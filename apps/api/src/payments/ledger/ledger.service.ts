import { Injectable } from '@nestjs/common';

import { LedgerRepository, type LedgerTx, type OrderMoney } from './ledger.repository';
import { assertPositiveAmount, credit, debit } from './postings';

/**
 * Every posting this phase makes, named once, with both legs visible on one screen.
 *
 * ── Why a service of named movements and not a `post(legs)` anybody may call ─────
 *
 * Plan 7.13's third seam: *"one bank fee posted to `settlement_variance` on the way in and to
 * `revenue` on the way out, by two designs that each believed they were the only one."* A
 * repository that takes arbitrary legs makes that inevitable — the accounting decision moves
 * to whichever service is writing that day, and the chart of accounts becomes a list of names
 * rather than a set of rules. So the accounts appear in this file and, apart from tests,
 * nowhere else in `apps/api`: the callers say what happened, and what that means in the ledger
 * is decided here.
 *
 * ── The signs, once ──────────────────────────────────────────────────────────────
 *
 * `bank_thb`, `remittance_in_transit` and `trade_receivable` are assets: a debit (positive) is
 * money or a claim arriving. `deposit_held`, `refund_payable`, `credit_clearing`, `revenue`,
 * `forfeited` and `settlement_variance` are the other side: a credit (negative) is the
 * obligation or the earning being recorded. So `order_held_thb_minor()` is the *negation* of
 * the `deposit_held` fold, which is why it is its own function in SQL and why nothing here
 * folds it by hand.
 *
 * ── Corrections are entries, never edits ─────────────────────────────────────────
 *
 * `ledger_entries` and `ledger_postings` are append-only, enforced by trigger. `reverse…`
 * below is therefore a real movement in the opposite direction with a memo saying what it
 * undoes — which is what an accountant does anyway, and which leaves both facts visible to the
 * person who has to explain the account next quarter.
 */
@Injectable()
export class LedgerService {
  constructor(private readonly ledger: LedgerRepository) {}

  /* ---------------------------------------------------------------- *
   * Money arriving
   * ---------------------------------------------------------------- */

  /**
   * A slip was accepted: the customer's money is now the company's to account for.
   *
   * `landed` is the domestic case and the default — a Thai transfer between Thai banks is in
   * the account by the time anybody looks at the slip. `landed: false` is plan 7.11's
   * cross-border wire, which sits in `remittance_in_transit` for one to two working days; the
   * reason that account exists at all is that a refund must not be paid out of money that has
   * not arrived, and `refunds_guard_write()` refuses the disbursement while it is non-zero.
   *
   * SEAM: the slip-review module calls this at the moment it accepts a slip, in the same
   * transaction as the acceptance. Nothing here decides whether the slip is good.
   */
  async recordSlipAccepted(
    tx: LedgerTx,
    input: {
      readonly orderId: string;
      readonly slipId: string;
      readonly amountThbMinor: bigint;
      readonly landed: boolean;
      readonly eventId?: string | undefined;
    },
  ): Promise<string> {
    assertPositiveAmount('an accepted slip', input.amountThbMinor);

    return this.ledger.post(tx, {
      orderId: input.orderId,
      kind: 'slip_accepted',
      slipId: input.slipId,
      eventId: input.eventId,
      memoTh: input.landed
        ? 'รับสลิปที่ตรวจแล้ว — เงินเข้าบัญชีบาท'
        : 'รับสลิปที่ตรวจแล้ว — โอนข้ามประเทศ ยังไม่เข้าบัญชี',
      legs: [
        debit(input.landed ? 'bank_thb' : 'remittance_in_transit', input.amountThbMinor),
        credit('deposit_held', input.amountThbMinor),
      ],
    });
  }

  /** The cross-border wire arrived. The only thing that empties `remittance_in_transit`. */
  async recordRemittanceLanded(
    tx: LedgerTx,
    input: {
      readonly orderId: string;
      readonly slipId: string;
      readonly amountThbMinor: bigint;
    },
  ): Promise<string> {
    assertPositiveAmount('a landed remittance', input.amountThbMinor);

    return this.ledger.post(tx, {
      orderId: input.orderId,
      kind: 'remittance_landed',
      slipId: input.slipId,
      memoTh: 'เงินโอนข้ามประเทศเข้าบัญชีแล้ว',
      legs: [debit('bank_thb', input.amountThbMinor), credit('remittance_in_transit', input.amountThbMinor)],
    });
  }

