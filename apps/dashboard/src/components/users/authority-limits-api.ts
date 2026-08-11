import 'client-only';

import { apiJson } from '@/lib/api/client';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The ceilings themselves — `GET/PUT/DELETE /quotes/authority/limits`.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ### Why the shapes are narrowed here rather than imported
 *
 * The same reason `components/quotes/authority-api.ts` gives, verbatim: these types live in
 * `apps/api/src/quotes/authority/authority.contract.ts`, whose header says they move into
 * `@wewin/contract` when somebody needs them in two places and that *"the move is a copy"*.
 * Reaching into `apps/api` from an app is what `turbo boundaries` exists to stop becoming
 * normal, and `zod` is not a dependency of `@wewin/dashboard` — so the decoders are
 * hand-written narrowers that throw with the field name, exactly as `organisation-api.ts` does.
 *
 * **When these land in `@wewin/contract`, delete every decoder below and import the schemas.**
 *
 * ### ⚠️ Money is a bare digit string on these endpoints
 *
 * `@wewin/contract` sends `{"unit":"THB.satang","digits":"879100"}` precisely so satang cannot
 * be mistaken for baht. This module's endpoints send `"879100"` — the API's own header defends
 * that as "the client widens as it chooses". It is a weaker guarantee than the rest of the
 * system gives and it is reported rather than smoothed over. `minorOf` is the one place it is
 * widened and it refuses anything that is not canonical digits, so a malformed amount is a
 * decode failure and never a `NaN` in a ceiling.
 *
 * ### ⚠️ Withdrawn ceilings arrive in this list, and that is deliberate
 *
 * `DELETE` on this resource sets `revokedAt` — `authority_limits_block_delete` refuses a real
 * delete at the database, because the row records *who granted this role its authority*. The
 * list therefore carries revoked rows, `AuthorityLimitsPanel` dims them rather than hiding
 * them, and `isFailClosed` means **no live ceiling** rather than no rows.
 */

export const APPROVAL_DIMENSIONS_WIRE = ['margin', 'cashflow'] as const;
export type AuthorityDimension = (typeof APPROVAL_DIMENSIONS_WIRE)[number];

export interface AuthorityLimitView {
  readonly groupId: string;
  readonly groupCode: string;
  readonly groupNameTh: string;
  readonly dimension: AuthorityDimension;
  readonly maxConcessionThbMinor: bigint;
  readonly grantedByUserId: string;
  readonly updatedAt: string;
  readonly noteTh: string | null;
  /** `null` is live. An instant is a ceiling that has been withdrawn and grants nothing. */
  readonly revokedAt: string | null;
  readonly revokedByUserId: string | null;
}

export interface AuthorityLimitList {
  readonly limits: readonly AuthorityLimitView[];
  /** True when no **live** ceiling exists anywhere: nobody may concede, nobody may approve. */
  readonly isFailClosed: boolean;
}

/** What one history entry snapshots. Mirrors `AuthorityService.snapshot` field for field. */
export interface AuthorityLimitSnapshot {
  readonly maxConcessionThbMinor: bigint;
  readonly noteTh: string | null;
  readonly isRevoked: boolean;
}

export interface AuthorityLimitChangeView {
  readonly id: string;
  readonly groupId: string;
  readonly groupCode: string;
  readonly dimension: AuthorityDimension;
  readonly changedByUserId: string;
  readonly changedAt: string;
  /** `null` on the first grant and on nothing else — that is what marks a creation. */
  readonly before: AuthorityLimitSnapshot | null;
  readonly after: AuthorityLimitSnapshot;
}

/* ------------------------------------------------------------------ *
 * Narrowers — throw with the field name so `apiJson` turns it into MALFORMED
 * ------------------------------------------------------------------ */

const DIGITS = /^(?:0|[1-9][0-9]*)$/u;

function asObject(input: unknown, what: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError(`${what} is not an object`);
  }
  return input as Record<string, unknown>;
}

function str(row: Record<string, unknown>, key: string, what: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new TypeError(`${what}.${key} is not a string`);
  return value;
}

function nullableStr(row: Record<string, unknown>, key: string, what: string): string | null {
  return row[key] === null || row[key] === undefined ? null : str(row, key, what);
}

function bool(row: Record<string, unknown>, key: string, what: string): boolean {
  const value = row[key];
  if (typeof value !== 'boolean') throw new TypeError(`${what}.${key} is not a boolean`);
  return value;
}

/**
 * A satang figure, widened to `bigint`.
 *
 * ⚠️ Never `Number`. A ceiling is compared against a concession and both can exceed 2^53 in
 * satang; `JSON.parse` on a large integer is also where a satang goes missing silently, which
 * is why the wire sends digits in the first place. The regex refuses `'1e3'`, `''` and `' 5'`,
 * all three of which `BigInt`/`Number` would otherwise accept or coerce.
 */
