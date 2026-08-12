import { Injectable } from '@nestjs/common';
import { resolveFxRate, type FxRate, type FxRateProblem, type FxSnapshot } from '@wewin/core/fx';
import type { Currency } from '@wewin/core/money';

import { AppError } from '../common/errors/app-error';
import { count as countParam, message } from '../i18n';
import { TaxCountryService, type DestinationFx } from '../organisation/tax-country.service';
import { FxRatesRepository, type FxSnapshotRow, type Tx } from './fx-rates.repository';
import { FX_RATE_REFUSE_AFTER_HOURS, fxRateAgeHours } from './staleness';

/**
 * One quotation's rate, pinned.
 *
 * `rate` is the whole of the arithmetic — currency, source, the spread that was actually
 * applied, the exact ratio, and (for a mid-market rate) the two provider figures it was derived
 * from. Everything a customer could question is reconstructible from it.
 *
 * `observedAt` is the one thing `FxRate` cannot carry, because `resolveFxRate` is arithmetic and
 * has no idea when the numbers it was handed were observed. An ISO 8601 string of the
 * snapshot's `rate_timestamp` — *when the provider struck the rate*, never when we fetched it,
 * because the first is the claim a document can print and the second is an implementation
 * detail of our polling.
 *
 * ⚠️ `null` **exactly when `rate.source === 'manual'`**, and that is a statement rather than a
 * gap. A manual override is a figure a member of staff read off a bank's screen and typed; it
 * has no provider, no observation and no timestamp, and stamping one on it (the row's
 * `updated_at`, say, or the moment of the submit) would put a date on a document that reads
 * like a market observation and is not one. The absence is the honest signal, and it is the
 * same shape `FxRate.provider` already uses for the same branch.
 */
export interface ResolvedQuotationRate {
  readonly rate: FxRate;
  /** ISO 8601. `null` when — and only when — `rate.source === 'manual'`. */
  readonly observedAt: string | null;
}

/**
 * The snapshot argument for a branch that provably does not read it.
 *
 * `resolveFxRate`'s manual branch returns before touching `snapshot.rates` or `snapshot.base`
 * (`packages/core/src/fx.ts`, the `settings.manualRateThbPerUnit !== null` branch — it is the
 * second statement in the function and it constructs its result from `settings` alone). So an
 * override does not need a stored observation and must not be made to wait for one: a
 * destination whose whole point is that somebody typed the rate would otherwise be unquotable
 * on a day the provider was down, which is precisely backwards.
 *
 * Empty and not plausible-looking, deliberately. A `{ base: 'USD', rates: { THB: 36.5 } }`
 * placeholder would be a number that means nothing, sitting where a real observation goes; if
 * core's branch order ever changed, that would resolve to a *wrong rate* silently, while this
 * resolves to `ok: false` with `baht_rate_missing` and the submit is refused. The failure mode
 * is chosen, not inherited.
 */
const NO_SNAPSHOT_NEEDED: FxSnapshot = { base: '', rates: {} };

/** What went wrong, for `details` — core's own vocabulary plus the one case it cannot name. */
type RateFailure = FxRateProblem | 'no_snapshot';

