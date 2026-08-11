import { describe, expect, it } from 'vitest';

import {
  decodeBankAccount,
  decodeBankAccountChange,
  decodeProfile,
  decodeProfileChange,
  decodeTaxCountry,
  decodeTaxCountryChange,
} from './organisation-api';

/**
 * The hand-narrowed decoders, tested where hand-narrowing goes wrong — the same reason
 * `authority-api.test.ts` exists for its own decoder. `@wewin/contract/organisation` publishes
 * no schema for what these three endpoints answer with, so nothing but this file proves the
 * narrowing actually runs rather than merely compiling.
 */

const PROFILE = {
  legalNameTh: 'บริษัท วีวิน180 จำกัด',
  legalNameEn: 'Wewin180 Co., Ltd.',
  addressTh: '180 ถนนสุขุมวิท กรุงเทพฯ',
  addressEn: null,
  taxId: '1234567890123',
  phone: '021234567',
  email: null,
  depositBp: 10_000,
  updatedAt: '2026-08-09T10:00:00.000Z',
};

describe('decodeProfile', () => {
  it('accepts a well-formed profile, nulls and all', () => {
    const profile = decodeProfile(PROFILE);
    expect(profile.legalNameTh).toBe('บริษัท วีวิน180 จำกัด');
    expect(profile.addressEn).toBeNull();
    expect(profile.email).toBeNull();
  });

  it('refuses a response that is not an object', () => {
    expect(() => decodeProfile(null)).toThrow();
    expect(() => decodeProfile('บริษัท')).toThrow();
    expect(() => decodeProfile([PROFILE])).toThrow();
  });

  it('refuses a missing required field rather than reading it as an empty string', () => {
    const { legalNameTh: _unused, ...broken } = PROFILE;
    expect(() => decodeProfile(broken)).toThrow(/legalNameTh/);
  });

  it('refuses a nullable field that is neither a string nor null', () => {
    expect(() => decodeProfile({ ...PROFILE, taxId: 13 })).toThrow(/taxId/);
  });
});

const ACCOUNT = {
  id: '00000000-0000-4000-8000-000000000001',
  bankCode: 'SCB',
  accountNumber: '1234567890',
  accountName: 'บริษัท วีวิน180 จำกัด',
  promptpayId: null,
  sortOrder: 0,
  isActive: true,
  updatedAt: '2026-08-09T10:00:00.000Z',
};

describe('decodeBankAccount', () => {
  it('accepts a well-formed account', () => {
    const account = decodeBankAccount(ACCOUNT);
    expect(account.bankCode).toBe('SCB');
    expect(account.isActive).toBe(true);
    expect(account.promptpayId).toBeNull();
  });

  it('does not hide a retired account behind a decode failure — it is still valid shape', () => {
    // Task 9's GET returns inactive rows deliberately; the decoder must accept `isActive: false`
    // exactly as readily as `true`, or a retired account would vanish from the admin screen too.
    const account = decodeBankAccount({ ...ACCOUNT, isActive: false });
    expect(account.isActive).toBe(false);
  });

  it('refuses a sortOrder that is not a number', () => {
    expect(() => decodeBankAccount({ ...ACCOUNT, sortOrder: '0' })).toThrow(/sortOrder/);
  });

  it('refuses an isActive that is not a boolean, naming the field', () => {
    expect(() => decodeBankAccount({ ...ACCOUNT, isActive: 'true' })).toThrow(/isActive/);
  });

  it('names the account id in every error once it is known', () => {
    expect(() => decodeBankAccount({ ...ACCOUNT, bankCode: undefined })).toThrow(
      new RegExp(ACCOUNT.id),
    );
  });
});

describe('decodeBankAccountChange', () => {
  const CREATE = {
    id: '00000000-0000-4000-8000-0000000000c1',
    changedAt: '2026-08-09T10:00:00.000Z',
    changedByUserId: '00000000-0000-4000-8000-0000000000aa',
    before: null,
    after: { bankCode: 'SCB', accountNumber: '1234567890', accountName: 'ชื่อ', promptpayId: null, isActive: true },
  };

  it('accepts a creation row, whose before is null', () => {
    const change = decodeBankAccountChange(CREATE);
    expect(change.before).toBeNull();
    expect(change.after).toEqual(CREATE.after);
  });

  it('accepts an edit row, whose before is the previous snapshot', () => {
    const edit = { ...CREATE, before: CREATE.after, after: { ...CREATE.after, accountNumber: '9876543210' } };
    const change = decodeBankAccountChange(edit);
    expect(change.before).toEqual(CREATE.after);
    expect((change.after as Record<string, unknown>)['accountNumber']).toBe('9876543210');
  });

  it('accepts a changedByUserId of null — the erasure case', () => {
    const change = decodeBankAccountChange({ ...CREATE, changedByUserId: null });
    expect(change.changedByUserId).toBeNull();
  });

  it('refuses an after that is missing entirely, rather than defaulting it to {}', () => {
    const { after: _unused, ...broken } = CREATE;
    expect(() => decodeBankAccountChange(broken)).toThrow(/after/);
  });

  it('refuses a before that is neither an object nor null', () => {
    expect(() => decodeBankAccountChange({ ...CREATE, before: 'yesterday' })).toThrow(/before/);
  });
});

