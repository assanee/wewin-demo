import 'client-only';

import { apiFetch, apiJson } from '@/lib/api/client';
import { apiErrorFromResponse } from '@/lib/api/errors';

/**
 * A person's own account.
 *
 * Shapes restated from `apps/api/src/account/account.contract.ts` — `turbo boundaries` stops
 * the dashboard importing from apps/api. Same debt as `media-api.ts` and `user-api.ts`,
 * recorded in plan 12.1.
 */

export interface LinkedProvider {
  readonly provider: string;
  readonly assertedEmail: string | null;
  readonly assertedEmailVerified: boolean;
  readonly lastAuthenticatedAt: string | null;
}

export interface MySession {
  readonly id: string;
  readonly userAgent: string | null;
  readonly createdAt: string;
  readonly lastSeenAt: string | null;
  readonly current: boolean;
}

export interface Account {
  readonly userId: string;
  readonly displayName: string | null;
  readonly emails: readonly { readonly address: string; readonly isPrimary: boolean }[];
  readonly hasPassword: boolean;
  readonly providers: readonly LinkedProvider[];
  readonly sessions: readonly MySession[];
  /**
   * How many ways this account still has of signing in.
   *
   * Read from the API rather than counted here. The rule has one definition — a password
   * with no verified address is *not* a way in, because the reset link has nowhere to go —
   * and a second copy in the browser would disagree in exactly the case it exists for.
   */
  readonly waysIn: number;
}

const asArray = (value: unknown, what: string): readonly unknown[] => {
  if (!Array.isArray(value)) throw new TypeError(`${what}: expected an array`);
  return value;
};

export const getAccount = (): Promise<Account> =>
  apiJson('/me/account', (body) => {
    const row = body as Record<string, unknown>;
    if (typeof row['userId'] !== 'string') throw new TypeError('account: no userId');
    return {
      userId: row['userId'],
      displayName: (row['displayName'] as string | null) ?? null,
      emails: asArray(row['emails'] ?? [], 'emails') as Account['emails'],
      hasPassword: row['hasPassword'] === true,
      providers: asArray(row['providers'] ?? [], 'providers') as LinkedProvider[],
      sessions: asArray(row['sessions'] ?? [], 'sessions') as MySession[],
      waysIn: Number(row['waysIn'] ?? 0),
    };
  });

export const changeMyPassword = (input: {
  readonly currentPassword?: string;
  readonly newPassword: string;
}): Promise<{ readonly otherSessionsEnded: number }> =>
  apiJson('/me/account/password', (body) => body as { otherSessionsEnded: number }, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

const del = async (path: string): Promise<void> => {
  const response = await apiFetch(path, { method: 'DELETE' });
  if (!response.ok) throw await apiErrorFromResponse(response);
};

export const unlinkProvider = (provider: string): Promise<void> =>
  del(`/me/account/providers/${encodeURIComponent(provider)}`);

export const revokeMySession = (sessionId: string): Promise<void> =>
  del(`/me/account/sessions/${encodeURIComponent(sessionId)}`);

export const revokeMyOtherSessions = (): Promise<{ readonly revoked: number }> =>
  apiJson('/me/account/sessions/revocation', (body) => body as { revoked: number }, {
    method: 'POST',
  });
