import { describe, expect, it } from 'vitest';

import {
  FX_MANUAL_SYNC_DAILY_LIMIT,
  FX_MANUAL_SYNC_MIN_INTERVAL_SECONDS,
  FX_MANUAL_SYNC_WINDOW_HOURS,
  manualSyncBudget,
  manualSyncRetryAfterSeconds,
  type FxManualSyncUsage,
} from '../../src/fx/manual-sync';

/**
 * ⭐ The bound under the manual sync button.
 *
 * `FxRatesService`'s header says the daily schedule is *"why the number is what it is, not a
 * preference that happened to land here"*, and a button that fetches on demand is that schedule
 * tightened into a human's hands. The provider's free plan allows 1,000 requests a month **for
 * the whole system**, so a button spent carelessly today is a scheduled sync that cannot run next
 * week, a rate that stops moving, and a foreign-currency quotation refused by somebody who never
 * pressed anything. Nothing about that chain is visible at the moment of the click, which is why
 * the guard has to be arithmetic rather than good intentions.
 *
 * Two limits, and the tests here are mostly about the fact that neither alone is enough:
 *
 *   - the **daily cap** bounds the month's spend, and permits the whole day's allowance in four
 *     seconds if it is the only rule;
 *   - the **minimum interval** stops a held-down button, and permits 288 syncs a day if it is the
 *     only rule.
 *
 * Pure — `now` is an argument — so "the tenth press in a day" and "the second press in the same
 * second" are stated rather than waited for.
 */

const NOW = new Date('2026-08-12T09:00:00.000Z');
const MS_PER_HOUR = 60 * 60 * 1000;
const hoursBefore = (hours: number): Date => new Date(NOW.getTime() - hours * MS_PER_HOUR);
const secondsBefore = (seconds: number): Date => new Date(NOW.getTime() - seconds * 1000);

const usage = (overrides: Partial<FxManualSyncUsage> = {}): FxManualSyncUsage => ({
  attemptsInWindow: 0,
  lastAttemptAt: undefined,
  oldestAttemptInWindowAt: undefined,
  ...overrides,
});

describe('an untouched budget allows the press', () => {
  it('allows a sync when nothing has been pressed at all', () => {
    const budget = manualSyncBudget(usage(), NOW);

    expect(budget.nextAllowedAt).toBeNull();
    expect(budget.remainingToday).toBe(FX_MANUAL_SYNC_DAILY_LIMIT);
    expect(budget.usedToday).toBe(0);
  });

  /**
   * The constants are reported *down* onto the payload rather than held by the screen, exactly as
   * `warnAfterHours` and `refuseAfterHours` are — so a card can never quote one number while the
   * refusal compares against another.
   */
  it('reports both constants so no screen keeps a copy of them', () => {
    const budget = manualSyncBudget(usage(), NOW);

    expect(budget.dailyLimit).toBe(FX_MANUAL_SYNC_DAILY_LIMIT);
    expect(budget.minIntervalSeconds).toBe(FX_MANUAL_SYNC_MIN_INTERVAL_SECONDS);
  });

  it('allows a sync once the minimum interval has elapsed', () => {
    const budget = manualSyncBudget(
      usage({
        attemptsInWindow: 1,
        lastAttemptAt: secondsBefore(FX_MANUAL_SYNC_MIN_INTERVAL_SECONDS + 1),
        oldestAttemptInWindowAt: secondsBefore(FX_MANUAL_SYNC_MIN_INTERVAL_SECONDS + 1),
      }),
      NOW,
    );

    expect(budget.nextAllowedAt).toBeNull();
    expect(budget.remainingToday).toBe(FX_MANUAL_SYNC_DAILY_LIMIT - 1);
  });
});

