import { describe, expect, it } from 'vitest';

import { divRoundHalfUp } from '@wewin/core/money';

import {
  BP_DENOMINATOR,
  SCHEDULED_DEPOSIT_BP_DEFAULT,
} from '../../../src/orders/defaults';
import { GATE_COVERAGE_BP_DEFAULT } from '../../../src/payments/schedule/defaults';
import { planSchedule, scheduledDepositMinor } from '../../../src/payments/schedule/plan';
import { depositPercentTerms, payInFullTerms } from '../../../src/payments/schedule/terms';

/**
 * ⚠️ THE SEAM PLAN 7.13 NAMES, WITH BOTH IMPLEMENTATIONS STILL IN THE TREE.
 *
 * `scheduledDepositMinor` is supposed to be **one** function. It decides how much of a
 * customer's money may be kept when they walk away, and three designs produced ฿5,530 and
 * ฿18,432 for the same 30/70 order — a difference of ฿12,902 on one small window.
 *
 * Today there are two:
 *
 *   `orders.service.ts`  pins `divRoundHalfUp(grandTotal × SCHEDULED_DEPOSIT_BP_DEFAULT, 10000)`
 *   this module          folds the gated prefix of the schedule
 *
 * They agree, and they agree **only because the default gate coverage is payment in full**.
 * The first two tests hold that agreement in place. The third states the exposure as an
 * executable fact rather than as a paragraph: on a 30/70 the two formulas answer differently,
 * and the answer the forfeit reads is the pinned one.
 *
 * The fix is one line in `apps/api/src/orders/orders.service.ts` — pin what this module
 * returns — and that file belongs to another part of this phase. Until it lands, a schedule
 * with a real deposit pins a forfeit ceiling of 100% of the order.
 */

const TOTALS = [1_843_200n, 940_637n, 1n, 999_999_999n];

describe('the scheduled deposit has two implementations, and they must not drift', () => {
  it('agrees with the submit path for payment in full, on every total', () => {
    for (const total of TOTALS) {
      const plan = planSchedule(total, payInFullTerms());
      expect(plan.ok).toBe(true);
      if (!plan.ok) return;

      const pinned = divRoundHalfUp(total * BigInt(SCHEDULED_DEPOSIT_BP_DEFAULT), BP_DENOMINATOR);
      expect(scheduledDepositMinor(plan.instalments)).toBe(pinned);
    }
  });

  it('agrees only because both defaults say the same thing', () => {
    expect(SCHEDULED_DEPOSIT_BP_DEFAULT).toBe(GATE_COVERAGE_BP_DEFAULT);
    expect(GATE_COVERAGE_BP_DEFAULT).toBe(10_000);
  });

  /**
   * Plan 7.8's ฿18,432-versus-฿5,530, reproduced from the two implementations that exist.
   *
   * Not a demonstration that one is wrong — the schedule's answer is the right one, and the
   * pin is the one a forfeit reads. This test exists so that the divergence is a number in a
   * test run rather than a sentence in a comment, and so that fixing the submit path makes a
   * test change rather than passing silently.
   */
  it('disagrees the moment a schedule has a real deposit', () => {
    const total = 1_843_200n;
    const plan = planSchedule(total, depositPercentTerms(3_000));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    const fromSchedule = scheduledDepositMinor(plan.instalments);
    const fromSubmitPath = divRoundHalfUp(
      total * BigInt(SCHEDULED_DEPOSIT_BP_DEFAULT),
      BP_DENOMINATOR,
    );

    expect(fromSchedule).toBe(552_960n);
    expect(fromSubmitPath).toBe(1_843_200n);
    expect(fromSubmitPath - fromSchedule).toBe(1_290_240n);
  });
});
