import { divRoundHalfUp } from '@wewin/core/money';

import { baht, percentText, readBaht, readDays, readPercentBp, type ParseResult } from './amounts';
import { ENTRY_MODES_BY_ANCHOR, type OverrideAnchorWire, type OverrideEntryModeWire } from './quote-wire';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE ANCHOR PER MEANING — plan 7.9(ข). And the preview is not the record.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ### What actually gets written down
 *
 * **Nothing in this file.** The request carries `enteredAs` and `enteredValueText` and no
 * money at all; the server parses the same text against a baseline it computed itself and
 * stores the absolute figure that produced. `@wewin/contract/quote`'s header is the authority
 * on why: a client that wanted to forge a concession would have to forge the baseline, and no
 * request has a field for one.
 *
 * So what is this module for? Two things a person needs before they press save, and neither
 * of them is a number the system will trust:
 *
 *   **a message under the box** — "ค่าเท่ากับที่คำนวณได้", "ยอดติดลบไม่ได้". Each mirrors a
 *   CHECK in `packages/db/src/schema/quote.ts`. Without them the same refusal arrives as
 *   SQLSTATE 23514 translated into prose, attached to no field.
 *
 *   **a preview** — typing `5` into a percent box and watching `฿8,351.45` appear is what
 *   makes plan 7.9(ก)'s "absolute, never a delta" self-evident rather than a paragraph
 *   somebody has to be told. It is also what makes the per-unit box safe to offer.
 *
 * ⚠️ **If this preview and the server ever disagree, the server is right and the screen will
 * show it on the next render**, because every write answers with the whole quote. That is the
 * ordinary case after a catalogue publish and it is not an error — the baseline moved between
 * the render and the write, which is exactly what `staleBaselines` is for.
 *
 * ### The per-unit box, and the failure it is not allowed to produce
 *
 * Unit price, line total and a percentage discount are one fact in three costumes. Plan
 * 7.9(ข)'s worked failure:
 *
 *     qty 2, unit price ฿9,000 **and** line total ฿18,432 set at once
 *     → the document is ฿432 short, and a 30% deposit is wrong from whichever end you take it
 *
 * `preview` takes **one** entry mode and produces **one** anchor value. Two anchors from one
 * keystroke is not something a caller can express, so that failure is not something this
 * screen can produce — and the request shape in the contract makes the same thing true of the
 * server.
 */

/* ------------------------------------------------------------------ *
 * Vocabulary, for the labels
 * ------------------------------------------------------------------ */

export const ENTRY_MODE_LABEL_TH: Readonly<Record<OverrideEntryModeWire, string>> = {
  line_total: 'ยอดรวมบรรทัด',
  unit_price: 'ราคาต่อหน่วย',
  grand_total: 'ยอดรวมทั้งใบ',
  percent_discount: 'ส่วนลดเป็น %',
  discount_amount: 'ส่วนลดเป็นจำนวนเงิน',
  lead_time_days: 'ระยะเวลาส่งมอบ',
};

export const ANCHOR_LABEL_TH: Readonly<Record<OverrideAnchorWire, string>> = {
  line_total: 'ยอดรวมบรรทัด',
  grand_total: 'ยอดรวมทั้งใบ (รวม VAT)',
  lead_time_days: 'ระยะเวลาส่งมอบ',
};

/* ------------------------------------------------------------------ *
 * The baseline a figure is set against
 * ------------------------------------------------------------------ */

/**
 * What the machine said, and everything needed to interpret what a human types against it.
 *
 * `qty` rides along on the line arm only, because it is the multiplier that turns a per-unit
 * figure into the anchor. Plan 4.3(ข) is emphatic that a unit price is a *display* number
 * that cannot be added up; it is an input here and an output nowhere.
 */
export type OverrideContext =
  | {
      readonly anchor: 'line_total';
      readonly quoteLineId: string;
      readonly computedThbMinor: bigint;
      readonly qty: number;
    }
  | { readonly anchor: 'grand_total'; readonly computedThbMinor: bigint }
  | { readonly anchor: 'lead_time_days'; readonly computedDays: number };

/**
 * What the server is expected to make of this typing.
 *
 * Deliberately not called a "draft" or a "request": nothing here is sent. The request carries
 * `enteredAs` and `enteredValueText`, both of which are in here so a caller does not have to
 * re-derive them, and the value is for the screen.
 */
