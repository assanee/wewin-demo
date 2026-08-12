import { MAX_QTY, MIN_QTY } from '@wewin/core/constants';
import {
  discountMinor,
  normalisePercentEntry,
  type DiscountRefusal,
  type PercentEntry,
  type PercentEntryRefusal,
  type TypedSign,
} from '@wewin/core/discount';
import { formatLength } from '@wewin/core/format';
import type { AuthoredUnit } from '@wewin/core';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The unit boundary for the quote editor. Every number a person types passes through here.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The rule, from the brief: **a raw minor-unit or micrometre figure never reaches a box a
 * human types into.** `quote-wire.ts` is the other half — it turns wire quantities into
 * canonical `bigint`s and nothing else. This file is the only place in the folder that
 * knows a satang from a baht, and `grep -rn 'MINOR_PER_BAHT\|BP_PER_PERCENT' src/components/quotes`
 * naming only this file is what makes that checkable rather than merely stated.
 *
 * ### Why this does not use `formatBaht`
 *
 * `@wewin/core/format`'s `formatBaht` rounds to the whole baht and says why in its own
 * header: *"Quotes are never issued in satang."* That is true of the **storefront**, whose
 * figures are `calcPrice` outputs already rounded to the baht. It is not true of this
 * screen. Phase 5b walked a real order and produced ฿9,406.37 grand and ฿2,821.91 deposit —
 * VAT on a whole-baht net lands on satang almost always, because 7% of a whole number is
 * not one. A quote editor that rendered ฿9,406.37 as `฿9,406` would be showing a figure the
 * customer will not transfer and the ledger will not reconcile against.
 *
 * So money is rendered here to the satang, and the trailing `.00` is dropped so that a
 * whole-baht figure still reads as one. Two spellings of the same rule, one file.
 *
 * ### Reading is stricter than writing, deliberately
 *
 * `Number('')` is 0, `Number(' ')` is 0 and `Number('1e3')` is 1000 — three ways for a field
 * somebody believes is empty or mistyped to become a price on a contract. So every parse is
 * regex-first and `BigInt` only ever runs on text already known to be digits. There is no
 * `Number` anywhere on the money path at all: the satang figure is assembled from the two
 * digit groups, so `0.1 + 0.2` never gets a chance to happen to a price.
 */

/** What a field parse can produce. `null` is not usable — the reason has to be shown. */
export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reasonTh: string };

const ok = <T>(value: T): ParseResult<T> => ({ ok: true, value });
const fail = <T>(reasonTh: string): ParseResult<T> => ({ ok: false, reasonTh });

const MINOR_PER_BAHT = 100n;
const BP_PER_PERCENT = 100n;

/* ------------------------------------------------------------------ *
 * The discount convention, borrowed whole from @wewin/core
 * ------------------------------------------------------------------ */

/**
 * ⚠️ **Both discount boxes on this screen defer to `@wewin/core/discount` for what a sign
 * means.** They used to decide it here, in a comment, in the opposite direction from the server's
 * comment — which is how `-5%` came to preview a five percent surcharge and store a five percent
 * discount. What is left here is the mapping from the rule's verdict to a Thai sentence.
 */
const signOf = (sign: string): TypedSign =>
  sign === '-' ? 'negative' : sign === '+' ? 'positive' : 'unsigned';

/**
 * The surcharge refusal **names the two routes that do raise a price**, because a refusal that
 * only says no leaves a salesperson with a legitimate need and no next step: an edit after a
 * factory bounce really is usually more expensive (plan 7.2). Type the total as an amount, or open
 * a new charge line — and both of those carry a description the customer can be shown, which is
 * the thing a negative discount never had.
 */
const SURCHARGE_TH =
  'ช่องส่วนลดใช้เพิ่มราคาไม่ได้ — ถ้าต้องการขึ้นราคา ให้กรอกยอดเป็นจำนวนเงิน หรือเปิดเป็นรายการใหม่';

const REFUSAL_TH: Readonly<Record<DiscountRefusal, string>> = {
  surcharge: SURCHARGE_TH,
  above_full: 'ส่วนลดเกิน 100% จะทำให้ยอดติดลบ',
};

/* ------------------------------------------------------------------ *
 * Money — satang stored, baht typed
 * ------------------------------------------------------------------ */

