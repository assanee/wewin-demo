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
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { guests, users } from './auth.js';
import { productVersions } from './versions.js';

/**
 * The order lifecycle, its append-only spine, and the outbox that reads from it.
 *
 * Phase 5a. Payments (5b) and the sales-editable quote (5c) attach to this file at the
 * seams marked `SEAM 5b` / `SEAM 5c`; nothing here stubs them, and nothing here needs
 * rewriting when they land — the columns they add are columns, and the transitions and
 * event types they add are rows.
 *
 * Four conventions hold everywhere below and are not repeated at each column:
 *
 *   money      `bigint` minor units with the currency in a column beside it, exactly as
 *              `catalog.ts` does it. Never `numeric`. Every amount in this file is THB
 *              and says so in its own name as well, because plan 7.13 settled that
 *              `grand_total_thb_minor` is the single base every other number is derived
 *              from — the name is the reminder that a presentment currency (5c) is a
 *              display layer and never the thing the ledger or a forfeit reads.
 *   closed sets `text` + CHECK, **not** `pgEnum`, and this is the one convention that
 *              deliberately breaks with `enums.ts`. Plan 7.1: this project has already
 *              grown the status list once after being told it was final, and
 *              `ALTER TYPE … ADD VALUE` cannot be rolled back. The same reasoning covers
 *              event types, payload kinds and channels — 5b adds `slip_received`, 5c adds
 *              override events, and adding a member has to be a reversible migration.
 *              Drizzle's `{ enum }` still gives callers the narrow union; the CHECK is
 *              what holds for an INSERT that did not come through Drizzle. That is the
 *              same pairing `media.ts` uses for `content_type`.
 *   times      `timestamptz`, always, for the reason `auth.ts` gives.
 *   comments   say WHY. A constraint whose reason is not written down is a constraint the
 *              next person deletes to make their test pass.
 */

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

/** `in ('a', 'b')` for a CHECK, built from the same literal list the TypeScript union comes from. */
const inList = (values: readonly string[]) =>
  sql.raw(`(${values.map((value) => `'${value}'`).join(', ')})`);

// ─────────────────────────────────────────────────────────────────────────────
// The ten statuses — plan 7.1
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every state an order can be in. Nine, not six.
 *
 * `redesign` is not `draft` and `superseded` is not `cancelled`, and both separations pay
 * for themselves in queries rather than in vocabulary:
 *
 *   `redesign` vs `draft` — their invariants are opposites. A draft has no contract, no
 *     money and no production history; a redesign has all three. Merging them would make
 *     every "carts that have not sold yet" query carry `AND document_id IS NULL`, and one
 *     day somebody forgets. Here the two are separated by constraint, not by discipline:
 *     `orders_draft_has_no_contract` and `orders_redesign_has_a_contract` below.
 *
 *   `superseded` vs `cancelled` — a post-freeze edit that produced a replacement order is
 *     not lost business. One shared status puts every revision into the cancellation
 *     report and the number sales actually looks at is wrong from day one.
 *
 * Order matters here only for readability; nothing indexes into this list.
 */
