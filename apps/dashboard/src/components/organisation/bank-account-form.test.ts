import { describe, expect, it } from 'vitest';

import {
  bankAccountCreateRequest,
  bankAccountFormErrors,
  bankAccountFormReady,
  bankAccountPatchRequest,
  fieldsFromAccount,
  type BankAccountFields,
} from './bank-account-form';

const VALID: BankAccountFields = {
  bankCode: 'scb',
  accountNumber: '1234567890',
  accountName: 'บริษัท วีวิน180 จำกัด',
  promptpayId: '',
};

describe('bankAccountFormErrors', () => {
  it('accepts a well-shaped form, case-insensitively on the bank code', () => {
    expect(bankAccountFormErrors(VALID)).toEqual({});
  });

  it('never reports a merely-empty field as an error — that is bankAccountFormReady’s job', () => {
    /*
     * ⭐ The assertion this function exists for. A newly opened "add account" dialog has
     * every field blank; it must show no red text until somebody actually types something
     * wrong, the same rule `value-dialog.tsx`'s `hexError` follows for a swatch hex.
     */
    expect(
      bankAccountFormErrors({ ...VALID, bankCode: '', accountNumber: '', accountName: '' }),
    ).toEqual({});
  });

  it('refuses a bank code that is not 3–8 upper-case letters', () => {
    expect(bankAccountFormErrors({ ...VALID, bankCode: 'SC' }).bankCode).toBeDefined();
    expect(bankAccountFormErrors({ ...VALID, bankCode: 'SCB123456789' }).bankCode).toBeDefined();
    expect(bankAccountFormErrors({ ...VALID, bankCode: 'S-B' }).bankCode).toBeDefined();
  });

  it('refuses an account number outside 10–15 digits, and a non-digit', () => {
    expect(bankAccountFormErrors({ ...VALID, accountNumber: '123' }).accountNumber).toBeDefined();
    expect(bankAccountFormErrors({ ...VALID, accountNumber: '1'.repeat(16) }).accountNumber).toBeDefined();
    expect(bankAccountFormErrors({ ...VALID, accountNumber: '123-456-789' }).accountNumber).toBeDefined();
  });

  it('leaves promptpayId optional, but refuses a length neither a phone nor a tax id has', () => {
    expect(bankAccountFormErrors({ ...VALID, promptpayId: '' }).promptpayId).toBeUndefined();
    expect(bankAccountFormErrors({ ...VALID, promptpayId: '0812345678' }).promptpayId).toBeUndefined();
    expect(bankAccountFormErrors({ ...VALID, promptpayId: '1234567890123' }).promptpayId).toBeUndefined();
    expect(bankAccountFormErrors({ ...VALID, promptpayId: '12345' }).promptpayId).toBeDefined();
  });

  it('⭐ refuses ten digits that are not a phone number — the QR that never rendered', () => {
    /*
     * ⚠️ THE GAP THAT PUT `1234567890` ON THE ONLY ACTIVE ACCOUNT IN THE DEV DATABASE.
     *
     * The test above checks *length* and nothing else, which is precisely how this survived:
     * `1234567890` is ten digits, so it passed here, passed `bankAccountCreateSchema`, passed
     * `bank_accounts_promptpay_shape`, and was stored. Then `promptPayTarget` — the one place
     * that has to turn it into an actual QR — refused it, because every Thai mobile number
     * starts with `0`. The customer's payment screen rendered that account with no QR beside
     * it, and nothing told anybody why.
     *
     * Refusing it here is not stylistic. Accepting it would mean *guessing* which nine digits
     * of a non-phone-number to keep, and `promptpay.ts` names the result: "well-formed, scans
     * fine, moves money to a number nobody asked for."
     */
    expect(bankAccountFormErrors({ ...VALID, promptpayId: '1234567890' }).promptpayId).toBeDefined();
    expect(bankAccountFormErrors({ ...VALID, promptpayId: '9812345678' }).promptpayId).toBeDefined();

    /* And the shapes a QR *can* be built from still pass, so this is not merely stricter. */
    for (const good of ['0612345678', '0812345678', '0912345678', '0105558012345']) {
      expect(bankAccountFormErrors({ ...VALID, promptpayId: good }).promptpayId).toBeUndefined();
    }
  });
});

describe('bankAccountFormReady', () => {
  it('is ready once the three required fields hold something and nothing is malformed', () => {
    expect(bankAccountFormReady(VALID)).toBe(true);
  });

  it('is not ready while a required field is blank — this is where "required" lives', () => {
    expect(bankAccountFormReady({ ...VALID, bankCode: '' })).toBe(false);
    expect(bankAccountFormReady({ ...VALID, accountNumber: '' })).toBe(false);
    expect(bankAccountFormReady({ ...VALID, accountName: '  ' })).toBe(false);
  });

  it('is not ready while a present field is malformed, even if every field is non-empty', () => {
    expect(bankAccountFormReady({ ...VALID, bankCode: 'S-B' })).toBe(false);
    expect(bankAccountFormReady({ ...VALID, promptpayId: '12345' })).toBe(false);
  });
});

describe('bankAccountCreateRequest', () => {
  it('upper-cases the bank code and trims everything', () => {
    const request = bankAccountCreateRequest({ ...VALID, bankCode: ' scb ', accountName: '  ชื่อบัญชี  ' });
    expect(request.bankCode).toBe('SCB');
    expect(request.accountName).toBe('ชื่อบัญชี');
  });

  it('omits promptpayId entirely when blank, rather than sending an empty string', () => {
    const request = bankAccountCreateRequest(VALID);
    expect('promptpayId' in request).toBe(false);
  });

  it('carries a promptpayId through when present', () => {
    const request = bankAccountCreateRequest({ ...VALID, promptpayId: '0812345678' });
    expect(request.promptpayId).toBe('0812345678');
  });
});

describe('bankAccountPatchRequest', () => {
  it('sends null for a blank promptpayId, never omits it', () => {
    /*
     * ⭐ The assertion this function exists for. Omitting the key here would make an existing
     * promptpay id un-clearable, and `bankAccountPatchSchema` would read a request with no
     * `promptpayId` key as "leave it alone" rather than "gone".
     */
    const request = bankAccountPatchRequest(VALID);
    expect(request.promptpayId).toBeNull();
    expect('promptpayId' in request).toBe(true);
  });

  it('always carries the whole form, so a patch is a full replace as this screen uses it', () => {
    const request = bankAccountPatchRequest({ ...VALID, promptpayId: '0812345678' });
    expect(Object.keys(request).sort()).toEqual(
      ['bankCode', 'accountNumber', 'accountName', 'promptpayId'].sort(),
    );
  });
});

describe('fieldsFromAccount', () => {
  it('reads a null promptpayId back as an empty field, not the string "null"', () => {
    const fields = fieldsFromAccount({
      bankCode: 'SCB',
      accountNumber: '1234567890',
      accountName: 'ชื่อบัญชี',
      promptpayId: null,
    });
    expect(fields.promptpayId).toBe('');
  });
});