function minorOf(row: Record<string, unknown>, key: string, what: string): bigint {
  const value = row[key];
  if (typeof value !== 'string' || !DIGITS.test(value)) {
    throw new TypeError(`${what}.${key} is not an amount in THB minor units`);
  }
  return BigInt(value);
}

function dimensionOf(row: Record<string, unknown>, key: string, what: string): AuthorityDimension {
  const value = str(row, key, what);
  if (value !== 'margin' && value !== 'cashflow') {
    throw new TypeError(`${what}.${key} is not an approval dimension`);
  }
  return value;
}

export function decodeAuthorityLimit(input: unknown): AuthorityLimitView {
  const row = asObject(input, 'authority limit');
  const groupCode = str(row, 'groupCode', 'authority limit');
  const what = `authority limit "${groupCode}"`;

  return {
    groupId: str(row, 'groupId', what),
    groupCode,
    groupNameTh: str(row, 'groupNameTh', what),
    dimension: dimensionOf(row, 'dimension', what),
    maxConcessionThbMinor: minorOf(row, 'maxConcessionThbMinor', what),
    grantedByUserId: str(row, 'grantedByUserId', what),
    updatedAt: str(row, 'updatedAt', what),
    noteTh: nullableStr(row, 'noteTh', what),
    revokedAt: nullableStr(row, 'revokedAt', what),
    revokedByUserId: nullableStr(row, 'revokedByUserId', what),
  };
}

export function decodeAuthorityLimitList(input: unknown): AuthorityLimitList {
  const row = asObject(input, 'authority limits response');
  const limits = row['limits'];
  if (!Array.isArray(limits)) {
    throw new TypeError('authority limits response has no limits array');
  }

  return {
    limits: limits.map(decodeAuthorityLimit),
    isFailClosed: bool(row, 'isFailClosed', 'authority limits response'),
  };
}

function decodeSnapshot(input: unknown, what: string): AuthorityLimitSnapshot {
  const row = asObject(input, what);
  return {
    maxConcessionThbMinor: minorOf(row, 'maxConcessionThbMinor', what),
    noteTh: nullableStr(row, 'noteTh', what),
    isRevoked: bool(row, 'isRevoked', what),
  };
}

export function decodeAuthorityLimitChange(input: unknown): AuthorityLimitChangeView {
  const row = asObject(input, 'authority limit change');
  const id = str(row, 'id', 'authority limit change');
  const what = `authority limit change ${id}`;

  return {
    id,
    groupId: str(row, 'groupId', what),
    groupCode: str(row, 'groupCode', what),
    dimension: dimensionOf(row, 'dimension', what),
    changedByUserId: str(row, 'changedByUserId', what),
    changedAt: str(row, 'changedAt', what),
    before:
      row['before'] === null || row['before'] === undefined
        ? null
        : decodeSnapshot(row['before'], `${what}.before`),
    after: decodeSnapshot(row['after'], `${what}.after`),
  };
}

/* ------------------------------------------------------------------ *
 * The calls
 * ------------------------------------------------------------------ */

const withBody = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const listAuthorityLimits = (): Promise<AuthorityLimitList> =>
  apiJson('/quotes/authority/limits', decodeAuthorityLimitList);

export interface SetAuthorityLimitRequest {
  readonly groupId: string;
  readonly dimension: AuthorityDimension;
  /** Digits, minor units. `'0'` is legal and is not the same as having no ceiling at all. */
  readonly maxConcessionThbMinor: string;
  readonly noteTh?: string;
}

export const setAuthorityLimit = (request: SetAuthorityLimitRequest): Promise<AuthorityLimitList> =>
  apiJson('/quotes/authority/limits', decodeAuthorityLimitList, withBody('PUT', request));

/**
 * Withdraw a ceiling.
 *
 * ⚠️ `DELETE` on the wire, a flag in the database. The response still contains the row, with
 * `revokedAt` set — a caller that removed it from its own list on a 200 would disagree with the
 * server about what just happened.
 */
export const withdrawAuthorityLimit = (
  groupId: string,
  dimension: AuthorityDimension,
): Promise<AuthorityLimitList> =>
  apiJson(
    `/quotes/authority/limits/${encodeURIComponent(groupId)}/${encodeURIComponent(dimension)}`,
    decodeAuthorityLimitList,
    { method: 'DELETE' },
  );

export const listAuthorityLimitChanges = (
  groupId: string,
  dimension: AuthorityDimension,
): Promise<readonly AuthorityLimitChangeView[]> =>
  apiJson(
    `/quotes/authority/limits/${encodeURIComponent(groupId)}/${encodeURIComponent(dimension)}/changes`,
    (body) => {
      const row = asObject(body, 'authority limit changes response');
      const changes = row['changes'];
      if (!Array.isArray(changes)) {
        throw new TypeError('authority limit changes response has no changes array');
      }
      return changes.map(decodeAuthorityLimitChange);
    },
  );
