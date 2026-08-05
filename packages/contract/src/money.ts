import { z } from 'zod';
import type { Currency, Money } from '@wewin/core/money';
import { type Exact, encodeExact, exactSchema, toBigInt, unitOf } from './exact.js';

/**
 * Money on the wire.
 *
 * Amounts are minor units, as they are everywhere else in this codebase, and the unit
 * tag says so in words: `THB.satang`, `VND.dong`. Naming the minor unit rather than
 * writing `THB.minor` is not decoration — plan 4.3(c) is about a 100x error that reads
 * as plausible, and the cheapest defence against it is a payload that says `dong` where
 * a reader might have assumed cents. LAK and VND have no minor unit at all, and their
 * tags say the major unit's own name, which is exactly the fact `minorExponent` records.
 */

/**
 * The name of one minor unit of each currency.
 *
 * `satisfies` is doing real work here: it fails the build if a currency is added to
 * core without a name, and object-literal excess-property checking fails it if a name
 * is added for a currency that does not exist. The table is therefore always exactly
 * the currency list, without importing it.
 */
export const MINOR_UNIT_NAME = {
  CNY: 'fen',
  EUR: 'cent',
  INR: 'paise',
  LAK: 'kip',
  MYR: 'sen',
  SGD: 'cent',
  THB: 'satang',
  USD: 'cent',
  VND: 'dong',
} as const satisfies Record<Currency, string>;

/** `'THB.satang'`, `'VND.dong'` — the unit of one digit of an amount. */
export type MinorTag<C extends Currency = Currency> = C extends Currency
  ? `${C}.${(typeof MINOR_UNIT_NAME)[C]}`
  : never;

/**
 * `'THB.satang/m2'` — the unit of one digit of a *rate*.
 *
 * A rate and an amount are both integers of satang in the catalogue, and telling them
 * apart by field name alone is how a per-m² figure ends up added to a total. The tag
 * makes them different types.
 */
export type MinorPerSqmTag<C extends Currency = Currency> = `${MinorTag<C>}/m2`;

/**
 * `'THB.satang/1e12'` — the unit of one digit of `unitPriceScaledMinor`.
 *
 * `PriceBreakdown` carries the per-unit price at full working precision, which is
 * minor units × `PRICE_SCALE` (pricing.ts:81). That figure is a million million times
 * larger than the satang figure beside it, and on the wire the two are otherwise
 * indistinguishable strings of digits. The suffix is the divisor, so one digit here is
 * one 10^12th of a satang. `tests/money.test.ts` pins the exponent to core's own
 * `PRICE_SCALE` so the label cannot drift from the arithmetic it describes.
 */
export type ScaledMinorTag<C extends Currency = Currency> = `${MinorTag<C>}/1e12`;

export type MoneyWire<C extends Currency = Currency> = Exact<MinorTag<C>>;
export type MoneyRateWire<C extends Currency = Currency> = Exact<MinorPerSqmTag<C>>;
export type ScaledMoneyWire<C extends Currency = Currency> = Exact<ScaledMinorTag<C>>;

/**
 * Every currency core knows, at runtime.
 *
 * Derived from the table above rather than imported from `@wewin/core/money`, which
 * keeps this package's *runtime* dependency on core down to one small module
 * (`./units` via catalog.ts). The `satisfies` above is what makes the key set provably
 * the currency list, so the assertion restates a fact the compiler has already checked.
 */
const CURRENCIES = Object.keys(MINOR_UNIT_NAME) as Currency[];

export const minorTag = <C extends Currency>(currency: C): MinorTag<C> =>
  `${currency}.${MINOR_UNIT_NAME[currency]}` as MinorTag<C>;

export const minorPerSqmTag = <C extends Currency>(currency: C): MinorPerSqmTag<C> =>
  `${minorTag(currency)}/m2`;

export const scaledMinorTag = <C extends Currency>(currency: C): ScaledMinorTag<C> =>
  `${minorTag(currency)}/1e12`;

const TAG_TO_CURRENCY = new Map<string, Currency>(
  CURRENCIES.map((currency) => [minorTag(currency), currency]),
);

/**
 * The currency a tag names, whatever suffix it carries.
 *
 * Returns `null` rather than throwing so callers can report which field was wrong;
 * a tag that reached here has already passed `exactSchema`, so this fails only when a
 * caller mixes currencies inside one breakdown — which is a 409-class bug, not a parse
 * error, and deserves its own message.
 */
export function currencyOfTag(tag: string): Currency | null {
  const base = tag.replace(/\/(?:m2|1e12)$/, '');
  return TAG_TO_CURRENCY.get(base) ?? null;
}

const ALL_MINOR_TAGS = CURRENCIES.map(minorTag);

