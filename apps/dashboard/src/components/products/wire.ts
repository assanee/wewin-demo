import {
  decodePricePerSqmMinor,
  encodeLengthUm,
  encodeMinBillableSqUm,
  encodePricePerSqmMinor,
} from '@wewin/contract/admin';
import { toBigInt, unitOf } from '@wewin/contract/exact';
import { decodeBasisPoints, decodeSqUm, decodeUm, encodeBasisPoints } from '@wewin/contract/measure';
import { encodeMinor, encodeMinorPerSqm } from '@wewin/contract/money';
import type {
  AreaWire,
  ConstValueWire,
  LengthWire,
  MoneyRateWire,
  MoneyWire,
  PriceDeltaWire,
} from '@wewin/contract';

import { baht, percentField } from './quantities';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The opaque boundary. Every `Exact` these screens touch is opened here and nowhere else.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `packages/contract/src/exact.ts` gives an exact quantity no readable member on purpose:
 * `wire.digits / 100` is a compile error rather than a wrong answer, and `toBigInt` is the
 * one way out. This module is this app's side of that arrangement — the single file that
 * calls it, so `grep -rn 'toBigInt\|unitOf' src/` naming only this one is what makes the
 * arrangement checkable rather than merely agreed.
 *
 * The counterpart matters just as much and is easier to get wrong. Encoding is where a
 * *write* acquires its unit, and a screen that built `{ unit: 'um', digits: '320' }` out of
 * a centimetre figure would type-check and store a window a third of a millimetre wide. So
 * the encoders are named here too, and the conversion from what a person typed happens one
 * layer up in `quantities.ts` — the only module that knows a centimetre from a micrometre.
 *
 * Two boundaries, one direction each:
 *
 *     keystrokes  →  quantities.ts  →  canonical bigint  →  wire.ts  →  request
 *     response    →  wire.ts        →  canonical bigint  →  quantities.ts  →  what is read
 */

/** The `percent` arm's amount, which is basis points and not money. */
type BasisPointsAmount = Extract<PriceDeltaWire, { type: 'percent' }>['amount'];

/* ------------------------------------------------------------------ *
 * Out of the wire
 * ------------------------------------------------------------------ */

export const umOf = (wire: LengthWire): bigint => decodeUm(wire);
export const sqUmOf = (wire: AreaWire): bigint => decodeSqUm(wire);
export const rateMinorOf = (wire: MoneyRateWire<'THB'>): bigint => decodePricePerSqmMinor(wire);
export const bpOf = (wire: BasisPointsAmount): bigint => decodeBasisPoints(wire);

/**
 * A flat surcharge, in satang.
 *
 * `toBigInt` directly, because `@wewin/contract/admin` publishes decoders for the three
 * quantities a *request* carries and a flat delta is not one of them — it only ever
 * arrives, inside a compiled document. Named here rather than inlined at a call site so it
 * still appears in the grep this module's header describes.
 */
export const flatMinorOf = (wire: MoneyWire<'THB'>): bigint => toBigInt(wire);

/**
 * A rule constant, and which of the three dimensions it is.
 *
 * `ConstValueWire` is one opaque type covering `um`, `um2` and `count`, so the tag has to
 * be read before the digits mean anything — see `rule-text.ts`. This is the only sanctioned
 * reason to call `unitOf`: everywhere else the field name already says the unit.
 */
export interface ConstValue {
  readonly dimension: 'um' | 'um2' | 'count';
  readonly value: bigint;
}

export const constOf = (wire: ConstValueWire): ConstValue => ({
  dimension: unitOf(wire),
  value: toBigInt(wire),
});

/* ------------------------------------------------------------------ *
 * Into the wire
 * ------------------------------------------------------------------ */

export const lengthWire = (um: bigint): LengthWire => encodeLengthUm(um);
export const areaWire = (sqUm: bigint): AreaWire => encodeMinBillableSqUm(sqUm);
export const rateWire = (minor: bigint): MoneyRateWire<'THB'> => encodePricePerSqmMinor(minor);

/**
 * A surcharge, from the two figures an editor holds.
 *
 * Built here rather than in a form component because the arm decides the unit: `flat` is
 * satang of a one-off charge, `per_sqm` is satang *per square metre*, and `percent` is
 * basis points, which are not money at all (plan 4.2 — 8% is 8% in every currency). Three
 * encoders, one switch, in the file that owns the encoders.
 */
export function deltaWire(type: PriceDeltaWire['type'], amount: bigint): PriceDeltaWire {
  switch (type) {
    case 'none':
      return { type: 'none' };
    case 'flat':
      return { type: 'flat', amount: encodeMinor(amount, 'THB') };
    case 'per_sqm':
      return { type: 'per_sqm', amount: encodeMinorPerSqm(amount, 'THB') };
    case 'percent':
      return { type: 'percent', amount: encodeBasisPoints(amount) };
  }
}

/* ------------------------------------------------------------------ *
 * Reading a surcharge
 * ------------------------------------------------------------------ */

/**
 * The canonical figure behind a delta, whatever arm it is.
 *
 * Satang for the two money arms and basis points for `percent`, which are not comparable
 * with one another — which is why this is never used without the type beside it.
 */
export function deltaAmount(delta: PriceDeltaWire): bigint {
  switch (delta.type) {
    case 'none':
      return 0n;
    case 'flat':
      return flatMinorOf(delta.amount);
    case 'per_sqm':
      return rateMinorOf(delta.amount);
    case 'percent':
      return bpOf(delta.amount);
  }
}

/**
 * Whether two surcharges are the same charge.
 *
 * Type first, then amount. Comparing amounts alone would call ฿300 flat and ฿300/m² equal,
 * and on a 4 m² opening those differ by ฿900.
 */
export const sameDelta = (left: PriceDeltaWire, right: PriceDeltaWire): boolean =>
  left.type === right.type && deltaAmount(left) === deltaAmount(right);

/** `฿300` → `+฿300`. Zero and a negative keep their own spelling. */
const signed = (minor: bigint): string => (minor > 0n ? `+${baht(minor)}` : baht(minor));

/**
 * A surcharge as a person reads it.
 *
 * `฿0/ตร.ม.` is deliberately not collapsed into "ไม่มีส่วนเพิ่ม": the catalogue really does
 * carry `{ type: 'per_sqm', amount: 0 }` on the baseline glass thickness, and the difference
 * between "priced per square metre at no extra cost" and "carries no surcharge at all" is
 * the difference between a figure somebody set and a figure nobody has set yet.
 */
export function deltaText(delta: PriceDeltaWire): string {
  switch (delta.type) {
    case 'none':
      return 'ไม่มีส่วนเพิ่ม';
    case 'flat':
      return `${signed(flatMinorOf(delta.amount))} ต่อชุด`;
    case 'per_sqm':
      return `${signed(rateMinorOf(delta.amount))}/ตร.ม.`;
    case 'percent': {
      const bp = bpOf(delta.amount);
      return `${bp > 0n ? '+' : ''}${percentField(bp)}% ของราคาฐาน`;
    }
  }
}
