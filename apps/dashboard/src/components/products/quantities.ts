import { formatBaht, formatLength, formatSqm } from '@wewin/core/format';
import { LATTICE_UM, SQ_UM_PER_SQM, sqmToSqUm, toMicrons } from '@wewin/core/units';
import type { AuthoredUnit } from '@wewin/core';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The unit boundary. Every number a person types on these screens passes through here.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The catalogue holds three quantities that are stored in one unit and authored in
 * another, and each of the three has already caused a real bug somewhere in this
 * repository's history:
 *
 *   a length   — held in micrometres, authored in centimetres. `3200000` and `320` are
 *                the same window; `320` typed into a field that means micrometres is a
 *                window a third of a millimetre wide.
 *   a price    — held in satang, authored in whole baht. `150000` and `1500` are the same
 *                price per square metre; the first one shown as baht is a hundredfold error
 *                that looks like a plausible figure for a different product.
 *   an area    — held in square micrometres, authored in square metres. The exponent is 12,
 *                so nobody eyeballing a figure will ever notice it is wrong.
 *
 * Hence the one rule this module exists to enforce, taken straight from the brief:
 *
 *   **A raw canonical figure never reaches a field a human types into.**
 *
 * Every function below is a pair: one that renders a stored quantity into the string the
 * input shows, and one that reads a typed string back. Nothing else in the product screens
 * calls `toMicrons`, `sqmToSqUm` or divides by a hundred — grep for those three and this
 * file is the only hit, which is what makes the rule checkable rather than merely stated.
 *
 * ### Why this does not use `parseMeasure`
 *
 * `@wewin/core`'s `parseMeasure` is the storefront's entry point and it *snaps up* to the
 * step grid, because a customer's window is better slightly large than slightly small
 * (spec section 6). That is exactly wrong here. The figures on these screens are the
 * catalogue's own bounds — the min, the max, and the step itself — and snapping a step to
 * a grid derived from that same step is circular. An administrator typing 0.5 cm as a step
 * means 0.5 cm; if that is not a legal step, the right answer is to say so, not to move it.
 *
 * So parsing here is deliberately plain: a decimal, in the unit the group was authored in,
 * multiplied out by `toMicrons`. The rounding inside `toMicrons` is to the nearest
 * micrometre, which is four orders of magnitude below anything a workshop can cut.
 */

/** What a field parse can produce. `null` is not usable here — the reason has to be shown. */
export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reasonTh: string };

const ok = <T>(value: T): ParseResult<T> => ({ ok: true, value });
const fail = <T>(reasonTh: string): ParseResult<T> => ({ ok: false, reasonTh });

/**
 * A plain decimal, and nothing that merely resembles one.
 *
 * `Number('')` is 0, `Number(' ')` is 0, and `Number('1e3')` is 1000 — three ways for a
 * field the person believes is empty or mistyped to become a real catalogue bound. The
 * regex is the guard; `Number` only runs on something already known to be digits.
 */
const DECIMAL = /^\d+(?:\.\d+)?$/;
const INTEGER = /^\d+$/;

/* ------------------------------------------------------------------ *
 * Lengths — µm stored, cm or mm authored
 * ------------------------------------------------------------------ */

/**
 * The value an input shows for a stored length.
 *
 * `formatLength` and not a division: it is bigint arithmetic all the way down, so a
 * 3,205,000 µm bound renders as `320.5` exactly rather than as `320.50000000000006`. The
 * output is also what `readLength` reads back, which is the property that lets somebody
 * click into a field and out again without moving a window — plan 4.1's one hard rule.
 */
export const lengthField = (um: bigint, unit: AuthoredUnit): string => formatLength(um, unit);

export function readLength(text: string, unit: AuthoredUnit): ParseResult<bigint> {
  const trimmed = text.trim();
  if (trimmed === '') return fail('กรอกตัวเลข');
  if (!DECIMAL.test(trimmed)) return fail(`กรอกเป็นตัวเลขในหน่วย ${unit}`);

  const um = toMicrons(Number(trimmed), unit);
  if (um <= 0n) return fail('ต้องมากกว่าศูนย์');

  return ok(um);
}

