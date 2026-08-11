import { divRoundHalfUp, minorPerUnit, type Currency } from './money.js';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Baht into a foreign figure — the arithmetic, and nothing that decides when to run it.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Open Exchange Rates publishes the **mid-market** rate: the midpoint between what banks
 * buy and sell at, and a price nobody actually transacts at. A ฿36,500 product quoted at a
 * mid-market 36.5 THB/USD becomes USD 1,000; the customer pays USD 1,000; the bank converts
 * at something nearer 35.9 and ฿35,900 lands — ฿600 short of the price that was agreed. The
 * two settings this module reads are what close that gap, and they live one row per
 * destination in `tax_countries` (`fx_spread_bp`, `fx_manual_rate`, `fx_currency`).
 *
 * ── ⭐ THE RULE, when both settings are set ───────────────────────────────────────
 *
 * **A manual override means that exact rate. The percentage spread is not applied on top
 * of it.** `resolveFxRate` is the only place that decides this, it is total, and every
 * conversion goes through it — so no caller can apply both by accident.
 *
 * The argument is what each setting is *for*, not which is more specific:
 *
 *   - The **spread** corrects a rate we did not choose. A mid-market figure is not a price;
 *     it is the midpoint of a spread that already exists in the market, and the percentage
 *     is our estimate of the half of that spread the bank will take from us. It is a
 *     correction applied to somebody else's number.
 *   - The **override** replaces that number with one we did choose — a figure a member of
 *     staff read off a bank's screen. A rate a bank quotes is already a transactable rate:
 *     the bank's own margin is baked into it. That is what makes it different from a
 *     mid-market rate, and it is the entire reason to type one in.
 *
 * Applying the percentage on top would therefore charge the bank's margin twice: once
 * because the quoted rate already contains it, and once more because we assumed it did not.
 * At a 2% spread on a ฿36,500 quotation that is roughly ฿730 of invented margin, arriving
 * with nothing on the document saying where it came from. The failure mode of the other
 * choice — an override that quietly *under*-recovers because somebody expected the spread
 * to still be there — is visible the moment the money lands short, and is fixed by typing a
 * different override. The failure mode of double-counting is a customer who was overcharged
 * and a figure nobody can reconstruct.
 *
 * `fx_spread_bp` is deliberately **not** cleared when an override is set: it stays on the
 * row, inert, so that removing the override restores the previous behaviour without anybody
 * retyping it, and so `tax_country_changes` records the two independently.
 *
 * ── ⭐ WHICH DIRECTION THE SPREAD MOVES, and why it divides rather than multiplies ─
 *
 * The spread marks the **rate** down, it does not mark the **amount** up:
 *
 *     effective THB per unit = mid THB per unit × (1 − s)
 *
 * so a 2% spread against a mid of 36.5 THB/USD gives 35.77, and the customer's figure comes
 * out as ฿36,500 ÷ 35.77 = USD 1,020.41.
 *
 * The obvious alternative — take the mid-market foreign figure and add 2% to it — gives USD
 * 1,020.00, and it is wrong in a way that is small but structural. `s` exists to estimate
 * the markdown `b` the bank will apply. Charging `F` recovers `F × mid × (1 − b)` baht. With
 * the rate-side rule and `s = b` that is exactly the price:
 *
 *     F = P ÷ (mid × (1 − s))  ⟹  F × mid × (1 − s) = P
 *
 * With the amount-side rule it is `P × (1 + s) × (1 − s) = P × (1 − s²)` — always short, by
 * `s²`. On ฿36,500 at 2% that is ฿14.60 that the setting *whose entire job is closing a gap*
 * does not close, and the shortfall grows as the square of the spread. Two further reasons
 * the rate side is the right side: a spread is by definition a difference between two rates,
 * so 35.77 is directly comparable against the number on a bank's screen and an override is
 * the same quantity in the same units; and it is the only form under which the override and
 * the mid-market path produce the identical kind of thing, which is what lets `FxRate` carry
 * one rate and no flag saying how to read it.
 *
 * ── ⭐ WHERE ROUNDING HAPPENS: once, at the end, and nowhere else ─────────────────
 *
 * The requirement is that a figure a customer questions is reconstructible from the stored
 * `rates` object, the country's settings, and nothing else. So:
 *
 *   1. The provider's rates are read as **exact decimals**, from their own decimal text —
 *      not as floats. `String(36.5)` is `'36.5'`, and splitting that into digits has no
 *      magnitude at which it starts being wrong. Same decision, for the same reason,
 *      `readSatang` (`money.ts`) makes about reading an amount out of a text box.
 *   2. The cross-rate through the provider's base, the spread, and the two currencies'
 *      minor-unit exponents are all carried as one **exact bigint ratio**. Nothing is
 *      rounded to a "rate with N decimal places" along the way.
 *   3. `divRoundHalfUp` runs **once**, on the final minor-unit figure, half away from zero.
 *
 * This is `vat.ts:61-74`'s lesson, applied to a chain that is one figure longer.
 * `fromGrand` derives VAT by subtracting rather than by a second multiplication because two
 * independent roundings produce three numbers that do not add up, "and an invoice whose
 * three numbers do not add up is one nobody can sign". Here the second rounding that would
 * do the same damage is rounding the *rate*: at four decimal places, ฿100,000 to SGD comes
 * out a cent apart from the exact chain (SGD 3,698.64 against 3,698.63) — see the test that
 * pins it. So the rate is never rounded before it is used.
 *
 * The consequence, stated out loud because it is the thing a reader will trip on:
 * **`thbPerUnitText` is a rendering, never the divisor.** It exists so a person can read
 * the rate; a document that printed it and expected `baht ÷ printed rate` to reproduce the
 * foreign figure to the last minor unit would be relying on a number this module did not
 * use. What reconstructs the figure is the pair of provider rates and the country's
 * settings, all of which are stored.
 *
 * ── The cross-rate, and why it is visible ─────────────────────────────────────────
 *
 * The free Open Exchange Rates plan is USD-base only, so THB→SGD exists only as a
 * derivation through USD (`fx.ts` in `packages/db/src/schema` says the same thing about why
 * the whole response object is stored rather than a computed pair). `resolveFxRate` does
 * that derivation as `rates[THB] ÷ rates[SGD]` — both figures being "X per base" — and hands
 * back the two it used, verbatim, on `FxRate.provider`. Nothing about the arithmetic assumes
 * the base is USD; what assumes it is the plan we are on.
 *
 * ── What is configurable, and what a salesperson still cannot do ──────────────────
 *
 * `vat.ts`'s header records the rule this module must not break: the *configurable* part is
 * the rate and the treatment, and the fixed part is that nothing on a quotation can move
 * them. The same shape holds here. What is configurable is a **spread** and an **override
 * rate**, both per destination, both rows in `tax_countries` editable only by a holder of
 * `organisation.write`, and both recorded in `tax_country_changes` before and after. What is
 * not configurable is anything reachable from a quote: `FxRate` carries exactly a currency
 * and one exact rate, there is no per-line or per-quotation field anywhere in this module,
 * and `resolveFxRate` is the only constructor of an `FxRate` — so no code path can vary the
 * rate, the spread, or the interaction rule for one deal. A salesperson still cannot type a
 * rate; that is still the point.
 *
 * ── Scope ────────────────────────────────────────────────────────────────────────
 *
 * Arithmetic only. Nothing here decides *when* a rate is pinned, which observation counts as
 * "the" rate for a quotation, or how a foreign figure is displayed beside baht — that last
 * one is the question the owner has not answered, and the quotation document is frozen once
 * issued. Nothing in this repository calls this module yet, on purpose.
 */