/**
 * ⭐ Resolving the exchange rate a quotation is priced at — the whole decision, in one place.
 *
 * `packages/core/src/fx.ts` has always ended by saying nothing calls it, *"on purpose, until
 * that answer exists"*. This is the answer, and it is deliberately small: which observation
 * counts as "the" rate for a quotation, and what happens when there is not one.
 *
 * ── ⭐ THE CACHE RULE: the newest stored observation, never a live fetch ──────────
 *
 * The owner's decision, verbatim: *"ดึงไม่ได้ทำยังไง = ให้ใช้ค่าเดิมที่ cache ไว้ในฐานข้อมูล"* —
 * if the daily sync could not fetch, use what is already cached in the database. So this reads
 * the newest row of `fx_rates` and nothing else. There is no "is today's fetch missing" branch
 * and no HTTP client reachable from this file.
 *
 * ⚠️ **There IS a freshness check now, and this paragraph used to say there was not.** The
 * sentence that stood here read: *"a sync that failed for three days costs three days of
 * staleness, and costs nobody a submit they cannot make."* Both halves were true and the second
 * was the bug — it described an **unbounded** cost as though three days were the end of it.
 * Nothing distinguished a rate an hour old from one three weeks old, and the three-week version
 * quoted a customer at last month's rate and froze it there forever.
 *
 * So the cache rule stands unchanged — no live fetch, no refusal merely because *today's* sync
 * missed — and a bound is added at the far end of it: past `FX_RATE_REFUSE_AFTER_HOURS` the
 * submit is refused with a sentence naming the way out. See `staleness.ts` for the two
 * thresholds, and for why the age is measured on `rate_timestamp` while the *ordering* below
 * stays on `fetched_at`. Three days is now where the cost stops rather than an example of it
 * continuing, which is what that sentence was reaching for without having.
 *
 * The reason it must never become a live fetch is stronger than tidiness. `forDestination` runs
 * inside `OrdersService.submit`'s transaction, which by then holds a lock on the order row. A
 * provider round-trip there would hold that lock for the length of somebody else's network, and
 * a provider that hangs would hold it for the length of a timeout — see `FxRatesRepository`'s
 * header, which states the same rule from the other side.
 *
 * ── ⭐ AND WHY IT FAILS CLOSED WHEN THERE IS NO OBSERVATION AT ALL ────────────────
 *
 * A destination configured for SGD, with no manual rate and no row in `fx_rates`, refuses the
 * submit. It does not fall back to baht.
 *
 * The argument is `order_documents_freeze`. A quotation document cannot be UPDATEd, ever, by
 * anybody — so a document that prints baht while its destination is configured for a foreign
 * currency is a document that contradicts its own configuration *permanently*, sitting in front
 * of a customer who will transfer the figure they can see. There is no correction, only a
 * superseding revision and an awkward conversation. A refused submit, by contrast, is a
 * sentence on a screen and a member of staff typing an override — recoverable in a minute, in
 * the same session, by the same person.
 *
 * That asymmetry is the whole of the decision, and it is the same one `resolveDestination`
 * makes about an unknown country code for the same reason: *"would compute Thai tax on a
 * foreign sale and pin it to the document permanently, with nothing recording that a fallback
 * happened"*. This is that sentence with the currency substituted in.
 *
 * A `resolveFxRate` that answers `ok: false` is refused identically and for the identical
 * reason — an unreadable override (`manual_rate_unreadable`) or a provider object with no SGD
 * in it (`destination_rate_missing`) leaves us with no rate, and having no rate is one
 * situation and not three. The distinction survives in `details.cause` for whoever is reading
 * the log, which is where it is useful and where it costs nothing.
 *
 * ── What this does NOT decide ────────────────────────────────────────────────────
 *
 * How a foreign figure is displayed beside baht, whether the customer pays it, and what the
 * document says about the rate it used are all `order-document.ts`'s and `quotation.ts`'s
 * questions. This hands over one `FxRate` and one timestamp; every figure derived from them is
 * derived there.
 */
@Injectable()
export class QuotationRateService {
  constructor(
    private readonly countries: TaxCountryService,
    private readonly snapshots: FxRatesRepository,
  ) {}

