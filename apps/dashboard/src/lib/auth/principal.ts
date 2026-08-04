import { apiJson } from '@/lib/api/client';

/**
 * `GET /me` — what the caller is, and what the caller may do.
 *
 * apps/api/src/rbac/principal.controller.ts is unusually clear about what this endpoint is
 * not: "it is not a security boundary at all — a client that ignores it and calls a
 * protected endpoint anyway gets the same 403 as a client that never asked". It exists so
 * the dashboard does not keep a second copy of the permission model. This module is the
 * client half of exactly that sentence.
 *
 * It is anonymous on the server, which is why `kind` matters here rather than the HTTP
 * status: a browser with no session gets a perfectly successful 200 describing a `public`
 * or `guest` principal with an empty permission list. "Not signed in" is a field, not an
 * error.
 */

export const PRINCIPAL_KINDS = ['user', 'guest', 'public', 'system'] as const;

export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];

export interface Principal {
  readonly kind: PrincipalKind;
  readonly userId: string | null;
  readonly guestId: string | null;
  readonly groupIds: readonly string[];
  /** Sorted by the API, so two responses can be compared without sorting them first. */
  readonly permissions: readonly string[];
}

/**
 * Narrowed rather than cast — see the note on `apiJson`.
 *
 * `permissions` stays `string[]` and is not filtered against `PERMISSION_CODES`. A build of
 * the API that is one release ahead of this bundle will send codes this file has never heard
 * of, and dropping them would be this client editing the server's answer. Nothing here needs
 * to understand a code to hold it.
 */
export function decodePrincipal(body: unknown): Principal {
  if (typeof body !== 'object' || body === null) {
    throw new Error('principal: expected an object');
  }
  const source = body as Record<string, unknown>;

  const kind = source['kind'];
  if (typeof kind !== 'string' || !(PRINCIPAL_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`principal: unknown kind ${JSON.stringify(kind)}`);
  }

  return {
    kind: kind as PrincipalKind,
    userId: nullableString(source['userId'], 'userId'),
    guestId: nullableString(source['guestId'], 'guestId'),
    groupIds: stringArray(source['groupIds'], 'groupIds'),
    permissions: stringArray(source['permissions'], 'permissions'),
  };
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null || typeof value === 'string') return value;
  throw new Error(`principal: ${field} must be a string or null`);
}

function stringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry: unknown) => typeof entry !== 'string')) {
    throw new Error(`principal: ${field} must be an array of strings`);
  }
  return value as readonly string[];
}

export async function fetchPrincipal(): Promise<Principal> {
  return apiJson('/me', decodePrincipal, { cache: 'no-store' });
}

/** A signed-in operator, as opposed to a visitor the API is happy to describe anonymously. */
export function isSignedIn(principal: Principal): boolean {
  return principal.kind === 'user';
}
