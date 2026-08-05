import { divRoundHalfUp, roundToUnit } from '@wewin/core/money';
import { asciiNumerals } from '@wewin/i18n/numerals';
import type { OverrideAnchorWire, OverrideEntryModeWire } from '@wewin/contract/quote';

/**
 * What a human typed, turned into the one figure the anchor holds — plan 7.9(ข).
 *
 * ── Why this is a module and not four lines in a service ─────────────────────────
 *
 * Plan 7.9(ข)'s finding is that fields with an arithmetic relationship between them produce
 * the question "which one wins?" *at every endpoint*, and that the question gets a different
 * answer at each one. The answer to that is not discipline, it is arithmetic that exists in
 * exactly one place. Every route that writes a price calls `normaliseEntry` and there is no
 * second path: the unit-price box, the percentage box and the line-total box all arrive here
 * and all leave as an absolute figure against a baseline this process computed.
 *
 * ── Three properties, and each of them is load-bearing ───────────────────────────
 *
 *   **Nothing is a `number` on the way through.** `'8500.50'` becomes `850050n` by string
 *   surgery on the decimal point, never by `parseFloat(text) * 100`, which is the classic
 *   way ฿8,500.29 becomes 850028. The one place a `number` appears is basis points, which
 *   are integers by definition (plan 4.4's `rateBp`) and days, which are counts.
 *
 *   **A percentage is resolved here and thrown away.** What is stored is the absolute figure
 *   it produced (plan 7.9(ก): a delta silently reprices to ฿9,209 the day the catalogue
 *   moves to ฿9,500, having promised ฿8,500) and `entered_value_text` keeps `'-15%'` so the
 *   conversation is still reconstructable.
 *
 *   **A discount mode may only discount.** `percent_discount` and `discount_amount` both
 *   accept `'15%'` and `'-15%'` — a salesperson writes either and means the same thing — and
 *   both refuse `'+15%'`. A mode that could also *raise* the price would be a surcharge
 *   wearing a discount's name, and a surcharge is a new line with its own description, not a
 *   negative discount nobody can explain to the customer. It would also arrive at plan
 *   7.13's `margin` dimension as a negative concession and quietly buy headroom under the
 *   ceiling for the next real discount.
 */

/** THB presents on the whole baht — the same policy constant `pricing.ts` applies, restated. */
const THB_ROUND_TO_MINOR = 100n;

const BP = 10_000n;

/** Two decimal places of a *percent* is exactly one basis point, so `15.25%` is 1525 bp. */
const BP_DECIMALS = 2;
/** Two decimal places of a *baht* is exactly one satang. */
const MINOR_DECIMALS = 2;

// The Thai digit table that used to live here is now `@wewin/i18n`'s `asciiNumerals`, and
// it covers all eight languages' keyboards rather than one.
//
// The comment it replaces argued — correctly — that "a Thai keyboard produces them and
// refusing them is not a rule". Phase 6a made Hindi and Burmese first-class locales, and
// their keyboards produce their own digits in exactly the sense that argument names. Before
// this, `"๘,๕๐๐"` parsed to ฿8,500 while `"८,५००"` and `"၈,၅၀၀"` were rejected — and rejected
// with the *wrong diagnosis*, `มีเครื่องหมายจุลภาคอยู่ผิดตำแหน่ง`, because with the digits
// unrecognised the comma was the only thing left that looked wrong.

export class EntryError extends Error {
  /** Prose the salesperson reads, in Thai. The caller turns it into a 422. */
  constructor(readonly messageTh: string) {
    super(messageTh);
    this.name = 'EntryError';
  }
}

/**
 * Everything a keyboard adds that is not the number — and nothing that is.
 *
 * The baht sign, `THB`, ordinary and non-breaking spaces. Deliberately *not* a general "strip
 * anything that is not a digit": that turns `8.500` (a European thousands separator) into
 * `8500`, and the difference between ฿8.50 and ฿8,500 is the whole order.
 *
 * Commas survive this step on purpose. Their *placement* is information — `8,500` is a grouped
 * four-digit number and `85,00` is not a number at all — so they are validated in `scan` and
 * removed there, rather than deleted here where the evidence would already be gone.
 */
function clean(text: string): string {
  let out = '';
  // Digits first, punctuation untouched: `asciiNumerals` rewrites only glyphs it knows to
  // be digits, so a European `8.500` and a mis-typed `85,00` reach `scan` exactly as typed
  // and are still told apart there.
  for (const character of asciiNumerals(text.trim())) {
    if (character === ' ' || character === ' ' || character === '฿') continue;
    out += character;
  }
  return out.replace(/^THB/i, '');
}

