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
    /* ฿8,791 less 5% = ฿8,791 − ฿439.55 = ฿8,351.45, and ฿8,351.45 is the promise. */
    const entry = shown(preview(LINE, 'percent_discount', '5'));

    expect(entry.anchorThbMinor).toBe(835_145n);
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

  it('keeps what was typed verbatim, including a sign and a percent symbol', () => {
    const entry = shown(preview(LINE, 'percent_discount', '  -15%  '));
    expect(entry.enteredValueText).toBe('-15%');
    /*
     * A negative discount raises the price: ฿8,791 + 15% = ฿10,109.65. Plan 7.2 says a
     * redesign after a factory bounce is usually *more* expensive, so this direction is real
     * and taking the magnitude would turn it into a giveaway.
     */
    expect(entry.anchorThbMinor).toBe(1_010_965n);
  });

  it('rounds half away from zero, which Math.round does not — plan 7.9(ง)(4)', () => {
    const context: OverrideContext = { ...LINE, computedThbMinor: 100_001n };
    const entry = shown(preview(context, 'percent_discount', '50'));
    /* 100001 × 5000 / 10000 = 50000.5 → 50001 (away from zero), so 100001 − 50001 = 50000. */
    expect(entry.anchorThbMinor).toBe(50_000n);
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

  it('refuses an empty box before it becomes a price', () => {
    expect(refusal(preview(LINE, 'line_total', '   '))).toContain('ยังไม่ได้กรอก');
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
