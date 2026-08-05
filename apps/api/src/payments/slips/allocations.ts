import { toBigInt } from '@wewin/contract/exact';
import { encodeThb } from '@wewin/contract/order';

import { AppError } from '../../common/errors/app-error';
import type { MoneyWire } from '@wewin/contract/money';

import type { AllocationRequestWire } from './slips.contract';

/**
 * What a reviewer typed, checked against what is actually owed.
 *
 * ── This is the untrusted input that decides what got paid ───────────────────────
 *
 * Plan 7.8 lists the footing rule among the two things that must be a CHECK and not a
 * matter of discipline, and gives the reason it is easy to miss: *every row involved is
 * individually valid.* The slip is a real slip, each allocation is a positive number
 * against a real instalment, and nothing referential is broken. The only thing wrong is the
 * total — and a total is exactly what a foreign key cannot see.
 *
 * So there are two layers and neither is redundant:
 *
 *   **`slip_allocations_foot`**, a deferred constraint trigger, is the enforcement. It
 *   holds for a transaction typed into psql, for a second service written next year, and
 *   for any path that bypasses this file. It is what makes the rule true.
 *
 *   **This file** is what makes the refusal *legible*. A reviewer who allocated ฿5,529.60
 *   of a ฿5,530.00 slip gets a sentence naming the forty satang, in the field they typed
 *   it in, rather than SQLSTATE 23001 translated into "the order changed, reload".
 *
 * ── The three rules, and the one that is not obvious ─────────────────────────────
 *
 * 1. The allocations sum to the slip, exactly. The database says so too.
 * 2. Every instalment named belongs to *this order*. Money carried to a revision is an
 *    allocation pointing back at the ancestor (plan 7.8), and it is written by the
 *    supersede path with `carried_from_order_id` — never by a reviewer typing an id into a
 *    review screen. A cross-order allocation arriving through this door is refused here and
 *    would be refused again by `slip_allocations_guard_write()`.
 * 3. **No instalment may absorb more than it is still due.** This is the one worth arguing
 *    about, because nothing in the schema forbids it: over-allocating instalment 1 breaks
 *    no constraint, and `order_settled_thb_minor()` still folds the right total. What it
 *    breaks is the frontier — `order_settled_through()` compares `due <= allocated` per
 *    instalment, so money piled onto instalment 1 leaves instalment 2 unsettled while the
 *    customer has paid for both, and the balance instalment then blocks a gate that is
 *    fully funded.
 * 4. **Money the schedule cannot absorb is receivable, and only then.** A slip for more than
 *    the whole order has an excess with nowhere to go; the reviewer states it exactly and it
 *    lands in `payment_slips.unallocated_thb_minor`, held against the order with no instalment
 *    behind it, where a refund can reach it. While the schedule still has room the same
 *    arithmetic is a reviewer who typed too little, and it stays refused. See
 *    `suggestAllocations`.
 */

export interface InstalmentForAllocation {
  readonly id: string;
  readonly seq: number;
  readonly dueThbMinor: bigint;
  /** From accepted slips only. A submitted slip is a photograph, not money. */
  readonly allocatedThbMinor: bigint;
}

/** What this instalment still wants, floored at zero so an over-allocated row cannot go negative. */
export function remainingOf(instalment: InstalmentForAllocation): bigint {
  const remaining = instalment.dueThbMinor - instalment.allocatedThbMinor;
  return remaining > 0n ? remaining : 0n;
}

/**
 * A wire amount as satang.
 *
 * A one-line re-export of `toBigInt` under a name that says which currency this module is
 * in, and it exists so that every site converting money here converts it the same way.
 * `Number()` appears nowhere in this file on purpose, and `Exact` has no readable member,
 * so there is no other way to a number from a `MoneyWire`.
 */
export function thbMinor(value: MoneyWire<'THB'>): bigint {
  return toBigInt(value);
}

export interface AllocationPlan {
  readonly instalmentId: string;
  readonly seq: number;
  readonly amountThbMinor: bigint;
}