export interface EntryPreview {
  readonly anchor: OverrideAnchorWire;
  readonly enteredAs: OverrideEntryModeWire;
  /** Verbatim, trimmed of outer whitespace and changed in no other way. */
  readonly enteredValueText: string;
  /** The anchor figure this typing should produce. Satang, or `null` on the lead-time anchor. */
  readonly anchorThbMinor: bigint | null;
  readonly anchorDays: number | null;
}

const fail = <T>(reasonTh: string): ParseResult<T> => ({ ok: false, reasonTh });
const ok = <T>(value: T): ParseResult<T> => ({ ok: true, value });

const BP_PER_UNIT = 10_000n;

/**
 * The contract's own cap on the verbatim field.
 *
 * `enteredValueTextSchema` is `.trim().min(1).max(32)`. Restated as a number rather than
 * imported as a schema because a zod parse would give a English message with a path in it,
 * and the thing under a text box has to be a Thai sentence. It fails towards the server
 * refusing something this screen allowed, which is the direction every mirror in this folder
 * fails in.
 */
const ENTERED_TEXT_MAX = 32;

/**
 * The price after a percentage has been taken off it.
 *
 * `divRoundHalfUp` and not `Math.round`, for the reason plan 7.9(ง)(4) records with a number:
 * `Math.round(-1432.5)` is −1432 because it rounds toward +Infinity, and half_up means −1433.
 * Negative money is new in this phase — credits, reversals, a discount typed with the wrong
 * sign — so the rule is taken from core rather than restated.
 */
const afterPercent = (computedMinor: bigint, bp: bigint): bigint =>
  computedMinor - divRoundHalfUp(computedMinor * bp, BP_PER_UNIT);

/**
 * What one entry mode means against one baseline.
 *
 * Returns a `ParseResult` rather than throwing, because every failure here is a sentence to
 * put under a text box: a mistyped price and an unusable one are the same event to the person
 * holding the keyboard.
 */
export function preview(
  context: OverrideContext,
  enteredAs: OverrideEntryModeWire,
  text: string,
): ParseResult<EntryPreview> {
  const permitted: readonly OverrideEntryModeWire[] = ENTRY_MODES_BY_ANCHOR[context.anchor];
  if (!permitted.includes(enteredAs)) {
    /*
     * Unreachable from the UI, which only offers `ENTRY_MODES_BY_ANCHOR[anchor]`. Kept
     * because it is the exact mistake plan 7.9(ข) says happens once per endpoint — a
     * normalisation that went to the wrong anchor — and because an unreachable branch that
     * mirrors both a CHECK and a discriminated union in the contract is cheaper than the 400
     * that replaces it.
     */
    return fail(`กรอก "${ENTRY_MODE_LABEL_TH[enteredAs]}" กับ "${ANCHOR_LABEL_TH[context.anchor]}" ไม่ได้`);
  }

  const enteredValueText = text.trim();
  if (enteredValueText === '') return fail('ยังไม่ได้กรอกค่า');
  if (enteredValueText.length > ENTERED_TEXT_MAX) {
    return fail(`ยาวเกิน ${String(ENTERED_TEXT_MAX)} ตัวอักษร — ช่องนี้เก็บราคา ไม่ใช่คำอธิบาย`);
  }

  if (context.anchor === 'lead_time_days') {
    const parsed = readDays(text);
    if (!parsed.ok) return parsed;
    if (parsed.value === context.computedDays) {
      return fail('ค่าเท่ากับที่คำนวณได้ — ถ้าต้องการยืนยันตามเดิม ให้ยกเลิกการแก้ค่าเดิมแทน');
    }

    return {
      ok: true,
      value: {
        anchor: 'lead_time_days',
        enteredAs,
        enteredValueText,
        anchorThbMinor: null,
        anchorDays: parsed.value,
      },
    };
  }

  const value = readMoneyEntry(enteredAs, text, context);
  if (!value.ok) return value;

  if (value.value < 0n) {
    return fail(`ยอดที่ได้คือ ${baht(value.value)} — ราคาติดลบไม่ได้ เงินที่ไหลกลับหาลูกค้าคือการคืนเงิน`);
  }

  /*
   * Mirrors `quote_overrides_value_differs`, and the schema's comment on it is why the
   * message says what it says: an override equal to the computed figure would occupy the one
   * live slot for its anchor and would make "does this line carry a promise?" — the question
   * the line guard asks before it allows a reprice — answer yes for a row that promised
   * nothing. Re-confirming a price after the catalogue moved is a *revocation*, which is
   * exactly what the contract's `RevokeOverrideRequestWire` header says too.
   */
  if (value.value === context.computedThbMinor) {
    return fail('ค่าเท่ากับที่คำนวณได้ — ถ้าต้องการยืนยันราคานี้ ให้ยกเลิกการแก้ราคาเดิมแทน');
  }

  return ok({
    anchor: context.anchor,
    enteredAs,
    enteredValueText,
    anchorThbMinor: value.value,
    anchorDays: null,
  });
}