describe('the minimum interval — the guard against a held-down button', () => {
  /**
   * ⭐ The failure this limit exists for. Without it, ten presses in four seconds spend the whole
   * day's allowance before anybody has read the result of the first — which is exactly what a
   * double-submit, a retrying browser, or an impatient person produces.
   */
  it('refuses a second press in the same second, with nine of ten still unspent', () => {
    const budget = manualSyncBudget(
      usage({ attemptsInWindow: 1, lastAttemptAt: NOW, oldestAttemptInWindowAt: NOW }),
      NOW,
    );

    expect(budget.nextAllowedAt).not.toBeNull();
    /* ⚠️ And the quota is NOT what is refusing: nine presses remain. A screen has to be able to
       say "wait a moment" rather than "you are out for the day", and `remainingToday` is what
       lets it tell them apart. */
    expect(budget.remainingToday).toBe(FX_MANUAL_SYNC_DAILY_LIMIT - 1);
  });

  it('names the moment the interval elapses, not a moment in the past', () => {
    const last = secondsBefore(10);
    const budget = manualSyncBudget(
      usage({ attemptsInWindow: 1, lastAttemptAt: last, oldestAttemptInWindowAt: last }),
      NOW,
    );

    expect(budget.nextAllowedAt).toBe(
      new Date(last.getTime() + FX_MANUAL_SYNC_MIN_INTERVAL_SECONDS * 1000).toISOString(),
    );
  });

  /**
   * ⚠️ `null` once the moment has passed, rather than a timestamp in the past. A screen reading a
   * past timestamp would have to compare it against its own clock to know whether the button
   * works — a second opinion about a question the server has already answered.
   */
  it('answers null rather than a past moment once the gap has elapsed', () => {
    const budget = manualSyncBudget(
      usage({ attemptsInWindow: 1, lastAttemptAt: hoursBefore(3), oldestAttemptInWindowAt: hoursBefore(3) }),
      NOW,
    );

    expect(budget.nextAllowedAt).toBeNull();
  });
});

describe('the daily cap — the guard on the provider quota', () => {
  const spent = (): FxManualSyncUsage =>
    usage({
      attemptsInWindow: FX_MANUAL_SYNC_DAILY_LIMIT,
      lastAttemptAt: hoursBefore(1),
      oldestAttemptInWindowAt: hoursBefore(20),
    });

  it('refuses once the limit is reached, long after the interval has elapsed', () => {
    const budget = manualSyncBudget(spent(), NOW);

    expect(budget.remainingToday).toBe(0);
    expect(budget.nextAllowedAt).not.toBeNull();
  });

  /**
   * ⭐ The window is **rolling**, not a calendar day. A calendar reset would put the whole
   * allowance back at midnight regardless of when it was spent, so eleven o'clock and one o'clock
   * would be twenty syncs two hours apart — which is the quota gone in an evening.
   *
   * The next press becomes affordable when the OLDEST attempt in the window ages out of it.
   */
  it('refills from the oldest attempt in the window, not from midnight', () => {
    const oldest = hoursBefore(20);
    const budget = manualSyncBudget(
      usage({
        attemptsInWindow: FX_MANUAL_SYNC_DAILY_LIMIT,
        lastAttemptAt: hoursBefore(1),
        oldestAttemptInWindowAt: oldest,
      }),
      NOW,
    );

    expect(budget.nextAllowedAt).toBe(
      new Date(oldest.getTime() + FX_MANUAL_SYNC_WINDOW_HOURS * MS_PER_HOUR).toISOString(),
    );
  });

  /** A count above the limit — two instances racing — still floors at zero rather than going
      negative, which a screen would print. */
  it('floors the remainder at zero rather than reporting a negative budget', () => {
    const budget = manualSyncBudget(
      usage({
        attemptsInWindow: FX_MANUAL_SYNC_DAILY_LIMIT + 3,
        lastAttemptAt: hoursBefore(1),
        oldestAttemptInWindowAt: hoursBefore(20),
      }),
      NOW,
    );

    expect(budget.remainingToday).toBe(0);
    expect(budget.usedToday).toBe(FX_MANUAL_SYNC_DAILY_LIMIT + 3);
  });
});

