import { Injectable } from '@nestjs/common';
import type { RefundStatus } from '@wewin/db/schema';

import { AppError } from '../../common/errors/app-error';
import type { Scope } from '../../rbac';
import { LedgerRepository, LedgerService, type LedgerTx } from '../ledger';
import { deriveOriginalAccount, type DerivedPayee } from './payee';
import { RefundsRepository, type RefundRow } from './refunds.repository';
import type {
  CreateRefundWire,
  DecideRefundWire,
  DisburseRefundWire,
  RefundDetailWire,
  RefundListWire,
  RefundQuery,
  RefundWire,
} from './refunds.contract';

/**
 * Money going back out, held to the same standard of evidence as money coming in.
 *
 * ── The shape of every mutation, and why it is always this shape ─────────────────
 *
 *     transaction
 *       → lock the row this is about                    ← two reviewers, one button
 *       → read the facts from where they were recorded  ← the spine, the slips, the ledger
 *       → refuse, with a sentence naming the amounts
 *       → post the ledger entry
 *       → move the refund's status
 *
 * The ledger before the status, every time, and it is not arbitrary. `refunds_match_accrual` is
 * a deferred constraint trigger comparing the row's amount against what its accrual entry put
 * into `refund_payable`, so the entry has to exist for the row to be legal; and on the way out,
 * a status that said `disbursed` before the cash leg was written would be a window — however
 * short — in which the company had told itself it had paid and had not.
 *
 * ── Four rules, and each one is a specific attack ────────────────────────────────
 *
 *   the amount is derived        `held − forfeit`, computed by Postgres, written to the ledger
 *                                and to the row in one transaction. Nothing in `CreateRefundWire`
 *                                names a figure, so "approve ฿3,594, disburse ฿359,400" has no
 *                                first step.
 *   the amount and payee freeze  the moment the status leaves `requested`
 *                                (`refunds_guard_write()`), and this service never issues an
 *                                UPDATE that could carry them.
 *   approver ≠ requester,        CHECKed on the row and refused here first, so the answer is a
 *   disburser ≠ approver         sentence rather than a 409 from a trigger.
 *   the payee is derived         from the accepted slips, not from a flag in the body — see
 *                                `payee.ts`.
 *
 * ── A refund is NOT an order transition ──────────────────────────────────────────
 *
 * Plan 7.12, mirroring 7.3. Nothing in this file writes `orders.status`, appends to
 * `order_events`, or calls anything that does. An order that has been cancelled and refunded is
 * `cancelled`; the refund is a fact about money, and the queue is where it is visible. That is
 * also why there is no notification here: notifications are consumers of `order_events` (plan
 * 10.1) and this module writes none, so **a customer is currently told nothing when their
 * refund is approved or paid.** That is a gap and it is reported, not papered over with a
 * `sendEmail` in a service.
 *
 * ── ⚠️ Two things this module cannot do, stated rather than worked around ────────
 *
 * 1. **It cannot pin the forfeit policy.** Plan 7.13 wants `forfeit_policy` pinned onto the
 *    order at submit and there is no column; see `RefundsRepository.effectiveForfeitPolicy`.
 *    The rate applied is written into the forfeit entry's memo, which is append-only.
 *
 * 2. **The separate approval for a different account is an explicit acknowledgement, not a
 *    separate permission.** `rbac/permissions.ts` is not this agent's file, and the right
 *    long-term answer is a code of its own — `payments.refund_other_account` — held by fewer
 *    people than `orders.refund`. What is here instead: the approver must send
 *    `acknowledgeDifferentAccount: true`, which cannot be sent by the click that approves an
 *    ordinary refund, and every such refund is listed by `?payee=different`.
 */
@Injectable()
export class RefundsService {
  constructor(
    private readonly repository: RefundsRepository,
    private readonly ledger: LedgerService,
    private readonly ledgerRepository: LedgerRepository,
  ) {}

  /* ---------------------------------------------------------------- *
   * Requesting — where the amount comes from
   * ---------------------------------------------------------------- */

