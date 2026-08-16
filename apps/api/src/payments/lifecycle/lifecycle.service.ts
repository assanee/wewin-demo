import { Injectable, Logger } from '@nestjs/common';
import type { FaultParty, OrderStatus } from '@wewin/db/schema';

import { AppError } from '../../common/errors/app-error';
import { LedgerRepository, LedgerService, type LedgerTx } from '../ledger';
import {
  ScheduleService,
  depositPercentTerms,
  payInFullTerms,
  type PlannedInstalment,
  type ScheduleTerm,
} from '../schedule';
import { LifecycleRepository } from './lifecycle.repository';

/**
 * What cancelling an order right now would do to the money it holds.
 *
 * Produced by `PaymentLifecycleService.priceCancellation` and consumed by two callers who must
 * never disagree — the cancellation itself, and the preview a customer is shown before they
 * confirm. See that method for why this is one type and not two.
 *
 * `policyId` is `null` only when nothing is held, which is the one case that needs no policy.
 */
export interface CancellationPrice {
  /** Money in hand, from `order_held_thb_minor()`. Not cash, not the grand total. */
  readonly heldThbMinor: bigint;
  /** What the pinned policy keeps. `order_forfeit_thb_minor()`'s answer, never a second one. */
  readonly forfeitThbMinor: bigint;
  /** What comes back: `held − forfeit`, which is what the refund path reads after the debit. */
  readonly refundThbMinor: bigint;
  /** The policy pinned at submit, whose rate priced this. `null` when nothing is held. */
  readonly policyId: string | null;
}

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
   * The two figures a customer's payment screen needs, from one read.
   *
   * `LedgerRepository.money()` and `SlipsRepository.orderMoney()` are two callers of the SQL
   * folds these come from. This is the third, and it exists *because* `OrdersModule` may not
   * import `SlipsModule` (see the module-level note above): the customer figures have to reach
   * the same folds through this module's one seam rather than by opening a second path to
   * them, let alone by re-deriving `outstanding` from `grandTotal − Σ(accepted slips)` — which
   * disagrees with the fold the moment a slip carries `unallocated_thb_minor` or an order has
   * more than one instalment.
   *
   * ── ⚠️ Two figures and not one, because they answer different questions ──────────
   *
   * `outstanding` is everything still owed on the order — `grand_total_thb_minor` minus
   * `order_settled_thb_minor()`, folding every instalment's accepted allocations rather than
   * only the gate's. It is what the screen *states*.
   *
   * `nextDue` is the owner's rule for what the amount field *opens on*: *"ถ้าเป็นเคสที่ระบุว่าต้อง
   * มัดจำ จึงจะมัดจำ ถ้าไม่ได้ระบุให้ใช้ยอดเต็มเลย"* — the remainder of the first unsettled
   * instalment. There is no branch for "has a deposit" because `payInFullTerms()` is a schedule
   * of one row rather than the absence of one (`terms.ts` says so at length), so a deposit
   * schedule and a pay-in-full schedule are the same fold reading two shapes. It is 0 when
   * nothing is due — settled in full, or a draft with no schedule.
   *
   * The two are equal on a pay-in-full order and differ by the balance on every 30/70. A screen
   * that opened on `outstanding` while the quotation promised the deposit is the mismatch this
   * pair exists to close, so they are returned together and never derived from one another.
   *
   * One `money()` call: both are columns on the same select, so the second question is free.
   */
  async customerFigures(orderId: string): Promise<{
    readonly outstandingThbMinor: bigint;
    readonly nextDueThbMinor: bigint;
    /**
     * ⭐ How much of this balance was forgiven rather than paid — 0048's third fold.
     *
     * On the *customer's* figures because the customer's screen is the one that would otherwise
     * lie: `outstanding <= 0` used to be enough to print *"ออเดอร์นี้ชำระครบแล้ว"*, and after a
     * write-off that sentence is false in the one direction that matters. See
     * `apps/web/src/components/payment/paymentPanel.ts`.
     */
    readonly writtenOffThbMinor: bigint;
  }> {
    const money = await this.ledgerRepository.money(orderId);
    return {
      outstandingThbMinor: money.outstandingThbMinor,
      nextDueThbMinor: money.nextDueThbMinor,
      writtenOffThbMinor: money.writtenOffThbMinor,
    };
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
   *
   * ── `depositBp` is the company's setting, and it arrives as an argument ──────────
   *
   * `organisation_profile.deposit_bp`, read by `OrdersService.submit` in the transaction it
   * already owns and handed down. This service takes no port and reads no settings: the schedule
   * has to be planned inside a transaction that has already locked the order and priced the
   * document, and a second read here could see a different value from the one the gate measures
   * against — which is the ฿12,902 seam wearing a new hat.
   */
  /**
   * ⭐ The terms a given deposit policy produces — the one rule, named once.
   *
   * Extracted so a **re-issue** plans from exactly the same rule a submit did. Two spellings of
   * "what a 30% deposit means" is how a revision comes to owe a different shape from the
   * contract it replaces, and the comment inside `pinsForSubmit` is about a real case where
   * two ways of writing the same policy produced a different row count.
   */
  termsFor(depositBp: number): readonly ScheduleTerm[] {
    return depositBp === 10_000 ? payInFullTerms() : depositPercentTerms(depositBp);
  }

  async pinsForSubmit(
    tx: LedgerTx,
    grandTotalThbMinor: bigint,
    depositBp: number,
  ): Promise<{
    readonly instalments: readonly PlannedInstalment[];
    readonly scheduledDepositThbMinor: bigint;
    readonly forfeitPolicyId: string;
  }> {
    /*
     * ⚠️ At payment in full, keep the terms submit has always produced.
     *
     * `depositPercentTerms(10_000)` is not wrong, just *different*: a gating `percent` row for
     * the whole total plus a `remainder` due ฿0.00, where submit produces one `remainder` row due
     * the whole total. Both foot, both gate the same amount, and the deposit pinned off either is
     * identical — but one is two rows and the other is one, and
     * `tests/payments/lifecycle/lifecycle.pg.test.ts:188` asserts the count. Changing the default
     * configuration's behaviour is not part of making the number configurable, and a feature
     * nobody switched on must not reshape the schedule of every order in the system.
     */
    const instalments = this.schedule.plan(
      grandTotalThbMinor,
      this.termsFor(depositBp),
    );

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

  /**
   * ⭐ The schedule a **re-issue** leaves behind, planned from the same rule a submit planned.
   *
   * `replace` and not `recompute`, and the two are genuinely different answers:
   *
   *   `recompute` keeps the instalments that exist and moves the difference into the remainder
   *   — the right behaviour when the total changes under a schedule somebody is *paying*.
   *
   *   `replace` re-derives the whole schedule from the deposit policy, which is what a re-issue
   *   means: the customer has not paid, the contract is being written again, and the deposit
   *   they are about to be asked for is a share of the new total rather than of the old one.
   *
   * A 30% deposit on a ฿100,000 quote that becomes ฿80,000 is ฿24,000 — `recompute` would have
   * left the ฿30,000 deposit standing and taken the whole ฿20,000 off the balance, which is a
   * deposit of 37.5% nobody chose.
   *
   * ⚠️ `replace` itself refuses when any instalment has an allocation. That refusal stays where
   * it is and is not the one a caller should rely on: `QuotesService.assertNoMoney` runs first,
   * says *why* in the customer's terms, and names the amount held. This one is the backstop for
   * a caller that forgets — and the schedule module's own invariant, which is not this feature's
   * to weaken.
   *
   * ⚠️ Split in two — `pinsForReissue` plans and `replaceScheduleForReissue` writes — for the
   * reason `plan`/`openPlanned` are split on the submit path: the deposit has to be pinned in
   * the same statement that moves the totals, and the instalments can only be written after
   * that statement, so the caller plans once and hands the answer to both. Planning twice would
   * be two evaluations of one schedule, which is the arithmetic `pinsForSubmit`'s comment
   * records a red team finding ฿13,805.57 of disagreement in.
   */
  pinsForReissue(
    grandTotalThbMinor: bigint,
    depositBp: number,
  ): {
    readonly instalments: readonly PlannedInstalment[];
    readonly scheduledDepositThbMinor: bigint;
  } {
    const instalments = this.schedule.plan(grandTotalThbMinor, this.termsFor(depositBp));
    return { instalments, scheduledDepositThbMinor: this.schedule.depositMinor(instalments) };
  }

  /**
   * Write what `pinsForReissue` planned, after the order row has moved.
   *
   * No forfeit policy is re-pinned and no money is carried: neither of those is a thing a
   * re-issue does. The policy an order was accepted under is a term of the contract that was
   * made when it was submitted, and there is no ancestor here — a re-issue revises *this*
   * order rather than superseding it.
   */
  async replaceScheduleForReissue(
    tx: LedgerTx,
    input: {
      readonly orderId: string;
      readonly status: OrderStatus;
      readonly grandTotalThbMinor: bigint;
      readonly instalments: readonly PlannedInstalment[];
    },
  ): Promise<void> {
    await this.schedule.replacePlanned(
      {
        tx,
        orderId: input.orderId,
        status: input.status,
        grandTotalThbMinor: input.grandTotalThbMinor,
      },
      input.instalments,
    );
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
  /**
   * ⭐ What a cancellation would cost, without performing one — and the ONLY reader of that.
   *
   * `onCancelled` below prices its forfeit by calling this, and so does
   * `GET /orders/:orderId/cancellation-preview`. That is the whole point: the figure a customer
   * is shown before they confirm and the figure the ledger keeps afterwards cannot disagree,
   * because they are not two answers — they are one call made twice. A screen promising one
   * number while the ledger keeps another is the plan-7.13 family this repository keeps finding
   * (`scheduledDepositMinor` written three ways, answering ฿5,530 and ฿18,432 for the same
   * order), and a preview with its own arithmetic would have been the next one.
   *
   * The arithmetic is not here and must never be: `order_forfeit_thb_minor()` is the definition
   * and `LedgerRepository` calls it. What *is* here is the sequencing SQL cannot do for itself —
   * whether any money is held at all, and which policy the order pinned. Those two steps are
   * what a second caller would have had to duplicate, so they moved here instead.
   *
   * ⚠️ The `held <= 0` short-circuit comes *before* the policy lookup, and the order is
   * load-bearing: an order holding nothing forfeits nothing whether or not it ever pinned a
   * policy, and a draft has not pinned one — the pin happens at submit. Checking the policy
   * first would refuse to price the cancellation of an empty cart, which is the one
   * cancellation that is always free.
   *
   * `refundThbMinor` is `held − forfeit` because that is what the refund path independently
   * arrives at: `RefundsService.request` refunds `money.heldThbMinor`, read *after* this
   * forfeit has been debited from `deposit_held`. Stating it here is what lets a customer be
   * told what comes back, not merely what is kept.
   */
  async priceCancellation(
    tx: LedgerTx,
    input: {
      readonly orderId: string;
      readonly fromStatus: OrderStatus;
      readonly fault: FaultParty;
    },
  ): Promise<CancellationPrice> {
    const held = (await this.ledgerRepository.money(input.orderId, tx)).heldThbMinor;
    if (held <= 0n) {
      return { heldThbMinor: 0n, forfeitThbMinor: 0n, refundThbMinor: 0n, policyId: null };
    }

    const terms = await this.lifecycle.orderMoneyTerms(tx, input.orderId);
    const policyId = terms?.forfeitPolicyId;

    if (policyId === undefined || policyId === null) {
      throw AppError.conflict(
        'ออร์เดอร์นี้ถือเงินอยู่แต่ไม่มีนโยบายการริบที่ตรึงไว้ตอนทำสัญญา — คิดยอดริบไม่ได้',
        { reason: 'no_pinned_forfeit_policy', heldThbMinor: held.toString() },
      );
    }

    const forfeitThbMinor = await this.ledgerRepository.forfeitThbMinor(
      input.orderId,
      input.fromStatus,
      input.fault,
      policyId,
      tx,
    );

    return {
      heldThbMinor: held,
      forfeitThbMinor,
      refundThbMinor: held - forfeitThbMinor,
      policyId,
    };
  }

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

    const price = await this.priceCancellation(tx, {
      orderId: input.orderId,
      fromStatus: input.fromStatus,
      fault: input.fault,
    });

    const amount = price.forfeitThbMinor;
    if (amount <= 0n) return 0n;

    /*
     * Unreachable, and stated rather than narrowed away: a positive forfeit requires money held,
     * and money held requires a pinned policy — `priceCancellation` refuses otherwise. A silent
     * `return 0n` here would turn a broken invariant into a free cancellation.
     */
    const { policyId } = price;
    if (policyId === null) {
      throw new Error(
        `payments: order ${input.orderId} priced a forfeit of ${amount} with no pinned policy`,
      );
    }

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
