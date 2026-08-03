import { z } from 'zod';

/**
 * Exact quantities on the wire.
 *
 * `JSON.stringify(1n)` throws, so an exact quantity crosses an HTTP boundary as a
 * string of digits. That much is settled: `quote.ts` already made this trade for
 * localStorage — `replacer` writes `value.toString()`, `readMinor` accepts only
 * `/^-?\d+$/` and hands back a `bigint` (quote.ts:229, quote.ts:236). Digits, never a
 * `number`, in both directions. This module does the same thing and deliberately does
 * not invent a second encoding.
 *
 * What it adds is the unit, and the reason is that the two boundaries have different
 * readers. A localStorage payload is read only by a build of this app, and
 * `parseStoredQuote` discards the whole thing when `schemaVersion` moves, so
 * `totalMinor: "879100"` can mean satang *by agreement*. An HTTP body is read by
 * clients this repository does not ship, in languages that have no `PriceBreakdown` to
 * consult, and it survives every deploy on both sides. There the agreement has to
 * travel with the number:
 *
 *     { "unit": "THB.satang", "digits": "879100" }
 *     { "unit": "um",         "digits": "3200000" }
 *
 * Two things then make a misreading structurally impossible rather than merely
 * discouraged:
 *
 *   1. `Exact<U>` exposes no readable member. `wire.digits / 100` is a compile error,
 *      not a wrong answer; the only way to a number is `toBigInt`, and the only way
 *      to an `Exact` is an encoder that was handed a value already carrying its unit
 *      (a `Money`, a canonical micrometre count). A client cannot hand-build
 *      `{ unit: 'THB.satang', digits: '8791' }` out of a baht figure — that object is
 *      not assignable to `Exact<'THB.satang'>`.
 *   2. For everything that is not TypeScript — curl, a Python integration, a log line
 *      under review — the payload states its own unit next to the digits, and the
 *      unit names the thing being counted (`satang`, `um`), never the thing a person
 *      would say out loud (`baht`, `cm`). `MINOR_EXPONENT` is a fact a reader would
 *      otherwise have to know; `"VND.dong"` puts it in the payload.
 */

/**
 * Phantom. Declared, never defined: it exists only in the type system, so nothing
 * emits it and `JSON.stringify` has nothing to drop.
 */
declare const exactUnit: unique symbol;

/**
 * A quantity whose digits count `U`.
 *
 * On the wire it is `{ unit: U, digits: string }`. In TypeScript it is opaque —
 * see the note above; the emptiness is the whole feature.
 */
export interface Exact<U extends string> {
  readonly [exactUnit]: U;
}

/** The shape that actually travels. Internal: publishing it would undo the opacity. */
interface ExactBody {
  readonly unit: string;
  readonly digits: string;
}

/**
 * Digits, canonically spelled.
 *
 * Stricter than `readMinor` in quote.ts, which accepts `007` and `-0`, because that
 * function reads back only what this codebase itself wrote. A request body is written
 * by somebody else, and two spellings of one amount is one amount that hashes two
 * ways — `documentHash` and the idempotency of a re-submitted order both depend on a
 * payload having exactly one form.
 */
const DIGITS = /^(?:0|-?[1-9][0-9]*)$/;

/**
 * A bound on `BigInt()`, which is superlinear in the input length and would otherwise
 * be reachable from an unauthenticated request body. The largest quantity this system
 * produces is `unitPriceScaledMinor` — satang × 10^12 on an 8 m × 3 m opening, which
 * is 19 digits. 40 leaves room for a currency with no minor unit and a very large
 * order without leaving room for a megabyte of nines.
 */
const MAX_DIGITS = 40;

const digitsSchema = z
  .string()
  .max(MAX_DIGITS, `must be at most ${String(MAX_DIGITS)} digits`)
  .regex(DIGITS, 'must be an integer written in canonical decimal digits');

/**
 * The one place an `Exact` is created.
 *
 * The assertion is what this module exists to contain: `Exact` has no readable
 * member precisely so that no other file can perform it.
 */
const mint = <U extends string>(unit: U, digits: string): Exact<U> =>
  ({ unit, digits }) as unknown as Exact<U>;

const body = (value: Exact<string>): ExactBody => value as unknown as ExactBody;

/** Encode a `bigint` as a quantity of `unit`. */
export const encodeExact = <U extends string>(unit: U, value: bigint): Exact<U> =>
  mint(unit, value.toString());

/** What the digits count. Reading this is how a decoder learns which of a union it has. */
export const unitOf = <U extends string>(value: Exact<U>): U => body(value).unit as U;

/**
 * The sanctioned way back to a number, and there is no other.
 *
 * Safe without re-validating: an `Exact` can only have come from `encodeExact` or from
 * `exactSchema`, and both produce canonical digits.
 */
export const toBigInt = (value: Exact<string>): bigint => BigInt(body(value).digits);

/**
 * Validate an untrusted quantity and admit it only if its unit is one this field
 * accepts.
 *
 * The unit is checked, not assumed. A `measures` entry arriving as
 * `{ unit: 'cm', digits: '320' }` is rejected rather than read as 320 µm — which is
 * the whole point, and is the failure mode plan 4.1 describes when a display unit is
 * allowed to reach a stored value.
 */
export const exactSchema = <U extends string>(
  units: readonly [U, ...U[]],
): z.ZodType<Exact<U>, ExactBody> =>
  z
    .object({ unit: z.literal(units), digits: digitsSchema })
    .transform((raw) => mint(raw.unit, raw.digits));

/** For a field that accepts exactly one unit — the common case. */
export const exactUnitSchema = <U extends string>(unit: U): z.ZodType<Exact<U>, ExactBody> =>
  exactSchema<U>([unit]);
