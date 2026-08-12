import { priceAfterPercentDiscount } from '@wewin/core/discount';
import { describe, expect, it } from 'vitest';

import {
  concessionText,
  preview,
  unitPriceOf,
  type EntryPreview,
  type OverrideContext,
} from './override-entry';
import { ENTRY_MODES_BY_ANCHOR } from './quote-wire';

/**
 * One anchor per meaning — plan 7.9(ข), with the plan's own numbers.
 *
 * The property under test is not "the arithmetic is right"; the arithmetic that counts runs on
 * the server. It is that **four boxes land on one anchor**, that the figure a person is shown
 * before they commit is the absolute price rather than a delta, and that every refusal the
 * database would issue is issued here first, in Thai, under the box.
 *
 * Plan 7.9(ข)'s worked failure is not represented below because it cannot be expressed:
 *
 *     qty 2 · unit ฿9,000 AND total ฿18,432 set at once → the quote is ฿432 short
 *
 * `preview` takes one entry mode and returns one anchor value. There is no call that sets two.
 */

const LINE: OverrideContext = {
  anchor: 'line_total',
  quoteLineId: 'line-1',
  computedThbMinor: 879_100n,
  qty: 1,
};

const shown = (result: ReturnType<typeof preview>): EntryPreview => {
  if (!result.ok) throw new Error(`expected success, got: ${result.reasonTh}`);
  return result.value;
};

const refusal = (result: ReturnType<typeof preview>): string => {
  if (result.ok) throw new Error('expected a refusal');
  return result.reasonTh;
};

