import { describe, expect, it } from 'vitest';

import { allocationPlan, type Draft } from '../src/components/slips/allocation-plan';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The arithmetic the slip reviewer is doing, made explicit.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `acceptSlipRequestSchema` has no "just accept it" shape, deliberately: plan 7.6 asks for a
 * two-column comparison **rather than a confirm button**, and a body that could be empty is a
 * confirm button however the screen in front of it is drawn. So the reviewer states where
 * every satang goes, and this is the sum that decides whether they may press the button.
 *
 * Three outcomes, and the third is the one the API added a field for:
 *
 *   balanced     allocations sum to the slip. Accept.
 *   short        they sum to less, with no excess named. The remainder would vanish.
 *   over         the slip is bigger than the order can absorb — a ฿20,000 transfer against a
 *                ฿19,722.24 order. `acknowledgeOverpaymentThbMinor` makes the reviewer *name*
 *                the ฿277.76, and it has to match, so a mistyped allocation is refused rather
 *                than quietly absorbed as excess.
 *
 * Everything is `bigint` satang. A `number` here is a rounding decision hiding on the way to
 * a screen, which is the whole reason this codebase has no floats in money at all.
 */

const draft = (...amounts: readonly bigint[]): readonly Draft[] =>
  amounts.map((amountThbMinor, index) => ({
    instalmentId: `00000000-0000-4000-8000-00000000000${index}`,
    amountThbMinor,
  }));

describe('the plan balances, or it says how it does not', () => {
  it('is ready when the allocations sum to the slip exactly', () => {
    const plan = allocationPlan(1_000_000n, 1_000_000n, draft(300_000n, 700_000n));

    expect(plan.allocated).toBe(1_000_000n);
    expect(plan.differenceThbMinor).toBe(0n);
    expect(plan.state).toBe('balanced');
    expect(plan.acknowledgement).toBeNull();
  });

  it('⚠️ refuses a short plan rather than letting the remainder vanish', () => {
    /*
     * The failure this catches is the quiet one. Allocating ฿3,000 of a ฿10,000 transfer is a
     * legal-looking request — the API would take it — and the other ฿7,000 becomes
     * `unallocated_thb_minor`, money the company has received and no instalment knows about.
     * The button is disabled instead, and the difference is on the screen.
     */
    const plan = allocationPlan(1_000_000n, 1_000_000n, draft(300_000n));

    expect(plan.differenceThbMinor).toBe(-700_000n);
    expect(plan.state).toBe('short');
  });

  it('⭐ makes an overpayment be named exactly, not merely acknowledged', () => {
    /*
     * ฿20,000.00 against an order that can absorb ฿19,722.24. The excess is ฿277.76, and the
     * point of the field is that a *mistyped allocation* produces a different excess and is
     * therefore refused — an acknowledgement checkbox would have accepted both.
     *
     * ฿20,000.00 transferred · ฿19,722.24 the order can absorb · ฿277.76 left over.
     */
    const plan = allocationPlan(2_000_000n, 1_972_224n, draft(1_972_224n));

    expect(plan.state).toBe('over');
    expect(plan.acknowledgement).toBe(27_776n);
  });

  it('does not offer an acknowledgement when nothing is over', () => {
    expect(allocationPlan(1_000_000n, 1_000_000n, draft(1_000_000n)).acknowledgement).toBeNull();
    expect(allocationPlan(1_000_000n, 1_000_000n, draft(400_000n)).acknowledgement).toBeNull();
  });

  it('⚠️ treats an empty plan as short, never as balanced', () => {
    /*
     * `z.array(...).min(1)`. A zero-allocation body is refused by the API, and a screen that
     * called an empty plan "balanced" would offer an enabled button that always 422s — the
     * worst combination, because the reviewer learns the rule from a failure instead of from
     * the form.
     */
    const plan = allocationPlan(1_000_000n, 1_000_000n, []);

    expect(plan.state).toBe('short');
    expect(plan.allocated).toBe(0n);
  });

  it('ignores a row the reviewer cleared, rather than counting it as zero', () => {
    /*
     * `positiveThbSchema` — an allocation of 0 is refused, so a cleared box has to leave the
     * request rather than travel in it as a zero. The distinction matters because a reviewer
     * clearing one line of three expects the other two to be sent.
     */
    const plan = allocationPlan(1_000_000n, 1_000_000n, draft(1_000_000n, 0n));

    expect(plan.sendable).toHaveLength(1);
    expect(plan.state).toBe('balanced');
  });
});

describe('what actually gets posted', () => {
  it('sends digits, not numbers', () => {
    /*
     * `positiveThbSchema` reads a `MoneyWire` — `{ unit, digits }` — and the digits are a
     * string because satang exceed what a double holds exactly once an order passes about
     * ฿90 trillion. Well beyond this company, and the point is that the type never gives
     * anybody the chance to find out where the boundary is.
     */
    const plan = allocationPlan(1_000_000n, 1_000_000n, draft(300_000n, 700_000n));

    expect(plan.sendable).toStrictEqual([
      {
        instalmentId: '00000000-0000-4000-8000-000000000000',
        amountThbMinor: { unit: 'THB.satang', digits: '300000' },
      },
      {
        instalmentId: '00000000-0000-4000-8000-000000000001',
        amountThbMinor: { unit: 'THB.satang', digits: '700000' },
      },
    ]);
  });
});