export const ORDER_STATUSES = [
  'draft',
  /**
   * ⭐ รอยืนยัน — the customer has asked for a quotation and nobody has agreed to anything yet.
   *
   * Between `draft` and `awaiting_payment` because that is where the gap always was: a request
   * for a price used to land straight in "please transfer money", against a figure no member of
   * staff had looked at. An order here has a number, a pinned document and a total — the
   * customer sees it, labelled as approximate — and cannot be paid.
   */
  'awaiting_confirmation',
  'awaiting_payment',
  'production_confirmed',
  'in_production',
  'awaiting_installation',
  'delivered',
  'redesign',
  'cancelled',
  'superseded',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

/**
 * The statuses that are on the far side of the freeze point.
 *
 * The freeze point is entry to `production_confirmed` (plan 7.5(ข)) — deposits changed
 * *what opens it*, not where it is. Everything downstream of it is downstream forever,
 * including `redesign`, which is why a bounce from the factory is not a return to `draft`.
 *
 * ⚠️ This list is a **mirror**. The definition Postgres uses is
 * `order_status_is_post_freeze()` in `drizzle/0007_order_guards.sql`, because a CHECK
 * constraint cannot be written against a TypeScript array. `tests/order.test.ts` asks the
 * database about all ten statuses and fails if the two ever disagree — the same drift
 * test `tests/enums.test.ts` does for the catalogue's unions.
 *
 * `cancelled` and `superseded` are deliberately absent: both are reachable from either
 * side of the freeze, which is exactly why the fact worth storing is `orders.frozen_at`
 * and not a status. A cancellation report needs to know whether aluminium had already
 * been committed, and after the cancellation the status can no longer say.
 */
export const POST_FREEZE_STATUSES = [
  'production_confirmed',
  'in_production',
  'awaiting_installation',
  'delivered',
  'redesign',
] as const;

/** Statuses with no outgoing transition. Kept for callers; the transition table is the truth. */
export const TERMINAL_ORDER_STATUSES = ['delivered', 'cancelled', 'superseded'] as const;

/**
 * What happened, as a word.
 *
 * Every status change carries exactly one of these, and which one is not the caller's
 * choice: `order_status_transitions` names the event type for each (from, to) pair and a
 * trigger refuses an event that disagrees. That matters because the outbox routes on
 * `event_type` (plan 10.3 is a table of event → recipient), so an event type that drifted
 * from the transition it recorded would send the wrong message about the right change.
 *
 * **Four** of these are not status changes at all — `quote_revised`, `change_requested`,
 * `change_resolved` and `balance_reminded`. They are on the spine because plan 10.3 has to
 * notify about them and plan 10.1 makes notifications a consumer of this table and of
 * nothing else. All four carry a null `(from_status, to_status)` pair, which
 * `order_events_status_pair_shape` has permitted by construction since 0007, and none of
 * them has — or may have — a row in `order_status_transitions`, which is keyed on that pair.
 *
 * ⭐ `balance_reminded` (0050) is the newest and the first that is about **money rather than
 * the quotation**: a member of staff asked the customer for the outstanding balance. Its
 * two rules — staff-only, and a payload carrying `outstanding_thb_minor` — are enforced by
 * `order_events_guard_insert()`, because the transition row that would normally carry
 * `allowed_actor_kinds` and `required_payload_keys` cannot exist for an event with no pair.
 *
 * ⚠️ It is named for the **ask**, not for the send. Whether a message left the building is
 * `notifications` / `notification_attempts`' fact, knowable minutes later and false for an
 * order with no contact channel; the spine records what a person did, in their transaction.
 *
 * SEAM 5b: `slip_received`, `slip_rejected`, `refund_requested`, `refund_disbursed` are
 * added here by migration, with rows in `notification_rules` beside them. None of them is
 * a status change (plan 7.3 and 7.12), so none of them needs a transition row.
 */
export const ORDER_EVENT_TYPES = [
  'created',
  'quote_revised',
  'submitted_for_payment',
  /**
   * ⭐ เจ้าหน้าที่ยืนยันใบเสนอราคาแล้ว — the act that makes a quoted price payable.
   *
   * The half of the flow that never existed: a customer's request used to arrive already
   * asking them for money. This is a member of staff saying the figures are agreed.
   */
  'quotation_confirmed',
  /** …and taking it back to renegotiate, while nothing has been paid. */
  'quotation_reopened',
  /**
   * ⛔ Production started with nothing received, said out loud.
   *
   * The owner's flow allows it ("ยังไม่ต้องชำระก็ได้ ... ข้ามไปที่ขั้นตอนเริ่มผลิตเลย"); what was
   * wrong was recording it as `payment_confirmed` and emailing the customer that their payment
   * had been verified when ฿0 had arrived. One (from, to) pair may carry exactly one event
   * type — `order_events_guard_insert()` refuses any other — so the honest name needed an
   * edge of its own, which is `awaiting_confirmation → production_confirmed` in 0054.
   *
   * Deliberately ugly, like `balance_written_off`: somebody reading this row in six months
   * needs to see that no money was received, and a polite name is how that gets lost.
   */
  'production_authorised_unpaid',
  'payment_confirmed',
  'production_started',
  'installation_scheduled',
  'delivered',
  'bounced_to_redesign',
  'redesign_approved',
  'cancelled',
  'superseded',
  'change_requested',
  'change_resolved',
  'balance_reminded',
  /*
   * ⭐ An approved ขออนุมัติตัดยอดค้างทิ้ง. Beside `balance_reminded` because it is the same
   * kind of row: money moved in the customer's favour and no status changed. Without it a
   * forgiven debt was the one balance movement the spine did not witness — WW-1044 had
   * ฿9,886.80 written off and its timeline still ended at `installation_scheduled`.
   */
  'balance_written_off',
  /*
   * ⭐ 0062. A numbered document was issued, or struck out. Beside the two above for the same
   * reason they are beside each other: no status changed, and the order's own history is where
   * somebody looks first to find out why TAX-2569-00042 exists. The number and the kind are in
   * the payload so the timeline reads without joining `tax_documents`.
   */
  'tax_document_issued',
  'tax_document_voided',
] as const;

/**
 * Which request body a transition takes.
 *
 * This is trap 4 (plan 7.4) made into data. `cancel` has two of these — one before the
 * freeze, one after — and the post-freeze one carries `fault`, which decides how much
 * money the customer gets back. A controller that picks its zod schema before loading the
 * order picks by name, gets the pre-freeze one, and zod *strips* `fault` silently.
 *
 * Naming the payload on the transition row makes that impossible to do by accident: the
 * row cannot be found without `from_status`, and `from_status` cannot be known without
 * loading the order. And `required_payload_keys` below is the backstop — if the field was
 * stripped anyway, the INSERT of the event fails rather than the cancellation quietly
 * defaulting to somebody's favour.
 */
export const ORDER_PAYLOAD_KINDS = [
  'none',
  'submit',
  'confirm_payment',
  /**
   * ⭐ Authorising production on an unpaid order, which requires a written `reason`.
   *
   * Its own kind rather than `confirm_payment` with an optional note, because the two acts are
   * different and the required key is the difference: confirming money that arrived needs no
   * justification, and releasing the factory against an invoice nobody has paid is a decision
   * somebody must be able to defend later. `required_payload_keys = {reason}` on the
   * transition row is what enforces it, in Postgres, for every writer.
   */
  'authorise_unpaid',
  'cancel_pre_freeze',
  'cancel_post_freeze',
  'bounce',
  'approve_redesign',
  'supersede',
] as const;

/**
 * Who is acting.
 *
 * 🔒 A kind is a **necessary** condition and never a sufficient one. Plan 7.4 trap 2 is
 * exactly the mistake of reading `actors: ['customer']` as "this customer": any signed-in
 * customer could then cancel any order whose id they guessed. Ownership belongs in the
 * query that loads the order — `orders.customer_user_id` / `orders.guest_id` are there so
 * it can be a WHERE clause — and `order_events_guard_insert()` in the guards migration
 * additionally refuses an event whose actor is not the order's owner, so forgetting the
 * WHERE clause is a failed write rather than a silent cross-tenant edit.
 */
export const ORDER_ACTOR_KINDS = ['customer', 'guest', 'staff', 'system'] as const;

/** Plan 4.4: configurable rate, configurable treatment, and a `grand_total` that always includes VAT. */
export const VAT_TREATMENTS = ['standard', 'zero_rated', 'exempt', 'out_of_scope'] as const;

/**
 * ⚠️ A DEFAULT, NOT A DECISION — plan 13.
 *
 * 700 bp is Thailand's own rate and the fallback for an order naming no destination. Of the
 * two questions it used to stand in for, migration 0029's `tax_countries` answered the
 * first — whether an overseas customer is zero-rated is now a per-destination fact, not one
 * rate for everybody — and cites this very comment while doing it. Whether delivery and
 * installation are taxable is still open. It is deliberately not a column default: a
 * `DEFAULT 700` in the schema is how a placeholder becomes a fact nobody remembers choosing.
 * The API passes it, pins it per document, and the pinned value is what a reprint of that
 * document renders forever after.
 */
export const VAT_RATE_BP_DEFAULT = 700;

// ─────────────────────────────────────────────────────────────────────────────
// The legal transitions, as rows
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every legal move, one row each, seeded in `drizzle/0007_order_guards.sql`.
 *
 * A table and not a `CASE` in plpgsql for the same reason the statuses are `text`: the
 * set has already grown once, and a row is a migration that can be rolled back. It is
 * also what lets the database answer the two questions the API would otherwise answer
 * from a hard-coded map that nothing keeps in step — "may this order move there?" and
 * "what does that move require?".
 *
 * **`cancel` really is two rows per side of the freeze** (six rows in total: `draft`,
 * `awaiting_payment` before; `production_confirmed`, `in_production`,
 * `awaiting_installation`, `redesign` after). Plan 7.8 is explicit that `redesign` is
 * cancellable and that forgetting it is the common mistake.
 *
 * **`superseded` is reachable only from `redesign`, on purpose.** A post-freeze change of
 * mind has to be *examined* before it becomes a new contract, and `redesign` is the state
 * that says somebody is examining it. Sales wanting to reissue a frozen order therefore
 * bounces it first, which is one extra click and one extra row on the spine. If that turns
 * out to be wrong, the fix is one INSERT in a migration — which is the entire reason this
 * is a table.
 */
export const orderStatusTransitions = pgTable(
  'order_status_transitions',
  {
    fromStatus: text('from_status', { enum: ORDER_STATUSES }).notNull(),
    toStatus: text('to_status', { enum: ORDER_STATUSES }).notNull(),
    /** The event type this move must be recorded as. One per pair, so routing cannot drift. */
    eventType: text('event_type', { enum: ORDER_EVENT_TYPES }).notNull(),
    payloadKind: text('payload_kind', { enum: ORDER_PAYLOAD_KINDS }).notNull(),
    /**
     * Keys the event payload must carry. Checked with `?&` on insert.
     *
     * The point is not validation — the API validates. The point is that a field zod
     * stripped, or a client never sent, cannot reach the database as an absence that
     * defaults to somebody's benefit.
     */
    requiredPayloadKeys: text('required_payload_keys').array().notNull().default(sql`'{}'`),
    /** 🔒 Necessary, never sufficient. See `ORDER_ACTOR_KINDS`. */
    allowedActorKinds: text('allowed_actor_kinds').array().notNull(),
    /** Why this move exists, in Thai, for the audit trail and the dashboard's tooltips. */
    descriptionTh: text('description_th').notNull(),
  },
  (table) => [
    primaryKey({
      name: 'order_status_transitions_pkey',
      columns: [table.fromStatus, table.toStatus],
    }),
    check('order_status_transitions_no_self_loop', sql`${table.fromStatus} <> ${table.toStatus}`),
    check(
      'order_status_transitions_actor_kinds_known',
      sql`${table.allowedActorKinds} <@ array['customer', 'guest', 'staff', 'system']::text[]
          and array_length(${table.allowedActorKinds}, 1) >= 1`,
    ),
    /*
     * The half of trap 4 a CHECK can carry: whatever else a post-freeze cancellation
     * requires, it requires the two fields that decide the money. `fault` is the one plan
     * 7.8 marks 🔒 — it must never come from a request body, and a row that does not demand
     * it is a row that lets it be absent.
     */
    check(
      'order_status_transitions_post_freeze_cancel_demands_fault',
      sql`${table.payloadKind} <> 'cancel_post_freeze'
          or ${table.requiredPayloadKeys} @> array['fault', 'reason']::text[]`,
    ),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// The order
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One order, from anonymous cart to whatever it ends as.
 *
 * ── Ownership is a column, not a check ──────────────────────────────────────────
 *
 * Plan 6's fourth scope variant is `{ kind: 'guest', guestId }`, and plan 7.4 trap 2 says
 * ownership belongs in the query that loads the order. Both land here as two nullable
 * columns and one CHECK that at least one is set, so the loading query is
 *
 *     … WHERE id = $1 AND (customer_user_id = $2 OR guest_id = $3)
 *
 * and an order that belongs to nobody cannot exist to be found by the query that forgot.
 * The anonymous visitor is the main funnel, so `customer_user_id IS NULL` is the ordinary
 * case and not an edge one. Signing in *adds* the user id and leaves the guest id in
 * place: the browser keeps sending the same guest cookie, and a cart that stopped being
 * findable at the moment of login would be a cart lost at the exact moment it converted.
 *
 * ── The circular FK, and which side gives ───────────────────────────────────────
 *
 * Trap 1. `orders.status_event_id` must name the event that put this order in its current
 * status, and `order_events.order_id` must name the order — both NOT NULL, and an order
 * therefore impossible to insert at all.
 *
 * **The order side gives, and it gives deferrability rather than nullability.** The FK is
 * `DEFERRABLE INITIALLY DEFERRED` (added by hand in `drizzle/0007_order_guards.sql`,
 * because drizzle-kit emits no such clause), so:
 *
 *     1. INSERT INTO orders (…, status_event_id) VALUES (…, $eventId)   -- id chosen by the caller
 *     2. INSERT INTO order_events (id, order_id, …) VALUES ($eventId, $orderId, …)
 *     3. COMMIT                                                        -- both FKs checked here
 *
 * The alternative — making the column nullable — was rejected because it moves the cost to
 * every reader forever: "an order always knows which event set its status" is worth more
 * than the convenience of inserting in the obvious order once. The event side stays
 * immediate and NOT NULL, so an event can never float free of an order.
 *
 * And the FK is **composite**: `(status_event_id, id, status)` references
 * `order_events (id, order_id, to_status)`. That is the trick `catalog.ts` uses to stop a
 * denormalised copy drifting — here it makes "the current status is the status the current
 * event set, on this order" a fact Postgres checks rather than a fact a service asserts.
 */
export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * The number a customer reads out on the phone. Minted at submit, never before.
     *
     * A draft is a cart, and most carts are abandoned; numbering them would burn a
     * sequence on browsing and publish the company's abandonment rate to anyone who
     * ordered twice. `order_no_seq` in the guards migration is the source; the API formats
     * it. Write-once, enforced by trigger.
     */
    orderNo: text('order_no').unique(),

    status: text('status', { enum: ORDER_STATUSES }).notNull().default('draft'),

    /**
     * The event that put this order in `status`. See the composite deferrable FK above.
     *
     * No `.references()` here on purpose: drizzle-kit would emit an immediate,
     * single-column FK and trap 1 would be back. The constraint lives in
     * `drizzle/0007_order_guards.sql` and is named `orders_status_event_fk`.
     */
    statusEventId: uuid('status_event_id').notNull(),

    // ── ownership ────────────────────────────────────────────────────────────
    /**
     * The account that owns this order, once there is one.
     *
     * `ON DELETE RESTRICT`, which is a deliberate break with `auth.ts`'s "cascade towards
     * the user, an erasure is one DELETE" convention, and the break needs saying out loud:
     * an order is an accounting record. Plan 13 lists retention as unanswered (five years
     * for accounting documents, to be confirmed with the bookkeeper) and PDPA erasure
     * pulls the other way. Until somebody answers, refusing the delete is the fail-closed
     * direction — a `DELETE FROM users` that stops with a visible error beats one that
     * silently destroys the only record of what a customer bought. Draft carts *are*
     * deletable (see `orders_block_delete()`), so an erasure routine can clear the funnel
     * without a decision.
     */
    customerUserId: uuid('customer_user_id').references(() => users.id, {
      onUpdate: 'cascade',
      onDelete: 'restrict',
    }),
    /** The anonymous visitor this began as. Plan 6: a real row, so a cart can hold a foreign key. */
    guestId: uuid('guest_id').references(() => guests.id, {
      onUpdate: 'cascade',
      onDelete: 'restrict',
    }),

    /**
     * Where a notification can reach this customer. Required at submit, not before.
     *
     * Plan 10.2 names the exact place the funnel leaks: v1 lets anyone see a price without
     * signing in — right for browsing — but a quote with no channel on it is a quote
     * nobody can be told anything about, and every message in plan 10.3 is then undeliverable.
     * So the ask happens once, at submit, and is one field.
     */
    contactEmail: text('contact_email'),
    contactName: text('contact_name'),
    contactPhone: text('contact_phone'),
    /**
     * The language notifications go out in when there is no account to ask.
     *
     * Plan 10.6 splits this deliberately: a *notification* uses the recipient's current
     * language, a *document* uses the language pinned at submit
     * (`order_documents.pinned_locale`). A guest has no account to hold a preference, so
     * this column is where "current" lives for them, and it is meant to be updated.
     */
    contactLocale: text('contact_locale').notNull().default('th'),

    /**
     * Where the order is going, chosen by the customer at submit. Migration 0032.
     *
     * Nullable and mutable, both deliberately. Nullable because all 25 existing orders — the
     * 21 carrying an issued document and the 4 drafts — predate the question, and migration
     * 0017 established the house answer to inventing a value for a new NOT NULL column: it
     * deleted the rows rather than guess, and these do not qualify for deletion. Mutable
     * because a customer who picks the wrong country should be correctable before the
     * document freezes; the tax that country produced stays pinned on the issued quotation
     * (`order_documents.destination_country`), never read live from here again.
     *
     * No foreign key to `tax_countries`. `TaxCountryService.resolveDestination` (Task 7) does
     * the checking, so it can tell *withdrawn* from *unknown* — a constraint cannot, and would
     * treat both alike, turning a routine withdrawal (`is_active = false`) into a broken cart.
     */
    destinationCountry: char('destination_country', { length: 2 }),

    // ── the revision chain ───────────────────────────────────────────────────
    /**
     * The order this one replaces. Set at insert, immutable afterwards.
     *
     * `superseded` needs a successor to mean anything, so entering it is refused unless
     * one exists (`orders_guard_update()`). Immutable rather than write-once because a
     * later `A supersedes B` on a row that `B` already supersedes is the only way to build
     * a cycle, and a cycle would hang the ancestor walk that 5b's money fold depends on.
     *
     * SEAM 5b: money follows this pointer as an *allocation* carrying
     * `carried_from_order_id`, never as an instalment row on the new order — plan 7.8, so
     * one payment is not reported by two orders forever. Trap 7 is closed structurally at
     * this end (a superseded order cannot be left with nowhere to carry its money to) and
     * financially at the ledger end.
     */
    supersedesOrderId: uuid('supersedes_order_id'),

    // ── the freeze point ─────────────────────────────────────────────────────
    /**
     * When this order first entered `production_confirmed`. Plan 7.5(ข).
     *
     * ⚠️ **This is the freeze point as a fact the database can see**, which is the whole
     * reason it is a column and not an inference. Three different readers need it and only
     * one of them is application code:
     *
     *   * the cancellation report — "was aluminium already committed?" — asked long after
     *     the status has become `cancelled` and can no longer answer;
     *   * `orders_post_freeze_requires_frozen_at`, which makes a post-freeze status with
     *     no freeze stamp unrepresentable;
     *   * the invariant that separates `redesign` from `draft`.
     *
     * Stamped by trigger on entry, never by the caller, and write-once. A second entry
     * into `production_confirmed` after a redesign does **not** re-stamp it: the order was
     * frozen the first time, and that is the date the money rules are about.
     */
    frozenAt: timestamp('frozen_at', { withTimezone: true }),

    /** When the customer submitted. Non-null is what "this has a contract" means; see the shape CHECK. */
    submittedAt: timestamp('submitted_at', { withTimezone: true }),

    /**
     * The pinned document this order is currently contracted on. Trap 3.
     *
     * Between submit and accept a catalogue version can be published; without a pin, sales
     * looking at a slip the next morning builds the contract from a document the customer
     * never saw. `order_documents` is that pin, frozen on write, one row per revision.
     * The FK is composite — `(document_id, id)` → `order_documents (id, order_id)` — so a
     * document belonging to a *different* order cannot be attached, and it is added by
     * hand in the guards migration because it closes a cycle drizzle-kit cannot order.
     */
    documentId: uuid('document_id'),

    // ── money: the single base, plan 4.4 and 7.13 ────────────────────────────
    currency: char('currency', { length: 3 }).notNull().default('THB'),
    /** The tax base. Result of `calcPrice` plus overrides (5c). */
    netThbMinor: bigint('net_thb_minor', { mode: 'bigint' }),
    /** Derived, never typed by a human — plan 4.4. Stored because a reprint must foot without recomputing. */
    vatThbMinor: bigint('vat_thb_minor', { mode: 'bigint' }),
    /**
     * What the customer transfers. **Always VAT-inclusive** — plan 4.4, and the one thing
     * in this area that is not configurable. Instalments, deposits, forfeits and refunds
     * all reference this number and only this number.
     */
    grandTotalThbMinor: bigint('grand_total_thb_minor', { mode: 'bigint' }),
    /**
     * The deposit obligation, pinned at submit. Plan 7.13.
     *
     * Pinned rather than computed at cancellation time because it is a *term of the
     * contract*: plan 7.13 found three different formulas producing ฿5,530 and ฿18,432 on
     * the same 30/70 shape, and that number is the ceiling on what may be forfeited. A
     * value computed later is a value that changes when the schedule is edited.
     *
     * SEAM 5b: `forfeitBase = min(receivedMinor, scheduled_deposit_thb_minor)`, then bps,
     * then clamped by cash actually received.
     */
    scheduledDepositThbMinor: bigint('scheduled_deposit_thb_minor', { mode: 'bigint' }),

    /**
     * The `cashflow` approval floor in force **when this contract was made**, in basis points.
     *
     * ── What it is, and why the column beside it cannot stand in for it ─────────
     *
     * `organisation_profile.deposit_bp` is the share of `grand_total_thb_minor` a payment
     * schedule must gate before production opens. Anything the schedule gates *below* it is a
     * `cashflow` concession — money the company agreed not to hold before cutting aluminium —
     * and `AuthorityService.measureFor` is the one place that subtraction happens.
     *
     * It read the setting **live**, so an order submitted while the policy was 30% and re-read
     * after the owner moved it to 100% reported a 70% concession nobody ever asked for. Not a
     * money defect — `gate` has one production caller and it runs inside the submit — but
     * `GET /quotes/authority/orders/:orderId` and the approval-detail `live` figure are audit
     * surfaces, and an audit trail that re-interprets a historical order against today's policy
     * answers a different question each time it is asked.
     *
     * `scheduled_deposit_thb_minor` above is **not** this number and cannot be made into it. It
     * is what the schedule *gates*; this is what the policy *required*. The concession is
     * `percentOf(grand_total, deposit_floor_bp) − scheduled_deposit_thb_minor`, so the same
     * pinned deposit against two different floors is two different concessions — ฿0 at a 30%
     * floor, 70% of the order at a 100% one. Two facts, and only one of them was recorded.
     *
     * The precedent is `approvals.decided_ceiling_thb_minor`, added by `0017` for the identical
     * retroactive re-interpretation on the ceiling side: pin the *input* the comparison was made
     * with, never the verdict. Which is why this is the floor and not the measured concession —
     * the concession is deliberately re-measured from the live schedule, and freezing it would
     * hide a schedule edited after submit.
     *
     * Nullable, and never backfilled. Every order submitted before this column existed genuinely
     * has no recorded floor, and `0029` seeded `deposit_bp` at 10 000 only as the shipping
     * default — writing that onto historical rows would assert a business fact nobody recorded.
     * `measureFor` falls back to the live policy on a NULL, which is exactly today's behaviour
     * for exactly the rows that already have it. Same call `forfeit_policy_id` above makes, and
     * `0017` before it.
     *
     * Deliberately **not** in `orders_submitted_shape`: that constraint is an `=` between two
     * nullabilities, and every already-submitted row would violate it.
     */
    depositFloorBp: smallint('deposit_floor_bp'),
    /**
     * ⭐ The deposit share somebody chose for **this** order — null when nobody did.
     *
     * Null is not 0%: it means the company setting applies. `PaymentLifecycleService`'s
     * re-issue reads this in preference to `organisation_profile.deposit_bp`, which is what
     * stops an authored deposit being reverted the next time staff edit and re-send a
     * quotation — the defect this column was added to prevent.
     *
     * ⚠️ Not write-once, unlike `depositFloorBp` above: that one records the policy the order
     * was *measured against* and must never move, while this is a decision staff may revisit
     * while the quotation is still being negotiated. Money is what closes it — see 0059.
     */
    depositBpAuthored: smallint('deposit_bp_authored'),

    /**
     * The forfeit policy in force **when this contract was made** — plan 7.13's seventh pin.
     *
     * Plan 7.13 lists `forfeit_policy` among the seven things `submit_for_payment` pins and
     * there was no column for it, so the rate applied at cancellation was *whatever is
     * effective now*: publishing a policy between the contract and the cancellation silently
     * changed what that customer got back, on a table nobody looks at while cancelling. The
     * forfeit is a term of the contract for the same reason `scheduled_deposit_thb_minor`
     * above is.
     *
     * Nullable and `ON DELETE restrict`: nullable because every order submitted before this
     * column existed genuinely has no pinned policy and inventing one would be inventing a
     * contract term, restrict because deleting a policy an order was priced under would
     * destroy the only record of the rate that will be applied to it.
     * `RefundsService.request` fails closed and loudly on an order with no pin rather than
     * quietly falling back to today's policy, which is the behaviour the pin exists to stop.
     *
     * The foreign key is declared in `0012_payment_closure.sql` rather than here:
     * `forfeit_policies` lives in `payment.ts`, which imports this file, and naming it here
     * would close the import cycle. It is a real FK in the database either way.
     */
    forfeitPolicyId: uuid('forfeit_policy_id'),

    ...timestamps,
  },
  (table) => [
    check('orders_status_known', sql`${table.status} in ${inList(ORDER_STATUSES)}`),
    check('orders_currency_is_thb', sql`${table.currency} = 'THB'`),

    /*
     * Plan 6's fourth scope, as an invariant. An order with neither owner is an order no
     * scoped query can ever return and no cleanup can ever attribute — it is a leak in
     * both directions at once.
     */
    check(
      'orders_has_an_owner',
      sql`num_nonnulls(${table.customerUserId}, ${table.guestId}) >= 1`,
    ),
    check(
      'orders_contact_email_lowercase',
      sql`${table.contactEmail} is null or ${table.contactEmail} = lower(${table.contactEmail})`,
    ),
    check(
      'orders_contact_email_shape',
      sql`${table.contactEmail} is null
          or ${table.contactEmail} ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'`,
    ),

    /*
     * ⓵ The draft/redesign split, as the two constraints that make it real (plan 7.1).
     * Delete either and the two statuses become synonyms with different spellings.
     */
    check(
      'orders_draft_has_no_contract',
      sql`${table.status} <> 'draft'
          or (${table.submittedAt} is null and ${table.frozenAt} is null and ${table.documentId} is null)`,
    ),
    check(
      'orders_redesign_has_a_contract',
      sql`${table.status} <> 'redesign'
          or (${table.submittedAt} is not null and ${table.frozenAt} is not null and ${table.documentId} is not null)`,
    ),

    /*
     * Everything a submit produces arrives together or not at all. `cancelled` is the one
     * status reachable from both sides — an abandoned draft and a cancelled contract are
     * both `cancelled` — which is why the predicate is `submitted_at`, not the status.
     */
    check(
      'orders_submitted_before_leaving_draft',
      sql`${table.status} in ('draft', 'cancelled') or ${table.submittedAt} is not null`,
    ),
    check(
      'orders_submitted_shape',
      sql`(${table.submittedAt} is null) = (${table.orderNo} is null)
          and (${table.submittedAt} is null) = (${table.documentId} is null)
          and (${table.submittedAt} is null) = (${table.grandTotalThbMinor} is null)
          and (${table.submittedAt} is null) = (${table.scheduledDepositThbMinor} is null)`,
    ),
    /*
     * Plan 10.2: a quote with no channel on it is a quote nobody can be told anything about.
     *
     * ⚠️ **A channel, not an address.** This was `contact_email is not null` until phone
     * numbers became identities, and the weakening is real: an order with only a number
     * satisfies this and still receives nothing, because the fan-out resolves recipients for
     * `email` alone. `0025_user_phones.sql` argues it at length and names the two places that
     * pay for it — the dashboard says the customer was not written to, and the quotation link
     * can be copied into LINE by hand.
     */
    check(
      'orders_submitted_has_a_contact_channel',
      sql`${table.submittedAt} is null
          or ${table.contactEmail} is not null
          or ${table.contactPhone} is not null`,
    ),
    /* The same canonical form `user_phones` demands — one telephone must not have two spellings across two columns. */
    check(
      'orders_contact_phone_e164',
      sql`${table.contactPhone} is null or ${table.contactPhone} ~ '^\\+[1-9][0-9]{7,14}$'`,
    ),
    /* Migration 0032. Shape only — whether the code names a real, still-relevant country is `resolveDestination`'s job, not a constraint's. */
    check(
      'orders_destination_country_shape',
      sql`${table.destinationCountry} is null or ${table.destinationCountry} ~ '^[A-Z]{2}$'`,
    ),
    check(
      'orders_frozen_after_submitted',
      sql`${table.frozenAt} is null
          or (${table.submittedAt} is not null and ${table.frozenAt} >= ${table.submittedAt})`,
    ),
    /*
     * Today no transition returns a frozen order to `awaiting_payment`, and the payload
     * selection in `order_status_transitions` leans on that: `cancel` is split by
     * `from_status`, which is only equivalent to being split by the freeze while the two
     * agree. If a "redesign needs more money" path is ever added, this constraint is where
     * you find out, and the fix is to key the split on `frozen_at` instead of on status.
     */
    check(
      'orders_awaiting_payment_is_pre_freeze',
      sql`${table.status} <> 'awaiting_payment' or ${table.frozenAt} is null`,
    ),

    /* Money: three columns or none, and the total foots. Plan 4.4. */
    check(
      'orders_money_shape',
      sql`num_nonnulls(${table.netThbMinor}, ${table.vatThbMinor}, ${table.grandTotalThbMinor}) in (0, 3)`,
    ),
    check(
      'orders_total_foots',
      sql`${table.grandTotalThbMinor} is null
          or ${table.grandTotalThbMinor} = ${table.netThbMinor} + ${table.vatThbMinor}`,
    ),
    check(
      'orders_money_nonnegative',
      sql`(${table.netThbMinor} is null or ${table.netThbMinor} >= 0)
          and (${table.vatThbMinor} is null or ${table.vatThbMinor} >= 0)`,
    ),
    /* A deposit obligation larger than the contract is not a deposit; a negative one is a refund. */
    check(
      'orders_scheduled_deposit_within_total',
      sql`${table.scheduledDepositThbMinor} is null
          or (${table.scheduledDepositThbMinor} >= 0
              and ${table.scheduledDepositThbMinor} <= ${table.grandTotalThbMinor})`,
    ),

    /*
     * The floor is a percentage or it is unrecorded — the same range
     * `organisation_profile_deposit_in_range` puts on the column it is copied from, restated
     * here because a copy that may drift is not a copy anybody can rely on. **1, not 0**: a
     * zero floor is expressed by authoring terms with no gate, and `depositPercentTerms(0)` is
     * refused by `planSchedule`.
     */
    check(
      'orders_deposit_floor_in_range',
      sql`${table.depositFloorBp} is null or ${table.depositFloorBp} between 1 and 10000`,
    ),
    /*
     * A draft has no contract and therefore no floor. Stated one-way rather than as the `=`
     * `orders_submitted_shape` uses, because NULL on a submitted row is the honest state of
     * every order that predates the column and inventing a value for them was refused.
     */
    check(
      'orders_deposit_floor_needs_a_contract',
      sql`${table.depositFloorBp} is null or ${table.submittedAt} is not null`,
    ),

    check(
      'orders_not_own_successor',
      sql`${table.supersedesOrderId} is distinct from ${table.id}`,
    ),
    /* One successor per order. Two revisions of one contract is two answers to what was agreed. */
    unique('orders_supersedes_order_key').on(table.supersedesOrderId),

    /* The scoped read, indexed: this is the query plan 7.4 trap 2 wants everybody to use. */
    index('orders_customer_status_idx').on(table.customerUserId, table.status),
    index('orders_guest_idx')
      .on(table.guestId)
      .where(sql`guest_id is not null`),
    /* The staff queues. Partial, because the two terminal statuses are most of the table after a year. */
    index('orders_live_status_idx')
      .on(table.status, table.updatedAt)
      .where(sql`status not in ('cancelled', 'superseded', 'delivered')`),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// The spine
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Everything that ever happened to an order, in order, forever.
 *
 * Append-only, enforced the way the catalogue enforces a published document: a trigger
 * (`order_events_append_only()`), not a convention. UPDATE is refused outright; DELETE is
 * refused unless the parent order is a never-submitted draft being deleted, which is the
 * one case where nothing of record is lost.
 *
 * Why it is the spine and not a log:
 *
 *   * `orders.status_event_id` points into it, so the current status is *derived from* a
 *     row here rather than merely accompanied by one;
 *   * plan 7.5(ค) needs "has this order ever been in `production_confirmed`?" — a gate can
 *     close again when a `remainder` instalment is recomputed upwards, so entitlement is
 *     `ever entered OR currently paid`, and only this table can answer the first half;
 *   * plan 10.1 makes notifications a *consumer* of this table. The outbox row is written
 *     by a trigger on this table, in the transaction that wrote the event.
 */
export const orderEvents = pgTable(
  'order_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onUpdate: 'cascade', onDelete: 'cascade' }),
    /**
     * Position on the spine, 1-based, assigned by trigger.
     *
     * Assigned rather than accepted because a caller that picks its own would eventually
     * pick one twice, and `created_at` cannot break the tie — two events in one
     * transaction share a `now()`. The uniqueness below is the arbiter under concurrency:
     * two transactions appending to one order collide on it and one retries, which is the
     * correct outcome and is why the transition path takes `SELECT … FOR UPDATE` on the
     * order first.
     *
     * The `DEFAULT 0` is a sentinel and never survives an insert — `order_events_guard_insert()`
     * overwrites whatever arrives. It exists so a caller may omit the column, and the
     * `seq >= 1` CHECK beside it is what turns a dropped trigger into a failed write rather
     * than a table full of zeroes.
     */
    seq: integer('seq').notNull().default(0),
    eventType: text('event_type', { enum: ORDER_EVENT_TYPES }).notNull(),
    /** Null only on the genesis event (`seq = 1`), which is the one event with nothing before it. */
    fromStatus: text('from_status', { enum: ORDER_STATUSES }),
    /** Null on events that are not status changes — a quote revision, a change request. */
    toStatus: text('to_status', { enum: ORDER_STATUSES }),

    actorKind: text('actor_kind', { enum: ORDER_ACTOR_KINDS }).notNull(),
    /** `ON DELETE RESTRICT` for the reason `orders.customer_user_id` gives: this is an accounting record. */
    actorUserId: uuid('actor_user_id').references(() => users.id, {
      onUpdate: 'cascade',
      onDelete: 'restrict',
    }),
    actorGuestId: uuid('actor_guest_id').references(() => guests.id, {
      onUpdate: 'cascade',
      onDelete: 'restrict',
    }),

    /**
     * What the transition carried. Shape is the API's business; presence is not.
     *
     * `order_status_transitions.required_payload_keys` is checked against this on insert,
     * which is the backstop for trap 4: a `fault` that zod stripped never reaches a
     * cancellation as an absence.
     */
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),

    /**
     * The transaction that wrote this row.
     *
     * Not diagnostics. `notifications_guard_insert()` compares it against
     * `pg_current_xact_id()` to make plan 10.1's "written in the same transaction as the
     * event" a rule the database enforces rather than a sentence in a comment. Kept as
     * `text` because `xid8` is unsigned 64-bit and has no lossless `bigint` domain, and
     * because equality is the only operation anything performs on it.
     */
    writeTxid: text('write_txid')
      .notNull()
      .default(sql`pg_current_xact_id()::text`),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('order_events_type_known', sql`${table.eventType} in ${inList(ORDER_EVENT_TYPES)}`),
    check('order_events_actor_kind_known', sql`${table.actorKind} in ${inList(ORDER_ACTOR_KINDS)}`),
    check(
      'order_events_status_known',
      sql`(${table.fromStatus} is null or ${table.fromStatus} in ${inList(ORDER_STATUSES)})
          and (${table.toStatus} is null or ${table.toStatus} in ${inList(ORDER_STATUSES)})`,
    ),
    check('order_events_seq_positive', sql`${table.seq} >= 1`),

    unique('order_events_order_seq_key').on(table.orderId, table.seq),
    /*
     * The handle `orders.status_event_id` hangs off. A three-column UNIQUE so the composite
     * FK can prove all three facts at once: the event exists, it belongs to this order, and
     * the status it moved the order *to* is the status the order is in.
     */
    unique('order_events_id_order_status_key').on(table.id, table.orderId, table.toStatus),
    /*
     * And the handle every *other* table hangs off, for the same reason `catalog.ts` keeps
     * `(id, option_group_id)` around: a child row that names both an order and an event can
     * then be made to prove they are the same order's. Redundant against the primary key as
     * a uniqueness claim, load-bearing as a foreign-key target.
     */
    unique('order_events_id_order_key').on(table.id, table.orderId),

    /*
     * A status change names where it came from, except at the beginning. An event with a
     * `from` and no `to` is a half-recorded transition, and the row that would leave
     * `orders.status` pointing at nothing.
     */
    check(
      'order_events_status_pair_shape',
      sql`case
            when ${table.toStatus} is null then ${table.fromStatus} is null
            when ${table.fromStatus} is null then ${table.seq} = 1
            else true
          end`,
    ),
    /*
     * The actor, spelled out. `staff` and `customer` are people and must be identifiable —
     * "who cancelled this" is the first question asked about a cancelled order — and
     * `system` is the timer or the worker and must not borrow anybody's name.
     */
    check(
      'order_events_actor_shape',
      sql`case ${table.actorKind}
            when 'customer' then ${table.actorUserId} is not null and ${table.actorGuestId} is null
            when 'staff'    then ${table.actorUserId} is not null and ${table.actorGuestId} is null
            when 'guest'    then ${table.actorGuestId} is not null and ${table.actorUserId} is null
            else ${table.actorUserId} is null and ${table.actorGuestId} is null
          end`,
    ),
    check('order_events_payload_is_object', sql`jsonb_typeof(${table.payload}) = 'object'`),

    /* The order's own history, newest last — the only order this table is ever read in. */
    index('order_events_order_seq_idx').on(table.orderId, table.seq),
    index('order_events_type_idx').on(table.eventType, table.createdAt),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// The pinned document — trap 3
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the customer was shown, frozen, one row per revision.
 *
 * Plan 7.4 trap 3: nothing was pinned between submit and accept. Sales opens the slip
 * hours later; if a catalogue version was published in between, the contract is built from
 * a different document than the customer saw. So `submit_for_payment` writes one of these
 * and `orders.document_id` points at it.
 *
 * Frozen on write, exactly like `product_versions`: UPDATE is refused outright. A change
 * is a new revision, which is also what makes plan 10.4's diff possible — "what we agreed"
 * and "what changed" are revision *n* and revision *n+1*, and without two rows there is
 * nothing to show a customer who is being asked to accept an edit.
 *
 * ── The seven pins, and the two that do not exist yet ────────────────────────────
 *
 * Plan 7.13 lists seven things one transaction must pin: catalogue version, rate, core
 * version, VAT rate, forfeit policy, payment policy, scheduled deposit. Five are here or
 * on `orders`; two — the forfeit and payment policies — belong to tables 5b creates, and
 * inventing dangling uuid columns for them now would be worse than naming the seam.
 * `pin_schema_version` is how that stays safe: it says which recipe `document_hash` was
 * computed from, so 5b bumping it to 2 cannot be compared against a hash made under
 * recipe 1. Plan 4.5 is a list of payloads whose version field and content drifted apart
 * in silence; this is that lesson applied before the fact.
 *
 * The `rate` pin is deliberately absent rather than seamed: plan 13's default is that the
 * foreign-currency line is closed entirely and every invoice is THB, so there is no rate
 * to pin. 5c opens it, and adds the column with the FX tables.
 */
export const orderDocuments = pgTable(
  'order_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onUpdate: 'cascade', onDelete: 'cascade' }),
    /** 1-based. Plan 7.9(จ)'s `quoteRevision`: the token a client sends back so a stale edit is a 409. */
    revision: integer('revision').notNull(),

    /**
     * The quote as the customer saw it. Opaque here.
     *
     * SEAM 5c: the shape inside is the sales-editable quote's business — lines, overrides
     * with both `computed_minor` and `override_minor`, the presentment currency. This
     * table's job is that it cannot change afterwards and that its hash is comparable.
     */
    document: jsonb('document').notNull(),
    /** SHA-256 over the canonical serialisation, like `product_versions.document_hash`. */
    documentHash: char('document_hash', { length: 64 }).notNull(),
    pinSchemaVersion: smallint('pin_schema_version').notNull().default(1),

    /** Which build of `@wewin/core` produced the numbers. A price that cannot be reproduced is not evidence. */
    pinnedCoreVersion: text('pinned_core_version').notNull(),
    pinnedVatRateBp: integer('pinned_vat_rate_bp').notNull(),
    pinnedVatTreatment: text('pinned_vat_treatment', { enum: VAT_TREATMENTS }).notNull(),
    /** Plan 10.6: a document reprinted in a different language is a document nobody can cite. */
    pinnedLocale: text('pinned_locale').notNull(),

    /* The totals as pinned. `orders_totals_match_document()` refuses to let the order and its own document disagree. */
    currency: char('currency', { length: 3 }).notNull().default('THB'),
    netThbMinor: bigint('net_thb_minor', { mode: 'bigint' }).notNull(),
    vatThbMinor: bigint('vat_thb_minor', { mode: 'bigint' }).notNull(),
    grandTotalThbMinor: bigint('grand_total_thb_minor', { mode: 'bigint' }).notNull(),

    /**
     * The event that produced this revision — so the diff notification knows what to talk
     * about. Tied to `order_id` by a composite FK below, so it cannot be another order's.
     */
    createdByEventId: uuid('created_by_event_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'order_documents_created_by_event_fk',
      columns: [table.createdByEventId, table.orderId],
      foreignColumns: [orderEvents.id, orderEvents.orderId],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    unique('order_documents_order_revision_key').on(table.orderId, table.revision),
    /* The handle `orders.document_id` hangs off: a document of *this* order, not of another one. */
    unique('order_documents_id_order_key').on(table.id, table.orderId),
    check('order_documents_revision_positive', sql`${table.revision} >= 1`),
    check('order_documents_currency_is_thb', sql`${table.currency} = 'THB'`),
    check('order_documents_hash_is_hex', sql`${table.documentHash} ~ '^[0-9a-f]{64}$'`),
    check('order_documents_document_is_object', sql`jsonb_typeof(${table.document}) = 'object'`),
    check(
      'order_documents_vat_treatment_known',
      sql`${table.pinnedVatTreatment} in ${inList(VAT_TREATMENTS)}`,
    ),
    check(
      'order_documents_vat_rate_in_range',
      sql`${table.pinnedVatRateBp} between 0 and 10000`,
    ),
    /* Plan 4.4: `grand_total` always includes VAT, and the three columns always foot. */
    check(
      'order_documents_total_foots',
      sql`${table.grandTotalThbMinor} = ${table.netThbMinor} + ${table.vatThbMinor}`,
    ),
    check(
      'order_documents_money_nonnegative',
      sql`${table.netThbMinor} >= 0 and ${table.vatThbMinor} >= 0`,
    ),
    index('order_documents_order_idx').on(table.orderId, table.revision),
  ],
);

/**
 * Which catalogue versions a pinned document was built from.
 *
 * The other half of trap 3, and the half a JSONB blob cannot do: a real foreign key. It
 * buys two things a `document ->> 'productVersionId'` scan does not — `ON DELETE RESTRICT`,
 * so a version a contract cites can never be removed from under it, and an answerable
 * question ("which contracts cite this version?") when a catalogue mistake is found.
 *
 * A trigger additionally refuses a `draft` version: a contract built from something nobody
 * published is a contract built from a document that was still being edited.
 */
export const orderDocumentProductVersions = pgTable(
  'order_document_product_versions',
  {
    orderDocumentId: uuid('order_document_id')
      .notNull()
      .references(() => orderDocuments.id, { onUpdate: 'cascade', onDelete: 'cascade' }),
    productVersionId: uuid('product_version_id')
      .notNull()
      .references(() => productVersions.id, { onUpdate: 'cascade', onDelete: 'restrict' }),
  },
  (table) => [
    primaryKey({
      name: 'order_document_product_versions_pkey',
      columns: [table.orderDocumentId, table.productVersionId],
    }),
    index('order_document_product_versions_version_idx').on(table.productVersionId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// The customer's objection — trap 5, and plan 10.4
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A customer asking for something to change, and the thing that clears it.
 *
 * Trap 5 is a request with nothing to resolve it: the first one blocks every later one for
 * the lifetime of the order. Both halves are here and neither works without the other —
 * `order_change_requests_one_open` makes a second request while one is open a 23505 the
 * API can turn into a sentence, and `resolved_event_id` is the path that makes the *next*
 * one possible. Take the resolution columns away and the partial index becomes the bug.
 *
 * It is also plan 10.4's objection button, which is called out as the biggest gap in the
 * "sales can edit anything" round: today a customer's only way to withhold consent is to
 * not transfer money, which strands the order in `awaiting_payment` forever because there
 * is no timeout. So an open request **blocks entry to `production_confirmed`** — the
 * freeze does not happen over an unanswered objection. That cannot strand the order
 * either: `rejected` is a resolution, and taking it is a decision with a name on it.
 */
export const orderChangeRequests = pgTable(
  'order_change_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onUpdate: 'cascade', onDelete: 'cascade' }),
    /** The `change_requested` event. The spine carries who asked and when; this row carries whether it is answered. */
    openedEventId: uuid('opened_event_id').notNull(),
    /** What the customer said, in their words. Never rendered onto a production sheet — plan 7.9(ค). */
    noteTh: text('note_th'),

    resolvedEventId: uuid('resolved_event_id'),
    resolution: text('resolution', {
      enum: ['accepted', 'rejected', 'withdrawn', 'superseded'],
    }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /*
     * Both events are tied to this row's order. A resolution recorded on somebody else's
     * spine would answer an objection nobody made, and leave this one open forever.
     */
    foreignKey({
      name: 'order_change_requests_opened_event_fk',
      columns: [table.openedEventId, table.orderId],
      foreignColumns: [orderEvents.id, orderEvents.orderId],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    foreignKey({
      name: 'order_change_requests_resolved_event_fk',
      columns: [table.resolvedEventId, table.orderId],
      foreignColumns: [orderEvents.id, orderEvents.orderId],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    /* One open request at a time — and, with the columns below, only at a time. */
    uniqueIndex('order_change_requests_one_open')
      .on(table.orderId)
      .where(sql`resolved_event_id is null`),
    /* Three columns, one fact — the shape `guests_claim_shape` uses. */
    check(
      'order_change_requests_resolution_shape',
      sql`num_nonnulls(${table.resolvedEventId}, ${table.resolution}, ${table.resolvedAt}) in (0, 3)`,
    ),
    check(
      'order_change_requests_resolution_known',
      sql`${table.resolution} is null
          or ${table.resolution} in ('accepted', 'rejected', 'withdrawn', 'superseded')`,
    ),
    index('order_change_requests_order_idx').on(table.orderId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// The outbox — plan 10
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⚠️ A DEFAULT, NOT A DECISION — plan 13. Email only, coalesce ten minutes, five attempts.
 *
 * LINE is the channel Thai customers actually read (plan 10.2) and it is *not* enabled
 * here, because LINE OA charges per push and requires the customer to have added the
 * account as a friend — a cost and a funnel step nobody has agreed to. The schema carries
 * `'line'` as a legal channel so enabling it later is a row in `notification_rules` and
 * one adapter in the worker, which is the whole argument of plan 10.1.
 */
export const NOTIFICATION_COALESCE_SECONDS_DEFAULT = 600;
export const NOTIFICATION_MAX_ATTEMPTS_DEFAULT = 5;

export const NOTIFICATION_CHANNELS = ['email', 'line'] as const;
export const NOTIFICATION_RECIPIENT_KINDS = ['customer', 'sales_queue', 'approver_queue'] as const;
export const NOTIFICATION_STATUSES = ['pending', 'sending', 'sent', 'dead', 'suppressed'] as const;

/*
 * The unions, beside `OrderStatus` where they belong.
 *
 * The arrays were exported and the types were not, so `src/notifications` derived its own
 * copies with a note saying they belonged here. Three names for three closed sets is not a
 * problem until the day one list grows and only one of the two files is edited — which is
 * how a status list drifts, and this schema exists partly because that has happened before.
 */
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];
export type NotificationRecipientKind = (typeof NOTIFICATION_RECIPIENT_KINDS)[number];
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

/**
 * Who hears about what, as data.
 *
 * Plan 10.3 is a table of event → recipient → why, and this is that table. Data rather
 * than a `switch` in the worker for the reason plan 10.1 gives about `sendEmail()` in
 * twenty transition handlers: adding LINE has to be one adapter, and adding a recipient
 * has to be one row, or neither happens.
 *
 * An empty table means no notifications — fail-silent, which plan 13 warns about — so the
 * rows are seeded in the guards migration and marked as the plan's defaults.
 */
export const notificationRules = pgTable(
  'notification_rules',
  {
    eventType: text('event_type', { enum: ORDER_EVENT_TYPES }).notNull(),
    recipientKind: text('recipient_kind', { enum: NOTIFICATION_RECIPIENT_KINDS }).notNull(),
    channel: text('channel', { enum: NOTIFICATION_CHANNELS }).notNull(),
    /** Which message. The template itself lives in the worker, in eight languages (plan 10.6). */
    templateKey: text('template_key').notNull(),
    /**
     * The coalescing bucket, or null for "never fold this one".
     *
     * Plan 10.5(2): five edits in ten minutes must not be five messages. Folding is by
     * *meaning* and not by time alone — the key is what says which messages mean the same
     * thing — so `quote_revised` folds and `delivered` does not. A delivery notice that
     * swallowed the previous delivery notice would be a lost fact, not a saved message.
     */
    coalesceGroup: text('coalesce_group'),
    /**
     * How long the fold stays open.
     *
     * Defaults to zero, not to plan 13's ten minutes, because a window only means anything
     * next to a `coalesce_group` — and a column default that violates the CHECK beside it
     * for the commonest row is a trap in its own right. `NOTIFICATION_COALESCE_SECONDS_DEFAULT`
     * is the plan's number, passed by whoever writes a folding rule.
     */
    coalesceSeconds: integer('coalesce_seconds').notNull().default(0),
    /**
     * Off is a state, not a deleted row.
     *
     * Turning a message off by deleting its rule loses the record that it ever existed;
     * turning it off here leaves the template key, the recipient and the day somebody
     * changed their mind. It is also how the LINE rows will ship disabled the moment the
     * owner answers plan 13's channel question.
     */
    isEnabled: boolean('is_enabled').notNull().default(true),
  },
  (table) => [
    primaryKey({
      name: 'notification_rules_pkey',
      columns: [table.eventType, table.recipientKind, table.channel],
    }),
    check('notification_rules_channel_known', sql`${table.channel} in ${inList(NOTIFICATION_CHANNELS)}`),
    check(
      'notification_rules_recipient_kind_known',
      sql`${table.recipientKind} in ${inList(NOTIFICATION_RECIPIENT_KINDS)}`,
    ),
    check('notification_rules_event_type_known', sql`${table.eventType} in ${inList(ORDER_EVENT_TYPES)}`),
    check('notification_rules_template_key_shape', sql`${table.templateKey} ~ '^[a-z][a-z0-9_.]*$'`),
    check(
      'notification_rules_coalesce_window_sane',
      sql`${table.coalesceSeconds} >= 0 and (${table.coalesceGroup} is not null or ${table.coalesceSeconds} = 0)`,
    ),
  ],
);

/**
 * The outbox. One row per (event, recipient, channel), written by the event that caused it.
 *
 * ── Why this is not `sendEmail()` in a transition handler — plan 10.1 ────────────
 *
 * SMTP being down must not roll back a state change, and must not commit one with nobody
 * told. Retries have to exist, and "what did we actually send them" has to be answerable
 * during a dispute. Adding LINE has to be one adapter rather than twenty call sites. All
 * four are properties of a row, and none is a property of a function call.
 *
 * ── Why the same transaction is structural here and not a convention ─────────────
 *
 * The brief for this phase is that the outbox row must be written in the same transaction
 * as the event, "structurally true rather than a convention a service can forget". Two
 * mechanisms in `drizzle/0007_order_guards.sql` do that, and they close different holes:
 *
 *   `order_events_fan_out_notifications()`  AFTER INSERT on `order_events`. Nobody writes
 *     these rows by hand, so nobody can omit them: the same statement that appends to the
 *     spine produces the outbox rows, and a rollback of the event takes them with it.
 *
 *   `notifications_guard_insert()`  BEFORE INSERT here. Refuses any row that did not come
 *     from a trigger, and refuses any row whose event was written by a *different*
 *     transaction (`order_events.write_txid` vs `pg_current_xact_id()`). Without it the
 *     fan-out is merely the usual path and a worker could still queue a message an hour
 *     later against an event that committed long ago — which is the failure the plan
 *     describes, arriving through the back door.
 *
 * Retrying is an UPDATE and an append to `notification_attempts`; neither is an INSERT
 * here, so the guard costs the worker nothing.
 *
 * SEAM 5b/5c and beyond: this table's producer is `order_events` and only `order_events`.
 * Review invitations (plan 9.2) and the approver's inbox (plan 10.3) have producers that
 * are not orders, and the shape that fits them is a second nullable source column plus a
 * CHECK that exactly one is set — not a nullable `event_id`, which would delete the
 * guarantee above for the rows that still have one.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onUpdate: 'cascade', onDelete: 'cascade' }),
    /** The event that caused this message. Part of the idempotency key — plan 10.5(1). */
    eventId: uuid('event_id').notNull(),
    /**
     * The newest event folded into this pending message.
     *
     * Equal to `event_id` until something coalesces onto it. Kept separate because the
     * idempotency key must stay the *first* event — moving it would let the same message
     * be produced twice — while the renderer wants the latest state to describe.
     */
    latestEventId: uuid('latest_event_id').notNull(),

    recipientKind: text('recipient_kind', { enum: NOTIFICATION_RECIPIENT_KINDS }).notNull(),
    /**
     * Where it goes, as one comparable string: `email:a@b.test`, `user:<uuid>`, `group:sales_queue`.
     *
     * One column rather than three nullable ones because it is half of the idempotency key
     * and a key spread over columns that are null in different combinations is a key that
     * compares equal to nothing. Null only when the message could not be addressed at all,
     * which is the `suppressed` case below.
     */
    recipientKey: text('recipient_key'),
    channel: text('channel', { enum: NOTIFICATION_CHANNELS }).notNull(),
    templateKey: text('template_key').notNull(),

    status: text('status', { enum: NOTIFICATION_STATUSES }).notNull().default('pending'),
    /**
     * Why nothing was sent, when nothing was sent.
     *
     * A message with no address is the exact failure plan 10.5(3) is about — the company
     * believes the customer was told. So it is a visible row in a terminal state with a
     * reason on it, not a row that was never written.
     *
     *   `no_contact_channel`  nobody gave us an address.
     *   `channel_disabled`    the channel exists in the rules and has no address book yet.
     *   `recipient_erased`    ⚠️ the person asked to be forgotten. Added in 0009 after the
     *                         behaviour was *exercised* rather than reasoned about: a message
     *                         queued before `erase_user()` ran was still claimed and
     *                         delivered to the erased address afterwards, and a new event on
     *                         the same order re-addressed it from `orders.contact_email`,
     *                         which the accounting exemption keeps. Suppression is the only
     *                         answer that leaves the accounting record intact and still stops
     *                         the message: the address stays on the order, and the outbox
     *                         refuses to use it. Terminal, and deliberately *not* retryable —
     *                         `retry` only requeues `dead`, so the button that would have
     *                         re-sent this months later can no longer reach it.
     *
     * TS-only narrowing: the column is plain `text` in Postgres with no CHECK on its values,
     * so this widening needs no DDL. That is stated rather than assumed — it is the reason
     * this change is one line and not a migration of an enum type.
     */
    /*
     * ⚠️ `balance_settled` is the fourth, and the first that is not about reachability. The
     * other three all mean *we could not write to them*; this one means *there was no longer
     * anything to say* — a customer who paid their balance between the reminder being asked for
     * and the worker draining the queue. The outbox groups them apart for that reason, and the
     * screen used to file this one under "go and find their address", which is an errand for a
     * customer who has already paid.
     *
     * It was added to the writer and to the screen and NOT to this list, and it compiled anyway:
     * `suppress()` takes `reason: string` and writes raw SQL, and the column has no CHECK. So
     * the narrowing sat here presenting three reasons as the set while a fourth was already in
     * the table — a type that is wrong in the one direction a type cannot warn about.
     */
    suppressedReason: text('suppressed_reason', {
      enum: ['no_contact_channel', 'channel_disabled', 'recipient_erased', 'balance_settled'],
    }),

    /** The folding bucket, copied from the rule that produced this row. Null means never fold. */
    coalesceKey: text('coalesce_key'),
    coalescedCount: integer('coalesced_count').notNull().default(0),
    /**
     * Not before this. The coalescing window, as a time the worker can index on.
     *
     * The window is why a message waits at all: five edits in ten minutes produce one row
     * whose `coalesced_count` reaches four and which is sent once, after the storm.
     */
    sendAfter: timestamp('send_after', { withTimezone: true }).notNull().defaultNow(),

    attemptCount: integer('attempt_count').notNull().default(0),
    lastError: text('last_error'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    /** When we gave up. Plan 10.5(3): `dead` has to surface in a queue somebody looks at. */
    deadAt: timestamp('dead_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    /* Both events belong to the order this message is about — see order_events_id_order_key. */
    foreignKey({
      name: 'notifications_event_fk',
      columns: [table.eventId, table.orderId],
      foreignColumns: [orderEvents.id, orderEvents.orderId],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    foreignKey({
      name: 'notifications_latest_event_fk',
      columns: [table.latestEventId, table.orderId],
      foreignColumns: [orderEvents.id, orderEvents.orderId],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    check('notifications_status_known', sql`${table.status} in ${inList(NOTIFICATION_STATUSES)}`),
    check('notifications_channel_known', sql`${table.channel} in ${inList(NOTIFICATION_CHANNELS)}`),
    check(
      'notifications_recipient_kind_known',
      sql`${table.recipientKind} in ${inList(NOTIFICATION_RECIPIENT_KINDS)}`,
    ),
    check(
      'notifications_recipient_key_shape',
      sql`${table.recipientKey} is null
          or ${table.recipientKey} ~ '^(email|user|guest|group):.+$'`,
    ),
    /*
     * ⓵ Idempotency — plan 10.5(1). `NULLS NOT DISTINCT` matters: a suppressed row has no
     * recipient, and under the default rule two nulls never collide, so the same
     * unaddressable event would produce a new suppressed row on every replay.
     */
    unique('notifications_idempotency_key')
      .on(table.eventId, table.recipientKey, table.channel)
      .nullsNotDistinct(),
    /*
     * ⓶ Coalescing — plan 10.5(2). Partial on `pending`: once a message has been sent, the
     * next edit is genuinely a new message, and folding into a sent row would be a message
     * nobody receives.
     */
    uniqueIndex('notifications_pending_coalesce_key')
      .on(table.orderId, table.coalesceKey, table.recipientKey, table.channel)
      .where(sql`status = 'pending' and coalesce_key is not null`),

    check(
      'notifications_status_shape',
      sql`case ${table.status}
            when 'sent'       then ${table.sentAt} is not null and ${table.deadAt} is null
            when 'dead'       then ${table.deadAt} is not null and ${table.attemptCount} > 0
            when 'suppressed' then ${table.suppressedReason} is not null and ${table.recipientKey} is null
            else ${table.sentAt} is null and ${table.deadAt} is null
          end`,
    ),
    /* Only a suppressed message may have nowhere to go. Anything else is a message about to be lost. */
    check(
      'notifications_addressed_unless_suppressed',
      sql`${table.status} = 'suppressed' or ${table.recipientKey} is not null`,
    ),
    check(
      'notifications_counters_nonnegative',
      sql`${table.attemptCount} >= 0 and ${table.coalescedCount} >= 0`,
    ),

    /* The worker's claim: `WHERE status='pending' AND send_after <= now() … FOR UPDATE SKIP LOCKED`. */
    index('notifications_due_idx')
      .on(table.sendAfter)
      .where(sql`status = 'pending'`),
    /* ⓷ The queue plan 10.5(3) demands. Partial, so looking at it costs nothing and is therefore done. */
    index('notifications_dead_idx')
      .on(table.deadAt)
      .where(sql`status = 'dead'`),
    index('notifications_order_idx').on(table.orderId, table.createdAt),
  ],
);

/**
 * One delivery attempt. Append-only, like the spine.
 *
 * This is the row that answers "what did we actually send them, when, and what did the
 * provider say" during a dispute — plan 10.1 lists that as one of the four reasons the
 * outbox exists at all, and a `last_error` column alone cannot answer it: it remembers
 * only the most recent failure and forgets the four before it.
 *
 * `locale` is recorded here rather than on `notifications` because plan 10.6 says a
 * notification goes out in the recipient's language **at the time of sending** — a
 * customer who switched to English yesterday should get English today. Pinning it when the
 * row was queued would freeze the wrong one of the two languages the plan distinguishes.
 */
export const notificationAttempts = pgTable(
  'notification_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    notificationId: uuid('notification_id')
      .notNull()
      .references(() => notifications.id, { onUpdate: 'cascade', onDelete: 'cascade' }),
    attemptNo: integer('attempt_no').notNull(),
    outcome: text('outcome', { enum: ['sent', 'failed'] }).notNull(),
    /** What was actually used, not what was planned — both may differ from the row's current values. */
    channel: text('channel', { enum: NOTIFICATION_CHANNELS }).notNull(),
    recipientKey: text('recipient_key').notNull(),
    locale: text('locale').notNull(),
    renderedSubject: text('rendered_subject'),
    providerMessageId: text('provider_message_id'),
    error: text('error'),
    attemptedAt: timestamp('attempted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('notification_attempts_attempt_key').on(table.notificationId, table.attemptNo),
    check('notification_attempts_attempt_no_positive', sql`${table.attemptNo} >= 1`),
    check('notification_attempts_outcome_known', sql`${table.outcome} in ('sent', 'failed')`),
    /* A failure with no message is a failure nobody can act on, which is how `dead` becomes silent. */
    check(
      'notification_attempts_failure_has_a_reason',
      sql`${table.outcome} <> 'failed' or ${table.error} is not null`,
    ),
    index('notification_attempts_notification_idx').on(table.notificationId, table.attemptNo),
  ],
);
