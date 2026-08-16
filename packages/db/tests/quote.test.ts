import { beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../src/client.js';
import {
  APPROVAL_DIMENSIONS,
  ORDER_STATUSES,
  OVERRIDE_ANCHORS,
  OVERRIDE_ENTRY_MODES,
  QUOTE_EDITABLE_ORDER_STATUSES,
  approvals,
  authorityLimits,
  groups,
  guests,
  orderDocuments,
  orderEvents,
  orderStatusTransitions,
  orders,
  quoteLines,
  quoteOverrides,
  users,
} from '../src/schema/index.js';
import { PG, connect, describeDb, errorCode } from './support/db.js';

/**
 * Phase 5c: the quote sales may edit, and the record of who edited it.
 *
 * Every block below is written so that **removing the guard makes it fail**. Each one was
 * mutation-tested against this database — drop the constraint or edit the function, watch
 * the test go red, put it back — and the ones where that turned out to be harder than it
 * looks are written down beside the test that changed. A guard nobody broke is a guard with
 * no evidence.
 *
 * ⚠️ The thing this file cannot test, stated once. Plan 7.9 gives up the mitigation that
 * "the api recomputes and 409s on mismatch" was: once a human may set any number, **no test
 * anywhere can assert that a total is correct**, because correct no longer has a definition.
 * What every test here asserts instead is provenance — which figure it was taken against,
 * who set it, what they typed, and that none of those three can afterwards be changed.
 *
 * Rows are not cleaned up. A submitted order cannot be deleted and an override on one
 * cannot either; a teardown able to remove them would contradict the schema it is testing.
 * `tests/globalSetup.ts` drops the whole database instead.
 */

const tag = randomUUID().slice(0, 8);

const expectViolation = async (
  operation: Promise<unknown>,
  code: (typeof PG)[keyof typeof PG],
): Promise<void> => {
  const caught = await operation.then(
    () => undefined,
    (error: unknown) => error,
  );

  expect(errorCode(caught), `expected SQLSTATE ${code}, got: ${String(caught)}`).toBe(code);
};

/** Plan 4.4's worked example: ฿8,791 net, 7% VAT, ฿9,406.37 grand, 30% of it. */
const NET = 879100n;
const VAT = 61537n;
const GRAND = 940637n;
const DEPOSIT = 282191n;

/** Plan 7.9(ก)'s line: computed ฿8,791, and the ฿8,500 sales promised out loud. */
const LINE_COMPUTED = 879100n;
const LINE_PROMISED = 850000n;

/** Plan 7.9(ข)'s two-of-a-kind: ฿18,432 for two, negotiated to ฿17,000. */
const PAIR_COMPUTED = 1_843_200n;
const PAIR_PROMISED = 1_700_000n;

type Draft = { orderId: string; guestId: string };

let db: Database;
let sales: string;
let manager: string;
let publishedVersionId: string;

const createUser = async (name: string): Promise<string> => {
  const [user] = await db.insert(users).values({ displayName: name }).returning({ id: users.id });
  if (!user) throw new Error('could not create a user');
  return user.id;
};

/** An anonymous cart, created the only way trap 1 permits — order first, event second, one transaction. */
const createDraft = async (): Promise<Draft> => {
  const [guest] = await db.insert(guests).values({}).returning({ id: guests.id });
  if (!guest) throw new Error('could not create a guest');

  const orderId = randomUUID();
  const eventId = randomUUID();

  await db.transaction(async (tx) => {
    await tx.insert(orders).values({
      id: orderId,
      statusEventId: eventId,
      guestId: guest.id,
      contactEmail: `quote-${randomUUID().slice(0, 8)}@example.test`,
    });
    await tx.insert(orderEvents).values({
      id: eventId,
      orderId,
      eventType: 'created',
      toStatus: 'draft',
      actorKind: 'guest',
      actorGuestId: guest.id,
    });
  });

  return { orderId, guestId: guest.id };
};

/** Submit: one transaction, one status move, and a frozen document. */
const submit = async (draft: Draft): Promise<void> => {
  const eventId = randomUUID();

  await db.transaction(async (tx) => {
    await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, draft.orderId)).for('update');

    await tx.insert(orderEvents).values({
      id: eventId,
      orderId: draft.orderId,
      eventType: 'submitted_for_payment',
      fromStatus: 'draft',
      /* The submit's destination since 0056; the staff confirmation follows. */
      toStatus: 'awaiting_confirmation',
      actorKind: 'guest',
      actorGuestId: draft.guestId,
    });

    const [document] = await tx
      .insert(orderDocuments)
      .values({
        orderId: draft.orderId,
        revision: 1,
        document: { lines: [] },
        documentHash: randomUUID().replace(/-/g, '').padEnd(64, '0').slice(0, 64),
        pinnedCoreVersion: '1.0.0',
        pinnedVatRateBp: 700,
        pinnedVatTreatment: 'standard',
        pinnedLocale: 'th',
        netThbMinor: NET,
        vatThbMinor: VAT,
        grandTotalThbMinor: GRAND,
        createdByEventId: eventId,
      })
      .returning({ id: orderDocuments.id });
    if (!document) throw new Error('could not pin a document');

    await tx
      .update(orders)
      .set({
        status: 'awaiting_confirmation',
        statusEventId: eventId,
        // The database clock, not this process one: the freeze trigger stamps frozen_at
        // with now(), orders_frozen_after_submitted compares the two, and a Node timestamp
        // makes that a race against container clock skew. See order.repository.ts.
        submittedAt: sql`now()`,
        orderNo: sql`'WW-' || nextval('order_no_seq')`,
        documentId: document.id,
        netThbMinor: NET,
        vatThbMinor: VAT,
        grandTotalThbMinor: GRAND,
        scheduledDepositThbMinor: DEPOSIT,
      })
      .where(eq(orders.id, draft.orderId));

    /* …and the staff confirmation, which is what makes the order payable since 0056. */
    const [confirmation] = await tx
      .insert(orderEvents)
      .values({
        orderId: draft.orderId,
        eventType: 'quotation_confirmed',
        fromStatus: 'awaiting_confirmation',
        toStatus: 'awaiting_payment',
        actorKind: 'staff',
        actorUserId: sales,
      })
      .returning({ id: orderEvents.id });
    if (!confirmation) throw new Error('could not confirm the quotation');

    await tx
      .update(orders)
      .set({ status: 'awaiting_payment', statusEventId: confirmation.id })
      .where(eq(orders.id, draft.orderId));
  });
};

/** A cancellation, which is the cheapest way to reach a status a quote may not be edited in. */
const cancel = async (draft: Draft): Promise<void> => {
  const eventId = randomUUID();

  await db.transaction(async (tx) => {
    const [order] = await tx
      .select({ status: orders.status })
      .from(orders)
      .where(eq(orders.id, draft.orderId))
      .for('update');
    if (!order) throw new Error('order not found');

    const [transition] = await tx
      .select()
      .from(orderStatusTransitions)
      .where(
        and(
          eq(orderStatusTransitions.fromStatus, order.status),
          eq(orderStatusTransitions.toStatus, 'cancelled'),
        ),
      );
    if (!transition) throw new Error(`no transition from ${order.status} to cancelled`);

    await tx.insert(orderEvents).values({
      id: eventId,
      orderId: draft.orderId,
      eventType: 'cancelled',
      fromStatus: order.status,
      toStatus: 'cancelled',
      actorKind: 'guest',
      actorGuestId: draft.guestId,
      payload: { reason: 'ลูกค้าเปลี่ยนใจ' },
    });

    await tx
      .update(orders)
      .set({ status: 'cancelled', statusEventId: eventId })
      .where(eq(orders.id, draft.orderId));
  });
};

type LineOptions = {
  seq?: number;
  qty?: number;
  computed?: bigint;
  configHash?: string;
};

/**
 * Sixteen hex characters — the width `@wewin/core/hash`'s `configHash` actually produces.
 *
 * ⚠️ This helper padded to **64** for a whole phase, and the column was `char(64)` to match. Both
 * were copied from `order_documents.document_hash`, which really is a SHA-256; `configHash` is a
 * 64-*bit* FNV-1a rendered as `.toString(16).padStart(16, '0')`. So this suite proved the column
 * accepted a value the application could never write, and the first real quote line in
 * `apps/api` was SQLSTATE 23514. A fixture that invents its own shape for a column is a fixture
 * that cannot notice the shape is wrong — `0017_quote_promise_freeze.sql` narrowed both.
 */
const hexHash = (seed: string): string => seed.padEnd(16, '0').slice(0, 16);

const addCatalogLine = async (orderId: string, options: LineOptions = {}): Promise<string> => {
  const [line] = await db
    .insert(quoteLines)
    .values({
      orderId,
      seq: options.seq ?? 1,
      kind: 'catalog',
      productVersionId: publishedVersionId,
      skuCode: 'WW-CSW-T6-CLR',
      selections: { glass: 't6', colour: 'clr' },
      measures: { width: '1200000', height: '1500000' },
      configHash: options.configHash ?? hexHash('a'.repeat(8)),
      qty: options.qty ?? 1,
      computedTotalThbMinor: options.computed ?? LINE_COMPUTED,
      customerDescriptionTh: 'หน้าต่างบานเลื่อน ห้องนอน 1',
    })
    .returning({ id: quoteLines.id });
  if (!line) throw new Error('could not add a catalog line');
  return line.id;
};

const addFreeformLine = async (
  orderId: string,
  charge: bigint,
  seq = 90,
): Promise<string> => {
  const [line] = await db
    .insert(quoteLines)
    .values({
      orderId,
      seq,
      kind: 'freeform',
      chargeTotalThbMinor: charge,
      customerDescriptionTh: 'ค่าขนส่งและติดตั้ง',
    })
    .returning({ id: quoteLines.id });
  if (!line) throw new Error('could not add a freeform line');
  return line.id;
};