  /**
   * What the bank credited is not what the pinned rate said, and the difference has a kind.
   *
   * Plan 7.11 sizes it at 2–3% of an invoice and calls it an accounting fact rather than a bug.
   * `shortfall: true` is the ordinary direction — less arrived than was invoiced — and posts the
   * difference to `settlement_variance` against `deposit_held`, so the instalment can be settled
   * in full while the cash tells the truth. That acceptance is a *discount* and plan 7.11 says
   * it counts against the same authority ceiling as any other; this method records it, and
   * whether it was allowed is the approvals table's question, not the ledger's.
   */
  async recordVariance(
    tx: LedgerTx,
    input: {
      readonly orderId: string;
      readonly amountThbMinor: bigint;
      readonly varianceKind: 'fx_spread' | 'bank_fee' | 'refund_fx';
      readonly shortfall: boolean;
      readonly slipId?: string | undefined;
      readonly memoTh: string;
    },
  ): Promise<string> {
    assertPositiveAmount('a settlement variance', input.amountThbMinor);

    return this.ledger.post(tx, {
      orderId: input.orderId,
      kind: 'variance',
      slipId: input.slipId,
      varianceKind: input.varianceKind,
      memoTh: input.memoTh,
      legs: input.shortfall
        ? [debit('settlement_variance', input.amountThbMinor), credit('deposit_held', input.amountThbMinor)]
        : [debit('deposit_held', input.amountThbMinor), credit('settlement_variance', input.amountThbMinor)],
    });
  }

  /* ---------------------------------------------------------------- *
   * Money moving between orders and into the company
   * ---------------------------------------------------------------- */

  /**
   * Money carried from a superseded order to its revision — two entries, because an entry
   * belongs to one order.
   *
   * `ledger_entries.order_id` is NOT NULL and every fold is `WHERE order_id = $1`, so a single
   * entry spanning two orders is not expressible and should not be: the ancestor's balance and
   * the revision's balance are two questions with two answers. `credit_clearing` is the account
   * the money passes through, and its balance over the pair is zero the moment both halves are
   * written — which is what makes an unfinished carry visible rather than silent.
   *
   * ⚠️ There is no cash leg on either side, and that is plan 7.8's ⚠️: the cash arrived on the
   * ancestor and was never in the revision's bank account. Every "have we been paid?" on the
   * revision must therefore read `order_held_thb_minor()`, never `order_cash_thb_minor()`.
   *
   * SEAM: the allocation itself *moves* onto the revision's instalment (see
   * `slip_allocations_guard_write()` — one payment keeps one allocation row forever). That is
   * the slips module's write; this is the accounting for it.
   */
  async recordCarriedForward(
    tx: LedgerTx,
    input: {
      readonly fromOrderId: string;
      readonly toOrderId: string;
      readonly amountThbMinor: bigint;
      readonly fromEventId?: string | undefined;
    },
  ): Promise<{ readonly fromEntryId: string; readonly toEntryId: string }> {
    assertPositiveAmount('money carried to a revision', input.amountThbMinor);

    if (input.fromOrderId === input.toOrderId) {
      throw new Error('ledger: money cannot be carried from an order to itself');
    }

    /*
     * 🔒 THE ANCESTRY CHECK, WHICH THIS METHOD DID NOT HAVE — 5b red team, finding 4.
     *
     * `slip_allocations_guard_write()` walks `order_is_ancestor_of` before it will let an
     * allocation move, and this — the other half of the same act — checked nothing at all. So
     * these two entries could be posted between two orders with no relationship whatever:
     * every entry balancing, `assert_ledger_entry_balances` passing, both orders internally
     * consistent, one payment settled on one and held on the other. Reproduced with ฿5,916.67.
     *
     * The two halves of "carrying money" were guarded to completely different standards, and
     * only the half that was unreachable was the guarded one.
     *
     * Asked of the database and not answered here: `order_is_ancestor_of` walks
     * `supersedes_order_id`, and a TypeScript walk would be a second reading of the chain that
     * decides whose money this is. The schema also holds a structural half — see
     * `assert_carry_is_between_relatives` in `0013_payment_closure_guards.sql` — so a caller
     * that skips this method still cannot post a carry off the chain.
     */
    if (!(await this.ledger.isAncestorOf(tx, input.fromOrderId, input.toOrderId))) {
      throw new Error(
        `ledger: order ${input.toOrderId} is not a revision of order ${input.fromOrderId}; money does not move sideways`,
      );
    }

    const fromEntryId = await this.ledger.post(tx, {
      orderId: input.fromOrderId,
      kind: 'carried_forward',
      eventId: input.fromEventId,
      memoTh: `ยกเงินที่รับไว้ไปยังออร์เดอร์ฉบับแก้ไข ${input.toOrderId}`,
      legs: [debit('deposit_held', input.amountThbMinor), credit('credit_clearing', input.amountThbMinor)],
    });

    const toEntryId = await this.ledger.post(tx, {
      orderId: input.toOrderId,
      kind: 'carried_forward',
      memoTh: `รับเงินที่ยกมาจากออร์เดอร์เดิม ${input.fromOrderId}`,
      legs: [debit('credit_clearing', input.amountThbMinor), credit('deposit_held', input.amountThbMinor)],
    });

    return { fromEntryId, toEntryId };
  }

