import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  fetchContactPrefill,
  fieldsToApply,
  resolveContactPrefill,
} from '../src/lib/quote/prefillContact';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ PINNING THE BEHAVIOUR, NOT THE PLUMBING.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `RequestQuotationForm` wires this module up to two real endpoints and a `useRef`, and none
 * of that is worth asserting against directly — a mocked `fetch` returning the right JSON is
 * plumbing, and a passing plumbing test would still let the two rules that matter regress
 * silently: whose contact wins, and whose typing survives.
 *
 * So the two decisions live in pure functions (`resolveContactPrefill`, `fieldsToApply`) and
 * are tested here with no network at all — and only the last describe block, where a failure
 * has to become "nothing", touches a mocked `fetch`.
 */

describe('⭐ the last order wins over the account', () => {
  it('uses the order’s contact when both a prior order and an account exist', () => {
    const result = resolveContactPrefill(
      { name: 'สมหญิง ใจดี', phone: '+66811111111', email: 'somying@example.test' },
      { phone: '+66899999999', email: 'account-fallback@example.test' },
    );

    expect(result).toEqual({
      name: 'สมหญิง ใจดี',
      phone: '+66811111111',
      email: 'somying@example.test',
    });
  });

  it('does not top up a channel the order itself left blank, from the account', () => {
    // ⚠️ Either/or, not a merge — see the module note on why a channel the order left
    // blank stays blank rather than being patched from the fallback.
    const result = resolveContactPrefill(
      { name: 'สมหญิง ใจดี', phone: null, email: 'somying@example.test' },
      { phone: '+66899999999', email: 'account-fallback@example.test' },
    );

    expect(result.phone).toBe('');
    expect(result.email).toBe('somying@example.test');
  });

  it('falls back to the account when there is no prior order at all', () => {
    const result = resolveContactPrefill(null, {
      phone: '+66899999999',
      email: 'account@example.test',
    });

    expect(result).toEqual({ name: '', phone: '+66899999999', email: 'account@example.test' });
  });

  it('⚠️ never invents a name from the account — only a prior order gives one', () => {
    // Phone-only registration never sets a display name, and this module must not reach for
    // one even where an account has other contact details to offer.
    const result = resolveContactPrefill(null, { phone: '+66899999999', email: null });
    expect(result.name).toBe('');
  });

  it('is empty when neither source has anything', () => {
    expect(resolveContactPrefill(null, null)).toEqual({ name: '', phone: '', email: '' });
  });
});

describe('⭐ a field the customer has already typed into is never overwritten', () => {
  const prefill = { name: 'สมหญิง ใจดี', phone: '+66811111111', email: 'somying@example.test' };

  it('omits every touched field from what should be applied', () => {
    const toApply = fieldsToApply({ name: true, phone: false, email: false }, prefill);

    expect(toApply).not.toHaveProperty('name');
    expect(toApply).toEqual({ phone: '+66811111111', email: 'somying@example.test' });
  });

  it('applies nothing at all once every field has been touched', () => {
    expect(fieldsToApply({ name: true, phone: true, email: true }, prefill)).toEqual({});
  });

  it('applies every field when nothing has been touched yet', () => {
    expect(fieldsToApply({ name: false, phone: false, email: false }, prefill)).toEqual(prefill);
  });

  it('never applies an empty answer over an untouched field either', () => {
    // Untouched does not mean "anything goes" — a source with nothing to say for a field
    // must not blank out whatever placeholder or prior value is already showing.
    const toApply = fieldsToApply(
      { name: false, phone: false, email: false },
      { name: '', phone: '+66811111111', email: '' },
    );

    expect(toApply).toEqual({ phone: '+66811111111' });
  });
});

/* ------------------------------------------------------------------ *
 * The network — where failure has to become nothing, not an error
 * ------------------------------------------------------------------ */

describe('the fetch: degrades to nothing rather than to a throw', () => {
  const originalBase = process.env.NEXT_PUBLIC_API_BASE_URL;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_API_BASE_URL = 'https://api.example';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalBase === undefined) delete process.env.NEXT_PUBLIC_API_BASE_URL;
    else process.env.NEXT_PUBLIC_API_BASE_URL = originalBase;
  });

  const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('reads the newest submitted order’s contact, skipping an untouched draft above it', async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      if (url.endsWith('/orders?limit=50')) {
        return jsonResponse({
          orders: [
            { id: 'draft-1', submittedAt: null },
            { id: 'order-2', submittedAt: '2026-08-01T00:00:00.000Z' },
          ],
        });
      }
      if (url.endsWith('/orders/order-2')) {
        return jsonResponse({
          contact: { name: 'สมหญิง ใจดี', phone: '+66811111111', email: 'somying@example.test', locale: 'th' },
        });
      }
      throw new Error(`unexpected url: ${url}`);
    });
    vi.stubGlobal('fetch', fetchSpy);

    const prefill = await fetchContactPrefill('token-abc');

    expect(prefill).toEqual({ name: 'สมหญิง ใจดี', phone: '+66811111111', email: 'somying@example.test' });
    // Never opened the draft's detail — there was nothing there worth a third call.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('falls back to the account when the order list has nothing submitted', async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      if (url.endsWith('/orders?limit=50')) {
        return jsonResponse({ orders: [{ id: 'draft-1', submittedAt: null }] });
      }
      if (url.endsWith('/me/account')) {
        return jsonResponse({
          phones: [{ number: '+66899999999', isPrimary: false }],
          emails: [],
        });
      }
      throw new Error(`unexpected url: ${url}`);
    });
    vi.stubGlobal('fetch', fetchSpy);

    expect(await fetchContactPrefill('token-abc')).toEqual({
      name: '',
      phone: '+66899999999',
      email: '',
    });
  });

  it('⚠️ resolves to null on a network failure — never throws, never rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    await expect(fetchContactPrefill('token-abc')).resolves.toBeNull();
  });

  it('resolves to null when the API refuses the request', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 502 })));

    await expect(fetchContactPrefill('token-abc')).resolves.toBeNull();
  });

  it('resolves to null when the body does not parse as JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{not json', { status: 200 })));

    await expect(fetchContactPrefill('token-abc')).resolves.toBeNull();
  });

  it('resolves to null without any network call when no API is configured', async () => {
    delete process.env.NEXT_PUBLIC_API_BASE_URL;
    vi.stubEnv('NODE_ENV', 'production');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    expect(await fetchContactPrefill('token-abc')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.unstubAllEnvs();
  });
});