/**
 * The canonical figure, spelled out beside the field rather than inside it.
 *
 * Shown because an administrator setting a step needs to know whether it lands on the
 * 25 µm lattice, and that is a fact about micrometres that no centimetre rendering can
 * convey. Read-only text, never an input — see the header.
 */
export const canonicalUm = (um: bigint): string => `${um.toLocaleString('th-TH')} µm`;

/** Whether a step is one core's schema will accept. Mirrors data/schema.ts:205. */
export const isOnLattice = (um: bigint): boolean => um % LATTICE_UM === 0n;

export const LATTICE_UM_VALUE = LATTICE_UM;

/**
 * The four bounds of a measurement, checked against each other before anything is sent.
 *
 * Every one of these is restated from `packages/core/src/data/schema.ts:189-225`, and the
 * duplication is deliberate and one-directional: core is the authority and will refuse a
 * draft that breaks any of them, but it refuses with a message naming a group code from
 * inside a compile step, arriving as a 400 attached to no field in particular. Checking
 * here means the person sees "ค่าสูงสุดต้องเป็นจำนวนเท่าของสเต็ปนับจากค่าต่ำสุด" under the
 * max box. A rule that drifts out of sync fails towards the server refusing something this
 * allowed, which is a worse message rather than a wrong catalogue.
 */
export interface MeasurementBounds {
  readonly minUm: bigint;
  readonly maxUm: bigint;
  readonly stepUm: bigint;
  readonly defaultUm: bigint;
}

export interface BoundsProblem {
  readonly field: keyof MeasurementBounds;
  readonly messageTh: string;
}

export function checkBounds(bounds: MeasurementBounds): readonly BoundsProblem[] {
  const problems: BoundsProblem[] = [];
  const { minUm, maxUm, stepUm, defaultUm } = bounds;

  if (stepUm <= 0n) {
    // Everything below divides by the step, so there is nothing more to say until it is fixed.
    return [{ field: 'stepUm', messageTh: 'สเต็ปต้องมากกว่าศูนย์' }];
  }

  if (!isOnLattice(stepUm)) {
    problems.push({
      field: 'stepUm',
      messageTh: `สเต็ปต้องเป็นจำนวนเท่าของ ${String(LATTICE_UM)} µm — ค่านี้คือ ${canonicalUm(stepUm)}`,
    });
  }

  if (minUm > maxUm) {
    problems.push({ field: 'maxUm', messageTh: 'ค่าสูงสุดต้องไม่น้อยกว่าค่าต่ำสุด' });
  }

  if (minUm % stepUm !== 0n) {
    problems.push({ field: 'minUm', messageTh: 'ค่าต่ำสุดต้องอยู่บนสเต็ปพอดี (การปัดค่าเริ่มนับจากศูนย์)' });
  }

  if (maxUm >= minUm && (maxUm - minUm) % stepUm !== 0n) {
    problems.push({ field: 'maxUm', messageTh: 'ค่าสูงสุดต้องเป็นจำนวนเท่าของสเต็ปนับจากค่าต่ำสุด' });
  }

  if (defaultUm < minUm || defaultUm > maxUm) {
    problems.push({ field: 'defaultUm', messageTh: 'ค่าเริ่มต้นต้องอยู่ในช่วงต่ำสุด–สูงสุด' });
  } else if ((defaultUm - minUm) % stepUm !== 0n) {
    problems.push({ field: 'defaultUm', messageTh: 'ค่าเริ่มต้นต้องอยู่บนสเต็ปเดียวกับค่าต่ำสุด' });
  }

  return problems;
}

/* ------------------------------------------------------------------ *
 * Money — satang stored, whole baht authored
 * ------------------------------------------------------------------ */