/** Thousands groups, exactly: `8,500` and `1,234,567`, never `85,00`. */
const GROUPED = /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;

/** `-` explicit, `+` explicit, or neither. Kept apart from the digits so a mode can refuse one. */
type Sign = 'negative' | 'positive' | 'unsigned';

interface Scanned {
  readonly sign: Sign;
  readonly digits: string;
  readonly isPercent: boolean;
}

function scan(raw: string, whatTh: string): Scanned {
  const text = clean(raw);

  const sign: Sign = text.startsWith('-') ? 'negative' : text.startsWith('+') ? 'positive' : 'unsigned';
  const unsigned = sign === 'unsigned' ? text : text.slice(1);

  const isPercent = unsigned.endsWith('%');
  const grouped = isPercent ? unsigned.slice(0, -1) : unsigned;

  /*
   * `85,00` and `8,,500` are typos, and both are plausible enough that a parser which quietly
   * deleted the commas would answer ฿8,500 for each while their authors meant ฿85.00 and
   * ฿8,500. The figure is a promise to a customer; the right answer to an ambiguous one is to
   * ask again.
   */
  if (grouped.includes(',') && !GROUPED.test(grouped)) {
    throw new EntryError(`${whatTh} "${raw}" มีเครื่องหมายจุลภาคอยู่ผิดตำแหน่ง`);
  }

  const digits = grouped.replaceAll(',', '');

  if (!/^\d+(?:\.\d+)?$/.test(digits)) {
    throw new EntryError(`${whatTh} "${raw}" อ่านเป็นตัวเลขไม่ได้`);
  }

  return { sign, digits, isPercent };
}

/**
 * A decimal string to an integer count of its smallest place, exactly.
 *
 * `'8500.5'` at two places is `850050`. The fractional part is padded rather than rounded,
 * and a longer one is refused rather than truncated: `'8500.567'` is a figure whose author
 * meant something this system cannot hold, and silently charging them ฿8,500.56 is the
 * failure mode plan 4.3 spends three pages on.
 */
function scaled(digits: string, places: number, whatTh: string): bigint {
  const [whole = '0', fraction = ''] = digits.split('.');
  if (fraction.length > places) {
    throw new EntryError(`${whatTh}มีทศนิยมเกิน ${String(places)} ตำแหน่ง`);
  }
  return BigInt(whole + fraction.padEnd(places, '0'));
}

/* ------------------------------------------------------------------ *
 * The one entry point
 * ------------------------------------------------------------------ */

export interface NormaliseInput {
  readonly anchor: OverrideAnchorWire;
  readonly enteredAs: OverrideEntryModeWire;
  readonly enteredValueText: string;
  /** ⓵ The machine's figure this is being set against. Computed by this process, always. */
  readonly computedThbMinor: bigint | null;
  readonly computedDays: number | null;
  /** The line's quantity, for the one mode that needs it. */
  readonly qty: number;
}

export type NormalisedEntry =
  | { readonly kind: 'money'; readonly overrideThbMinor: bigint }
  | { readonly kind: 'days'; readonly overrideDays: number };

/**
 * The typed box → the anchor's absolute value.
 *
 * `enteredAs` has already been checked against `anchor` by the request schema (and again by
 * `quote_overrides_entry_mode_fits_anchor`), so the switch below is total over the pairs that
 * can arrive rather than over the cross product.
 */
export function normaliseEntry(input: NormaliseInput): NormalisedEntry {
  if (input.enteredAs === 'lead_time_days') return { kind: 'days', overrideDays: days(input) };

  const computed = input.computedThbMinor;
  if (computed === null) {
    /*
     * Not reachable from a route: a money anchor always carries a baseline, because the
     * baseline is what this process just computed. It is a `throw` and not a `!` because
     * "the caller would have passed one" is a claim about another file.
     */
    throw new Error('quotes: a money override was normalised with no baseline');
  }

  switch (input.enteredAs) {
    case 'line_total':
    case 'grand_total':
      return { kind: 'money', overrideThbMinor: absolute(input) };

    case 'unit_price':
      /*
       * ⭐ PLAN 7.9(ข), IN ONE LINE. The UI offers the per-unit box because sales asked for
       * it; the write normalises to the line total and `entered_as` remembers which box it
       * was. Multiplication and not division, so nothing is rounded: a per-unit figure is a
       * display number that cannot be added up (plan 4.3(ข)), and the contract number is the
       * line total.
       */
      return { kind: 'money', overrideThbMinor: absolute(input) * BigInt(input.qty) };

    case 'percent_discount': {
      const bp = discountBp(input);
      /*
       * Rounded to the whole baht, which is `pricing.ts`'s presentation unit for THB and not
       * a rule invented here: every computed line total already lands there, so a percentage
       * that produced ฿7,472.35 would be the only figure on the document with satang in it.
       * An *absolute* entry is not rounded — ฿8,500.50 is what the human promised, and the
       * system's job is to record promises, not to tidy them.
       */
      const reduced = computed - divRoundHalfUp(computed * BigInt(bp), BP);
      return { kind: 'money', overrideThbMinor: roundToUnit(reduced, THB_ROUND_TO_MINOR) };
    }

    case 'discount_amount': {
      const off = magnitude(input);
      const reduced = computed - off;
      if (reduced < 0n) {
        throw new EntryError('ส่วนลดมากกว่าราคาตั้งต้น — ยอดติดลบเป็นการคืนเงิน ไม่ใช่ส่วนลด');
      }
      return { kind: 'money', overrideThbMinor: reduced };
    }
  }
}