export interface CheckAllocationsInput {
  readonly slipAmountThbMinor: bigint;
  readonly allocations: readonly AllocationRequestWire[];
  /** Every instalment of the slip's own order, with what accepted slips have already put on it. */
  readonly instalments: readonly InstalmentForAllocation[];
  /**
   * The reviewer's acknowledgement that this slip is for more than the schedule wants.
   *
   * Undefined means "no overpayment expected" and any excess is refused. A number means the
   * reviewer looked at the image, agrees the money arrived, and states the excess exactly —
   * which is then written to `payment_slips.unallocated_thb_minor` and held against the order
   * with no instalment behind it, where a refund can reach it.
   */
  readonly acknowledgeOverpaymentThbMinor?: bigint | undefined;
}

/** A checked plan, plus the money in it that closed nothing. */
export interface AllocationOutcome {
  readonly allocations: readonly AllocationPlan[];
  readonly unallocatedThbMinor: bigint;
}

/**
 * Turn the request into a plan, or refuse it with a sentence.
 *
 * Returns the plan in `seq` order rather than in the order the reviewer sent it, so that
 * everything downstream — the INSERT, the response, the log line — reads in the order the
 * schedule is read in.
 */
export function planAllocations(input: CheckAllocationsInput): AllocationOutcome {
  const roomOnSchedule = input.instalments.reduce((sum, instalment) => sum + remainingOf(instalment), 0n);

  if (input.allocations.length === 0) {
    /*
     * The one shape of empty request that is not a reviewer forgetting to type: a transfer
     * against an order the schedule has no room for at all — a duplicate payment, or money
     * arriving after the last instalment was settled. Refusing it is the orphan this round
     * closed, moved one step: the money is in the bank either way, and a slip that cannot be
     * accepted is a slip nothing can refund from.
     */
    const wholeSlipAcknowledged =
      roomOnSchedule === 0n && input.acknowledgeOverpaymentThbMinor === input.slipAmountThbMinor;

    if (!wholeSlipAcknowledged) {
      throw AppError.validationFailed(
        'ต้องระบุว่าสลิปนี้ตัดชำระงวดใดบ้าง — การรับสลิปโดยไม่ระบุงวดคือการกดยืนยันเฉยๆ',
        { reason: 'no_allocations' },
      );
    }

    return { allocations: [], unallocatedThbMinor: input.slipAmountThbMinor };
  }

  const byId = new Map(input.instalments.map((instalment) => [instalment.id, instalment]));
  const seen = new Set<string>();
  const plan: AllocationPlan[] = [];
  let total = 0n;

  for (const allocation of input.allocations) {
    if (seen.has(allocation.instalmentId)) {
      throw AppError.validationFailed('ระบุงวดเดียวกันซ้ำสองบรรทัด — ให้รวมเป็นบรรทัดเดียว', {
        reason: 'duplicate_instalment',
        instalmentId: allocation.instalmentId,
      });
    }
    seen.add(allocation.instalmentId);

    const instalment = byId.get(allocation.instalmentId);
    if (instalment === undefined) {
      /*
       * 404 would be the tempting answer and is the wrong one: the instalment may well
       * exist, on another order. Saying "not found" about a row that exists elsewhere is an
       * oracle for probing ids, and 422 is honest — the request named something that is not
       * part of this slip's order.
       */
      throw AppError.validationFailed(
        'งวดที่ระบุไม่ได้อยู่ในตารางงวดของออร์เดอร์นี้ — เงินไม่ย้ายข้ามออร์เดอร์ผ่านหน้าตรวจสลิป',
        { reason: 'instalment_not_on_this_order', instalmentId: allocation.instalmentId },
      );
    }

    const amount = thbMinor(allocation.amountThbMinor);
    const remaining = remainingOf(instalment);

    if (amount > remaining) {
      throw AppError.validationFailed(
        `งวดที่ ${String(instalment.seq)} ค้างอยู่ ${satang(remaining)} แต่ระบุตัดชำระ ${satang(amount)} — ` +
          'ส่วนเกินเป็นของงวดถัดไป ไม่ใช่ของงวดนี้',
        {
          reason: 'over_allocated',
          instalmentId: instalment.id,
          seq: instalment.seq,
          remainingThbMinor: remaining.toString(),
          requestedThbMinor: amount.toString(),
        },
      );
    }

    plan.push({ instalmentId: instalment.id, seq: instalment.seq, amountThbMinor: amount });
    total += amount;
  }

  const unallocatedThbMinor = input.slipAmountThbMinor - total;

  /*
   * ⚠️ THE EXCESS HAS A HOME NOW, AND IT IS THE REVIEWER'S DELIBERATE ACT.
   *
   * This used to be `total !== slipAmount → refuse`, full stop, and the consequence was
   * measured by the red team at ฿277.76 on a ฿19,722.24 order: a ฿20,000.00 transfer could be
   * neither accepted (no room), nor deleted (`payment_slips_guard_write`), nor truthfully
   * rejected — the money was in the bank and `order_held_thb_minor()` was ฿0.00. Refusing a
   * slip does not make the money go away, it makes it invisible.
   *
   * So a *short* allocation is still refused, always: that is the direction plan 7.8's CHECK
   * exists to close, and money that never arrived settling an instalment is the whole attack.
   * An *over* allocation is the reviewer accepting more than the schedule wants, and it is
   * allowed only when they say so — `acknowledgeOverpaymentThbMinor` has to name the exact
   * excess, so a fat-fingered figure is refused rather than absorbed.
   */
  if (unallocatedThbMinor > 0n) {
    /*
     * ⚠️ THE EXCESS IS ONLY AN EXCESS WHEN THE SCHEDULE HAS NOWHERE TO PUT IT.
     *
     * Without this, `acknowledgeOverpaymentThbMinor` turns every *short* allocation into a
     * legal one: a reviewer looking at a ฿5,529.60 photograph who types ฿5,529.20 and forty
     * satang of "excess" gets an accepted slip, an instalment forty satang short, and a gate
     * that stays shut with the money already in the bank — the reviewer's own error recorded
     * as an accounting fact. The acknowledgement exists for money the schedule cannot absorb,
     * and that is a property of the schedule, not of what was typed.
     *
     * So the room left on the whole order after this plan decides which branch this is, and
     * the refusal names the room rather than the difference: the reviewer's next action is to
     * put the money on an instalment, not to argue with a total.
     */
    const roomLeft = roomOnSchedule - total;
    if (roomLeft > 0n) {
      throw AppError.validationFailed(
        `ยอดที่ตัดชำระรวม ${satang(total)} แต่สลิปใบนี้เป็นเงิน ${satang(input.slipAmountThbMinor)} ` +
          `และตารางงวดยังรับได้อีก ${satang(roomLeft)} — เงินที่ยังมีงวดรองรับต้องตัดเข้างวด ไม่ใช่ค้างเป็นเงินรับล่วงหน้า`,
        {
          reason: 'allocations_do_not_foot',
          allocatedThbMinor: total.toString(),
          slipAmountThbMinor: input.slipAmountThbMinor.toString(),
          differenceThbMinor: (total - input.slipAmountThbMinor).toString(),
          scheduleRoomLeftThbMinor: roomLeft.toString(),
        },
      );
    }

    if (input.acknowledgeOverpaymentThbMinor === undefined) {
      throw AppError.validationFailed(
        `สลิปใบนี้เกินยอดที่ตารางงวดรองรับอยู่ ${satang(unallocatedThbMinor)} — ` +
          'ถ้ายืนยันว่าเงินเข้าจริง ให้ระบุยอดส่วนเกินเพื่อรับไว้เป็นเงินรับล่วงหน้าที่ยังไม่ตัดงวดใด',
        {
          reason: 'overpayment_not_acknowledged',
          unallocatedThbMinor: unallocatedThbMinor.toString(),
          slipAmountThbMinor: input.slipAmountThbMinor.toString(),
          allocatedThbMinor: total.toString(),
        },
      );
    }

    if (input.acknowledgeOverpaymentThbMinor !== unallocatedThbMinor) {
      throw AppError.validationFailed(
        `ยอดส่วนเกินที่ยืนยันคือ ${satang(input.acknowledgeOverpaymentThbMinor)} แต่ส่วนเกินจริงคือ ` +
          `${satang(unallocatedThbMinor)} — ตัวเลขต้องตรงกัน`,
        {
          reason: 'overpayment_mismatch',
          acknowledgedThbMinor: input.acknowledgeOverpaymentThbMinor.toString(),
          unallocatedThbMinor: unallocatedThbMinor.toString(),
        },
      );
    }

    return {
      allocations: [...plan].sort((left, right) => left.seq - right.seq),
      unallocatedThbMinor,
    };
  }

  if (total !== input.slipAmountThbMinor) {
    /*
     * The message names both numbers and their difference. A reviewer looking at a
     * photograph of ฿5,530.00 who typed ฿5,529.60 needs to be told which forty satang, not
     * that "the total does not match" — the second sentence sends them back to the image.
     */
    const difference = total - input.slipAmountThbMinor;
    throw AppError.validationFailed(
      `ยอดที่ตัดชำระรวม ${satang(total)} แต่สลิปใบนี้เป็นเงิน ${satang(input.slipAmountThbMinor)} — ` +
        `ต่างกัน ${satang(difference < 0n ? -difference : difference)} · สลิปที่รับแล้วต้องตัดชำระเท่ากับเงินที่เป็นหลักฐานพอดี`,
      {
        reason: 'allocations_do_not_foot',
        allocatedThbMinor: total.toString(),
        slipAmountThbMinor: input.slipAmountThbMinor.toString(),
        differenceThbMinor: difference.toString(),
      },
    );
  }

  return { allocations: [...plan].sort((left, right) => left.seq - right.seq), unallocatedThbMinor: 0n };
}

