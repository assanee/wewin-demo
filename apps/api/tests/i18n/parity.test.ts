import { describe, expect, it } from 'vitest';

import { AppError } from '../../src/common/errors/app-error';
import { renderInThai, renderServerMessage } from '../../src/i18n';
import { translatePostgresError } from '../../src/admin/pg-errors';
import { translateOrderError } from '../../src/orders/pg-errors';
import { translateQuoteError } from '../../src/quotes/pg-errors';
import { translatePaymentError } from '../../src/payments/ledger/pg-errors';
import { translateSlipError } from '../../src/payments/slips/slip-errors';

/**
 * The sentences did not change. That is the whole claim of this file.
 *
 * ── Why parity is the right test for this round ──────────────────────────────────
 *
 * 6a moved ~100 Thai sentences out of five error translators and into a keyed catalogue.
 * The mechanism is new; the prose is not. If the prose had been improved on the way past,
 * there would be no way left to tell an improvement from a transcription slip — and a
 * transcription slip in Thai is invisible to a reviewer who does not read Thai, which is a
 * plausible description of a future reader of this repository.
 *
 * So every assertion below is the literal *as it was at HEAD*, pasted, and the route to it
 * is the real one: a driver error shaped like Postgres's goes into the translator that
 * handled it before, and the Thai that comes out is compared. A key that was wired to the
 * wrong sentence fails here even though both sentences exist and both are grammatical.
 *
 * This is the same shape as the parity test `core` used for the identical change, and it is
 * the reason the 1,819 existing tests are evidence rather than luck: many of them assert on
 * these strings, and they pass because the strings are the same, not because they were
 * updated to match.
 */

/** A driver error the way node-postgres reports one, wrapped the way Drizzle wraps it. */
const pgError = (code: string, constraint?: string): unknown => ({
  name: 'DrizzleQueryError',
  cause: { code, constraint },
});

const thaiOf = (error: unknown): string => {
  expect(error).toBeInstanceOf(AppError);
  return (error as AppError).message;
};