/* ------------------------------------------------------------------ *
 * Exact decimals — a rate is a ratio, not money
 * ------------------------------------------------------------------ */

/**
 * An exact rational. Rates are ratios between two currencies, not amounts of either, so
 * they are never `bigint` minor units — forcing 36.5 THB/USD into satang would invent a
 * currency for a number that is not one (the header of `packages/db/src/schema/fx.ts` makes
 * the same call about the storage type).
 */
export interface Ratio {
  readonly n: bigint;
  readonly d: bigint;
}

/** Optional whole part, optional fraction, optional exponent. No sign: a rate is positive. */
const DECIMAL = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d{1,3}))?$/u;

/**
 * A bound on `BigInt()`, which is superlinear in its input and would otherwise be reachable
 * from a stored value somebody typed. `exact.ts` in `@wewin/contract` picks 40 for the same
 * reason; a rate needs far fewer, and 40 leaves room for a very small rate written out.
 */
const MAX_RATE_DIGITS = 40;

/** The largest power of ten this module will build. Keeps `10n ** x` from being a weapon. */
const MAX_SCALE = 60;

/**
 * A positive decimal, read as digits rather than as a number.
 *
 * `null` for anything that is not one — including a negative, a zero, `NaN`, `Infinity`, and
 * a string with a sign or spaces inside it. Never throws: a malformed rate is a value the
 * caller reports, the same shape `parseLatestRates` (`apps/api/src/fx/latest-rates.ts`) uses
 * for a malformed provider body.
 */
