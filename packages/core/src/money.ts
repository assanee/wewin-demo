/**
 * Money primitives.
 *
 * Amounts are `bigint` counts of a currency's minor unit — satang, cents, đồng.
 * Never `number`: a price that survives a float round-trip is luck, not design, and
 * the one place this codebase already had to work around it is `pricing.ts` adding
 * `+ 0` to stop a total rendering as "-0".
 *
 * Two ideas are kept apart on purpose (plan 4.3c):
 *
 *   minorExponent  a fact about the currency. THB has 2, VND has 0. Not negotiable.
 *   roundTo        a business policy about which amounts look finished. Negotiable.
 *
 * Conflating them produces a 100x error that reads as plausible — this project's own
 * plan once claimed `100000` meant "round to the nearest thousand đồng", when VND has
 * no minor unit and 100000 minor is ₫100,000.
 */

export const CURRENCIES = ['CNY', 'EUR', 'INR', 'LAK', 'MYR', 'SGD', 'THB', 'USD', 'VND'] as const;

export type Currency = (typeof CURRENCIES)[number];

/** How many decimal places the currency's minor unit sits at. A fact, not a policy. */
export const MINOR_EXPONENT: Record<Currency, 0 | 2> = {
  CNY: 2,
  EUR: 2,
  INR: 2,
  LAK: 0,
  MYR: 2,
  SGD: 2,
  THB: 2,
  USD: 2,
  VND: 0,
};

/** Minor units in one whole unit of the currency: 100 satang to the baht, 1 đồng to the đồng. */
export function minorPerUnit(currency: Currency): bigint {
  return MINOR_EXPONENT[currency] === 0 ? 1n : 100n;
}

export interface Money {
  readonly minor: bigint;
  readonly currency: Currency;
}

export const money = (minor: bigint, currency: Currency): Money => ({ minor, currency });

/**
 * Divide, rounding a half **away from zero**.
 *
 * This is the half_up the accounting world means, and it is not what `Math.round`
 * does: `Math.round(-1432.5)` is `-1432`, because it rounds toward +Infinity. With
 * only positive amounts in the system the difference never showed. Credits, refunds
 * and FX differences all produce negatives, so the rule is fixed here once.
 */
export function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new RangeError('divRoundHalfUp: denominator must not be zero');

  const negative = numerator < 0n !== denominator < 0n;
  const absNumerator = numerator < 0n ? -numerator : numerator;
  const absDenominator = denominator < 0n ? -denominator : denominator;

  // Compare twice the remainder against the divisor: `>=` is what makes a half go up.
  const quotient = absNumerator / absDenominator;
  const remainder = absNumerator % absDenominator;
  const rounded = remainder * 2n >= absDenominator ? quotient + 1n : quotient;

  return negative ? -rounded : rounded;
}

/**
 * Round an amount to the nearest multiple of `unit`, in the same minor units.
 *
 * `unit` is the policy half of the pair above: 100 makes a THB total land on a whole
 * baht, 1000 makes a VND total land on a thousand đồng. It is always counted in minor
 * units, so reading it never requires knowing the exponent.
 */
export function roundToUnit(minor: bigint, unit: bigint): bigint {
  if (unit <= 0n) throw new RangeError('roundToUnit: unit must be positive');
  return divRoundHalfUp(minor, unit) * unit;
}

/**
 * Round an amount **up** to the nearest multiple of `unit`, away from zero.
 *
 * The rate table carries a mode per currency because the published examples need
 * both: ₫5,990,400 is quoted as ₫5,991,000, which half_up would not produce. Away
 * from zero rather than toward +Infinity so that "always rounds in the holder's
 * favour" stays true on a credit as well as a charge.
 */
export function ceilToUnit(minor: bigint, unit: bigint): bigint {
  if (unit <= 0n) throw new RangeError('ceilToUnit: unit must be positive');

  const negative = minor < 0n;
  const absolute = negative ? -minor : minor;
  const remainder = absolute % unit;
  const rounded = remainder === 0n ? absolute : absolute + (unit - remainder);

  return negative ? -rounded : rounded;
}

/** Sum minor amounts with no intermediate rounding. Callers round once, at the end. */
export function addMinor(amounts: readonly bigint[]): bigint {
  let total = 0n;
  for (const amount of amounts) total += amount;
  return total;
}

/**
 * Whole currency units to minor units.
 *
 * For the figures that are still plain integers of baht — `pricePerSqm`, the "from"
 * prices on the catalogue and marketing pages. Explicit at the call site on purpose:
 * a formatter that silently accepted both would be a 100x error with no symptom.
 */
export function bahtToMinor(baht: number): bigint {
  return BigInt(Math.round(baht)) * 100n;
}

/* ------------------------------------------------------------------ *
 * Reading an amount out of a text box
 * ------------------------------------------------------------------ */

export type ParseResult = { readonly ok: true; readonly value: bigint } | { readonly ok: false; readonly problemTh: string };

/** `฿1,972.24` for a text box: no currency mark, no grouping, always two places. */
export function satangField(minor: bigint): string {
  const negative = minor < 0n;
  const magnitude = negative ? -minor : minor;
  const satang = (magnitude % 100n).toString().padStart(2, '0');

  return `${negative ? '-' : ''}${(magnitude / 100n).toString()}.${satang}`;
}

/** Optional thousands separators, then baht, then at most two decimal places. */
const AMOUNT = /^(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?$/u;

/**
 * ⭐ Baht-and-satang from a text box, read as digits rather than as a number.
 *
 * ⚠️ **`Math.trunc(parseFloat(text) * 100)` is wrong 2.6% of the time.** Measured, not
 * assumed: across the 200,000 amounts between ฿0 and ฿40,000 ending in .01/.29/.57/.83/.99,
 * it produces the wrong satang for 5,209 of them — `0.29` becomes 28, `2.01` becomes 200 —
 * because those decimals are not representable in binary and land a hair below.
 *
 * `Math.round` rescues these magnitudes, and that is the problem with it: it is a claim
 * about how large the numbers will be, made in a function whose job is deciding where
 * somebody's money goes. Splitting the string has no magnitude at which it starts being
 * wrong, and needs no argument about which magnitudes are reachable.
 *
 * The API refuses anything but positive amounts (`positiveThbSchema`), so a minus is a typo
 * here and not a credit — refused with a sentence rather than sent and 422'd.
 */
export function readSatang(text: string): ParseResult {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: false, problemTh: 'กรอกจำนวนเงิน' };

  const match = AMOUNT.exec(trimmed);
  if (match === null) {
    return { ok: false, problemTh: 'กรอกเป็นตัวเลข ทศนิยมไม่เกินสองตำแหน่ง เช่น 1972.24' };
  }

  const baht = (match[1] ?? '').replaceAll(',', '');
  /*
   * `.4` is forty satang, not four. Padding rather than parsing is the same decision as
   * above: "5.4" and "5.40" are one amount, and the place a digit sits in decides its value.
   */
  const satang = (match[2] ?? '').padEnd(2, '0');

  return { ok: true, value: BigInt(baht) * 100n + BigInt(satang === '' ? '0' : satang) };
}