  /**
   * The destination a document is being priced for, resolved to the rate it converts at.
   *
   * `null` — quote in baht, no conversion — in exactly two cases, and both are ordinary
   * configuration rather than degradation:
   *
   *   1. the order names no destination at all, and
   *   2. the destination it names has no `fx_currency`, which is every domestic sale and every
   *      foreign one nobody has configured a currency for.
   *
   * Everything else either resolves or throws. There is no third answer, and in particular
   * there is no "we tried and fell back", because a fallback here is a frozen document that
   * disagrees with its own destination — see the class header.
   *
   * ⚠️ `tx` is REQUIRED and may be `undefined`, the same shape as
   * `TaxCountryService.resolveDestination` and for the reason argued at length there: this read
   * belongs inside the submit's transaction, dropping the argument changes nothing a runtime
   * test can observe, and so the compiler is made to notice instead. A caller that genuinely
   * has no transaction says `undefined` out loud.
   */
  async forDestination(
    countryCode: string | null,
    tx: Tx | undefined,
  ): Promise<ResolvedQuotationRate | null> {
    /* No destination is not a failed conversion; it is a baht quotation, which is most of them. */
    if (countryCode === null) return null;

    return this.fromSettings(await this.countries.resolveFxSettings(countryCode, tx), tx);
  }

  /**
   * ⭐ The same decision, for a caller that has already read the row.
   *
   * `OrdersService.submit` needs the tax envelope *and* the fx settings off one destination, and
   * getting them from two calls meant reading `tax_countries` twice inside a transaction already
   * holding a row lock — see `TaxCountryService.resolveForSubmit` for the measurement. This is
   * the half of `forDestination` after the lookup, so the two paths cannot decide differently:
   * the cache rule, the manual-override short-circuit and the refusal all live here, once.
   */
  async fromSettings(
    fx: DestinationFx | null,
    tx: Tx | undefined,
  ): Promise<ResolvedQuotationRate | null> {
    if (fx === null) return null;

    const { currency, settings } = fx;
    const countryCode = fx.code;

    /*
     * ⭐ An override short-circuits the snapshot entirely — it does not merely take precedence
     * over it. Reading `fx_rates` first and then discarding it would make a destination with a
     * typed-in rate unquotable on a day `fx_rates` was empty, which inverts the entire point of
     * being able to type one in. See `NO_SNAPSHOT_NEEDED` for why the argument is empty rather
     * than plausible.
     */
    if (settings.manualRateThbPerUnit !== null) {
      const resolved = resolveFxRate(currency, settings, NO_SNAPSHOT_NEEDED);
      if (!resolved.ok) throw unusable(countryCode, currency, resolved.reason);

      /* No provider, no observation, no timestamp — see `ResolvedQuotationRate.observedAt`. */
      return { rate: resolved.rate, observedAt: null };
    }

    const snapshot = await this.snapshots.latest(tx);
    if (snapshot === undefined) throw unusable(countryCode, currency, 'no_snapshot');

    /*
     * ⭐ THE AGE BOUND — the one thing the cache rule never said.
     *
     * The owner's rule is "use the cached value", and it stays: everything above this line
     * still reads the newest stored row and never fetches. What it did not say is that "the
     * cached value" describes an hour-old rate and a three-week-old rate in the same words,
     * and only the first is a rate. Past `FX_RATE_REFUSE_AFTER_HOURS` this refuses rather than
     * pinning a figure `order_documents_freeze` will then make permanent — see `staleness.ts`
     * for why 72, and for why the age is measured on `rateTimestamp` rather than `fetchedAt`.
     *
     * ⚠️ **Below the manual-override branch, and that placement is the escape hatch.** A
     * hand-typed rate short-circuits at `settings.manualRateThbPerUnit !== null` above and
     * never reaches this line, so an override is never refused for staleness — correctly, and
     * not by a special case here: a figure somebody read off a bank's screen has no provider
     * observation to be old. That is also what makes the refusal below honest when it tells
     * staff to type one; the way out it names is a way out that actually works, because it
     * runs before this check rather than around it.
     */
    const ageHours = fxRateAgeHours(snapshot.rateTimestamp, new Date());
    if (ageHours > FX_RATE_REFUSE_AFTER_HOURS) {
      throw tooStale(countryCode, currency, snapshot, ageHours);
    }

    const resolved = resolveFxRate(currency, settings, {
      base: snapshot.base,
      rates: snapshot.rates,
    });
    if (!resolved.ok) throw unusable(countryCode, currency, resolved.reason);

    /*
     * `rateTimestamp` and not `fetchedAt`: what a document can honestly claim is the moment the
     * provider struck the rate. `fetchedAt` is when our cron happened to run, which is a fact
     * about our infrastructure and not about the market. The two are never equal — see the
     * column's own note in `packages/db/src/schema/fx.ts` — so the choice is visible.
     */
    return { rate: resolved.rate, observedAt: snapshot.rateTimestamp.toISOString() };
  }

