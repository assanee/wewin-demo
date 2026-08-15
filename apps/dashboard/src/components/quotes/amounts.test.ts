import { describe, expect, it } from 'vitest';

import {
  baht,
  bahtInput,
  daysText,
  percentText,
  readBaht,
  readCharge,
  readDays,
  readDiscountBaht,
  readPercentEntry,
  readQty,
  readSignedBaht,
  signedBaht,
  QTY_MAX,
} from './amounts';

/**
 * The unit boundary, tested where it would hurt.
 *
 * Two properties carry the weight here and neither is about formatting for its own sake:
 *
 *   **satang survive.** Phase 5b walked a real order and produced ฿9,406.37 and ฿2,821.91;
 *   core's `formatBaht` would render both without their satang because the storefront never
 *   shows one. A quote editor that did the same would display a figure the customer will not
 *   transfer.
 *
 *   **the round trip is exact.** `readBaht(bahtInput(x)) === x` is what lets somebody click
 *   into a price field and out again without moving a price — the same property
 *   `products/quantities.ts` pins for lengths, and the reason there is no `Number` anywhere
 *   on the money path.
 */

const value = <T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false }): T => {
  if (!result.ok) throw new Error('expected a parse to succeed');
  return result.value;
};

describe('reading money', () => {
  it('assembles satang from the digit groups rather than through a float', () => {
    expect(value(readSignedBaht('8500.05'))).toBe(850_005n);
    expect(value(readSignedBaht('8500.5'))).toBe(850_050n);
    expect(value(readSignedBaht('8500'))).toBe(850_000n);
    /* 0.1 + 0.2 never gets a chance to happen to a price. */
    expect(value(readSignedBaht('0.1')) + value(readSignedBaht('0.2'))).toBe(30n);
  });

  it('accepts a pasted figure with separators and a symbol', () => {
    expect(value(readSignedBaht('฿8,791.00'))).toBe(879_100n);
    expect(value(readSignedBaht(' 18,432.00 '))).toBe(1_843_200n);
  });

  it('refuses the three spellings that Number() would silently accept', () => {
    /* `Number('')` is 0, `Number(' ')` is 0, `Number('1e3')` is 1000. */
    expect(readSignedBaht('').ok).toBe(false);
    expect(readSignedBaht('   ').ok).toBe(false);
    expect(readSignedBaht('1e3').ok).toBe(false);
  });

  it('refuses a third decimal place, a malformed group and prose', () => {
    expect(readSignedBaht('8.505').ok).toBe(false);
    expect(readSignedBaht('8,50').ok).toBe(false);
    expect(readSignedBaht('แปดพัน').ok).toBe(false);
  });

  it('refuses a negative price but keeps one for a charge — the schema draws the line there', () => {
    expect(readBaht('-1').ok).toBe(false);
    expect(value(readCharge('-1000'))).toBe(-100_000n);
    /* Mirrors `quote_lines_charge_nonzero`: a line for nothing is noise somebody has to read. */
    expect(readCharge('0').ok).toBe(false);
    expect(value(readBaht('0'))).toBe(0n);
  });
});

describe('showing money', () => {
  it('keeps the satang that phase 5b actually produced', () => {
    expect(baht(940_637n)).toBe('฿9,406.37');
    expect(baht(282_191n)).toBe('฿2,821.91');
    expect(baht(879_100n)).toBe('฿8,791.00');
  });

  it('puts the minus outside the symbol, where a column makes it visible', () => {
    expect(baht(-29_100n)).toBe('-฿291.00');
    expect(signedBaht(30_000n)).toBe('+฿300.00');
    expect(signedBaht(0n)).toBe('฿0.00');
  });

  it('round-trips through the input spelling exactly', () => {
    for (const minor of [0n, 1n, 50n, 879_100n, 940_637n, 1_843_200n, -100_000n]) {
      expect(value(readSignedBaht(bahtInput(minor)))).toBe(minor);
    }
  });

  it('never puts a separator into a box, because a comma comes back out as part of the number', () => {
    expect(bahtInput(1_843_200n)).toBe('18432');
    expect(bahtInput(940_637n)).toBe('9406.37');
  });
});