describe('parity — the Thai is what it was before the keys existed', () => {
  it('catalogue constraints', () => {
    expect(thaiOf(translatePostgresError(pgError('23505', 'products_slug_unique')))).toBe(
      'มีสินค้าที่ใช้ slug นี้อยู่แล้ว',
    );
    expect(thaiOf(translatePostgresError(pgError('23514', 'product_version_options_grid')))).toBe(
      'ช่วงขนาดไม่ลงตัวกับสเต็ป — สเต็ปต้องเป็นจำนวนเท่าของ 25 µm และ min/max/default ต้องอยู่บนกริดเดียวกัน',
    );
    expect(thaiOf(translatePostgresError(pgError('23001')))).toBe(
      'เวอร์ชันนี้ถูกเผยแพร่แล้วและแก้ไขไม่ได้ — สร้างร่างใหม่แทน',
    );
    /* An unnamed constraint falls through to the generic of *this* vocabulary. */
    expect(thaiOf(translatePostgresError(pgError('23514')))).toBe('ข้อมูลไม่ผ่านเงื่อนไขของแคตตาล็อก');
  });

  it('order constraints', () => {
    expect(thaiOf(translateOrderError(pgError('23514', 'orders_total_foots')))).toBe(
      'ยอดรวมไม่ตรงกับผลบวกของยอดก่อนภาษีและภาษี',
    );
    expect(thaiOf(translateOrderError(pgError('23001')))).toBe(
      'สถานะของออร์เดอร์เปลี่ยนไปแล้วระหว่างที่ทำรายการ — กรุณาโหลดข้อมูลใหม่แล้วลองอีกครั้ง',
    );
    expect(thaiOf(translateOrderError(pgError('55P03')))).toBe(
      'ออร์เดอร์นี้กำลังถูกแก้ไขอยู่ — กรุณาลองใหม่อีกครั้ง',
    );
    /*
     * ⭐ The generic CHECK differs per vocabulary, and that difference is the reason there
     * are four translators rather than one. Asserted side by side so that a future
     * "simplification" that merges them fails on the sentence rather than on a code review.
     */
    expect(thaiOf(translateOrderError(pgError('23514')))).toBe('ข้อมูลไม่ผ่านเงื่อนไขของออร์เดอร์');
    expect(thaiOf(translateQuoteError(pgError('23514'), 'write_line'))).toBe(
      'ข้อมูลไม่ผ่านเงื่อนไขของใบเสนอราคา',
    );
    expect(thaiOf(translatePaymentError(pgError('23514')))).toBe('ข้อมูลไม่ผ่านเงื่อนไขของระบบการเงิน');
    expect(thaiOf(translateSlipError(pgError('23514')))).toBe('ข้อมูลไม่ผ่านเงื่อนไขของการชำระเงิน');
  });

  it('the five quote refusals, one per operation — plan 7.9(ง)(2)', () => {
    // Each names a different recovery. One key per operation, so that a translator cannot
    // be handed one sentence with an `{operation}` hole in it.
    expect(thaiOf(translateQuoteError(pgError('23001'), 'reprice_line'))).toBe(
      'รายการนี้มีราคาที่ตกลงกับลูกค้าไว้แล้ว — ต้องยกเลิกหรือแก้ราคาที่ตกลงไว้ก่อนจึงจะเปลี่ยนจำนวนหรือรายละเอียดได้',
    );
    expect(thaiOf(translateQuoteError(pgError('23001'), 'remove_line'))).toBe(
      'รายการนี้มีราคาที่ตกลงกับลูกค้าไว้แล้ว — ต้องยกเลิกราคาที่ตกลงไว้ก่อนจึงจะลบรายการได้',
    );
    expect(thaiOf(translateQuoteError(pgError('23001'), 'write_line'))).toBe(
      'แก้ไขใบเสนอราคานี้ไม่ได้ในสถานะปัจจุบัน — กรุณาโหลดข้อมูลใหม่แล้วลองอีกครั้ง',
    );
    expect(thaiOf(translateQuoteError(pgError('23001'), 'write_override'))).toBe(
      'แก้ไขราคาในใบเสนอราคานี้ไม่ได้ในสถานะปัจจุบัน — กรุณาโหลดข้อมูลใหม่',
    );
    expect(thaiOf(translateQuoteError(pgError('23001'), 'supersede_override'))).toBe(
      'ราคาที่ตกลงไว้รายการนี้ถูกแก้ไขไปแล้วโดยคนอื่น — กรุณาโหลดข้อมูลใหม่แล้วลองอีกครั้ง',
    );
  });

  it('one constraint name, two vocabularies, two sentences', () => {
    // ⭐ `refunds_accrual_entry_key` is explained differently to a slip reviewer and to an
    // accountant. A key space flattened to the constraint name would have kept whichever
    // was registered last, and the loss would have looked like a working system.
    expect(thaiOf(translateSlipError(pgError('23505', 'refunds_accrual_entry_key')))).toBe(
      'รายการตั้งค้างนี้ถูกอ้างถึงโดยการคืนเงินอื่นแล้ว',
    );
    expect(thaiOf(translatePaymentError(pgError('23505', 'refunds_accrual_entry_key')))).toBe(
      'ยอดค้างจ่ายก้อนนี้มีคำขอคืนเงินอยู่แล้ว — เงินก้อนเดียวคืนได้ครั้งเดียว',
    );

    // And the same for `ledger_postings_amount_nonzero`, which both tables also share.
    expect(thaiOf(translateSlipError(pgError('23514', 'ledger_postings_amount_nonzero')))).toBe(
      'รายการบัญชีที่เป็นศูนย์ไม่มีความหมาย',
    );
    expect(thaiOf(translatePaymentError(pgError('23514', 'ledger_postings_amount_nonzero')))).toBe(
      'รายการบัญชีที่เป็นศูนย์ไม่มีความหมาย',
    );
  });

  it('the slip guard, which is a concatenation of two clauses', () => {
    expect(thaiOf(translateSlipError(pgError('23001')))).toBe(
      'รายการชำระเงินนี้ไม่ผ่านการตรวจสอบของฐานข้อมูล — ' +
        'ยอดที่ตัดชำระต้องเท่ากับยอดบนสลิปพอดี และตารางงวดอาจถูกแก้ไขระหว่างที่คุณกำลังตรวจ กรุณาโหลดใหม่แล้วตรวจอีกครั้ง',
    );
  });

  it('an unrecognised SQLSTATE is still handed back untouched', () => {
    // Not a parity detail — a property. Wrapping an unknown driver error in a 4xx files our
    // bug under the caller's mistakes and loses the stack, and every one of the five
    // translators says so in its own header. The keys did not change that.
    const unknown = pgError('42P01');
    expect(translatePostgresError(unknown)).toBe(unknown);
    expect(translateOrderError(unknown)).toBe(unknown);
    expect(translateQuoteError(unknown, 'write_line')).toBe(unknown);
    expect(translatePaymentError(unknown)).toBe(unknown);
    /* The slip translator delegates its default arm to the order one, which also declines. */
    expect(translateSlipError(unknown)).toBe(unknown);
  });
});

