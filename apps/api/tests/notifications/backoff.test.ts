import { describe, expect, it } from 'vitest';

import { backoffMs, retryScheduleMs } from '../../src/notifications/backoff';

/**
 * The retry schedule, pinned.
 *
 * A backoff is the easiest thing in a queue to get wrong in a way nothing notices: an
 * off-by-one in the exponent turns "about a quarter of an hour before we give up" into most
 * of a day, and nobody finds out until the first outage, when the dead queue is empty and
 * everybody assumes the messages went out.
 *
 * `random` is injected everywhere below. A schedule with `Math.random` inside it cannot be
 * asserted, and an unasserted schedule is the one that drifts.
 */

const SETTINGS = { baseMs: 60_000, maxMs: 3_600_000 } as const;

describe('retry backoff', () => {
  it('does not delay the first attempt', () => {
    // Attempt 1 is the send that has not happened yet. A delay here would mean every
    // notification waited a minute before anybody tried to send it.
    expect(backoffMs(1, SETTINGS, () => 1)).toBe(0);
    expect(backoffMs(0, SETTINGS, () => 1)).toBe(0);
  });

  it('doubles from the base, attempt by attempt', () => {
    // With no jitter (random → 1) the delay before attempt n is base × 2^(n-2).
    expect(backoffMs(2, SETTINGS, () => 1)).toBe(60_000);
    expect(backoffMs(3, SETTINGS, () => 1)).toBe(120_000);
    expect(backoffMs(4, SETTINGS, () => 1)).toBe(240_000);
    expect(backoffMs(5, SETTINGS, () => 1)).toBe(480_000);
  });

  it('never waits longer than the ceiling, however many attempts have passed', () => {
    // The failure this rules out is an unbounded doubling: attempt 40 is 2^38 minutes,
    // which is a message scheduled past the heat death of the retention policy.
    expect(backoffMs(40, SETTINGS, () => 1)).toBe(3_600_000);
    expect(backoffMs(400, SETTINGS, () => 1)).toBe(3_600_000);
  });

  it('spreads a batch over the second half of the window', () => {
    // Every message in a storm fails at the same instant for the same reason, so without
    // jitter every one of them comes back at the same instant too — and the first thing the
    // recovering mail server sees is the herd that was hitting it before.
    expect(backoffMs(2, SETTINGS, () => 0)).toBe(30_000);
    expect(backoffMs(2, SETTINGS, () => 0.5)).toBe(45_000);
    expect(backoffMs(2, SETTINGS, () => 1)).toBe(60_000);
  });

  it('clamps a random source that misbehaves', () => {
    // Not hypothetical: a test stub, or a future seeded generator, may hand back something
    // outside [0, 1). The ceiling has to be a ceiling regardless.
    expect(backoffMs(2, SETTINGS, () => 5)).toBe(60_000);
    expect(backoffMs(2, SETTINGS, () => -5)).toBe(30_000);
  });

  it('gives up after about a quarter of an hour on plan 13 defaults', () => {
    // Plan 13's default is five attempts. Four waits, worst case, is 15 minutes — the number
    // an operator wants when deciding whether to look at the dead queue now or after lunch.
    const schedule = retryScheduleMs(5, SETTINGS);

    expect(schedule).toStrictEqual([60_000, 120_000, 240_000, 480_000]);
    expect(schedule.reduce((total, delay) => total + delay, 0)).toBe(900_000);
  });
});