/** An absolute amount, non-negative, exactly as typed. */
function absolute(input: NormaliseInput): bigint {
  const { sign, digits, isPercent } = scan(input.enteredValueText, 'จำนวนเงิน');
  if (isPercent) throw new EntryError('ช่องนี้รับเป็นจำนวนเงิน ไม่ใช่เปอร์เซ็นต์');
  if (sign === 'negative') {
    throw new EntryError('ราคาติดลบไม่ได้ — การคืนเงินเป็นคนละเรื่องกับใบเสนอราคา');
  }
  return scaled(digits, MINOR_DECIMALS, 'จำนวนเงิน');
}

/** A discount written as money. `'291'` and `'-291'` both mean ฿291 off; `'+291'` does not. */
function magnitude(input: NormaliseInput): bigint {
  const { sign, digits, isPercent } = scan(input.enteredValueText, 'ส่วนลด');
  if (isPercent) throw new EntryError('ช่องนี้รับส่วนลดเป็นจำนวนเงิน ไม่ใช่เปอร์เซ็นต์');
  refuseASurcharge(sign);
  return scaled(digits, MINOR_DECIMALS, 'ส่วนลด');
}

/** A discount written as a percentage, in basis points. */
function discountBp(input: NormaliseInput): number {
  const { sign, digits, isPercent } = scan(input.enteredValueText, 'ส่วนลด');
  if (!isPercent) throw new EntryError('ช่องนี้รับส่วนลดเป็นเปอร์เซ็นต์ เช่น "-15%"');
  refuseASurcharge(sign);

  const bp = Number(scaled(digits, BP_DECIMALS, 'ส่วนลด'));
  if (bp > Number(BP)) throw new EntryError('ส่วนลดเกิน 100% — ยอดติดลบเป็นการคืนเงิน ไม่ใช่ส่วนลด');
  return bp;
}

function refuseASurcharge(sign: Sign): void {
  if (sign === 'positive') {
    throw new EntryError('ช่องส่วนลดใช้เพิ่มราคาไม่ได้ — ค่าบริการเพิ่มเติมให้เปิดเป็นรายการใหม่');
  }
}

function days(input: NormaliseInput): number {
  const { sign, digits, isPercent } = scan(input.enteredValueText, 'จำนวนวัน');
  if (isPercent) throw new EntryError('ระยะเวลาส่งมอบรับเป็นจำนวนวัน ไม่ใช่เปอร์เซ็นต์');
  if (sign === 'negative') throw new EntryError('ระยะเวลาส่งมอบติดลบไม่ได้');
  if (digits.includes('.')) throw new EntryError('ระยะเวลาส่งมอบต้องเป็นจำนวนวันเต็ม');

  return Number(BigInt(digits));
}

/**
 * A free-form charge, which is the one human figure that is a *baseline* rather than an
 * override against one — plan 7.9(ค)'s "แถวใหม่".
 *
 * Negative is allowed and is the point: plan 7.13 lists "a negative charge" among the things
 * the `margin` dimension has to catch, because a −฿1,000 line is a discount wearing a
 * different hat and `applyOverrides` counts it as one. Zero is refused by
 * `quote_lines_charge_nonzero` and here, with a message, because a line for nothing is a row
 * somebody still has to read.
 */
export function normaliseCharge(enteredValueText: string): bigint {
  const { sign, digits, isPercent } = scan(enteredValueText, 'จำนวนเงิน');
  if (isPercent) throw new EntryError('ค่าบริการรับเป็นจำนวนเงิน ไม่ใช่เปอร์เซ็นต์');

  const amount = scaled(digits, MINOR_DECIMALS, 'จำนวนเงิน');
  if (amount === 0n) throw new EntryError('รายการที่เป็นศูนย์บาทไม่มีความหมาย — ลบรายการนี้ออกแทน');

  return sign === 'negative' ? -amount : amount;
}
