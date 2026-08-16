import { Injectable } from '@nestjs/common';
import type { OrderStatus } from '@wewin/db/schema';
import { encodeInstalment, type PaymentScheduleWire } from '@wewin/contract/schedule';
import { encodeThb } from '@wewin/contract/order';

import { withTranslatedOrderErrors } from '../../orders/pg-errors';
import type { Tx } from '../../orders/order.repository';
import { SCHEDULE_EDITABLE_STATUSES } from './defaults';
import {
  notEditableError,
  scheduleExistsError,
  scheduleFailureError,
  scheduleHasMoneyError,
} from './errors';
import {
  isLocked,
  planSchedule,
  recomputeSchedule,
  scheduledDepositMinor,
  type PlannedInstalment,
} from './plan';
import { ScheduleRepository, type StoredInstalment } from './schedule.repository';
import { payInFullTerms, type ScheduleTerm } from './terms';

/**
 * The instalment schedule: authoring it, computing it, and recomputing it when the total
 * moves.
 *
 * ── What the caller owes this service, in every method ───────────────────────────
 *
 * A transaction it opened, the order's **status**, and the order's
 * **`grand_total_thb_minor`** as it stands *in that transaction*. Not an order id to go and
 * look up — see the repository's note on why there is no loader here — and not a total from
 * a request body. Two consequences follow and both are load-bearing:
 *
 *   **The caller must have written the total before calling.** `assert_order_schedule()` is
 *   run at the end of every write here, and it compares the instalments against
 *   `orders.grand_total_thb_minor` as the row stands *now*. Recomputing before the new total
 *   is written asserts against the old one and passes for the wrong reason.
 *
 *   **The caller must hold the row lock.** Two concurrent repricings would otherwise each
 *   read the schedule, each compute a consistent set of instalments, and the second would
 *   overwrite the first with rows derived from a total that had already changed. The lock is
 *   `OrdersService`'s, taken at the top of every mutation, and this service deliberately
 *   cannot take one — asking it to would be asking it to load an order.
 *
 * ── The one number this module hands upward ──────────────────────────────────────
 *
 * `scheduledDepositMinor(instalments)` is the figure the submit path pins into
 * `orders.scheduled_deposit_thb_minor`. Plan 7.13 is unambiguous that there is **one**
 * definition of it, because three implementations differed by ฿12,902 on the same 30/70
 * order and it is the ceiling on what a customer gets back.
 *
 * ⚠️ AND THERE USED TO BE A SECOND ONE. `orders.service.ts` used to pin the deposit with
 * `divRoundHalfUp(grandTotal × SCHEDULED_DEPOSIT_BP_DEFAULT, 10000)`, which agreed with this
 * module's fold *only* while the default gate coverage was payment in full — the day sales
 * authored a 30/70, that path pinned 100% of the order as the forfeit ceiling while the
 * schedule said 30%, plan 7.8's ฿18,432-instead-of-฿5,530 exactly. `orders.service.ts` now
 * calls `LifecycleService.pinsForSubmit`, which calls this module and nothing else — that
 * function is gone, and `tests/payments/schedule/deposit-seam.test.ts` is the regression
 * guard against its shortcut coming back, not evidence that it is still in the tree.
 */

export interface ScheduleContext {
  readonly tx: Tx;
  readonly orderId: string;
  readonly status: OrderStatus;
  /** As written in this transaction. Always VAT-inclusive — plan 4.4. */
  readonly grandTotalThbMinor: bigint;
}

export interface RecomputeResult {
  readonly instalments: readonly PlannedInstalment[];
  /** The `seq`s whose `due` actually moved. Empty is the ordinary answer for a re-save. */
  readonly changedSeqs: readonly number[];
  /** False when the order has no schedule yet, which is not an error — a draft owes nothing. */
  readonly hadSchedule: boolean;
}

@Injectable()
export class ScheduleService {
  constructor(private readonly repository: ScheduleRepository) {}

  /**
   * Write the schedule for an order that has none — the submit path.
   *
   * The default terms are payment in full (plan 13's gate floor), which is *one instalment*
   * and not "no schedule". Everything downstream then reads a schedule whatever the deposit
   * arrangement is, and the zero-deposit case stops being a branch.
   */
  async open(
    context: ScheduleContext,
    terms: readonly ScheduleTerm[] = payInFullTerms(),
  ): Promise<readonly PlannedInstalment[]> {
    return this.openPlanned(context, this.plan(context.grandTotalThbMinor, terms));
  }

