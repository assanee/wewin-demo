import { Injectable } from '@nestjs/common';
import { resolveFxRate, type FxRate, type FxRateProblem, type FxSnapshot } from '@wewin/core/fx';

import { AppError } from '../common/errors/app-error';
import { message } from '../i18n';
import { TaxCountryService, type DestinationFx } from '../organisation/tax-country.service';
import { FxRatesRepository, type Tx } from './fx-rates.repository';

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
 * the newest row of `fx_rates` and nothing else. There is no freshness check, no "is today's
 * fetch missing" branch, and no HTTP client reachable from this file: a sync that failed for
 * three days costs three days of staleness, and costs nobody a submit they cannot make.
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
}

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
