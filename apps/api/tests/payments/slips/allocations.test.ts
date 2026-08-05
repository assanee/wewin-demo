import { describe, expect, it } from 'vitest';
import { encodeThb } from '@wewin/contract/order';

import { AppError } from '../../../src/common/errors/app-error';
import {
  planAllocations,
  remainingOf,
  suggestAllocations,
  type InstalmentForAllocation,
} from '../../../src/payments/slips';

/**
 * The reviewer's typing, checked before it becomes money.
 *
 * ── Plan 7.8's numbers, at satang precision ──────────────────────────────────────
 *
 * ฿18,432 VAT-inclusive with a 30% deposit. The plan quotes the deposit as ฿5,530; at
 * satang precision it is ฿5,529.60, and `packages/db/tests/payment.test.ts` pins that the
 * difference is the plan rounding in prose rather than a disagreement. The same figures are
 * used here so that a reader comparing the two files is comparing the same order.
 */

const GRAND = 1_843_200n;
const DEPOSIT = 552_960n;
const BALANCE = GRAND - DEPOSIT;

const instalment = (
  seq: number,
  due: bigint,
  allocated = 0n,
): InstalmentForAllocation => ({
  id: `0000000${String(seq)}-0000-4000-8000-000000000000`,
  seq,
  dueThbMinor: due,
  allocatedThbMinor: allocated,
});

const thirtySeventy = (depositAllocated = 0n): InstalmentForAllocation[] => [
  instalment(1, DEPOSIT, depositAllocated),
  instalment(2, BALANCE),
];

const reasonOf = (run: () => unknown): unknown => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    const details = (error as AppError).details;
    return typeof details === 'object' && details !== null && 'reason' in details
      ? (details as { reason: unknown }).reason
      : undefined;
  }

  throw new Error('expected a refusal, and nothing was thrown');
};

describe('remainingOf', () => {
  it('is what the instalment still wants', () => {
    expect(remainingOf(instalment(1, DEPOSIT, 100_000n))).toBe(DEPOSIT - 100_000n);
  });

  /**
   * Clamped, not signed. An over-allocated instalment is settled and stays settled — a
   * negative remainder would be rendered by a screen as a credit the customer does not have.
   */
  it('never goes negative', () => {
    expect(remainingOf(instalment(1, DEPOSIT, DEPOSIT + 1n))).toBe(0n);
  });
});