const tagsFor = <C extends Currency>(
  currency: C | undefined,
  suffix: '' | '/m2' | '/1e12',
): [string, ...string[]] => {
  const base = currency === undefined ? ALL_MINOR_TAGS : [minorTag(currency)];
  const tags = base.map((tag) => `${tag}${suffix}`);
  // `tagsFor` is only ever called over a non-empty currency list, but the tuple type
  // zod wants cannot be derived from `map`.
  const [head, ...rest] = tags;
  if (head === undefined) throw new Error('contract: no currencies are defined');
  return [head, ...rest];
};

/**
 * An amount in minor units. Pass a currency to pin the field to it — an endpoint that
 * only ever answers in baht should not accept a cent figure it would then add up.
 *
 * The three schemas below assert their output type because the tag list they accept is
 * built by `tagsFor` at runtime and no `map` produces a template-literal union. The
 * assertion is checked by test rather than by the compiler: `tests/money.test.ts` walks
 * every currency and every suffix and asserts each schema takes its own tags and
 * refuses the other two.
 */
export const moneyWireSchema = <C extends Currency = Currency>(
  currency?: C,
): z.ZodType<MoneyWire<C>> =>
  (exactSchema(tagsFor(currency, '')) as z.ZodType<MoneyWire<C>>).refine(
    (value) => withinInt8(toBigInt(value)),
    'จำนวนเงินเกินขอบเขตที่ระบบเก็บได้',
  ) as z.ZodType<MoneyWire<C>>;

/**
 * ⚠️ WHY A MONEY AMOUNT IS BOUNDED AND A LENGTH IS NOT — 5b red team, B6.
 *
 * `exact.ts` already caps the *string* at 40 digits, which contains `BigInt()`'s superlinear
 * parse. It does not contain what happens next: every amount in this system lands in a
 * Postgres `bigint`, which holds 19 digits, so a 40-digit figure reached the driver and came
 * back as SQLSTATE 22003 — neither an `AppError` nor an `HttpException`, so it fell through the
 * exception filter as **500 INTERNAL with a logged stack**, on `POST /orders`, reachable by any
 * visitor with a cart. A customer whose number is too big is not a server that is broken.
 *
 * The bound is `int8`'s own range and not a business ceiling: a business ceiling is a number
 * nobody has agreed (plan 13), and this one is a fact about the column. It is applied to
 * `moneyWireSchema` only — the rate and scaled schemas carry different units into different
 * columns, and giving them the same limit would be asserting something about columns this file
 * has not checked.
 */
const INT8_MAX = 9_223_372_036_854_775_807n;
const withinInt8 = (value: bigint): boolean => value >= -INT8_MAX - 1n && value <= INT8_MAX;

export const moneyRateWireSchema = <C extends Currency = Currency>(
  currency?: C,
): z.ZodType<MoneyRateWire<C>> =>
  exactSchema(tagsFor(currency, '/m2')) as z.ZodType<MoneyRateWire<C>>;

export const scaledMoneyWireSchema = <C extends Currency = Currency>(
  currency?: C,
): z.ZodType<ScaledMoneyWire<C>> =>
  exactSchema(tagsFor(currency, '/1e12')) as z.ZodType<ScaledMoneyWire<C>>;

/* ------------------------------------------------------------------ *
 * Codecs
 * ------------------------------------------------------------------ */

export const encodeMinor = <C extends Currency>(minor: bigint, currency: C): MoneyWire<C> =>
  encodeExact(minorTag(currency), minor);

export const encodeMoney = (amount: Money): MoneyWire =>
  encodeMinor(amount.minor, amount.currency);

export const encodeMinorPerSqm = <C extends Currency>(
  minorPerSqm: bigint,
  currency: C,
): MoneyRateWire<C> => encodeExact(minorPerSqmTag(currency), minorPerSqm);

export const encodeScaledMinor = <C extends Currency>(
  scaled: bigint,
  currency: C,
): ScaledMoneyWire<C> => encodeExact(scaledMinorTag(currency), scaled);

/**
 * Back to a `Money`, currency and all.
 *
 * There is no `toBaht` here and there will not be one. A caller that wants baht has
 * `formatBaht` in core, which takes minor units for the same reason this does: the
 * division is the place a rounding decision hides from review (format.ts:16-24).
 */
export function decodeMoney(wire: MoneyWire): Money {
  const tag = unitOf(wire);
  const currency = currencyOfTag(tag);
  if (currency === null) throw new TypeError(`contract: unknown money unit "${tag}"`);
  return { minor: toBigInt(wire), currency };
}

/**
 * The currency a wire amount is denominated in.
 *
 * There is no `decodeMinor` beside this: the digits come out through `toBigInt`, which
 * every wire quantity shares, and a second name for it in the money module would read
 * like a second conversion.
 */
export function currencyOf(wire: MoneyWire | MoneyRateWire | ScaledMoneyWire): Currency {
  const tag = unitOf(wire);
  const currency = currencyOfTag(tag);
  if (currency === null) throw new TypeError(`contract: unknown money unit "${tag}"`);
  return currency;
}
