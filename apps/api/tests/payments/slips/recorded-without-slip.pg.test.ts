import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, createPool, type Database, type Pool } from '@wewin/db/client';
import { sql } from '@wewin/db/sql';
import { toBigInt } from '@wewin/contract/exact';
import { encodeThb } from '@wewin/contract/order';
import type { MoneyWire } from '@wewin/contract/money';
import type { OrderLineRequestWire, OrderWire } from '@wewin/contract/order';

import type { PermissionCode } from '../../../src/rbac';
import type {
  AcceptSlipResultWire,
  RecordedSlipListWire,
  SlipListWire,
  SlipQueueWire,
  SlipWire,
} from '../../../src/payments/slips';
import {
  client,
  liveLine,
  makeActor,
  paymentsEnv,
  submittedOrder,
  type Actor,
} from '../support/payments-app';
import {
  bootSlipsApp,
  folds,
  instalmentIds,
  ledgerKinds,
  writeThirtySeventy,
  type SlipsApp,
} from './support/slips-app';

/**
 * ⭐ A payment that arrived with no slip — `0047_slip_without_evidence.sql`.
 *
 * The owner's ask, in their words: *"เจ้าหน้าที่สามารถปิดยอดการชำระได้โดยไม่มีการยืนยันสลิป แต่
 * ต้องระบุเหตุผล เพราะอาจมีกรณีที่ลูกค้าโอนชำระแล้วแต่ไม่ได้แนบสลิปยืนยัน"*, accepted on one
 * condition: *"สิ่งสำคัญคือต้องสามารถตรวจสอบย้อนหลังได้ ถ้าทำได้ก็โอเค"*.
 *
 * ── What each block is evidence of, and what it would take to make it green wrongly ──
 *
 * The organising question is the house one: **remove the production line this asserts, does it
 * go red, and is it obvious which line it was?** So blocks ⓵–⓸ assert *consequences* — the money
 * arrived in the same ledger through the same posting, the reason is on the row and frozen, the
 * audit list names the right people — rather than status codes, which survive most of the
 * mutations that matter.
 *
 * ⓹ is different in kind. It is the **guard-survival** block, and every assertion in it was
 * failing before this feature existed. It is here because this round amended a CHECK and a
 * trigger that between them carry the whole of plan 7.6 and 7.7, and "I did not weaken it" is a
 * claim that needs a test rather than a sentence: a slip is still undeletable, the submitter is
 * still immutable, an accepted row is still frozen (**including the two new columns**), a
 * cancelled order still refuses slips, and a self-review with no declaration is still refused —
 * by the database, from a statement the application never sees.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

const tag = randomUUID().slice(0, 8);
const contactFor = (who: string): { email: string; name: string } => ({
  email: `norec-${who}-${tag}@probe.invalid`,
  name: `0047 no-slip ${tag}`,
});

/** The driver error, however deeply Drizzle has wrapped it. Same walk as `slips.pg.test.ts`. */
function pgFailure(error: unknown): { code?: string; where?: string } {
  for (let current: unknown = error, depth = 0; depth < 8; depth += 1) {
    if (typeof current !== 'object' || current === null) return {};
    if ('code' in current && typeof (current as { code: unknown }).code === 'string') {
      const { code, where } = current as { code: string; where?: unknown };
      return { code, ...(typeof where === 'string' ? { where } : {}) };
    }
    current = 'cause' in current ? (current as { cause: unknown }).cause : undefined;
  }
  return {};
}

/**
 * The clerk who takes the telephone call. Records, and reviews nothing.
 *
 * ⚠️ No `payments.verify` and no `payments.self_review_slip`, deliberately — this set is the
 * evidence that the two-person rule survives the feature: their entry waits for somebody else.
 */
const RECORDER: readonly PermissionCode[] = [
  'payments.record_without_slip',
  'payments.read',
  'orders.read',
  'orders.write',
];

/** Somebody who may review, and may not record. The other half of the pair. */
const REVIEWER: readonly PermissionCode[] = [
  'payments.read',
  'payments.verify',
  'orders.read',
  'orders.write',
];

