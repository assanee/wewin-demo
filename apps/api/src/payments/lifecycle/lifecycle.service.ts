import { Injectable, Logger } from '@nestjs/common';
import type { FaultParty, OrderStatus } from '@wewin/db/schema';

import { AppError } from '../../common/errors/app-error';
import { LedgerRepository, LedgerService, type LedgerTx } from '../ledger';
import { ScheduleService, type PlannedInstalment } from '../schedule';
import { LifecycleRepository } from './lifecycle.repository';

/**
 * What happens to money when an order moves — the seam 5a left open and 5b spent a round
 * proving was still open.
 *
 * ── The finding this file is the answer to ───────────────────────────────────────
 *
 * Three modules shipped in 5b — the schedule, the slips, the ledger and refunds — and none of
 * them was reachable, because nothing called them. The red team measured it end to end
 * against the assembled application:
 *
 *     an order submitted through the real app had **0 `order_instalments` rows**
 *       → `order_settled_through()` = NULL
 *       → `order_gate_is_open(order,'production_confirmed')` = **true with ฿0.00 received**
 *       → the freeze gate was vacuous, and no slip could ever be accepted because every
 *         allocation named an instalment that did not exist
 *
 *     a delivered, installed, fully paid job's entire ledger was `bank_thb` +฿19,722.24
 *       against `deposit_held` −฿19,722.24 — `revenue` empty, for ever
 *
 *     a cancelled order holding a deposit could not be cancelled at all: `assert_order_schedule`
 *       refuses a terminal order whose schedule is open, 5a's handlers closed nothing, and the
 *       assertion is deferred, so it landed as a 409 at COMMIT with no ordering of separate
 *       transactions that could satisfy it
 *
 * Every one of those is the same omission: the order lifecycle and the money were written as
 * two systems with a seam between them and nobody stood in the seam. This service is that
 * person. `OrdersService` calls it at four points and knows nothing else about money.
 *
 * ── Why here and not in `OrdersService` ──────────────────────────────────────────
 *
 * Because `OrdersService` would then decide accounting. Plan 7.13's third seam is one bank fee
 * posted to `settlement_variance` by the module that received it and to `revenue` by the module
 * that paid it, and the defence is that the chart of accounts lives in `LedgerService` and
 * callers say what *happened*. This file says what happened; it never assembles a posting.
 *
 * ── Why not in `payments/refunds` or `payments/slips` ────────────────────────────
 *
 * Module direction. `SlipsModule` and `RefundsModule` import from `orders`; `OrdersModule`
 * imports this. A cycle here would be a `forwardRef`, which is a way of writing a cycle down
 * rather than not having one — and the cycle would be between the lifecycle and the money,
 * which is the exact relationship this round is trying to make one-directional.
 */
@Injectable()
export class PaymentLifecycleService {
  private readonly logger = new Logger(PaymentLifecycleService.name);

  constructor(
    private readonly schedule: ScheduleService,
    private readonly ledger: LedgerService,
    private readonly ledgerRepository: LedgerRepository,
    private readonly lifecycle: LifecycleRepository,
  ) {}

  /* ---------------------------------------------------------------- *
   * Reading — the customer's own question, task 10
   * ---------------------------------------------------------------- */

  /**
   * How much is left to pay, from the same fold the staff slip-review screen reads.
   *
   * `LedgerRepository.money()` and `SlipsRepository.orderMoney()` are two callers of the one
   * SQL function this comes from, `order_outstanding_thb_minor()` — `grand_total_thb_minor`
   * minus `order_settled_thb_minor()`, which folds every instalment's accepted allocations, not
   * only the gate instalment's. This is the third caller, and it exists *because*
   * `OrdersModule` may not import `SlipsModule` (see the module-level note above): the customer
   * figure has to reach the same fold through this module's one seam rather than by opening a
   * second path to it, let alone by re-deriving it from `grandTotal − Σ(accepted slips)` —
   * which disagrees with the fold the moment a slip carries `unallocated_thb_minor` or an
   * order has more than one instalment.
   */
  async outstandingThbMinor(orderId: string): Promise<bigint> {
    return (await this.ledgerRepository.money(orderId)).outstandingThbMinor;
  }

  /* ---------------------------------------------------------------- *
   * Submit — the transaction that pins
   * ---------------------------------------------------------------- */

