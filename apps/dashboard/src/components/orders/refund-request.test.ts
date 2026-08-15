import { describe, expect, it } from 'vitest';

import { refundAvailability, refundFormBody } from './refund-request';

describe('when ขอคืนเงิน may be offered', () => {
  const held = 423720n;

  it('⭐ only on a cancelled order — the rule the server taught us by refusing', () => {
    /*
     * "คืนเงินได้เฉพาะออร์เดอร์ที่ถูกยกเลิกแล้วเท่านั้น". Money on a live order is not spare: it is
     * the deposit holding the production slot. Found by calling the endpoint against a
     * delivered order, not by reading the service hopefully.
     */
    for (const status of ['draft', 'awaiting_payment', 'in_production', 'delivered', 'superseded']) {
      expect(refundAvailability({ status, heldThbMinor: held, hasOpenRefund: false })).toStrictEqual({
        kind: 'notCancelled',
      });
    }

    expect(
      refundAvailability({ status: 'cancelled', heldThbMinor: held, hasOpenRefund: false }),
    ).toStrictEqual({ kind: 'available', heldThbMinor: held });
  });

  it('says nothing to refund when the company holds nothing', () => {
    for (const amount of [0n, null, -100n]) {
      expect(
        refundAvailability({ status: 'cancelled', heldThbMinor: amount, hasOpenRefund: false }).kind,
      ).toBe('nothingHeld');
    }
  });

  it('⚠️ reports an open request ahead of the balance, because that is what is in the way', () => {
    expect(
      refundAvailability({ status: 'cancelled', heldThbMinor: held, hasOpenRefund: true }).kind,
    ).toBe('pending');
  });
});

describe('the body sent to POST /payments/refunds', () => {
  it('⭐ carries no amount, because the server owns that figure', () => {
    const result = refundFormBody({ payee: null, reasonTh: '' });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.body).toStrictEqual({});
  });

  it('sends the money back the way it came when no account is typed', () => {
    const result = refundFormBody({ payee: null, reasonTh: 'ลูกค้ายกเลิกเพราะย้ายบ้าน' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body).toStrictEqual({ reasonTh: 'ลูกค้ายกเลิกเพราะย้ายบ้าน' });
      expect('payee' in result.body).toBe(false);
    }
  });

  it('⚠️ refuses a half-filled account rather than letting the server 400 on it', () => {
    const result = refundFormBody({
      payee: { name: 'มานี ใจดี', bankCode: '', accountLast4: '22' },
      reasonTh: '',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems).toHaveLength(3);
      expect(result.problems.some((p) => p.includes('ธนาคาร'))).toBe(true);
      expect(result.problems.some((p) => p.includes('4 หลัก'))).toBe(true);
      expect(result.problems.some((p) => p.includes('เหตุผล'))).toBe(true);
    }
  });

  it('⭐ demands a reason whenever an account is typed at all', () => {
    const withoutReason = refundFormBody({
      payee: { name: 'มานี ใจดี', bankCode: 'KBANK', accountLast4: '2233' },
      reasonTh: '  ',
    });
    expect(withoutReason.ok).toBe(false);

    const withReason = refundFormBody({
      payee: { name: ' มานี ใจดี ', bankCode: 'KBANK', accountLast4: '2233' },
      reasonTh: ' บัญชีเดิมปิดไปแล้ว ',
    });
    expect(withReason.ok).toBe(true);
    if (withReason.ok) {
      expect(withReason.body).toStrictEqual({
        payee: { name: 'มานี ใจดี', bankCode: 'KBANK', accountLast4: '2233' },
        reasonTh: 'บัญชีเดิมปิดไปแล้ว',
      });
    }
  });
});
