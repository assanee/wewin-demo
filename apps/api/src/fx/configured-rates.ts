import {
  resolveFxRate,
  thbPerUnitText,
  type FxCountrySettings,
  type FxSnapshot,
} from '@wewin/core/fx';
import type { Currency } from '@wewin/core/money';
import type { FxConfiguredRateWire } from '@wewin/contract/organisation';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ THE NUMBERS THE FEED IS HOLDING — for the ~170 currencies, the two that matter.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `GET /admin/fx/health` reported the *health* of the feed and never the *figures*, so staff
 * could see that a sync had landed and could not see what had landed in it. That is a smaller
 * gap than it sounds: the whole reason a person opens this screen is to check the system's rate
 * against the one they know, and until now the screen answered every question about that rate
 * except what it was.
 *
 * ── ⭐ WHY THIS IS NOT "PRINT `rates`" ───────────────────────────────────────────
 *
 * A `latest.json` body carries about 170 currencies. Almost none of them are anything here:
 * this company sells to the destinations in `tax_countries`, and a currency with no destination
 * behind it is a number nobody will ever quote in. Dumping the object would bury the two rows
 * that matter under a screenful that never changes, and a reader scanning 170 rows for SGD is a
 * reader who will stop opening the card.
 *
 * So the list is driven from `tax_countries` and not from the provider's keyset. It is short by
 * construction, it grows only when somebody configures a destination, and every row on it is a
 * rate that can actually reach a document.
 *
 * ── ⭐⭐ WHY THE PROVIDER'S NUMBER IS NOT THE NUMBER, AND MUST NOT LOOK LIKE IT ───
 *
 * This is the part that would do real damage if it were got wrong, so it is worth being blunt.
 *
 * The free plan is USD-base. `rates['SGD'] = 1.35` means **1.35 Singapore dollars per US
 * dollar**. The figure a staff member here needs is **baht per Singapore dollar** — about 27 —
 * and it is derived from two of the provider's numbers, through a base that cancels, and then
 * marked down by the destination's spread. Between the raw figure and the useful one there is a
 * reciprocal, a cross-rate and a spread; they are not the same quantity, not the same magnitude,
 * and not comparable against each other.
 *
 * A staff member who opens Google, types "SGD to THB", reads 27.04, and then looks at a card
 * showing `1.35` has been actively misled by a screen that was telling the truth. So:
 *
 *   1. `effectiveThbPerUnit` — the rate the system would actually quote with, spread included —
 *      is the figure. It is what the row leads with and the only one comparable against a bank
 *      or a search engine.
 *   2. Every raw provider figure is nested under `provider`, beside the `base` that gives it
 *      meaning, so no template can print one where a THB rate belongs without saying `base` out
 *      loud in the same breath.
 *
 * ── ⭐ AND WHAT HAPPENS TO A DESTINATION WITH A MANUAL OVERRIDE ──────────────────
 *
 * `midThbPerUnit` is `null` for `source: 'manual'`, and that is the deliberate part.
 *
 * THE RULE in `packages/core/src/fx.ts` is that an override is used exactly as typed and the
 * spread is not applied on top of it — so for such a destination there is no "mid-market rate
 * currently in play". One could still be *computed*: the provider's figures are right there and
 * the arithmetic is three lines. Computing it would put a plausible, correctly-derived,
 * completely inapplicable number on a settings card next to the real one, and the first person
 * to reconcile a quotation against the wrong one of the two would be right to blame the screen.
 *
 * What is *not* hidden is the feed's own figures: `provider` is populated for a manual
 * destination exactly as it is for a mid-market one, because "what did the sync bring in" is a
 * fact about the feed and this card is about the feed. The screen labels it as not applied here.
 * The line is: **raw observations, yes; a derived rate the system would never use, no.**
 *
 * ── Pure, and therefore tested without a database ────────────────────────────────
 *
 * Nothing here reads a table or a clock. `FxController` hands it the newest row and the
 * destination list; every branch is a function of those two, which is what lets
 * `configured-rates.test.ts` state the manual-override case, the missing-currency case and the
 * cross-rate arithmetic as plain assertions.
 */

/** The half of a `tax_countries` row this file reads. Structurally satisfied by `TaxCountryWire`. */
export interface FxConfiguredDestination {
  readonly code: string;
  readonly nameTh: string;
  readonly fxCurrency: string | null;
  readonly fxSpreadBp: number;
  readonly fxManualRate: string | null;
  readonly isActive: boolean;
}

/** The stored observation, or `undefined` for a database that has never synced. */
export interface FxObservation {
  readonly base: string;
  readonly rates: Record<string, number>;
}

