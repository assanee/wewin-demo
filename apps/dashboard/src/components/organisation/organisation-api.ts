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
import {
  TAX_TREATMENTS_WIRE,
  type TaxCountryAvailabilityRequest,
  type TaxCountryPatchRequest,
  type TaxCountryWire,
} from '@wewin/contract/tax';

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
 *
 * `@wewin/contract/tax` happens to export `taxCountryWireSchema`/`settingChangeWireSchema` —
 * real zod schemas, unlike the organisation contract's request-only exports — but they are not
 * used here: `zod` is not a declared dependency of `@wewin/dashboard`, and pnpm's workspace
 * layout does not hoist a sibling package's own dependency into this one, so importing it
 * would be a phantom import today and a real one added on purpose tomorrow. Hand-narrowing
 * `decodeTaxCountry`/`decodeTaxCountryChange` below the same way `decodeProfile` and
 * `decodeBankAccount` already do keeps this file's one decoding idiom, one dependency list.
 *
 * `listTaxCountries` reads the admin's own read (Task 5): active *and* withdrawn rows, code
 * and everything the row carries, so the table below can render a withdrawn destination dimmed
 * rather than missing — the same choice `listBankAccounts` makes for retired accounts.
 * `createTaxCountry` is deliberately not wired here: `0029_tax_countries.sql` seeds Thailand
 * "and only Thailand" — "a foreign rate is a tax registration somebody has to actually hold —
 * seeding one would put an unverified number where it looks verified" — so a new destination
 * is not a form a staff member fills in from this screen. The four calls below are read, edit,
 * withdraw/restore, and history — the ones `TaxCountriesSection` actually has a control for.
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
    depositBp: num(row, 'depositBp', 'organisation profile'),
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

function treatmentOf(row: Record<string, unknown>, what: string): TaxCountryWire['treatment'] {
  const value = row['treatment'];
  if (typeof value !== 'string' || !(TAX_TREATMENTS_WIRE as readonly string[]).includes(value)) {
    throw new TypeError(`${what} has an unrecognised treatment`);
  }
  return value as TaxCountryWire['treatment'];
}

export function decodeTaxCountry(input: unknown): TaxCountryWire {
  const row = asObject(input, 'tax country');
  const code = str(row, 'code', 'tax country');
  const what = `tax country "${code}"`;
  return {
    code,
    nameTh: str(row, 'nameTh', what),
    rateBp: num(row, 'rateBp', what),
    treatment: treatmentOf(row, what),
    pricesIncludeTax: bool(row, 'pricesIncludeTax', what),
    isActive: bool(row, 'isActive', what),
    sortOrder: num(row, 'sortOrder', what),
    updatedAt: str(row, 'updatedAt', what),
  };
}

/**
 * `SettingChangeWire` (`@wewin/contract/tax`) is one shape shared by two change logs — tax
 * country and the organisation profile — and its `before`/`after` are typed as bare `unknown`
 * for exactly that reason: the two logs snapshot different fields, so the contract cannot fix
 * a `Record` shape without picking one of them. This narrows those two properties to an object
 * (or, for `before`, `null`) the same way `decodeBankAccountChange` narrows
 * `BankAccountChangeWire`'s — which *does* fix a `Record` shape, because that type serves one
 * log alone. `TaxCountryChangeRow` restates the same five fields with that narrowing applied,
 * for `tax-country-fields.ts`'s reader to index into without re-checking `typeof` itself.
 */
export interface TaxCountryChangeRow {
  readonly id: string;
  readonly changedAt: string;
  readonly changedByUserId: string | null;
  readonly before: Readonly<Record<string, unknown>> | null;
  readonly after: Readonly<Record<string, unknown>>;
}

export function decodeTaxCountryChange(input: unknown): TaxCountryChangeRow {
  const row = asObject(input, 'tax country change');
  const id = str(row, 'id', 'tax country change');
  const what = `tax country change "${id}"`;

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

/**
 * Every destination, active and withdrawn — the admin list, keyed `taxCountries` on the wire.
 *
 * `countries` alone (the strict parallel to `bank-accounts` → `accounts`) would read as *every*
 * country in the world; `taxCountries` says what this actually is — the configured subset with
 * a tax policy attached — and matches `products`/`categories`/`users`/`groups`/`limits`, the
 * majority of `apps/api`'s wrapped lists, which key on the full segment name rather than a
 * shorthand. Reads cleanly from here: `row['taxCountries']` beside a function named
 * `listTaxCountries` is exactly the symmetry `listBankAccounts`'s `row['accounts']` has with
 * its own name.
 */
export const listTaxCountries = (): Promise<readonly TaxCountryWire[]> =>
  apiJson('/admin/organisation/tax-countries', (body) => {
    const row = asObject(body, 'tax countries response');
    const taxCountries = row['taxCountries'];
    if (!Array.isArray(taxCountries)) {
      throw new TypeError('tax countries response has no taxCountries array');
    }
    return taxCountries.map(decodeTaxCountry);
  });

export const listTaxCountryChanges = (code: string): Promise<readonly TaxCountryChangeRow[]> =>
  apiJson(`/admin/organisation/tax-countries/${encodeURIComponent(code)}/changes`, (body) => {
    const row = asObject(body, 'tax country changes response');
    const changes = row['changes'];
    if (!Array.isArray(changes)) throw new TypeError('tax country changes response has no changes array');
    return changes.map(decodeTaxCountryChange);
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

export const patchTaxCountry = (
  code: string,
  request: TaxCountryPatchRequest,
): Promise<TaxCountryWire> =>
  apiJson(
    `/admin/organisation/tax-countries/${encodeURIComponent(code)}`,
    decodeTaxCountry,
    withBody('PATCH', request),
  );

/** Withdraws or restores a destination — never a delete; `tax_countries_block_delete` refuses one. */
export const setTaxCountryAvailability = (code: string, isActive: boolean): Promise<TaxCountryWire> =>
  apiJson(
    `/admin/organisation/tax-countries/${encodeURIComponent(code)}/availability`,
    decodeTaxCountry,
    withBody('PUT', { isActive } satisfies TaxCountryAvailabilityRequest),
  );
