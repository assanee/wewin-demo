import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorefrontRevalidateService } from '../../src/admin/storefront-revalidate';

/**
 * ⛔ What this protects is a publish, not a cache.
 *
 * The storefront being unreachable must never turn a committed publish into an error. The
 * version is frozen and the customer-facing document is correct before this service runs; a
 * throw here would lose the work and report a failure that did not happen. Every test below
 * is a way the storefront can misbehave, and the assertion is always the same: no throw.
 */

const ORIGINAL = { url: process.env['STOREFRONT_REVALIDATE_URL'], token: process.env['REVALIDATE_TOKEN'] };

describe('telling the storefront a product changed', () => {
  let service: StorefrontRevalidateService;

  beforeEach(() => {
    service = new StorefrontRevalidateService();
    process.env['STOREFRONT_REVALIDATE_URL'] = 'http://storefront.test/api/revalidate';
    process.env['REVALIDATE_TOKEN'] = 'a-test-token';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (ORIGINAL.url === undefined) delete process.env['STOREFRONT_REVALIDATE_URL'];
    else process.env['STOREFRONT_REVALIDATE_URL'] = ORIGINAL.url;
    if (ORIGINAL.token === undefined) delete process.env['REVALIDATE_TOKEN'];
    else process.env['REVALIDATE_TOKEN'] = ORIGINAL.token;
  });

  it('⭐ sends the id AND the slug, because the two halves of a page are keyed differently', async () => {
    /*
     * Reviews and the gallery are cached by product id; the product page's own fetch is
     * cached by slug, because a `fetch` declares its tags before the body carrying the id
     * exists. Sending one without the other refreshes half a page, which is worse than
     * refreshing none of it — it looks like it worked.
     */
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await service.productChanged('lvr-hang-single', 'lvr-hang-single-slug');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://storefront.test/api/revalidate');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toStrictEqual({
      productIds: ['lvr-hang-single'],
      slugs: ['lvr-hang-single-slug'],
    });
  });

  it('presents the shared token header, spelled the way the storefront reads it', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await service.productChanged('p', 's');

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['x-wewin-revalidate-token']).toBe('a-test-token');
  });

  it('⛔ a refusal does not throw — a stale cache is not a failed publish', async () => {
    for (const status of [403, 503, 500]) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status })));
      await expect(service.productChanged('p', 's')).resolves.toBeUndefined();
    }
  });

  it('⛔ an unreachable storefront does not throw', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    await expect(service.productChanged('p', 's')).resolves.toBeUndefined();
  });

  it('⛔ a timeout does not throw', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('The operation was aborted', 'TimeoutError');
      }),
    );
    await expect(service.productChanged('p', 's')).resolves.toBeUndefined();
  });

  it('⚠️ unconfigured is silence, not a call and not an error', async () => {
    /*
     * Every test run, every laptop and the CI database have no storefront to tell. It must
     * be a no-op there, or the whole suite is telling a machine that does not exist.
     */
    delete process.env['STOREFRONT_REVALIDATE_URL'];
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(service.productChanged('p', 's')).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('⚠️ a URL without a token is also unconfigured — it does not call with no credential', async () => {
    delete process.env['REVALIDATE_TOKEN'];
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await service.productChanged('p', 's');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
