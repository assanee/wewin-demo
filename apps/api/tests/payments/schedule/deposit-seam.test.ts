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
 * ⚠️ THE SEAM PLAN 7.13 NAMED — CLOSED, AND THIS IS THE GUARD AGAINST IT REOPENING.
 *
 * `scheduledDepositMinor` is supposed to be **one** function. It decides how much of a
 * customer's money may be kept when they walk away, and three designs produced ฿5,530 and
 * ฿18,432 for the same 30/70 order — a difference of ฿12,902 on one small window.
 *
 * There used to be two:
 *
 *   `orders.service.ts`  pinned `divRoundHalfUp(grandTotal × SCHEDULED_DEPOSIT_BP_DEFAULT, 10000)`
 *   this module          folds the gated prefix of the schedule
 *
 * They agreed, and only because the default gate coverage was payment in full. `orders.
 * service.ts` no longer computes its own figure — it calls `LifecycleService.pinsForSubmit`,
 * which calls this module and nothing else, so `SCHEDULED_DEPOSIT_BP_DEFAULT` is not read by
 * any live arithmetic today. It survives here, compared against `GATE_COVERAGE_BP_DEFAULT`,
 * so that if a future shortcut reintroduces a second formula it disagrees with immediately
 * rather than agreeing by coincidence for as long as the two constants happen to match.
 *
 * The third test is kept as the executable record of the exposure that made this worth
 * guarding: on a 30/70 the two formulas answer differently, and the answer the forfeit
 * reads is the schedule's, never the shortcut's.
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