  /**
   * The job was delivered, so the money stops being the customer's and starts being earned.
   * The only entry that touches `revenue`, and the only one that touches `trade_receivable`.
   *
   * ⚠️ THIS HAD NO CALLER AT ALL UNTIL THE CLOSING ROUND, and the red team measured the
   * consequence: a delivered, installed, fully paid job whose whole ledger was `bank_thb`
   * ฿19,722.24 against `deposit_held` −฿19,722.24, with `order_held_thb_minor()` still
   * reporting the full amount. `revenue` was structurally empty and `deposit_held` accumulated
   * every completed contract for ever — a trial balance saying the company owes every customer
   * it has ever delivered to.
   *
   * Two debit legs rather than one, because delivery earns the **whole contract** and not only
   * the part that has been paid for. What is in hand comes out of `deposit_held`; what is not
   * is a claim on the customer, which is what `trade_receivable` is for and is the only honest
   * place for it — recognising only the cash would make revenue depend on how promptly people
   * transfer, and leave the balance owed recorded nowhere.
   *
   * Money held **beyond** the contract total is deliberately left in `deposit_held`: an
   * overpayment is not revenue, it is somebody's money awaiting a refund, and it is exactly the
   * `payment_slips.unallocated_thb_minor` the slip review had to record to accept the slip.
   */
  async recordRevenueRecognised(
    tx: LedgerTx,
    input: {
      readonly orderId: string;
      /** The contract total. Always VAT-inclusive — plan 4.4. */
      readonly grandTotalThbMinor: bigint;
      /** `order_held_thb_minor()` as it stands in this transaction. */
      readonly heldThbMinor: bigint;
      readonly eventId?: string | undefined;
    },
  ): Promise<string> {
    assertPositiveAmount('recognised revenue', input.grandTotalThbMinor);

    const fromHeld =
      input.heldThbMinor < input.grandTotalThbMinor ? input.heldThbMinor : input.grandTotalThbMinor;
    const receivable = input.grandTotalThbMinor - (fromHeld > 0n ? fromHeld : 0n);

    const legs = [
      ...(fromHeld > 0n ? [debit('deposit_held', fromHeld)] : []),
      ...(receivable > 0n ? [debit('trade_receivable', receivable)] : []),
      credit('revenue', input.grandTotalThbMinor),
    ];

    return this.ledger.post(tx, {
      orderId: input.orderId,
      kind: 'revenue_recognised',
      eventId: input.eventId,
      memoTh:
        `รับรู้รายได้เมื่อส่งมอบงาน — ยอดตามสัญญา ${input.grandTotalThbMinor} ` +
        `จากเงินที่ถือไว้ ${fromHeld > 0n ? fromHeld : 0n} ค้างรับ ${receivable}`,
      legs,
    });
  }

  /* ---------------------------------------------------------------- *
   * Money the company keeps, and money it gives back
   * ---------------------------------------------------------------- */

  /**
   * What the company keeps on a cancellation, within the deposit obligation.
   *
   * The *amount* is `order_forfeit_thb_minor()`'s and is never computed here — see
   * `LedgerRepository.forfeitThbMinor`. What this method contributes is the memo, and the memo
   * is not decoration: nothing in the schema records which forfeit policy was applied to which
   * cancellation (plan 7.13 wants `forfeit_policy` pinned onto the order at submit, and there
   * is no column for it yet — see the note in `refunds.service.ts`). Until there is, this
   * append-only line is the only evidence of the rate that was used, and it is written in the
   * same transaction as the money it explains.
   */
  async recordForfeit(
    tx: LedgerTx,
    input: {
      readonly orderId: string;
      readonly amountThbMinor: bigint;
      readonly eventId: string;
      readonly policyCode: string;
      readonly fromStatus: string;
      readonly fault: string;
      readonly forfeitBp: number;
    },
  ): Promise<string> {
    assertPositiveAmount('a forfeit', input.amountThbMinor);

    return this.ledger.post(tx, {
      orderId: input.orderId,
      kind: 'forfeited',
      eventId: input.eventId,
      memoTh:
        `ริบตามนโยบาย ${input.policyCode} — ยกเลิกจากสถานะ ${input.fromStatus} ` +
        `ความผิดฝ่าย ${input.fault} อัตรา ${input.forfeitBp} bp ของ min(เงินที่ถือไว้, มัดจำตามสัญญา)`,
      legs: [debit('deposit_held', input.amountThbMinor), credit('forfeited', input.amountThbMinor)],
    });
  }

