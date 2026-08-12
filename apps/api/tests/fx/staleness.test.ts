import { describe, expect, it } from 'vitest';

import {
  FX_RATE_REFUSE_AFTER_HOURS,
  FX_RATE_WARN_AFTER_HOURS,
  fxRateAgeHours,
  fxRateHealthStatus,
} from '../../src/fx/staleness';

/**
 * The two thresholds and the arithmetic between them — no database, no clock, no Nest.
 *
 * Everything here is a statement about numbers, so it is tested as one. What a *row* does is
 * `quotation-rate.pg.test.ts`'s subject, and what an *outage* does is `fx-staleness.test.ts`'s;
 * this file exists so that when one of those fails, the boundary arithmetic is already ruled
 * out as the cause.
 */

const HOUR = 60 * 60 * 1000;
const at = (hoursAgo: number): Date => new Date(Date.UTC(2026, 7, 12, 12) - hoursAgo * HOUR);
const NOW = at(0);

describe('fxRateAgeHours', () => {
  it('measures elapsed hours as a real number, not a whole one', () => {
    /* Not rounded: the refusal compares against 72 and a 72.5-hour-old rate has to lose. A
       version that floored to whole hours would accept exactly the first half-day past every
       threshold, which is the widest a rounding bug in this file could be. */
    expect(fxRateAgeHours(at(72.5), NOW)).toBeCloseTo(72.5, 6);
    expect(fxRateAgeHours(at(1), NOW)).toBeCloseTo(1, 6);
  });

  /**
   * ⭐ A rate struck "in the future" is fresh, not `-2` hours old.
   *
   * Provider and server clocks disagree by seconds routinely and by hours when an NTP daemon
   * has failed. Without the clamp the age goes negative, which compares *correctly* against
   * both thresholds by luck — but reaches a screen as `เก่า -2 ชั่วโมง` and reaches
   * `Math.floor` in the refusal sentence as an even stranger number. Clock skew is not
   * staleness, and this file answers only the second question.
   */
  it('clamps a future observation to zero rather than reporting a negative age', () => {
    expect(fxRateAgeHours(at(-5), NOW)).toBe(0);
    expect(fxRateAgeHours(NOW, NOW)).toBe(0);
  });
});

describe('fxRateHealthStatus', () => {
  it('is ok below the warning threshold', () => {
    expect(fxRateHealthStatus(0)).toBe('ok');
    expect(fxRateHealthStatus(26)).toBe('ok');
  });

  /**
   * ⭐ The boundaries, both exclusive, stated as tests because "past 36 hours" and "36 hours or
   * more" are different systems and the difference is one character in the comparison.
   *
   * Exactly at a threshold is the *better* state, deliberately: a daily sync lands at a
   * slightly different second every day, so a rate that is 36.0000 hours old is a rate that is
   * about to be replaced, and warning on it would produce an email a day for a healthy system
   * whose cron drifted by a second. `>` rather than `>=`, in both places, for that reason.
   */
  it('warns strictly past the warning threshold and not at it', () => {
    expect(fxRateHealthStatus(FX_RATE_WARN_AFTER_HOURS)).toBe('ok');
    expect(fxRateHealthStatus(FX_RATE_WARN_AFTER_HOURS + 0.01)).toBe('warn');
  });

  it('blocks strictly past the refusal threshold and not at it', () => {
    expect(fxRateHealthStatus(FX_RATE_REFUSE_AFTER_HOURS)).toBe('warn');
    expect(fxRateHealthStatus(FX_RATE_REFUSE_AFTER_HOURS + 0.01)).toBe('blocked');
  });

  /**
   * ⭐ No observation at all is `blocked`, not a fourth word and not `warn`.
   *
   * An empty `fx_rates` already fails every foreign-currency submit with
   * `cause: 'no_snapshot'`. Anything softer here would be the organisation screen showing
   * amber over submits that are, at that moment, being refused — a screen disagreeing with the
   * API about a thing the API has already decided.
   */
  it('treats "no observation at all" as blocked, matching what a submit already does', () => {
    expect(fxRateHealthStatus(null)).toBe('blocked');
  });

  /**
   * The thresholds are ordered and the warning one is reachable. A single-constant refactor
   * that set both to the same number would leave every other test in this file passing while
   * silently deleting the warning band — nobody would ever be told before being refused, which
   * is the entire failure this round exists to fix.
   */
  it('leaves a real band between warning and refusing', () => {
    expect(FX_RATE_WARN_AFTER_HOURS).toBeLessThan(FX_RATE_REFUSE_AFTER_HOURS);
    /* Wide enough that a daily sync gets at least one more chance to land inside it. */
    expect(FX_RATE_REFUSE_AFTER_HOURS - FX_RATE_WARN_AFTER_HOURS).toBeGreaterThanOrEqual(24);
  });

  /**
   * ⭐ The warning threshold clears a healthy system's own ceiling.
   *
   * `FxRatesService` fetches once a day, so the newest `rate_timestamp` in a perfectly healthy
   * deployment is up to ~25 hours old just before the next tick (~24h of gap plus the ~1h the
   * free plan's hourly cadence can leave on the rate when it is stored). A warning threshold at
   * or below that emails staff every single day about a system that is working, and an alert
   * that fires daily is an alert that gets filtered — after which the real one is invisible too.
   */
  it('does not warn about a healthy daily sync at its oldest', () => {
    expect(fxRateHealthStatus(25)).toBe('ok');
    expect(fxRateHealthStatus(26)).toBe('ok');
  });
});
