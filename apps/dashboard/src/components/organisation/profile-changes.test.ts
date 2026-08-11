import { describe, expect, it } from 'vitest';

import type { ProfileChangeRow } from './organisation-api';
import { isProfileCreation, profileChangedFields } from './profile-changes';

const change = (
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
): ProfileChangeRow => ({
  id: '00000000-0000-4000-8000-000000000001',
  changedAt: '2026-08-09T10:00:00.000Z',
  changedByUserId: '00000000-0000-4000-8000-0000000000aa',
  before,
  after,
});

const SNAPSHOT = {
  legalNameTh: 'บริษัท วีวิน180 จำกัด',
  legalNameEn: 'Wewin180 Co., Ltd.',
  addressTh: '180 ถนนสุขุมวิท กรุงเทพฯ',
  addressEn: null,
  taxId: '1234567890123',
  phone: '021234567',
  email: null,
  depositBp: 10_000,
};

describe('isProfileCreation', () => {
  it('is true only when there is nothing to diff against', () => {
    expect(isProfileCreation(change(null, SNAPSHOT))).toBe(true);
    expect(isProfileCreation(change(SNAPSHOT, SNAPSHOT))).toBe(false);
  });
});

describe('profileChangedFields', () => {
  it('shows every recorded field on a creation, in the fixed order, not Object.keys order', () => {
    const fields = profileChangedFields(change(null, SNAPSHOT));

    expect(fields.map((field) => field.key)).toEqual([
      'legalNameTh',
      'legalNameEn',
      'addressTh',
      'addressEn',
      'taxId',
      'phone',
      'email',
      'depositBp',
    ]);
    expect(fields.every((field) => field.beforeText === '—')).toBe(true);
    expect(fields.find((field) => field.key === 'addressEn')?.afterText).toBe('—');
    expect(fields.find((field) => field.key === 'depositBp')?.afterText).toBe('100%');
  });

  it('shows only the field that moved on an edit', () => {
    const after = { ...SNAPSHOT, phone: '029998888' };
    const fields = profileChangedFields(change(SNAPSHOT, after));

    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({
      key: 'phone',
      labelTh: 'เบอร์โทร',
      beforeText: '021234567',
      afterText: '029998888',
    });
  });

  it('renders a depositBp move as a percentage, never the raw basis points', () => {
    // ⭐ The one row this module exists for: "10000 → 3000" is unreconcilable with what the
    // profile form itself shows as "100% → 30%" — see this module's own header note.
    const fields = profileChangedFields(change(SNAPSHOT, { ...SNAPSHOT, depositBp: 3_000 }));

    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({ key: 'depositBp', beforeText: '100%', afterText: '30%' });
  });

  it('renders a fractional deposit percentage without inventing false precision', () => {
    const fields = profileChangedFields(change(SNAPSHOT, { ...SNAPSHOT, depositBp: 750 }));

    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({ key: 'depositBp', beforeText: '100%', afterText: '7.5%' });
  });

  it('treats an absent key and an explicit null as the same value, so neither reads as a change', () => {
    const before: Record<string, unknown> = { ...SNAPSHOT };
    delete before['addressEn'];
    const fields = profileChangedFields(change(before, SNAPSHOT));

    expect(fields).toHaveLength(0);
  });

  it('reports nothing when a write recorded no actual change — every field intact', () => {
    expect(profileChangedFields(change(SNAPSHOT, { ...SNAPSHOT }))).toEqual([]);
  });

  it('renders a cleared optional field distinctly from one that was never set', () => {
    const withEmail = { ...SNAPSHOT, email: 'ap@wewin180.example' };
    const fields = profileChangedFields(change(withEmail, SNAPSHOT));

    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({ key: 'email', beforeText: 'ap@wewin180.example', afterText: '—' });
  });
});