/** The four money entry modes, each landing on the same anchor. */
function readMoneyEntry(
  enteredAs: OverrideEntryModeWire,
  text: string,
  context: Extract<OverrideContext, { computedThbMinor: bigint }>,
): ParseResult<bigint> {
  switch (enteredAs) {
    case 'line_total':
    case 'grand_total':
      return readBaht(text);

    case 'unit_price': {
      const parsed = readBaht(text);
      if (!parsed.ok) return parsed;
      /*
       * Exact: satang × a whole quantity has no remainder, so no rounding decision hides in
       * this multiplication. The reverse — deriving a unit price for display — is the one
       * that rounds, and `unitPriceOf` below is labelled accordingly.
       */
      const qty = context.anchor === 'line_total' ? context.qty : 1;
      return ok(parsed.value * BigInt(qty));
    }

    case 'percent_discount': {
      const parsed = readPercentBp(text);
      if (!parsed.ok) return parsed;
      return ok(afterPercent(context.computedThbMinor, parsed.value));
    }

    case 'discount_amount': {
      const parsed = readBaht(text);
      if (!parsed.ok) return parsed;
      return ok(context.computedThbMinor - parsed.value);
    }

    case 'lead_time_days':
      /* Handled before this function is reached; the anchor guard above makes it unreachable. */
      return fail('ระยะเวลาส่งมอบไม่ใช่จำนวนเงิน');
  }
}

/* ------------------------------------------------------------------ *
 * Reading a figure back
 * ------------------------------------------------------------------ */

/**
 * The per-unit figure, for display, and it is **not addable**.
 *
 * Plan 4.3(ข) requires this to be declared in the code and on the screen: the number on the
 * contract is the line total, and a column of unit prices does not sum to anything. It
 * rounds, so `unitPriceOf(total, qty) * qty` is not always `total` — which is exactly why the
 * write goes the other way and this is only ever rendered.
 */
export const unitPriceOf = (lineTotalMinor: bigint, qty: number): bigint =>
  divRoundHalfUp(lineTotalMinor, BigInt(qty));

/** How much the customer pays less because of this figure. Positive is a concession. */
export const concessionOf = (computedMinor: bigint, overrideMinor: bigint): bigint =>
  computedMinor - overrideMinor;

/**
 * A concession as a person reads it: `ลดลง ฿291 (3.31%)`.
 *
 * The percentage is derived for reading only and rounded to a basis point, because it is a
 * description of a decision rather than the decision — the decision is the absolute figure,
 * which is the whole of plan 7.9(ก)'s argument against storing deltas.
 *
 * ⚠️ It answers "what does this one change do", which is a **different and smaller question**
 * than the one the authority ceiling asks. Plan 7.13: the concession that matters is
 * evaluated at document level by the server, or ten lines discounted 10% each pass
 * individually and nothing is ever reviewed. This function is never summed.
 */
export function concessionText(computedMinor: bigint, overrideMinor: bigint): string {
  const delta = concessionOf(computedMinor, overrideMinor);
  if (delta === 0n) return 'ไม่เปลี่ยนแปลง';

  const direction = delta > 0n ? 'ลดลง' : 'เพิ่มขึ้น';
  const magnitude = delta > 0n ? delta : -delta;
  if (computedMinor === 0n) return `${direction} ${baht(magnitude)}`;

  const bp = divRoundHalfUp(
    magnitude * BP_PER_UNIT,
    computedMinor < 0n ? -computedMinor : computedMinor,
  );
  return `${direction} ${baht(magnitude)} (${percentText(bp)}%)`;
}