  /**
   * Turn money held on a cancelled order into a recorded obligation and a request to pay it.
   *
   * The arithmetic, in the order it happens and with the reason for each step:
   *
   *   held      = `order_held_thb_minor()` — the `deposit_held` fold, NOT cash. Plan 7.8's ⚠️:
   *               a revision order carrying its ancestor's money has no cash leg and never
   *               will, so branching on cash answers "have we been paid?" wrongly and answers
   *               it consistently, which is worse.
   *   refund    = held, in full.
   *
   * The forfeit has already happened. It is priced by `order_forfeit_thb_minor()` —
   * `least(held, scheduled_deposit) × bp`, clamped — and posted in the **cancellation's** own
   * transaction (`PaymentLifecycleService.onCancelled`), because keeping part of a deposit is a
   * consequence of the customer walking away and not of the company being asked for the rest
   * back. Bounding by the *pinned obligation* and not by the cash that happened to arrive is
   * the difference between keeping ฿5,530 and keeping ฿18,432 from a customer who paid in full
   * up front (plan 7.8's worked example).
   *
   * So `held` here is already net of whatever was kept, and there is nothing left for this
   * method to decide about it.
   */
  async request(scope: Scope, body: CreateRefundWire): Promise<RefundDetailWire> {
    const requesterUserId = staffUserId(scope);

    return this.repository.transaction(async (tx) => {
      const order = await this.repository.lockOrder(tx, body.orderId);
      if (!order) throw AppError.notFound('ไม่พบออร์เดอร์นี้');

      /*
       * `cancelled` only, and `superseded` deliberately not.
       *
       * Money on a superseded order is *carried* to its revision as an allocation pointing back
       * at the ancestor's slip (plan 7.8) — it is not given back, and refunding it here would
       * pay out money the revision is still counting on. A superseded order that is still
       * holding money after the carry is a reconciliation exception, and it is visible:
       * `order_payment_queue_bucket()` puts it in `terminal_holding_money` too.
       */
      if (order.status !== 'cancelled') {
        throw AppError.conflict(
          'คืนเงินได้เฉพาะออร์เดอร์ที่ถูกยกเลิกแล้วเท่านั้น — เงินของออร์เดอร์ที่ออกใบใหม่แทนจะถูกยกไปยังใบใหม่ ไม่ใช่คืน',
          { status: order.status },
        );
      }

      const open = await this.repository.openRefundId(tx, order.id);
      if (open !== undefined) {
        throw AppError.conflict('ออร์เดอร์นี้มีคำขอคืนเงินที่ยังไม่จบอยู่แล้ว', { refundId: open });
      }

      /*
       * 🔒 WHOEVER SAID THE MONEY ARRIVED DOES NOT GET TO ASK FOR IT BACK — 5b red team, RT-3.
       *
       * The composed attack the red team walked to real cash: one person with a plausible
       * "payments officer" permission set opens a cart anonymously, uploads a slip for money
       * that never moved, accepts it themselves — attesting their own account as the payer —
       * cancels the order, requests the refund to that account, gets one approval click from
       * somebody who has no reason to look, and disburses it. `bank_thb` nets to zero, because
       * the fake money in and the real money out cancel exactly.
       *
       * 0013 closed the acceptance half for the ordinary funnel and said out loud what nothing
       * identity-based can close: a reviewer who never claims the guest session is two
       * identities and always will be. So the rule moves to the leg where an identity always
       * exists. It is the same sentence as "the reviewer is not the submitter", pointed the
       * other way, and it costs no new approval point — plan 7.13's warning — because it
       * constrains who may take an existing step rather than adding one.
       *
       * `refunds_requester_did_not_take_the_money` holds it on the row as well. Neither is
       * redundant: that one covers a second writer nobody has written yet, this one names the
       * slip. 403 rather than 409 — it is not a race, it is this person.
       */
      const ownSlipId = await this.repository.acceptedSlipReviewedBy(tx, order.id, requesterUserId);
      if (ownSlipId !== undefined) {
        throw new AppError(
          'FORBIDDEN',
          403,
          'ผู้ที่ตรวจรับสลิปของออร์เดอร์นี้ขอคืนเงินเองไม่ได้ — เงินเข้าและเงินออกต้องเป็นคนละคน',
          { reason: 'requester_accepted_the_payment', slipId: ownSlipId },
        );
      }

      /* 🔒 `fault` from the spine. There is no parameter on this method that could supply it. */
      const cancellation = await this.repository.cancellationOnSpine(tx, order.id);
      if (!cancellation) {
        throw AppError.conflict(
          'ออร์เดอร์นี้ถูกยกเลิกโดยไม่มีเหตุการณ์การยกเลิกบันทึกไว้ — คิดยอดริบไม่ได้',
          { reason: 'no_cancellation_event' },
        );
      }

      /*
       * ⚠️ THE FORFEIT IS NOT COMPUTED HERE ANY MORE, AND THAT IS THE FIX.
       *
       * It used to be: this method read `held`, priced the forfeit and posted both entries. Two
       * things were wrong with that and the red team found both.
       *
       *   *The money went into limbo when the forfeit was everything.* `refundable = held −
       *   forfeit` came out at zero, the guard below refused the whole request, and the forfeit
       *   entry was never written — so a cancelled order sat with `forfeited = ฿0.00` and
       *   `deposit_held = ฿19,722.24`, money that was neither the customer's nor recognised as
       *   the company's, on a finished contract, for ever.
       *
       *   *And an order nobody asked a refund for was never forfeited at all.* `forfeited` was
       *   structurally empty for any customer who walked away without arguing, which is most of
       *   them.
       *
       * The forfeit is a consequence of the **cancellation**, not of somebody asking for money
       * back, so it is posted in the cancellation's own transaction — see
       * `PaymentLifecycleService.onCancelled`. By the time this method runs, `held` is already
       * net of it, and the refund is simply what is left.
       */
      const money = await this.ledgerRepository.money(order.id, tx);
      if (money.heldThbMinor <= 0n) {
        const forfeited = await this.ledgerRepository.accountBalance(order.id, 'forfeited', tx);

        throw AppError.conflict('ออร์เดอร์นี้ไม่มีเงินคงเหลือที่จะคืน', {
          heldThbMinor: money.heldThbMinor.toString(),
          /* Credited, so negative in the fold; negated so a reader sees what was kept. */
          forfeitedThbMinor: (-forfeited).toString(),
        });
      }

      const refundableThbMinor = money.heldThbMinor;
      const payee = await this.resolvePayee(tx, order.id, body);

      const accrualEntryId = await this.ledger.recordRefundAccrued(tx, {
        orderId: order.id,
        amountThbMinor: refundableThbMinor,
        eventId: cancellation.eventId,
        memoTh: `ตั้งค้างคืนเงินหลังยกเลิกจากสถานะ ${cancellation.fromStatus} — เงินที่ถือไว้ ${money.heldThbMinor}`,
      });

      const refundId = await this.repository.insertRefund(tx, {
        orderId: order.id,
        accrualEntryId,
        amountThbMinor: refundableThbMinor,
        payeeName: payee.name,
        payeeBankCode: payee.bankCode,
        payeeAccountLast4: payee.accountLast4,
        payeeIsOriginalAccount: payee.isOriginalAccount,
        requestedByUserId: requesterUserId,
      });

      return this.detail(tx, refundId, payee.matchedSlipId);
    });
  }