describe('both limits together', () => {
  /**
   * ⭐ `nextAllowedAt` is the LATER of the two answers, because both have to be satisfied. A
   * quota exhausted an hour ago with a press two seconds ago must not report the interval's
   * moment — that would offer a press in fifty-eight seconds that the quota will refuse.
   */
  it('reports the later of the two moments when both limits are holding', () => {
    const oldest = hoursBefore(20);
    const budget = manualSyncBudget(
      usage({
        attemptsInWindow: FX_MANUAL_SYNC_DAILY_LIMIT,
        lastAttemptAt: secondsBefore(2),
        oldestAttemptInWindowAt: oldest,
      }),
      NOW,
    );

    const quotaMoment = oldest.getTime() + FX_MANUAL_SYNC_WINDOW_HOURS * MS_PER_HOUR;
    const intervalMoment = NOW.getTime() - 2000 + FX_MANUAL_SYNC_MIN_INTERVAL_SECONDS * 1000;
    expect(quotaMoment, 'fixture no longer exercises the max').toBeGreaterThan(intervalMoment);

    expect(budget.nextAllowedAt).toBe(new Date(quotaMoment).toISOString());
  });
});

describe('the retry-after figure the refusal carries', () => {
  it('is undefined when the press would be accepted right now', () => {
    expect(manualSyncRetryAfterSeconds(manualSyncBudget(usage(), NOW), NOW)).toBeUndefined();
  });

  /**
   * ⚠️ At least one second. `Retry-After: 0` invites an immediate retry the guard would refuse
   * again — RFC 9110 wants a delay, not a permission — and it is the same floor `SignInThrottle`
   * applies for the same reason.
   */
  it('is at least one second, never zero, at the boundary', () => {
    const budget = manualSyncBudget(
      usage({ attemptsInWindow: 1, lastAttemptAt: NOW, oldestAttemptInWindowAt: NOW }),
      NOW,
    );
    /* Read a whisker before the moment elapses: the naive `ceil` of a sub-second remainder is 0. */
    const almost = new Date(
      NOW.getTime() + FX_MANUAL_SYNC_MIN_INTERVAL_SECONDS * 1000 - 200,
    );

    expect(manualSyncRetryAfterSeconds(budget, almost)).toBe(1);
  });

  it('counts up from the moment the budget named', () => {
    const budget = manualSyncBudget(
      usage({ attemptsInWindow: 1, lastAttemptAt: secondsBefore(10), oldestAttemptInWindowAt: secondsBefore(10) }),
      NOW,
    );

    expect(manualSyncRetryAfterSeconds(budget, NOW)).toBe(FX_MANUAL_SYNC_MIN_INTERVAL_SECONDS - 10);
  });
});

describe('the constants are inside the plan they are chosen against', () => {
  /**
   * ⭐ The arithmetic that makes the whole feature safe, pinned so nobody raises the limit
   * without meeting it.
   *
   * The free plan is 1,000 requests a month. The daily tick spends ~31. The worst possible month
   * of manual syncs is `dailyLimit × 31`. If the sum ever reaches 1,000, the *scheduled* sync
   * stops — and the button's whole cost lands on somebody who never touched it, a week later, as
   * a refused quotation. This is the assertion that turns "10 felt about right" into a bound.
   */
  it('leaves the scheduled sync affordable in the worst possible month', () => {
    const scheduledPerMonth = 31;
    const worstManualMonth = FX_MANUAL_SYNC_DAILY_LIMIT * 31;

    expect(worstManualMonth + scheduledPerMonth).toBeLessThan(1_000);
  });

  /**
   * The interval has to be short enough that somebody who has just fixed a network problem is not
   * left waiting, and long enough that the day's allowance cannot be spent before the first result
   * is on screen. A limit's worth of presses at the minimum interval must take real minutes.
   */
  it('makes spending the whole day allowance take minutes rather than seconds', () => {
    const secondsToSpendIt = (FX_MANUAL_SYNC_DAILY_LIMIT - 1) * FX_MANUAL_SYNC_MIN_INTERVAL_SECONDS;

    expect(secondsToSpendIt).toBeGreaterThanOrEqual(300);
  });
});