  /**
   * The two contract terms a submit must pin before it writes the order, plan 7.13.
   *
   * `scheduled_deposit_thb_minor` and `forfeit_policy_id` both have to be present in the same
   * statement that stamps `submitted_at` (`orders_submitted_shape`, and the pin is meaningless
   * after the fact), while the instalment rows can only be written *after* the total is on the
   * row — `assert_order_schedule()` compares them against `orders.grand_total_thb_minor` as it
   * stands. So the schedule is planned here, used for the pin, and handed back to be written by
   * `openSchedule` a statement later. One evaluation, two uses.
   *
   * ⚠️ AND THE DEPOSIT COMES FROM THE SCHEDULE, WHICH IS THE WHOLE OF PLAN 7.13'S FOURTH SEAM.
   * `orders.service.ts` used to pin `divRoundHalfUp(grandTotal × SCHEDULED_DEPOSIT_BP_DEFAULT,
   * 10000)` — a second implementation that agreed with this one *only* while the default gate
   * coverage was payment in full. The day sales authored a 30/70 it pinned 100% of the order as
   * the forfeit ceiling where the schedule said 30%: ฿19,722.24 against ฿5,916.67 on the red
   * team's live order, and the customer got ฿0.00 back instead of ฿13,805.57. That function is
   * gone; this is the only one left.
   */
  async pinsForSubmit(
    tx: LedgerTx,
    grandTotalThbMinor: bigint,
  ): Promise<{
    readonly instalments: readonly PlannedInstalment[];
    readonly scheduledDepositThbMinor: bigint;
    readonly forfeitPolicyId: string;
  }> {
    const instalments = this.schedule.plan(grandTotalThbMinor);

    /*
     * Fail closed, at submit, where it is a refusal to make a contract rather than a refusal
     * to give money back. Plan 13's rule is that every unanswered number must have defined
     * behaviour on day one; `0011_payment_guards.sql` seeds `plan13_default` (0 bp in every
     * cell) precisely so this never fires in a working system, and if somebody empties the
     * table the right moment to find out is before anybody transfers anything.
     */
    const policy = await this.ledgerRepository.effectiveForfeitPolicy(tx);
    if (!policy) {
      throw AppError.conflict(
        'ยังไม่มีนโยบายการริบที่มีผลบังคับใช้ — ต้องกำหนดนโยบายก่อนจึงจะรับสัญญาได้',
        { reason: 'no_effective_forfeit_policy' },
      );
    }

    return {
      instalments,
      scheduledDepositThbMinor: this.schedule.depositMinor(instalments),
      forfeitPolicyId: policy.id,
    };
  }

  /**
   * Write the instalments, then carry anything the ancestor was holding.
   *
   * Called immediately after the submit statement, in the same transaction, because both halves
   * are only legal once the total is on the row.
   *
   * Returns what was carried, in THB minor, so the caller can put it on the event — a revision
   * that starts life already part-paid is the first thing the customer asks about.
   */
  async onSubmitted(
    tx: LedgerTx,
    input: {
      readonly orderId: string;
      readonly status: OrderStatus;
      readonly grandTotalThbMinor: bigint;
      readonly instalments: readonly PlannedInstalment[];
      readonly forfeitPolicyId: string;
      readonly supersedesOrderId: string | null;
    },
  ): Promise<bigint> {
    await this.schedule.openPlanned(
      {
        tx,
        orderId: input.orderId,
        status: input.status,
        grandTotalThbMinor: input.grandTotalThbMinor,
      },
      input.instalments,
    );

    await this.lifecycle.pinForfeitPolicy(tx, input.orderId, input.forfeitPolicyId);

    if (input.supersedesOrderId === null) return 0n;
    return this.carryForward(tx, input.supersedesOrderId, input.orderId);
  }

  /* ---------------------------------------------------------------- *
   * Carrying money to a revision — plan 7.8
   * ---------------------------------------------------------------- */

