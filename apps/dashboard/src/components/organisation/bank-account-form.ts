import type { BankAccountCreateRequestWire, BankAccountPatchRequestWire } from '@wewin/contract/organisation';

/**
 * The add/edit form for one receiving account, checked against the same three CHECK
 * constraints `0027_organisation.sql` enforces and `bankAccountCreateSchema` /
 * `bankAccountPatchSchema` restate — see `profile-form.ts` for why that duplication is
 * deliberate rather than drift.
 *
 * ⚠️ **A field that is merely empty is never an "error" here** — the same rule
 * `profile-form.ts` follows, and `value-dialog.tsx`'s `hexError` before both of them: a shape
 * check fires only once a field is non-empty and wrong, never for a dialog that just opened
 * with nothing typed yet. `bankAccountFormReady` is where "required" lives.
 */

export interface BankAccountFields {
  readonly bankCode: string;
  readonly accountNumber: string;
  readonly accountName: string;
  readonly promptpayId: string;
}

const BANK_CODE = /^[A-Z]{3,8}$/u;
const ACCOUNT_NUMBER = /^[0-9]{10,15}$/u;
const PROMPTPAY_ID = /^([0-9]{10}|[0-9]{13})$/u;

export interface BankAccountFormErrors {
  readonly bankCode?: string;
  readonly accountNumber?: string;
  readonly promptpayId?: string;
}

export function bankAccountFormErrors(fields: BankAccountFields): BankAccountFormErrors {
  const errors: Record<string, string> = {};

  const bankCode = fields.bankCode.trim().toUpperCase();
  if (bankCode !== '' && !BANK_CODE.test(bankCode)) {
    errors['bankCode'] = 'รหัสธนาคารเป็นตัวพิมพ์ใหญ่ 3–8 ตัว เช่น SCB, KBANK';
  }

  const accountNumber = fields.accountNumber.trim();
  if (accountNumber !== '' && !ACCOUNT_NUMBER.test(accountNumber)) {
    errors['accountNumber'] = 'เลขบัญชีเป็นตัวเลข 10–15 หลัก';
  }

  const promptpayId = fields.promptpayId.trim();
  if (promptpayId !== '' && !PROMPTPAY_ID.test(promptpayId)) {
    errors['promptpayId'] = 'พร้อมเพย์เป็นเบอร์มือถือ 10 หลัก หรือเลขผู้เสียภาษี 13 หลัก';
  }

  return errors;
}

/**
 * Whether the form may be submitted: the three required fields hold something, and no shape
 * check above is failing. The only place "required" is enforced — it disables Add/Save and
 * never paints a field's border red for a field nobody has touched yet.
 */
export function bankAccountFormReady(fields: BankAccountFields): boolean {
  return (
    fields.bankCode.trim() !== '' &&
    fields.accountNumber.trim() !== '' &&
    fields.accountName.trim() !== '' &&
    Object.keys(bankAccountFormErrors(fields)).length === 0
  );
}

/** `bankCode` is upper-cased here, once, so every request and every render agrees on its case. */
const normalise = (
  fields: BankAccountFields,
): { bankCode: string; accountNumber: string; accountName: string; promptpayId: string } => ({
  bankCode: fields.bankCode.trim().toUpperCase(),
  accountNumber: fields.accountNumber.trim(),
  accountName: fields.accountName.trim(),
  promptpayId: fields.promptpayId.trim(),
});

/** Called only once `bankAccountFormErrors` has come back empty. */
export function bankAccountCreateRequest(fields: BankAccountFields): BankAccountCreateRequestWire {
  const { bankCode, accountNumber, accountName, promptpayId } = normalise(fields);
  return {
    bankCode,
    accountNumber,
    accountName,
    ...(promptpayId === '' ? {} : { promptpayId }),
  };
}

/**
 * ⚠️ **Always the full form, and `promptpayId` always present — `null` rather than omitted
 * when blank.** `patchAccount` snapshots exactly the keys it receives into `before`/`after`
 * (`organisation.service.ts`'s `snapshot`), so a patch that omitted an unchanged field would
 * still record `null` for it in the history row — `RECORDED.map((key) => [key, row[key] ??
 * null])` reads it off the *updated* row, not off the request, so this is not a correctness
 * bug there. It matters here for a different reason: sending only the one field a person
 * edited would make an account whose promptpay id was cleared impossible to save, because
 * `bankAccountPatchSchema` treats an absent `promptpayId` as "leave it alone" and `null` as
 * "clear it" — the same distinction `profile-form.ts` makes for the organisation profile.
 */
export function bankAccountPatchRequest(fields: BankAccountFields): BankAccountPatchRequestWire {
  const { bankCode, accountNumber, accountName, promptpayId } = normalise(fields);
  return {
    bankCode,
    accountNumber,
    accountName,
    promptpayId: promptpayId === '' ? null : promptpayId,
  };
}

/** The form, from the account the list last showed — the dual of the two request builders. */
export function fieldsFromAccount(account: {
  readonly bankCode: string;
  readonly accountNumber: string;
  readonly accountName: string;
  readonly promptpayId: string | null;
}): BankAccountFields {
  return {
    bankCode: account.bankCode,
    accountNumber: account.accountNumber,
    accountName: account.accountName,
    promptpayId: account.promptpayId ?? '',
  };
}
