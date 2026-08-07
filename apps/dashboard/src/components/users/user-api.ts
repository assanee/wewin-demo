import 'client-only';

import { apiFetch, apiJson } from '@/lib/api/client';
import { apiErrorFromResponse } from '@/lib/api/errors';

/**
 * Every call the user-administration screen makes.
 *
 * ⚠️ The shapes are restated from `apps/api/src/users/users.contract.ts` — `turbo boundaries`
 * stops the dashboard importing from apps/api, and rightly. Same debt as `media-api.ts`, same
 * mitigation: the decoders check at runtime, so a rename becomes a message naming the path
 * rather than `undefined` three components deep. Recorded in plan 12.1.
 */

export type UserStatus = 'active' | 'suspended' | 'closed' | 'erased';

export interface UserGroup {
  readonly id: string;
  readonly code: string;
  readonly nameTh: string;
  readonly isSystem: boolean;
}

export interface UserSummary {
  readonly id: string;
  readonly displayName: string | null;
  readonly status: UserStatus;
  /** Verified addresses only — an unverified row is a claim, not an identity. */
  readonly emails: readonly string[];
  readonly groups: readonly UserGroup[];
  readonly permissions: readonly string[];
  readonly liveSessions: number;
  readonly suspendedAt: string | null;
  readonly createdAt: string;
}

export interface Group extends UserGroup {
  readonly permissions: readonly string[];
  readonly memberCount: number;
}

const asArray = (value: unknown, what: string): readonly unknown[] => {
  if (!Array.isArray(value)) throw new TypeError(`${what}: expected an array`);
  return value;
};

const decodeGroupRef = (raw: unknown): UserGroup => {
  const row = raw as Record<string, unknown>;
  if (typeof row['id'] !== 'string') throw new TypeError('group: no id');
  return {
    id: row['id'],
    code: String(row['code'] ?? ''),
    nameTh: String(row['nameTh'] ?? ''),
    isSystem: row['isSystem'] === true,
  };
};

function decodeUser(raw: unknown): UserSummary {
  const row = raw as Record<string, unknown>;
  if (typeof row['id'] !== 'string') throw new TypeError('user: no id');

  return {
    id: row['id'],
    displayName: (row['displayName'] as string | null) ?? null,
    status: row['status'] as UserStatus,
    emails: asArray(row['emails'] ?? [], 'emails').map(String),
    groups: asArray(row['groups'] ?? [], 'groups').map(decodeGroupRef),
    permissions: asArray(row['permissions'] ?? [], 'permissions').map(String),
    liveSessions: Number(row['liveSessions'] ?? 0),
    suspendedAt: (row['suspendedAt'] as string | null) ?? null,
    createdAt: String(row['createdAt'] ?? ''),
  };
}

export const listUsers = (): Promise<readonly UserSummary[]> =>
  apiJson('/admin/users', (body) =>
    asArray((body as Record<string, unknown>)['users'] ?? [], 'users').map(decodeUser),
  );

export const listGroups = (): Promise<{
  readonly groups: readonly Group[];
  readonly available: readonly string[];
}> =>
  apiJson('/admin/groups', (body) => {
    const row = body as Record<string, unknown>;
    return {
      groups: asArray(row['groups'] ?? [], 'groups').map((raw) => {
        const group = raw as Record<string, unknown>;
        return {
          ...decodeGroupRef(group),
          permissions: asArray(group['permissions'] ?? [], 'permissions').map(String),
          memberCount: Number(group['memberCount'] ?? 0),
        };
      }),
      available: asArray(row['available'] ?? [], 'available').map(String),
    };
  });

const send = async (path: string, method: string, body?: unknown): Promise<Response> => {
  const response = await apiFetch(path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (!response.ok) throw await apiErrorFromResponse(response);
  return response;
};

const userPath = (userId: string): string => `/admin/users/${encodeURIComponent(userId)}`;
const groupPath = (groupId: string): string => `/admin/groups/${encodeURIComponent(groupId)}`;

export const createUser = (input: {
  readonly email: string;
  readonly displayName: string;
  readonly groupIds: readonly string[];
}): Promise<{ readonly userId: string; readonly invitationSent: boolean }> =>
  apiJson('/admin/users', (body) => body as { userId: string; invitationSent: boolean }, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

/** Ban. The reason is required by the API and is not optional here either. */
export const suspendUser = (userId: string, reasonTh: string): Promise<unknown> =>
  send(`${userPath(userId)}/suspension`, 'POST', { reasonTh });

export const reinstateUser = (userId: string): Promise<unknown> =>
  send(`${userPath(userId)}/suspension`, 'DELETE');

export const setUserGroups = (userId: string, groupIds: readonly string[]): Promise<unknown> =>
  send(`${userPath(userId)}/groups`, 'PUT', { groupIds });

/** The lost-laptop action: ends every session and leaves the account able to work. */
export const revokeSessions = (userId: string): Promise<{ readonly revoked: number }> =>
  apiJson(`${userPath(userId)}/sessions/revocation`, (body) => body as { revoked: number }, {
    method: 'POST',
  });

export const sendPasswordLink = (userId: string): Promise<{ readonly sent: boolean }> =>
  apiJson(`${userPath(userId)}/password-link`, (body) => body as { sent: boolean }, {
    method: 'POST',
  });

export const createGroup = (input: {
  readonly code: string;
  readonly nameTh: string;
  readonly permissions: readonly string[];
}): Promise<unknown> => send('/admin/groups', 'POST', input);

export const renameGroup = (groupId: string, nameTh: string): Promise<unknown> =>
  send(groupPath(groupId), 'PATCH', { nameTh });

export const deleteGroup = (groupId: string): Promise<unknown> => send(groupPath(groupId), 'DELETE');

export const setGroupPermissions = (
  groupId: string,
  permissions: readonly string[],
): Promise<unknown> => send(`${groupPath(groupId)}/permissions`, 'PUT', { permissions });