  /**
   * The payee, decided from the slips and never from a flag in the body.
   *
   * Three outcomes, and the middle one is the whole control:
   *
   *   nothing asked for, an account on record  → refund to it, `yes`, no extra approval.
   *   nothing asked for, no account on record  → 409. The company cannot invent a destination,
   *                                              and defaulting to "whatever the customer types
   *                                              next" is the fraud path with the control
   *                                              removed.
   *   an account asked for                     → compared. Matching a slip is `yes`; not
   *                                              matching is `no`, which requires a reason now
   *                                              and an explicit acknowledgement at approval.
   */
  private async resolvePayee(
    tx: LedgerTx,
    orderId: string,
    body: CreateRefundWire,
  ): Promise<DerivedPayee> {
    const onRecord = await this.repository.acceptedPayers(tx, orderId);

    const derived = deriveOriginalAccount({
      onRecord,
      requested: body.payee,
      defaultBankCode: undefined,
    });

    if (derived === undefined) {
      throw AppError.conflict(
        'ไม่มีบัญชีต้นทางที่ตรวจแล้วบนออร์เดอร์นี้ — ต้องระบุบัญชีปลายทางพร้อมเหตุผล และต้องผ่านการอนุมัติแยก',
        { reason: 'no_payer_on_record' },
      );
    }

    if (derived.isOriginalAccount === 'no' && (body.reasonTh === undefined || body.reasonTh.length === 0)) {
      throw AppError.validationFailed(
        'การคืนเงินเข้าบัญชีอื่นที่ไม่ใช่บัญชีที่โอนมา ต้องระบุเหตุผลและจะถูกบันทึกในรายงาน',
        { reason: 'different_account_requires_reason' },
      );
    }

    return derived;
  }

