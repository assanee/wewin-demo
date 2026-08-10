import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  fetchContactPrefill,
  fieldsToApply,
  newestSubmittedOrder,
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

describe('⭐ the newest order is the one most recently submitted, not most recently touched', () => {
  /*
   * `GET /orders` sorts `updatedAt desc`, and `moveStatus()` bumps `updatedAt` on any later
   * staff status change without touching the frozen contact columns. So the list's own order
   * is not a safe proxy for "which contact is newest" — these fix that at the position that
   * matters, before a network is ever involved.
   */

  it('picks the greatest `submittedAt`, even when it is not the first row', () => {
    // The exact shape a stale-touch bug produces: the *older* submission sits first because
    // staff touched it since, and the *newer* submission — the one with the corrected
    // contact — sits second.
    const list = [
      { id: 'order-old-touched', submittedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'order-new-submitted', submittedAt: '2026-06-01T00:00:00.000Z' },
    ];

    expect(newestSubmittedOrder(list)?.id).toBe('order-new-submitted');
  });

  it('is order-independent — the same answer however the rows are arranged', () => {
    const newer = { id: 'newer', submittedAt: '2026-06-01T00:00:00.000Z' };
    const older = { id: 'older', submittedAt: '2026-01-01T00:00:00.000Z' };

    expect(newestSubmittedOrder([newer, older])?.id).toBe('newer');
    expect(newestSubmittedOrder([older, newer])?.id).toBe('newer');
  });

  it('skips drafts entirely, whatever position they sit in', () => {
    const list = [
      { id: 'draft', submittedAt: null },
      { id: 'submitted', submittedAt: '2026-01-01T00:00:00.000Z' },
    ];

    expect(newestSubmittedOrder(list)?.id).toBe('submitted');
  });

  it('is null when nothing has been submitted, or the list itself is null', () => {
    expect(newestSubmittedOrder([{ id: 'draft', submittedAt: null }])).toBeNull();
    expect(newestSubmittedOrder([])).toBeNull();
    expect(newestSubmittedOrder(null)).toBeNull();
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

  it('⭐ prefers the more recently submitted order over the more recently touched one', async () => {
    // The reviewer's scenario, over the network: a customer submits order A, then submits
    // order B with a corrected phone. Staff later move A to a new status, which bumps its
    // `updatedAt` and puts it first in `GET /orders` — but never touches its frozen contact.
    // The pre-fill must still come from B, the one the customer told us about more recently.
    const fetchSpy = vi.fn(async (url: string) => {
      if (url.endsWith('/orders?limit=50')) {
        return jsonResponse({
          orders: [
            // First in the list — touched most recently by staff, submitted longest ago.
            { id: 'order-a-old-number', submittedAt: '2026-01-01T00:00:00.000Z' },
            // Second in the list — submitted more recently, with the corrected number.
            { id: 'order-b-new-number', submittedAt: '2026-06-01T00:00:00.000Z' },
          ],
        });
      }
      if (url.endsWith('/orders/order-b-new-number')) {
        return jsonResponse({
          contact: { name: 'สมหญิง ใจดี', phone: '+66822222222', email: null, locale: 'th' },
        });
      }
      throw new Error(`unexpected url: ${url}`);
    });
    vi.stubGlobal('fetch', fetchSpy);

    const prefill = await fetchContactPrefill('token-abc');

    expect(prefill).toEqual({ name: 'สมหญิง ใจดี', phone: '+66822222222', email: '' });
    // Never even opened the older, list-first order's detail.
    expect(fetchSpy).not.toHaveBeenCalledWith(expect.stringContaining('order-a-old-number'), expect.anything());
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
