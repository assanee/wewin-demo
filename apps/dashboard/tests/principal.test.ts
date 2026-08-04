import { describe, expect, it } from 'vitest';

import { apiErrorFromResponse, networkError } from '@/lib/api/errors';
import { decodePrincipal, isSignedIn } from '@/lib/auth/principal';

/**
 * `/me` is anonymous on the server, so a 200 proves nothing about who is calling — `kind`
 * is the field that decides. These tests exist because that is the single most misreadable
 * thing about the endpoint: a signed-out browser gets a perfectly successful response.
 */
describe('decodePrincipal', () => {
  const user = {
    kind: 'user',
    userId: '4a88d0a0-ab2c-49df-a816-1037542debfa',
    guestId: null,
    groupIds: ['g1'],
    permissions: ['catalog.read'],
  };

  it('accepts a signed-in user', () => {
    expect(isSignedIn(decodePrincipal(user))).toBe(true);
  });

  it('reports a visitor as not signed in even though the call succeeded', () => {
    const guest = decodePrincipal({ ...user, kind: 'guest', userId: null, guestId: 'abc', permissions: [] });

    expect(isSignedIn(guest)).toBe(false);
  });

  it('keeps permission codes it does not recognise instead of filtering the API answer', () => {
    const ahead = decodePrincipal({ ...user, permissions: ['catalog.read', 'invoices.reconcile'] });

    expect(ahead.permissions).toEqual(['catalog.read', 'invoices.reconcile']);
  });

  it.each([
    ['a null body', null],
    ['a kind nobody defined', { ...user, kind: 'root' }],
    ['permissions that are not strings', { ...user, permissions: [1, 2] }],
    ['a userId that is neither string nor null', { ...user, userId: 7 }],
  ])('refuses %s rather than passing it on', (_why, body) => {
    expect(() => decodePrincipal(body)).toThrow();
  });
});

describe('reading an error off the wire', () => {
  it('reads the API envelope when there is one', async () => {
    const response = new Response(
      JSON.stringify({
        error: { code: 'FORBIDDEN', message: 'ไม่มีสิทธิ์', requestId: 'r-1' },
      }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    );

    const error = await apiErrorFromResponse(response);

    expect(error.code).toBe('FORBIDDEN');
    expect(error.requestId).toBe('r-1');
    expect(error.isUnauthenticated).toBe(false);
  });

  it('survives a body that is not our envelope — a load balancer answering with HTML', async () => {
    const response = new Response('<html>502</html>', { status: 502 });

    const error = await apiErrorFromResponse(response);

    expect(error.code).toBe('MALFORMED');
    expect(error.status).toBe(502);
  });

  it('distinguishes "the API said no" from "there was no API" ', () => {
    expect(networkError(new TypeError('Failed to fetch')).status).toBe(0);
    expect(networkError(new TypeError('Failed to fetch')).code).toBe('NETWORK');
  });
});