export function readRatio(value: number | string): Ratio | null {
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    /*
     * `String(n)` is the shortest decimal that round-trips the double, which for a provider
     * figure is the text the provider itself printed. Reading *that* is exact; reading the
     * double by multiplying it into an integer is the 2.6%-wrong trick `readSatang` refuses.
     */
    text = String(value);
  } else {
    text = value.trim();
  }

  const match = DECIMAL.exec(text);
  if (match === null) return null;

  const whole = match[1] ?? '';
  const fraction = match[2] ?? '';
  const exponent = match[3] === undefined ? 0 : Number(match[3]);

  const digits = `${whole}${fraction}`;
  if (digits.length > MAX_RATE_DIGITS) return null;

  const units = BigInt(digits);
  if (units === 0n) return null;

  const scale = fraction.length - exponent;
  if (Math.abs(scale) > MAX_SCALE) return null;

  return scale >= 0
    ? { n: units, d: 10n ** BigInt(scale) }
    : { n: units * 10n ** BigInt(-scale), d: 1n };
}

/* ------------------------------------------------------------------ *
 * The settings, and the one place the interaction rule lives
 * ------------------------------------------------------------------ */

/**
 * The spread's ceiling, exclusive.
 *
 * A spread of 100% would make the effective rate zero and the division undefined, so this
 * bound is arithmetic rather than policy and belongs here — the opposite of `vat.ts`'s
 * `assertRate`, which deliberately carries *no* upper bound and leaves the ceiling to
 * `tax_countries_rate_in_range`. The business ceiling is still the database's:
 * `tax_countries_fx_spread_in_range` refuses anything above 2,000 bp, five times the worst
 * retail FX spread, and that is the one an administrator will ever meet.
 */
export const FX_SPREAD_BP_LIMIT = 10_000;

/** What one destination row says about converting out of baht. */
export interface FxCountrySettings {
  /** Basis points shaved off the mid-market rate, so 2% is 200. `0` is a real setting. */
  readonly spreadBp: number;
  /**
   * Baht per **one whole unit** of the destination currency, as an exact decimal string —
   * `'35.90'` for USD, `'27.05'` for SGD. `null` to use the mid-market rate.
   *
   * A string and not a number for the reason `money.ts` gives about amounts: a decimal that
   * survives a float round-trip is luck. `numeric` in Postgres hands drizzle a string
   * already, so this is also what the column actually reads back as.
   *
   * ⚠️ Baht per foreign unit, one direction, always — even where a bank would naturally
   * quote the other way round (a Thai bank says "1 บาท = 700 ดอง", not "0.00143 บาท/ดอง").
   * One column cannot hold two conventions, and this is the direction that is directly
   * comparable with the mid-market rate derived below, which is what makes a spread
   * legible: 35.90 against a mid of 36.50 is visibly 1.6% worse.
   */
  readonly manualRateThbPerUnit: string | null;
}

export type FxRateSource = 'mid_market' | 'manual';

/** The two provider figures a mid-market rate was derived from, kept verbatim. */
export interface FxProviderInputs {
  /** What the stored observation was based on — `'USD'` on the free plan. */
  readonly base: string;
  /** `rates['THB']` exactly as stored. */
  readonly thbPerBase: number;
  /** `rates[currency]` exactly as stored. */
  readonly unitPerBase: number;
}

/**
 * One destination's rate, resolved. The **only** constructor is `resolveFxRate`.
 *
 * `spreadBp` is the spread that was actually applied, which is `0` for a manual override —
 * see THE RULE in the header. It is not the value on the row.
 */
export interface FxRate {
  readonly currency: Currency;
  readonly source: FxRateSource;
  readonly spreadBp: number;
  /** Baht per one whole unit of `currency`. Exact, and never rounded. */
  readonly thbPerUnit: Ratio;
  /** The same quantity before the spread. `null` when `source` is `'manual'`. */
  readonly midThbPerUnit: Ratio | null;
  /** `null` when `source` is `'manual'` — an override needs no provider figures at all. */
  readonly provider: FxProviderInputs | null;
}

