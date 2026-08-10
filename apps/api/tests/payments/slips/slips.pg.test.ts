import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, createPool, type Database, type Pool } from '@wewin/db/client';
import { sql } from '@wewin/db/sql';
import { toBigInt } from '@wewin/contract/exact';
import { encodeThb } from '@wewin/contract/order';
import type { MoneyWire } from '@wewin/contract/money';
import type { OrderLineRequestWire, OrderWire } from '@wewin/contract/order';

import type { PermissionCode } from '../../../src/rbac';
import { mintImageGrant, type SlipStorageConfig } from '../../../src/payments/slips';
import { SLIP_STORAGE_CONFIG } from '../../../src/payments/slips/slips.tokens';
import type {
  AcceptSlipResultWire,
  RejectSlipResultWire,
  SlipImageGrantWire,
  SlipImageUploadWire,
  SlipListWire,
  SlipQueueWire,
  SlipReviewWire,
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
import { exifWithGps, jpegWithSegment, makeJpeg, makePng } from '../../media/fixtures';
import {
  bootSlipsApp,
  eventCount,
  folds,
  getRaw,
  instalmentIds,
  ledgerKinds,
  makeBankAccount,
  receivedAccountOf,
  uploadImage,
  writeThirtySeventy,
  type SlipsApp,
} from './support/slips-app';

/**
 * Payment slips, end to end, over real HTTP against real Postgres and a real bucket.
 *
 * ── What each block is evidence of ───────────────────────────────────────────────
 *
 * The organising question is the one the brief asks: **remove the fix, does something go
 * red, and is it obvious which fix it was?** So each block names the rule it is about and
 * asserts the *consequence* rather than the status code — the acceptance test checks the
 * order's status and `frozen_at`, the rejection test checks that the spine did not grow, and
 * the footing test checks that the ledger stayed empty. A test that only asserted `422`
 * would pass with the transaction rollback removed.
 *
 * Nothing here is mocked. Six of these cannot be tested any other way: the status trigger,
 * the deferred footing assertion, the two-person CHECK, the frontier, the gate predicate and
 * the ownership WHERE clause are all in the database, and a mocked repository has none of
 * them.
 *
 * ── The one thing that is written directly ───────────────────────────────────────
 *
 * The instalment schedule. That module is another agent's in this round, so reaching for its
 * routes would make this suite fail whenever theirs is mid-edit and would prove nothing
 * about slips. `writeThirtySeventy` writes the rows the way the schema insists — see its
 * note. Everything else, including the order and its pinned totals, goes through the
 * application.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

const tag = randomUUID().slice(0, 8);
const contactFor = (who: string): { email: string; name: string } => ({
  email: `slips-${who}-${tag}@probe.invalid`,
  name: `plan 7.6 slips ${tag}`,
});

/**
 * The driver error, however deeply Drizzle has wrapped it.
 *
 * `DrizzleQueryError` carries no `code` and keeps the real error on `.cause`; reading the
 * SQLSTATE off the top sees `undefined` for every trigger in the schema. The same walk
 * `src/payments/slips/slip-errors.ts` does, restated here because a test that used the
 * production translator would be testing the translator.
 */
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

/** Everything a person who reviews slips has to hold — see `slip-review.controller.ts`. */
const REVIEWER: readonly PermissionCode[] = [
  'payments.read',
  'payments.verify',
  'orders.read',
  'orders.write',
];

/** The same person without `orders.write`: may reject, may not accept. */
const CLERK: readonly PermissionCode[] = ['payments.read', 'payments.verify', 'orders.read'];

describeWithPg('payment slips — upload, review, acceptance, rejection', () => {
  let pool: Pool;
  let db: Database;
  let app: SlipsApp;
  let call: ReturnType<typeof client>;

  let reviewer: Actor;
  let secondReviewer: Actor;
  let clerk: Actor;
  let looker: Actor;
  let eraser: Actor;
  let customer: Actor;
  let stranger: Actor;
  let line: OrderLineRequestWire;

  beforeAll(async () => {
    pool = createPool(url ?? '');
    db = createDatabase(pool);
    app = await bootSlipsApp(paymentsEnv(url ?? ''));
    call = client(app.baseUrl);

    reviewer = await makeActor(db, app, `slips reviewer ${tag}`, REVIEWER);
    secondReviewer = await makeActor(db, app, `slips reviewer two ${tag}`, REVIEWER);
    clerk = await makeActor(db, app, `slips clerk ${tag}`, CLERK);
    looker = await makeActor(db, app, `slips looker ${tag}`, ['payments.read', 'orders.read']);
    eraser = await makeActor(db, app, `slips eraser ${tag}`, [
      'payments.read',
      'orders.read',
      'users.erase',
    ]);
    customer = await makeActor(db, app, `slips customer ${tag}`, []);
    stranger = await makeActor(db, app, `slips stranger ${tag}`, []);
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
    submittedOrder(call, customer, line, contactFor(who));

  const uploadFor = async (
    orderId: string,
    actor: Actor = customer,
    bytes: Buffer = makePng(),
  ): Promise<SlipImageUploadWire> => {
    const uploaded = await uploadImage(
      app.baseUrl,
      `/orders/${orderId}/payment-slips/image`,
      actor.token,
      bytes,
    );
    expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(201);
    return uploaded.body as SlipImageUploadWire;
  };

  const createSlip = async (
    orderId: string,
    amount: bigint,
    actor: Actor = customer,
    overrides: Record<string, unknown> = {},
  ): Promise<SlipWire> => {
    const image = await uploadFor(orderId, actor);
    const created = await call('POST', `/orders/${orderId}/payment-slips`, {
      token: actor.token,
      body: {
        imageHandle: image.imageHandle,
        amountThbMinor: encodeThb(amount),
        transferredAt: new Date().toISOString(),
        bankReference: `REF-${randomUUID().slice(0, 8)}`,
        payerName: 'ลูกค้าทดสอบ',
        payerAccountLast4: '4321',
        ...overrides,
      },
    });

    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return created.body as SlipWire;
  };

  const statusOf = async (orderId: string): Promise<{ status: string; frozenAt: string | null }> => {
    const read = await call('GET', `/orders/${orderId}`, { token: reviewer.token });
    expect(read.status).toBe(200);
    const order = read.body as OrderWire;
    return { status: order.status, frozenAt: order.frozenAt };
  };

  /* ================================================================ *
   * ⓵ The asymmetry: the gating slip freezes, the balance slip does not
   * ================================================================ */

  it('freezes the order on the slip that closes the GATING instalment, and on no other', async () => {
    const order = await orderOf('gate');
    if (order.money === null) throw new Error('a submitted order has money');

    const grand = minor(order.money.grandTotalThbMinor);
    const schedule = await writeThirtySeventy(db, app, order.id, grand);
    const [depositInstalment, balanceInstalment] = await instalmentIds(db, order.id);

    /* ---- the deposit slip: the comparison screen first, as plan 7.6 requires ---- */

    const deposit = await createSlip(order.id, schedule.depositThbMinor);

    const reviewed = await call('GET', `/payments/slips/${deposit.id}`, { token: reviewer.token });
    expect(reviewed.status, JSON.stringify(reviewed.body)).toBe(200);
    const screen = reviewed.body as SlipReviewWire;

    expect(screen.gate).toMatchObject({ status: 'production_confirmed', isOpenNow: false });
    expect(screen.gate.gatingInstalmentSeqs).toEqual([1]);
    expect(minor(screen.comparison.slipAmountThbMinor)).toBe(schedule.depositThbMinor);
    expect(screen.comparison.expectedNextDueThbMinor).not.toBeNull();
    /* Zero difference: the two columns agree, which is the only case a reviewer may accept blind. */
    expect(minor(screen.comparison.differenceThbMinor ?? encodeThb(-1n))).toBe(0n);
    expect(screen.suggestedAllocations).toEqual([
      { instalmentId: depositInstalment, amountThbMinor: encodeThb(schedule.depositThbMinor) },
    ]);

    const accepted = await call('POST', `/payments/slips/${deposit.id}/acceptance`, {
      token: reviewer.token,
      body: { allocations: screen.suggestedAllocations },
    });

    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    const result = accepted.body as AcceptSlipResultWire;

    /* ⚠️ THIS acceptance is the transition. */
    expect(result.gateOpened).toBe(true);
    expect(result.orderTransition).toMatchObject({
      from: 'awaiting_payment',
      to: 'production_confirmed',
    });

    const frozen = await statusOf(order.id);
    expect(frozen.status).toBe('production_confirmed');
    /* Stamped by the database at the freeze point, not by this module. */
    expect(frozen.frozenAt).not.toBeNull();

    /* ---- the balance slip: money, and nothing else ---- */

    const balance = await createSlip(order.id, schedule.balanceThbMinor);
    const secondAcceptance = await call('POST', `/payments/slips/${balance.id}/acceptance`, {
      token: reviewer.token,
      body: {
        allocations: [
          { instalmentId: balanceInstalment, amountThbMinor: encodeThb(schedule.balanceThbMinor) },
        ],
      },
    });

    expect(secondAcceptance.status, JSON.stringify(secondAcceptance.body)).toBe(200);
    const second = secondAcceptance.body as AcceptSlipResultWire;

    /* ⚠️ …and this one moves nothing. Plan 7.5(ข). */
    expect(second.orderTransition).toBeNull();
    expect(second.gateOpened).toBe(false);

    const afterBalance = await statusOf(order.id);
    expect(afterBalance.status).toBe('production_confirmed');
    /* The freeze was not re-dated by the second payment. */
    expect(afterBalance.frozenAt).toBe(frozen.frozenAt);

    /* ---- and the three numbers, from the database's own folds ---- */

    const money = await folds(db, order.id);
    expect(money.cash).toBe(grand);
    expect(money.held).toBe(grand);
    expect(money.settled).toBe(grand);
    /* The frontier is a MAX over the settled prefix, and both instalments are settled. */
    expect(money.settledThrough).toBe(2);

    expect(minor(second.money.outstandingThbMinor)).toBe(0n);
    expect(await ledgerKinds(db, order.id)).toEqual(['slip_accepted', 'slip_accepted']);
  }, 60_000);

  /* ================================================================ *
   * ⓶ Rejecting is not a transition — plan 7.3
   * ================================================================ */

  it('leaves the order exactly where it was when a slip is rejected, and writes nothing to the spine', async () => {
    const order = await orderOf('reject');
    if (order.money === null) throw new Error('a submitted order has money');

    const schedule = await writeThirtySeventy(db, app, order.id, minor(order.money.grandTotalThbMinor));
    const slip = await createSlip(order.id, schedule.depositThbMinor);

    const before = await eventCount(db, order.id);

    const rejected = await call('POST', `/payments/slips/${slip.id}/rejection`, {
      token: reviewer.token,
      body: { reasonTh: 'ยอดเงินบนสลิปไม่ตรงกับที่ต้องชำระ และเวลาที่โอนอ่านไม่ออก' },
    });

    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    const result = rejected.body as RejectSlipResultWire;
    expect(result.slip.status).toBe('rejected');
    expect(result.slip.rejectedReasonTh).toContain('ไม่ตรง');

    /*
     * ⚠️ THE ASSERTION THIS TEST EXISTS FOR.
     *
     * Not "the response was 200" — the order did not move, no event was appended, and no
     * money was recorded. Making a rejection a transition would need a status meaning the
     * same as the previous status, which plan 7.3 calls poison; making it *append* to the
     * spine would fan a notification out to the customer through the outbox saying an order
     * had changed state when it had not.
     */
    expect(await statusOf(order.id)).toMatchObject({ status: 'awaiting_payment', frozenAt: null });
    expect(await eventCount(db, order.id)).toBe(before);
    expect(await ledgerKinds(db, order.id)).toEqual([]);

    const money = await folds(db, order.id);
    expect(money.cash).toBe(0n);
    expect(money.settled).toBe(0n);
    /* Nothing settled: `MIN(seq) - 1` on a dense schedule, which is 0 — not null. */
    expect(money.settledThrough).toBe(0);
  }, 60_000);

  /* ================================================================ *
   * ⓷ The asymmetry is in the permissions, not only in the handler
   * ================================================================ */

  it('lets a clerk without orders.write reject a slip and refuses to let them accept one', async () => {
    const order = await orderOf('clerk');
    if (order.money === null) throw new Error('a submitted order has money');

    const schedule = await writeThirtySeventy(db, app, order.id, minor(order.money.grandTotalThbMinor));
    const [depositInstalment] = await instalmentIds(db, order.id);
    const slip = await createSlip(order.id, schedule.depositThbMinor);

    /*
     * Accepting may freeze an order, and *which* slip does that is not knowable before the
     * allocations are planned — so the authority to move an order is required for every
     * acceptance. The guard refuses before the handler runs.
     */
    const refused = await call('POST', `/payments/slips/${slip.id}/acceptance`, {
      token: clerk.token,
      body: {
        allocations: [
          { instalmentId: depositInstalment, amountThbMinor: encodeThb(schedule.depositThbMinor) },
        ],
      },
    });
    expect(refused.status).toBe(403);

    /* The slip is untouched: a refused acceptance is not a review. */
    const listed = await call('GET', `/orders/${order.id}/payment-slips`, { token: customer.token });
    expect(((listed.body as SlipListWire).slips[0] ?? { status: '' }).status).toBe('submitted');

    /* The same person may reject, because rejecting moves nothing. */
    const rejected = await call('POST', `/payments/slips/${slip.id}/rejection`, {
      token: clerk.token,
      body: { reasonTh: 'รูปสลิปเบลอเกินกว่าจะอ่านเลขที่รายการได้' },
    });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
  }, 60_000);

  /* ================================================================ *
   * ⓸ Allocations are untrusted input — plan 7.8
   * ================================================================ */

  it('refuses allocations that do not foot, and leaves the slip and the ledger untouched', async () => {
    const order = await orderOf('foot');
    if (order.money === null) throw new Error('a submitted order has money');

    const schedule = await writeThirtySeventy(db, app, order.id, minor(order.money.grandTotalThbMinor));
    const [depositInstalment] = await instalmentIds(db, order.id);
    const slip = await createSlip(order.id, schedule.depositThbMinor);

    const short = await call('POST', `/payments/slips/${slip.id}/acceptance`, {
      token: reviewer.token,
      body: {
        allocations: [
          {
            instalmentId: depositInstalment,
            amountThbMinor: encodeThb(schedule.depositThbMinor - 40n),
          },
        ],
      },
    });

    expect(short.status).toBe(422);
    expect(short.body).toMatchObject({
      error: { details: { reason: 'allocations_do_not_foot', differenceThbMinor: '-40' } },
    });

    /*
     * The rollback is the assertion. Without the transaction, the slip would be accepted and
     * the ledger written before the footing was checked — which is exactly the state the
     * deferred trigger exists to make impossible at COMMIT.
     */
    const review = await call('GET', `/payments/slips/${slip.id}`, { token: reviewer.token });
    expect((review.body as SlipReviewWire).slip.status).toBe('submitted');
    expect(await ledgerKinds(db, order.id)).toEqual([]);
    expect((await folds(db, order.id)).cash).toBe(0n);
  }, 60_000);

  it('refuses to pile a whole payment onto the first instalment', async () => {
    const order = await orderOf('over');
    if (order.money === null) throw new Error('a submitted order has money');

    const grand = minor(order.money.grandTotalThbMinor);
    await writeThirtySeventy(db, app, order.id, grand);
    const [depositInstalment] = await instalmentIds(db, order.id);

    /* Paid in full, in one transfer, on a 30/70 schedule. */
    const slip = await createSlip(order.id, grand);

    const piled = await call('POST', `/payments/slips/${slip.id}/acceptance`, {
      token: reviewer.token,
      body: { allocations: [{ instalmentId: depositInstalment, amountThbMinor: encodeThb(grand) }] },
    });

    expect(piled.status).toBe(422);
    expect(piled.body).toMatchObject({ error: { details: { reason: 'over_allocated', seq: 1 } } });

    /*
     * And the suggestion the server offers instead splits it across the prefix — one slip
     * settling both instalments, which still opens the gate exactly once.
     */
    const review = await call('GET', `/payments/slips/${slip.id}`, { token: reviewer.token });
    const suggested = (review.body as SlipReviewWire).suggestedAllocations;
    expect(suggested).toHaveLength(2);

    const accepted = await call('POST', `/payments/slips/${slip.id}/acceptance`, {
      token: reviewer.token,
      body: { allocations: suggested },
    });

    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect((accepted.body as AcceptSlipResultWire).orderTransition).toMatchObject({
      to: 'production_confirmed',
    });
    expect((await folds(db, order.id)).settledThrough).toBe(2);
  }, 60_000);

  it('refuses an instalment belonging to another order — money does not move sideways', async () => {
    const mine = await orderOf('mine');
    const theirs = await orderOf('theirs');
    if (mine.money === null || theirs.money === null) throw new Error('a submitted order has money');

    const schedule = await writeThirtySeventy(db, app, mine.id, minor(mine.money.grandTotalThbMinor));
    await writeThirtySeventy(db, app, theirs.id, minor(theirs.money.grandTotalThbMinor));
    const [foreignInstalment] = await instalmentIds(db, theirs.id);

    const slip = await createSlip(mine.id, schedule.depositThbMinor);

    const sideways = await call('POST', `/payments/slips/${slip.id}/acceptance`, {
      token: reviewer.token,
      body: {
        allocations: [
          { instalmentId: foreignInstalment, amountThbMinor: encodeThb(schedule.depositThbMinor) },
        ],
      },
    });

    expect(sideways.status).toBe(422);
    expect(sideways.body).toMatchObject({
      error: { details: { reason: 'instalment_not_on_this_order' } },
    });
    expect(await ledgerKinds(db, theirs.id)).toEqual([]);
  }, 60_000);

  /* ================================================================ *
   * ⓹ The two-person rule — plan 7.7's single control
   * ================================================================ */

  it('refuses to let the person who uploaded a slip review it', async () => {
    const order = await orderOf('self');
    if (order.money === null) throw new Error('a submitted order has money');

    const schedule = await writeThirtySeventy(db, app, order.id, minor(order.money.grandTotalThbMinor));
    const [depositInstalment] = await instalmentIds(db, order.id);

    /* Staff entering a transfer reported by telephone — the ordinary way this happens. */
    const slip = await createSlip(order.id, schedule.depositThbMinor, reviewer);

    const ownReview = await call('POST', `/payments/slips/${slip.id}/acceptance`, {
      token: reviewer.token,
      body: {
        allocations: [
          { instalmentId: depositInstalment, amountThbMinor: encodeThb(schedule.depositThbMinor) },
        ],
      },
    });

    expect(ownReview.status).toBe(403);
    expect(ownReview.body).toMatchObject({ error: { details: { reason: 'reviewer_is_submitter' } } });

    /*
     * And they cannot reject it either. The rule is about *review*, not about acceptance: a
     * person who could refuse their own upload could clear their own mistake off the queue
     * before anybody else saw it, which is the same control failing in the quieter direction.
     */
    const ownRejection = await call('POST', `/payments/slips/${slip.id}/rejection`, {
      token: reviewer.token,
      body: { reasonTh: 'ลบรายการของตัวเองออกจากคิวเงียบๆ' },
    });
    expect(ownRejection.status).toBe(403);

    /* Anybody else may, and the CHECK behind this is what holds when the service does not. */
    const byAnother = await call('POST', `/payments/slips/${slip.id}/acceptance`, {
      token: secondReviewer.token,
      body: {
        allocations: [
          { instalmentId: depositInstalment, amountThbMinor: encodeThb(schedule.depositThbMinor) },
        ],
      },
    });

    expect(byAnother.status, JSON.stringify(byAnother.body)).toBe(200);
  }, 60_000);

  /* ================================================================ *
   * ⓺ Trap 6 — the write is guarded on status, in two places
   * ================================================================ */

  it('refuses a slip against a finished contract, in the API and again in the database', async () => {
    const order = await orderOf('finished');
    if (order.money === null) throw new Error('a submitted order has money');

    /* Cancel it. No schedule was written, so no footing assertion is involved. */
    const cancelled = await call('POST', `/orders/${order.id}/transitions/cancelled`, {
      token: customer.token,
      body: { reason: 'เปลี่ยนใจ ยังไม่พร้อมติดตั้ง' },
    });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);

    /* ── the API half: refused before a single byte is stored ── */
    const upload = await uploadImage(
      app.baseUrl,
      `/orders/${order.id}/payment-slips/image`,
      customer.token,
      makePng(),
    );
    expect(upload.status).toBe(409);
    expect(upload.body).toMatchObject({
      error: { details: { reason: 'order_not_accepting_slips', status: 'cancelled' } },
    });

    /*
     * ── the database half ──
     *
     * ⚠️ This is the assertion that stops `SLIP_ATTACHABLE_STATUSES` from becoming the only
     * guard. Plan 7.4 trap 6 is precisely that `FOR UPDATE` orders a race and forbids
     * nothing; the service's list holds for the service, and `payment_slips_live_orders_only`
     * holds for a second code path, a script, or a migration. Inserting directly is the only
     * way to prove the second one is there.
     */
    const direct = await db
      .execute(
        sql`insert into payment_slips (order_id, amount_thb_minor, transferred_at)
            values (${order.id}, 100, now())`,
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(direct, 'the trigger must refuse a slip against a cancelled order').toBeDefined();
    /*
     * The SQLSTATE and the raising function, not the prose. `restrict_violation` is what
     * every guard in `0011_payment_guards.sql` raises with, and `order_child_require_status`
     * is the shared mechanism 0007 predicted slips would attach to — asserting on the message
     * text would turn a reword into a failure and would not distinguish this trigger from any
     * other.
     */
    expect(pgFailure(direct)).toMatchObject({
      code: '23001',
      where: expect.stringContaining('order_child_require_status'),
    });
  }, 60_000);

  it('refuses to accept a slip whose order was cancelled while it sat in the queue', async () => {
    const order = await orderOf('raced');

    const slip = await createSlip(order.id, 100_00n);

    const cancelled = await call('POST', `/orders/${order.id}/transitions/cancelled`, {
      token: customer.token,
      body: { reason: 'ยกเลิกระหว่างรอตรวจสลิป' },
    });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);

    const accepted = await call('POST', `/payments/slips/${slip.id}/acceptance`, {
      token: reviewer.token,
      body: { allocations: [{ instalmentId: randomUUID(), amountThbMinor: encodeThb(100_00n) }] },
    });

    /*
     * The status refusal comes before the allocation check, which is why the bogus instalment
     * id above never matters: money must not land on a finished contract at all. Plan 7.8's
     * `terminal_holding_money` bucket is about money already accepted, not a licence to add.
     */
    expect(accepted.status).toBe(409);
    expect(accepted.body).toMatchObject({
      error: { details: { reason: 'order_not_accepting_slips', status: 'cancelled' } },
    });
    expect(await ledgerKinds(db, order.id)).toEqual([]);
  }, 60_000);

  /* ================================================================ *
   * ⓻ The signed upload handle
   * ================================================================ */

  it('refuses a handle minted for another order', async () => {
    const mine = await orderOf('handle-mine');
    const other = await orderOf('handle-other');

    const image = await uploadFor(other.id);

    const created = await call('POST', `/orders/${mine.id}/payment-slips`, {
      token: customer.token,
      body: {
        imageHandle: image.imageHandle,
        amountThbMinor: encodeThb(100_00n),
        transferredAt: new Date().toISOString(),
      },
    });

    /*
     * 🔒 Without this, a caller uploads against an order of their own, then presents the
     * handle on a slip attached to somebody else's order — or, if the key were unsigned,
     * names a stranger's slip image outright and reads it back through their own view grant.
     * Every check downstream would pass, because every check downstream is about the slip
     * they legitimately own.
     */
    expect(created.status).toBe(400);
    expect(created.body).toMatchObject({ error: { details: { reason: 'handle_order_mismatch' } } });
  }, 60_000);

  it('refuses a transfer time in the future', async () => {
    const order = await orderOf('future');
    const image = await uploadFor(order.id);

    const created = await call('POST', `/orders/${order.id}/payment-slips`, {
      token: customer.token,
      body: {
        imageHandle: image.imageHandle,
        amountThbMinor: encodeThb(100_00n),
        transferredAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
    });

    expect(created.status).toBe(422);
    expect(created.body).toMatchObject({
      error: { details: { reason: 'transfer_in_the_future' } },
    });
  }, 60_000);

  /* ================================================================ *
   * ⓼ Ownership — plan 7.4 trap 2
   * ================================================================ */

  it('answers 404, never 403, to a customer asking about somebody else’s slips', async () => {
    const order = await orderOf('owned');
    const slip = await createSlip(order.id, 100_00n);

    const listed = await call('GET', `/orders/${order.id}/payment-slips`, { token: stranger.token });
    expect(listed.status).toBe(404);

    const upload = await uploadImage(
      app.baseUrl,
      `/orders/${order.id}/payment-slips/image`,
      stranger.token,
      makePng(),
    );
    expect(upload.status).toBe(404);

    const grant = await call('POST', `/payments/slips/${slip.id}/image-grant`, {
      token: stranger.token,
      body: { purpose: 'view' },
    });
    expect(grant.status).toBe(404);
  }, 60_000);

  it('hides the staff columns from the customer’s own copy of their slip', async () => {
    const order = await orderOf('audience');
    const slip = await createSlip(order.id, 100_00n, reviewer);

    const mine = await call('GET', `/orders/${order.id}/payment-slips`, { token: customer.token });
    const staff = await call('GET', `/orders/${order.id}/payment-slips`, { token: reviewer.token });

    const customerCopy = (mine.body as SlipListWire).slips[0];
    const staffCopy = (staff.body as SlipListWire).slips[0];

    expect(customerCopy?.id).toBe(slip.id);
    expect(customerCopy?.submittedByUserId).toBeNull();
    expect(staffCopy?.submittedByUserId).toBe(reviewer.userId);
  }, 60_000);

  /* ================================================================ *
   * ⓽ The image: EXIF, short-lived grants, and erasure
   * ================================================================ */

  it('strips the GPS coordinates out of a slip photograph before storing it', async () => {
    const order = await orderOf('exif');

    /* A telephone photograph of a bank slip, with the location the telephone attached. */
    const photograph = jpegWithSegment(makeJpeg(), 0xe1, exifWithGps());
    const image = await uploadFor(order.id, customer, photograph);

    /*
     * Plan 7.6's PDPA line reaches this file: the picture of the transfer is the one upload
     * in the system most likely to carry somebody's home address as coordinates.
     */
    expect(image.stripped).toContain('Exif');
    expect(image.contentType).toBe('image/jpeg');
    expect(image.byteSize).toBeLessThan(photograph.byteLength);
  }, 60_000);

  it('serves the image only through a short-lived grant, and gates the bytes not the header', async () => {
    const order = await orderOf('grant');
    const slip = await createSlip(order.id, 100_00n);

    const minted = await call('POST', `/payments/slips/${slip.id}/image-grant`, {
      token: customer.token,
      body: { purpose: 'view' },
    });
    expect(minted.status, JSON.stringify(minted.body)).toBe(201);
    const grant = minted.body as SlipImageGrantWire;

    const served = await getRaw(app.baseUrl, grant.path);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(served.headers.get('content-disposition')).toBe('inline');
    /* Private data on an expiring URL: a shared cache holding it outlives the expiry. */
    expect(served.headers.get('cache-control')).toBe('private, no-store');
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');
    expect(served.bytes.byteLength).toBeGreaterThan(0);

    /* A tampered token is the same 404 as a slip that does not exist — never a 401 or 403. */
    const tampered = await getRaw(app.baseUrl, `${grant.path.slice(0, -2)}zz`);
    expect(tampered.status).toBe(404);

    /* The customer may download their own document. */
    const download = await call('POST', `/payments/slips/${slip.id}/image-grant`, {
      token: customer.token,
      body: { purpose: 'download' },
    });
    const attached = await getRaw(app.baseUrl, (download.body as SlipImageGrantWire).path);
    expect(attached.headers.get('content-disposition')).toBe(
      `attachment; filename="slip-${slip.id}.png"`,
    );

    /*
     * ⚠️ THE VIEW/DOWNLOAD SPLIT WAS DECORATIVE, AND PRETENDING OTHERWISE WAS WORSE THAN
     * NOT HAVING IT.
     *
     * This test used to assert that staff without `payments.verify` could mint a *view* grant
     * and not a *download* one. The red team took ten seconds over it: the view grant serves
     * identical bytes from `GET /payments/slip-images/:grant`, which is anonymous by design —
     * the grant is the credential. The only difference was `Content-Disposition: inline`
     * against `attachment`, so plan 7.6's PDPA control was right-click → Save As, or curl.
     *
     * So the permission now gates the bytes: staff need `payments.verify` to mint either
     * purpose, and `purpose` survives as what it always was, a rendering hint. A real split
     * needs the bytes to differ — a watermarked, downscaled render for viewing and the
     * original for download — which is a feature, not a permission.
     */
    for (const purpose of ['view', 'download'] as const) {
      const staffGrant = await call('POST', `/payments/slips/${slip.id}/image-grant`, {
        token: looker.token,
        body: { purpose },
      });
      expect(staffGrant.status, `${purpose}: ${JSON.stringify(staffGrant.body)}`).toBe(403);
      expect(staffGrant.body).toMatchObject({ error: { details: { purpose } } });
    }

    /* And a reviewer who does hold it gets both, because both are the same act. */
    for (const purpose of ['view', 'download'] as const) {
      const reviewerGrant = await call('POST', `/payments/slips/${slip.id}/image-grant`, {
        token: reviewer.token,
        body: { purpose },
      });
      expect(reviewerGrant.status, `${purpose}: ${JSON.stringify(reviewerGrant.body)}`).toBe(201);
    }
  }, 60_000);

  it('kills a live grant the moment the image is erased, and keeps the accounting row', async () => {
    const order = await orderOf('erase');
    const slip = await createSlip(order.id, 100_00n);

    const minted = await call('POST', `/payments/slips/${slip.id}/image-grant`, {
      token: customer.token,
      body: { purpose: 'view' },
    });
    const grant = (minted.body as SlipImageGrantWire).path;
    expect((await getRaw(app.baseUrl, grant)).status).toBe(200);

    const erased = await call('DELETE', `/payments/slips/${slip.id}/image`, { token: eraser.token });
    expect(erased.status, JSON.stringify(erased.body)).toBe(200);

    const after = erased.body as SlipWire;
    expect(after.hasImage).toBe(false);
    expect(after.imageErasedAt).not.toBeNull();
    /* The row survives: the amount and the four digits are what reconcile a statement. */
    expect(after.payerAccountLast4).toBe('4321');
    expect(after.bankReference).not.toBeNull();

    /*
     * The grant was minted before the erasure and has minutes left on its clock. It is dead
     * anyway, because the storage key is re-read from the row and compared with the signed
     * one — a token is never trusted for anything but its own signature.
     */
    expect((await getRaw(app.baseUrl, grant)).status).toBe(404);
  }, 60_000);

  /**
   * The same guard as the erasure test, isolated so that it has evidence of its own.
   *
   * In the erasure case the grant dies for two reasons at once — `storage_key` is null *and*
   * it no longer matches the signed one — so removing the comparison leaves that test green.
   * A green test with two mechanisms behind it is evidence for neither, so this one moves the
   * key to a *different* non-null value (allowed by `payment_slips_guard_write()` while the
   * slip is still `submitted`) and leaves only the comparison standing.
   */
  it('refuses a grant whose signed key is no longer the key on the row', async () => {
    const order = await orderOf('restale');
    const slip = await createSlip(order.id, 100_00n);

    const minted = await call('POST', `/payments/slips/${slip.id}/image-grant`, {
      token: customer.token,
      body: { purpose: 'view' },
    });
    const grant = (minted.body as SlipImageGrantWire).path;
    expect((await getRaw(app.baseUrl, grant)).status).toBe(200);

    /* A second upload against the same slip would land here — a different, still-present key. */
    const replacement = await uploadFor(order.id, customer, makeJpeg());
    expect(replacement.contentType).toBe('image/jpeg');

    await db.execute(sql`
      update payment_slips
         set storage_key = 'slips/' || ${order.id} || '/replaced.jpg'
       where id = ${slip.id}
    `);

    expect((await getRaw(app.baseUrl, grant)).status).toBe(404);
  }, 60_000);

  /**
   * A signed token whose subject is not a uuid is a 404, never a 500.
   *
   * Only this suite can produce one: the subject of every grant the application mints is a
   * `payment_slips.id`. Reaching into the running graph for the signing key and minting a
   * deliberately malformed token is the only way to ask what happens if that ever stops
   * being true — and the answer must not be a `uuid` column raising SQLSTATE 22P02 on the
   * one route in this feature anybody can reach. Same reasoning as the redteam suites' "a
   * hostile order id is a 404, never a 500".
   */
  it('answers 404 to a validly signed grant whose subject is not a uuid', async () => {
    const config = app.app.get<SlipStorageConfig>(SLIP_STORAGE_CONFIG);
    const { token } = mintImageGrant(
      {
        slipId: "not-a-uuid'; drop table payment_slips; --",
        storageKey: 'slips/whatever.png',
        audience: 'test',
        purpose: 'view',
      },
      config.grantKey,
      Date.now(),
    );

    expect((await getRaw(app.baseUrl, `/payments/slip-images/${token}`)).status).toBe(404);
  }, 60_000);

  /**
   * ⚠️ Unbounded writes to a bucket, closed by a default nobody has agreed.
   *
   * The upload route writes bytes and a principal may call it as many times as they like
   * against an order they own; nothing in the schema bounds it and the funnel throttle
   * covers only `POST /orders`. Twenty is generous for every honest case (one slip, or two
   * with a deposit, or four with a rejection and a re-transfer) and short of a bucket.
   */
  it('stops a customer filling the bucket with slips against one order', async () => {
    const order = await orderOf('flood');

    for (let n = 0; n < 20; n += 1) {
      /* Distinct bytes each time: the key is a content hash, so identical uploads would
       * converge on one object and prove nothing about the count of rows. */
      await createSlip(order.id, BigInt(100 + n));
    }

    const flooded = await uploadImage(
      app.baseUrl,
      `/orders/${order.id}/payment-slips/image`,
      customer.token,
      makePng(),
    );

    expect(flooded.status).toBe(409);
    expect(flooded.body).toMatchObject({ error: { details: { reason: 'too_many_slips', limit: 20 } } });
  }, 120_000);

  /* ================================================================ *
   * ⓾ Concurrency and the queue
   * ================================================================ */

  it('accepts a slip exactly once, however many times the button is pressed', async () => {
    const order = await orderOf('twice');
    if (order.money === null) throw new Error('a submitted order has money');

    const schedule = await writeThirtySeventy(db, app, order.id, minor(order.money.grandTotalThbMinor));
    const [depositInstalment] = await instalmentIds(db, order.id);
    const slip = await createSlip(order.id, schedule.depositThbMinor);

    const body = {
      allocations: [
        { instalmentId: depositInstalment, amountThbMinor: encodeThb(schedule.depositThbMinor) },
      ],
    };

    const first = await call('POST', `/payments/slips/${slip.id}/acceptance`, {
      token: reviewer.token,
      body,
    });
    const second = await call('POST', `/payments/slips/${slip.id}/acceptance`, {
      token: reviewer.token,
      body,
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ error: { details: { reason: 'slip_already_reviewed' } } });

    /* One acceptance, one ledger entry, one lot of money. */
    expect(await ledgerKinds(db, order.id)).toEqual(['slip_accepted']);
    expect((await folds(db, order.id)).cash).toBe(schedule.depositThbMinor);
  }, 60_000);

  it('shows a waiting slip in the queue with the bucket its order is in', async () => {
    const order = await orderOf('queue');
    if (order.money === null) throw new Error('a submitted order has money');

    const schedule = await writeThirtySeventy(db, app, order.id, minor(order.money.grandTotalThbMinor));
    const slip = await createSlip(order.id, schedule.depositThbMinor);

    const queued = await call('GET', '/payments/slips?limit=200', { token: reviewer.token });
    expect(queued.status, JSON.stringify(queued.body)).toBe(200);

    const entry = (queued.body as SlipQueueWire).entries.find((row) => row.slip.id === slip.id);
    expect(entry).toBeDefined();
    expect(entry?.orderStatus).toBe('awaiting_payment');
    /*
     * `order_payment_queue_bucket()` tests the terminal statuses on its FIRST line — plan
     * 7.8 — so an order that is cancelled while holding money never reports as waiting for a
     * customer to transfer. This one is genuinely waiting, and says so.
     */
    expect(entry?.queueBucket).toBe('awaiting_review');
  }, 60_000);

  /* ================================================================ *
   * ⓫ Which account received the money — task 13 fix round 1
   * ================================================================ */

  it('persists the account a customer names, and stores NULL when none is named', async () => {
    const order = await orderOf('account-persist');
    const accountId = await makeBankAccount(db, {
      bankCode: 'TEST',
      accountNumber: String(Date.now()),
      accountName: `slips test account ${tag}`,
      isActive: true,
    });

    /*
     * ⚠️ THE ASSERTION THIS PAIR EXISTS FOR — the coordinator's own words: "optional" is how
     * this regresses. A refactor that stopped passing the field through `createSlip` would
     * still return 201 and still pass every existing test; only reading the column back
     * proves the value actually reached the row rather than being silently dropped.
     */
    const named = await createSlip(order.id, 100_00n, customer, {
      receivedBankAccountId: accountId,
    });
    expect(await receivedAccountOf(db, named.id)).toBe(accountId);

    const unnamed = await createSlip(order.id, 100_00n);
    expect(await receivedAccountOf(db, unnamed.id)).toBeNull();
  }, 60_000);

  /*
   * F2 — the column above was write-only: persisted on every slip through the fix round 1
   * pair above, surfaced on no read path at all. This is that fix — the resolved bank code
   * and account name, not the raw id, reaching the wire the staff slip-review screen reads.
   */
  it('surfaces which account received the money on the wire, honestly when unnamed', async () => {
    const order = await orderOf('account-surface');
    const accountId = await makeBankAccount(db, {
      bankCode: 'TEST',
      accountNumber: String(Date.now() + 2),
      accountName: `slips surfaced account ${tag}`,
      isActive: true,
    });

    /*
     * `receivedBankAccount` is not audience-gated — it names one of the company's own
     * accounts, the same account the customer's own picker offered before this slip existed
     * — so the create response (the customer's audience) carries it too, not only the staff
     * screen this finding is about.
     */
    const named = await createSlip(order.id, 100_00n, customer, {
      receivedBankAccountId: accountId,
    });
    expect(named.receivedBankAccount).toEqual({
      bankCode: 'TEST',
      accountName: `slips surfaced account ${tag}`,
    });

    /* The staff slip-review screen — where reconciliation actually happens. */
    const namedReview = await call('GET', `/payments/slips/${named.id}`, { token: reviewer.token });
    expect(namedReview.status, JSON.stringify(namedReview.body)).toBe(200);
    expect((namedReview.body as SlipReviewWire).slip.receivedBankAccount).toEqual({
      bankCode: 'TEST',
      accountName: `slips surfaced account ${tag}`,
    });

    /*
     * An unnamed slip is not a blank the wire papers over with a guess — `receivedBankAccount`
     * is `null`, on the create response and on the review screen alike, so the dialog can say
     * so honestly instead of leaving the row empty.
     */
    const unnamed = await createSlip(order.id, 100_00n);
    expect(unnamed.receivedBankAccount).toBeNull();

    const unnamedReview = await call('GET', `/payments/slips/${unnamed.id}`, {
      token: reviewer.token,
    });
    expect(unnamedReview.status, JSON.stringify(unnamedReview.body)).toBe(200);
    expect((unnamedReview.body as SlipReviewWire).slip.receivedBankAccount).toBeNull();
  }, 60_000);

  it('refuses an account that is not active, and one that does not exist at all', async () => {
    const order = await orderOf('account-refuse');
    const retiredId = await makeBankAccount(db, {
      bankCode: 'TEST',
      accountNumber: String(Date.now() + 1),
      accountName: `slips retired account ${tag}`,
      isActive: false,
    });

    /*
     * ⚠️ The FK (`payment_slips_received_bank_account_id_bank_accounts_id_fk`) alone would
     * refuse only the second candidate — a uuid that names no row at all. It has nothing to
     * say about the first: the retired account genuinely exists, so a check that stopped at
     * "does this row exist" would let this one through. `assertKnownActiveAccount` is the
     * service-level check that closes the gap the FK leaves open, and this asserts both
     * halves land on the same refusal rather than one landing here and the other as an
     * unhandled foreign-key violation.
     */
    for (const candidate of [retiredId, randomUUID()]) {
      const image = await uploadFor(order.id);
      const refused = await call('POST', `/orders/${order.id}/payment-slips`, {
        token: customer.token,
        body: {
          imageHandle: image.imageHandle,
          amountThbMinor: encodeThb(100_00n),
          transferredAt: new Date().toISOString(),
          receivedBankAccountId: candidate,
        },
      });

      expect(refused.status, JSON.stringify(refused.body)).toBe(400);
      expect(refused.body).toMatchObject({
        error: { details: { reason: 'bank_account_not_recognised' } },
      });
    }

    /* And the slip never landed — a refused account name is not a partial slip. */
    const list = await call('GET', `/orders/${order.id}/payment-slips`, { token: customer.token });
    expect((list.body as SlipListWire).slips).toHaveLength(0);
  }, 60_000);
});
