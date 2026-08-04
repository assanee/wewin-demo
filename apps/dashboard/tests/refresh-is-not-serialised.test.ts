import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getAccessToken, setAccessToken } from '@/lib/api/access-token';
import { apiFetch, refreshAccessToken } from '@/lib/api/client';

/**
 * The one property in this app that a well-meaning refactor would delete.
 *
 * apps/api's fix for plan 6(c) makes refresh-token rotation a single atomic statement with a
 * ~15 second grace window, so that several requests whose tokens expired in the same
 * millisecond each get a successor rather than one of them being mistaken for a replay. The
 * dashboard's client therefore refreshes *per call* — no mutex, no shared in-flight promise.
 *
 * A client that dedupes would still work. That is exactly the problem: the race would stop
 * happening, the grace window would stop being exercised, and the day it regresses on the
 * server — a migration that drops the clause, an `AUTH_REFRESH_GRACE_SECONDS=0` in an
 * environment file — nothing would notice.
 *
 * So the absence of deduplication is asserted here, out loud, and adding one turns this
 * green test red with a message that says why.
 */

interface Call {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
}

function recordCall(input: RequestInfo | URL, init: RequestInit | undefined): Call {
  const headers = new Headers(init?.headers);
  return {
    url: typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
    method: init?.method ?? 'GET',
    authorization: headers.get('Authorization'),
  };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const refreshBody = (value: string) => ({
  accessToken: value,
  accessTokenExpiresAt: new Date(Date.now() + 600_000).toISOString(),
});

describe('the refresh client', () => {
  let calls: Call[];

  beforeEach(() => {
    calls = [];
    setAccessToken({ value: 'expired', expiresAt: new Date(Date.now() - 1_000) });
  });

  afterEach(() => {
    setAccessToken(null);
    vi.unstubAllGlobals();
  });

  it('refreshes once per concurrent 401 rather than funnelling them through one promise', async () => {
    const PANELS = 6;
    let issued = 0;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const call = recordCall(input, init);
        calls.push(call);

        if (call.url.endsWith('/auth/refresh')) {
          issued += 1;
          /*
           * A tick of latency, so that all six are genuinely in flight at once. Without it
           * the first `await` resolves before the second call is made and a serialising
           * client would pass this test by accident.
           */
          await new Promise((resolve) => setTimeout(resolve, 5));
          return json(refreshBody(`successor-${String(issued)}`));
        }

        // Every panel's first attempt carries the expired token and is refused.
        return call.authorization === 'Bearer expired'
          ? json({ error: { code: 'UNAUTHENTICATED', message: 'no' } }, 401)
          : json({ ok: true });
      }),
    );

    const responses = await Promise.all(
      Array.from({ length: PANELS }, (_unused, index) => apiFetch(`/panel/${String(index)}`)),
    );

    expect(responses.every((response) => response.ok)).toBe(true);

    const refreshes = calls.filter((call) => call.url.endsWith('/auth/refresh'));
    expect(
      refreshes.length,
      'Six concurrent 401s must produce six refreshes. If this is 1, something has ' +
        'introduced single-flight deduplication — see src/lib/api/client.ts for why the ' +
        'grace window in apps/api stops being exercised the moment that happens.',
    ).toBe(PANELS);
    expect(refreshes.every((call) => call.method === 'POST')).toBe(true);
  });

  it('retries a 401 exactly once, so a server that keeps refusing does not become a loop', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        calls.push(recordCall(input, init));
        if (String(input).endsWith('/auth/refresh')) return json(refreshBody('fresh'));
        return json({ error: { code: 'UNAUTHENTICATED', message: 'still no' } }, 401);
      }),
    );

    const response = await apiFetch('/anything');

    expect(response.status).toBe(401);
    expect(calls.filter((call) => call.url.endsWith('/auth/refresh'))).toHaveLength(1);
    expect(calls.filter((call) => call.url.endsWith('/anything'))).toHaveLength(2);
  });

  it('sends no Authorization header and does not retry for an anonymous call', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        calls.push(recordCall(input, init));
        return json({ error: { code: 'UNAUTHENTICATED', message: 'no' } }, 401);
      }),
    );

    await apiFetch('/auth/oauth/providers', { anonymous: true });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.authorization).toBeNull();
  });

  it('every request carries credentials, or the refresh cookie never arrives', async () => {
    let credentials: RequestCredentials | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        credentials = init?.credentials;
        return json({ ok: true });
      }),
    );

    setAccessToken({ value: 'fresh', expiresAt: new Date(Date.now() + 600_000) });
    await apiFetch('/me');

    expect(credentials).toBe('include');
  });

  it('drops the stored token when the API refuses a refresh, so the next call does not repeat it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (): Promise<Response> => json({ error: { code: 'UNAUTHENTICATED', message: 'no' } }, 401)),
    );

    expect(await refreshAccessToken()).toBeNull();
    expect(getAccessToken()).toBeNull();
  });

  it('keeps the token when the network fails, because a dropped wifi is not a sign-out', async () => {
    const held = { value: 'held', expiresAt: new Date(Date.now() + 600_000) };
    setAccessToken(held);

    vi.stubGlobal(
      'fetch',
      vi.fn(async (): Promise<Response> => {
        throw new TypeError('Failed to fetch');
      }),
    );

    expect(await refreshAccessToken()).toBeNull();
    expect(getAccessToken()).toBe(held);
  });
});
