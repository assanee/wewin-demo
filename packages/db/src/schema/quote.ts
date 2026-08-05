import {
  bigint,
  boolean,
  char,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { groups, users } from './auth.js';
import { orders } from './order.js';
import { APPROVAL_DIMENSIONS } from './payment.js';
import { productVersions } from './versions.js';

/**
 * The sales-editable quote — phase 5c. The lines, the overrides, and who may grant one.
 *
 * ── What this file gives up, said out loud ───────────────────────────────────────
 *
 * Risk 1 of the plan was mitigated by *"the api recomputes and 409s on mismatch"*. The
 * owner's fourth decision (plan 7.9) removes that mitigation: once a human may set any
 * number, **"is this total correct?" has no computable answer**. There is no constraint in
 * this file that checks a price, because there is no longer anything to check it against.
 *
 * The question this file makes answerable instead is plan 7.9's replacement:
 * **"where did this number come from, and was that person allowed?"** — which is a question
 * about provenance, and provenance is a row.
 *
 * ── The three layers, which are never collapsed (plan 7.9(ก)) ────────────────────
 *
 *   computed   `calcPrice()` from (product version, selections, measures, qty). The api
 *              computes it itself, always, and never accepts a number from a client.
 *              Here it is `quote_lines.computed_total_thb_minor` — and on a line that has
 *              no product to compute from, that column is NULL rather than a typed figure
 *              wearing the word "computed" (see `charge_total_thb_minor`).
 *   override   `quote_overrides`: one row holding BOTH the figure it was taken against and
 *              the figure a human set. Absolute, never a delta — plan 7.9(ก): sales
 *              promises "฿8,500", not "less ฿291", and a delta silently reprices when the
 *              catalogue moves.
 *   document   `order_documents.document` — frozen JSONB with its hash, written at submit.
 *              It belongs to `order.ts` and nothing here duplicates it.
 *
 * **`calcPrice` is not touched, and this file is the reason it does not have to be.** Plan
 * 7.9(ก): folding overrides into it would end 219 tests as a safety net, notably the one
 * asserting that the breakdown lines sum to the unit price.
 *
 * ── One anchor per meaning (plan 7.9(ข)) ─────────────────────────────────────────
 *
 * Unit price, line total and a percentage discount are one fact in three costumes. Two
 * editable fields with an arithmetic relationship produce "which one wins?" at every
 * endpoint, answered differently each time. So there are **three anchors and no fourth**,
 * the write always normalises onto one of them, and what the human actually typed survives
 * verbatim in `entered_as` + `entered_value_text`.
 *
 * The plan's list of override-editable things names four (line total, document discount,
 * net total, lead time) and this file ships three. That is not a subtraction: a document
 * discount and a document total are one fact two ways, and 7.9(ข) is the rule that
 * collapses them. `entered_as = 'percent_discount'` is how "ลด 5%" is still recorded as
 * having been typed that way. See `OVERRIDE_ANCHORS`.
 *
 * ── The conventions from `order.ts` and `payment.ts` hold and are not repeated ────
 *
 * Money is `bigint` minor units with `_thb_` in the name and the currency beside it; closed
 * sets are `text` + CHECK and never `pgEnum`; times are `timestamptz`; comments say WHY.
 *
 * ── And the count of two-person rules is still four ──────────────────────────────
 *
 * Nothing here adds a fifth. `authority_limits` is a **ceiling**, not an approver: it says
 * how large a concession a role may grant before `approvals` (which already exists, with
 * its one decider ≠ requester CHECK) has to be involved. Plan 7.13 warns that eight
 * approval gates in one workflow kill the single control that means anything, and
 * `tests/payment.test.ts` fails if a fifth two-person CHECK appears anywhere.
 */

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

/** `in ('a', 'b')` for a CHECK, built from the literal list the TypeScript union comes from. */
const inList = (values: readonly string[]) =>
  sql.raw(`(${values.map((value) => `'${value}'`).join(', ')})`);

// ─────────────────────────────────────────────────────────────────────────────
// The statuses a quote may still be edited in
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⚠️ A **mirror**, like `POST_FREEZE_STATUSES`.
 *
 * The definition Postgres uses is the `TG_ARGV` list on `quote_lines_live_orders_only` and
 * `quote_overrides_live_orders_only`, both of which reuse `order_child_require_status()`
 * from `0007_order_guards.sql` — the guard that takes `FOR SHARE` on the order rather than
 * merely ordering the race (trap 6). `tests/quote.test.ts` reads `pg_get_triggerdef` and
 * fails if the two ever disagree.
 *
 * The three are the three plan 7.5(ง) names as repriceable: `draft` is the cart,
 * `awaiting_payment` is a quote that has been sent and not paid, and `redesign` is a
 * frozen order the factory bounced — which the plan calls out as the one everybody
 * forgets, and where the edit is usually *more* expensive rather than less.
 *
 * `delivered`, `cancelled` and `superseded` are absent for the obvious reason. The three
 * production statuses are absent for a less obvious one: aluminium has been cut, so a
 * price change there is a credit note or a refund (plan 7.12), not an edit to a quote.
 */
export const QUOTE_EDITABLE_ORDER_STATUSES = ['draft', 'awaiting_payment', 'redesign'] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Quote lines — plan 7.9(ค) and 7.9(ง)(3)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a line is a line *of*.
 *
 *   `catalog`   a configured product: a product version, a sku, selections, measures, and
 *               a figure `calcPrice()` produced.
 *   `freeform`  delivery, installation, a site survey, a goodwill credit — plan 7.9(ค)'s
 *               "แถวใหม่" row, and the only place a human-typed amount is the *baseline*
 *               rather than an override against one.
 *
 * Two kinds and not three: a delivery charge and a free-form line differ in what somebody
 * types into the description, and in nothing a constraint could ever check.
 */
export const QUOTE_LINE_KINDS = ['catalog', 'freeform'] as const;

export type QuoteLineKind = (typeof QUOTE_LINE_KINDS)[number];

/**
 * One line of a quote, with an identity of its own.
 *
 * ── Why a line is not its configuration — plan 7.9(ง)(3) ─────────────────────────
 *
 * `quoteReducer.ts:86` merges an added line into an existing one when `configHash` and
 * `productId` match. That is right for a cart and **wrong for a quote**: the second window
 * would inherit the price somebody negotiated for the first, with nobody approving it, and
 * quoting two identical windows at two different prices — which is an ordinary thing for a
 * salesperson to do — could not be represented at all.
 *
 * So there is deliberately **no unique index on (order_id, config_hash)**. Two rows with
 * the same hash are two lines, each with its own overrides. `tests/quote.test.ts` asserts
 * this by building exactly that pair, because "we did not add a constraint" is otherwise
 * invisible to a reader and to a future migration.
 *
 * ── What a works order may read, and what it may not — plan 7.9(ค) ⚠️ ─────────────
 *
 * Sales can type "กระจกเทมเปอร์ 8 มม." onto a line whose sku says 6 mm. The plan's rule is
 * that a production sheet renders from the sku and the resolved options only, and that
 * sales prose is labelled "for the customer". A schema cannot police a renderer, so this
 * table makes the distinction structural instead:
 *
 *   `customer_description_th`  free text. Edit it as often as you like.
 *   `sku_code` · `product_version_id` · `selections` · `measures`  the fields a works order
 *   renders from — and `quote_lines_guard_write()` refuses to let `product_version_id` move
 *   at all, and refuses to let `sku_code` move unless `selections` moved with it, because
 *   the sku is *derived* from the selections and never travels on its own.
 *
 * The prose is therefore the only thing that can be edited without a trace, and the prose
 * is the only thing that never reaches the factory.
 */
export const quoteLines = pgTable(
  'quote_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onUpdate: 'cascade', onDelete: 'cascade' }),

    /**
     * Display order. 1-based, unique per order, and deliberately **not dense**.
     *
     * The opposite decision from `order_instalments.seq`, and for a stated reason: there
     * the frontier formula `MAX(seq) over the settled prefix` disagrees with `COUNT(*)`
     * the moment a hole appears, so density is load-bearing. Nothing here counts lines to
     * decide anything, so a removed line may leave its number behind — and reusing it
     * would make two different lines share a position in an audit trail.
     */
    seq: integer('seq').notNull(),
    kind: text('kind', { enum: QUOTE_LINE_KINDS }).notNull(),

    /** 🔒 Not editable — plan 7.9(ค). A different product is a different line. */
    productVersionId: uuid('product_version_id').references(() => productVersions.id, {
      onUpdate: 'cascade',
      onDelete: 'restrict',
    }),
    /**
     * 🔒 Not editable *directly* — it is derived from `selections` by `@wewin/core/skuCode`.
     *
     * Stored rather than derived on read because it is what the factory works from and a
     * derivation that depends on today's catalogue is not evidence of what was ordered.
     */
    skuCode: text('sku_code'),

    /** `{ groupCode: valueCode }` — plan 7.9(ง)(1): codes, never Thai labels. */
    selections: jsonb('selections'),
    /** Canonical micrometres as decimal strings, keyed by custom group code (plan 4.1). */
    measures: jsonb('measures'),
    /**
     * `@wewin/core`'s hash of the configuration. An identity for the *config*, not for the line.
     *
     * ⚠️ **16, not 64, and 5c is where that was found.** This column shipped as `char(64)` with
     * a `^[0-9a-f]{64}$` CHECK — the shape of `order_documents.document_hash` two tables away,
     * which is presumably where it was copied from. But the value it is named after is
     * `@wewin/core/hash`'s `configHash`, a 64-**bit** FNV-1a rendered as
     * `.toString(16).padStart(16, '0')`: **sixteen** hex characters. The column could not hold
     * the value it was named for, and the first write of a real quote line was SQLSTATE 23514.
     * `packages/db`'s own test never met it because it used a made-up 64-hex literal.
     *
     * The API worked around it by storing `sha256(configHash(...))`, which is deterministic and
     * injective — so it collided exactly where core collides — but is not comparable with the
     * 16-hex `configHash` inside a frozen `order_documents` line. That workaround is deleted;
     * this is the fix it named.
     */
    configHash: char('config_hash', { length: 16 }),

    qty: integer('qty').notNull().default(1),

    currency: char('currency', { length: 3 }).notNull().default('THB'),

    /**
     * ⓵ COMPUTED. `calcPrice()`'s figure for this whole line, at this quantity.
     *
     * NULL on a `freeform` line, and that NULL is the point. A typed charge stored in a
     * column called "computed" is the first step of collapsing the three layers, and it
     * would make every "how much has been conceded on this document?" query count the
     * whole of a ฿2,000 delivery charge as a discount taken against ฿0.
     *
     * The database cannot verify that the api really called `calcPrice` — nothing can. What
     * it can hold is that the column is absent exactly where there was nothing to compute.
     */
    computedTotalThbMinor: bigint('computed_total_thb_minor', { mode: 'bigint' }),

    /**
     * The amount on a `freeform` line, typed by a human, and NULL on a `catalog` line.
     *
     * May be negative: plan 7.13 lists "a negative charge" among the things the `margin`
     * dimension has to catch, because a −฿1,000 line is a discount wearing a different hat.
     * Never zero — a line for nothing is noise somebody still has to read.
     */
    chargeTotalThbMinor: bigint('charge_total_thb_minor', { mode: 'bigint' }),

    /**
     * Plan 7.9(ค): the VAT *amount* is not editable, but whether a line is taxable is.
     *
     * ⚠️ `true` is plan 13's DEFAULT, not a decision — the open question is whether
     * delivery and installation are taxable, and it is on the owner's list. A default in
     * the column rather than in a service is deliberate here because the answer is
     * per-line data, not structure; changing it needs no migration.
     */
    isVatApplicable: boolean('is_vat_applicable').notNull().default(true),

    /** 📣 FOR THE CUSTOMER. Never rendered onto a production sheet — see the block comment. */
    customerDescriptionTh: text('customer_description_th'),

    /**
     * Soft removal, because a line on a sent quote is history.
     *
     * Before submit a line is a cart item and is simply deleted. After submit it cannot be:
     * an override on it says the company promised something, and deleting the line would
     * delete the context of the promise. `quote_lines_guard_write()` enforces the split the
     * same way `order_events_append_only()` does — a never-submitted draft is not an
     * accounting document, and everything else is.
     */
    removedAt: timestamp('removed_at', { withTimezone: true }),
    removedByUserId: uuid('removed_by_user_id').references(() => users.id, {
      onUpdate: 'cascade',
      onDelete: 'restrict',
    }),

    ...timestamps,
  },
  (table) => [
    unique('quote_lines_order_seq_key').on(table.orderId, table.seq),
    /* The handle `quote_overrides` hangs off, so an override can be proved to be this order's. */
    unique('quote_lines_id_order_key').on(table.id, table.orderId),

    check('quote_lines_seq_positive', sql`${table.seq} >= 1`),
    check('quote_lines_kind_known', sql`${table.kind} in ${inList(QUOTE_LINE_KINDS)}`),
    check('quote_lines_currency_is_thb', sql`${table.currency} = 'THB'`),
    /*
     * ⚠️ No upper bound on qty here, on purpose. `MAX_QTY = 99` already exists twice —
     * `quoteReducer.ts:57` and a hardcoded copy at `PriceSummary.tsx:21` — and plan 7.9(ง)(5)
     * names that duplication as the bug: raising the ceiling in one place leaves the +
     * button disabled at 99. A third copy in Postgres would make it three places and would
     * additionally require a migration to change a number that is a UI limit.
     */
    check('quote_lines_qty_positive', sql`${table.qty} >= 1`),

    /*
     * ⓵ THE TWO KINDS, AS THE SHAPE THEY EACH HAVE. Same idea as
     * `order_instalments_basis_shape`: the kind carries exactly the columns it needs, so a
     * row two readers can disagree about cannot be written. One of those readers is the
     * works order and the other is the discount report.
     */
    check(
      'quote_lines_kind_shape',
      sql`case ${table.kind}
            when 'catalog' then ${table.productVersionId} is not null
                                 and ${table.skuCode} is not null
                                 and ${table.selections} is not null
                                 and ${table.measures} is not null
                                 and ${table.configHash} is not null
                                 and ${table.computedTotalThbMinor} is not null
                                 and ${table.chargeTotalThbMinor} is null
            else ${table.productVersionId} is null
                 and ${table.skuCode} is null
                 and ${table.selections} is null
                 and ${table.measures} is null
                 and ${table.configHash} is null
                 and ${table.computedTotalThbMinor} is null
                 and ${table.chargeTotalThbMinor} is not null
          end`,
    ),
    /* A computed price is never negative; `calcPrice` cannot produce one and neither may a caller. */
    check(
      'quote_lines_computed_nonnegative',
      sql`${table.computedTotalThbMinor} is null or ${table.computedTotalThbMinor} >= 0`,
    ),
    /* A charge of nothing is a row somebody has to read and cannot act on. Negative is allowed — a credit. */
    check(
      'quote_lines_charge_nonzero',
      sql`${table.chargeTotalThbMinor} is null or ${table.chargeTotalThbMinor} <> 0`,
    ),
    check('quote_lines_config_hash_is_hex', sql`${table.configHash} is null or ${table.configHash} ~ '^[0-9a-f]{16}$'`),
    check('quote_lines_selections_is_object', sql`${table.selections} is null or jsonb_typeof(${table.selections}) = 'object'`),
    check('quote_lines_measures_is_object', sql`${table.measures} is null or jsonb_typeof(${table.measures}) = 'object'`),
    /* Two columns, one fact — the shape `guests_claim_shape` uses. */
    check(
      'quote_lines_removal_shape',
      sql`num_nonnulls(${table.removedAt}, ${table.removedByUserId}) in (0, 2)`,
    ),

    index('quote_lines_order_seq_idx').on(table.orderId, table.seq),
    /* The live quote: everything not removed, in order. The read the editor does on every keystroke. */
    index('quote_lines_live_idx')
      .on(table.orderId, table.seq)
      .where(sql`removed_at is null`),
    index('quote_lines_product_version_idx')
      .on(table.productVersionId)
      .where(sql`product_version_id is not null`),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Overrides — plan 7.9(ก) and 7.9(ข)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The anchors. Three, and the number three is the design.
 *
 *   `line_total`      what one line costs. The line-scoped anchor, and the only one.
 *   `grand_total`     what the customer transfers. VAT-inclusive, always (plan 4.4), and
 *                     the single base every other number derives from (plan 7.13).
 *   `lead_time_days`  the promise that is not money. Here rather than in a column of its
 *                     own because a second override mechanism for a second kind of promise
 *                     is precisely the finding plan 7.13 opens with — six mechanisms
 *                     pretending to be one — and it would arrive with its own answer to
 *                     "who set this, against what, and when was it replaced?".
 *
 * ── The three that are deliberately NOT anchors ──────────────────────────────────
 *
 *   *unit price* — `line_total / qty`, and plan 4.3(ข) already says it is a display number
 *   that cannot be added up. The UI may offer the box; the write normalises to the line
 *   total and records `entered_as = 'unit_price'`. Plan 7.9(ข)'s own worked example: qty 2
 *   with unit ฿9,000 *and* total ฿18,432 set at once leaves the quote ฿432 short of footing
 *   and makes a 30% deposit wrong from whichever end you compute it.
 *
 *   *document discount* — a discount and a total are one fact two ways. Both editable means
 *   "which wins?" at every endpoint. Typing "−5%" is preserved exactly:
 *   `entered_as = 'percent_discount'`, `entered_value_text = '-5%'`, and the stored value is
 *   the absolute grand total it produced. Plan 7.9(ก) is explicit that a delta is the wrong
 *   thing to store: ฿8,791 less ฿291 becomes ฿9,209 the day the catalogue moves to ฿9,500,
 *   silently, having promised ฿8,500.
 *
 *   *net total* — `grand − vat`, and plan 4.4 forbids editing the VAT amount. Editing the
 *   net while the grand is the base would set the VAT amount by the back door.
 */
export const OVERRIDE_ANCHORS = ['line_total', 'grand_total', 'lead_time_days'] as const;

export type OverrideAnchor = (typeof OVERRIDE_ANCHORS)[number];

/**
 * What the human actually typed into, before the write normalised it onto an anchor.
 *
 * Not decoration and not diagnostics. Plan 7.9(ก): sales told the customer *"เอา ฿8,500"* or
 * *"ลด 5%"*, and which of the two they said is what the conversation was; the anchor value
 * alone cannot reconstruct it. It is also the only way the approvals report can tell a
 * negotiated round number from a percentage policy somebody applied by habit.
 */
export const OVERRIDE_ENTRY_MODES = [
  'line_total',
  'unit_price',
  'grand_total',
  'percent_discount',
  'discount_amount',
  'lead_time_days',
] as const;

export type OverrideEntryMode = (typeof OVERRIDE_ENTRY_MODES)[number];

/**
 * ⚠️ A DEFAULT VOCABULARY, NOT A DECISION — plan 13's rule for this file.
 *
 * A reason code is required (the brief), and nobody has told us what the company's reasons
 * *are*. These seven are a starting set chosen to be reportable rather than to be right,
 * and adding or removing one is a reversible migration precisely because this is `text` +
 * CHECK and not a `pgEnum` (the convention `order.ts` explains).
 *
 * `other` is not a loophole: the CHECK below requires a note when it is used, so the
 * vocabulary grows from real sentences somebody wrote rather than from a design meeting.
 */
export const OVERRIDE_REASONS = [
  'price_match',
  'volume',
  'relationship',
  'goodwill',
  'correction',
  'rounding',
  'other',
] as const;

export type OverrideReason = (typeof OVERRIDE_REASONS)[number];

/** Why an override stopped being the live one. `replaced` names a successor; `revoked` does not. */
export const OVERRIDE_SUPERSESSION_REASONS = ['replaced', 'revoked'] as const;

/**
 * One human-set figure, and the machine figure it was set against.
 *
 * ── Append-only with supersession, like every other spine here ───────────────────
 *
 * A quote disputed months later has to be reconstructable, so an override is never edited
 * and never deleted. Changing ฿8,500 to ฿8,200 is a **new row** plus a stamp on the old one
 * saying which row replaced it and who did it. `quote_overrides_guard_write()` permits
 * exactly one UPDATE per row — the four supersession columns, NULL → NOT NULL, once — and
 * refuses everything else, including DELETE, on the same terms `order_events_append_only()`
 * uses: a never-submitted draft is not an accounting document, everything else is.
 *
 * That is also the whole of plan 7.9(ค)'s *"the computed baseline of an override already
 * issued is not editable"*. It is not a separate rule; it is what append-only means.
 *
 * ── Exactly one active row per (line, anchor) ────────────────────────────────────
 *
 * Enforced, not assumed, by two partial unique indexes rather than one. Postgres treats
 * NULLs as distinct in a unique index by default, and a document-scoped anchor has a NULL
 * line — so a single index on `(order_id, quote_line_id, anchor)` would happily hold five
 * live grand-total overrides. `NULLS NOT DISTINCT` would fix it and cannot be written on a
 * *partial* index in this drizzle version, so the rule is split along the same seam the
 * shape CHECK already splits: line anchors key on the line, document anchors key on the
 * order.
 *
 * ── What `computed_thb_minor` means on a `grand_total` row ───────────────────────
 *
 * The figure the document showed **immediately before this override**, which for a grand
 * total is after the line overrides have been applied. The cascade is one-directional —
 * lines, then the document total — so "recompute the baseline and compare" stays
 * well-defined at pin time. Plan 7.9(จ): at submit every override is re-verified, and a
 * baseline that no longer matches is an **integrity alarm, not a 409** — it means `core`
 * changed behaviour underneath a pinned document, which no client can recover from.
 */
export const quoteOverrides = pgTable(
  'quote_overrides',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onUpdate: 'cascade', onDelete: 'cascade' }),

    /** The line this is about, or NULL for a document-scoped anchor. Tied to `order_id` below. */
    quoteLineId: uuid('quote_line_id'),

    anchor: text('anchor', { enum: OVERRIDE_ANCHORS }).notNull(),

    /* ── the money anchors ─────────────────────────────────────────────────── */
    /** ⓵ What the machine said. Frozen with the row — see the block comment. */
    computedThbMinor: bigint('computed_thb_minor', { mode: 'bigint' }),
    /** ⓶ What the human said. **Absolute, never a delta** — plan 7.9(ก). */
    overrideThbMinor: bigint('override_thb_minor', { mode: 'bigint' }),

    /* ── the anchor that is not money ──────────────────────────────────────── */
    computedDays: integer('computed_days'),
    overrideDays: integer('override_days'),

    /** Which box it was typed into. See `OVERRIDE_ENTRY_MODES`. */
    enteredAs: text('entered_as', { enum: OVERRIDE_ENTRY_MODES }).notNull(),
    /** Verbatim. `'8500'`, `'-15%'`, `'8,500'` — whatever the keyboard produced. */
    enteredValueText: text('entered_value_text').notNull(),

    reasonCode: text('reason_code', { enum: OVERRIDE_REASONS }).notNull(),
    noteTh: text('note_th'),

    /**
     * Who set it. NOT NULL, and there is no guest variant.
     *
     * Plan 7.9's whole replacement mitigation is "which person, and were they allowed" —
     * an override with no name on it answers neither. A customer cannot set a price, so
     * unlike `order_events` this column has no `guest_id` sibling and needs none.
     */
    setByUserId: uuid('set_by_user_id')
      .notNull()
      .references(() => users.id, { onUpdate: 'cascade', onDelete: 'restrict' }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

    /* ── supersession: the only columns an UPDATE may touch, once ──────────── */
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    /**
     * The row that replaced this one.
     *
     * ⚠️ **No foreign key here on purpose**, exactly as `orders.status_event_id` has none.
     * drizzle-kit would emit an immediate one, and an immediate one makes replacing an
     * override impossible — see the ORDER OF STATEMENTS block in
     * `drizzle/0016_quote_guards.sql`. The constraint exists in the database, is named
     * `quote_overrides_successor_fk`, and is `DEFERRABLE INITIALLY DEFERRED`.
     */
    supersededByOverrideId: uuid('superseded_by_override_id'),
    /** Who withdrew or replaced it — the successor row carries its own author, a revocation has none. */
    supersededByUserId: uuid('superseded_by_user_id').references(() => users.id, {
      onUpdate: 'cascade',
      onDelete: 'restrict',
    }),
    supersessionReason: text('supersession_reason', { enum: OVERRIDE_SUPERSESSION_REASONS }),
  },
  (table) => [
    /* The line belongs to this override's order. A promise recorded on somebody else's line is not a promise. */
    foreignKey({
      name: 'quote_overrides_line_fk',
      columns: [table.quoteLineId, table.orderId],
      foreignColumns: [quoteLines.id, quoteLines.orderId],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    /* The handle the deferrable successor FK in the guards migration hangs off. */
    unique('quote_overrides_id_order_key').on(table.id, table.orderId),

    check('quote_overrides_anchor_known', sql`${table.anchor} in ${inList(OVERRIDE_ANCHORS)}`),
    /*
     * ⚠️ NO INDEPENDENT BEHAVIOURAL EVIDENCE, and reported rather than claimed.
     *
     * Mutation testing dropped it and the suite stayed green:
     * `quote_overrides_entry_mode_fits_anchor` below restricts `entered_as` to a *subset*
     * of this list for every anchor, so no row exists that one refuses and the other
     * accepts. It stays because the house convention is that a closed set carries its own
     * CHECK — it is what still holds the day somebody widens the anchor mapping — and
     * `tests/quote.test.ts` asserts its definition enumerates the whole union, which is
     * evidence that it is present and complete rather than evidence that it fires.
     */
    check('quote_overrides_entered_as_known', sql`${table.enteredAs} in ${inList(OVERRIDE_ENTRY_MODES)}`),
    check('quote_overrides_reason_known', sql`${table.reasonCode} in ${inList(OVERRIDE_REASONS)}`),
    check(
      'quote_overrides_supersession_reason_known',
      sql`${table.supersessionReason} is null
          or ${table.supersessionReason} in ${inList(OVERRIDE_SUPERSESSION_REASONS)}`,
    ),

    /*
     * ⓵ SCOPE. A line anchor names a line; a document anchor must not. Without this a
     * `grand_total` row could carry a line id, and the two unique indexes below — which
     * partition on exactly that column — would each think the other one was enforcing it.
     */
    check(
      'quote_overrides_scope_shape',
      sql`(${table.anchor} = 'line_total') = (${table.quoteLineId} is not null)`,
    ),

    /*
     * ⓶ THE VALUE PAIR, BY ANCHOR. Same idea as `order_instalments_basis_shape`.
     *
     * Both halves are NOT NULL together or the row is not an override: a value with no
     * baseline cannot be re-verified at submit (plan 7.9(จ)), and a baseline with no value
     * is a note.
     */
    check(
      'quote_overrides_value_shape',
      sql`case ${table.anchor}
            when 'lead_time_days' then ${table.computedDays} is not null and ${table.overrideDays} is not null
                                       and ${table.computedThbMinor} is null and ${table.overrideThbMinor} is null
            else ${table.computedThbMinor} is not null and ${table.overrideThbMinor} is not null
                 and ${table.computedDays} is null and ${table.overrideDays} is null
          end`,
    ),
    /*
     * A price is never negative. A concession that would take a line or a total below zero
     * is money going the other way, which is a refund (plan 7.12) or a credit line, and
     * both of those are rows somewhere else with their own approval.
     */
    check(
      'quote_overrides_money_nonnegative',
      sql`(${table.computedThbMinor} is null or ${table.computedThbMinor} >= 0)
          and (${table.overrideThbMinor} is null or ${table.overrideThbMinor} >= 0)`,
    ),
    check(
      'quote_overrides_days_nonnegative',
      sql`(${table.computedDays} is null or ${table.computedDays} >= 0)
          and (${table.overrideDays} is null or ${table.overrideDays} >= 0)`,
    ),
    /*
     * ⓷ AN OVERRIDE THAT CHANGES NOTHING IS NOT AN OVERRIDE.
     *
     * It would take up the one active slot for its anchor, and it would make "does this
     * line carry a promise?" — the question `quote_lines_guard_write()` asks before it
     * allows a reprice — answer yes for a row that promised nothing. Confirming a price
     * after the catalogue moved is a *revocation* of the old override, not a new one equal
     * to today's computed figure.
     */
    check(
      'quote_overrides_value_differs',
      sql`${table.overrideThbMinor} is distinct from ${table.computedThbMinor}
          or ${table.overrideDays} is distinct from ${table.computedDays}`,
    ),
    /*
     * ⓸ THE TYPED BOX HAS TO FIT THE ANCHOR. `entered_as = 'unit_price'` on a grand total
     * is a normalisation that went to the wrong anchor, and it is the exact mistake plan
     * 7.9(ข) says happens once per endpoint.
     */
    check(
      'quote_overrides_entry_mode_fits_anchor',
      sql`case ${table.anchor}
            when 'line_total'     then ${table.enteredAs} in ('line_total', 'unit_price', 'percent_discount', 'discount_amount')
            when 'grand_total'    then ${table.enteredAs} in ('grand_total', 'percent_discount', 'discount_amount')
            else ${table.enteredAs} = 'lead_time_days'
          end`,
    ),
    /* Verbatim means there was something to record. An empty string is a field nobody filled in. */
    check('quote_overrides_entered_text_present', sql`btrim(${table.enteredValueText}) <> ''`),
    /* `other` is a prompt for a sentence, not a way past the vocabulary. */
    check(
      'quote_overrides_other_needs_a_note',
      sql`${table.reasonCode} <> 'other' or btrim(coalesce(${table.noteTh}, '')) <> ''`,
    ),

    /*
     * ⓹ SUPERSESSION IS THREE COLUMNS AND ONE FACT, plus a successor when there is one.
     * A row stamped superseded with nobody's name on it is a promise that vanished.
     */
    check(
      'quote_overrides_supersession_shape',
      sql`case
            when ${table.supersededAt} is null
              then ${table.supersededByUserId} is null and ${table.supersessionReason} is null
                   and ${table.supersededByOverrideId} is null
            else ${table.supersededByUserId} is not null and ${table.supersessionReason} is not null
                 and (${table.supersessionReason} <> 'replaced') = (${table.supersededByOverrideId} is null)
          end`,
    ),
    check(
      'quote_overrides_successor_is_another_row',
      sql`${table.supersededByOverrideId} is distinct from ${table.id}`,
    ),

    /*
     * ⓺ ONE ACTIVE OVERRIDE PER (LINE, ANCHOR) — enforced, in two halves.
     *
     * See the block comment for why it is two indexes and not one: a partial unique index
     * cannot be `NULLS NOT DISTINCT` here, and the document anchors have a NULL line.
     */
    uniqueIndex('quote_overrides_one_active_per_line')
      .on(table.quoteLineId, table.anchor)
      .where(sql`superseded_at is null and quote_line_id is not null`),
    uniqueIndex('quote_overrides_one_active_per_document')
      .on(table.orderId, table.anchor)
      .where(sql`superseded_at is null and quote_line_id is null`),

    /* The editor's read: every live override on this quote, one round trip. */
    index('quote_overrides_active_idx')
      .on(table.orderId, table.anchor)
      .where(sql`superseded_at is null`),
    /* The reconstruction: the whole history of one quote, in the order it happened. */
    index('quote_overrides_history_idx').on(table.orderId, table.createdAt),
    index('quote_overrides_line_idx')
      .on(table.quoteLineId)
      .where(sql`quote_line_id is not null`),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Authority — plan 13, and it is empty on purpose
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How much a role may concede before `approvals` has to be involved.
 *
 * ── Fail closed, and what that costs ─────────────────────────────────────────────
 *
 * Plan 13: *"อำนาจ · เพดานส่วนลดต่อ role … **fail-closed** — ยังไม่มีแถว = ยังลดราคาไม่ได้"*.
 * **No row means no authority.** A role with no row here may grant nothing at all, and this
 * table ships with **zero rows** — the owner has not been asked yet, and plan 13's rule for
 * this repository is that a placeholder must never be shipped wearing the costume of an
 * answer. `tests/quote.test.ts` asserts the row count is zero, so the day somebody seeds a
 * "reasonable default" it fails a test and has to be argued for out loud.
 *
 * The other half of plan 13's paragraph is the one that makes fail-closed survivable: the
 * smoke path — ฿8,791 THB, 30% deposit, one slip, confirm, produce, deliver — **must run
 * with no approval at all**, and it does. Nothing in this file requires a row in
 * `approvals` or here for an order to be quoted, submitted, paid or delivered. Fail-closed
 * bites only when somebody actually reduces what the customer pays.
 *
 * ── One number, and deliberately not a percentage ────────────────────────────────
 *
 * Plan 13's instruction for this round is literal: *"Do not invent a percentage."* So there
 * is one ceiling column, in THB minor units, and no `max_concession_bp` beside it. A
 * percentage ceiling is the more likely answer for a business whose orders differ by an
 * order of magnitude — but "likely" is a guess, and a guess in a policy table is
 * indistinguishable from a decision three months later. **This is the open question**: the
 * owner may answer with a percentage, in which case this table gains a column and the CHECK
 * that exactly one of the two is set.
 *
 * ── Two dimensions, and they are the ones `approvals` already has ────────────────
 *
 * `margin` and `cashflow`, imported from `payment.ts` rather than redeclared. Plan 7.13
 * found the same rule written six times with six column pairs; a second copy of the
 * dimension list here would be the seventh.
 *
 * ── Why the wildcard row cannot exist ────────────────────────────────────────────
 *
 * `forfeit_policy_rules` learned this the hard way and the test that found it is in
 * `tests/payment.test.ts`: drizzle's `{ enum }` narrows TypeScript and narrows nothing in
 * Postgres, so `INSERT … ('ANY', …)` succeeded and left a row every reader had to have an
 * opinion about. Here `group_id` is NOT NULL with a real foreign key (no "all roles" row)
 * and `dimension` carries a CHECK (no "any dimension" row), so the two shapes a wildcard
 * could take are both unrepresentable.
 *
 * `ON DELETE CASCADE` towards `groups` is the fail-closed direction and the opposite of
 * what this file uses everywhere else: deleting a role deletes its authority, and the next
 * request from anybody in it can concede nothing. `RESTRICT` would leave a ceiling attached
 * to a role that no longer exists, which is the only outcome worse than losing it.
 */
export const authorityLimits = pgTable(
  'authority_limits',
  {
    /** The role. `groups` is what a role is in this schema — see `auth.ts`: a guard asks for a permission, never for a job title. */
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onUpdate: 'cascade', onDelete: 'cascade' }),
    dimension: text('dimension', { enum: APPROVAL_DIMENSIONS }).notNull(),

    /**
     * The largest concession, in THB minor units, this role may grant **without** an
     * approval. At or below it the document goes out; above it `approvals` decides.
     *
     * `0` is a legal and meaningful value — "this role may record concessions but may
     * approve none of its own" — and it is *not* the same as having no row, which is "this
     * role may not concede at all". The difference matters to the API's error message and
     * to the report, so it is representable.
     */
    maxConcessionThbMinor: bigint('max_concession_thb_minor', { mode: 'bigint' }).notNull(),

    /**
     * Who granted this authority. NOT NULL, because there is no migration that seeds this
     * table and therefore no row that arrives without a person behind it.
     */
    grantedByUserId: uuid('granted_by_user_id')
      .notNull()
      .references(() => users.id, { onUpdate: 'cascade', onDelete: 'restrict' }),
    noteTh: text('note_th'),
    ...timestamps,
  },
  (table) => [
    primaryKey({ name: 'authority_limits_pkey', columns: [table.groupId, table.dimension] }),
    check('authority_limits_dimension_known', sql`${table.dimension} in ${inList(APPROVAL_DIMENSIONS)}`),
    /* Negative authority is not a smaller ceiling, it is a sentence nobody can read. */
    check('authority_limits_ceiling_nonnegative', sql`${table.maxConcessionThbMinor} >= 0`),
    index('authority_limits_dimension_idx').on(table.dimension),
  ],
);