describe('parity — the sentences that carry money', () => {
  /*
   * These are the six that used to build `฿5,529.60` inside `allocations.ts` with a private
   * `satang()` helper. The figures are the ones plan 7.13's smoke path and the red team's
   * report actually name — ฿5,529.60, ฿19,722.24, ฿277.76 — rather than round numbers,
   * because a grouping bug and an off-by-one in the satang both survive `฿100.00`.
   */
  it('renders the same baht and satang the private helper did', () => {
    const cases: readonly (readonly [bigint, string])[] = [
      [552_960n, '฿5,529.60'],
      [1_972_224n, '฿19,722.24'],
      [27_776n, '฿277.76'],
      [2_000_000n, '฿20,000.00'],
      [40n, '฿0.40'],
      [0n, '฿0.00'],
      [-40n, '-฿0.40'],
      [123_456_789_012n, '฿1,234,567,890.12'],
    ];

    for (const [minor, expected] of cases) {
      const rendered = renderInThai({
        key: 'error.slip.overpayment_not_acknowledged',
        params: { excess: { kind: 'money', minor, currency: 'THB' } },
      });
      expect(rendered, minor.toString()).toBe(
        `สลิปใบนี้เกินยอดที่ตารางงวดรองรับอยู่ ${expected} — ` +
          'ถ้ายืนยันว่าเงินเข้าจริง ให้ระบุยอดส่วนเกินเพื่อรับไว้เป็นเงินรับล่วงหน้าที่ยังไม่ตัดงวดใด',
      );
    }
  });

  it('the footing refusal, with all three figures in their old places', () => {
    // The sentence a reviewer reads when they typed ฿5,529.20 against a ฿5,529.60
    // photograph. `allocations.ts` spends a paragraph on why the *difference* has to be in
    // it rather than "the total does not match"; the difference is now a param and is still
    // in it.
    expect(
      renderInThai({
        key: 'error.slip.foot_mismatch',
        params: {
          allocated: { kind: 'money', minor: 552_920n, currency: 'THB' },
          slip: { kind: 'money', minor: 552_960n, currency: 'THB' },
          difference: { kind: 'money', minor: 40n, currency: 'THB' },
        },
      }),
    ).toBe(
      'ยอดที่ตัดชำระรวม ฿5,529.20 แต่สลิปใบนี้เป็นเงิน ฿5,529.60 — ' +
        'ต่างกัน ฿0.40 · สลิปที่รับแล้วต้องตัดชำระเท่ากับเงินที่เป็นหลักฐานพอดี',
    );
  });

  it('the instalment refusal, whose ordinal is a count and not a String()', () => {
    expect(
      renderInThai({
        key: 'error.slip.over_allocated',
        params: {
          seq: { kind: 'count', value: 2 },
          remaining: { kind: 'money', minor: 1_290_240n, currency: 'THB' },
          requested: { kind: 'money', minor: 1_843_200n, currency: 'THB' },
        },
      }),
    ).toBe(
      'งวดที่ 2 ค้างอยู่ ฿12,902.40 แต่ระบุตัดชำระ ฿18,432.00 — ' +
        'ส่วนเกินเป็นของงวดถัดไป ไม่ใช่ของงวดนี้',
    );
  });

  it('a product id is quoted by the locale and not by the call site', () => {
    expect(
      renderServerMessage(
        {
          key: 'error.catalog.product_not_found',
          params: { productId: { kind: 'code', value: 'awn-4t' } },
        },
        'th',
      ).text,
    ).toBe('ไม่พบสินค้ารหัส "awn-4t"');
  });
});