  /* ---------------------------------------------------------------- *
   * Deciding
   * ---------------------------------------------------------------- */

  /**
   * Approve or refuse. One endpoint, because it is one decision with two answers.
   *
   * Rejecting **reverses the accrual**, and that is not tidiness. Without it the money stays in
   * `refund_payable` for ever: the queue plan 7.12 demands shows a debt the company has decided
   * not to pay, the order's held balance is understated by the same amount, and a second refund
   * request computes its own amount from that understated balance. A reversing entry rather than
   * a deletion, because the ledger is append-only and because "we recorded a promise and then
   * withdrew it" is itself a fact somebody will have to explain.
   */
  async decide(scope: Scope, refundId: string, body: DecideRefundWire): Promise<RefundDetailWire> {
    const deciderUserId = staffUserId(scope);

    return this.repository.transaction(async (tx) => {
      const refund = await this.lockOrFail(tx, refundId);

      if (refund.status !== 'requested') {
        throw AppError.conflict('คำขอคืนเงินนี้ถูกตัดสินไปแล้ว', { status: refund.status });
      }

      if (body.decision === 'rejected') {
        const reason = body.noteTh;
        if (reason === undefined) {
          throw AppError.validationFailed('การปฏิเสธคำขอคืนเงินต้องระบุเหตุผล', {
            reason: 'rejection_requires_note',
          });
        }

        await this.ledger.recordRefundAccrualReversed(tx, {
          orderId: refund.orderId,
          amountThbMinor: refund.amountThbMinor,
          reasonTh: reason,
        });

        if (!(await this.repository.reject(tx, refund.id, reason))) {
          throw AppError.conflict('คำขอคืนเงินนี้ถูกตัดสินไปแล้ว', { reason: 'decided_concurrently' });
        }

        return this.detail(tx, refund.id, null);
      }

      /*
       * 🔒 Two-person rule. CHECKed on the row as well — `refunds_approver_is_not_requester` —
       * and neither check is redundant: that one is the guarantee and covers a second writer
       * nobody has written yet, this one is the sentence the person reads. 403 and not 409: it
       * is not a race, it is this person, and retrying will not help them.
       */
      if (refund.requestedByUserId === deciderUserId) {
        throw new AppError(
          'FORBIDDEN',
          403,
          'ผู้อนุมัติต้องไม่ใช่ผู้ยื่นคำขอคืนเงิน — ขาออกต้องมีคนที่สองเช่นเดียวกับขาเข้า',
          { reason: 'approver_is_requester' },
        );
      }

      /*
       * The separate approval plan 7.12 asks for. It is a second *act*, not a second checkbox
       * on the same one: an approver who has not read the field that says the destination is
       * unrecognised cannot send this, because they have no reason to.
       */
      if (refund.payeeIsOriginalAccount === 'no' && body.acknowledgeDifferentAccount !== true) {
        throw AppError.validationFailed(
          'คำขอนี้คืนเข้าบัญชีที่ไม่ตรงกับบัญชีที่โอนเข้ามา — ต้องยืนยันการอนุมัติเส้นทางนี้แยกต่างหาก',
          { reason: 'different_account_requires_acknowledgement' },
        );
      }

      if (!(await this.repository.approve(tx, refund.id, deciderUserId))) {
        throw AppError.conflict('คำขอคืนเงินนี้ถูกตัดสินไปแล้ว', { reason: 'decided_concurrently' });
      }

      return this.detail(tx, refund.id, null);
    });
  }

