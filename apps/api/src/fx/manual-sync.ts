import type { FxManualSyncBudgetWire } from '@wewin/contract/organisation';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ THE BUDGET UNDER THE MANUAL SYNC BUTTON — and why there has to be one.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `FxRatesService`'s class header ends with a sentence this file exists because of:
 *
 *   *"Do not tighten the schedule below without re-reading the quota and staleness reasoning
 *   above; they are why the number is what it is, not a preference that happened to land here."*
 *
 * A button that fetches on demand **is** that tightening, moved out of a cron expression and into
 * a person's hands, and it is worse than tightening the schedule in one specific way: a schedule
 * has a known upper bound and a person does not.
 *
 * ── ⭐ WHAT IS ACTUALLY AT RISK, said plainly because the consequence is a week away ─
 *
 * The free Open Exchange Rates plan allows **1,000 requests a month, for the whole system**. The
 * daily tick spends ~30. The ~970 left over is not slack — the service's header calls it the
 * point of choosing daily over hourly, the room that lets a failed fetch be retried "without
 * quota anxiety".
 *
 * When that budget is gone, the provider stops answering **everyone**, including the 01:00 tick.
 * So an afternoon of impatient clicking today is not paid for today; it is paid for next week, by
 * a rate that stops updating, then a `warn`, then a refused foreign-currency quotation, with
 * nothing on any screen connecting the refusal to the clicking. That is the failure this file is
 * shaped around: **the cost is displaced from the action, so the guard has to be the thing that
 * connects them**, out loud, on the screen, before the button is pressed rather than after.
 *
 * ── ⭐ TWO LIMITS, BECAUSE ONE OF THEM IS DEFEATED BY THE OTHER'S FAILURE MODE ────
 *
 * **`FX_MANUAL_SYNC_DAILY_LIMIT` — 10 per rolling 24 hours.** This is the quota bound. Ten a day
 * every day for a month is 310, plus ~31 scheduled, which is 341 against 1,000 — leaving ~659
 * spare, comfortably inside the headroom the service's header argues for. Realistically the
 * number is zero on almost every day; what the limit buys is that the *worst* month still cannot
 * reach the ceiling. Ten is also well above what the button is for: the honest uses are "the
 * provider was down this morning and I have just seen it come back" and "the rate looks wrong and
 * I want to force a re-read", and neither is a thing anybody does eleven times in a day.
 *
 * **`FX_MANUAL_SYNC_MIN_INTERVAL_SECONDS` — 60 seconds.** A daily cap alone permits all ten in
 * four seconds — a double-submit, a held-down key, a browser that retried. That is the day's whole
 * allowance spent before anybody has read the first result, and it is the exact shape of the
 * "button anyone can hold down" failure. A minute is long enough that the second press is a
 * decision and short enough that somebody who has just fixed a firewall is not left waiting.
 *
 * Neither number is an owner decision that has been taken; both are this module's defaults,
 * stated the way `SIGN_IN_ACCOUNT_LIMIT_DEFAULT` states its own. What would make them settable is
 * the same paragraph `staleness.ts` writes about its two thresholds, and the same answer: nobody
 * has yet wanted a number other than these.
 *
 * ── ⚠️ WHY THE COUNT IS NOT IN MEMORY, unlike every other limiter in this app ────
 *
 * `SignInThrottle`, `MFA_THROTTLE` and `FunnelThrottleMiddleware` are all in-process `Map`s, and
 * all three are right: they protect *this instance* from traffic aimed at it, and each documents
 * that two instances allow twice the traffic.
 *
 * This budget is a different kind of thing. It belongs to the **provider account**, not to a Node
 * process — two instances do not get two thousand requests, they share one thousand. And an
 * in-memory counter resets on restart, which means a deploy silently refills the quota guard, and
 * a deploy is very often exactly when somebody is standing over the button wondering why the rate
 * has not moved. So the count is read from `fx_rates` and `fx_sync_failures` by `trigger_kind`
 * (migration 0041): durable across restarts, shared across instances, and *derived* from the same
 * rows the rest of this card already reads — which is `fx_sync_failures`' own stated rule, that a
 * count measured against the rows it describes cannot drift from them.
 *
 * ── Pure ────────────────────────────────────────────────────────────────────────
 *
 * No clock, no table: the caller passes both usage and `now`. That is what lets
 * `manual-sync.test.ts` state "the tenth press in a day" and "the second press in the same
 * second" without waiting for either.
 */

/** Manual syncs allowed per rolling window. See the header for the arithmetic against 1,000/month. */
export const FX_MANUAL_SYNC_DAILY_LIMIT = 10;