describe('planAllocations', () => {
  it('accepts a slip that settles the deposit exactly, and orders the plan by seq', () => {
    const instalments = thirtySeventy();
    const plan = planAllocations({
      slipAmountThbMinor: GRAND,
      /* Deliberately sent out of order: the plan comes back in schedule order regardless. */
      allocations: [
        { instalmentId: instalments[1]?.id ?? '', amountThbMinor: encodeThb(BALANCE) },
        { instalmentId: instalments[0]?.id ?? '', amountThbMinor: encodeThb(DEPOSIT) },
      ],
      instalments,
    });

    expect(plan.allocations.map((line) => line.seq)).toEqual([1, 2]);
    expect(plan.allocations.map((line) => line.amountThbMinor)).toEqual([DEPOSIT, BALANCE]);
    expect(plan.unallocatedThbMinor).toBe(0n);
  });

  /**
   * ⚠️ THE RULE PLAN 7.8 SAYS MUST BE A CHECK AND NOT A MATTER OF DISCIPLINE.
   *
   * Forty satang short of the photograph. The database refuses it too, at COMMIT, with no
   * constraint name; this refusal is what makes the number legible in the field it was typed
   * in — so the assertion is on the *details*, not merely on the throw.
   */
  it('refuses allocations that do not sum to the slip, and reports the difference', () => {
    const instalments = thirtySeventy();

    let caught: AppError | undefined;
    try {
      planAllocations({
        slipAmountThbMinor: DEPOSIT,
        allocations: [{ instalmentId: instalments[0]?.id ?? '', amountThbMinor: encodeThb(DEPOSIT - 40n) }],
        instalments,
      });
    } catch (error) {
      caught = error as AppError;
    }

    expect(caught?.status).toBe(422);
    expect(caught?.details).toMatchObject({
      reason: 'allocations_do_not_foot',
      differenceThbMinor: '-40',
      slipAmountThbMinor: DEPOSIT.toString(),
    });

    /*
     * 6a: this short allocation reaches the *room left* branch, and the key says so.
     *
     * Worth pinning because the two branches share `reason: 'allocations_do_not_foot'` in
     * `details` and say completely different things to the reviewer — "put the money on an
     * instalment" versus "your total does not match the photograph". Before the keys, the
     * only way to tell them apart was to read the Thai.
     */
    expect(caught?.serverMessage?.key).toBe('error.slip.foot_with_room_left');
    /*
     * The whole sentence, not three `toContain`s. Three of the params are money and two of
     * them can be swapped without changing the set of figures in the string — a `toContain`
     * suite passes with `roomLeft` and `slip` exchanged, which tells the reviewer the
     * schedule can absorb ฿5,529.60 when it can absorb ฿12,902.80.
     */
    expect(caught?.message).toBe(
      'ยอดที่ตัดชำระรวม ฿5,529.20 แต่สลิปใบนี้เป็นเงิน ฿5,529.60 ' +
        'และตารางงวดยังรับได้อีก ฿12,902.80 — เงินที่ยังมีงวดรองรับต้องตัดเข้างวด ไม่ใช่ค้างเป็นเงินรับล่วงหน้า',
    );
  });

  /**
   * The other footing branch — the one whose sentence names the difference.
   *
   * Reached by allocating *more* than the slip across instalments that can each take it, so
   * there is no room left over to be told about. `foot_with_room_left` above is the short
   * case; this is the long one, and the two are the reason `differenceThbMinor` and the
   * sentence's `ต่างกัน` are separate things.
   */
  it('names the difference when the allocations exceed the slip', () => {
    const instalments = thirtySeventy();

    let caught: AppError | undefined;
    try {
      planAllocations({
        slipAmountThbMinor: GRAND - 40n,
        allocations: [
          { instalmentId: instalments[0]?.id ?? '', amountThbMinor: encodeThb(DEPOSIT) },
          { instalmentId: instalments[1]?.id ?? '', amountThbMinor: encodeThb(BALANCE) },
        ],
        instalments,
      });
    } catch (error) {
      caught = error as AppError;
    }

    expect(caught?.serverMessage?.key).toBe('error.slip.foot_mismatch');
    /*
     * `ต่างกัน ฿0.40` and never `ต่างกัน -฿0.40`. The message says the figures *differ by*
     * forty satang, so its param is a magnitude — a minus sign in that clause reads as a
     * negative amount of money rather than a shortfall. The signed value is not lost; it is
     * on `differenceThbMinor`, which is where a client reads the direction.
     */
    expect(caught?.message).toContain('ต่างกัน ฿0.40');
    expect(caught?.details).toMatchObject({ differenceThbMinor: '40' });
  });

  /**
   * The rule nothing in the schema forbids: money piled onto instalment 1 leaves instalment
   * 2 unsettled while the customer has paid for both, and the frontier — a maximum over the
   * settled *prefix* — then reports one when the gate is fully funded.
   */
  it('refuses more than an instalment is still due', () => {
    const instalments = thirtySeventy();
    expect(
      reasonOf(() =>
        planAllocations({
          slipAmountThbMinor: GRAND,
          allocations: [{ instalmentId: instalments[0]?.id ?? '', amountThbMinor: encodeThb(GRAND) }],
          instalments,
        }),
      ),
    ).toBe('over_allocated');
  });

  it('counts what previous accepted slips already put on a row', () => {
    const instalments = thirtySeventy(DEPOSIT - 1n);

    /* One satang left on instalment 1, so two is one too many. */
    expect(
      reasonOf(() =>
        planAllocations({
          slipAmountThbMinor: 2n,
          allocations: [{ instalmentId: instalments[0]?.id ?? '', amountThbMinor: encodeThb(2n) }],
          instalments,
        }),
      ),
    ).toBe('over_allocated');
  });

  it('refuses the same instalment twice rather than adding the two lines up', () => {
    const instalments = thirtySeventy();
    const id = instalments[0]?.id ?? '';

    expect(
      reasonOf(() =>
        planAllocations({
          slipAmountThbMinor: DEPOSIT,
          allocations: [
            { instalmentId: id, amountThbMinor: encodeThb(DEPOSIT - 1n) },
            { instalmentId: id, amountThbMinor: encodeThb(1n) },
          ],
          instalments,
        }),
      ),
    ).toBe('duplicate_instalment');
  });

  /**
   * 🔒 A reviewer may not move money sideways.
   *
   * Carrying a payment to a revision order is an allocation on the *ancestor's* slip that is
   * moved forward with `carried_from_order_id`, written by the supersede path (plan 7.8).
   * A review screen naming an instalment of another order is refused here and would be
   * refused again by `slip_allocations_guard_write()`.
   */
  it('refuses an instalment that is not on this slip’s order', () => {
    expect(
      reasonOf(() =>
        planAllocations({
          slipAmountThbMinor: DEPOSIT,
          allocations: [
            { instalmentId: '99999999-9999-4999-8999-999999999999', amountThbMinor: encodeThb(DEPOSIT) },
          ],
          instalments: thirtySeventy(),
        }),
      ),
    ).toBe('instalment_not_on_this_order');
  });

  it('refuses an empty allocation, which is the confirm button plan 7.6 forbids', () => {
    expect(
      reasonOf(() =>
        planAllocations({ slipAmountThbMinor: DEPOSIT, allocations: [], instalments: thirtySeventy() }),
      ),
    ).toBe('no_allocations');
  });

  /**
   * ⚠️ THE ACKNOWLEDGEMENT IS FOR MONEY THE SCHEDULE CANNOT ABSORB — NOT FOR TYPING TOO LITTLE.
   *
   * The excess having a home closed a real orphan (see below), and it opened this if it is
   * left unqualified: a reviewer looking at a ฿5,529.60 photograph who types ฿5,529.20 and
   * acknowledges forty satang gets an accepted slip, an instalment forty satang short, and a
   * gate that stays shut with the money already in the bank. Their own slip is the evidence
   * against them and the system recorded it as an accounting fact.
   *
   * So the branch is decided by the room left on the *schedule*, never by what was typed.
   */
  it('refuses an acknowledged excess while the schedule still has room for it', () => {
    const instalments = thirtySeventy();

    let caught: AppError | undefined;
    try {
      planAllocations({
        slipAmountThbMinor: DEPOSIT,
        allocations: [{ instalmentId: instalments[0]?.id ?? '', amountThbMinor: encodeThb(DEPOSIT - 40n) }],
        instalments,
        acknowledgeOverpaymentThbMinor: 40n,
      });
    } catch (error) {
      caught = error as AppError;
    }

    expect(caught?.details).toMatchObject({
      reason: 'allocations_do_not_foot',
      /* The room is named, because putting the money on an instalment is the next action. */
      scheduleRoomLeftThbMinor: (BALANCE + 40n).toString(),
    });
  });

  /**
   * The other side of the same rule, with plan 7.8's own order.
   *
   * ฿20,000.00 against a ฿18,432.00 schedule: ฿1,568.00 has nowhere to go, the reviewer says
   * so exactly, and it lands in `payment_slips.unallocated_thb_minor` where a refund can reach
   * it. Refusing the slip does not make the money go away, it makes it invisible.
   */
  it('receives an excess the schedule has no room for, when the reviewer names it exactly', () => {
    const instalments = thirtySeventy();
    const outcome = planAllocations({
      slipAmountThbMinor: 2_000_000n,
      allocations: [
        { instalmentId: instalments[0]?.id ?? '', amountThbMinor: encodeThb(DEPOSIT) },
        { instalmentId: instalments[1]?.id ?? '', amountThbMinor: encodeThb(BALANCE) },
      ],
      instalments,
      acknowledgeOverpaymentThbMinor: 156_800n,
    });

    expect(outcome.unallocatedThbMinor).toBe(156_800n);
    expect(outcome.allocations.map((line) => line.seq)).toEqual([1, 2]);
  });

  it('refuses an excess figure that is not the excess', () => {
    const instalments = thirtySeventy();
    expect(
      reasonOf(() =>
        planAllocations({
          slipAmountThbMinor: 2_000_000n,
          allocations: [
            { instalmentId: instalments[0]?.id ?? '', amountThbMinor: encodeThb(DEPOSIT) },
            { instalmentId: instalments[1]?.id ?? '', amountThbMinor: encodeThb(BALANCE) },
          ],
          instalments,
          acknowledgeOverpaymentThbMinor: 156_700n,
        }),
      ),
    ).toBe('overpayment_mismatch');
  });

  /**
   * A duplicate transfer against a fully settled order allocates nothing at all — and it is
   * the one empty request that is not a reviewer forgetting to type. Refusing it would put the
   * orphan back one step to the left: the money is in the bank either way, and a slip that
   * cannot be accepted is a slip nothing can refund from.
   */
  it('receives a whole slip that closes nothing, on a schedule with no room left', () => {
    const outcome = planAllocations({
      slipAmountThbMinor: DEPOSIT,
      allocations: [],
      instalments: [instalment(1, DEPOSIT, DEPOSIT), instalment(2, BALANCE, BALANCE)],
      acknowledgeOverpaymentThbMinor: DEPOSIT,
    });

    expect(outcome.allocations).toEqual([]);
    expect(outcome.unallocatedThbMinor).toBe(DEPOSIT);
  });

  it('still refuses an empty allocation when the acknowledgement is not the whole slip', () => {
    expect(
      reasonOf(() =>
        planAllocations({
          slipAmountThbMinor: DEPOSIT,
          allocations: [],
          instalments: [instalment(1, DEPOSIT, DEPOSIT), instalment(2, BALANCE, BALANCE)],
          acknowledgeOverpaymentThbMinor: DEPOSIT - 1n,
        }),
      ),
    ).toBe('no_allocations');
  });
});