  /**
   * Move the ancestor's money onto this order.
   *
   * ⚠️ THE ALTERNATIVE IS BILLING THE CUSTOMER TWICE, and until this round that is what
   * happened — `superseded` was unreachable (the schedule could not be closed), so
   * `supersedes_order_id` was never set, so `slip_allocations_guard_write()`'s carry branch was
   * dead code, and a customer whose quote was revised had ฿5,916.67 stranded on order A while
   * order B invoiced them the whole ฿19,722.24 again.
   *
   * Two movements, and they are different things:
   *
   *   the **allocations** move, row by row, onto instalments of this order. One payment keeps
   *   one allocation row for ever (plan 7.8, and `slip_allocations_guard_write` refuses a
   *   second), so the ancestor's settled fold correctly drops to zero.
   *
   *   the **ledger** records the transfer as a pair of entries through `credit_clearing`,
   *   because an entry belongs to one order. There is no cash leg on either side — the cash
   *   arrived on the ancestor — which is why every "have we been paid?" downstream reads
   *   `order_held_thb_minor()` and never `order_cash_thb_minor()`.
   *
   * ── The fit, and what happens when it fails ──────────────────────────────────
   *
   * An allocation cannot be split (its amount is evidence and immutable), and no instalment may
   * hold more than it is due (`assert_instalment_allocation`, added this round). So the carried
   * rows have to be *packed* into the new schedule. Largest first into the earliest instalment
   * with room, which always succeeds under the default preset — one `remainder` instalment
   * whose due is the whole total — whenever the carried money does not exceed the new total.
   *
   * When it does not fit, the submit is refused with the numbers in it. That is deliberate and
   * it is not a fallback: quietly leaving the money behind is how it ends up counted on two
   * orders, which is the failure the whole carry design exists to prevent.
   */
  private async carryForward(
    tx: LedgerTx,
    fromOrderId: string,
    toOrderId: string,
  ): Promise<bigint> {
    const heldOnAncestor = (await this.ledgerRepository.money(fromOrderId, tx)).heldThbMinor;
    const allocations = await this.lifecycle.carriedAllocations(tx, fromOrderId);

    if (heldOnAncestor <= 0n && allocations.length === 0) return 0n;

    const instalments = await this.lifecycle.instalments(tx, toOrderId);
    const room = new Map(instalments.map((row) => [row.id, row.dueThbMinor]));

    for (const allocation of allocations) {
      const target = instalments.find((row) => (room.get(row.id) ?? 0n) >= allocation.amountThbMinor);

      if (target === undefined) {
        throw AppError.conflict(
          'เงินที่รับไว้จากออร์เดอร์เดิมลงงวดของใบใหม่ไม่พอดี — ต้องแก้ตารางงวดก่อนจึงจะออกใบแก้ไขได้',
          {
            reason: 'carried_money_does_not_fit',
            fromOrderId,
            allocationThbMinor: allocation.amountThbMinor.toString(),
            grandTotalThbMinor: instalments
              .reduce((sum, row) => sum + row.dueThbMinor, 0n)
              .toString(),
          },
        );
      }

      room.set(target.id, (room.get(target.id) ?? 0n) - allocation.amountThbMinor);
      await this.lifecycle.moveAllocation(tx, allocation.id, target.id, fromOrderId);
    }

    if (heldOnAncestor <= 0n) return 0n;

    await this.ledger.recordCarriedForward(tx, {
      fromOrderId,
      toOrderId,
      amountThbMinor: heldOnAncestor,
    });

    this.logger.log(
      `Carried ${heldOnAncestor} THB minor from order ${fromOrderId} to its revision ${toOrderId} ` +
        `across ${allocations.length} allocation(s)`,
    );

    return heldOnAncestor;
  }

  /* ---------------------------------------------------------------- *
   * The terminal moves
   * ---------------------------------------------------------------- */