/**
 * The value an input shows for a stored price, in baht and without a thousands separator.
 *
 * `formatBaht` is for reading — it produces `฿1,500`, which is right in a table and wrong
 * in a text box, because the comma comes back out of the box as part of the number. So the
 * field gets the bare integer and the surrounding UI gets `formatBaht`.
 *
 * Every price on this surface is a whole number of baht: `pricePerSqmSchema` refuses a
 * fraction, `products_price_whole_baht` refuses it again in Postgres, and `calcPrice`
 * would throw on it. The division is therefore exact and the assertion is free.
 */
const MINOR_PER_BAHT = 100n;

export function bahtField(minor: bigint): string {
  return (minor / MINOR_PER_BAHT).toString();
}

export function readBaht(text: string): ParseResult<bigint> {
  const trimmed = text.trim();
  if (trimmed === '') return fail('กรอกจำนวนเงิน');
  if (!INTEGER.test(trimmed)) return fail('กรอกเป็นจำนวนเต็มบาท (ไม่มีสตางค์)');

  return ok(BigInt(trimmed) * MINOR_PER_BAHT);
}

/** Baht for reading, from satang. The one formatter for money on these screens. */
export const baht = (minor: bigint): string => formatBaht(minor);

/* ------------------------------------------------------------------ *
 * Percent — basis points stored, whole percent authored
 * ------------------------------------------------------------------ */

const BP_PER_PERCENT = 100n;

export const percentField = (bp: bigint): string => (bp / BP_PER_PERCENT).toString();

export function readPercent(text: string): ParseResult<bigint> {
  const trimmed = text.trim();
  if (trimmed === '') return fail('กรอกเปอร์เซ็นต์');
  if (!INTEGER.test(trimmed)) return fail('กรอกเป็นจำนวนเต็มเปอร์เซ็นต์');

  return ok(BigInt(trimmed) * BP_PER_PERCENT);
}

/* ------------------------------------------------------------------ *
 * Area — µm² stored, m² authored
 * ------------------------------------------------------------------ */

/**
 * The value an input shows for the price floor, in square metres.
 *
 * Rendered by dividing bigints and padding the remainder rather than through `Number`,
 * for the same reason `formatLength` does it: `Number(1_500_000_000_000n) / 1e12` is
 * 1.5 today and something ending in `0000000002` for the next figure somebody enters, and
 * a field that shows that is a field that writes it back.
 */
export function sqmField(sqUm: bigint): string {
  const whole = sqUm / SQ_UM_PER_SQM;
  const fraction = (sqUm % SQ_UM_PER_SQM)
    .toString()
    .padStart(String(SQ_UM_PER_SQM).length - 1, '0')
    .replace(/0+$/, '');

  return fraction === '' ? whole.toString() : `${whole.toString()}.${fraction}`;
}

export function readSqm(text: string): ParseResult<bigint> {
  const trimmed = text.trim();
  if (trimmed === '') return fail('กรอกพื้นที่');
  if (!DECIMAL.test(trimmed)) return fail('กรอกเป็นตัวเลขในหน่วยตารางเมตร');

  const sqUm = sqmToSqUm(Number(trimmed));
  if (sqUm <= 0n) return fail('ต้องมากกว่าศูนย์');

  return ok(sqUm);
}

/** Square metres for reading, always two decimals — spec section 5, via core. */
export const sqm = (sqUm: bigint): string => formatSqm(Number(sqUm) / Number(SQ_UM_PER_SQM));

/* ------------------------------------------------------------------ *
 * Counts
 * ------------------------------------------------------------------ */

export function readCount(text: string, { min, max }: { min: number; max: number }): ParseResult<number> {
  const trimmed = text.trim();
  if (trimmed === '') return fail('กรอกตัวเลข');
  if (!INTEGER.test(trimmed)) return fail('กรอกเป็นจำนวนเต็ม');

  const value = Number(trimmed);
  if (value < min || value > max) return fail(`ต้องอยู่ระหว่าง ${String(min)} ถึง ${String(max)}`);

  return ok(value);
}
