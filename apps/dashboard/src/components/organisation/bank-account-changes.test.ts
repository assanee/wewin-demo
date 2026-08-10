import { describe, expect, it } from 'vitest';
import type { BankAccountChangeWire } from '@wewin/contract/organisation';

import { changedFields, isCreation } from './bank-account-changes';

const change = (before: Record<string, unknown> | null, after: Record<string, unknown>): BankAccountChangeWire => ({
  id: '00000000-0000-4000-8000-000000000001',
  changedAt: '2026-08-09T10:00:00.000Z',
  changedByUserId: '00000000-0000-4000-8000-0000000000aa',
  before,
  after,
});

const SNAPSHOT = {
  bankCode: 'SCB',
  accountNumber: '1234567890',
  accountName: 'บริษัท วีวิน180 จำกัด',
  promptpayId: null,
  isActive: true,
};

describe('isCreation', () => {
  it('is true only when there is nothing to diff against', () => {
    expect(isCreation(change(null, SNAPSHOT))).toBe(true);
    expect(isCreation(change(SNAPSHOT, SNAPSHOT))).toBe(false);
  });
});

describe('changedFields', () => {
  it('shows every recorded field on a creation, in the fixed order, not Object.keys order', () => {
    const fields = changedFields(change(null, SNAPSHOT));

    expect(fields.map((field) => field.key)).toEqual([
      'bankCode',
      'accountNumber',
      'accountName',
      'promptpayId',
      'isActive',
    ]);
    expect(fields.every((field) => field.beforeText === '—')).toBe(true);
    expect(fields.find((field) => field.key === 'isActive')?.afterText).toBe('ใช้งาน');
    expect(fields.find((field) => field.key === 'promptpayId')?.afterText).toBe('ไม่ระบุ');
  });

  it('shows only the field that moved on an edit — the assertion this function exists for', () => {
    /*
     * ⭐ `snapshot()` on the server records all five fields on every write, changed or not.
     * A view that showed every recorded field on every row would bury the one number an
     * auditor is actually looking for under four that never moved.
     */
    const after = { ...SNAPSHOT, accountNumber: '9876543210' };
    const fields = changedFields(change(SNAPSHOT, after));

    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({
      key: 'accountNumber',
      labelTh: 'เลขบัญชี',
      beforeText: '1234567890',
      afterText: '9876543210',
    });
  });

  it('shows a deactivation as the one field it is', () => {
    const fields = changedFields(change(SNAPSHOT, { ...SNAPSHOT, isActive: false }));

    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({ key: 'isActive', beforeText: 'ใช้งาน', afterText: 'ปิดใช้งาน' });
  });

  it('treats an absent key and an explicit null as the same value, so neither reads as a change', () => {
    // What a row from before a field existed could look like, versus one that recorded it null.
    const before: Record<string, unknown> = { ...SNAPSHOT };
    delete before['promptpayId'];
    const fields = changedFields(change(before, SNAPSHOT));

    expect(fields).toHaveLength(0);
  });

  it('reports nothing when a write recorded no actual change — every field intact', () => {
    expect(changedFields(change(SNAPSHOT, { ...SNAPSHOT }))).toEqual([]);
  });

  it('renders a cleared promptpay id distinctly from one that was never set', () => {
    const withPromptpay = { ...SNAPSHOT, promptpayId: '0812345678' };
    const fields = changedFields(change(withPromptpay, SNAPSHOT));

    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({ key: 'promptpayId', beforeText: '0812345678', afterText: 'ไม่ระบุ' });
  });
});