  /**
   * The order was cancelled: close the schedule, and keep what the policy says may be kept.
   *
   * ── Closing the schedule is not bookkeeping ─────────────────────────────────
   *
   * `assert_order_schedule()` runs both ways — a terminal order may not carry an open schedule,
   * a live order may not carry a closed one — and it is DEFERRED, so it can only be satisfied
   * *inside one transaction*. There was therefore no ordering of separate requests that could
   * cancel an order with a schedule: closing first raised "order is awaiting_payment but its
   * payment schedule is closed", cancelling first raised the mirror image at COMMIT. Plan
   * 7.5(ก) predicted exactly this and said the exemption must be a stamp; the stamp had no
   * writer.
   *
   * ── And the forfeit belongs here, not in the refund ─────────────────────────
   *
   * Keeping part of a deposit is a consequence of the customer walking away. Pricing it when
   * somebody asks for the rest back meant two things: an order nobody argued about was never
   * forfeited at all, and — when the forfeit came to the whole balance — the refund was refused
   * before the entry was written, leaving the money in neither party's column for ever.
   *
   * The rate comes from `orders.forfeit_policy_id`, pinned at submit (plan 7.13's seventh pin),
   * so publishing a policy between the contract and the cancellation cannot change what this
   * customer gets back. An order holding money with no pin is refused rather than priced under
   * today's table, which is the behaviour the pin exists to produce.
   */
  async onCancelled(
    tx: LedgerTx,
    input: {
      readonly orderId: string;
      readonly fromStatus: OrderStatus;
      readonly fault: FaultParty;
      readonly eventId: string;
    },
  ): Promise<bigint> {
    await this.schedule.close({ tx, orderId: input.orderId }, 'cancelled');

    const held = (await this.ledgerRepository.money(input.orderId, tx)).heldThbMinor;
    if (held <= 0n) return 0n;

    const terms = await this.lifecycle.orderMoneyTerms(tx, input.orderId);
    const policyId = terms?.forfeitPolicyId;

    if (policyId === undefined || policyId === null) {
      throw AppError.conflict(
        'ออร์เดอร์นี้ถือเงินอยู่แต่ไม่มีนโยบายการริบที่ตรึงไว้ตอนทำสัญญา — คิดยอดริบไม่ได้',
        { reason: 'no_pinned_forfeit_policy', heldThbMinor: held.toString() },
      );
    }

    const amount = await this.ledgerRepository.forfeitThbMinor(
      input.orderId,
      input.fromStatus,
      input.fault,
      policyId,
      tx,
    );

    if (amount <= 0n) return 0n;

    const policy = await this.ledgerRepository.effectiveForfeitPolicy(tx);
    const bp = await this.ledgerRepository.forfeitBp(policyId, input.fromStatus, input.fault, tx);

    await this.ledger.recordForfeit(tx, {
      orderId: input.orderId,
      amountThbMinor: amount,
      eventId: input.eventId,
      /*
       * The pinned policy's own code, which is what the memo has to name. `effectiveForfeitPolicy`
       * is only consulted as a label of last resort — if today's effective policy is a different
       * one, the id is still the pinned one and the memo says so.
       */
      policyCode: policy?.id === policyId ? policy.code : policyId,
      fromStatus: input.fromStatus,
      fault: input.fault,
      /*
       * The cell was found a statement ago by `order_forfeit_thb_minor()`, which raises when it
       * is missing — so this is a re-read for the memo, not a second lookup with an opinion.
       * `-1` is unreachable and says so rather than pretending to be a rate.
       */
      forfeitBp: bp ?? -1,
    });

    return amount;
  }

  /**
   * The order was replaced by a revision. Close the schedule and leave the money where it is.
   *
   * Nothing is forfeited and nothing is refunded: the money belongs to the customer's *new*
   * contract, and it moves when that contract is submitted (`carryForward` above). Between the
   * two the ancestor sits in `order_payment_queue_bucket()`'s `terminal_holding_money`, which is
   * plan 7.8's "bucket that must be visible" doing exactly its job — a revision the customer
   * never submits is money the company is still holding, and somebody has to see that.
   */
  async onSuperseded(tx: LedgerTx, orderId: string): Promise<void> {
    await this.schedule.close({ tx, orderId }, 'superseded');
  }

  /**
   * The job was delivered. The money stops being the customer's and becomes revenue.
   *
   * Once per order — `revenue_recognised` is checked for rather than assumed, because
   * `delivered` is reachable only once today but "reachable only once" is a property of a table
   * of transitions that a future migration edits with one INSERT.
   */
  async onDelivered(tx: LedgerTx, input: { readonly orderId: string; readonly eventId: string }): Promise<void> {
    if (await this.ledgerRepository.hasEntryOfKind(input.orderId, 'revenue_recognised', tx)) return;

    const terms = await this.lifecycle.orderMoneyTerms(tx, input.orderId);
    const total = terms?.grandTotalThbMinor;
    if (total === undefined || total === null || total <= 0n) return;

    const held = (await this.ledgerRepository.money(input.orderId, tx)).heldThbMinor;

    await this.ledger.recordRevenueRecognised(tx, {
      orderId: input.orderId,
      grandTotalThbMinor: total,
      heldThbMinor: held,
      eventId: input.eventId,
    });
  }
}