describe('suggestAllocations', () => {
  /**
   * The greedy fill is down the schedule in `seq` order, because that is the only rule that
   * agrees with the frontier: filling instalment 2 before instalment 1 settles nothing at all
   * as far as any gate is concerned.
   */
  it('fills the settled prefix, in order', () => {
    const suggestion = suggestAllocations(GRAND, thirtySeventy());

    expect(suggestion.unallocatableReasonTh).toBeNull();
    expect(suggestion.allocations).toEqual([
      { instalmentId: thirtySeventy()[0]?.id, amountThbMinor: encodeThb(DEPOSIT) },
      { instalmentId: thirtySeventy()[1]?.id, amountThbMinor: encodeThb(BALANCE) },
    ]);
    expect(suggestion.expectedNextDueThbMinor).toBe(DEPOSIT);
  });

  it('stops when the slip runs out', () => {
    const suggestion = suggestAllocations(DEPOSIT, thirtySeventy());
    expect(suggestion.allocations).toHaveLength(1);
    expect(suggestion.allocations?.[0]?.amountThbMinor).toEqual(encodeThb(DEPOSIT));
  });

  it('skips instalments that are already settled', () => {
    const suggestion = suggestAllocations(BALANCE, thirtySeventy(DEPOSIT));

    expect(suggestion.expectedNextDueThbMinor).toBe(BALANCE);
    expect(suggestion.allocations).toEqual([
      { instalmentId: thirtySeventy()[1]?.id, amountThbMinor: encodeThb(BALANCE) },
    ]);
  });

  /**
   * An overpayment gets the fill *and* the sentence.
   *
   * It used to get neither: with `SUM(allocations) = slip.amount` as the only rule, a
   * ฿20,000.00 transfer against ฿18,432.00 of schedule was a slip that could be neither
   * accepted, nor deleted (`payment_slips_guard_write`), nor truthfully rejected — ฿1,568.00
   * in the bank and ฿0.00 in `order_held_thb_minor()`. The suggestion now fills the schedule
   * to the brim and names the excess the reviewer has to confirm.
   */
  it('fills what it can and names the excess it cannot place', () => {
    const suggestion = suggestAllocations(GRAND + 156_800n, thirtySeventy());

    expect(suggestion.allocations).toEqual([
      { instalmentId: thirtySeventy()[0]?.id, amountThbMinor: encodeThb(DEPOSIT) },
      { instalmentId: thirtySeventy()[1]?.id, amountThbMinor: encodeThb(BALANCE) },
    ]);
    expect(suggestion.unallocatableReasonTh).toContain('฿1,568.00');
  });

  it('has no expectation when everything is settled', () => {
    const suggestion = suggestAllocations(1n, [
      instalment(1, DEPOSIT, DEPOSIT),
      instalment(2, BALANCE, BALANCE),
    ]);

    expect(suggestion.expectedNextDueThbMinor).toBeNull();
    /* Nothing to fill, and the whole satang is named as the part that closes nothing. */
    expect(suggestion.allocations).toEqual([]);
    expect(suggestion.unallocatableReasonTh).toContain('฿0.01');
  });
});
