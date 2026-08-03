import { z } from 'zod';
import { isLengthUnit, type LengthUnit } from '@wewin/core/units';
import { type Exact, encodeExact, exactUnitSchema, toBigInt } from './exact.js';

/**
 * The non-money units the catalogue and the configurator speak in.
 *
 * All four are exact integers, so all four travel as digits with a tag. `um` and `um2`
 * are core's canonical units unchanged — a length is micrometres and an area is square
 * micrometres, because area is `widthUm × heightUm` with no division anywhere
 * (pricing.ts:163).
 */

/** Micrometres. The canonical length everywhere in this system. */
export type LengthWire = Exact<'um'>;

/** Square micrometres — `minBillableSqUm`, and the `area` an `area` rule compares. */
export type AreaWire = Exact<'um2'>;

/** A dimensionless integer, for a rule constant that multiplies rather than measures. */
export type CountWire = Exact<'count'>;

/**
 * Basis points — hundredths of a percent.
 *
 * A `percent` delta is `8` in the catalogue meaning 8%, and plan 4.2 fixes basis points
 * as the storage form because a percentage is the one figure in the system that is the
 * same number in every currency. Carrying it as `bp` also stops it being read as a
 * fraction: `{ "unit": "bp", "digits": "800" }` cannot be applied as 800×.
 */
export type BasisPointsWire = Exact<'bp'>;

export const lengthWireSchema: z.ZodType<LengthWire> = exactUnitSchema('um');
export const areaWireSchema: z.ZodType<AreaWire> = exactUnitSchema('um2');
export const countWireSchema: z.ZodType<CountWire> = exactUnitSchema('count');
export const basisPointsWireSchema: z.ZodType<BasisPointsWire> = exactUnitSchema('bp');

export const encodeUm = (um: bigint): LengthWire => encodeExact('um', um);
export const encodeSqUm = (sqUm: bigint): AreaWire => encodeExact('um2', sqUm);
export const encodeCount = (count: bigint): CountWire => encodeExact('count', count);
export const encodeBasisPoints = (bp: bigint): BasisPointsWire => encodeExact('bp', bp);

export const decodeUm = (wire: LengthWire): bigint => toBigInt(wire);
export const decodeSqUm = (wire: AreaWire): bigint => toBigInt(wire);
export const decodeCount = (wire: CountWire): bigint => toBigInt(wire);
export const decodeBasisPoints = (wire: BasisPointsWire): bigint => toBigInt(wire);

/**
 * The unit a measurement was *typed* in.
 *
 * A plain string, not an `Exact`, because it is not a quantity — it is the record of
 * which grid the customer was working to, which travels beside the measurement and
 * never rewrites it (plan 4.1, quote.ts:23-35). Validated against core's own list so
 * this boundary and the share link cannot end up disagreeing about whether `'inch'`
 * is a unit (units.ts:33).
 */
export const lengthUnitSchema: z.ZodType<LengthUnit> = z.custom<LengthUnit>(
  isLengthUnit,
  'not a known length unit',
);
