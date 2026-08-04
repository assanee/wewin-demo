/**
 * How long to wait before trying again — plan 13's "retry 5 times, exponential backoff".
 *
 * ⚠️ Plan 13 gives the *count* (5) and the *word* ("exponential") and no interval. So the
 * count is `NOTIFICATION_MAX_ATTEMPTS_DEFAULT` in packages/db and is plan 13's number; the
 * shape below — 60 s doubling to a one-hour ceiling — is this module's own default, marked
 * as such, and is a `NOTIFICATIONS_RETRY_BASE_MS` / `_MAX_MS` away from being changed
 * without a deploy argument.
 *
 * ── Why there is jitter, and why it is deterministic in a test ───────────────
 *
 * Every notification in a storm fails at the same moment for the same reason — the SMTP
 * host is down — so every one of them would come back at the same moment too, and the
 * first thing the mail server sees when it recovers is the same thundering herd that was
 * hitting it before. The jitter is full-width on the *last* doubling only (`[delay/2,
 * delay]`), which spreads a batch without ever waiting longer than the ceiling.
 *
 * `random` is a parameter rather than a call to `Math.random`, because a retry schedule
 * with a random number generator inside it is a schedule nobody can write a test for, and
 * an untested backoff is how a "one hour" ceiling turns out to be eleven days.
 */

export interface BackoffSettings {
  readonly baseMs: number;
  readonly maxMs: number;
}

/**
 * Delay before attempt number `nextAttempt` (1-based: the delay before the *second*
 * attempt is `nextAttempt = 2`).
 *
 * Attempt 1 has no delay — it is the send that has not happened yet — and asking for one
 * returns 0 rather than throwing, because the caller that would trip it is the one
 * scheduling a first attempt, and refusing to schedule it would be worse than sending
 * immediately.
 */
export function backoffMs(
  nextAttempt: number,
  settings: BackoffSettings,
  random: () => number = Math.random,
): number {
  if (nextAttempt <= 1) return 0;

  // 2 → base, 3 → 2×base, 4 → 4×base … capped before the jitter, so the ceiling is a
  // ceiling on what is actually waited and not on what was computed before spreading.
  const exponent = nextAttempt - 2;
  const uncapped = settings.baseMs * 2 ** exponent;
  const capped = Math.min(uncapped, settings.maxMs);

  // Clamped rather than trusted: a `random()` returning exactly 1, or a stub returning
  // something outside [0, 1), must not produce a delay above the ceiling or below zero.
  const spread = Math.min(Math.max(random(), 0), 1);
  return Math.round(capped / 2 + (capped / 2) * spread);
}

/**
 * The whole schedule, for a human reading a log line or a test asserting the shape.
 *
 * Written as its own function rather than as a loop at the call site so the answer to
 * "how long until this gives up" has one implementation. With the defaults and no jitter
 * that is 1 m, 2 m, 4 m, 8 m — about a quarter of an hour before `dead`, which is the
 * number an operator actually wants to know when deciding whether to look now or later.
 */
export function retryScheduleMs(maxAttempts: number, settings: BackoffSettings): readonly number[] {
  const schedule: number[] = [];
  for (let attempt = 2; attempt <= maxAttempts; attempt += 1) {
    // `() => 1` is the worst case, which is the honest number for "when do we give up".
    schedule.push(backoffMs(attempt, settings, () => 1));
  }
  return schedule;
}
