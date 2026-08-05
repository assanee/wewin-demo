import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, createPool, type Database, type Pool } from '@wewin/db/client';
import { sql } from '@wewin/db/sql';
import { toBigInt } from '@wewin/contract/exact';
import type { OrderLineRequestWire, OrderWire } from '@wewin/contract/order';

import type {
  RefundDetailWire,
  RefundListWire,
} from '../../../src/payments/refunds/refunds.contract';
import {
  bootPaymentsApp,
  client,
  liveLine,
  makeActor,
  paymentsEnv,
  submittedOrder,
  type Actor,
  type Json,
  type PaymentsApp,
} from '../support/payments-app';
import {
  accountBalance,
  cancelWithScheduleClosed,
  dropForfeitPolicy,
  expectRejection,
  giveOrderHeldMoney,
  seedForfeitPolicy,
} from '../support/money-fixture';

/**
 * Money going back out — over real HTTP, against a real Postgres, with nothing stubbed.
 *
 * Every property this suite is about lives *between* the layers, which is why none of it is
 * asserted through a service call:
 *
 *   - the freeze on a refund's amount and payee is a BEFORE trigger, so a test that never issues
 *     an UPDATE never meets it;
 *   - the two-person rules are CHECKs on the row as well as refusals in the service, and only
 *     one of those two is reachable from a unit test;
 *   - every amount comes out of a SQL fold, and a mock has no fold.
 *
 * ── Where the numbers come from ─────────────────────────────────────────────────
 *
 * The order is priced by the application from the published catalogue through
 * `submit_for_payment`, which is the only path that pins `grand_total_thb_minor` and
 * `scheduled_deposit_thb_minor` — and the second of those is the ceiling on every forfeit here.
 * A fabricated order row would be a ceiling this suite chose rather than the one the contract
 * did, which is precisely the ฿5,530-versus-฿18,432 confusion plan 7.13 records.
 *
 * ⚠️ `SCHEDULED_DEPOSIT_BP_DEFAULT` is 10,000 bp today — plan 13's *"gate coverage = payment in
 * full"* default — so the pinned deposit equals the grand total and `least(held, obligation)`
 * cannot be told apart from `held` on these orders. The one test that *can* tell them apart is
 * marked below, and it produces the gap by paying in full against a smaller obligation written
 * directly onto the order, because no API can currently set a 30% deposit.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

const tag = randomUUID().slice(0, 8);

describeWithPg('refunds by ordinary bank transfer', () => {
  let pool: Pool;
  let db: Database;
  let app: PaymentsApp;
  let call: ReturnType<typeof client>;
  let line: OrderLineRequestWire;

  /** Three separate people, because two of the four rules in this phase are about that. */
  let customer: Actor;
  let requester: Actor;
  let approver: Actor;
  let disburser: Actor;
  /** Holds `payments.read` and nothing else: may look at the queue, may not move money. */
  let reader: Actor;
  /**
   * The person who accepted the slip, and deliberately none of the three above.
   *
   * `refunds_requester_did_not_take_the_money` (0014) refuses a refund requested by whoever
   * accepted the payment — the 5b red team's composed attack, which reached real cash with one
   * insider and one careless approval click. This fixture used to hand the reviewer's id to
   * `requester`, which is exactly the shape the rule forbids.
   */
  let slipReviewer: Actor;

  beforeAll(async () => {
    pool = createPool(url ?? '');
    db = createDatabase(pool);

    app = await bootPaymentsApp(paymentsEnv(url ?? ''));
    call = client(app.baseUrl);

    customer = await makeActor(db, app, `refund customer ${tag}`, []);
    requester = await makeActor(db, app, `refund requester ${tag}`, ['orders.refund', 'payments.read']);
    approver = await makeActor(db, app, `refund approver ${tag}`, ['orders.refund', 'payments.read']);
    disburser = await makeActor(db, app, `refund disburser ${tag}`, ['orders.refund', 'payments.read']);
    reader = await makeActor(db, app, `refund reader ${tag}`, ['payments.read']);
    /*
     * Deliberately the whole plausible "payments officer" bundle, `orders.refund` included:
     * nothing in RBAC forbids one group carrying both, and a test where the refusal could come
     * from a missing permission would say nothing about the separation-of-duties rule.
     */
    slipReviewer = await makeActor(db, app, `refund slip reviewer ${tag}`, [
      'payments.verify',
      'payments.read',
      'orders.read',
      'orders.write',
      'orders.refund',
    ]);

    line = await liveLine(call);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  /* ---------------------------------------------------------------- *
   * Helpers that speak the API
   * ---------------------------------------------------------------- */

  const orderHoldingMoney = async (
    who: string,
    options: {
      readonly fault?: 'customer' | 'company';
      readonly payerLast4?: string;
      /**
       * Overwrite the pinned deposit obligation **before** the cancellation.
       *
       * Before, not after: the forfeit is now priced in the cancellation's own transaction, so a
       * ceiling written afterwards would be a ceiling nothing ever read. No route can author a
       * 30% deposit in 5b — the authoring layer is 5c — so plan 7.8's worked example is produced
       * by writing the obligation the contract would have carried.
       */
      readonly pinnedDepositThbMinor?: bigint;
    } = {},
  ): Promise<{ readonly order: OrderWire; readonly grandTotal: bigint; readonly slipId: string }> => {
    const order = await submittedOrder(call, customer, line, {
      email: `refund-${who}-${tag}@probe.invalid`,
      name: `refund probe ${tag}`,
    });

    const grandTotal = toBigInt(order.grandTotalThbMinor ?? never());

    const held = await giveOrderHeldMoney(db, {
      orderId: order.id,
      grandTotalThbMinor: grandTotal,
      paidThbMinor: grandTotal,
      payerName: `สมชาย ใจดี ${tag}`,
      payerAccountLast4: options.payerLast4 ?? '4821',
      reviewerUserId: slipReviewer.userId,
    });

    if (options.pinnedDepositThbMinor !== undefined) {
      await db.execute(sql`
        update orders set scheduled_deposit_thb_minor = ${options.pinnedDepositThbMinor.toString()}::bigint
         where id = ${order.id}::uuid
      `);
    }

    /*
     * ⚠️ THROUGH THE REAL ROUTE, WHICH IS THE CLOSING ROUND'S POINT.
     *
     * This used to be `cancelWithScheduleClosed` — three raw statements — because
     * `POST /orders/:id/transitions/cancelled` genuinely could not cancel an order that had a
     * payment schedule: `assert_order_schedule` refuses a terminal order whose schedule is open,
     * the assertion is deferred, and 5a's handler closed nothing, so the request was a 409 at
     * COMMIT with no ordering of separate transactions that could fix it. That is now
     * `PaymentLifecycleService.onCancelled`, in the cancellation's own transaction, and the
     * fixture no longer has to impersonate a handler.
     *
     * It also means the **forfeit is already posted** by the time any test below asks for a
     * refund. That is the second half of the same fix: keeping part of a deposit is a
     * consequence of the customer walking away, not of somebody asking for the rest back.
     */
    const cancelled = await call('POST', `/orders/${order.id}/transitions/cancelled`, {
      token: customer.token,
      body: { reason: 'เปลี่ยนใจ' },
    });
    expect(cancelled.status).toBe(200);

    return { order, grandTotal, slipId: held.slipId };
  };

  const requestRefund = async (orderId: string, body: Record<string, unknown> = {}): Promise<Json> =>
    call('POST', '/payments/refunds', { token: requester.token, body: { orderId, ...body } });

  const decide = async (refundId: string, actor: Actor, body: Record<string, unknown>): Promise<Json> =>
    call('POST', `/payments/refunds/${refundId}/decision`, { token: actor.token, body });

  const disburse = async (refundId: string, actor: Actor, reference: string): Promise<Json> =>
    call('POST', `/payments/refunds/${refundId}/disbursement`, {
      token: actor.token,
      body: { disbursementReference: reference },
    });

  /* ================================================================ *
   * The happy path, and what it moves in the ledger
   * ================================================================ */

  it('accrues, approves and pays — and the cash leg is written only at the end', async () => {
    const { order, grandTotal } = await orderHoldingMoney('happy');

    const requested = await requestRefund(order.id);
    expect(requested.status, JSON.stringify(requested.body)).toBe(201);
    const detail = requested.body as RefundDetailWire;

    /* The amount is the obligation, and nobody typed it. */
    expect(detail.refund.amountThbMinor).toBe(grandTotal.toString());
    expect(detail.refund.status).toBe('requested');
    expect(detail.refund.payeeIsOriginalAccount).toBe('yes');

    /*
     * ⚠️ Accrual moves NO cash. `refund_payable` carries the promise; `bank_thb` is untouched
     * until somebody transfers. If these two assertions could both be satisfied at this point
     * by a single entry, approving a refund and paying it would be the same act and the
     * two-person separation below would be separating nothing.
     */
    expect(detail.money.refundPayableThbMinor).toBe(grandTotal.toString());
    expect(detail.money.cashThbMinor).toBe(grandTotal.toString());
    expect(detail.money.heldThbMinor).toBe('0');

    const approved = await decide(detail.refund.id, approver, { decision: 'approved' });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect((approved.body as RefundDetailWire).refund.approvedByUserId).toBe(approver.userId);
    /* Still a promise: approval does not move money either. */
    expect(await accountBalance(db, order.id, 'bank_thb')).toBe(grandTotal);

    const paid = await disburse(detail.refund.id, disburser, `TXN-${tag}-1`);
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);

    const final = paid.body as RefundDetailWire;
    expect(final.refund.status).toBe('disbursed');
    expect(final.refund.disbursedByUserId).toBe(disburser.userId);
    expect(final.refund.disbursementReference).toBe(`TXN-${tag}-1`);

    /* Now, and only now, the cash is gone — and every account is back to zero. */
    expect(await accountBalance(db, order.id, 'bank_thb')).toBe(0n);
    expect(await accountBalance(db, order.id, 'refund_payable')).toBe(0n);
    expect(await accountBalance(db, order.id, 'deposit_held')).toBe(0n);
  });

  /* A refund is NOT an order transition — plan 7.12, mirroring 7.3. */
  it('moves nothing on the order and writes nothing to the spine', async () => {
    const { order } = await orderHoldingMoney('not-a-transition');

    const before = await spine(db, order.id);
    const requested = await requestRefund(order.id);
    const refundId = (requested.body as RefundDetailWire).refund.id;
    await decide(refundId, approver, { decision: 'approved' });
    await disburse(refundId, disburser, `TXN-${tag}-2`);

    const after = await spine(db, order.id);
    expect(after).toEqual(before);
    expect(await statusOf(db, order.id)).toBe('cancelled');
  });

  /* ================================================================ *
   * The amount is derived, and it freezes
   * ================================================================ */

  /**
   * The sharpest finding of the design round, as an executable statement.
   *
   * Approve ฿3,594, then UPDATE the row to ฿359,400 and change the destination account, and the
   * approval approved nothing. Both halves are checked: the amount, and the payee — freezing only
   * the amount would leave the money going to a different bank account, which is the half a
   * reviewer is least likely to re-check.
   */
  it('freezes the amount and every payee column once it leaves `requested`', async () => {
    const { order } = await orderHoldingMoney('frozen');

    const requested = await requestRefund(order.id);
    const refund = (requested.body as RefundDetailWire).refund;
    await decide(refund.id, approver, { decision: 'approved' });

    await expect(
      db.execute(sql`
        update refunds set amount_thb_minor = amount_thb_minor * 100 where id = ${refund.id}::uuid
      `),
    ).rejects.toThrow();

    await expect(
      db.execute(sql`
        update refunds set payee_account_last4 = '9999', payee_name = 'somebody else'
         where id = ${refund.id}::uuid
      `),
    ).rejects.toThrow();

    const [row] = await rows<{ amount_thb_minor: string; payee_account_last4: string }>(
      db,
      sql`select amount_thb_minor::text, payee_account_last4 from refunds where id = ${refund.id}::uuid`,
    );

    expect(row?.amount_thb_minor).toBe(refund.amountThbMinor);
    expect(row?.payee_account_last4).toBe(refund.payeeAccountLast4);
  });

  it('has no way to name an amount in the request at all', async () => {
    const { order, grandTotal } = await orderHoldingMoney('no-amount');

    /* `z.strictObject` — an unknown key is a 400, not a silently stripped field. */
    const attempt = await requestRefund(order.id, { amountThbMinor: '999999999' });
    expect(attempt.status).toBe(400);

    const honest = await requestRefund(order.id);
    expect((honest.body as RefundDetailWire).refund.amountThbMinor).toBe(grandTotal.toString());
  });

  /* ================================================================ *
   * Two people, twice
   * ================================================================ */

  /**
   * 🔒 THE OUTBOUND HALF OF "MONEY IN AND MONEY OUT ARE DIFFERENT PEOPLE" — 5b red team, RT-3.
   *
   * The composed attack that reached real cash: one person with a plausible payments-officer
   * permission set opens a cart anonymously, uploads a slip for money that never moved, accepts
   * it themselves, cancels, requests the refund to their own account, gets one approval click
   * and disburses it. `bank_thb` nets to zero — the fake money in and the real money out cancel
   * exactly — so no per-order balance check could ever have caught it.
   *
   * The acceptance half cannot be closed for an anonymous submitter (0013 says so in those
   * words), so the chain is cut here, at the first step where an identity always exists.
   *
   * ⚠️ BOTH HALVES ARE ASSERTED SEPARATELY, because a test green through the *other* mechanism
   * is a test that lies: the service refusal is checked on its `details`, and the trigger is
   * checked by an INSERT with every service removed.
   */
  it('refuses a refund requested by whoever accepted the payment, in the service and on the row', async () => {
    const { order, slipId } = await orderHoldingMoney('requester-took-it');

    const bySelf = await call('POST', '/payments/refunds', {
      token: slipReviewer.token,
      body: { orderId: order.id },
    });
    expect(bySelf.status, JSON.stringify(bySelf.body)).toBe(403);
    expect(bodyDetails(bySelf)['reason']).toBe('requester_accepted_the_payment');
    /* The slip is named: a reviewer will not otherwise remember which decision is in the way. */
    expect(bodyDetails(bySelf)['slipId']).toBe(slipId);

    /* Nothing was written — not the refund, and not the accrual that precedes it. */
    const none = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from refunds where order_id = ${order.id}::uuid`,
    );
    expect(none.rows[0]?.n).toBe('0');

    /* And the row guard, with the service out of the picture entirely. */
    await expectRejection(
      db.execute(sql`
        insert into refunds (order_id, accrual_entry_id, amount_thb_minor, payee_name,
                             payee_bank_code, payee_account_last4, payee_is_original_account,
                             requested_by_user_id)
        select ${order.id}::uuid, e.id, 100::bigint, 'x', '014', '4821', 'yes',
               ${slipReviewer.userId}::uuid
          from ledger_entries e where e.order_id = ${order.id}::uuid limit 1
      `),
      /cannot request its refund/u,
    );

    /* A colleague still can. This is a separation of duties, not a wall around the order. */
    const byColleague = await requestRefund(order.id);
    expect(byColleague.status, JSON.stringify(byColleague.body)).toBe(201);
  });

  it('refuses the requester as approver, and the approver as disburser', async () => {
    const { order } = await orderHoldingMoney('two-people');

    const requested = await requestRefund(order.id);
    const refundId = (requested.body as RefundDetailWire).refund.id;

    const selfApproved = await decide(refundId, requester, { decision: 'approved' });
    expect(selfApproved.status).toBe(403);
    expect(bodyDetails(selfApproved)['reason']).toBe('approver_is_requester');

    const approved = await decide(refundId, approver, { decision: 'approved' });
    expect(approved.status).toBe(200);

    const selfDisbursed = await disburse(refundId, approver, `TXN-${tag}-3`);
    expect(selfDisbursed.status).toBe(403);
    expect(bodyDetails(selfDisbursed)['reason']).toBe('disburser_is_approver');

    /*
     * ⚠️ The requester MAY disburse, and that is a decision rather than an omission. With three
     * roles and possibly two employees, `disburser ≠ requester` is the rule that makes refunds
     * impossible — and plan 7.13 is explicit that a control everybody has to click past is worse
     * than no control. Two rules, not three, and this is where that is written down.
     */
    const paid = await disburse(refundId, requester, `TXN-${tag}-4`);
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
  });

  it('will not disburse a refund nobody approved', async () => {
    const { order } = await orderHoldingMoney('unapproved');
    const requested = await requestRefund(order.id);
    const refundId = (requested.body as RefundDetailWire).refund.id;

    const paid = await disburse(refundId, disburser, `TXN-${tag}-5`);
    expect(paid.status).toBe(409);
    expect(await accountBalance(db, order.id, 'refund_payable')).toBeLessThan(0n);
  });

  /* ================================================================ *
   * "Please send it to a different account"
   * ================================================================ */

  it('defaults to the account that paid, with nothing extra to approve', async () => {
    const { order } = await orderHoldingMoney('default-payee', { payerLast4: '4821' });

    const requested = await requestRefund(order.id);
    const detail = requested.body as RefundDetailWire;

    expect(detail.refund.payeeAccountLast4).toBe('4821');
    expect(detail.refund.payeeIsOriginalAccount).toBe('yes');
    expect(detail.matchedSlipId).not.toBeNull();

    /* No acknowledgement needed, because there is nothing unusual to acknowledge. */
    expect((await decide(detail.refund.id, approver, { decision: 'approved' })).status).toBe(200);
  });

  it('flags a different account, demands a reason, and demands a separate acknowledgement', async () => {
    const { order } = await orderHoldingMoney('different-payee', { payerLast4: '4821' });

    const noReason = await requestRefund(order.id, {
      payee: { name: 'someone else', bankCode: 'SCB', accountLast4: '7777' },
    });
    expect(noReason.status).toBe(422);
    expect(bodyDetails(noReason)['reason']).toBe('different_account_requires_reason');

    const requested = await requestRefund(order.id, {
      payee: { name: 'someone else', bankCode: 'SCB', accountLast4: '7777' },
      reasonTh: 'ลูกค้าปิดบัญชีเดิมแล้ว',
    });
    expect(requested.status, JSON.stringify(requested.body)).toBe(201);

    const detail = requested.body as RefundDetailWire;
    expect(detail.refund.payeeIsOriginalAccount).toBe('no');
    expect(detail.matchedSlipId).toBeNull();

    const unacknowledged = await decide(detail.refund.id, approver, { decision: 'approved' });
    expect(unacknowledged.status).toBe(422);
    expect(bodyDetails(unacknowledged)['reason']).toBe('different_account_requires_acknowledgement');

    const acknowledged = await decide(detail.refund.id, approver, {
      decision: 'approved',
      acknowledgeDifferentAccount: true,
    });
    expect(acknowledged.status).toBe(200);
  });

  /**
   * The half that makes the flag worth having: it cannot be set by the person it is about.
   *
   * A requester who names the account that actually paid gets `yes` — but the flag came from the
   * comparison, not from them, and there is no key in the request that reaches it.
   */
  it('derives the flag from the slips, and the request has no field for it', async () => {
    const { order } = await orderHoldingMoney('derived-flag', { payerLast4: '4821' });

    const lie = await requestRefund(order.id, {
      payee: { name: 'someone else', bankCode: 'SCB', accountLast4: '7777' },
      reasonTh: 'อ้างว่าเป็นบัญชีเดิม',
      payeeIsOriginalAccount: 'yes',
    });
    expect(lie.status).toBe(400);

    const honest = await requestRefund(order.id, {
      payee: { name: `  สมชาย   ใจดี ${tag} `, bankCode: 'KBANK', accountLast4: '4821' },
    });
    expect((honest.body as RefundDetailWire).refund.payeeIsOriginalAccount).toBe('yes');
  });

  it('lists every different-account refund as a report', async () => {
    const listed = await call('GET', '/payments/refunds?payee=different&status=approved', {
      token: reader.token,
    });

    expect(listed.status).toBe(200);
    const body = listed.body as RefundListWire;
    expect(body.refunds.length).toBeGreaterThanOrEqual(1);
    for (const refund of body.refunds) {
      expect(refund.payeeIsOriginalAccount).toBe('no');
    }
  });

  /* ================================================================ *
   * Rejection puts the money back
   * ================================================================ */

  /**
   * Without the reversing entry the accrual sits in `refund_payable` for ever: the queue shows a
   * debt the company has decided not to pay, the order's held balance stays understated by the
   * same amount, and a second refund request computes its amount from that understated balance.
   */
  it('reverses the accrual when a refund is refused, and a second request can then be made', async () => {
    const { order, grandTotal } = await orderHoldingMoney('rejected');

    const requested = await requestRefund(order.id);
    const refundId = (requested.body as RefundDetailWire).refund.id;

    const noReason = await decide(refundId, approver, { decision: 'rejected' });
    expect(noReason.status).toBe(422);
    /* The CHECK on the row gives 422 as well; the details are what tell the two apart. */
    expect(bodyDetails(noReason)['reason']).toBe('rejection_requires_note');

    const rejected = await decide(refundId, approver, {
      decision: 'rejected',
      noteTh: 'ยอดไม่ตรงกับสลิป',
    });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);

    expect(await accountBalance(db, order.id, 'refund_payable')).toBe(0n);
    const detail = rejected.body as RefundDetailWire;
    expect(detail.money.heldThbMinor).toBe(grandTotal.toString());

    const again = await requestRefund(order.id);
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect((again.body as RefundDetailWire).refund.amountThbMinor).toBe(grandTotal.toString());
  });

  it('refuses a second refund while one is still open', async () => {
    const { order } = await orderHoldingMoney('one-open');

    const first = await requestRefund(order.id);
    expect(first.status).toBe(201);
    const firstId = (first.body as RefundDetailWire).refund.id;

    const second = await requestRefund(order.id);
    expect(second.status).toBe(409);

    /*
     * ⚠️ Which guard answered, again — and this one was found by mutation rather than by reading.
     *
     * Deleting the open-refund check leaves the second request 409ing anyway: the first accrual
     * has already debited `deposit_held`, so `held <= 0` refuses it one guard later. The status
     * code alone is therefore green with the guard removed. Only the open refund's *id* is
     * evidence that the request was refused for the right reason — and the right reason matters,
     * because the fallback stops working the moment the accrual is not the whole balance.
     */
    expect(bodyDetails(second)['refundId']).toBe(firstId);
  });

  /* ================================================================ *
   * The forfeit
   * ================================================================ */

  /**
   * ⚠️ WITH A NON-ZERO POLICY, BECAUSE 0 bp PROVES NOTHING.
   *
   * The shipped policy forfeits nothing in every cell, so every assertion about the forfeit
   * arithmetic against it is `0 === 0` and stays green with the multiplication, the `least()`,
   * the clamp and the fault lookup all deleted. This block publishes a policy with a real rate
   * so the numbers can move — and publishing one is itself the evidence for the finding recorded
   * in `RefundsRepository.effectiveForfeitPolicy`: nothing pins a policy to an order, so a policy
   * published between the contract and the cancellation changes what that customer gets back.
   */
  describe('with a policy that actually forfeits', () => {
    let policyId: string;

    beforeAll(async () => {
      policyId = await seedForfeitPolicy(db, {
        code: `probe_${tag}`.slice(0, 40),
        customerFaultBp: 5_000,
      });
    });

    afterAll(async () => {
      await dropForfeitPolicy(db, policyId);
    });

    it('keeps half and refunds the rest, and both legs are in the ledger', async () => {
      const { order, grandTotal } = await orderHoldingMoney('forfeit-half');

      const requested = await requestRefund(order.id);
      expect(requested.status, JSON.stringify(requested.body)).toBe(201);

      const detail = requested.body as RefundDetailWire;
      /* `awaiting_payment` × `customer` = 5,000 bp of min(held, pinned deposit). */
      const expectedForfeit = (grandTotal * 5_000n + 5_000n) / 10_000n;

      expect(detail.money.forfeitedThbMinor).toBe(expectedForfeit.toString());
      expect(detail.refund.amountThbMinor).toBe((grandTotal - expectedForfeit).toString());
      expect(await accountBalance(db, order.id, 'forfeited')).toBe(-expectedForfeit);
    });

    /**
     * ⚠️ THE ฿5,530-VERSUS-฿18,432 CASE — plan 7.8's worked example.
     *
     * A customer who pays the whole contract up front and then cancels must not lose a forfeit
     * computed on everything they happened to send: the ceiling is the deposit they *agreed to*.
     * The pinned obligation is written down here rather than produced through the API because
     * `SCHEDULED_DEPOSIT_BP_DEFAULT` is 10,000 bp and no route can currently set a 30% deposit —
     * which is the instalments module's to provide. Bounding by cash instead of by the obligation
     * makes this test fail by a factor of more than three.
     */
    it('bounds the forfeit by the pinned deposit, not by the cash that happened to arrive', async () => {
      const grandTotalGuess = toBigInt((await submittedOrder(call, customer, line, {
        email: `refund-ceiling-probe-${tag}@probe.invalid`,
        name: `refund probe ${tag}`,
      })).grandTotalThbMinor ?? never());

      const obligation = (grandTotalGuess * 3_000n) / 10_000n;
      const { order, grandTotal } = await orderHoldingMoney('forfeit-ceiling', {
        pinnedDepositThbMinor: obligation,
      });
      expect(grandTotal).toBe(grandTotalGuess);

      const requested = await requestRefund(order.id);
      const detail = requested.body as RefundDetailWire;

      const expectedForfeit = (obligation * 5_000n + 5_000n) / 10_000n;
      expect(detail.money.forfeitedThbMinor).toBe(expectedForfeit.toString());
      expect(detail.refund.amountThbMinor).toBe((grandTotal - expectedForfeit).toString());

      /* And the ceiling really bit: forfeiting on cash would have kept more than three times as much. */
      const ifBoundedByCash = (grandTotal * 5_000n + 5_000n) / 10_000n;
      expect(expectedForfeit).toBeLessThan(ifBoundedByCash);
    });

    /**
     * 🔒 `fault` decides the money, and it comes from the spine.
     *
     * The same order, the same policy, the same request body — and a `cancelled` event recorded
     * with `fault: 'company'` forfeits nothing, because the company's own mistake is never the
     * customer's cost. Nothing in the request could have produced this difference.
     */
    it('reads `fault` from the cancellation event, and a company-fault cancellation forfeits nothing', async () => {
      const order = await submittedOrder(call, customer, line, {
        email: `refund-company-fault-${tag}@probe.invalid`,
        name: `refund probe ${tag}`,
      });
      const grandTotal = toBigInt(order.grandTotalThbMinor ?? never());

      await giveOrderHeldMoney(db, {
        orderId: order.id,
        grandTotalThbMinor: grandTotal,
        paidThbMinor: grandTotal,
        payerName: `สมชาย ใจดี ${tag}`,
        payerAccountLast4: '4821',
        reviewerUserId: slipReviewer.userId,
      });

      /* A post-freeze cancellation is the only one that may carry `fault` — see 0007's table. */
      await moveTo(db, order.id, 'production_confirmed', 'payment_confirmed', 'staff', requester.userId);
      await moveTo(db, order.id, 'in_production', 'production_started', 'staff', requester.userId);
      await cancelWithScheduleClosed(db, {
        orderId: order.id,
        fromStatus: 'in_production',
        actorKind: 'staff',
        actorUserId: requester.userId,
        reasonTh: 'โรงงานทำไม่ได้',
        fault: 'company',
      });

      const requested = await requestRefund(order.id);
      expect(requested.status, JSON.stringify(requested.body)).toBe(201);

      const detail = requested.body as RefundDetailWire;
      expect(detail.money.forfeitedThbMinor).toBe('0');
      expect(detail.refund.amountThbMinor).toBe(grandTotal.toString());
    });

    /*
     * The pre-freeze default. A cancellation from `awaiting_payment` carries no `fault` key at
     * all, and the absence must read as `customer` — the direction matters, because `company` is
     * the value that forfeits nothing.
     */
    it('treats a cancellation with no `fault` on the spine as the customer’s', async () => {
      const { order, grandTotal } = await orderHoldingMoney('no-fault-key');

      const requested = await requestRefund(order.id);
      const detail = requested.body as RefundDetailWire;

      expect(detail.money.forfeitedThbMinor).not.toBe('0');
      expect(detail.refund.amountThbMinor).not.toBe(grandTotal.toString());
    });
  });

  /* ================================================================ *
   * What refunds refuse to do at all
   * ================================================================ */

  it('refuses a live order — refunds are for cancellations, and 5c owns over-payment', async () => {
    const order = await submittedOrder(call, customer, line, {
      email: `refund-live-${tag}@probe.invalid`,
      name: `refund probe ${tag}`,
    });
    const grandTotal = toBigInt(order.grandTotalThbMinor ?? never());

    await giveOrderHeldMoney(db, {
      orderId: order.id,
      grandTotalThbMinor: grandTotal,
      paidThbMinor: grandTotal,
      payerName: `สมชาย ใจดี ${tag}`,
      payerAccountLast4: '4821',
      reviewerUserId: slipReviewer.userId,
    });

    const requested = await requestRefund(order.id);
    expect(requested.status).toBe(409);
    /*
     * The `details` and not only the code. Without the status check the request still 409s —
     * `cancellationOnSpine` finds no `cancelled` event a moment later — so a test that read the
     * status alone would be green with the guard deleted, and would be reporting the *second*
     * guard's answer as though it were the first's.
     */
    expect(bodyDetails(requested)['status']).toBe('awaiting_payment');
  });

  it('refuses an order that holds nothing', async () => {
    const order = await submittedOrder(call, customer, line, {
      email: `refund-empty-${tag}@probe.invalid`,
      name: `refund probe ${tag}`,
    });

    await cancelWithScheduleClosed(db, {
      orderId: order.id,
      fromStatus: 'awaiting_payment',
      actorKind: 'customer',
      actorUserId: customer.userId,
      reasonTh: 'เปลี่ยนใจ',
    });

    const requested = await requestRefund(order.id);
    expect(requested.status).toBe(409);

    /*
     * ⚠️ Asserting WHICH guard answered, and that is the point rather than pedantry.
     *
     * `refundable <= 0` two statements later refuses the same request with the same code and the
     * same `heldThbMinor`, so a test that read either would be green with this guard deleted —
     * reporting the second mechanism's answer as though it were the first's. The second guard's
     * message also carries `forfeitThbMinor`; its absence is what distinguishes them. The
     * distinction is worth keeping because reaching the second guard means the forfeit was
     * computed, and `order_forfeit_thb_minor()` raises on a missing policy cell — so an order
     * holding nothing would be able to produce a policy error.
     */
    expect(bodyDetails(requested)['heldThbMinor']).toBe('0');
    expect(bodyDetails(requested)).not.toHaveProperty('forfeitThbMinor');
  });

  /**
   * There is nowhere to send it, so nothing is sent — plan 7.12's default has no fallback.
   *
   * PDPA erasure may clear a slip's payer columns and a staff-entered slip may never have had
   * them, so "no account on record" is a real state. Defaulting to whatever the customer types
   * next is the fraud path with the control removed, and it is the shape the feature takes if
   * nobody decides otherwise, because a missing account reads like a missing default.
   */
  it('refuses to invent a destination when no accepted slip names an account', async () => {
    const order = await submittedOrder(call, customer, line, {
      email: `refund-no-payee-${tag}@probe.invalid`,
      name: `refund probe ${tag}`,
    });
    const grandTotal = toBigInt(order.grandTotalThbMinor ?? never());

    await giveOrderHeldMoney(db, {
      orderId: order.id,
      grandTotalThbMinor: grandTotal,
      paidThbMinor: grandTotal,
      payerName: null,
      payerAccountLast4: null,
      reviewerUserId: slipReviewer.userId,
    });

    await cancelWithScheduleClosed(db, {
      orderId: order.id,
      fromStatus: 'awaiting_payment',
      actorKind: 'customer',
      actorUserId: customer.userId,
      reasonTh: 'เปลี่ยนใจ',
    });

    const requested = await requestRefund(order.id);
    expect(requested.status).toBe(409);
    expect(bodyDetails(requested)['reason']).toBe('no_payer_on_record');

    /* And an explicitly named account is allowed — flagged, with a reason, as any other would be. */
    const named = await requestRefund(order.id, {
      payee: { name: 'สมชาย ใจดี', bankCode: 'SCB', accountLast4: '1234' },
      reasonTh: 'สลิปไม่มีชื่อบัญชีผู้โอน',
    });
    expect(named.status, JSON.stringify(named.body)).toBe(201);
    expect((named.body as RefundDetailWire).refund.payeeIsOriginalAccount).toBe('no');
  });

  /**
   * Plan 7.11: money that has not landed cannot be paid back out.
   *
   * An accepted slip for a cross-border wire sits in `remittance_in_transit` for one to two
   * working days. Refunding in that window is the company's own cash going out against money it
   * has not received — and the customer's transfer may still fail.
   */
  it('will not pay a refund while a remittance is still in transit', async () => {
    const order = await submittedOrder(call, customer, line, {
      email: `refund-transit-${tag}@probe.invalid`,
      name: `refund probe ${tag}`,
    });
    const grandTotal = toBigInt(order.grandTotalThbMinor ?? never());

    await giveOrderHeldMoney(db, {
      orderId: order.id,
      grandTotalThbMinor: grandTotal,
      paidThbMinor: grandTotal,
      payerName: `สมชาย ใจดี ${tag}`,
      payerAccountLast4: '4821',
      reviewerUserId: slipReviewer.userId,
      landed: false,
    });

    await cancelWithScheduleClosed(db, {
      orderId: order.id,
      fromStatus: 'awaiting_payment',
      actorKind: 'customer',
      actorUserId: customer.userId,
      reasonTh: 'เปลี่ยนใจ',
    });

    const requested = await requestRefund(order.id);
    expect(requested.status).toBe(201);
    const refundId = (requested.body as RefundDetailWire).refund.id;

    expect((await decide(refundId, approver, { decision: 'approved' })).status).toBe(200);

    const paid = await disburse(refundId, disburser, `TXN-${tag}-transit`);
    expect(paid.status).toBe(409);
    /*
     * The amount, which only the pre-check knows. `refunds_guard_write()` refuses this too and is
     * the guarantee, but its answer is the generic `payment_state_changed` — so asserting the
     * status alone would be green with the pre-check deleted and would be reporting the trigger's
     * refusal as though it were the service's. Defence in depth is only visible if the layers
     * are told apart.
     */
    expect(bodyDetails(paid)['remittanceInTransitThbMinor']).toBe(grandTotal.toString());
    expect(await accountBalance(db, order.id, 'bank_thb')).toBe(0n);
  });

  /**
   * ⚠️ NO POLICY MEANS NO CONTRACT — fail closed and loudly, exactly as the SQL does.
   *
   * `order_forfeit_thb_minor()` raises rather than returning zero when a (status × fault) cell is
   * missing, and this is the same rule one level up for a missing *policy*. Silence would be a
   * policy nobody wrote being applied to somebody's money — in the customer's favour today, and
   * in nobody's favour the day the table is half filled.
   *
   * ⚠️ AND IT MOVED, WHICH IS THE POINT. The refusal used to be at the *refund*, which is far too
   * late: the money had already been taken under terms nobody could name. Since
   * `0012_payment_closure.sql` the policy is pinned onto the order at submit (plan 7.13's seventh
   * pin), so the moment there is nothing to pin is the moment to stop — before anybody transfers
   * anything.
   *
   * The window in which no policy is effective is a few milliseconds and is restored in a
   * `finally`. It is the only way to reach the branch: the migrations seed `plan13_default` and
   * every other test in this file depends on it being there.
   */
  it('refuses to accept a contract at all when no forfeit policy is effective', async () => {
    const suspended = await rows<{ id: string }>(
      db,
      sql`select id from forfeit_policies where effective_from is not null`,
    );

    try {
      await db.execute(sql`update forfeit_policies set effective_from = null`);

      const created = await call('POST', '/orders', { token: customer.token, body: {} });
      expect(created.status, JSON.stringify(created.body)).toBe(201);

      const draft = created.body as OrderWire;
      const submitted = await call('POST', `/orders/${draft.id}/transitions/awaiting_payment`, {
        token: customer.token,
        body: {
          lines: [line],
          contact: { email: `refund-no-policy-${tag}@probe.invalid`, name: `refund probe ${tag}` },
        },
      });

      expect(submitted.status).toBe(409);
      expect(bodyDetails(submitted)['reason']).toBe('no_effective_forfeit_policy');
    } finally {
      for (const policy of suspended) {
        await db.execute(
          sql`update forfeit_policies set effective_from = now() where id = ${policy.id}::uuid`,
        );
      }
    }

    /* And with the policy back, the same order submits — so the refusal was about the policy. */
    const { order } = await orderHoldingMoney('policy-restored');
    const afterwards = await requestRefund(order.id);
    expect(afterwards.status, JSON.stringify(afterwards.body)).toBe(201);
  });

  /* ================================================================ *
   * Who may look, and who may act
   * ================================================================ */

  it('separates looking at the queue from moving money', async () => {
    const listed = await call('GET', '/payments/refunds', { token: reader.token });
    expect(listed.status).toBe(200);

    const body = listed.body as RefundListWire;
    /* Defaults to `approved` — the promises, which is what a payable queue is for. */
    for (const refund of body.refunds) expect(refund.status).toBe('approved');
    expect(BigInt(body.payableTotalThbMinor)).toBeGreaterThanOrEqual(0n);

    const { order } = await orderHoldingMoney('reader-cannot-act');
    const attempted = await call('POST', '/payments/refunds', {
      token: reader.token,
      body: { orderId: order.id },
    });
    expect(attempted.status).toBe(403);
  });

  it('tells the customer nothing about anybody’s refund', async () => {
    const listed = await call('GET', '/payments/refunds', { token: customer.token });
    expect(listed.status).toBe(403);
  });

  it('answers 404 for an id that is not a uuid, rather than a 500 from the driver', async () => {
    const answer = await call('GET', '/payments/refunds/not-a-uuid', { token: reader.token });
    expect(answer.status).toBe(404);
  });

  /* ================================================================ *
   * ⚠️ A cross-module finding, pinned so it cannot be forgotten
   * ================================================================ */

  /**
   * ✅ THE ONE THIS SUITE USED TO PIN THE OTHER WAY UP.
   *
   * It read: *"the 5a cancellation route cannot cancel an order that has a payment schedule"*, and
   * it was true. `assert_order_schedule()` refuses a `cancelled` order whose
   * `order_payment_schedules.closed_at` is null — plan 7.5(ก) requires that exemption or
   * cancellation-after-deposit is unrepresentable — the assertion is DEFERRED, and 5a's handler
   * closed nothing. Both orderings failed, so there was no sequence of separate transactions that
   * could cancel an order which had taken a deposit: the money sat on a live order for ever and
   * refunds were unreachable in production.
   *
   * The fix was the one UPDATE this test predicted, inside the cancellation's own transaction
   * (`PaymentLifecycleService.onCancelled`). The assertion is inverted here rather than deleted,
   * because the interesting claim is not that cancelling works — it is that cancelling *closes the
   * schedule*, and a future refactor that moved the close back out would leave the 409 exactly
   * where it was.
   */
  it('cancels an order that has taken a deposit, and closes its schedule in the same transaction', async () => {
    const order = await submittedOrder(call, customer, line, {
      email: `refund-cancel-gap-${tag}@probe.invalid`,
      name: `refund probe ${tag}`,
    });
    const grandTotal = toBigInt(order.grandTotalThbMinor ?? never());

    await giveOrderHeldMoney(db, {
      orderId: order.id,
      grandTotalThbMinor: grandTotal,
      paidThbMinor: grandTotal,
      payerName: `สมชาย ใจดี ${tag}`,
      payerAccountLast4: '4821',
      reviewerUserId: slipReviewer.userId,
    });

    const cancelled = await call('POST', `/orders/${order.id}/transitions/cancelled`, {
      token: customer.token,
      body: { reason: 'เปลี่ยนใจ' },
    });

    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(await statusOf(db, order.id)).toBe('cancelled');

    const [schedule] = await rows<{ closed_reason: string | null }>(
      db,
      sql`select closed_reason from order_payment_schedules where order_id = ${order.id}::uuid`,
    );
    expect(schedule?.closed_reason).toBe('cancelled');

    /* And the money is still there to be refunded — 0 bp under the shipped default policy. */
    expect(await accountBalance(db, order.id, 'deposit_held')).toBe(-grandTotal);
  });
});

/* ------------------------------------------------------------------------- *
 * Small readers
 * ------------------------------------------------------------------------- */

async function rows<T>(db: Database, statement: ReturnType<typeof sql>): Promise<readonly T[]> {
  const result = await db.execute(statement);
  const value = (result as { rows?: unknown }).rows;
  return Array.isArray(value) ? (value as T[]) : [];
}

async function spine(db: Database, orderId: string): Promise<readonly string[]> {
  const found = await rows<{ event_type: string; seq: number }>(
    db,
    sql`select event_type, seq from order_events where order_id = ${orderId}::uuid order by seq`,
  );
  return found.map((row) => `${row.seq}:${row.event_type}`);
}

async function statusOf(db: Database, orderId: string): Promise<string> {
  const [row] = await rows<{ status: string }>(
    db,
    sql`select status from orders where id = ${orderId}::uuid`,
  );
  return row?.status ?? 'missing';
}

/** Move an order through a legal transition, event first, exactly as the lifecycle does. */
async function moveTo(
  db: Database,
  orderId: string,
  toStatus: string,
  eventType: string,
  actorKind: string,
  actorUserId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const eventId = randomUUID();
    const [current] = await rows<{ status: string }>(
      tx as unknown as Database,
      sql`select status from orders where id = ${orderId}::uuid`,
    );

    await tx.execute(sql`
      insert into order_events
        (id, order_id, event_type, from_status, to_status, actor_kind, actor_user_id, payload)
      values (${eventId}::uuid, ${orderId}::uuid, ${eventType}, ${current?.status ?? ''},
              ${toStatus}, ${actorKind}, ${actorUserId}::uuid, '{}'::jsonb)
    `);

    await tx.execute(sql`
      update orders set status = ${toStatus}, status_event_id = ${eventId}::uuid
       where id = ${orderId}::uuid
    `);
  });
}

function bodyDetails(answer: Json): Record<string, unknown> {
  const body = answer.body;
  if (typeof body !== 'object' || body === null || !('error' in body)) return {};
  const error = (body as { error: unknown }).error;
  if (typeof error !== 'object' || error === null || !('details' in error)) return {};
  const details = (error as { details: unknown }).details;
  return typeof details === 'object' && details !== null ? (details as Record<string, unknown>) : {};
}

function never(): never {
  throw new Error('a submitted order has a grand total');
}