  /**
   * ⭐ THE SAME RATE, FOR A SCREEN — and the one method here that never throws.
   *
   * Staff compose a whole quotation in baht and the first anybody sees of the destination
   * currency is the issued document, at which point `order_documents_freeze` has already made
   * it permanent. This is what lets the editor show the figure *while it can still be changed*.
   *
   * ── ⚠️ WHY IT CANNOT REUSE `fromSettings`, EVEN THOUGH IT WANTS THE SAME ANSWER ──
   *
   * `fromSettings` throws — that is its job, and every one of its refusals is right *for a
   * submit*. On a read they would be catastrophic in a way that is easy to miss: `getQuote` and
   * every quote *write* answer with the whole quote, so a throw from here would 422 the editor
   * itself. A destination with no rate behind it would produce a quote screen that cannot be
   * opened, and a stale feed would make every existing foreign quotation unopenable and
   * uneditable — including the ones a salesperson is trying to correct. That is
   * `resolveForEditing`'s own lesson, verbatim: *"a read that refused would leave a cart
   * carrying a mistyped country permanently unopenable"*, and it applies with more force here,
   * because the whole point of the refusal is that staff should still be able to work.
   *
   * So every failure becomes a *reported absence*: `unavailable`, with a reason the screen can
   * phrase, and never an exception. The submit still refuses. The read still opens.
   *
   * ── ⭐ AND WHY IT REPORTS STALENESS RATHER THAN HIDING IT ────────────────────────
   *
   * A stale rate does **not** collapse to `unavailable` here. The figure is still returned,
   * with `stale: true` beside it, because the two facts a salesperson needs are different from
   * the two a submit needs: *roughly what will this cost in SGD*, and *will this actually go
   * out*. Hiding the number would answer neither, and showing it silently would let them
   * promise a customer a figure the submit is about to refuse. Both, together, is the only
   * version that tells them what is going to happen before it happens.
   */
  async preview(fx: DestinationFx | null, tx: Tx | undefined): Promise<QuotationRatePreview> {
    if (fx === null) return { ok: false, reason: 'no_destination_currency' };

    const { currency, settings } = fx;

    if (settings.manualRateThbPerUnit !== null) {
      const resolved = resolveFxRate(currency, settings, NO_SNAPSHOT_NEEDED);
      if (!resolved.ok) return { ok: false, reason: resolved.reason, currency };

      /* A typed rate has no observation, so it cannot be stale — the same statement the
       * refusal path makes by branching before it reads `fx_rates` at all. */
      return { ok: true, rate: resolved.rate, observedAt: null, stale: false, ageHours: null };
    }

    const snapshot = await this.snapshots.latest(tx);
    if (snapshot === undefined) return { ok: false, reason: 'no_snapshot', currency };

    const resolved = resolveFxRate(currency, settings, {
      base: snapshot.base,
      rates: snapshot.rates,
    });
    if (!resolved.ok) return { ok: false, reason: resolved.reason, currency };

    const ageHours = fxRateAgeHours(snapshot.rateTimestamp, new Date());

    return {
      ok: true,
      rate: resolved.rate,
      observedAt: snapshot.rateTimestamp.toISOString(),
      /* The identical comparison the submit makes, from the identical constant — so the badge
       * that says "this will be refused" and the refusal itself cannot disagree. */
      stale: ageHours > FX_RATE_REFUSE_AFTER_HOURS,
      ageHours,
    };
  }
}