  /**
   * The obligation to give money back, recorded before anybody is asked to approve paying it.
   *
   * This is the entry a `refunds` row must point at, and `refunds_match_accrual` checks that
   * the row's amount equals what this entry put into `refund_payable`. Plan 7.12: *"อนุมัติแล้ว
   * ยังไม่โอน = คำสัญญาที่บริษัทให้ไว้"* — a promise only means something if the promise and the
   * payable are the same number, and the only way to guarantee that is for the number to come
   * from here rather than from a form.
   *
   * ⚠️ No cash leg. Accruing costs the company nothing until somebody transfers.
   */
  async recordRefundAccrued(
    tx: LedgerTx,
    input: {
      readonly orderId: string;
      readonly amountThbMinor: bigint;
      readonly eventId?: string | undefined;
      readonly memoTh: string;
    },
  ): Promise<string> {
    assertPositiveAmount('a refund accrual', input.amountThbMinor);

    return this.ledger.post(tx, {
      orderId: input.orderId,
      kind: 'refund_accrued',
      eventId: input.eventId,
      memoTh: input.memoTh,
      legs: [debit('deposit_held', input.amountThbMinor), credit('refund_payable', input.amountThbMinor)],
    });
  }

  /**
   * A refund request was refused, so the promise is withdrawn and the money goes back to held.
   *
   * Without this, rejecting a refund leaves the accrual in `refund_payable` for ever: the
   * payable queue plan 7.12 demands shows a debt nobody intends to pay, and the order's held
   * balance stays understated by the same amount. A reversing entry rather than a deletion,
   * because the tables are append-only and because "we said we would and then did not" is
   * itself a fact worth keeping.
   */
  async recordRefundAccrualReversed(
    tx: LedgerTx,
    input: {
      readonly orderId: string;
      readonly amountThbMinor: bigint;
      readonly reasonTh: string;
    },
  ): Promise<string> {
    assertPositiveAmount('a reversed refund accrual', input.amountThbMinor);

    return this.ledger.post(tx, {
      orderId: input.orderId,
      kind: 'refund_accrued',
      memoTh: `กลับรายการตั้งค้างคืนเงิน — คำขอถูกปฏิเสธ: ${input.reasonTh}`,
      legs: [debit('refund_payable', input.amountThbMinor), credit('deposit_held', input.amountThbMinor)],
    });
  }

  /**
   * ⚠️ THE ONLY ENTRY IN THIS PHASE THAT TAKES CASH OUT OF THE COMPANY.
   *
   * Written at disbursement and nowhere else, against a reference somebody can find in a bank
   * statement. Accrual and payment are two events and must be two entries: an accrual that also
   * moved cash would mean approving a refund was the same act as paying it, and the two-person
   * separation the rest of this module is built on would be separating nothing.
   */
  async recordRefundDisbursed(
    tx: LedgerTx,
    input: {
      readonly orderId: string;
      readonly amountThbMinor: bigint;
      readonly disbursementReference: string;
    },
  ): Promise<string> {
    assertPositiveAmount('a disbursed refund', input.amountThbMinor);

    return this.ledger.post(tx, {
      orderId: input.orderId,
      kind: 'refund_disbursed',
      memoTh: `โอนเงินคืนแล้ว — อ้างอิง ${input.disbursementReference}`,
      legs: [debit('refund_payable', input.amountThbMinor), credit('bank_thb', input.amountThbMinor)],
    });
  }

  /* ---------------------------------------------------------------- *
   * Reading
   * ---------------------------------------------------------------- */

  /** Every balance a money screen needs, each from its own SQL fold. See `OrderMoney`. */
  async money(orderId: string, tx?: LedgerTx): Promise<OrderMoney> {
    return this.ledger.money(orderId, tx);
  }
}