/** One row of `fx_rates`, as much of it as conversion needs. */
export interface FxSnapshot {
  readonly base: string;
  readonly rates: Readonly<Record<string, number>>;
}

export type FxRateProblem =
  | 'same_currency'
  | 'destination_rate_missing'
  | 'baht_rate_missing'
  | 'manual_rate_unreadable';

export type FxRateResult =
  | { readonly ok: true; readonly rate: FxRate }
  | { readonly ok: false; readonly reason: FxRateProblem };

/**
 * Mirrors `vat.ts`'s `assertRate`, and throws for the same class of thing: a spread outside
 * this range is a bug in the caller, not a state of the world, and a `RangeError` from the
 * function that would otherwise divide by zero says so more usefully than a wrong figure.
 * A *missing provider rate* is the other class entirely, and comes back as `ok: false`.
 */
function assertSpread(spreadBp: number): void {
  if (!Number.isInteger(spreadBp) || spreadBp < 0 || spreadBp >= FX_SPREAD_BP_LIMIT) {
    throw new RangeError(
      `fx: spreadBp must be an integer in [0, ${String(FX_SPREAD_BP_LIMIT)}), got ${String(spreadBp)}`,
    );
  }
}

const BP = 10_000n;

/**
 * ⭐ A destination's settings and one stored observation, resolved to a single exact rate.
 *
 * The whole interaction rule between the two settings is the first branch below, and this is
 * the only function that has it — see THE RULE in this file's header for the argument.
 */
export function resolveFxRate(
  currency: Currency,
  settings: FxCountrySettings,
  snapshot: FxSnapshot,
): FxRateResult {
  assertSpread(settings.spreadBp);

  /*
   * Converting baht to baht is not a conversion, and with a spread attached it would be a
   * silent mark-up of the domestic price. `tax_countries_fx_currency_not_thb` refuses to
   * store it; this refuses to compute it, so neither depends on the other being present.
   */
  if (currency === 'THB') return { ok: false, reason: 'same_currency' };

  /*
   * ⭐ THE RULE. An override is a rate somebody chose, off a bank's screen, with the bank's
   * own margin already in it. The spread corrects a rate nobody chose. Applying the second
   * to the first charges that margin twice — so the override is used exactly as typed, and
   * the resolved rate reports `spreadBp: 0` because zero is what was applied.
   */
  if (settings.manualRateThbPerUnit !== null) {
    const manual = readRatio(settings.manualRateThbPerUnit);
    if (manual === null) return { ok: false, reason: 'manual_rate_unreadable' };

    return {
      ok: true,
      rate: {
        currency,
        source: 'manual',
        spreadBp: 0,
        thbPerUnit: manual,
        midThbPerUnit: null,
        provider: null,
      },
    };
  }

  /*
   * Two reasons, kept apart: a provider object with no THB in it is unusable for every
   * destination at once, while a missing destination rate is one country's problem. A caller
   * deciding whether to fall back to a cached observation or to refuse the whole screen wants
   * to be able to tell those apart. A present-but-unusable figure (zero, negative, `NaN` —
   * all of which `Record<string, number>` admits) is reported as the same missing, because it
   * is missing for every purpose a conversion has.
   */
  const thbPerBaseValue = snapshot.rates['THB'];
  if (thbPerBaseValue === undefined) return { ok: false, reason: 'baht_rate_missing' };
  const thbPerBase = readRatio(thbPerBaseValue);
  if (thbPerBase === null) return { ok: false, reason: 'baht_rate_missing' };

  const unitPerBaseValue = snapshot.rates[currency];
  if (unitPerBaseValue === undefined) return { ok: false, reason: 'destination_rate_missing' };
  const unitPerBase = readRatio(unitPerBaseValue);
  if (unitPerBase === null) return { ok: false, reason: 'destination_rate_missing' };

  /*
   * The cross-rate, through whatever base the observation carried — USD on the free plan.
   * (thb/base) ÷ (unit/base) = thb/unit, and the base cancels rather than being assumed.
   */
  const mid: Ratio = {
    n: thbPerBase.n * unitPerBase.d,
    d: thbPerBase.d * unitPerBase.n,
  };

  /*
   * The spread marks the rate down — see the header for why this is a division on the
   * customer's figure rather than a mark-up of it. No rounding: the factor is folded into
   * the ratio and stays exact all the way to the single `divRoundHalfUp` in `convertFromBaht`.
   */
  const thbPerUnit: Ratio = {
    n: mid.n * (BP - BigInt(settings.spreadBp)),
    d: mid.d * BP,
  };

  return {
    ok: true,
    rate: {
      currency,
      source: 'mid_market',
      spreadBp: settings.spreadBp,
      thbPerUnit,
      midThbPerUnit: mid,
      provider: { base: snapshot.base, thbPerBase: thbPerBaseValue, unitPerBase: unitPerBaseValue },
    },
  };
}