  /**
   * Evaluate terms against a total, with no database anywhere near it.
   *
   * Split out of `open` because the submit path needs the answer **before** it writes the
   * order: `orders_submitted_shape` requires `scheduled_deposit_thb_minor` to be present in
   * the same statement that stamps `submitted_at`, and the deposit is a fold over these
   * instalments (plan 7.13). Planning twice — once to pin, once to write — would be two
   * evaluations of one schedule, which is precisely the shape of the seam this module exists
   * to close, so the caller plans once and hands the result to `openPlanned`.
   */
  plan(
    grandTotalThbMinor: bigint,
    terms: readonly ScheduleTerm[] = payInFullTerms(),
  ): readonly PlannedInstalment[] {
    const plan = planSchedule(grandTotalThbMinor, terms);
    if (!plan.ok) throw scheduleFailureError(plan.failure);
    return plan.instalments;
  }

  /** Write instalments that have already been planned. See `plan`. */
  async openPlanned(
    context: ScheduleContext,
    instalments: readonly PlannedInstalment[],
  ): Promise<readonly PlannedInstalment[]> {
    this.assertEditable(context);

    const plan = { ok: true as const, instalments };

    return withTranslatedOrderErrors(async () => {
      await this.repository.ensureSchedule(context.tx, context.orderId);

      const existing = await this.repository.load(context.tx, context.orderId);
      if (existing.length > 0) throw scheduleExistsError(existing.map((row) => row.seq));

      await this.repository.insertAll(context.tx, context.orderId, plan.instalments);
      await this.repository.verifySchedule(context.tx, context.orderId);

      return plan.instalments;
    });
  }

  /**
   * Replace the schedule wholesale — the 5c authoring path, with no route on it in 5b.
   *
   * Refused once any money has been allocated, and that refusal is the seam rather than a
   * limitation: editing a schedule that has been paid against is a *recompute*, where locked
   * rows stand and the remainder absorbs, and a delete-and-reinsert would drop the allocation
   * links that make the lock possible in the first place. The database agrees — deleting an
   * allocated instalment raises `restrict_violation` — so this check exists to give the
   * caller the reason rather than the SQLSTATE.
   */
  async replace(
    context: ScheduleContext,
    terms: readonly ScheduleTerm[],
  ): Promise<readonly PlannedInstalment[]> {
    this.assertEditable(context);

    const plan = planSchedule(context.grandTotalThbMinor, terms);
    if (!plan.ok) throw scheduleFailureError(plan.failure);

    return withTranslatedOrderErrors(async () => {
      await this.repository.ensureSchedule(context.tx, context.orderId);

      const existing = await this.repository.load(context.tx, context.orderId);
      const paid = existing.filter((row) => row.allocatedThbMinor > 0n);
      if (paid.length > 0) throw scheduleHasMoneyError(paid);

      await this.repository.deleteAll(context.tx, context.orderId);
      await this.repository.insertAll(context.tx, context.orderId, plan.instalments);
      await this.repository.verifySchedule(context.tx, context.orderId);

      return plan.instalments;
    });
  }

  /**
   * Replace with instalments that have already been planned — `replace` as `openPlanned` is to
   * `open`, and for the identical reason.
   *
   * A re-issue has to pin `orders.scheduled_deposit_thb_minor` in the *same statement* that
   * moves the totals, because `assert_order_schedule()` foots the instalments against the row —
   * so the row must be written before these instalments and the deposit must be known before
   * the row. Planning here as well as at the pin would be the two evaluations of one schedule
   * this module exists to prevent.
   */
  async replacePlanned(
    context: ScheduleContext,
    instalments: readonly PlannedInstalment[],
  ): Promise<readonly PlannedInstalment[]> {
    this.assertEditable(context);

    return withTranslatedOrderErrors(async () => {
      await this.repository.ensureSchedule(context.tx, context.orderId);

      const existing = await this.repository.load(context.tx, context.orderId);
      const paid = existing.filter((row) => row.allocatedThbMinor > 0n);
      if (paid.length > 0) throw scheduleHasMoneyError(paid);

      await this.repository.deleteAll(context.tx, context.orderId);
      await this.repository.insertAll(context.tx, context.orderId, instalments);
      await this.repository.verifySchedule(context.tx, context.orderId);

      return instalments;
    });
  }