/** The rolling window the limit is counted over. */
export const FX_MANUAL_SYNC_WINDOW_HOURS = 24;

/** The floor between two manual syncs — the guard against a held-down button, not against quota. */
export const FX_MANUAL_SYNC_MIN_INTERVAL_SECONDS = 60;

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * What the two append-only tables say about manual syncs in the window.
 *
 * ⚠️ `attemptsInWindow` counts **successes and failures alike**, and that is load-bearing rather
 * than tidy. A manual sync that failed still spent a provider request — the quota is charged by
 * the provider on the request, not on the answer — so a guard that counted only the `fx_rates`
 * rows would let somebody hold the button down through an outage and spend the month without the
 * count moving at all. That is the one usage pattern under which the quota disappears fastest.
 */
export interface FxManualSyncUsage {
  readonly attemptsInWindow: number;
  /** The newest manual attempt at all, for the minimum interval. `undefined` if there is none. */
  readonly lastAttemptAt: Date | undefined;
  /** The oldest manual attempt *inside the window*, which is when a full quota starts to refill. */
  readonly oldestAttemptInWindowAt: Date | undefined;
}

/**
 * ⭐ The budget as it stands, in the shape the screen and the refusal both read.
 *
 * One function and not two, so "may I press it" and "what does the card say about pressing it"
 * are answered by the same arithmetic. Two implementations would drift, and the drift that
 * matters is a button that looks available and 429s — which reads as a broken screen and sends
 * somebody to press it again.
 *
 * `nextAllowedAt` is the **later** of the two limits' answers, because both have to be satisfied.
 * A screen wanting to say *which* one is holding reads `remainingToday`: zero is the quota, and
 * non-zero beside a non-null `nextAllowedAt` is the minimum interval.
 */
export function manualSyncBudget(usage: FxManualSyncUsage, now: Date): FxManualSyncBudgetWire {
  const used = usage.attemptsInWindow;
  const remaining = Math.max(0, FX_MANUAL_SYNC_DAILY_LIMIT - used);

  const moments: number[] = [];

  /*
   * Quota exhausted. The next press becomes affordable when the *oldest* attempt in the window
   * ages out of it — which is what makes the window rolling rather than a calendar day. A
   * calendar day would put the whole allowance back at midnight regardless of when it was spent,
   * so eleven o'clock and one o'clock would be twenty syncs two hours apart.
   *
   * `oldestAttemptInWindowAt` being `undefined` while the quota is exhausted is not reachable —
   * a positive count has a row behind it — but the limit is honoured rather than assumed away:
   * with no moment to age out, the honest answer is the far end of a whole window from now.
   */
  if (remaining === 0) {
    const oldest = usage.oldestAttemptInWindowAt?.getTime() ?? now.getTime();
    moments.push(oldest + FX_MANUAL_SYNC_WINDOW_HOURS * MS_PER_HOUR);
  }

  /* The minimum interval, measured from the newest attempt of any outcome. */
  if (usage.lastAttemptAt !== undefined) {
    moments.push(usage.lastAttemptAt.getTime() + FX_MANUAL_SYNC_MIN_INTERVAL_SECONDS * 1000);
  }

  const earliest = moments.length === 0 ? undefined : Math.max(...moments);

  return {
    dailyLimit: FX_MANUAL_SYNC_DAILY_LIMIT,
    usedToday: used,
    remainingToday: remaining,
    minIntervalSeconds: FX_MANUAL_SYNC_MIN_INTERVAL_SECONDS,
    /*
     * `null` once the moment has passed, rather than a moment in the past. A screen reading a
     * past timestamp would have to compare it against its own clock to know whether the button
     * works, which is a second opinion about a question the server has already answered.
     */
    nextAllowedAt:
      earliest === undefined || earliest <= now.getTime()
        ? null
        : new Date(earliest).toISOString(),
  };
}

/**
 * Seconds until a refused press would be accepted, or `undefined` when it would be accepted now.
 *
 * Derived from `manualSyncBudget` rather than recomputed, so the `Retry-After` header, the
 * refusal's `details` and the card's countdown are the same number by construction.
 *
 * At least `1`: `Retry-After: 0` invites an immediate retry that this guard would refuse again,
 * and RFC 9110 wants a delay rather than a permission. The same floor `SignInThrottle` applies.
 */
export function manualSyncRetryAfterSeconds(
  budget: FxManualSyncBudgetWire,
  now: Date,
): number | undefined {
  if (budget.nextAllowedAt === null) return undefined;

  const at = Date.parse(budget.nextAllowedAt);
  if (Number.isNaN(at)) return undefined;

  return Math.max(1, Math.ceil((at - now.getTime()) / 1000));
}