const TAX_COUNTRY = {
  code: 'TH',
  nameTh: 'ไทย',
  rateBp: 700,
  treatment: 'standard',
  pricesIncludeTax: false,
  isActive: true,
  sortOrder: 0,
  updatedAt: '2026-08-09T10:00:00.000Z',
};

describe('decodeTaxCountry', () => {
  it('accepts a well-formed row', () => {
    const country = decodeTaxCountry(TAX_COUNTRY);
    expect(country.code).toBe('TH');
    expect(country.rateBp).toBe(700);
    expect(country.treatment).toBe('standard');
  });

  it('does not hide a withdrawn destination behind a decode failure', () => {
    const country = decodeTaxCountry({ ...TAX_COUNTRY, isActive: false });
    expect(country.isActive).toBe(false);
  });

  it('refuses a treatment this build has never heard of, naming the code', () => {
    expect(() => decodeTaxCountry({ ...TAX_COUNTRY, treatment: 'reduced' })).toThrow(/TH/);
  });

  it('refuses a rateBp that is not a number', () => {
    expect(() => decodeTaxCountry({ ...TAX_COUNTRY, rateBp: '700' })).toThrow(/rateBp/);
  });
});

describe('decodeTaxCountryChange', () => {
  const CREATE = {
    id: '00000000-0000-4000-8000-0000000000d1',
    changedAt: '2026-08-09T10:00:00.000Z',
    changedByUserId: '00000000-0000-4000-8000-0000000000aa',
    before: null,
    after: { code: 'TH', nameTh: 'ไทย', rateBp: 700, treatment: 'standard', pricesIncludeTax: false, isActive: true, sortOrder: 0 },
  };

  it('accepts a creation row, whose before is null', () => {
    const change = decodeTaxCountryChange(CREATE);
    expect(change.before).toBeNull();
    expect(change.after).toEqual(CREATE.after);
  });

  it('accepts an edit row, whose before is the previous snapshot', () => {
    const edit = { ...CREATE, before: CREATE.after, after: { ...CREATE.after, rateBp: 0, treatment: 'zero_rated' } };
    const change = decodeTaxCountryChange(edit);
    expect(change.before).toEqual(CREATE.after);
    expect((change.after as Record<string, unknown>)['treatment']).toBe('zero_rated');
  });

  it('accepts a changedByUserId of null — the erasure case', () => {
    const change = decodeTaxCountryChange({ ...CREATE, changedByUserId: null });
    expect(change.changedByUserId).toBeNull();
  });

  it('refuses an after that is missing entirely, rather than defaulting it to {}', () => {
    const { after: _unused, ...broken } = CREATE;
    expect(() => decodeTaxCountryChange(broken)).toThrow(/after/);
  });

  it('refuses a before that is neither an object nor null', () => {
    expect(() => decodeTaxCountryChange({ ...CREATE, before: 'yesterday' })).toThrow(/before/);
  });
});

describe('decodeProfileChange', () => {
  const EDIT = {
    id: '00000000-0000-4000-8000-0000000000e1',
    changedAt: '2026-08-09T10:00:00.000Z',
    changedByUserId: '00000000-0000-4000-8000-0000000000aa',
    before: { ...PROFILE, updatedAt: undefined },
    after: { ...PROFILE, updatedAt: undefined, depositBp: 3_000 },
  };

  it('accepts an edit row, whose before is the previous snapshot', () => {
    const change = decodeProfileChange(EDIT);
    expect(change.before).toEqual(EDIT.before);
    expect((change.after as Record<string, unknown>)['depositBp']).toBe(3_000);
  });

  it('accepts a creation row, whose before is null — reachable by the wire type even if never seen in practice', () => {
    const change = decodeProfileChange({ ...EDIT, before: null });
    expect(change.before).toBeNull();
  });

  it('accepts a changedByUserId of null — the erasure case', () => {
    const change = decodeProfileChange({ ...EDIT, changedByUserId: null });
    expect(change.changedByUserId).toBeNull();
  });

  it('refuses an after that is missing entirely, rather than defaulting it to {}', () => {
    const { after: _unused, ...broken } = EDIT;
    expect(() => decodeProfileChange(broken)).toThrow(/after/);
  });

  it('refuses a before that is neither an object nor null', () => {
    expect(() => decodeProfileChange({ ...EDIT, before: 'yesterday' })).toThrow(/before/);
  });
});
