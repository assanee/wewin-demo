import { describe, expect, it } from 'vitest';

import {
  crc16ccitt,
  isPromptPayId,
  promptPayPayload,
  promptPayTarget,
  PROMPTPAY_MOBILE,
  PROMPTPAY_TAX_ID,
} from '../src/promptpay.js';

/**
 * ⭐ A QR that scans and carries the wrong number is the whole risk here.
 *
 * Nothing on screen can show this is wrong — the image renders, the phone reads it, and the
 * amount is off. So the assertions are against known payloads rather than against a
 * re-implementation of the same arithmetic.
 */
describe('CRC16-CCITT (0x1021, init 0xFFFF)', () => {
  it('matches the published check value', () => {
    // The standard test vector for this parameterisation.
    expect(crc16ccitt('123456789')).toBe('29B1');
  });

  it('is four uppercase hex digits, zero-padded', () => {
    expect(crc16ccitt('A')).toMatch(/^[0-9A-F]{4}$/u);
  });
});

describe('reading a PromptPay identifier', () => {
  it('takes ten digits as a mobile number and thirteen as a tax id', () => {
    expect(promptPayTarget('0812345678')).toStrictEqual({ kind: 'mobile', digits: '0812345678' });
    expect(promptPayTarget('0105561000001')).toStrictEqual({
      kind: 'taxId',
      digits: '0105561000001',
    });
  });

  it('refuses anything else rather than guessing', () => {
    for (const bad of ['', '081234567', '08123456789', 'abcdefghij', '081-234-5678']) {
      expect(promptPayTarget(bad), `"${bad}" was accepted`).toBeNull();
    }
  });

  /**
   * F3 — `bank_accounts_promptpay_shape` only enforces `^([0-9]{10}|[0-9]{13})$`, so a
   * ten-digit id that does not start with `0` reaches this function looking exactly like a
   * mobile number. `accountValue`'s `slice(1)` assumed a leading zero it never checked, which
   * silently drops the wrong digit and points the QR at a different number — well-formed,
   * scans fine, wrong destination. `1812345678` is the finding's own example: the database
   * accepts it today, and this is the point that must not.
   */
  it('refuses a ten-digit id that does not start with 0, rather than mis-slicing it as a mobile number', () => {
    expect(promptPayTarget('1812345678'), '"1812345678" was accepted').toBeNull();
  });

  /**
   * ⭐ And the predicate the validators call must be this same refusal, not a copy of it.
   *
   * F3 above described the gap and left it open: the CHECK, `bankAccountCreateSchema` and the
   * dashboard's `bankAccountFormErrors` all enforced `^([0-9]{10}|[0-9]{13})$`, so a staff
   * member could type `1234567890`, be told nothing, and have it stored — which is exactly
   * what the dev database held on its only *active* account. The customer's payment screen
   * then rendered that account with no QR beside it and nothing anywhere said why.
   *
   * `isPromptPayId` is now exported for those validators to call, so the front door and this
   * function cannot answer differently. Asserting them equal across the same inputs is what
   * keeps that true — a predicate that drifted from `promptPayTarget` would put the gap back
   * while every test above stayed green.
   */
  it('⭐ isPromptPayId agrees with promptPayTarget on every shape', () => {
    const inputs = [
      '0812345678',
      '0612345678',
      '0912345678',
      '0105558012345',
      '1234567890',
      '1812345678',
      '9812345678',
      '081234567',
      '08123456789',
      '',
      'abcdefghij',
      '081-234-5678',
    ];

    for (const id of inputs) {
      expect(isPromptPayId(id), `disagreed on "${id}"`).toBe(promptPayTarget(id) !== null);
    }
  });

  it('the two shape constants carry no global flag, so `.test` is not stateful', () => {
    /* A `g` regex keeps `lastIndex` between calls and would answer `false` on every second
     * call for the same string — a validator that passes on retry is worse than one that
     * fails, because nobody reproduces it. */
    expect(PROMPTPAY_MOBILE.global).toBe(false);
    expect(PROMPTPAY_TAX_ID.global).toBe(false);
    expect(isPromptPayId('0812345678')).toBe(isPromptPayId('0812345678'));
  });
});

describe('the payload', () => {
  const mobile = { kind: 'mobile', digits: '0812345678' } as const;

  it('opens with the format indicator and closes with a CRC over everything before it', () => {
    const payload = promptPayPayload(mobile, 100_00n);

    expect(payload.startsWith('000201')).toBe(true);
    expect(payload.slice(-8, -4)).toBe('6304');
    expect(payload.slice(-4)).toBe(crc16ccitt(payload.slice(0, -4)));
  });

  it('writes the amount in baht with two decimal places', () => {
    // ฿1,972.24 → tag 54, length 07, value 1972.24
    expect(promptPayPayload(mobile, 197_224n)).toContain('54071972.24');
    // ฿100.00 → length 06
    expect(promptPayPayload(mobile, 100_00n)).toContain('5406100.00');
  });

  it('carries a mobile number as 66 + the nine digits after the leading zero', () => {
    // Tag 29 → sub-tag 01 (mobile), 13 digits: 0066 + 812345678
    expect(promptPayPayload(mobile, 100_00n)).toContain('01130066812345678');
  });

  it('marks a payload that names an amount as single-use', () => {
    // Point-of-initiation 12 = dynamic. A static QR (11) with an amount is a contradiction.
    expect(promptPayPayload(mobile, 100_00n)).toContain('010212');
  });

  it('refuses a non-positive amount rather than emitting a scannable zero', () => {
    expect(() => promptPayPayload(mobile, 0n)).toThrow(RangeError);
    expect(() => promptPayPayload(mobile, -1n)).toThrow(RangeError);
  });
});