type OverrideOptions = {
  lineId?: string | null;
  anchor?: (typeof OVERRIDE_ANCHORS)[number];
  computed?: bigint;
  override?: bigint;
  computedDays?: number;
  overrideDays?: number;
  enteredAs?: 'line_total' | 'unit_price' | 'grand_total' | 'percent_discount' | 'discount_amount' | 'lead_time_days';
  enteredValueText?: string;
  reasonCode?: 'price_match' | 'volume' | 'relationship' | 'goodwill' | 'correction' | 'rounding' | 'other';
  noteTh?: string;
  setBy?: string;
};

const setOverride = async (orderId: string, options: OverrideOptions = {}): Promise<string> => {
  const anchor = options.anchor ?? 'line_total';
  const isMoney = anchor !== 'lead_time_days';

  const [row] = await db
    .insert(quoteOverrides)
    .values({
      orderId,
      quoteLineId: options.lineId ?? null,
      anchor,
      computedThbMinor: isMoney ? (options.computed ?? LINE_COMPUTED) : null,
      overrideThbMinor: isMoney ? (options.override ?? LINE_PROMISED) : null,
      computedDays: isMoney ? null : (options.computedDays ?? 45),
      overrideDays: isMoney ? null : (options.overrideDays ?? 30),
      enteredAs: options.enteredAs ?? (isMoney ? (anchor === 'grand_total' ? 'grand_total' : 'line_total') : 'lead_time_days'),
      enteredValueText: options.enteredValueText ?? '8500',
      reasonCode: options.reasonCode ?? 'price_match',
      noteTh: options.noteTh ?? null,
      setByUserId: options.setBy ?? sales,
    })
    .returning({ id: quoteOverrides.id });
  if (!row) throw new Error('could not set an override');
  return row.id;
};

/** Stamp an override superseded — the one UPDATE the append-only guard allows. */
const supersede = async (
  overrideId: string,
  successorId: string | null,
  by = manager,
): Promise<void> => {
  await db
    .update(quoteOverrides)
    .set({
      supersededAt: new Date(),
      supersededByOverrideId: successorId,
      supersededByUserId: by,
      supersessionReason: successorId === null ? 'revoked' : 'replaced',
    })
    .where(eq(quoteOverrides.id, overrideId));
};

/**
 * Replace a promise with a new one, in the order the partial unique index permits.
 *
 * ⚠️ STAMP FIRST, INSERT SECOND, and the id is chosen by the caller. The obvious sequence —
 * insert the replacement, then point the old row at it — raises 23505, because
 * `quote_overrides_one_active_per_line` is a *partial* unique index and a partial index is
 * enforced per statement and cannot be deferred. This is `product_versions.ts`'s "archive
 * first, publish second" arriving a second time; see PART 4 of `0016_quote_guards.sql`.
 */
const replaceOverride = async (
  overrideId: string,
  values: {
    orderId: string;
    lineId?: string | null;
    anchor?: (typeof OVERRIDE_ANCHORS)[number];
    computed: bigint;
    override: bigint;
    enteredValueText: string;
  },
): Promise<string> => {
  const successorId = randomUUID();

  await db.transaction(async (tx) => {
    await tx
      .update(quoteOverrides)
      .set({
        supersededAt: new Date(),
        supersededByOverrideId: successorId,
        supersededByUserId: manager,
        supersessionReason: 'replaced',
      })
      .where(eq(quoteOverrides.id, overrideId));

    await tx.insert(quoteOverrides).values({
      id: successorId,
      orderId: values.orderId,
      quoteLineId: values.lineId ?? null,
      anchor: values.anchor ?? 'line_total',
      computedThbMinor: values.computed,
      overrideThbMinor: values.override,
      enteredAs: values.anchor === 'grand_total' ? 'grand_total' : 'line_total',
      enteredValueText: values.enteredValueText,
      reasonCode: 'price_match',
      setByUserId: sales,
    });
  });

  return successorId;
};

beforeAll(async () => {
  db = await connect();
  sales = await createUser(`sales ${tag}`);
  manager = await createUser(`manager ${tag}`);

  // A quote line cites the catalogue as published (trap 3, one table further in). Any
  // non-draft version will do — the guard refuses `draft` and nothing else — but a
  // published one is what a real quote holds, so that is what is asked for first.
  const found = await db.execute<{ id: string }>(sql`
    select id from product_versions
     order by case status when 'published' then 0 when 'archived' then 1 else 2 end
     limit 1
  `);
  const id = found.rows[0]?.id;
  if (!id) throw new Error('no catalogue version to quote from — run `pnpm db:seed`');
  publishedVersionId = id;
});

// ─────────────────────────────────────────────────────────────────────────────
// ⓵ Three layers, never collapsed — plan 7.9(ก)
// ─────────────────────────────────────────────────────────────────────────────