  /* ---------------------------------------------------------------- *
   * Paying
   * ---------------------------------------------------------------- */

  /**
   * The transfer actually happened, and here is where to find it in a statement.
   *
   * ⚠️ This is the only place in the phase that takes cash out of the company, and everything
   * about it is arranged so that it cannot happen quietly:
   *
   *   - the reference is required and is written into the ledger memo as well as the row;
   *   - the disburser must differ from the approver (CHECKed, and refused here with a sentence);
   *   - money that has not landed blocks it. Plan 7.11: an accepted slip for a cross-border wire
   *     sits in `remittance_in_transit` for one to two working days, and a refund paid in that
   *     window is the company's own money going out against money it has not received.
   *     `refunds_guard_write()` refuses it; this checks first so the message names the amount.
   */
  async disburse(
    scope: Scope,
    refundId: string,
    body: DisburseRefundWire,
  ): Promise<RefundDetailWire> {
    const disburserUserId = staffUserId(scope);

    return this.repository.transaction(async (tx) => {
      const refund = await this.lockOrFail(tx, refundId);

      if (refund.status !== 'approved') {
        throw AppError.conflict('คำขอคืนเงินที่ยังไม่ผ่านการอนุมัติจะโอนไม่ได้', {
          status: refund.status,
        });
      }

      /* 🔒 Two-person rule #3. See `decide` for why this is 403 and not 409. */
      if (refund.approvedByUserId === disburserUserId) {
        throw new AppError(
          'FORBIDDEN',
          403,
          'ผู้กดโอนเงินคืนต้องไม่ใช่ผู้อนุมัติ',
          { reason: 'disburser_is_approver' },
        );
      }

      const money = await this.ledgerRepository.money(refund.orderId, tx);
      if (money.remittanceInTransitThbMinor !== 0n) {
        throw AppError.conflict(
          'ออร์เดอร์นี้ยังมีเงินโอนที่ยังไม่เข้าบัญชี — จ่ายเงินคืนออกไปก่อนไม่ได้',
          { remittanceInTransitThbMinor: money.remittanceInTransitThbMinor.toString() },
        );
      }

      await this.ledger.recordRefundDisbursed(tx, {
        orderId: refund.orderId,
        amountThbMinor: refund.amountThbMinor,
        disbursementReference: body.disbursementReference,
      });

      if (
        !(await this.repository.disburse(tx, refund.id, {
          disburserUserId,
          disbursementReference: body.disbursementReference,
        }))
      ) {
        throw AppError.conflict('คำขอคืนเงินนี้ถูกโอนไปแล้ว', { reason: 'disbursed_concurrently' });
      }

      return this.detail(tx, refund.id, null);
    });
  }

  /* ---------------------------------------------------------------- *
   * Reading
   * ---------------------------------------------------------------- */

  /**
   * The queue, and the report, from the same endpoint.
   *
   * Plan 7.12: *"อนุมัติแล้วยังไม่โอน = คำสัญญาที่บริษัทให้ไว้ ต้องเป็นบัญชี `refund_payable`
   * และมีคิวที่มองเห็น ไม่ใช่ค้างเงียบเป็นเดือน"*. The default filter is therefore `approved` —
   * the promises — rather than everything, because a queue that shows every refund that ever
   * happened is an archive and nobody works from it. `?payee=different` is the other half: every
   * refund going somewhere other than the account that paid, which is the report plan 7.12 asks
   * for by name.
   *
   * ⚠️ There is no SLA on this queue. Plan 13's refunds row records that as an open question and
   * the documented default is *no SLA, but the queue must be visible* — so nothing here ages a
   * refund, marks it late, or escalates it. That is a default, not a decision.
   */
  async list(query: RefundQuery): Promise<RefundListWire> {
    const statuses = statusesOf(query);

    const [rows, payableTotal] = await Promise.all([
      this.repository.list({
        statuses,
        differentAccountOnly: query.payee === 'different',
        limit: query.limit,
      }),
      this.repository.payableTotalThbMinor(),
    ]);

    return {
      refunds: rows.map(encodeRefund),
      payableTotalThbMinor: payableTotal.toString(),
    };
  }

