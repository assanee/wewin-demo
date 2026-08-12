/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ HOW OLD IS TOO OLD — the two numbers, and the clock they are measured on.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The owner's cache rule stands and is not in question: *"ดึงไม่ได้ทำยังไง = ให้ใช้ค่าเดิมที่
 * cache ไว้ในฐานข้อมูล"* — when the sync cannot reach the provider, quote from what is already
 * stored. What this file adds is the sentence that rule never contained: **and say so, and stop
 * eventually.** "The cached value" describes an hour-old rate and a three-week-old rate
 * identically, and only one of those is a rate.
 *
 * The stakes are asymmetric and that is the whole design. `order_documents_freeze` blocks
 * UPDATE on a pinned document forever, so a quotation issued at last month's rate is wrong
 * permanently, in front of a customer who transfers the figure they can see, and the only
 * remedy is a superseding revision and an awkward conversation. A refused submit is a sentence
 * on a screen and an administrator typing an override — a minute, same session, same person.
 * This is `QuotationRateService`'s own argument about a missing rate, applied to an old one,
 * because a rate old enough is a missing rate that still has digits in it.
 *
 * ── ⭐ WHICH CLOCK: `rate_timestamp`, not `fetched_at` ───────────────────────────
 *
 * `fx_rates` carries both and they disagree by design — the column's own note says so. The
 * refusal is measured on **`rate_timestamp`**, the moment the provider struck the rate, and the
 * choice is not a coin toss:
 *
 *   1. **`fetched_at` cannot see the failure this file exists to catch.** A provider whose feed
 *      has frozen but whose HTTP endpoint is healthy answers 200 every day with the same stale
 *      `timestamp`. That writes a new row daily, so `fetched_at` is always minutes old and every
 *      staleness check built on it reports perfect health — while the number being frozen onto
 *      documents is three weeks old. `fetched_at` measures *how recently we asked*; it is a fact
 *      about our cron, not about the market, and a customer is not quoted our cron.
 *   2. **It is the instant the document already prints.** `ResolvedQuotationRate.observedAt` is
 *      this same `rate_timestamp`, and `quotation-sheet.tsx` renders it as *"อ้างอิงอัตรา ณ …"*.
 *      Measuring the refusal on a different clock than the one the document quotes would let the
 *      system refuse a rate whose printed observation is fresh, or accept one whose printed
 *      observation is ancient. The check and the document have to be talking about the same
 *      moment or the refusal is not honest.
 *
 * ⚠️ **Ordering stays on `fetched_at` and this does not change that.** `FxRatesRepository.latest`
 * picks the newest row by `fetched_at` because that is the only clock monotonic in *our* history
 * — a provider re-serving an old `timestamp` after an outage would sort an older observation
 * above a newer one under `rate_timestamp`. So the two clocks do different jobs and both are
 * right: `fetched_at` chooses *which row we will pin*, and `rate_timestamp` then says *how old
 * the number on that row is*. Age is a property of the row already chosen, never a way of
 * choosing one.
 *
 * ── ⭐ WHY 36 AND 72, and what a healthy system actually looks like ──────────────
 *
 * `FxRatesService` fetches once a day at 01:00, and the free Open Exchange Rates plan updates
 * hourly, so a landed rate is at most ~1h old when it is stored. A perfectly healthy system
 * therefore holds a newest `rate_timestamp` somewhere between ~1h and ~25h old, depending only
 * on where in the day you look. ~26h is the healthy ceiling, not a degradation.
 *
 *   - **36h to warn.** Comfortably above the healthy ceiling — no email on a Tuesday afternoon
 *     just because the sync is 23h from its last run — and low enough that *one* missed daily
 *     tick is reported within half a day of the miss. One miss is exactly the point at which a
 *     human can still fix it before it matters.
 *   - **72h to refuse.** Three consecutive missed syncs. Three because two is a long weekend's
 *     worth of ordinary provider flakiness that the cache rule is explicitly there to absorb,
 *     and because `QuotationRateService`'s header already reached for this number when it said a
 *     sync that failed for three days "costs three days of staleness" — that sentence described
 *     an unbounded cost, and this is the bound it was describing without having.
 *
 * Both are *conservative on the side of quoting*: staff are warned twice a day before anything
 * is ever refused, and the refusal names the way out.
 *
 * ── ⚠️ These are constants, not settings, and here is the path to changing that ──
 *
 * `fxSpreadBp` is a per-destination column with a CHECK, an audit row in `tax_country_changes`
 * and a form field. These two are neither, and the difference is real: a spread is a commercial
 * position that legitimately differs per country, while "how old is too old" is one statement
 * about one provider feed shared by every destination. Making it configurable would mean a
 * settings table with exactly one row, which is `organisation_profile`'s shape and its cost.
 *
 * What it would take, if the owner wants it later: two `integer` columns on
 * `organisation_profile` with a CHECK that warn < refuse, added to `PROFILE_RECORDED` in
 * `organisation.service.ts` so both land in `organisation_profile_changes` under the existing
 * `changedAt: sql\`clock_timestamp()\`` rule; the two reads in `QuotationRateService` and
 * `FxStalenessService` take them from the profile row they would then have to load; and this
 * file keeps the constants as the defaults the migration backfills with. It is about a day, and
 * the reason it is not in this round is that nobody has yet wanted a number other than these.
 */

/** Warn past this. One missed daily sync, seen within half a day. */
export const FX_RATE_WARN_AFTER_HOURS = 36;

/** Refuse a foreign-currency submit past this. Three missed daily syncs. */
export const FX_RATE_REFUSE_AFTER_HOURS = 72;

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * How old the observation is, in hours, as a real number.
 *
 * ⚠️ **Clamped at zero.** A provider clock running ahead of ours produces a `rate_timestamp` in
 * the future, and the honest reading of that is "not stale" rather than a negative age that
 * would compare oddly against a threshold and print as `-2 ชั่วโมง` on a screen. A rate from the
 * future is a clock-skew problem and not a staleness problem, and this file only answers the
 * second question.
 */
export function fxRateAgeHours(observedAt: Date, now: Date): number {
  const elapsed = now.getTime() - observedAt.getTime();

  return elapsed <= 0 ? 0 : elapsed / MS_PER_HOUR;
}

/**
 * ⭐ The one comparison, so the refusal, the warning and the screen cannot disagree.
 *
 * Three call sites ask "how bad is it" — `QuotationRateService` before it throws,
 * `FxStalenessService` before it emails, and the health endpoint the organisation screen reads.
 * Written out three times these would drift the first time a threshold moved, and the drift
 * that matters is a screen showing green over a submit that is being refused.
 *
 * `null` — meaning *there is no observation at all* — is `'blocked'`, not a fourth word. An
 * empty `fx_rates` already fails every foreign-currency submit with `cause: 'no_snapshot'`
 * (`QuotationRateService.fromSettings`), so reporting it as anything softer would be a screen
 * disagreeing with the API about a submit that is, right now, refused.
 */
export type FxRateHealthStatus = 'ok' | 'warn' | 'blocked';

export function fxRateHealthStatus(ageHours: number | null): FxRateHealthStatus {
  if (ageHours === null) return 'blocked';
  if (ageHours > FX_RATE_REFUSE_AFTER_HOURS) return 'blocked';

  return ageHours > FX_RATE_WARN_AFTER_HOURS ? 'warn' : 'ok';
}