/**
 * Records **and** reviews, and holds no bypass.
 *
 * The actor that isolates the permission half of the rule from the reason half: without them,
 * the "no bypass permission" case is refused by `RbacGuard` for want of `payments.verify` and the
 * test would pass with `SlipsService`'s own check deleted.
 */
const RECORDER_REVIEWER: readonly PermissionCode[] = [
  'payments.record_without_slip',
  'payments.verify',
  'payments.read',
  'orders.read',
  'orders.write',
];

/** The person the owner trusts to close a balance alone. Both new codes, plus the review set. */
const SOLO: readonly PermissionCode[] = [
  'payments.record_without_slip',
  'payments.self_review_slip',
  'payments.read',
  'payments.verify',
  'orders.read',
  'orders.write',
];

describeWithPg('a payment recorded with no slip', () => {
  let pool: Pool;
  let db: Database;
  let app: SlipsApp;
  let call: ReturnType<typeof client>;

  let recorder: Actor;
  let reviewer: Actor;
  let bothHalves: Actor;
  let solo: Actor;
  let customer: Actor;
  let line: OrderLineRequestWire;

  beforeAll(async () => {
    pool = createPool(url ?? '');
    db = createDatabase(pool);
    app = await bootSlipsApp(paymentsEnv(url ?? ''));
    call = client(app.baseUrl);

    recorder = await makeActor(db, app, `norec recorder ${tag}`, RECORDER);
    reviewer = await makeActor(db, app, `norec reviewer ${tag}`, REVIEWER);
    bothHalves = await makeActor(db, app, `norec both ${tag}`, RECORDER_REVIEWER);
    solo = await makeActor(db, app, `norec solo ${tag}`, SOLO);
    customer = await makeActor(db, app, `norec customer ${tag}`, []);
    line = await liveLine(call);
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  /* ---------------------------------------------------------------- *
   * Helpers
   * ---------------------------------------------------------------- */

  const minor = (wire: MoneyWire<'THB'>): bigint => toBigInt(wire);

  const orderOf = async (who: string): Promise<OrderWire> =>
    submittedOrder(db, call, customer, line, contactFor(who));

  /** An order with a 30/70 schedule, and the two figures it wants. */
  const scheduled = async (
    who: string,
  ): Promise<{
    order: OrderWire;
    depositThbMinor: bigint;
    balanceThbMinor: bigint;
    depositInstalment: string;
  }> => {
    const order = await orderOf(who);
    if (order.money === null) throw new Error('a submitted order has money');

    const schedule = await writeThirtySeventy(
      db,
      app,
      order.id,
      minor(order.money.grandTotalThbMinor),
    );
    const [depositInstalment] = await instalmentIds(db, order.id);
    if (depositInstalment === undefined) throw new Error('no instalments');

    return { order, ...schedule, depositInstalment };
  };

  const record = async (
    actor: Actor,
    orderId: string,
    amount: bigint,
    overrides: Record<string, unknown> = {},
  ) =>
    call('POST', '/payments/slips/recorded', {
      token: actor.token,
      body: {
        orderId,
        amountThbMinor: encodeThb(amount),
        transferredAt: new Date().toISOString(),
        noSlipReasonTh: 'ลูกค้าโอนแล้วแจ้งทางโทรศัพท์ แต่ไม่ได้ส่งสลิปกลับมา',
        bankReference: `TEL-${randomUUID().slice(0, 8)}`,
        ...overrides,
      },
    });

  /* ================================================================ *
   * ⓵ The money lands in the same ledger, through the same acceptance
   * ================================================================ */

  it('records a payment with no image and moves the money through the ordinary acceptance path', async () => {
    const { order, depositThbMinor, depositInstalment } = await scheduled('lands');

    const recorded = await record(recorder, order.id, depositThbMinor);
    expect(recorded.status, JSON.stringify(recorded.body)).toBe(201);

    const slip = recorded.body as SlipWire;
    expect(slip.status).toBe('submitted');
    expect(slip.hasImage).toBe(false);
    /* Never photographed, as against photographed and later erased — two different facts. */
    expect(slip.imageErasedAt).toBeNull();
    expect(slip.noSlipReasonTh).toContain('ไม่ได้ส่งสลิป');
    expect(slip.selfReviewReasonTh).toBeNull();
    expect(slip.submittedByUserId).toBe(recorder.userId);

    /*
     * ⚠️ NOT ACCEPTED. This is the assertion that the route did not become a second way for
     * money to move: recording writes a `submitted` row and the folds are untouched.
     */
    expect(await ledgerKinds(db, order.id)).toEqual([]);
    expect((await folds(db, order.id)).held).toBe(0n);

    /* It is in the queue, where a second person will find it. */
    const queue = await call('GET', '/payments/slips?limit=200', { token: reviewer.token });
    expect(queue.status).toBe(200);
    const queued = (queue.body as SlipQueueWire).entries.find((e) => e.slip.id === slip.id);
    expect(queued, 'a recorded payment must appear in the review queue').toBeDefined();
    expect(queued?.slip.noSlipReasonTh).toContain('ไม่ได้ส่งสลิป');

    /* ---- and the money moves through the acceptance that every other slip uses ---- */

    const accepted = await call('POST', `/payments/slips/${slip.id}/acceptance`, {
      token: reviewer.token,
      body: {
        allocations: [
          { instalmentId: depositInstalment, amountThbMinor: encodeThb(depositThbMinor) },
        ],
      },
    });

    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    const result = accepted.body as AcceptSlipResultWire;

    /*
     * ⭐ THE POINT OF THE WHOLE BLOCK. Same posting, same allocation, same gate — a payment
     * with no photograph behind it is an ordinary payment once a person has said so. If this
     * route had grown its own ledger write, `ledgerKinds` would say something other than the
     * one `slip_accepted` every other acceptance produces.
     */
    expect(await ledgerKinds(db, order.id)).toEqual(['slip_accepted']);
    expect(result.gateOpened).toBe(true);
    expect(result.orderTransition).toMatchObject({
      from: 'awaiting_payment',
      to: 'production_confirmed',
    });

    const money = await folds(db, order.id);
    expect(money.cash).toBe(depositThbMinor);
    expect(money.held).toBe(depositThbMinor);
    expect(money.settled).toBe(depositThbMinor);
    expect(result.slip.selfReviewReasonTh).toBeNull();
  }, 60_000);

  /* ================================================================ *
   * ⓶ Two permissions, not one — and neither is `payments.verify`
   * ================================================================ */

  it('refuses to record without payments.record_without_slip, whoever else they are', async () => {
    const { order, depositThbMinor } = await scheduled('perm');

    /* A full reviewer. May accept anybody's slip; may not conjure one out of a telephone call. */
    const refused = await record(reviewer, order.id, depositThbMinor);
    expect(refused.status).toBe(403);

    const listed = await call('GET', `/orders/${order.id}/payment-slips`, {
      token: reviewer.token,
    });
    expect((listed.body as SlipListWire).slips).toEqual([]);
  }, 60_000);

  it('refuses a reason too thin to audit, and one made of spaces', async () => {
    const { order, depositThbMinor } = await scheduled('thin');

    /*
     * 400 and not 422 — `ZodBodyPipe`'s own rule: the body did not parse, so there is no request
     * to have an opinion about, and 422 is reserved for a well-formed one that would produce an
     * illegal state (the allocations that do not foot).
     */
    const short = await record(recorder, order.id, depositThbMinor, { noSlipReasonTh: 'ไม่มี' });
    expect(short.status).toBe(400);

    /* `.trim()` runs before `.min(10)`, which is what makes a wall of spaces a short string. */
    const blank = await record(recorder, order.id, depositThbMinor, {
      noSlipReasonTh: '              ',
    });
    expect(blank.status).toBe(400);

    /* Nothing was written on either attempt. */
    const listed = await call('GET', `/orders/${order.id}/payment-slips`, { token: reviewer.token });
    expect((listed.body as SlipListWire).slips).toEqual([]);
  }, 60_000);

  /* ================================================================ *
   * ⓷ Self-review: the permission AND the reason, and neither alone
   * ================================================================ */

  it('refuses a self-review without the bypass permission, and again without a reason', async () => {
    const { order, depositThbMinor, depositInstalment } = await scheduled('self');

    const allocations = [
      { instalmentId: depositInstalment, amountThbMinor: encodeThb(depositThbMinor) },
    ];

    /*
     * ---- ① somebody who may record AND may verify, and holds no bypass. Refused. ----
     *
     * ⚠️ `bothHalves` and not `recorder`, deliberately. `recorder` holds no `payments.verify`, so
     * `RbacGuard` would refuse this at the door and the test would go on passing with the
     * service's own permission check deleted. This actor reaches the handler.
     */

    const byRecorder = await record(bothHalves, order.id, depositThbMinor);
    expect(byRecorder.status, JSON.stringify(byRecorder.body)).toBe(201);
    const clerkSlip = byRecorder.body as SlipWire;

    const noPermission = await call('POST', `/payments/slips/${clerkSlip.id}/acceptance`, {
      token: bothHalves.token,
      body: { allocations, selfReviewReasonTh: 'อยู่เวรคนเดียว ไม่มีใครตรวจให้' },
    });

    expect(noPermission.status).toBe(403);
    expect(noPermission.body).toMatchObject({
      error: { details: { reason: 'reviewer_is_submitter' } },
    });
    /*
     * ⚠️ A reason without the permission is NOT a bypass. Asserting the refusal alone would pass
     * with the permission check deleted, because the message would still be a 403 from the
     * missing-reason branch — so the *reason code* is the assertion, and the row is checked too.
     */
    expect(await ledgerKinds(db, order.id)).toEqual([]);

    /* ---- ② somebody holding the bypass, who forgot to say why. Also refused. ---- */

    const bySolo = await record(solo, order.id, depositThbMinor);
    expect(bySolo.status, JSON.stringify(bySolo.body)).toBe(201);
    const soloSlip = bySolo.body as SlipWire;

    const noReason = await call('POST', `/payments/slips/${soloSlip.id}/acceptance`, {
      token: solo.token,
      body: { allocations },
    });

    expect(noReason.status).toBe(403);
    expect(noReason.body).toMatchObject({
      error: { details: { reason: 'self_review_needs_reason' } },
    });
    expect(await ledgerKinds(db, order.id)).toEqual([]);

    /* ---- ③ both. Allowed, and the declaration is on the row. ---- */

    const declared = await call('POST', `/payments/slips/${soloSlip.id}/acceptance`, {
      token: solo.token,
      body: {
        allocations,
        selfReviewReasonTh: 'เสาร์นี้อยู่เวรคนเดียว ลูกค้าต้องการใบเสร็จวันนี้',
      },
    });

    expect(declared.status, JSON.stringify(declared.body)).toBe(200);
    const result = declared.body as AcceptSlipResultWire;
    expect(result.slip.selfReviewReasonTh).toContain('อยู่เวรคนเดียว');
    expect(await ledgerKinds(db, order.id)).toEqual(['slip_accepted']);
  }, 60_000);

  it('does not mark a slip self-reviewed because somebody typed a reason on somebody else’s', async () => {
    const { order, depositThbMinor, depositInstalment } = await scheduled('spurious');

    const recorded = await record(recorder, order.id, depositThbMinor);
    expect(recorded.status, JSON.stringify(recorded.body)).toBe(201);
    const slip = recorded.body as SlipWire;

    /* `solo` did not record this one, so the declaration is about a bypass that never happened. */
    const accepted = await call('POST', `/payments/slips/${slip.id}/acceptance`, {
      token: solo.token,
      body: {
        allocations: [
          { instalmentId: depositInstalment, amountThbMinor: encodeThb(depositThbMinor) },
        ],
        selfReviewReasonTh: 'เหตุผลที่ไม่ควรถูกบันทึก เพราะไม่ได้ตรวจสลิปของตัวเอง',
      },
    });

    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    /*
     * ⚠️ The audit must not over-report either. A self-review marker on a slip two people handled
     * correctly is the list lying in the direction nobody would think to check.
     */
    expect((accepted.body as AcceptSlipResultWire).slip.selfReviewReasonTh).toBeNull();
  }, 60_000);

  /* ================================================================ *
   * ⓸ The audit surface — the owner's condition, made answerable
   * ================================================================ */

  it('answers who recorded it, who accepted it, why, and which were self-reviewed', async () => {
    const twoPeople = await scheduled('audit-pair');
    const oneperson = await scheduled('audit-solo');

    const pairSlip = (await record(recorder, twoPeople.order.id, twoPeople.depositThbMinor))
      .body as SlipWire;
    await call('POST', `/payments/slips/${pairSlip.id}/acceptance`, {
      token: reviewer.token,
      body: {
        allocations: [
          {
            instalmentId: twoPeople.depositInstalment,
            amountThbMinor: encodeThb(twoPeople.depositThbMinor),
          },
        ],
      },
    });

    const soloSlip = (await record(solo, oneperson.order.id, oneperson.depositThbMinor))
      .body as SlipWire;
    await call('POST', `/payments/slips/${soloSlip.id}/acceptance`, {
      token: solo.token,
      body: {
        allocations: [
          {
            instalmentId: oneperson.depositInstalment,
            amountThbMinor: encodeThb(oneperson.depositThbMinor),
          },
        ],
        selfReviewReasonTh: 'ปิดยอดคนเดียวเพราะเพื่อนร่วมทีมลาป่วย',
      },
    });

    const audit = await call('GET', '/payments/slips/recorded?limit=200', {
      token: reviewer.token,
    });
    expect(audit.status, JSON.stringify(audit.body)).toBe(200);
    const entries = (audit.body as RecordedSlipListWire).entries;

    const pair = entries.find((entry) => entry.slip.id === pairSlip.id);
    const alone = entries.find((entry) => entry.slip.id === soloSlip.id);

    expect(pair, 'the audit list must carry every evidence-free payment').toBeDefined();
    expect(alone).toBeDefined();

    /* ⭐ Every clause of the owner's question, on one row. */
    expect(pair?.recordedBy).toMatchObject({ userId: recorder.userId });
    expect(pair?.recordedBy?.name).toContain('norec recorder');
    expect(pair?.reviewedBy).toMatchObject({ userId: reviewer.userId });
    expect(pair?.slip.noSlipReasonTh).toContain('ไม่ได้ส่งสลิป');
    expect(pair?.selfReviewed).toBe(false);
    expect(pair?.orderId).toBe(twoPeople.order.id);

    expect(alone?.recordedBy).toMatchObject({ userId: solo.userId });
    expect(alone?.reviewedBy).toMatchObject({ userId: solo.userId });
    expect(alone?.selfReviewed).toBe(true);
    expect(alone?.slip.selfReviewReasonTh).toContain('เพื่อนร่วมทีมลาป่วย');

    /* And the narrowing question the owner will actually ask. */
    const only = await call('GET', '/payments/slips/recorded?limit=200&only=self_reviewed', {
      token: reviewer.token,
    });
    expect(only.status).toBe(200);
    const ids = (only.body as RecordedSlipListWire).entries.map((entry) => entry.slip.id);
    expect(ids).toContain(soloSlip.id);
    expect(ids).not.toContain(pairSlip.id);
  }, 90_000);

  it('keeps an ordinary customer slip out of the audit list entirely', async () => {
    /*
     * The list is `no_slip_reason_th is not null` and nothing else. A slip whose picture was
     * erased for PDPA has no image either, and must not read as an evidence-free entry — it is an
     * ordinary customer slip that was photographed and lawfully cleaned up. Nothing in this suite
     * creates one, so the weaker statement is what is asserted: a *customer* slip never appears.
     */
    const { order, depositThbMinor } = await scheduled('ordinary');

    const recorded = await record(recorder, order.id, depositThbMinor);
    const mine = (recorded.body as SlipWire).id;

    const audit = await call('GET', '/payments/slips/recorded?limit=200', { token: reviewer.token });
    const entries = (audit.body as RecordedSlipListWire).entries;

    expect(entries.map((entry) => entry.slip.id)).toContain(mine);
    expect(
      entries.every((entry) => entry.slip.noSlipReasonTh !== null),
      'every row in the audit list is an evidence-free entry',
    ).toBe(true);
  }, 60_000);

  it('shows the customer why there is no slip, and never why one person did both halves', async () => {
    const { order, depositThbMinor, depositInstalment } = await scheduled('audience');

    const slip = (await record(solo, order.id, depositThbMinor)).body as SlipWire;
    await call('POST', `/payments/slips/${slip.id}/acceptance`, {
      token: solo.token,
      body: {
        allocations: [
          { instalmentId: depositInstalment, amountThbMinor: encodeThb(depositThbMinor) },
        ],
        selfReviewReasonTh: 'ปิดยอดคนเดียวเพราะร้านมีพนักงานคนเดียวในวันหยุด',
      },
    });

    const mine = await call('GET', `/orders/${order.id}/payment-slips`, { token: customer.token });
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    const [customerCopy] = (mine.body as SlipListWire).slips;

    /*
     * ⚠️ Reasons out, identities withheld — the rule `rejectedReasonTh` already follows. The
     * customer is owed the sentence about *their* money and is not owed a note about how the
     * company staffs its payments desk.
     */
    expect(customerCopy?.noSlipReasonTh).toContain('ไม่ได้ส่งสลิป');
    expect(customerCopy?.selfReviewReasonTh).toBeNull();
    expect(customerCopy?.submittedByUserId).toBeNull();
    expect(customerCopy?.reviewedByUserId).toBeNull();
  }, 60_000);

  /* ================================================================ *
   * ⓹ NOTHING WAS WEAKENED. Every assertion here is about a guard that
   *    existed before this round, plus the two columns it now covers.
   * ================================================================ */

  it('still refuses to delete a slip, to edit its submitter, or to touch a reviewed row', async () => {
    const { order, depositThbMinor, depositInstalment } = await scheduled('guards');

    const slip = (await record(recorder, order.id, depositThbMinor)).body as SlipWire;

    /* ---- the submitter is immutable even while the row is still `submitted` ---- */
    const movedSubmitter = await db
      .execute(
        sql`update payment_slips set submitted_by_user_id = ${reviewer.userId}::uuid
             where id = ${slip.id}::uuid`,
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(pgFailure(movedSubmitter)).toMatchObject({ code: '23001' });

    const accepted = await call('POST', `/payments/slips/${slip.id}/acceptance`, {
      token: reviewer.token,
      body: {
        allocations: [
          { instalmentId: depositInstalment, amountThbMinor: encodeThb(depositThbMinor) },
        ],
      },
    });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);

    /* ---- a slip is evidence and cannot be deleted ---- */
    const deleted = await db
      .execute(sql`delete from payment_slips where id = ${slip.id}::uuid`)
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(pgFailure(deleted)).toMatchObject({
      code: '23001',
      where: expect.stringContaining('payment_slips_guard_write'),
    });

    /* ---- a reviewed row is frozen. `bank_reference` is guarded by the freeze and by
           nothing else, which is why `payment.test.ts` picks it and why this does too. ---- */
    const rewritten = await db
      .execute(sql`update payment_slips set bank_reference = 'REWRITTEN' where id = ${slip.id}::uuid`)
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(pgFailure(rewritten)).toMatchObject({ code: '23001' });
  }, 60_000);

  it('freezes the two new reasons the moment the slip is reviewed', async () => {
    const { order, depositThbMinor, depositInstalment } = await scheduled('frozen-reasons');

    const slip = (await record(solo, order.id, depositThbMinor)).body as SlipWire;
    const accepted = await call('POST', `/payments/slips/${slip.id}/acceptance`, {
      token: solo.token,
      body: {
        allocations: [
          { instalmentId: depositInstalment, amountThbMinor: encodeThb(depositThbMinor) },
        ],
        selfReviewReasonTh: 'เหตุผลตอนตรวจ ซึ่งจะต้องแก้ไม่ได้อีกเลยหลังจากนี้',
      },
    });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);

    /*
     * ⭐ THE ASSERTION THE OWNER'S "ตรวจสอบย้อนหลังได้" RESTS ON.
     *
     * A reason somebody can go back and improve once the money has landed is not a trail, it is a
     * draft. Both columns are in `payment_slips_guard_write()`'s frozen list beside the money, and
     * these two statements are what says so — remove either from that list and one goes green.
     */
    for (const statement of [
      sql`update payment_slips set no_slip_reason_th = 'เขียนใหม่ทีหลัง' where id = ${slip.id}::uuid`,
      sql`update payment_slips set self_review_reason_th = 'เขียนใหม่ทีหลัง' where id = ${slip.id}::uuid`,
    ]) {
      const failure = await db.execute(statement).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(pgFailure(failure)).toMatchObject({
        code: '23001',
        where: expect.stringContaining('payment_slips_guard_write'),
      });
    }
  }, 60_000);

  it('refuses a slip with no image, no erasure and no reason — the CHECK the app can never reach', async () => {
    const { order, depositThbMinor } = await scheduled('evidence');

    /*
     * The application always supplies one of the three, so this is the statement a script, a
     * migration or a future second writer would make. `payment_slips_evidence_exists` is the only
     * thing standing between it and a payment nobody can ever explain.
     */
    const naked = await db
      .execute(
        sql`insert into payment_slips (order_id, amount_thb_minor, transferred_at)
            values (${order.id}, ${depositThbMinor.toString()}::bigint, now())`,
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(pgFailure(naked)).toMatchObject({ code: '23514' });

    /* …and the PDPA shape stays legal: a row that once had an image and no longer does. */
    const erased = await db
      .execute(
        sql`insert into payment_slips (order_id, amount_thb_minor, transferred_at, storage_key_erased_at)
            values (${order.id}, ${depositThbMinor.toString()}::bigint, now(), now())`,
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(erased, 'an erased slip must remain representable').toBeUndefined();
  }, 60_000);

  it('still refuses a self-review with nothing written down, from a statement the app never sees', async () => {
    const { order, depositThbMinor } = await scheduled('db-bypass');

    const slip = (await record(solo, order.id, depositThbMinor)).body as SlipWire;

    /*
     * ⭐ THE HALF THAT IS NOT THE APPLICATION'S.
     *
     * `payments.self_review_slip` decides *whether*, in `SlipsService`. This statement bypasses
     * the service entirely — which is what a script, a psql session or a second code path is —
     * and the trigger must still refuse, because the column is null and the reviewer is the
     * submitter. Both halves of the rule moved together in 0047; this is the evidence for the
     * trigger half, and the CHECK half is `packages/db/tests/payment.test.ts`.
     */
    const silent = await db
      .execute(
        sql`update payment_slips
               set status = 'accepted',
                   reviewed_by_user_id = ${solo.userId}::uuid,
                   reviewed_at = now()
             where id = ${slip.id}::uuid`,
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(pgFailure(silent)).toMatchObject({
      code: '23001',
      where: expect.stringContaining('payment_slips_guard_write'),
    });
  }, 60_000);

  it('still refuses to record a payment against a contract that has finished', async () => {
    const order = await orderOf('cancelled');

    const cancelled = await call('POST', `/orders/${order.id}/transitions/cancelled`, {
      token: customer.token,
      body: { reason: 'ยกเลิกก่อนจ่ายเงิน' },
    });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);

    const refused = await record(recorder, order.id, 100_00n);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      error: { details: { reason: 'order_not_accepting_slips', status: 'cancelled' } },
    });

    /* And the database half, for the path that does not go through this service at all. */
    const direct = await db
      .execute(
        sql`insert into payment_slips (order_id, amount_thb_minor, transferred_at, no_slip_reason_th)
            values (${order.id}, 100, now(), 'เหตุผลที่ยาวพอจะผ่านการตรวจรูปแบบ')`,
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(pgFailure(direct)).toMatchObject({
      code: '23001',
      where: expect.stringContaining('order_child_require_status'),
    });
  }, 60_000);
});