  async get(refundId: string): Promise<RefundDetailWire> {
    const refund = await this.repository.findRefund(refundId);
    if (!refund) throw AppError.notFound('ไม่พบคำขอคืนเงินนี้');

    return this.assemble(refund, null);
  }

  /* ---------------------------------------------------------------- *
   * Helpers
   * ---------------------------------------------------------------- */

  private async lockOrFail(tx: LedgerTx, refundId: string): Promise<RefundRow> {
    const refund = await this.repository.lockRefund(tx, refundId);
    if (!refund) throw AppError.notFound('ไม่พบคำขอคืนเงินนี้');
    return refund;
  }

  private async detail(
    tx: LedgerTx,
    refundId: string,
    matchedSlipId: string | null,
  ): Promise<RefundDetailWire> {
    const refund = await this.repository.findRefund(refundId, tx);
    if (!refund) throw new Error('refunds: the refund could not be read back');

    return this.assemble(refund, matchedSlipId, tx);
  }

  private async assemble(
    refund: RefundRow,
    matchedSlipId: string | null,
    tx?: LedgerTx,
  ): Promise<RefundDetailWire> {
    const [money, forfeited] = await Promise.all([
      this.ledgerRepository.money(refund.orderId, tx),
      this.ledgerRepository.accountBalance(refund.orderId, 'forfeited', tx),
    ]);

    return {
      refund: encodeRefund(refund),
      money: {
        cashThbMinor: money.cashThbMinor.toString(),
        heldThbMinor: money.heldThbMinor.toString(),
        settledThbMinor: money.settledThbMinor.toString(),
        refundPayableThbMinor: money.refundPayableThbMinor.toString(),
        /* Credited, therefore negative in the fold. Negated so "kept" reads as a positive number. */
        forfeitedThbMinor: (-forfeited).toString(),
        queueBucket: money.queueBucket,
      },
      matchedSlipId,
    };
  }
}

/* ------------------------------------------------------------------------- *
 * Encoding and small decisions
 * ------------------------------------------------------------------------- */

function encodeRefund(row: RefundRow): RefundWire {
  return {
    id: row.id,
    orderId: row.orderId,
    orderNo: row.orderNo,
    status: row.status,
    /* Digits as a string — `JSON.parse` on a large integer is where a satang goes missing. */
    amountThbMinor: row.amountThbMinor.toString(),
    currency: row.currency,
    accrualEntryId: row.accrualEntryId,
    payeeName: row.payeeName,
    payeeBankCode: row.payeeBankCode,
    payeeAccountLast4: row.payeeAccountLast4,
    payeeIsOriginalAccount: row.payeeIsOriginalAccount,
    requestedByUserId: row.requestedByUserId,
    requestedAt: row.requestedAt.toISOString(),
    approvedByUserId: row.approvedByUserId,
    approvedAt: row.approvedAt === null ? null : row.approvedAt.toISOString(),
    disbursedByUserId: row.disbursedByUserId,
    disbursedAt: row.disbursedAt === null ? null : row.disbursedAt.toISOString(),
    disbursementReference: row.disbursementReference,
    rejectedReasonTh: row.rejectedReasonTh,
  };
}

/** Absent means the payable queue. See the note on `list`. */
function statusesOf(query: RefundQuery): readonly RefundStatus[] {
  if (query.status === undefined) return ['approved'];
  return Array.isArray(query.status) ? query.status : [query.status];
}

/**
 * The member of staff acting, or a 401 — and never a guest.
 *
 * `RequirePermissions` on the route means this cannot be reached without a user scope, so this
 * is the second lock rather than the first. It is a `throw` and not a non-null assertion because
 * "the guard would have stopped them" is a claim about a decorator in another file, and the
 * columns being filled in here are the ones that make the two-person rules mean anything: a
 * refund approved by nobody is a refund approved by whoever is holding the keyboard.
 */
function staffUserId(scope: Scope): string {
  if (scope.kind !== 'user') {
    throw AppError.unauthenticated('ต้องเข้าสู่ระบบด้วยบัญชีเจ้าหน้าที่จึงจะทำรายการคืนเงินได้');
  }
  return scope.userId;
}