describe('percent', () => {
  const bp = (text: string): bigint => value(readPercentEntry(text)).bp;

  it('reads whole and fractional percentages as basis points', () => {
    expect(bp('5')).toBe(500n);
    expect(bp('7.5')).toBe(750n);
    expect(bp('3.31')).toBe(331n);
    expect(bp('100')).toBe(10_000n);
  });

  /**
   * ⭐ The `%` is a decoration on the field, so a salesperson types `5`; the server requires a
   * literal `%`. The append happens in `@wewin/core/discount` and this asserts the screen gets the
   * benefit of it — and that nothing else is added, since `entered_value_text` is the record of
   * what a person said.
   */
  it('sends the % the field only draws, and nothing else', () => {
    expect(value(readPercentEntry('5')).wireText).toBe('5%');
    expect(value(readPercentEntry('7.5')).wireText).toBe('7.5%');
    expect(value(readPercentEntry('  5  ')).wireText).toBe('5%');
    expect(value(readPercentEntry('5')).wireText).not.toContain('-');
  });

  /**
   * ⚠️ **Two rounds of this file accepted a sign here, in both directions, and it now refuses one.**
   *
   * First it read `-5` as "raise the price by five percent"; then, once the convention was settled,
   * as "five percent off" — the same figure as `5`. The owner has since asked for a single format
   * with a visible refusal, because two spellings are two things a salesperson can believe about
   * what they typed. The message has to *teach*, so it names the sign rather than reporting that the
   * input is invalid.
   */
  it('refuses a sign and tells the person to drop it', () => {
    for (const typed of ['-5', '+5', '-5%', '-7.5']) {
      const refused = readPercentEntry(typed);
      expect(refused.ok, typed).toBe(false);
      if (!refused.ok) {
        expect(refused.reasonTh, typed).toContain('ไม่ต้องใส่เครื่องหมาย');
        expect(refused.reasonTh, typed).toContain('5');
      }
    }
  });

  it('refuses a typed % and says the field already has one', () => {
    for (const typed of ['5%', '5 %', '7.5%']) {
      const refused = readPercentEntry(typed);
      expect(refused.ok, typed).toBe(false);
      if (!refused.ok) expect(refused.reasonTh, typed).toContain('ไม่ต้องพิมพ์ %');
    }
  });

  it('refuses a discount that changes nothing and one that would go below zero', () => {
    expect(readPercentEntry('0').ok).toBe(false);
    expect(readPercentEntry('0.00').ok).toBe(false);
    expect(readPercentEntry('101').ok).toBe(false);
    expect(readPercentEntry('100.01').ok).toBe(false);
  });

  it('refuses a blank box with a sentence that names the format, not the emptiness', () => {
    for (const typed of ['', '   ']) {
      const refused = readPercentEntry(typed);
      expect(refused.ok, typed).toBe(false);
      /* This is the first thing the dialog shows on open, so it has to teach. */
      if (!refused.ok) expect(refused.reasonTh, typed).toContain('กรอกเป็นตัวเลขเท่านั้น');
    }
  });

  it('refuses something that is not a number', () => {
    for (const typed of ['abc', '5.123', '1 5', '.5', '5.']) {
      expect(readPercentEntry(typed).ok, typed).toBe(false);
    }
  });

  /**
   * ⚠️ **The money box now has the percentage box's rule, and this test has had all three of its
   * answers.** It expected `-291` to be refused as a negative price; then to mean ฿291 off, the same
   * as `291`; now to be refused with the instruction to drop the sign. The owner's reasoning, applied
   * consistently: whoever typed the minus believed something different from whoever did not, and
   * making both mean ฿291 off told one of them nothing.
   */
  it('takes one spelling and refuses the rest, in baht as in percent', () => {
    expect(value(readDiscountBaht('291')).minor).toBe(29_100n);
    expect(value(readDiscountBaht('291.50')).minor).toBe(29_150n);
    /* `readSatang`'s separators, because the grammar is its and not a second one. */
    expect(value(readDiscountBaht('1,234.50')).minor).toBe(123_450n);

    for (const [typed, instruction] of [
      ['-291', 'ไม่ต้องใส่เครื่องหมาย'],
      ['+291', 'ไม่ต้องใส่เครื่องหมาย'],
      ['฿291', 'ไม่ต้องพิมพ์ ฿'],
      ['0', 'ส่วนลด ฿0'],
      ['', 'กรอกเป็นตัวเลขเท่านั้น'],
      ['291.123', 'ทศนิยมไม่เกิน 2 ตำแหน่ง'],
    ] as const) {
      const refused = readDiscountBaht(typed);
      expect(refused.ok, typed).toBe(false);
      if (!refused.ok) expect(refused.reasonTh, typed).toContain(instruction);
    }
  });

  /* Nothing is appended here — unlike the percentage box, which must add its `%`. */
  it('sends a money discount exactly as typed', () => {
    expect(value(readDiscountBaht('291')).wireText).toBe('291');
    expect(value(readDiscountBaht(' 1,234.50 ')).wireText).toBe('1,234.50');
  });

  it('renders basis points without inventing trailing zeros', () => {
    expect(percentText(500n)).toBe('5');
    expect(percentText(750n)).toBe('7.5');
    expect(percentText(331n)).toBe('3.31');
    expect(percentText(5n)).toBe('0.05');
  });
});

describe('counts', () => {
  it('bounds quantity by core’s own constant and not by a fourth copy of 99', () => {
    expect(QTY_MAX).toBe(99);
    expect(value(readQty('99'))).toBe(99);
    expect(readQty('100').ok).toBe(false);
    expect(readQty('0').ok).toBe(false);
    expect(readQty('1.5').ok).toBe(false);
  });

  it('allows a same-day promise and refuses a date pasted into a duration', () => {
    expect(value(readDays('0'))).toBe(0);
    expect(value(readDays('30'))).toBe(30);
    expect(readDays('3651').ok).toBe(false);
    expect(daysText(30)).toBe('30 วัน');
  });
});