/**
 * An indicative rate for a screen, or the reason there is not one. Never an exception.
 *
 * `stale: true` with `ok: true` is the deliberate combination: there is a figure, it is the
 * figure the submit *would* use, and the submit is going to refuse it. A shape that could not
 * express that would force the screen to choose between showing a number it cannot vouch for
 * and showing nothing about a submit that is about to fail.
 */
export type QuotationRatePreview =
  | {
      readonly ok: true;
      readonly rate: FxRate;
      /** ISO 8601, or `null` for a manual override — same rule as `ResolvedQuotationRate`. */
      readonly observedAt: string | null;
      /** Past the refusal threshold: the figure is shown, and the submit will refuse it. */
      readonly stale: boolean;
      /** `null` for a manual override, which has no observation to age. */
      readonly ageHours: number | null;
    }
  /**
   * There is no destination currency at all — a domestic quotation, an order naming no country,
   * or a code `tax_countries` has no row for. Its own arm, with no `currency` field, because
   * there is genuinely no currency to name and a `currency: null` would invite a screen to
   * render an empty one.
   */
  | { readonly ok: false; readonly reason: 'no_destination_currency' }
  /**
   * A currency is configured and no rate could be produced for it. The currency is always known
   * here — it came off the same row — which is what lets the screen say *"SGD, and we have no
   * rate"* rather than the uselessly generic "no rate".
   */
  | { readonly ok: false; readonly reason: RateFailure; readonly currency: Currency };

/**
 * The one refusal, built once so the three throw sites cannot drift apart.
 *
 * `reason` is what a client branches on and is the same for all three, because all three are
 * the same situation: this destination wants a foreign figure and we have no rate to produce
 * one with. `cause` is the finer distinction, kept for a log and for whoever is debugging a
 * sync — never for control flow, since there is no different thing to do about any of them.
 *
 * 422 and not 500: nothing is broken. A destination is configured for a currency and the rate
 * behind it is missing, which is a state of the configuration, and the sentence tells staff
 * which two things fix it.
 */
function unusable(countryCode: string, currency: string, cause: RateFailure): AppError {
  return AppError.validationFailed(message('error.fx.rate_unavailable'), {
    reason: 'fx_rate_unavailable',
    cause,
    destinationCountry: countryCode,
    currency,
  });
}

/**
 * ⭐ The other refusal: there *is* a rate, and it is too old to freeze onto a document.
 *
 * A separate `reason` from `fx_rate_unavailable`, and separate deliberately — this is the one
 * place this module's usual "having no rate is one situation and not three" argument does not
 * apply. The other three causes are all *"we cannot produce a figure"*; this one is *"we can,
 * and you should not want it"*, and a client that showed them identically would tell staff to
 * wait for the next sync when the next sync is exactly what has not been happening.
 *
 * `ageHours` is floored into the sentence and kept exact in `details`. A staff member reading
 * *"เก่ากว่า 72 ชั่วโมง"* does not want 73.4, and a support engineer reading the envelope does.
 */
function tooStale(
  countryCode: string,
  currency: string,
  snapshot: FxSnapshotRow,
  ageHours: number,
): AppError {
  return AppError.validationFailed(
    message('error.fx.rate_too_stale', {
      hours: countParam(Math.floor(ageHours)),
      limitHours: countParam(FX_RATE_REFUSE_AFTER_HOURS),
    }),
    {
      reason: 'fx_rate_too_stale',
      destinationCountry: countryCode,
      currency,
      /* Both clocks, because the pair is the diagnosis — see `staleness.ts`. A `fetchedAt`
       * minutes old beside an `observedAt` three weeks old is a frozen provider feed; the two
       * ageing together is a sync that has stopped running. */
      observedAt: snapshot.rateTimestamp.toISOString(),
      fetchedAt: snapshot.fetchedAt.toISOString(),
      ageHours,
      limitHours: FX_RATE_REFUSE_AFTER_HOURS,
    },
  );
}
