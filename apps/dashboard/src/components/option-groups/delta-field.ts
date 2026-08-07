import type { AdminOptionGroupWire, AdminOptionValueWire } from '@wewin/contract/admin';
import type { PriceDeltaWire } from '@wewin/contract';

import { bahtField, percentField } from '@/components/products/quantities';
import { bpOf, flatMinorOf, rateMinorOf } from '@/components/products/wire';

/** What a parser answers. Same shape as `quantities.ts`, so callers read the same way. */
export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reasonTh: string };

const MINOR_PER_BAHT = 100n;
const BP_PER_PERCENT = 100n;

/** A whole number with an optional leading `-`. No decimals, no `+`, no separators. */
const SIGNED_INTEGER = /^-?\d+$/;

/**
 * ⭐ **Why these are not `quantities.readBaht` and `quantities.readPercent`.**
 *
 * Those refuse a leading `-`, and they are right to: their caller is `pricePerSqm` on the
 * product form, which is a *base price*. A negative base price is not a discount, it is a
 * product the company pays people to take away.
 *
 * A surcharge is the opposite case. `deltaText` in `products/wire.ts` has rendered negative
 * amounts since it was written — `signed()` exists precisely to print the sign — the wire
 * schema constrains only the *shape* of a delta, and so does the database's
 * `option_values_delta_shape`. A discount is a legitimate, storable value.
 *
 * Reusing the base-price parser therefore produced a screen on which any value carrying a
 * discount could be *opened* and never *saved*: the field rendered `-500`, the parser
 * refused it, and Save stayed disabled with no explanation. Found by the round-trip test in
 * `delta-field.test.ts`, which is the only place the render and the parse meet.
 *
 * Widening `quantities.readBaht` instead would have been the smaller diff and the wrong
 * one — it would let a negative base price through on a form two screens away.
 */
export function readDeltaBaht(text: string): ParseResult<bigint> {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: false, reasonTh: 'กรอกจำนวนเงิน' };
  if (!SIGNED_INTEGER.test(trimmed)) {
    return { ok: false, reasonTh: 'กรอกเป็นจำนวนเต็มบาท (ไม่มีสตางค์) ใส่ - นำหน้าเพื่อเป็นส่วนลด' };
  }

  return { ok: true, value: BigInt(trimmed) * MINOR_PER_BAHT };
}

export function readDeltaPercent(text: string): ParseResult<bigint> {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: false, reasonTh: 'กรอกเปอร์เซ็นต์' };
  if (!SIGNED_INTEGER.test(trimmed)) {
    return { ok: false, reasonTh: 'กรอกเป็นจำนวนเต็มเปอร์เซ็นต์ ใส่ - นำหน้าเพื่อเป็นส่วนลด' };
  }

  return { ok: true, value: BigInt(trimmed) * BP_PER_PERCENT };
}

/**
 * The two pure decisions the option-group screen makes, out of the components that make
 * them, so they can be tested without a DOM.
 *
 * `vitest.config.ts` runs `environment: 'node'` for the whole package, which is a
 * deliberate constraint rather than an obstacle: it keeps the tests pointed at logic that
 * can be *wrong* rather than at markup that can only be different.
 */

/**
 * The text an amount field starts with, in the unit its arm is authored in.
 *
 * ⭐ **This is one half of a round trip and cannot be checked on its own.** The other half is
 * `readBaht`/`readPercent` in `quantities.ts`, and between them they decide what happens when
 * somebody opens a value to change its *label* and presses Save: the amount field is
 * re-parsed and re-encoded on every save, so a lossy render here silently rewrites a price
 * nobody meant to touch. `delta-field.test.ts` asserts the round trip, not this function.
 *
 * The units are not interchangeable and that is why each arm has its own line: `flat` is
 * satang of a one-off charge, `per_sqm` is satang *per square metre*, and `percent` is basis
 * points, which are not money at all.
 */
export function amountFieldText(delta: PriceDeltaWire | undefined): string {
  if (delta === undefined) return '';
  switch (delta.type) {
    case 'none':
      return '';
    case 'flat':
      return bahtField(flatMinorOf(delta.amount));
    case 'per_sqm':
      return bahtField(rateMinorOf(delta.amount));
    case 'percent':
      return percentField(bpOf(delta.amount));
  }
}

/**
 * Whether a group matches what somebody typed.
 *
 * Searches the *values* as well as the group, and that is the point rather than a nicety:
 * an operator looking for a colour knows `เขียว`, not that it lives under `glass_color`.
 * A search that only read group names would answer "not found" for every question anybody
 * actually asks this screen.
 */
export function groupMatches(group: AdminOptionGroupWire, needle: string): boolean {
  const trimmed = needle.trim();
  if (trimmed === '') return true;

  const hay = [
    group.code,
    group.labelTh,
    group.helperTh ?? '',
    ...group.values.flatMap((value: AdminOptionValueWire) => [value.code, value.labelTh]),
  ]
    .join(' ')
    .toLowerCase();

  return hay.includes(trimmed.toLowerCase());
}
