import { describe, expect, it } from 'vitest';

import {
  fieldsFromProfile,
  profileFormErrors,
  profileFormReady,
  profileRequest,
  type ProfileFields,
} from './profile-form';

/**
 * The form checks the same shapes `organisationProfilePutSchema` does, ahead of the request —
 * see the header of `profile-form.ts` for why that duplication is deliberate, and for why
 * "required" is `profileFormReady`'s job rather than an entry in `profileFormErrors`.
 */

const VALID: ProfileFields = {
  legalNameTh: 'บริษัท วีวิน180 จำกัด',
  legalNameEn: 'Wewin180 Co., Ltd.',
  addressTh: '180 ถนนสุขุมวิท กรุงเทพฯ',
  addressEn: '',
  taxId: '1234567890123',
  phone: '021234567',
  email: 'info@wewin180.co.th',
  depositPercent: '30',
};

describe('profileFormErrors', () => {
  it('accepts a fully filled, well-shaped form', () => {
    expect(profileFormErrors(VALID)).toEqual({});
  });

  it('accepts the three optional fields left blank', () => {
    expect(
      profileFormErrors({ ...VALID, legalNameEn: '', addressEn: '', taxId: '', email: '' }),
    ).toEqual({});
  });

  it('never reports a merely-empty field as an error — that is profileFormReady’s job', () => {
    /*
     * ⭐ The assertion this function exists for. A dialog that just opened with blank fields
     * must show no red text at all — `value-dialog.tsx`'s `hexError` sets this precedent, and
     * a decoder that regressed to "empty is an error" would paint every required field red
     * before a person had typed a single character.
     */
    expect(
      profileFormErrors({ ...VALID, legalNameTh: '', addressTh: '', phone: '', depositPercent: '' }),
    ).toEqual({});
  });

  it('refuses a tax id that is not exactly thirteen digits', () => {
    expect(profileFormErrors({ ...VALID, taxId: '123' }).taxId).toBeDefined();
    expect(profileFormErrors({ ...VALID, taxId: '12345678901234' }).taxId).toBeDefined();
    expect(profileFormErrors({ ...VALID, taxId: '123456789012a' }).taxId).toBeDefined();
  });

  it('refuses an email with no @ or no domain, and accepts one that has both', () => {
    expect(profileFormErrors({ ...VALID, email: 'not-an-email' }).email).toBeDefined();
    expect(profileFormErrors({ ...VALID, email: 'a@b' }).email).toBeDefined();
    expect(profileFormErrors({ ...VALID, email: 'a@b.co' }).email).toBeUndefined();
  });

  it('refuses a deposit outside 0..100%, and 0% itself — the schema floor is 1 bp, not 0', () => {
    /*
     * ⭐ `organisationProfilePutSchema`'s `depositBp` is `z.int().min(1).max(10_000)` because
     * "the schedule planner refuses a 0% deposit" — 0% is not merely unusual here, it is the
     * one value between the general 0..100% range and this field's own floor.
     */
    expect(profileFormErrors({ ...VALID, depositPercent: '0' }).depositPercent).toBeDefined();
    expect(profileFormErrors({ ...VALID, depositPercent: '200' }).depositPercent).toBeDefined();
    expect(profileFormErrors({ ...VALID, depositPercent: 'abc' }).depositPercent).toBeDefined();
    expect(profileFormErrors({ ...VALID, depositPercent: '0.01' }).depositPercent).toBeUndefined();
    expect(profileFormErrors({ ...VALID, depositPercent: '100' }).depositPercent).toBeUndefined();
  });
});

describe('profileFormReady', () => {
  it('is ready once the four required fields hold something and nothing is malformed', () => {
    expect(profileFormReady(VALID)).toBe(true);
    expect(profileFormReady({ ...VALID, legalNameEn: '', addressEn: '', taxId: '', email: '' })).toBe(
      true,
    );
  });

  it('is not ready while a required field is blank — this is where "required" lives', () => {
    expect(profileFormReady({ ...VALID, legalNameTh: '   ' })).toBe(false);
    expect(profileFormReady({ ...VALID, addressTh: '' })).toBe(false);
    expect(profileFormReady({ ...VALID, phone: '' })).toBe(false);
    expect(profileFormReady({ ...VALID, depositPercent: '' })).toBe(false);
  });

  it('is not ready while an optional field is present but malformed', () => {
    expect(profileFormReady({ ...VALID, taxId: '123' })).toBe(false);
    expect(profileFormReady({ ...VALID, email: 'not-an-email' })).toBe(false);
  });

  it('is not ready while the deposit is present but below the floor or out of range', () => {
    expect(profileFormReady({ ...VALID, depositPercent: '0' })).toBe(false);
    expect(profileFormReady({ ...VALID, depositPercent: '200' })).toBe(false);
  });
});

describe('profileRequest', () => {
  it('trims every field and carries the optional ones through when present', () => {
    const request = profileRequest({ ...VALID, legalNameTh: '  บริษัท  ', phone: ' 021234567 ' });
    expect(request.legalNameTh).toBe('บริษัท');
    expect(request.phone).toBe('021234567');
    expect(request.taxId).toBe('1234567890123');
  });

  it('encodes the deposit percentage as basis points', () => {
    expect(profileRequest({ ...VALID, depositPercent: '30' }).depositBp).toBe(3_000);
    expect(profileRequest({ ...VALID, depositPercent: '7.5' }).depositBp).toBe(750);
  });

  it('sends null for a blank optional field, never omits it', () => {
    /*
     * ⭐ The assertion this function exists for. `putProfile` spreads the request into
     * Drizzle's `.set(...)`, which only touches keys that are present — an omitted `taxId`
     * would leave a previously-set one in the database untouched, not clear it.
     */
    const request = profileRequest({ ...VALID, legalNameEn: '', addressEn: '  ', taxId: '', email: '' });
    expect(request.legalNameEn).toBeNull();
    expect(request.addressEn).toBeNull();
    expect(request.taxId).toBeNull();
    expect(request.email).toBeNull();
    expect(Object.keys(request).sort()).toEqual(
      ['legalNameTh', 'legalNameEn', 'addressTh', 'addressEn', 'taxId', 'phone', 'email', 'depositBp'].sort(),
    );
  });
});

describe('fieldsFromProfile and profileRequest round-trip', () => {
  it('reads a loaded profile into editable fields and back into an equivalent request', () => {
    const fields = fieldsFromProfile({
      legalNameTh: 'บริษัท วีวิน180 จำกัด',
      legalNameEn: null,
      addressTh: '180 ถนนสุขุมวิท',
      addressEn: null,
      taxId: null,
      phone: '021234567',
      email: null,
      depositBp: 3_000,
    });

    expect(fields.legalNameEn).toBe('');
    expect(fields.taxId).toBe('');
    expect(fields.depositPercent).toBe('30');

    const request = profileRequest(fields);
    expect(request.legalNameEn).toBeNull();
    expect(request.taxId).toBeNull();
    expect(request.legalNameTh).toBe('บริษัท วีวิน180 จำกัด');
    expect(request.depositBp).toBe(3_000);
  });
});
