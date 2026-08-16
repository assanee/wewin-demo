import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `POST /api/revalidate` — the half of plan 9.5 that makes a cached page change its mind.
 *
 * `next/cache` is mocked because `revalidateTag` needs a Next request context to do
 * anything, and what is under test here is not Next's cache: it is **which tags this route
 * decides to poke, and whether it can be made to poke them by somebody who should not be
 * able to.** Both are decisions this file makes on its own.
 *
 * The single most valuable assertion in here is the boring one — that the tags it pokes are
 * the tags `lib/reviews/api.ts` attaches to its fetch. A mismatch there produces no error
 * anywhere: the endpoint returns 200, the caller believes it invalidated something, and the
 * page never changes for as long as the deployment lives.
 */

// Typed, so `.mock.calls` is `[tag, profile][]` rather than `any[][]`. Worth the generic:
// the assertions below read the *second* element of each call, and on `any[][]` a typo
// there is a comparison against `undefined` that passes for the wrong reason.
const revalidateTag = vi.fn<(tag: string, profile: string) => void>();
vi.mock('next/cache', () => ({ revalidateTag: (tag: string, profile: string) => revalidateTag(tag, profile) }));

const { POST, REVALIDATE_TOKEN_HEADER, MAX_PRODUCT_IDS, productIdsFrom } = await import(
  '@/app/api/revalidate/route'
);
const { catalogTag, tagsForProduct } = await import('@/lib/reviews/tags');

const TOKEN = 'a-token-with-some-length';

const post = (body: unknown, token: string | null = TOKEN): Request =>
  new Request('http://localhost:3002/api/revalidate', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { [REVALIDATE_TOKEN_HEADER]: token }),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('the invalidation endpoint', () => {
  beforeEach(() => {
    revalidateTag.mockClear();
    vi.stubEnv('REVALIDATE_TOKEN', TOKEN);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('refuses everything when the token is not configured', async () => {
    vi.stubEnv('REVALIDATE_TOKEN', '');

    const response = await POST(post({ productIds: ['awn-4t'] }));

    // 503 and not 200: "the deployment forgot the variable" must not be the state in which
    // anybody can make a static site rebuild 648 documents on demand.
    expect(response.status).toBe(503);
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it('refuses a missing or wrong token, and says nothing else', async () => {
    expect((await POST(post({ productIds: ['awn-4t'] }, null))).status).toBe(403);
    expect((await POST(post({ productIds: ['awn-4t'] }, 'wrong'))).status).toBe(403);
    // Same length, one byte different — the case a `startsWith` or an early-exit compare
    // would leak the shape of.
    expect((await POST(post({ productIds: ['awn-4t'] }, `${TOKEN.slice(0, -1)}X`))).status).toBe(403);
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it('pokes exactly the tags the product page reads, in one call each', async () => {
    const response = await POST(post({ productIds: ['awn-4t', 'fold-nt-12'] }));

    expect(response.status).toBe(200);
    expect(revalidateTag.mock.calls.map(([tag]) => tag)).toEqual([
      ...tagsForProduct('awn-4t'),
      ...tagsForProduct('fold-nt-12'),
      /*
       * ⭐ Always, and not the caller's to send: any product changing changes the single
       * entry the catalogue list is built from, so a caller cannot forget it.
       */
      catalogTag(),
    ]);
    // Next 16 requires the `cacheLife` profile argument; `max` is "this changed, for
    // everybody" rather than "for readers who are at most a minute behind".
    expect(revalidateTag.mock.calls.every(([, profile]) => profile === 'max')).toBe(true);

    expect(await response.json()).toEqual({
      revalidated: [...tagsForProduct('awn-4t'), ...tagsForProduct('fold-nt-12'), catalogTag()],
    });
  });

  it('⭐ pokes the slug tag too, because the catalogue reads by slug and reviews read by id', async () => {
    /*
     * `loadPublishedProduct` fetches `/catalog/products/:slug` and must tag that entry by
     * slug — a `fetch` declares its tags before the body carrying the id exists. A caller
     * that sent only ids would refresh a product's reviews while its page stayed frozen.
     */
    const { productSlugTag } = await import('@/lib/reviews/tags');
    const response = await POST(post({ productIds: ['awn-4t'], slugs: ['awn-4t-slug'] }));

    expect(response.status).toBe(200);
    expect(revalidateTag.mock.calls.map(([tag]) => tag)).toEqual([
      ...tagsForProduct('awn-4t'),
      productSlugTag('awn-4t-slug'),
      catalogTag(),
    ]);
  });

  it('⚠️ slugs are optional, so every caller written before them still works', async () => {
    expect((await POST(post({ productIds: ['awn-4t'] }))).status).toBe(200);
  });

  it('refuses a malformed slugs list rather than ignoring it', async () => {
    /* Silently dropping it would let a caller believe it invalidated a page it had not. */
    expect((await POST(post({ productIds: ['awn-4t'], slugs: 'a' }))).status).toBe(400);
    expect((await POST(post({ productIds: ['awn-4t'], slugs: [''] }))).status).toBe(400);
    expect((await POST(post({ productIds: ['awn-4t'], slugs: [7] }))).status).toBe(400);
  });

  it('never caches its own answer', async () => {
    const response = await POST(post({ productIds: ['awn-4t'] }));
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('de-duplicates rather than poking the same tag twice', async () => {
    await POST(post({ productIds: ['awn-4t', 'awn-4t'] }));
    /* Two product tags plus the catalogue tag — the repeated id contributes nothing. */
    expect(revalidateTag.mock.calls).toHaveLength(3);
  });

  it('refuses a body it does not recognise instead of guessing', async () => {
    expect((await POST(post('not json at all'))).status).toBe(400);
    expect((await POST(post({}))).status).toBe(400);
    expect((await POST(post({ productIds: [] }))).status).toBe(400);
    expect((await POST(post({ productIds: 'awn-4t' }))).status).toBe(400);
    expect((await POST(post({ productIds: ['awn-4t', 7] }))).status).toBe(400);
    expect((await POST(post({ productIds: [''] }))).status).toBe(400);
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it('caps one request, because "everything" is a caller that lost track', async () => {
    const tooMany = Array.from({ length: MAX_PRODUCT_IDS + 1 }, (_unused, index) => `p-${index}`);
    expect(productIdsFrom({ productIds: tooMany })).toBeNull();
    expect((await POST(post({ productIds: tooMany }))).status).toBe(400);

    const justEnough = Array.from({ length: MAX_PRODUCT_IDS }, (_unused, index) => `p-${index}`);
    expect(productIdsFrom({ productIds: justEnough })).toHaveLength(MAX_PRODUCT_IDS);
  });
});