  /**
   * The total moved. Lock what money has touched, re-derive the rest, let the remainder
   * absorb the difference — plan 7.5(ง).
   *
   * Accepts `draft`, `awaiting_payment` **and `redesign`**. The third is the one that gets
   * left out and it is the one that matters most: work bounced by the factory always lands
   * in `redesign`, plan 7.2 says the fix is usually more expensive than what it replaced,
   * and the deposit is already in hand — so this is exactly the path where a schedule has to
   * be re-cut around locked money.
   */
  async recompute(context: ScheduleContext): Promise<RecomputeResult> {
    this.assertEditable(context);

    const stored = await this.repository.load(context.tx, context.orderId);
    if (stored.length === 0) {
      /*
       * No schedule to move. A draft that was never submitted has no instalments and owes
       * nothing, and `assert_order_schedule()` returns early for exactly the same reason —
       * so this is the database's own reading of the case, not a convenience.
       */
      return { instalments: [], changedSeqs: [], hadSchedule: false };
    }

    const plan = recomputeSchedule(context.grandTotalThbMinor, stored);
    if (!plan.ok) throw scheduleFailureError(plan.failure);

    const byId = new Map(stored.map((row) => [row.seq, row]));
    const changed = plan.instalments.filter((instalment) => {
      const before = byId.get(instalment.seq);
      return before !== undefined && before.dueThbMinor !== instalment.dueThbMinor;
    });

    return withTranslatedOrderErrors(async () => {
      for (const instalment of changed) {
        const before = byId.get(instalment.seq);
        if (before === undefined) continue;
        await this.repository.updateDue(context.tx, before.id, instalment.dueThbMinor);
      }

      await this.repository.verifySchedule(context.tx, context.orderId);

      return {
        instalments: plan.instalments,
        changedSeqs: changed.map((instalment) => instalment.seq),
        hadSchedule: true,
      };
    });
  }

  /**
   * Stamp the schedule closed, in the same transaction as the cancellation.
   *
   * Not a transition and not a decision about money: it is the fact that stops the footing
   * assertion applying, which plan 7.5(ก) requires or cancelling an order that holds money
   * is unrepresentable. What happens to the money it still holds is the forfeit and refund
   * question, and it belongs to another module.
   */
  async close(context: Omit<ScheduleContext, 'grandTotalThbMinor' | 'status'>, reason: 'cancelled' | 'superseded'): Promise<void> {
    await withTranslatedOrderErrors(async () => {
      await this.repository.close(context.tx, context.orderId, reason);
    });
  }

  /** The deposit obligation this schedule implies — the figure the submit path pins. */
  depositMinor(instalments: readonly PlannedInstalment[]): bigint {
    return scheduledDepositMinor(instalments);
  }

  /** The schedule as a client reads it. No route serves this in 5b; the shape is the seam. */
  async view(context: ScheduleContext): Promise<PaymentScheduleWire> {
    const rows = await this.repository.load(context.tx, context.orderId);
    const closed = await this.repository.closedState(context.tx, context.orderId);
    const settledThroughSeq = await this.repository.settledThrough(context.tx, context.orderId);

    return {
      orderId: context.orderId,
      grandTotalThbMinor: encodeThb(context.grandTotalThbMinor),
      scheduledDepositThbMinor: encodeThb(scheduledDepositMinor(rows)),
      settledThroughSeq,
      closedAt: closed?.closedAt?.toISOString() ?? null,
      closedReason: closed?.closedReason ?? null,
      instalments: rows.map((row: StoredInstalment) => encodeInstalment(row)),
    };
  }

  /** `allocated > 0` and not a remainder — exported so a caller can grey a row out. */
  isLocked(row: StoredInstalment): boolean {
    return isLocked(row);
  }

  private assertEditable(context: ScheduleContext): void {
    if (!SCHEDULE_EDITABLE_STATUSES.includes(context.status)) {
      throw notEditableError(context.status, SCHEDULE_EDITABLE_STATUSES);
    }
  }
}