/**
 * A sign, a whole part and at most two decimal places.
 *
 * Thousands separators are accepted on input because people paste `8,500` out of a
 * spreadsheet and out of a chat message, and refusing that is a papercut with no safety
 * value — the group is stripped before parsing and the verbatim text is kept separately
 * anyway (plan 7.9(ก): `entered_value_text` is what the human actually typed).
 *
 * A leading `฿` is accepted for the same reason and no other.
 */
const MONEY = /^(-?)(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?$/;

const clean = (text: string): string => text.trim().replace(/^฿\s*/, '');

/**
 * Satang, from what a person typed. Signed.
 *
 * The decimal group is padded rather than multiplied: `'8500.5'` is 850,050 satang and
 * `'8500.05'` is 850,005, and the difference between those two is what padding gets right
 * and `Number(...) * 100` gets wrong for a value like `8500.07`.
 */
export function readSignedBaht(text: string): ParseResult<bigint> {
  const trimmed = clean(text);
  if (trimmed === '') return fail('กรอกจำนวนเงิน');

  const match = MONEY.exec(trimmed);
  if (match === null) return fail('กรอกเป็นจำนวนเงินบาท ทศนิยมไม่เกิน 2 ตำแหน่ง');

  const [, sign = '', whole = '0', fraction = ''] = match;
  const satang = BigInt(whole.replace(/,/g, '')) * MINOR_PER_BAHT + BigInt(fraction.padEnd(2, '0'));

  return ok(sign === '-' ? -satang : satang);
}

/** Satang, refusing a negative. Every override anchor is a price, and a price is never below zero. */
export function readBaht(text: string): ParseResult<bigint> {
  const parsed = readSignedBaht(text);
  if (!parsed.ok) return parsed;
  /*
   * Mirrors `quote_overrides_money_nonnegative`. A concession that would take a line below
   * zero is money going the other way, which is a refund or a credit line — both of those
   * are rows elsewhere with their own approval, and neither of them is this box.
   */
  if (parsed.value < 0n) return fail('ยอดติดลบไม่ได้ — เงินที่ไหลกลับหาลูกค้าคือการคืนเงิน ไม่ใช่ราคา');
  return parsed;
}

/**
 * A free-form charge, which **may** be negative and may not be zero.
 *
 * Mirrors `quote_lines_charge_nonzero` and the comment above it: a −฿1,000 line is a
 * discount wearing a different hat, which is why plan 7.13 has the `margin` dimension catch
 * it; a ฿0 line is a row somebody has to read and cannot act on.
 */
export function readCharge(text: string): ParseResult<bigint> {
  const parsed = readSignedBaht(text);
  if (!parsed.ok) return parsed;
  if (parsed.value === 0n) return fail('ค่าใช้จ่าย ฿0 คือบรรทัดที่ไม่มีผลกับใบเสนอราคา');
  return parsed;
}

/** As `MONEY`, but `+` is matched so the shared rule can refuse it by name rather than as a typo. */
const DISCOUNT_MONEY = /^([-+]?)(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?$/;

/**
 * Satang **off**, from a discount typed as money.
 *
 * `'291'` and `'-291'` are both ฿291 off, and `'+291'` is a surcharge. That is `discountMinor`'s
 * rule and not this file's, for the same reason `readPercentBp` no longer owns the percentage
 * one: `readBaht` used to refuse `-291` outright here while the server read it as ฿291 off, so
 * the two discount boxes disagreed about a minus sign in opposite directions.
 */
export function readDiscountBaht(text: string): ParseResult<bigint> {
  const trimmed = clean(text);
  if (trimmed === '') return fail('กรอกจำนวนเงิน');

  const match = DISCOUNT_MONEY.exec(trimmed);
  if (match === null) return fail('กรอกเป็นจำนวนเงินบาท ทศนิยมไม่เกิน 2 ตำแหน่ง');

  const [, sign = '', whole = '0', fraction = ''] = match;
  const magnitude = BigInt(whole.replace(/,/g, '')) * MINOR_PER_BAHT + BigInt(fraction.padEnd(2, '0'));

  const ruled = discountMinor(signOf(sign), magnitude);
  return ruled.ok ? ok(ruled.value) : fail(REFUSAL_TH[ruled.refusal]);
}

const groups = (digits: string): string => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/**
 * Money as a person reads it: `฿9,406.37`, `฿8,500`, `-฿291`.
 *
 * The minus goes outside the symbol, matching `formatBaht`, so that a negative charge in a
 * column of positives is visible at the left edge rather than three characters in.
 */
export function baht(minor: bigint): string {
  const negative = minor < 0n;
  const magnitude = negative ? -minor : minor;
  const whole = magnitude / MINOR_PER_BAHT;
  const satang = magnitude % MINOR_PER_BAHT;
  const decimals = satang === 0n ? '' : `.${satang.toString().padStart(2, '0')}`;

  return `${negative ? '-' : ''}฿${groups(whole.toString())}${decimals}`;
}

/** `+฿300` / `-฿291` / `฿0` — for a figure whose direction is the point. */
export const signedBaht = (minor: bigint): string => (minor > 0n ? `+${baht(minor)}` : baht(minor));

/**
 * The value a text box shows for a stored amount: no symbol, no separators.
 *
 * The separators are stripped on the way *in* because a comma comes back out of the box as
 * part of the number; they are accepted on the way *out* of a person's keyboard because a
 * paste is not a mistake. Round-trip: `readBaht(bahtInput(x)).value === x` for every x, which
 * is what lets somebody click into a field and out again without moving a price.
 */
export function bahtInput(minor: bigint): string {
  const negative = minor < 0n;
  const magnitude = negative ? -minor : minor;
  const whole = magnitude / MINOR_PER_BAHT;
  const satang = magnitude % MINOR_PER_BAHT;
  const decimals = satang === 0n ? '' : `.${satang.toString().padStart(2, '0')}`;

  return `${negative ? '-' : ''}${whole.toString()}${decimals}`;
}

/* ------------------------------------------------------------------ *
 * Percent — basis points, and @wewin/core decides what the sign means
 * ------------------------------------------------------------------ */

/**
 * Thai prose for `normalisePercentEntry`'s reasons. The rule is arithmetic; this is the sentence.
 *
 * ⚠️ **Every one of these says what to type.** The owner's instruction was
 * *"ถ้าใส่ผิดให้ขึ้นแดงเลยจะได้กรอกรูปแบบเดียว ไม่งงด้วย"*, and a refusal that only reports that the
 * input is wrong leaves the person guessing at the format — which is the confusion being named, not
 * a smaller version of it. So each message ends in the example `5` and what it means, and the two
 * commonest mistakes get the specific instruction rather than a generic one.
 */
const PERCENT_REFUSAL_TH: Readonly<Record<PercentEntryRefusal, string>> = {
  empty: 'กรอกเป็นตัวเลขเท่านั้น เช่น 5 = ลด 5%',
  signed: 'ไม่ต้องใส่เครื่องหมาย + หรือ − — ช่องนี้เป็นส่วนลดอยู่แล้ว กรอก 5 = ลด 5%',
  percent_typed: 'ไม่ต้องพิมพ์ % — ช่องนี้เป็น % อยู่แล้ว กรอก 5 = ลด 5%',
  unreadable: 'กรอกเป็นตัวเลขเท่านั้น ทศนิยมไม่เกิน 2 ตำแหน่ง เช่น 5 หรือ 7.5',
  no_change: 'ส่วนลด 0% ไม่เปลี่ยนอะไร — กรอกตัวเลขมากกว่า 0 เช่น 5 = ลด 5%',
  above_full: 'ส่วนลดเกิน 100% จะทำให้ยอดติดลบ — กรอกระหว่าง 0.01 ถึง 100',
  /*
   * Unreachable through `normalisePercentEntry`: `signed` catches a `+` first. Present because
   * `discountBp` is typed to be able to say it, and an exhaustive map is what makes a new reason
   * code fail to compile here rather than fall through as a blank sentence under the box.
   */
  surcharge: SURCHARGE_TH,
};

/**
 * A percentage typed into a box labelled **ส่วนลด** — the figure *and* the text to send.
 *
 * ⚠️ **Neither the sign rule nor the parse is this file's, and both used to be.** It read the sign
 * as a *direction* — `-5` meaning "add five percent" — while `apps/api/src/quotes/entry.ts` read
 * the same keystroke as five percent off. Each file carried a comment asserting its own reading,
 * and on a ฿8,791.00 line `-5%` therefore previewed ฿9,230.55 and stored ฿8,351.00.
 *
 * `@wewin/core/discount`'s `normalisePercentEntry` is the only reader now. It also produces
 * `wireText`, because the `%` in this field is a decoration rather than text and the server
 * requires a literal one — so `5` has to become `5%` on the way out. That append happens **there
 * and not in the dialog**: a second place that knows how to read a percentage is the shape this
 * defect had, and a dialog that patched the string after the preview had been computed from it
 * would be exactly that shape again.
 */
export function readPercentEntry(text: string): ParseResult<PercentEntry> {
  const ruled = normalisePercentEntry(text);
  return ruled.ok ? ok(ruled.value) : fail(PERCENT_REFUSAL_TH[ruled.refusal]);
}

/** `750` → `7.5`. Trailing zeros dropped, so 500 bp reads as `5` and not `5.00`. */
export function percentText(bp: bigint): string {
  const negative = bp < 0n;
  const magnitude = negative ? -bp : bp;
  const whole = magnitude / BP_PER_PERCENT;
  const rest = magnitude % BP_PER_PERCENT;
  const decimals = rest === 0n ? '' : `.${rest.toString().padStart(2, '0').replace(/0$/, '')}`;

  return `${negative ? '-' : ''}${whole.toString()}${decimals}`;
}

/* ------------------------------------------------------------------ *
 * Counts — quantity and days
 * ------------------------------------------------------------------ */

const INTEGER = /^\d+$/;

export const QTY_MIN = MIN_QTY;
/**
 * The ceiling, imported and not restated.
 *
 * Plan 7.9(ง)(5) names the exact bug: `MAX_QTY` already lives in `quoteReducer.ts:57` and
 * again, hardcoded, in `PriceSummary.tsx:21`, so raising it in one place leaves a + button
 * disabled at 99. `packages/db/src/schema/quote.ts` deliberately declined to add a third
 * copy in Postgres. This is the fourth chance to add one and it does not take it either.
 */
export const QTY_MAX = MAX_QTY;

export function readQty(text: string): ParseResult<number> {
  const trimmed = text.trim();
  if (trimmed === '') return fail('กรอกจำนวน');
  if (!INTEGER.test(trimmed)) return fail('กรอกเป็นจำนวนเต็ม');

  const value = Number(trimmed);
  if (value < QTY_MIN || value > QTY_MAX) {
    return fail(`จำนวนต้องอยู่ระหว่าง ${String(QTY_MIN)} ถึง ${String(QTY_MAX)}`);
  }

  return ok(value);
}

/** Lead time, in whole days. Zero is legal — "รับของวันนี้" is a promise somebody makes. */
export function readDays(text: string): ParseResult<number> {
  const trimmed = text.trim();
  if (trimmed === '') return fail('กรอกจำนวนวัน');
  if (!INTEGER.test(trimmed)) return fail('กรอกเป็นจำนวนเต็มวัน');

  const value = Number(trimmed);
  /*
   * A promise a year out is almost certainly a typo — 365 typed where 3 was meant, or a
   * date pasted into a duration. The ceiling is a *sanity* bound and not a policy: plan 13
   * has no answer for a maximum lead time and this file must not invent one, so it refuses
   * only the range where the figure has stopped being plausible as a number of days.
   */
  if (value > 3650) return fail('จำนวนวันมากผิดปกติ — ตรวจสอบว่าไม่ได้กรอกเป็นวันที่');

  return ok(value);
}

export const daysText = (days: number): string => `${days.toLocaleString('th-TH')} วัน`;

/* ------------------------------------------------------------------ *
 * Lengths — µm stored, never typed here
 * ------------------------------------------------------------------ */

/**
 * A measure, for reading only.
 *
 * There is no `readLength` in this file and that is a scope decision with a reason: changing
 * a measure re-runs `calcPrice`, which needs the product's custom-group bounds, its authored
 * unit and its step — the whole of `products/quantities.ts`'s `checkBounds` — and the line
 * guard in `packages/db` refuses a measure change outright while a live `line_total`
 * override exists. So this screen shows measures and sends people to the configurator to
 * change them, rather than shipping a second, smaller answer to snapping and validation.
 */
export const measureText = (um: bigint, unit: AuthoredUnit = 'cm'): string =>
  `${formatLength(um, unit)} ${unit}`;

/** The canonical figure, spelled out beside a reading and never inside a box. */
export const canonicalUm = (um: bigint): string => `${um.toLocaleString('th-TH')} µm`;