describe('four boxes, one anchor', () => {
  it('reads a typed line total as itself', () => {
    const entry = shown(preview(LINE, 'line_total', '8500'));
    expect(entry.anchor).toBe('line_total');
    expect(entry.anchorThbMinor).toBe(850_000n);
    expect(entry.enteredAs).toBe('line_total');
    expect(entry.enteredValueText).toBe('8500');
  });

  it('turns a per-unit figure into the line total, exactly, and remembers the box', () => {
    /* Plan 7.9(ข)'s example, from the side that is allowed: qty 2 at ฿9,000 each. */
    const context: OverrideContext = { ...LINE, computedThbMinor: 1_843_200n, qty: 2 };
    const entry = shown(preview(context, 'unit_price', '9000'));

    expect(entry.anchor).toBe('line_total');
    expect(entry.anchorThbMinor).toBe(1_800_000n);
    expect(entry.enteredAs).toBe('unit_price');
    expect(entry.enteredValueText).toBe('9000');
  });

  it('shows a percentage as the absolute figure it produces, never as the percentage', () => {
    /* ฿8,791 less 5% = ฿8,791 − ฿439.55 = ฿8,351.45, on the whole baht ฿8,351. */
    const entry = shown(preview(LINE, 'percent_discount', '5'));

    expect(entry.anchorThbMinor).toBe(835_100n);
    expect(entry.enteredAs).toBe('percent_discount');
    /*
     * The delta appears nowhere. Plan 7.9(ก): a stored −฿439.55 would silently become a
     * different promise the day the catalogue moves to ฿9,500.
     */
    expect(Object.values(entry)).not.toContain(-43_955n);
  });

  it('shows a discount amount as the total after it, not as the amount', () => {
    const entry = shown(preview(LINE, 'discount_amount', '291'));
    expect(entry.anchorThbMinor).toBe(850_000n);
    expect(entry.enteredValueText).toBe('291');
  });

  /**
   * ⚠️ **The history of this one assertion is the history of the whole bug.**
   *
   * `preview(LINE, 'percent_discount', '  -15%  ')` first expected `1_010_965n` — a fifteen percent
   * *surcharge* — while the server stored ฿7,472 for the same keystroke. Then it expected
   * `747_200n`, once the magnitude convention was settled. Now `-15%` is **refused**: the owner
   * asked for one accepted format so that no salesperson has to hold a theory about what a minus
   * means in a discount box. The figure it used to argue about is asserted from `15` instead.
   */
  it('refuses a signed percentage outright, and prices the same discount from a plain number', () => {
    expect(refusal(preview(LINE, 'percent_discount', '  -15%  '))).toContain('ไม่ต้องใส่เครื่องหมาย');

    const entry = shown(preview(LINE, 'percent_discount', '15'));
    expect(entry.enteredValueText).toBe('15%');
    expect(entry.anchorThbMinor).toBe(747_200n);
  });

  it('rounds half away from zero, which Math.round does not — plan 7.9(ง)(4)', () => {
    const context: OverrideContext = { ...LINE, computedThbMinor: 100_001n };
    const entry = shown(preview(context, 'percent_discount', '50'));
    /* 100001 × 5000 / 10000 = 50000.5 → 50001 (away from zero), so 100001 − 50001 = 50000. */
    expect(entry.anchorThbMinor).toBe(50_000n);
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE NUMBER ON THE SCREEN IS THE NUMBER THE SERVER APPLIES
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The bug these cover was not a wrong figure; it was **two right figures**. This screen read the
 * sign as a direction and `apps/api/src/quotes/entry.ts` read it as a magnitude, each with a
 * comment saying so, and `-5%` on a ฿8,791.00 line therefore promised ฿9,230.55 and stored
 * ฿8,351.00 — ฿879.55 apart, silently, against the company.
 *
 * So these assert **delegation**, not arithmetic. Every expectation is
 * `priceAfterPercentDiscount(...)`, the function `normaliseEntry` calls with the same arguments;
 * the literals it produces are pinned once in `packages/core/tests/discount.test.ts`. A preview
 * that goes back to doing its own arithmetic fails here even if its arithmetic is *correct*,
 * because being correct separately is what went wrong.
 */
describe('the preview and the write cannot disagree', () => {
  it('derives the previewed figure from the shared rule and not from arithmetic of its own', () => {
    expect(shown(preview(LINE, 'percent_discount', '5')).anchorThbMinor).toBe(
      priceAfterPercentDiscount(LINE.computedThbMinor, 500n),
    );
  });

  /*
   * ⭐ The direction that used to be silent. A discount goes *below* the baseline — not the
   * ฿9,230.55 above it that this screen once showed for the same intent.
   */
  it('previews a figure below the baseline, never above it', () => {
    const entry = shown(preview(LINE, 'percent_discount', '5'));
    expect(entry.anchorThbMinor).toBeLessThan(LINE.computedThbMinor);
    expect(entry.anchorThbMinor).toBe(835_100n);
  });

  it('refuses a sign in the percent box with the instruction, not with "invalid"', () => {
    expect(refusal(preview(LINE, 'percent_discount', '+5'))).toContain('ไม่ต้องใส่เครื่องหมาย');
    expect(refusal(preview(LINE, 'percent_discount', '-5'))).toContain('ไม่ต้องใส่เครื่องหมาย');
  });

  /*
   * ⚠️ The money box was flagged for the owner rather than changed unasked, on the grounds that a
   * minus in front of an amount was not the *demonstrated* ambiguity a minus in front of a percentage
   * had been. The owner's call was to close it anyway, before anyone was burned: whoever types `-291`
   * believes something different from whoever types `291`, and making both mean ฿291 off left one of
   * them uncorrected. Same rule, same reason codes, the other unit.
   */
  it('refuses a sign in the money-discount box with the same instruction as the percent box', () => {
    for (const typed of ['+291', '-291']) {
      expect(refusal(preview(LINE, 'discount_amount', typed)), typed).toContain('ไม่ต้องใส่เครื่องหมาย');
    }
  });

  it('refuses a typed ฿ in the money-discount box', () => {
    expect(refusal(preview(LINE, 'discount_amount', '฿291'))).toContain('ไม่ต้องพิมพ์ ฿');
  });

  it('prices a money discount from the one accepted spelling', () => {
    expect(shown(preview(LINE, 'discount_amount', '291')).anchorThbMinor).toBe(850_000n);
    expect(shown(preview(LINE, 'discount_amount', ' 291 ')).anchorThbMinor).toBe(850_000n);
  });

  it('previews on the whole baht, because that is the unit the write stores', () => {
    /* The 45 satang that used to separate the preview from the record. */
    const entry = shown(preview(LINE, 'percent_discount', '5'));
    expect(entry.anchorThbMinor).not.toBe(835_145n);
    expect((entry.anchorThbMinor ?? 0n) % 100n).toBe(0n);
  });

  it('still refuses more than the whole price', () => {
    expect(refusal(preview(LINE, 'percent_discount', '150'))).toContain('เกิน 100%');
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE FIELD DRAWS A `%`; THE SERVER DEMANDS ONE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The percent box renders `%` as a decoration, so a salesperson typing `5` used to send `5` — and
 * `apps/api/src/quotes/entry.ts` refuses a bare number, by design, so that `291` cannot be read as
 * 291 percent. Its 422 then advised `เช่น "-15%"`, and `-15%` is what previewed a surcharge and
 * stored a discount. The guard stays; the client sends what the guard requires.
 *
 * What these assert is the property from the round before, now over **one** accepted format: the
 * figure previewed is the figure the sent text produces, and every other spelling is refused with a
 * sentence that says what to type.
 */
describe('what a person types reaches the server as something it accepts', () => {
  it('prices a plain number and sends it with the % the field only drew', () => {
    for (const [typed, expected] of [
      ['5', 835_100n],
      ['  5  ', 835_100n],
      ['7.5', 813_200n],
      ['15', 747_200n],
    ] as const) {
      const entry = shown(preview(LINE, 'percent_discount', typed));
      expect(entry.anchorThbMinor, typed).toBe(expected);
      expect(entry.enteredValueText, typed).toMatch(/^\d+(\.\d{1,2})?%$/);
    }
  });

  /*
   * ⚠️ `entered_value_text` is plan 7.9(ก)'s record of what the salesperson said. The `%` is the
   * only addition, and with one accepted format it is the only addition possible.
   */
  it('appends the % and nothing else', () => {
    expect(shown(preview(LINE, 'percent_discount', '5')).enteredValueText).toBe('5%');
    expect(shown(preview(LINE, 'percent_discount', '7.5')).enteredValueText).toBe('7.5%');
    expect(shown(preview(LINE, 'percent_discount', ' 15 ')).enteredValueText).toBe('15%');
    expect(shown(preview(LINE, 'percent_discount', '5')).enteredValueText).not.toContain('-');
  });

  /*
   * The other three modes are already in the form the server parses, so nothing is added to them.
   * The money-discount box therefore records `entered_value_text` character-for-character — a
   * stronger form of plan 7.9(ก)'s record than the percentage box can manage, since that one must
   * append the `%` its field only draws.
   */
  it('leaves the absolute and money-discount modes exactly as typed', () => {
    expect(shown(preview(LINE, 'line_total', ' 8500 ')).enteredValueText).toBe('8500');
    expect(shown(preview(LINE, 'discount_amount', ' 291 ')).enteredValueText).toBe('291');
    expect(shown(preview(LINE, 'discount_amount', '1,234.50')).enteredValueText).toBe('1,234.50');
  });

  /**
   * ⭐ Every spelling the previous round accepted must now refuse — otherwise the strictness has
   * come undone and a suite that only checks `5` would never notice.
   */
  it('refuses every spelling that used to be accepted', () => {
    for (const typed of ['-5', '+5', '5%', '-5%', '5 %']) {
      expect(preview(LINE, 'percent_discount', typed).ok, typed).toBe(false);
    }
  });

  it('refuses a blank box with the format, which is what the dialog shows on open', () => {
    expect(refusal(preview(LINE, 'percent_discount', '   '))).toContain('กรอกเป็นตัวเลขเท่านั้น');
    expect(refusal(preview(LINE, 'percent_discount', ''))).toContain('กรอกเป็นตัวเลขเท่านั้น');
  });

  it('refuses a percentage that is not a number, and zero', () => {
    expect(refusal(preview(LINE, 'percent_discount', '5.123'))).toContain('ทศนิยม');
    expect(refusal(preview(LINE, 'percent_discount', '0'))).toContain('0%');
  });

  /* Each mode keeps its own blank sentence, now that no blanket one preempts them. */
  it('refuses a blank box in every mode, each in its own words', () => {
    expect(refusal(preview(LINE, 'line_total', ''))).toContain('กรอกจำนวนเงิน');
    /* The two discount boxes teach their format instead of only reporting the emptiness. */
    expect(refusal(preview(LINE, 'discount_amount', '  '))).toContain('กรอกเป็นตัวเลขเท่านั้น');
    expect(refusal(preview(LINE, 'percent_discount', '  '))).toContain('กรอกเป็นตัวเลขเท่านั้น');
    const lead: OverrideContext = { anchor: 'lead_time_days', computedDays: 30 };
    expect(refusal(preview(lead, 'lead_time_days', ''))).toContain('กรอกจำนวนวัน');
  });

  /*
   * The cap has to be applied to what is *sent*, because a percentage grows by one character on the
   * way out — 32 characters pass the check on the typed text and would then send 33.
   *
   * Zero-padding is the only way to reach 32 characters while staying a legal percentage (`5`
   * repeated 32 times is refused as over 100% long before length matters). Contrived as an input,
   * exact as a boundary: this is the case the second check exists for, and without it the contract's
   * `enteredValueTextSchema` would refuse something this screen had already priced.
   */
  it('refuses at the contract length limit measured on the sent text, not the typed text', () => {
    const padded = `${'0'.repeat(31)}5`;
    expect(padded).toHaveLength(32);
    /* Still an ordinary five percent, so nothing else refuses it. */
    expect(shown(preview(LINE, 'percent_discount', '05')).anchorThbMinor).toBe(835_100n);
    expect(refusal(preview(LINE, 'percent_discount', padded))).toContain('ยาวเกิน');
  });
});

describe('refusals that mirror a CHECK in packages/db', () => {
  it('refuses a value equal to the baseline — quote_overrides_value_differs', () => {
    expect(refusal(preview(LINE, 'line_total', '8791'))).toContain('เท่ากับที่คำนวณได้');
  });

  it('refuses a total below zero — quote_overrides_money_nonnegative', () => {
    expect(refusal(preview(LINE, 'discount_amount', '9000'))).toContain('ติดลบ');
  });

  it('refuses an entry mode that does not fit the anchor — entry_mode_fits_anchor', () => {
    const grand: OverrideContext = { anchor: 'grand_total', computedThbMinor: 940_637n };
    expect(ENTRY_MODES_BY_ANCHOR.grand_total).not.toContain('unit_price');
    expect(refusal(preview(grand, 'unit_price', '9000'))).toContain('ไม่ได้');
  });

  /*
   * The blanket `ยังไม่ได้กรอกค่า` that used to answer this is gone: each reader now names what its
   * own box wants, so the percent field can teach its format on open instead of saying only that it
   * is empty. `readBaht` answers for the money modes.
   */
  it('refuses an empty box before it becomes a price', () => {
    expect(refusal(preview(LINE, 'line_total', '   '))).toContain('กรอกจำนวนเงิน');
  });

  it('refuses text longer than the contract will accept — enteredValueTextSchema is max 32', () => {
    expect(refusal(preview(LINE, 'line_total', '8'.repeat(33)))).toContain('ยาวเกิน');
  });

  it('refuses a lead time equal to the computed one', () => {
    const lead: OverrideContext = { anchor: 'lead_time_days', computedDays: 30 };
    expect(refusal(preview(lead, 'lead_time_days', '30'))).toContain('เท่ากับที่คำนวณได้');
    expect(shown(preview(lead, 'lead_time_days', '21')).anchorDays).toBe(21);
  });
});

describe('the shape of a preview', () => {
  it('never carries both a money value and a day count — quote_overrides_value_shape', () => {
    expect(shown(preview(LINE, 'line_total', '8500')).anchorDays).toBeNull();

    const lead: OverrideContext = { anchor: 'lead_time_days', computedDays: 30 };
    expect(shown(preview(lead, 'lead_time_days', '21')).anchorThbMinor).toBeNull();
  });

  it('carries the anchor it landed on, whichever box was typed into', () => {
    for (const mode of ENTRY_MODES_BY_ANCHOR.line_total) {
      const entry = shown(preview(LINE, mode, mode === 'percent_discount' ? '5' : '8500'));
      expect(entry.anchor).toBe('line_total');
    }
  });
});

describe('a unit price is for reading and does not add up', () => {
  it('does not round-trip, which is why the write goes the other way', () => {
    const unit = unitPriceOf(879_100n, 3);
    expect(unit).toBe(293_033n);
    /* 293,033 × 3 = 879,099 — one satang short of the line total. Plan 4.3(ข). */
    expect(unit * 3n).not.toBe(879_100n);
  });

  it('rounds half up rather than truncating, so the display is not systematically low', () => {
    /*
     * ฿8,791 over six units is ฿1,465.1666… — half_up gives ฿1,465.17 and truncation gives
     * ฿1,465.16. A truncating unit price understates every line it appears on, which is the
     * kind of error that looks like a rounding preference and reads as a discount.
     */
    expect(unitPriceOf(879_100n, 6)).toBe(146_517n);
  });
});

describe('a concession as a person reads it', () => {
  it('names the direction, the amount and the percentage', () => {
    expect(concessionText(879_100n, 850_000n)).toBe('ลดลง ฿291 (3.31%)');
    expect(concessionText(879_100n, 1_010_965n)).toBe('เพิ่มขึ้น ฿1,318.65 (15%)');
    expect(concessionText(879_100n, 879_100n)).toBe('ไม่เปลี่ยนแปลง');
  });

  it('says the amount alone when there is no baseline to be a percentage of', () => {
    expect(concessionText(0n, 200_000n)).toBe('เพิ่มขึ้น ฿2,000');
  });
});