/* ------------------------------------------------------------------ *
 * The conversion — one division, one rounding
 * ------------------------------------------------------------------ */

/**
 * ⭐ Baht in minor units to the destination currency's minor units.
 *
 * The **only** rounding in the whole chain, half away from zero, on the final figure. See
 * the header: rounding the rate first is a second rounding, and it moves the answer.
 *
 * Both currencies' minor-unit exponents are folded into the same ratio rather than applied
 * as a separate scaling step, so THB→VND (2 minor places to 0) needs no special case and
 * gets no intermediate truncation.
 *
 * Negative amounts convert too, and land on the same side of a half as positive ones do —
 * credits, refunds and FX differences are exactly the case `divRoundHalfUp` exists for and
 * exactly where `Math.round` would round the wrong way.
 */
export function convertFromBaht(thbMinor: bigint, rate: FxRate): bigint {
  const foreignMinorPerUnit = minorPerUnit(rate.currency);
  const bahtMinorPerUnit = minorPerUnit('THB');

  return divRoundHalfUp(
    thbMinor * foreignMinorPerUnit * rate.thbPerUnit.d,
    bahtMinorPerUnit * rate.thbPerUnit.n,
  );
}

export interface FxAmount {
  readonly currency: Currency;
  /** Minor units of `currency` — cents, đồng. */
  readonly minor: bigint;
  /** Everything the figure was derived from. */
  readonly rate: FxRate;
}

export type FxAmountResult =
  | { readonly ok: true; readonly amount: FxAmount }
  | { readonly ok: false; readonly reason: FxRateProblem };

/** `resolveFxRate` then `convertFromBaht`, for a caller that wants both in one step. */
export function quoteFromBaht(
  thbMinor: bigint,
  currency: Currency,
  settings: FxCountrySettings,
  snapshot: FxSnapshot,
): FxAmountResult {
  const resolved = resolveFxRate(currency, settings, snapshot);
  if (!resolved.ok) return resolved;

  return {
    ok: true,
    amount: { currency, minor: convertFromBaht(thbMinor, resolved.rate), rate: resolved.rate },
  };
}

/* ------------------------------------------------------------------ *
 * Showing a rate to a person
 * ------------------------------------------------------------------ */

/** What `thbPerUnitText` renders at unless a caller says otherwise. */
export const FX_RATE_DISPLAY_DP = 6;

/**
 * ⚠️ **A rendering, never the divisor.**
 *
 * `convertFromBaht` divides by the exact ratio, not by this string, and the two differ:
 * ฿100,000 to SGD is 3,698.63 exactly and 3,698.64 through a rate rounded to four places.
 * Printing this next to a figure and inviting a reader to reproduce the figure from it would
 * be inviting them to reproduce a different one. What reconstructs the figure is
 * `FxRate.provider` plus the country's settings — both stored, both on the audit chain.
 *
 * Half away from zero, like every other rounding here, so the rendered rate is at least the
 * nearest one rather than a truncation.
 */
export function thbPerUnitText(rate: FxRate, decimals: number = FX_RATE_DISPLAY_DP): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_SCALE) {
    throw new RangeError(`fx: decimals must be an integer in [0, ${String(MAX_SCALE)}]`);
  }

  /*
   * No sign handling, unlike `satangField` in `money.ts`: an amount can be a credit, a rate
   * cannot. `readRatio` refuses anything but a positive decimal and the spread factor
   * `(BP − spreadBp)` is positive because `assertSpread` bounds it below `BP`, so every
   * `FxRate` this module can construct is positive and a negative branch here would be
   * unreachable code pretending to be defensive.
   */
  const scale = 10n ** BigInt(decimals);
  const scaled = divRoundHalfUp(rate.thbPerUnit.n * scale, rate.thbPerUnit.d);
  if (decimals === 0) return scaled.toString();

  const fraction = (scaled % scale).toString().padStart(decimals, '0');
  return `${(scaled / scale).toString()}.${fraction}`;
}