export interface Suggestion {
  readonly allocations: readonly AllocationRequestWire[] | null;
  /** Null when there is a suggestion. A sentence the reviewer can act on when there is not. */
  readonly unallocatableReasonTh: string | null;
  /** What the first unsettled instalment still wants, for the comparison column. */
  readonly expectedNextDueThbMinor: bigint | null;
}

/**
 * What the server *would* allocate — offered, never applied.
 *
 * The greedy fill down the schedule in `seq` order is the only rule that agrees with the
 * frontier: `order_settled_through()` is a maximum over the settled *prefix*, so filling
 * instalment 3 before instalment 2 settles nothing at all as far as any gate is concerned.
 *
 * An overpayment gets the greedy fill *and* a sentence naming the excess. It used to get
 * neither, and the orphan the red team measured was ฿277.76 on a ฿19,722.24 order: a slip
 * that could be neither accepted (no room), nor deleted (`payment_slips_guard_write`), nor
 * truthfully rejected, with the money in the bank and `order_held_thb_minor()` reading
 * ฿0.00. The excess now has a home the reviewer must name exactly
 * (`acknowledgeOverpaymentThbMinor`) — a deliberate act with their name on it, rather than a
 * number this function invents on their behalf.
 */
export function suggestAllocations(
  slipAmountThbMinor: bigint,
  instalments: readonly InstalmentForAllocation[],
): Suggestion {
  const ordered = [...instalments].sort((left, right) => left.seq - right.seq);
  const firstUnsettled = ordered.find((instalment) => remainingOf(instalment) > 0n);
  const expectedNextDueThbMinor = firstUnsettled === undefined ? null : remainingOf(firstUnsettled);

  let left = slipAmountThbMinor;
  const allocations: AllocationRequestWire[] = [];

  for (const instalment of ordered) {
    if (left === 0n) break;
    const remaining = remainingOf(instalment);
    if (remaining === 0n) continue;

    const take = remaining < left ? remaining : left;
    allocations.push({ instalmentId: instalment.id, amountThbMinor: encodeThb(take) });
    left -= take;
  }

  if (left > 0n) {
    /*
     * There IS a suggestion now, and the excess is named in it. What the reviewer has to do is
     * confirm the number — `acknowledgeOverpaymentThbMinor` — which is a deliberate act with
     * their name on it rather than a slip that could not be accepted at all.
     */
    return {
      allocations,
      unallocatableReasonTh:
        `สลิปใบนี้เกินยอดที่ตารางงวดรองรับอยู่ ${satang(left)} — ` +
        'ถ้ายืนยันว่าเงินเข้าจริง ให้ระบุยอดส่วนเกินนี้เพื่อรับไว้เป็นเงินรับล่วงหน้า แล้วเข้ากระบวนการคืนเงินต่อไป',
      expectedNextDueThbMinor,
    };
  }

  return { allocations, unallocatableReasonTh: null, expectedNextDueThbMinor };
}

/**
 * Satang as baht, for a message a person reads. Never for arithmetic and never for storage.
 *
 * Integer division and a remainder rather than `Number(minor) / 100`: the division is the
 * one operation in this file that could lose a satang, and it does not happen.
 */
function satang(minor: bigint): string {
  const negative = minor < 0n;
  const absolute = negative ? -minor : minor;
  const baht = absolute / 100n;
  const fraction = absolute % 100n;
  return `${negative ? '-' : ''}฿${baht.toLocaleString('en-US')}.${fraction.toString().padStart(2, '0')}`;
}