/**
 * ⭐ One row per destination that has a currency, resolved to the rate that destination quotes at.
 *
 * Destinations with no `fxCurrency` are dropped rather than listed with nulls: they are quoted in
 * baht, no conversion happens for them at all, and a row of blanks under a heading about exchange
 * rates invites a reader to think something is missing.
 *
 * ⚠️ **Withdrawn destinations are kept.** `is_active` governs which destinations a *new* order may
 * name, never whether an order that already names one resolves — `TaxCountryRepository.byCode` has
 * no `is_active` filter and says so at length. A withdrawn destination's rate can still be pinned
 * onto a document, so hiding it here would hide a live number. `isActive: false` travels instead
 * and the screen marks it.
 *
 * The order is the caller's — `sort_order` then code, as `TaxCountryRepository.list` returns them —
 * so this card and the tax table below it read in the same order.
 */
export function configuredRates(
  destinations: readonly FxConfiguredDestination[],
  observation: FxObservation | undefined,
): readonly FxConfiguredRateWire[] {
  const rows: FxConfiguredRateWire[] = [];

  for (const destination of destinations) {
    const { fxCurrency } = destination;
    if (fxCurrency === null) continue;

    rows.push(resolveOne(destination, fxCurrency as Currency, observation));
  }

  return rows;
}

function resolveOne(
  destination: FxConfiguredDestination,
  currency: Currency,
  observation: FxObservation | undefined,
): FxConfiguredRateWire {
  const settings: FxCountrySettings = {
    spreadBp: destination.fxSpreadBp,
    manualRateThbPerUnit: destination.fxManualRate,
  };
  const manual = destination.fxManualRate !== null;

  /*
   * The provider's own two figures for this destination, whatever happens next.
   *
   * Read before `resolveFxRate` rather than off its result, because `FxRate.provider` is `null`
   * for a manual override — correctly, since an override is derived from no provider figure at
   * all — and this card still wants to show what the sync brought in for that currency. The two
   * questions are genuinely different: "what did the feed say" and "what did we quote with".
   */
  const provider =
    observation === undefined
      ? null
      : figures(observation.rates[currency], observation.rates['THB']);

  /*
   * ⚠️ **The manual branch does not need an observation and must not wait for one.**
   *
   * `resolveFxRate` returns from `settings` alone when an override is set — it is the second
   * statement in that function — so a destination whose whole point is that somebody typed the
   * rate stays readable on a day `fx_rates` is empty. `QuotationRateService` makes the identical
   * short-circuit for the identical reason, with the identical empty placeholder; using a
   * plausible-looking one instead would resolve to a *wrong rate* silently if core's branch order
   * ever moved. See `NO_SNAPSHOT_NEEDED` there.
   */
  const snapshot: FxSnapshot | undefined = manual
    ? { base: '', rates: {} }
    : observation === undefined
      ? undefined
      : { base: observation.base, rates: observation.rates };

  const base = {
    countryCode: destination.code,
    countryNameTh: destination.nameTh,
    currency,
    isActive: destination.isActive,
    source: manual ? ('manual' as const) : ('mid_market' as const),
    spreadBp: destination.fxSpreadBp,
    /* `false` exactly when an override is set — THE RULE, restated as a boolean so no screen
     * has to re-derive it from `source` and get the polarity backwards. */
    spreadApplied: !manual,
    provider,
  };

  if (snapshot === undefined) {
    /* Mid-market with nothing stored. The one cause `@wewin/core/fx` cannot name, because it
     * never sees the table — the same word `QuotationRateService` uses for it. */
    return { ...base, effectiveThbPerUnit: null, midThbPerUnit: null, problem: 'no_snapshot' };
  }

  const resolved = resolveFxRate(currency, settings, snapshot);
  if (!resolved.ok) {
    return { ...base, effectiveThbPerUnit: null, midThbPerUnit: null, problem: resolved.reason };
  }

  return {
    ...base,
    effectiveThbPerUnit: thbPerUnitText(resolved.rate),
    /*
     * `null` for a manual override — see this file's header. `FxRate.midThbPerUnit` is already
     * `null` on that branch, so this is core's own answer passed through rather than a second
     * decision made here.
     */
    midThbPerUnit:
      resolved.rate.midThbPerUnit === null
        ? null
        : thbPerUnitText({ ...resolved.rate, thbPerUnit: resolved.rate.midThbPerUnit }),
    problem: null,
  };
}

/**
 * Both provider figures, or `null` unless both are present and usable.
 *
 * All-or-nothing because the pair is what means something: `unitPerBase` without `thbPerBase` is
 * a number denominated in a currency this business does not price in, and a screen showing one
 * of the two would be showing the half that cannot be reasoned from. `Record<string, number>`
 * also admits `NaN`, `Infinity` and negatives — none of which survive `readRatio` — so they are
 * refused here rather than printed as digits.
 */
function figures(
  unitPerBase: number | undefined,
  thbPerBase: number | undefined,
): { readonly unitPerBase: number; readonly thbPerBase: number } | null {
  if (!usable(unitPerBase) || !usable(thbPerBase)) return null;

  return { unitPerBase, thbPerBase };
}

function usable(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}
