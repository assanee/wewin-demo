import 'client-only';

import type {
  AvailabilityRequestWire,
  BankAccountChangeWire,
  BankAccountCreateRequestWire,
  BankAccountPatchRequestWire,
  BankAccountWire,
  OrganisationProfilePutRequestWire,
  OrganisationProfileWire,
} from '@wewin/contract/organisation';

import { apiJson } from '@/lib/api/client';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Every call this screen makes to `OrganisationController` — GET, PUT, POST, PATCH.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Unlike `option-group-api.ts`'s writes, every one of these answers with the row it just
 * wrote, not a `204`. `catalog-api.ts:143-246`'s house rule still applies exactly the same
 * way: `@wewin/contract/organisation` publishes the *request* schemas
 * (`bankAccountCreateSchema` and friends) because apps/api validates a body against them, but
 * no schema for what a `GET` answers with — so the response is narrowed by hand below, never
 * cast, with the field name in the `TypeError` so `apiJson` can turn it into a `MALFORMED`
 * with the path attached.
 */

function asObject(input: unknown, what: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError(`${what} is not an object`);
  }
  return input as Record<string, unknown>;
}

function str(row: Record<string, unknown>, key: string, what: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new TypeError(`${what} has no ${key}`);
  return value;
}

function nullableStr(row: Record<string, unknown>, key: string, what: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new TypeError(`${what} has a non-string ${key}`);
  return value;
}

function num(row: Record<string, unknown>, key: string, what: string): number {
  const value = row[key];
  if (typeof value !== 'number') throw new TypeError(`${what} has no ${key}`);
  return value;
}

function bool(row: Record<string, unknown>, key: string, what: string): boolean {
  const value = row[key];
  if (typeof value !== 'boolean') throw new TypeError(`${what} has no ${key}`);
  return value;
}

export function decodeProfile(input: unknown): OrganisationProfileWire {
  const row = asObject(input, 'organisation profile');
  return {
    legalNameTh: str(row, 'legalNameTh', 'organisation profile'),
    legalNameEn: nullableStr(row, 'legalNameEn', 'organisation profile'),
    addressTh: str(row, 'addressTh', 'organisation profile'),
    addressEn: nullableStr(row, 'addressEn', 'organisation profile'),
    taxId: nullableStr(row, 'taxId', 'organisation profile'),
    phone: str(row, 'phone', 'organisation profile'),
    email: nullableStr(row, 'email', 'organisation profile'),
    updatedAt: str(row, 'updatedAt', 'organisation profile'),
  };
}

export function decodeBankAccount(input: unknown): BankAccountWire {
  const row = asObject(input, 'bank account');
  const id = str(row, 'id', 'bank account');
  const what = `bank account "${id}"`;
  return {
    id,
    bankCode: str(row, 'bankCode', what),
    accountNumber: str(row, 'accountNumber', what),
    accountName: str(row, 'accountName', what),
    promptpayId: nullableStr(row, 'promptpayId', what),
    sortOrder: num(row, 'sortOrder', what),
    isActive: bool(row, 'isActive', what),
    updatedAt: str(row, 'updatedAt', what),
  };
}

/**
 * `before`/`after` are read only as "an object, or (for `before`) null" — never narrowed field
 * by field. What is inside them is a free-form snapshot the server decided to keep
 * (`organisation.service.ts`'s `RECORDED`), not a contract this dashboard validates; reading
 * it is `bank-account-changes.ts`'s job, at render time, where an unrecognised key is simply a
 * field this build does not know how to label rather than a decode failure.
 */
export function decodeBankAccountChange(input: unknown): BankAccountChangeWire {
  const row = asObject(input, 'bank account change');
  const id = str(row, 'id', 'bank account change');
  const what = `bank account change "${id}"`;

  const before = row['before'];
  if (before !== null && (typeof before !== 'object' || Array.isArray(before))) {
    throw new TypeError(`${what} has a before that is neither an object nor null`);
  }
  const after = row['after'];
  if (typeof after !== 'object' || after === null || Array.isArray(after)) {
    throw new TypeError(`${what} has no after`);
  }

  return {
    id,
    changedAt: str(row, 'changedAt', what),
    changedByUserId: nullableStr(row, 'changedByUserId', what),
    before: before as Readonly<Record<string, unknown>> | null,
    after: after as Readonly<Record<string, unknown>>,
  };
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

export const getProfile = (): Promise<OrganisationProfileWire> =>
  apiJson('/admin/organisation', decodeProfile);

/**
 * Every account, including retired ones. Admin only — Task 10's customer-facing route filters
 * to what is live. Retired rows are kept in this list deliberately: an administrator auditing
 * "what did we retire, and when" has to be able to see the row, not just the ones still paid.
 */
export const listBankAccounts = (): Promise<readonly BankAccountWire[]> =>
  apiJson('/admin/organisation/bank-accounts', (body) => {
    const row = asObject(body, 'bank accounts response');
    const accounts = row['accounts'];
    if (!Array.isArray(accounts)) throw new TypeError('bank accounts response has no accounts array');
    return accounts.map(decodeBankAccount);
  });

export const listBankAccountChanges = (id: string): Promise<readonly BankAccountChangeWire[]> =>
  apiJson(`/admin/organisation/bank-accounts/${encodeURIComponent(id)}/changes`, (body) => {
    const row = asObject(body, 'bank account changes response');
    const changes = row['changes'];
    if (!Array.isArray(changes)) throw new TypeError('bank account changes response has no changes array');
    return changes.map(decodeBankAccountChange);
  });

/* ------------------------------------------------------------------ *
 * Writes — every one answers with the row it just wrote, decoded the same way a read is
 * ------------------------------------------------------------------ */

const withBody = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const putProfile = (request: OrganisationProfilePutRequestWire): Promise<OrganisationProfileWire> =>
  apiJson('/admin/organisation', decodeProfile, withBody('PUT', request));

export const createBankAccount = (request: BankAccountCreateRequestWire): Promise<BankAccountWire> =>
  apiJson('/admin/organisation/bank-accounts', decodeBankAccount, withBody('POST', request));

export const patchBankAccount = (
  id: string,
  request: BankAccountPatchRequestWire,
): Promise<BankAccountWire> =>
  apiJson(
    `/admin/organisation/bank-accounts/${encodeURIComponent(id)}`,
    decodeBankAccount,
    withBody('PATCH', request),
  );

/**
 * ⚠️ Its own endpoint, not a field `patchBankAccount` also accepts — `bankAccountPatchSchema`
 * is `z.strictObject` with no `isActive`, so this is the only path that can turn an account on
 * or off, and the API records it in `bank_account_changes` exactly like any other edit.
 */
export const setBankAccountAvailability = (id: string, isActive: boolean): Promise<BankAccountWire> =>
  apiJson(
    `/admin/organisation/bank-accounts/${encodeURIComponent(id)}/availability`,
    decodeBankAccount,
    withBody('PUT', { isActive } satisfies AvailabilityRequestWire),
  );