describeDb('⓵ the three layers, and the shapes that keep them apart', () => {
  it('leaves `computed` NULL where there was nothing to compute, rather than filling it in', async () => {
    /*
     * The temptation this refuses: one `total_thb_minor` column, filled by `calcPrice` on a
     * product line and by a human on a delivery line. It reads fine and it makes every
     * "how much has been conceded on this document?" query count the whole of a ฿2,000
     * delivery charge as a discount taken against ฿0 — plan 7.13's `margin` dimension is
     * exactly that sum, and it is the number an authority ceiling is compared against.
     */
    const draft = await createDraft();

    const catalog = await addCatalogLine(draft.orderId);
    const freeform = await addFreeformLine(draft.orderId, 200000n);

    const rows = await db
      .select({
        id: quoteLines.id,
        computed: quoteLines.computedTotalThbMinor,
        charge: quoteLines.chargeTotalThbMinor,
      })
      .from(quoteLines)
      .where(eq(quoteLines.orderId, draft.orderId));

    expect(rows.find((row) => row.id === catalog)).toMatchObject({
      computed: LINE_COMPUTED,
      charge: null,
    });
    expect(rows.find((row) => row.id === freeform)).toMatchObject({
      computed: null,
      charge: 200000n,
    });

    // And the two shapes are not interchangeable in either direction.
    await expectViolation(
      db.insert(quoteLines).values({
        orderId: draft.orderId,
        seq: 3,
        kind: 'freeform',
        computedTotalThbMinor: 100000n,
      }),
      PG.checkViolation,
    );
    await expectViolation(
      db.insert(quoteLines).values({
        orderId: draft.orderId,
        seq: 4,
        kind: 'catalog',
        productVersionId: publishedVersionId,
        skuCode: 'WW-CSW-T6-CLR',
        selections: {},
        measures: {},
        configHash: hexHash('b'.repeat(8)),
        chargeTotalThbMinor: 100000n,
      }),
      PG.checkViolation,
    );
  });

  it('stores the figure it was taken against beside the figure a human set', async () => {
    // Plan 7.9(ก): absolute, and paired with its baseline. A delta would be ฿291 here, and
    // ฿291 off a catalogue that moves to ฿9,500 tomorrow is ฿9,209 — silently, having
    // promised ฿8,500 out loud.
    const draft = await createDraft();
    const lineId = await addCatalogLine(draft.orderId);
    const overrideId = await setOverride(draft.orderId, { lineId });

    const [row] = await db
      .select()
      .from(quoteOverrides)
      .where(eq(quoteOverrides.id, overrideId));

    expect(row?.computedThbMinor).toBe(LINE_COMPUTED);
    expect(row?.overrideThbMinor).toBe(LINE_PROMISED);
    expect(row?.enteredValueText).toBe('8500');
    expect(row?.setByUserId).toBe(sales);
  });

  it('has three anchors and no fourth — a document discount is a grand total in a hat', async () => {
    /*
     * Plan 7.9(ข). A discount and a total have an arithmetic relationship, so shipping both
     * as anchors means answering "which one wins?" at every endpoint, and answering it
     * differently each time. Typing "−5%" survives in `entered_as` + `entered_value_text`;
     * what gets stored is the absolute figure it produced.
     */
    expect([...OVERRIDE_ANCHORS]).toEqual(['line_total', 'grand_total', 'lead_time_days']);

    const draft = await createDraft();

    /*
     * ⚠️ THE `entered_as` HERE IS DELIBERATELY THE ONE THAT FITS, and mutation testing is
     * why. Written the natural way — `document_discount` with `discount_amount` beside it —
     * this test still went red with `quote_overrides_anchor_known` DROPPED, because
     * `entry_mode_fits_anchor`'s ELSE branch caught it instead. Two mechanisms behind one
     * green assertion is evidence for neither; 5b's report says the same sentence about the
     * refund freeze. So the row below satisfies every other CHECK and leaves exactly one
     * thing that can refuse it.
     */
    await expectViolation(
      db.execute(sql`
        insert into quote_overrides
          (order_id, anchor, computed_thb_minor, override_thb_minor, entered_as,
           entered_value_text, reason_code, set_by_user_id)
        values (${draft.orderId}, 'document_discount', ${GRAND}, ${GRAND - 50000n},
                'lead_time_days', '500', 'volume', ${sales})
      `),
      PG.checkViolation,
    );

    /*
     * And the two closed sets are enumerated where a reader can see them. `entered_as_known`
     * has no *behavioural* evidence and cannot have any: `entry_mode_fits_anchor` restricts
     * `entered_as` to a subset of the known list for every anchor, so no row exists that the
     * one refuses and the other accepts. It stays because the house convention is that a
     * closed set carries its own CHECK — the day somebody relaxes the anchor mapping, this
     * is what still holds — and this assertion is the evidence it is there and complete.
     */
    const definitions = await db.execute<{ conname: string; definition: string }>(sql`
      select conname, pg_get_constraintdef(oid) as definition from pg_constraint
       where conname in ('quote_overrides_anchor_known', 'quote_overrides_entered_as_known')
    `);
    const anchors = definitions.rows.find((row) => row.conname.endsWith('anchor_known'))?.definition ?? '';
    const modes = definitions.rows.find((row) => row.conname.endsWith('entered_as_known'))?.definition ?? '';
    for (const anchor of OVERRIDE_ANCHORS) expect(anchors).toContain(`'${anchor}'`);
    for (const mode of OVERRIDE_ENTRY_MODES) expect(modes).toContain(`'${mode}'`);

    // …and the percentage that a salesperson actually typed is recorded as a percentage.
    const id = await setOverride(draft.orderId, {
      anchor: 'grand_total',
      computed: GRAND,
      override: 893605n,
      enteredAs: 'percent_discount',
      enteredValueText: '-5%',
      reasonCode: 'volume',
    });

    const [row] = await db.select().from(quoteOverrides).where(eq(quoteOverrides.id, id));
    expect(row?.enteredAs).toBe('percent_discount');
    expect(row?.enteredValueText).toBe('-5%');
    expect(row?.overrideThbMinor).toBe(893605n);
  });

  it('makes a line anchor name a line and a document anchor name none', async () => {
    // Without this the two partial unique indexes below each assume the other one is
    // covering the case where a `grand_total` row carries a line id, and neither is.
    const draft = await createDraft();
    const lineId = await addCatalogLine(draft.orderId);

    await expectViolation(
      setOverride(draft.orderId, { lineId: null, anchor: 'line_total' }),
      PG.checkViolation,
    );
    await expectViolation(
      setOverride(draft.orderId, {
        lineId,
        anchor: 'grand_total',
        computed: GRAND,
        override: 900000n,
        enteredAs: 'grand_total',
      }),
      PG.checkViolation,
    );
  });

  it('refuses a unit price typed onto a total that has no units', async () => {
    // `entered_as` is not decoration: it says which box produced the number, and
    // `unit_price` on a document total is a normalisation that went to the wrong anchor —
    // plan 7.9(ข)'s mistake, which it says happens once per endpoint.
    const draft = await createDraft();
    const lineId = await addCatalogLine(draft.orderId, { qty: 2, computed: PAIR_COMPUTED });

    // The legal one: typed per unit, written as the line total.
    const id = await setOverride(draft.orderId, {
      lineId,
      computed: PAIR_COMPUTED,
      override: PAIR_PROMISED,
      enteredAs: 'unit_price',
      enteredValueText: '8500',
    });
    const [row] = await db.select().from(quoteOverrides).where(eq(quoteOverrides.id, id));
    expect(row?.overrideThbMinor).toBe(PAIR_PROMISED);

    await expectViolation(
      setOverride(draft.orderId, {
        anchor: 'grand_total',
        computed: GRAND,
        override: 900000n,
        enteredAs: 'unit_price',
      }),
      PG.checkViolation,
    );
  });

  it('refuses an override that overrides nothing', async () => {
    // It would occupy the one live slot for its anchor and make "does this line carry a
    // promise?" — the question the reprice guard asks — answer yes about a row that
    // promised nothing. Re-confirming a price after the catalogue moved is a *revocation*.
    const draft = await createDraft();
    const lineId = await addCatalogLine(draft.orderId);

    await expectViolation(
      setOverride(draft.orderId, { lineId, computed: LINE_COMPUTED, override: LINE_COMPUTED }),
      PG.checkViolation,
    );
  });

  it('demands a sentence when the reason is `other`', async () => {
    const draft = await createDraft();
    const lineId = await addCatalogLine(draft.orderId);

    await expectViolation(
      setOverride(draft.orderId, { lineId, reasonCode: 'other' }),
      PG.checkViolation,
    );

    const id = await setOverride(draft.orderId, {
      lineId,
      reasonCode: 'other',
      noteTh: 'ผู้จัดการอนุมัติทางโทรศัพท์ เลขที่อ้างอิง 2026-0042',
    });
    expect(id).toBeTruthy();

    // And an empty verbatim string is a field nobody filled in, not a value.
    await expectViolation(
      db.execute(sql`
        insert into quote_overrides
          (order_id, quote_line_id, anchor, computed_thb_minor, override_thb_minor,
           entered_as, entered_value_text, reason_code, set_by_user_id)
        values (${draft.orderId}, ${lineId}, 'line_total', ${LINE_COMPUTED}, ${LINE_PROMISED},
                'line_total', '   ', 'volume', ${sales})
      `),
      PG.checkViolation,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ⓶ Exactly one live override per (subject, anchor) — enforced, not assumed
// ─────────────────────────────────────────────────────────────────────────────

describeDb('⓶ one live override per subject and anchor', () => {
  it('refuses a second live override on the same line and anchor', async () => {
    const draft = await createDraft();
    const lineId = await addCatalogLine(draft.orderId);
    const first = await setOverride(draft.orderId, { lineId });

    await expectViolation(
      setOverride(draft.orderId, { lineId, override: 800000n, enteredValueText: '8000' }),
      PG.uniqueViolation,
    );

    // Superseding frees the slot — which is what makes the rule "one *live* override"
    // rather than "one override ever", and is the whole reason the history is a chain.
    await supersede(first, null);
    const second = await setOverride(draft.orderId, {
      lineId,
      override: 800000n,
      enteredValueText: '8000',
    });
    expect(second).toBeTruthy();
  });

  it('refuses a second live override on the document, where the line id is NULL', async () => {
    /*
     * ⭐ THIS IS THE ONE A SINGLE INDEX WOULD HAVE MISSED.
     *
     * `UNIQUE (order_id, quote_line_id, anchor)` looks like it covers both cases. It does
     * not: Postgres treats NULLs as distinct in a unique index, a document anchor has a
     * NULL line, and so five live grand-total overrides on one quote would all be legal —
     * five different final prices, each one individually well-formed. `NULLS NOT DISTINCT`
     * would fix it and cannot be written on a *partial* index here, so the rule is split
     * into two indexes along the seam the scope CHECK already cuts.
     */
    const draft = await createDraft();
    await setOverride(draft.orderId, {
      anchor: 'grand_total',
      computed: GRAND,
      override: 900000n,
      enteredAs: 'grand_total',
    });

    await expectViolation(
      setOverride(draft.orderId, {
        anchor: 'grand_total',
        computed: GRAND,
        override: 800000n,
        enteredAs: 'grand_total',
      }),
      PG.uniqueViolation,
    );
  });

  it('lets a lead-time promise and a price promise live side by side', async () => {
    // Different anchors are different facts. The uniqueness is per anchor, not per document.
    const draft = await createDraft();

    await setOverride(draft.orderId, {
      anchor: 'grand_total',
      computed: GRAND,
      override: 900000n,
      enteredAs: 'grand_total',
    });
    const lead = await setOverride(draft.orderId, {
      anchor: 'lead_time_days',
      computedDays: 45,
      overrideDays: 30,
      enteredValueText: '30 วัน',
      reasonCode: 'relationship',
    });

    const [row] = await db.select().from(quoteOverrides).where(eq(quoteOverrides.id, lead));
    expect(row?.overrideDays).toBe(30);
    expect(row?.overrideThbMinor).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ⓷ Append-only, with supersession as the one exception
// ─────────────────────────────────────────────────────────────────────────────

describeDb('⓷ an override is history the moment it is written', () => {
  it('refuses to edit the promise', async () => {
    const draft = await createDraft();
    const lineId = await addCatalogLine(draft.orderId);
    const id = await setOverride(draft.orderId, { lineId });

    await expectViolation(
      db.update(quoteOverrides).set({ overrideThbMinor: 700000n }).where(eq(quoteOverrides.id, id)),
      PG.restrictViolation,
    );
    await expectViolation(
      db.update(quoteOverrides).set({ enteredValueText: '7000' }).where(eq(quoteOverrides.id, id)),
      PG.restrictViolation,
    );
    await expectViolation(
      db.update(quoteOverrides).set({ setByUserId: manager }).where(eq(quoteOverrides.id, id)),
      PG.restrictViolation,
    );
  });

  it('refuses to move the baseline the promise was taken against', async () => {
    /*
     * The attack this is the answer to. Leave the ฿8,500 the customer was told, quietly
     * raise `computed` from ฿8,791 to ฿12,000, and a ฿291 concession is now a ฿3,500 one
     * that no ceiling was ever asked about. Or lower it, to slip *under* a ceiling that was.
     *
     * Plan 7.9(ค) lists "the computed baseline of an override already issued" as
     * not-editable, and this is where that sentence is enforced.
     */
    const draft = await createDraft();
    const lineId = await addCatalogLine(draft.orderId);
    const id = await setOverride(draft.orderId, { lineId });

    await expectViolation(
      db.update(quoteOverrides).set({ computedThbMinor: 1_200_000n }).where(eq(quoteOverrides.id, id)),
      PG.restrictViolation,
    );

    const [row] = await db.select().from(quoteOverrides).where(eq(quoteOverrides.id, id));
    expect(row?.computedThbMinor).toBe(LINE_COMPUTED);
  });

  it('refuses an override that arrives already superseded', async () => {
    /*
     * ⚠️ FOUND SURVIVING. The shape CHECK is happy — `superseded_at`, the name and the
     * reason are all there — so a row could be written that was born dead: it occupies no
     * live slot, it names a promise nobody ever made, and the chain it belongs to has a
     * link with no beginning. Supersession is something that happens TO a row, later.
     */
    const draft = await createDraft();
    const lineId = await addCatalogLine(draft.orderId);

    await expectViolation(
      db.insert(quoteOverrides).values({
        orderId: draft.orderId,
        quoteLineId: lineId,
        anchor: 'line_total',
        computedThbMinor: LINE_COMPUTED,
        overrideThbMinor: LINE_PROMISED,
        enteredAs: 'line_total',
        enteredValueText: '8500',
        reasonCode: 'price_match',
        setByUserId: sales,
        supersededAt: new Date(),
        supersededByUserId: manager,
        supersessionReason: 'revoked',
      }),
      PG.restrictViolation,
    );
  });

  it('refuses an UPDATE that is not a supersession, even one that changes nothing', async () => {
    /*
     * ⚠️ FOUND SURVIVING, and it is the branch that states the rule rather than an instance
     * of it. Every other update test changes a column, so the *generic* append-only branch
     * was answering all of them and this one — "the only legal UPDATE is a supersession" —
     * had no case of its own. A no-op UPDATE is the case: nothing to compare, and it must
     * still be refused, or `UPDATE quote_overrides SET …` is a statement that sometimes
     * works.
     */
    const draft = await createDraft();
    const lineId = await addCatalogLine(draft.orderId);
    const id = await setOverride(draft.orderId, { lineId });

    await expectViolation(
      db.execute(sql`update quote_overrides set note_th = note_th where id = ${id}`),
      PG.restrictViolation,
    );
  });

  it('refuses a supersession that smuggles an edit alongside the stamp', async () => {
    /*
     * ⚠️ BOTH BRANCHES FOUND SURVIVING, and this is the attack they are actually for.
     *
     * Every earlier test updates a row WITHOUT stamping it, so `superseded_at IS NULL`
     * answered all of them and neither the baseline branch nor the generic one had a case.
     * The reachable version is the one that looks legitimate: stamp the row superseded — a
     * thing sales is allowed to do — and move `computed_thb_minor` or `override_thb_minor`
     * in the same statement. The concession recorded in the history is then whatever the
     * last writer wanted it to have been.
     */
    const draft = await createDraft();
    const lineId = await addCatalogLine(draft.orderId);
    const first = await setOverride(draft.orderId, { lineId });

    await expectViolation(
      db.execute(sql`
        update quote_overrides
           set superseded_at = now(), superseded_by_user_id = ${manager},
               supersession_reason = 'revoked', computed_thb_minor = 1200000
         where id = ${first}
      `),
      PG.restrictViolation,
    );

    const second = await setOverride(draft.orderId, {
      anchor: 'grand_total',
      computed: GRAND,
      override: 900000n,
      enteredAs: 'grand_total',
    });
    await expectViolation(
      db.execute(sql`
        update quote_overrides
           set superseded_at = now(), superseded_by_user_id = ${manager},
               supersession_reason = 'revoked', override_thb_minor = 700000
         where id = ${second}
      `),
      PG.restrictViolation,
    );
  });

  it('refuses to delete an override once the order has been submitted', async () => {
    const draft = await createDraft();
    const lineId = await addCatalogLine(draft.orderId);
    const id = await setOverride(draft.orderId, { lineId });
    await submit(draft);

    await expectViolation(
      db.delete(quoteOverrides).where(eq(quoteOverrides.id, id)),
      PG.restrictViolation,
    );
  });

  it('still lets an abandoned cart be thrown away whole', async () => {
    /*
     * The other half of `order_events_append_only()`'s reasoning, and the half that is easy
     * to lose: a never-submitted draft is not an accounting document. Without this the
     * funnel accumulates forever and `orders_block_delete()`'s deliberate exception stops
     * working, because the cascade would hit an override that refuses to go.
     */
    const draft = await createDraft();
    const lineId = await addCatalogLine(draft.orderId);
    const first = await setOverride(draft.orderId, { lineId });
    /*
     * A line promise and a document promise, both live — which is the state
     * `quote_overrides_document_freeze()` refuses to let anybody *withdraw* a line promise from.
     * The cascade is the one exception, and it has to be: a cart carrying both would otherwise
     * be undeletable, the freeze refusing its own cascade, and the funnel would accumulate
     * drafts for ever. The written order is the only legal one — document promise last, over
     * the line prices it was promised against.
     */
    const second = await setOverride(draft.orderId, {
      anchor: 'grand_total',
      computed: GRAND,
      override: 900000n,
      enteredAs: 'grand_total',
    });

    await db.delete(orders).where(eq(orders.id, draft.orderId));

    const left = await db
      .select({ id: quoteOverrides.id })
      .from(quoteOverrides)
      .where(eq(quoteOverrides.orderId, draft.orderId));
    expect(left).toHaveLength(0);
    expect([first, second]).toHaveLength(2);
  });

  it('supersedes exactly once, and never back', async () => {
    const draft = await createDraft();
    const lineId = await addCatalogLine(draft.orderId);
    const first = await setOverride(draft.orderId, { lineId });

    await supersede(first, null);

    // Twice would let the record of who withdrew a promise be rewritten later.
    await expectViolation(supersede(first, null), PG.restrictViolation);

    // And un-superseding would put two live overrides on one anchor without the unique
    // index ever seeing a second INSERT.
    await expectViolation(
      db
        .update(quoteOverrides)
        .set({
          supersededAt: null,
          supersededByUserId: null,
          supersessionReason: null,
          supersededByOverrideId: null,
        })
        .where(eq(quoteOverrides.id, first)),
      PG.restrictViolation,
    );
  });

  it('replaces a promise with the statements in the only order that works', async () => {
    /*
     * ⭐ FOUND BY THIS TEST, WRITTEN THE OBVIOUS WAY ROUND, AND IT FAILED WITH 23505.
     *
     * `quote_overrides_one_active_per_line` is a PARTIAL unique index, so it is enforced per
     * statement and cannot be declared DEFERRABLE — a partial index is not a constraint and
     * only constraints can defer. Insert the replacement first and there are momentarily two
     * live overrides on one anchor, which is exactly what the index is for.
     *
     * This is `product_versions_one_published_per_product`'s "archive first, publish second"
     * arriving a second time in a different table. The sequence that works is: choose the
     * successor's id, stamp the old row with it, insert the successor, commit — which needs
     * `quote_overrides_successor_fk` to be DEFERRABLE INITIALLY DEFERRED, and it is.
     */
    const draft = await createDraft();
    const lineId = await addCatalogLine(draft.orderId);
    const first = await setOverride(draft.orderId, { lineId });

    // The obvious order. Still fails, and this assertion is what stops somebody "tidying"
    // the FK back to an immediate one.
    await expectViolation(
      setOverride(draft.orderId, { lineId, override: 820000n, enteredValueText: '8200' }),
      PG.uniqueViolation,
    );

    const second = await replaceOverride(first, {
      orderId: draft.orderId,
      lineId,
      computed: LINE_COMPUTED,
      override: 820000n,
      enteredValueText: '8200',
    });

    const [old] = await db.select().from(quoteOverrides).where(eq(quoteOverrides.id, first));
    expect(old?.supersededByOverrideId).toBe(second);
    expect(old?.overrideThbMinor).toBe(LINE_PROMISED); // the first promise is still readable
    expect(old?.supersessionReason).toBe('replaced');
  });

  it('refuses a successor that replaces something else', async () => {
    /*
     * A `grand_total` row named as the successor of a `line_total` row leaves the line with
     * no live override and the document with two — and neither partial unique index can see
     * it, because each looks at one (subject, anchor) pair at a time and both pairs are
     * individually legal. Only a comparison of the two rows catches it, and because the
     * successor may not exist yet when the stamp is written, that comparison has to happen
     * at COMMIT.
     */
    const draft = await createDraft();
    const lineId = await addCatalogLine(draft.orderId);
    const onTheLine = await setOverride(draft.orderId, { lineId });
    const onTheDocument = await setOverride(draft.orderId, {
      anchor: 'grand_total',
      computed: GRAND,
      override: 900000n,
      enteredAs: 'grand_total',
    });

    await expectViolation(supersede(onTheLine, onTheDocument), PG.restrictViolation);

    // The stamp is rolled back with the transaction it was in — the line still has its promise.
    const [row] = await db.select().from(quoteOverrides).where(eq(quoteOverrides.id, onTheLine));
    expect(row?.supersededAt).toBeNull();
  });

  it('refuses a `replaced` stamp with nobody to replace it, and a `revoked` one with a successor', async () => {
    const draft = await createDraft();
    const lineId = await addCatalogLine(draft.orderId);
    const first = await setOverride(draft.orderId, { lineId });

    await expectViolation(
      db
        .update(quoteOverrides)
        .set({ supersededAt: new Date(), supersededByUserId: manager, supersessionReason: 'replaced' })
        .where(eq(quoteOverrides.id, first)),
      PG.checkViolation,
    );

    // And a stamp with no name on it is a promise that vanished.
    await expectViolation(
      db
        .update(quoteOverrides)
        .set({ supersededAt: new Date(), supersessionReason: 'revoked' })
        .where(eq(quoteOverrides.id, first)),
      PG.checkViolation,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ⓸ The reprice that used to lose the promise — plan 7.9(ง)(2)
// ─────────────────────────────────────────────────────────────────────────────

describeDb('⓸ a live promise freezes the inputs it was quoted against', () => {
  it('refuses the + button while a line carries an override', async () => {
    /*
     * ⭐ The finding with a line number on it. `quoteReducer.ts:68` recomputes
     * `total = round(unitPrice × qty)` on every quantity change and `tests/quoteReducer.test.ts`
     * pins that behaviour. Sales agrees ฿17,000 for two, the customer asks for a third, and
     * the promise is gone — no error, no record, an order that goes out at list price after
     * somebody said otherwise on the phone.
     *
     * ฿17,000 for two is not ฿17,000 for three, so an absolute override cannot survive the
     * change. Refusing is the only outcome that is not a silent loss: the way through is to
     * supersede the promise first, which is one deliberate act with a name and a reason.
     */
    const draft = await createDraft();
    const lineId = await addCatalogLine(draft.orderId, { qty: 2, computed: PAIR_COMPUTED });
    const promise = await setOverride(draft.orderId, {
      lineId,
      computed: PAIR_COMPUTED,
      override: PAIR_PROMISED,
      enteredValueText: '17000',
    });

    await expectViolation(
      db.update(quoteLines).set({ qty: 3 }).where(eq(quoteLines.id, lineId)),
      PG.restrictViolation,
    );

    await supersede(promise, null);

    await db
      .update(quoteLines)
      .set({ qty: 3, computedTotalThbMinor: PAIR_COMPUTED + 921600n })
      .where(eq(quoteLines.id, lineId));

    const [row] = await db.select().from(quoteLines).where(eq(quoteLines.id, lineId));
    expect(row?.qty).toBe(3);
  });

  it('refuses a re-selection or a re-measure for the same reason', async () => {
    const draft = await createDraft();
    const lineId = await addCatalogLine(draft.orderId);
    await setOverride(draft.orderId, { lineId });

    await expectViolation(
      db
        .update(quoteLines)
        .set({ selections: { glass: 't8', colour: 'clr' }, skuCode: 'WW-CSW-T8-CLR' })
        .where(eq(quoteLines.id, lineId)),
      PG.restrictViolation,
    );
    await expectViolation(
      db
        .update(quoteLines)
        .set({ measures: { width: '1400000', height: '1500000' } })
        .where(eq(quoteLines.id, lineId)),
      PG.restrictViolation,
    );
    await expectViolation(
      db.update(quoteLines).set({ computedTotalThbMinor: 999900n }).where(eq(quoteLines.id, lineId)),
      PG.restrictViolation,
    );
  });

  it('refuses to remove a line that still carries one', async () => {
    // The same disappearance with a different spelling.
    const draft = await createDraft();
    const lineId = await addCatalogLine(draft.orderId);
    const promise = await setOverride(draft.orderId, { lineId });

    await expectViolation(
      db
        .update(quoteLines)
        .set({ removedAt: new Date(), removedByUserId: sales })
        .where(eq(quoteLines.id, lineId)),
      PG.restrictViolation,
    );

    await supersede(promise, null);
    await db
      .update(quoteLines)
      .set({ removedAt: new Date(), removedByUserId: sales })
      .where(eq(quoteLines.id, lineId));

    // …and a removed line cannot be given a new promise afterwards.
    await expectViolation(setOverride(draft.orderId, { lineId }), PG.restrictViolation);
  });

  it('refuses to delete a line once the order has been submitted', async () => {
    /*
     * ⚠️ FOUND SURVIVING. The override delete guard was covering for this one on every case
     * anybody had written down, because deleting a line cascades to its overrides — so the
     * line with NO overrides, on a submitted order, was the case with no test. It is also
     * the ordinary case: a line nobody negotiated on, deleted rather than removed, taking
     * its position in the document with it.
     */
    const draft = await createDraft();
    const lineId = await addCatalogLine(draft.orderId);
    await submit(draft);

    await expectViolation(
      db.delete(quoteLines).where(eq(quoteLines.id, lineId)),
      PG.restrictViolation,
    );

    await db
      .update(quoteLines)
      .set({ removedAt: new Date(), removedByUserId: sales })
      .where(eq(quoteLines.id, lineId));
    const [row] = await db.select().from(quoteLines).where(eq(quoteLines.id, lineId));
    expect(row?.removedAt).not.toBeNull();
  });

  it('leaves the prose alone — it is the only field a works order never reads', async () => {
    /*
     * Plan 7.9(ค)'s ⚠️: sales can type "กระจกเทมเปอร์ 8 มม." on a line whose sku says T6.
     * A schema cannot police a renderer, so the distinction is made structural instead —
     * the fields a works order renders from are frozen or derived, and the customer-facing
     * description is the one thing that moves freely. That asymmetry IS the guard.
     */
    const draft = await createDraft();
    const lineId = await addCatalogLine(draft.orderId);
    await setOverride(draft.orderId, { lineId });

    await db
      .update(quoteLines)
      .set({ customerDescriptionTh: 'กระจกเทมเปอร์ 8 มม. ตามที่คุยกันครับ' })
      .where(eq(quoteLines.id, lineId));

    const [row] = await db.select().from(quoteLines).where(eq(quoteLines.id, lineId));
    expect(row?.customerDescriptionTh).toContain('8 มม.');
    expect(row?.skuCode).toBe('WW-CSW-T6-CLR'); // and the factory still cuts 6 mm
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ⓹ What a line may never become
// ─────────────────────────────────────────────────────────────────────────────

describeDb('⓹ the fields a works order renders from', () => {
  it('refuses a different product on the same line', async () => {
    const draft = await createDraft();
    const lineId = await addCatalogLine(draft.orderId);

    await expectViolation(
      db.update(quoteLines).set({ productVersionId: null }).where(eq(quoteLines.id, lineId)),
      PG.restrictViolation,
    );
    await expectViolation(
      db.update(quoteLines).set({ kind: 'freeform' }).where(eq(quoteLines.id, lineId)),
      PG.restrictViolation,
    );
  });

  it('refuses a sku typed on its own, and allows one that moved with its selections', async () => {
    // The sku is derived (`@wewin/core/skuCode`). A sku that can be typed is a number
    // somebody can make say anything, and it is what the factory cuts from.
    const draft = await createDraft();
    const lineId = await addCatalogLine(draft.orderId);

    await expectViolation(
      db.update(quoteLines).set({ skuCode: 'WW-CSW-T8-CLR' }).where(eq(quoteLines.id, lineId)),
      PG.restrictViolation,
    );

    await db
      .update(quoteLines)
      .set({
        skuCode: 'WW-CSW-T8-CLR',
        selections: { glass: 't8', colour: 'clr' },
        computedTotalThbMinor: 990000n,
      })
      .where(eq(quoteLines.id, lineId));

    const [row] = await db.select().from(quoteLines).where(eq(quoteLines.id, lineId));
    expect(row?.skuCode).toBe('WW-CSW-T8-CLR');
  });

  it('refuses a line quoted from a catalogue version nobody published', async () => {
    // Trap 3, one table further in: a draft version is a document somebody is still editing.
    const draft = await createDraft();

    const productId = await db.execute<{ product_id: string; next: number }>(sql`
      select product_id, max(version) + 1 as next from product_versions
       group by product_id order by product_id limit 1
    `);
    const source = productId.rows[0];
    expect(source, 'no catalogue to build a draft version from').toBeDefined();
    if (!source) return;

    const created = await db.execute<{ id: string }>(sql`
      insert into product_versions (product_id, version, status, document, document_hash)
      values (${source.product_id}, ${source.next}, 'draft', '{}'::jsonb, ${hexHash('d'.repeat(8))})
      returning id
    `);
    const draftVersionId = created.rows[0]?.id;
    if (!draftVersionId) throw new Error('could not create a draft version');

    await expectViolation(
      db.insert(quoteLines).values({
        orderId: draft.orderId,
        seq: 1,
        kind: 'catalog',
        productVersionId: draftVersionId,
        skuCode: 'WW-CSW-T6-CLR',
        selections: {},
        measures: {},
        configHash: hexHash('e'.repeat(8)),
        computedTotalThbMinor: LINE_COMPUTED,
      }),
      PG.restrictViolation,
    );

    await db.execute(sql`delete from product_versions where id = ${draftVersionId}`);
  });

  it('is not its configuration — two identical windows may carry two different prices', async () => {
    /*
     * Plan 7.9(ง)(3). `quoteReducer.ts:86` merges an added line into an existing one when
     * `configHash` and `productId` match, which is right for a cart and wrong for a quote:
     * the second window would inherit a negotiated price nobody approved for it, and
     * quoting two identical windows at two different prices — an ordinary thing to do —
     * could not be represented at all.
     *
     * So there is deliberately NO unique index on (order_id, config_hash), and this test is
     * what makes that absence visible to the next person and to the next migration.
     */
    const draft = await createDraft();
    const shared = hexHash('f'.repeat(8));

    const first = await addCatalogLine(draft.orderId, { seq: 1, configHash: shared });
    const second = await addCatalogLine(draft.orderId, { seq: 2, configHash: shared });

    await setOverride(draft.orderId, { lineId: first, override: LINE_PROMISED });
    await setOverride(draft.orderId, {
      lineId: second,
      override: 800000n,
      enteredValueText: '8000',
      reasonCode: 'volume',
    });

    const rows = await db
      .select({ id: quoteOverrides.id, value: quoteOverrides.overrideThbMinor })
      .from(quoteOverrides)
      .where(eq(quoteOverrides.orderId, draft.orderId));
    expect(rows.map((row) => row.value).sort()).toEqual([800000n, LINE_PROMISED].sort());

    const indexes = await db.execute<{ indexdef: string }>(sql`
      select indexdef from pg_indexes where tablename = 'quote_lines'
    `);
    expect(indexes.rows.filter((row) => row.indexdef.includes('config_hash'))).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ⓺ A quote is editable in three statuses, and the list lives in one place
// ─────────────────────────────────────────────────────────────────────────────

describeDb('⓺ when a quote may still be edited', () => {
  it('keeps the TypeScript mirror and the trigger argument in step', async () => {
    // The same drift test `order.test.ts` runs against `order_status_is_post_freeze()`.
    // The definition is the TG_ARGV list; the exported array is a convenience for callers,
    // and a convenience that disagrees with the database is worse than no convenience.
    const trigger = await db.execute<{ definition: string }>(sql`
      select pg_get_triggerdef(oid) as definition
        from pg_trigger where tgname = 'quote_overrides_live_orders_only'
    `);
    const definition = trigger.rows[0]?.definition ?? '';
    const argument = /'\{([^}]*)\}'/.exec(definition)?.[1] ?? '';
    const fromDatabase = argument.split(',').map((value) => value.trim());

    expect(fromDatabase).toEqual([...QUOTE_EDITABLE_ORDER_STATUSES]);

    // And every one of the nine is on exactly one side of the line.
    for (const status of ORDER_STATUSES) {
      expect(
        fromDatabase.includes(status),
        `${status} disagrees between the trigger and QUOTE_EDITABLE_ORDER_STATUSES`,
      ).toBe((QUOTE_EDITABLE_ORDER_STATUSES as readonly string[]).includes(status));
    }
  });

  it('refuses a discount typed onto an order nobody can act on any more', async () => {
    const draft = await createDraft();
    const lineId = await addCatalogLine(draft.orderId);
    await cancel(draft);

    await expectViolation(setOverride(draft.orderId, { lineId }), PG.restrictViolation);
    await expectViolation(
      db.update(quoteLines).set({ customerDescriptionTh: 'x' }).where(eq(quoteLines.id, lineId)),
      PG.restrictViolation,
    );
  });

  it('still allows the edit a sent quote is for', async () => {
    // `awaiting_payment` is editable, which is the entire point of the feature: sales
    // adjusts a quote the customer has been sent and has not paid.
    const draft = await createDraft();
    const lineId = await addCatalogLine(draft.orderId);
    await submit(draft);

    const id = await setOverride(draft.orderId, { lineId });
    expect(id).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ⓻ Authority — fail-closed, and the smoke path needs none of it
// ─────────────────────────────────────────────────────────────────────────────

describeDb('⓻ authority limits, and what an empty table means', () => {
  it('ships with no rows at all, which is plan 13 fail-closed', async () => {
    /*
     * ⚠️ A DEFAULT, NOT A DECISION, and this test is what stops it becoming one quietly.
     *
     * Plan 13: *"อำนาจ … fail-closed — ยังไม่มีแถว = ยังลดราคาไม่ได้"*. No row means the role
     * may concede nothing. Nobody has asked the owner for the numbers, so no migration
     * seeds any — and the day somebody seeds a "reasonable default" this fails and has to
     * be argued for out loud, which is the entire mechanism plan 13 asks this repo for.
     */
    const rows = await db.execute<{ n: number }>(sql`select count(*)::int as n from authority_limits`);
    expect(rows.rows[0]?.n).toBe(0);
  });

  it('has no wildcard row, in either of the two shapes one could take', async () => {
    /*
     * `forfeit_policy_rules` learned this the hard way and the test that found it lives in
     * `tests/payment.test.ts`: drizzle's `{ enum }` narrows TypeScript and narrows nothing
     * in Postgres, so `INSERT … ('ANY', …)` succeeded and left a row every reader had to
     * have an opinion about. A wildcard in an authority table is worse — it is a ceiling
     * that applies to everybody, including the roles nobody granted anything to.
     */
    const [group] = await db
      .insert(groups)
      .values({ code: `sales_${tag}`, nameTh: 'ฝ่ายขาย' })
      .returning({ id: groups.id });
    if (!group) throw new Error('could not create a group');

    await expectViolation(
      db.execute(sql`
        insert into authority_limits (group_id, dimension, max_concession_thb_minor, granted_by_user_id)
        values (${group.id}, 'ANY', 100000, ${manager})
      `),
      PG.checkViolation,
    );

    // "every role" as a NULL group is the other shape, and the primary key refuses it.
    await expectViolation(
      db.execute(sql`
        insert into authority_limits (group_id, dimension, max_concession_thb_minor, granted_by_user_id)
        values (null, 'margin', 100000, ${manager})
      `),
      PG.notNullViolation,
    );
  });

  it('separates "may concede nothing" from "has no authority at all"', async () => {
    // Zero is a legal ceiling and is not the same as an absent row: one is a role that may
    // record a concession and approve none of its own, the other is a role that may not
    // concede. The API's error message and the report both need to tell them apart.
    const [group] = await db
      .insert(groups)
      .values({ code: `junior_${tag}`, nameTh: 'พนักงานขายใหม่' })
      .returning({ id: groups.id });
    if (!group) throw new Error('could not create a group');

    await db.insert(authorityLimits).values({
      groupId: group.id,
      dimension: 'margin',
      maxConcessionThbMinor: 0n,
      grantedByUserId: manager,
    });

    await expectViolation(
      db.insert(authorityLimits).values({
        groupId: group.id,
        dimension: 'cashflow',
        maxConcessionThbMinor: -1n,
        grantedByUserId: manager,
      }),
      PG.checkViolation,
    );

    // One ceiling per (role, dimension) — a second is a second answer to one question.
    await expectViolation(
      db.insert(authorityLimits).values({
        groupId: group.id,
        dimension: 'margin',
        maxConcessionThbMinor: 500000n,
        grantedByUserId: manager,
      }),
      PG.uniqueViolation,
    );

    // Deleting the role takes its authority with it. `RESTRICT` would leave a ceiling
    // attached to a role that no longer exists, which is the one outcome worse than losing
    // it — this is the fail-closed direction, and it is the opposite of what this schema
    // does everywhere else.
    await db.delete(groups).where(eq(groups.id, group.id));
    const left = await db
      .select({ dimension: authorityLimits.dimension })
      .from(authorityLimits)
      .where(eq(authorityLimits.groupId, group.id));
    expect(left).toHaveLength(0);
  });

  it('uses the two dimensions `approvals` already has, and does not redeclare them', async () => {
    // Plan 7.13's finding was one rule written six times with six column pairs. A second
    // copy of the dimension list here would be the seventh.
    expect([...APPROVAL_DIMENSIONS]).toEqual(['margin', 'cashflow']);

    const constraint = await db.execute<{ definition: string }>(sql`
      select pg_get_constraintdef(oid) as definition
        from pg_constraint where conname = 'authority_limits_dimension_known'
    `);
    for (const dimension of APPROVAL_DIMENSIONS) {
      expect(constraint.rows[0]?.definition ?? '').toContain(`'${dimension}'`);
    }
  });

  it("runs plan 13's smoke path with no approval and no authority row anywhere", async () => {
    /*
     * Plan 7.13's second warning: a policy table with no defined day-one behaviour is a
     * feature that dies quietly, and fail-closed is only survivable if the ordinary order —
     * one THB quote, no concession — needs none of it.
     *
     * So this walks the quote half of that path with both tables empty and asserts it
     * arrives. Nothing in 5c requires an approval to exist; the ceiling is checked by the
     * API, at the document level, at submit, and only when somebody has actually conceded.
     */
    const before = await db.execute<{ approvals: number; limits: number }>(sql`
      select (select count(*)::int from approvals)         as approvals,
             (select count(*)::int from authority_limits)  as limits
    `);
    expect(before.rows[0]?.approvals).toBe(0);
    expect(before.rows[0]?.limits).toBe(0);

    const draft = await createDraft();
    await addCatalogLine(draft.orderId);
    await addFreeformLine(draft.orderId, 150000n);
    await submit(draft);

    const [order] = await db
      .select({ status: orders.status, grand: orders.grandTotalThbMinor })
      .from(orders)
      .where(eq(orders.id, draft.orderId));
    expect(order?.status).toBe('awaiting_payment');
    expect(order?.grand).toBe(GRAND);

    const after = await db
      .select({ id: approvals.id })
      .from(approvals)
      .where(eq(approvals.orderId, draft.orderId));
    expect(after).toHaveLength(0);
  });

  it('adds no fifth two-person rule', async () => {
    /*
     * `tests/payment.test.ts` owns the budget test and fails if the count leaves four. This
     * is the local half of it: 5c introduces three tables and none of them carries a
     * two-person CHECK. Authority is a *ceiling*, not an approver — plan 7.13 says eight
     * approval gates in one workflow kill the single control that means anything, and
     * nobody has answered how many people this company has.
     */
    const rules = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from pg_constraint
       where contype = 'c'
         and conrelid in ('quote_lines'::regclass, 'quote_overrides'::regclass,
                          'authority_limits'::regclass)
         and conname like '%is_not_%'
    `);
    expect(rules.rows[0]?.n).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ⓼ The shapes with no argument attached to them
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The constraints nobody debates, each with one assertion.
 *
 * They are here because a guard nobody mutation-tested is a guard nobody has evidence for,
 * and "obviously it holds" is what everybody said about `forfeit_policy_rules` accepting an
 * `'ANY'` row until a test tried it. Drizzle's `{ enum }` narrows TypeScript and narrows
 * nothing in Postgres, so several of these go in through raw SQL — which is the path a
 * migration, a psql session and the next service take.
 */
describeDb('⓼ the shapes', () => {
  it('refuses a malformed quote line', async () => {
    const draft = await createDraft();

    // A position of zero, and two lines in one position.
    await expectViolation(addCatalogLine(draft.orderId, { seq: 0 }), PG.checkViolation);
    await addCatalogLine(draft.orderId, { seq: 5 });
    await expectViolation(addCatalogLine(draft.orderId, { seq: 5 }), PG.uniqueViolation);

    // A kind nobody defined, past the TypeScript union.
    await expectViolation(
      db.execute(sql`
        insert into quote_lines (order_id, seq, kind, charge_total_thb_minor)
        values (${draft.orderId}, 6, 'bundle', 100000)
      `),
      PG.checkViolation,
    );

    // A second base currency is a migration with a name, not a discovery — `catalog.ts`.
    await expectViolation(
      db.execute(sql`
        insert into quote_lines (order_id, seq, kind, currency, charge_total_thb_minor)
        values (${draft.orderId}, 7, 'freeform', 'USD', 100000)
      `),
      PG.checkViolation,
    );

    await expectViolation(addCatalogLine(draft.orderId, { seq: 8, qty: 0 }), PG.checkViolation);
    await expectViolation(
      addCatalogLine(draft.orderId, { seq: 9, computed: -1n }),
      PG.checkViolation,
    );
    // A line for nothing is noise somebody still has to read; a credit is a negative one.
    await expectViolation(addFreeformLine(draft.orderId, 0n, 10), PG.checkViolation);
    const credit = await addFreeformLine(draft.orderId, -100000n, 11);
    expect(credit).toBeTruthy();

    await expectViolation(
      addCatalogLine(draft.orderId, { seq: 12, configHash: 'not-a-hash' }),
      PG.checkViolation,
    );
    await expectViolation(
      db.execute(sql`
        insert into quote_lines
          (order_id, seq, kind, product_version_id, sku_code, selections, measures,
           config_hash, computed_total_thb_minor)
        values (${draft.orderId}, 13, 'catalog', ${publishedVersionId}, 'WW-X',
                '[]'::jsonb, '{}'::jsonb, ${hexHash('c'.repeat(8))}, 100000)
      `),
      PG.checkViolation,
    );
    // ⚠️ `measures` needs its own line. Mutation testing found this one SURVIVING: the
    // selections case above passed with `measures_is_object` dropped, because the two are
    // separate constraints and one assertion is evidence for exactly one of them.
    await expectViolation(
      db.execute(sql`
        insert into quote_lines
          (order_id, seq, kind, product_version_id, sku_code, selections, measures,
           config_hash, computed_total_thb_minor)
        values (${draft.orderId}, 15, 'catalog', ${publishedVersionId}, 'WW-X',
                '{}'::jsonb, '"1200000"'::jsonb, ${hexHash('c'.repeat(8))}, 100000)
      `),
      PG.checkViolation,
    );

    // Removed by nobody, at no time — two columns, one fact.
    const lineId = await addCatalogLine(draft.orderId, { seq: 14 });
    await expectViolation(
      db.update(quoteLines).set({ removedAt: new Date() }).where(eq(quoteLines.id, lineId)),
      PG.checkViolation,
    );
  });

  it('refuses a malformed override', async () => {
    const draft = await createDraft();
    const lineId = await addCatalogLine(draft.orderId);

    const raw = (values: string): Promise<unknown> =>
      db.execute(sql.raw(`
        insert into quote_overrides
          (order_id, quote_line_id, anchor, computed_thb_minor, override_thb_minor,
           computed_days, override_days, entered_as, entered_value_text, reason_code,
           note_th, set_by_user_id)
        values (${values})
      `));

    const order = `'${draft.orderId}'`;
    const line = `'${lineId}'`;
    const user = `'${sales}'`;

    // A typing mode and a reason nobody defined.
    await expectViolation(
      raw(`${order}, ${line}, 'line_total', 879100, 850000, null, null, 'vibes', '8500', 'volume', null, ${user}`),
      PG.checkViolation,
    );
    await expectViolation(
      raw(`${order}, ${line}, 'line_total', 879100, 850000, null, null, 'line_total', '8500', 'because', null, ${user}`),
      PG.checkViolation,
    );

    // Money on the anchor that is not money, and days on the anchors that are.
    await expectViolation(
      raw(`${order}, null, 'lead_time_days', 879100, 850000, 45, 30, 'lead_time_days', '30', 'volume', null, ${user}`),
      PG.checkViolation,
    );
    await expectViolation(
      raw(`${order}, ${line}, 'line_total', 879100, 850000, 45, 30, 'line_total', '8500', 'volume', null, ${user}`),
      PG.checkViolation,
    );

    // A price is never negative — a concession past zero is a refund, not an override.
    await expectViolation(
      raw(`${order}, ${line}, 'line_total', 879100, -1, null, null, 'line_total', '-1', 'volume', null, ${user}`),
      PG.checkViolation,
    );
    await expectViolation(
      raw(`${order}, null, 'lead_time_days', null, null, 45, -1, 'lead_time_days', '-1', 'volume', null, ${user}`),
      PG.checkViolation,
    );

    // A supersession reason nobody defined, on a row that is not superseded either.
    const id = await setOverride(draft.orderId, { lineId });
    await expectViolation(
      db.execute(sql`
        update quote_overrides
           set superseded_at = now(), superseded_by_user_id = ${manager},
               supersession_reason = 'forgotten'
         where id = ${id}
      `),
      PG.checkViolation,
    );

    // And a row cannot be its own successor.
    await expectViolation(
      db.execute(sql`
        update quote_overrides
           set superseded_at = now(), superseded_by_user_id = ${manager},
               supersession_reason = 'replaced', superseded_by_override_id = id
         where id = ${id}
      `),
      PG.checkViolation,
    );
  });

  it("refuses an override attached to another order's line", async () => {
    /*
     * The composite foreign key, and the reason it is composite. A promise recorded against
     * a line of somebody else's quote is a discount that shows up on neither document and
     * on both reports — and a plain `quote_line_id → quote_lines.id` would accept it,
     * because that line does exist.
     */
    const mine = await createDraft();
    const theirs = await createDraft();
    const theirLine = await addCatalogLine(theirs.orderId);

    await expectViolation(
      setOverride(mine.orderId, { lineId: theirLine }),
      PG.foreignKeyViolation,
    );
  });

  it("refuses a successor belonging to another order's quote", async () => {
    /*
     * ⚠️ FOUND BY MUTATION TESTING, WHICH IS THE ONLY WAY IT WOULD HAVE BEEN FOUND.
     *
     * `quote_overrides_successor_matches()` compares the anchor and the line — and for two
     * DOCUMENT anchors both lines are NULL, so it compares nothing about the order. Without
     * the composite foreign key, one quote's grand total could be recorded as having been
     * replaced by another quote's, and the history of both becomes unreadable.
     *
     * Dropping `quote_overrides_id_order_key` (the FK's target) left the whole suite green
     * before this test existed: the trigger was covering for the key on every case anybody
     * had thought to write down.
     */
    const mine = await createDraft();
    const theirs = await createDraft();

    const ours = await setOverride(mine.orderId, {
      anchor: 'grand_total',
      computed: GRAND,
      override: 900000n,
      enteredAs: 'grand_total',
    });
    const theirOverride = await setOverride(theirs.orderId, {
      anchor: 'grand_total',
      computed: GRAND,
      override: 800000n,
      enteredAs: 'grand_total',
    });

    await expectViolation(supersede(ours, theirOverride), PG.foreignKeyViolation);
  });

  it('refuses two overrides that name each other', async () => {
    // A history with no beginning, and a walk that reconstructs a disputed quote by
    // following the chain would not terminate. Checked at COMMIT, with the rest of the
    // chain assertion — the stamp is written before the successor exists.
    const draft = await createDraft();
    const lineId = await addCatalogLine(draft.orderId);
    const first = await setOverride(draft.orderId, { lineId });
    const second = await replaceOverride(first, {
      orderId: draft.orderId,
      lineId,
      computed: LINE_COMPUTED,
      override: 820000n,
      enteredValueText: '8200',
    });

    await expectViolation(supersede(second, first), PG.restrictViolation);
  });
});

/* ═══════════════════════════════════════════════════════════════════════ *
 * ⓹ A LIVE DOCUMENT PROMISE FREEZES THE DOCUMENT — 0018, and four attacks
 * ═══════════════════════════════════════════════════════════════════════ */

/**
 * The rule 0016 wrote for the line anchor and did not write for the document anchor.
 *
 * `quote_lines_guard_write()` freezes a *line's* repricing inputs while a `line_total` promise
 * hangs off it, because ฿17,000 for two is not ฿17,000 for three. A `grand_total` promise is the
 * same promise about a bigger subject and had no equivalent, so two red teams walked through the
 * gap from opposite ends and one of them summarised it in three legal HTTP calls:
 *
 *     add a ฿7,395.84 line  →  set the document total to ฿7,495.84 (an *uplift*, so nothing is
 *     conceded and no ceiling is ever consulted)  →  add a second line worth ฿55,296.
 *
 *     untouched document ฿66,562.56 · billed ฿7,495.84 · conceded 88.7% · measured ฿0.00
 *
 * Every case below is a write that used to succeed.
 */
describeDb('⓺ a live document promise freezes the document', () => {
  const withDocumentPromise = async (): Promise<{
    draft: Draft;
    lineId: string;
    promiseId: string;
  }> => {
    const draft = await createDraft();
    const lineId = await addCatalogLine(draft.orderId);
    const promiseId = await setOverride(draft.orderId, {
      anchor: 'grand_total',
      computed: GRAND,
      override: 900000n,
      enteredAs: 'grand_total',
    });
    return { draft, lineId, promiseId };
  };

  it('refuses a line added underneath it — the invisible discount', async () => {
    const { draft } = await withDocumentPromise();

    await expectViolation(
      addCatalogLine(draft.orderId, { seq: 2, configHash: hexHash('b'.repeat(8)) }),
      PG.restrictViolation,
    );
    await expectViolation(addFreeformLine(draft.orderId, 200000n, 3), PG.restrictViolation);
  });

  it('refuses the last line being taken away, so a quote cannot be an invoice for nothing', async () => {
    const { draft, lineId } = await withDocumentPromise();

    /* Both spellings: the draft-cart DELETE and the post-submit stamp. */
    await expectViolation(
      db.delete(quoteLines).where(eq(quoteLines.id, lineId)),
      PG.restrictViolation,
    );
    await expectViolation(
      db
        .update(quoteLines)
        .set({ removedAt: new Date(), removedByUserId: sales })
        .where(eq(quoteLines.id, lineId)),
      PG.restrictViolation,
    );

    const still = await db
      .select({ id: quoteLines.id })
      .from(quoteLines)
      .where(eq(quoteLines.orderId, draft.orderId));
    expect(still).toHaveLength(1);
  });

  it('refuses a reprice, and refuses the VAT flip that moved ฿897.68 through the prose route', async () => {
    const { lineId } = await withDocumentPromise();

    await expectViolation(
      db.update(quoteLines).set({ qty: 3 }).where(eq(quoteLines.id, lineId)),
      PG.restrictViolation,
    );
    await expectViolation(
      db
        .update(quoteLines)
        .set({ computedTotalThbMinor: 1n })
        .where(eq(quoteLines.id, lineId)),
      PG.restrictViolation,
    );
    /*
     * ⭐ `is_vat_applicable` was in **neither** frozen list. It is the one field on a line that
     * moves the grand total by 7% with a single write, and it was editable through the endpoint
     * whose whole purpose is text the customer reads.
     */
    await expectViolation(
      db.update(quoteLines).set({ isVatApplicable: false }).where(eq(quoteLines.id, lineId)),
      PG.restrictViolation,
    );
  });

  it('leaves the prose alone, because prose reaches nothing that foots', async () => {
    const { lineId } = await withDocumentPromise();

    await db
      .update(quoteLines)
      .set({ customerDescriptionTh: 'กระจกเทมเปอร์ 8 มม.' })
      .where(eq(quoteLines.id, lineId));

    const [row] = await db
      .select({ description: quoteLines.customerDescriptionTh })
      .from(quoteLines)
      .where(eq(quoteLines.id, lineId));
    expect(row?.description).toBe('กระจกเทมเปอร์ 8 มม.');
  });

  /**
   * ⭐ The ordering invariant `concession.ts` declares, made true by the database.
   *
   * That file states — and depends on — `computed_thb_minor` on a `grand_total` row being the
   * total *after* the line overrides. Nothing constrained the write order, so a document promise
   * written first and a line promise second over-counted the concession by ฿1,070, and revoking
   * a line promise from underneath one **under**-counted it by the same. The second is the
   * fail-open direction, on the exact number `AuthorityService.gate` compares against a ceiling.
   */
  it('refuses a line promise written underneath it, and one withdrawn from underneath it', async () => {
    const { draft, lineId, promiseId } = await withDocumentPromise();

    await expectViolation(setOverride(draft.orderId, { lineId }), PG.restrictViolation);

    /* The other direction: a line promise that was legally written first cannot be withdrawn. */
    const other = await createDraft();
    const otherLine = await addCatalogLine(other.orderId);
    const linePromise = await setOverride(other.orderId, { lineId: otherLine });
    await setOverride(other.orderId, {
      anchor: 'grand_total',
      computed: 909500n,
      override: 900000n,
      enteredAs: 'grand_total',
    });

    await expectViolation(supersede(linePromise, null), PG.restrictViolation);
    expect(promiseId).toBeTypeOf('string');
  });

  it('lets the document promise itself be withdrawn, and everything move again afterwards', async () => {
    const { draft, lineId, promiseId } = await withDocumentPromise();

    /* The recovery, and it must never be blocked: a promise nobody can withdraw is a quote
     * nobody can edit again. */
    await supersede(promiseId, null);

    await db.update(quoteLines).set({ qty: 3 }).where(eq(quoteLines.id, lineId));
    const second = await addCatalogLine(draft.orderId, { seq: 2, configHash: hexHash('c'.repeat(8)) });
    const linePromise = await setOverride(draft.orderId, { lineId: second });

    expect(linePromise).toBeTypeOf('string');
  });

  /* A lead time is a number of days. It is in neither dimension of `approvals` and moves no
   * money, so freezing the document must not freeze it. */
  it('does not touch the lead-time anchor', async () => {
    const { draft } = await withDocumentPromise();

    const days = await setOverride(draft.orderId, { anchor: 'lead_time_days' });
    expect(days).toBeTypeOf('string');
  });
});

/* ═══════════════════════════════════════════════════════════════════════ *
 * ⓻ AN APPROVAL NAMES THE QUOTE IT WAS MEASURED AGAINST
 * ═══════════════════════════════════════════════════════════════════════ */

/**
 * `approvals` was keyed `(order_document_id, dimension)` and carried an absolute figure, which
 * made it a **standing line of credit on the order**: the red team had ฿9,630 approved against a
 * ฿138,240 line — 6.97%, entirely defensible — then revoked the override, removed the line,
 * added a ฿6,912 line and set it to ฿0.00. The new concession was ฿7,395.84 ≤ ฿9,630, so it was
 * "covered", and a 100% discount on a quote the approver never saw left the building.
 *
 * There is a second reason the key had to move, and it is structural rather than adversarial: an
 * `order_documents` row only exists after a submit pins one, and the gate that refuses the
 * submit **rolls that pin back**. So the row a request needed to point at ceased to exist at the
 * exact moment the request became necessary.
 */
describeDb('⓻ an approval names the quote revision it was measured against', () => {
  const REVISION = '0123456789abcdef';

  const approval = async (
    orderId: string,
    over: Partial<typeof approvals.$inferInsert> = {},
  ): Promise<string> => {
    const [row] = await db
      .insert(approvals)
      .values({
        orderId,
        quoteRevision: REVISION,
        dimension: 'margin',
        concessionThbMinor: 100000n,
        reasonTh: 'ส่วนลดตามที่ตกลง',
        requestedByUserId: sales,
        ...over,
      })
      .returning({ id: approvals.id });
    if (!row) throw new Error('could not record an approval');
    return row.id;
  };

  it('records a request before there is any document to point at', async () => {
    const draft = await createDraft();
    const id = await approval(draft.orderId);

    const [row] = await db
      .select({ documentId: approvals.orderDocumentId, revision: approvals.quoteRevision })
      .from(approvals)
      .where(eq(approvals.id, id));

    expect(row?.documentId).toBeNull();
    expect(row?.revision).toBe(REVISION);
  });

  it('refuses a revision token that is not one', async () => {
    const draft = await createDraft();
    await expectViolation(approval(draft.orderId, { quoteRevision: 'ZZZZ' }), PG.checkViolation);
  });

  it('holds at most one open question per order and dimension', async () => {
    const draft = await createDraft();
    await approval(draft.orderId);

    await expectViolation(approval(draft.orderId), PG.uniqueViolation);

    /* A *decided* row against an older revision is not in the way: the quote moved, the
     * approval stopped covering, and asking again is the correct next step. */
    await db
      .update(approvals)
      .set({ status: 'rejected', decidedByUserId: manager, decidedAt: new Date() })
      .where(eq(approvals.orderId, draft.orderId));

    const second = await approval(draft.orderId, { quoteRevision: 'fedcba9876543210' });
    expect(second).toBeTypeOf('string');
  });

  /**
   * The pinned ceiling — so that a limit raised next month does not make last month's approvals
   * look unnecessary, and one lowered does not make them look like abuses. Neither reading is
   * recoverable from `authority_limits`, which holds only today's number.
   */
  it('records the decider’s own ceiling exactly when there was an approval to have one', async () => {
    const draft = await createDraft();
    const id = await approval(draft.orderId);

    /* Approved with no ceiling recorded: the shape CHECK refuses it. */
    await expectViolation(
      db
        .update(approvals)
        .set({ status: 'approved', decidedByUserId: manager, decidedAt: new Date() })
        .where(eq(approvals.id, id)),
      PG.checkViolation,
    );

    /* A ceiling that does not cover the figure: the rule the service states in Thai. */
    await expectViolation(
      db
        .update(approvals)
        .set({
          status: 'approved',
          decidedByUserId: manager,
          decidedAt: new Date(),
          decidedCeilingThbMinor: 99999n,
        })
        .where(eq(approvals.id, id)),
      PG.checkViolation,
    );

    await db
      .update(approvals)
      .set({
        status: 'approved',
        decidedByUserId: manager,
        decidedAt: new Date(),
        decidedCeilingThbMinor: 100000n,
      })
      .where(eq(approvals.id, id));

    const [row] = await db
      .select({ ceiling: approvals.decidedCeilingThbMinor })
      .from(approvals)
      .where(eq(approvals.id, id));
    expect(row?.ceiling).toBe(100000n);
  });

  /* Saying no is not an exercise of authority — the service needs no ceiling to reject, and the
   * row must not demand one. */
  it('needs no ceiling to record a refusal', async () => {
    const draft = await createDraft();
    const id = await approval(draft.orderId);

    await db
      .update(approvals)
      .set({ status: 'rejected', decidedByUserId: manager, decidedAt: new Date(), decisionNoteTh: 'ลดเกินไป' })
      .where(eq(approvals.id, id));

    const [row] = await db
      .select({ status: approvals.status, ceiling: approvals.decidedCeilingThbMinor })
      .from(approvals)
      .where(eq(approvals.id, id));
    expect(row?.status).toBe('rejected');
    expect(row?.ceiling).toBeNull();
  });
});
