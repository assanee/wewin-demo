import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ReviewBlockContent } from '@/components/reviews/ReviewBlock';
import { DisplayUnitProvider } from '@/state/useDisplayUnit';
import { formattersFor } from '@/i18n/format';
import { averageTenths, averageText, starFills } from '@/lib/reviews/average';
import { loadProductReviews, reviewsPath } from '@/lib/reviews/api';
import { decodeInvitation } from '@/lib/reviews/invitation';
import { productTag, reviewsTag, tagsForProduct } from '@/lib/reviews/tags';
import { decodeProductReviews } from '@/lib/reviews/wire';
import type { ProductReviewsWire } from '@/lib/reviews/wire';

/**
 * # Plan section 9 on the storefront
 *
 * What is asserted here is chosen by the same rule the rest of this suite uses: **the
 * failures that produce a plausible page.** A review block that throws is found by the
 * first person who looks at it. A review block that renders `5.0 ★` with no count, or that
 * quietly drops the hidden ratings out of an average, or whose cache tag is spelled one way
 * by the reader and another by the writer, looks completely correct and is wrong for
 * months.
 *
 * The environment is `node` and there is no browser in it, exactly as
 * `configurator-render.test.ts` requires — the review block is a server component and the
 * whole point of it is that it lands in prerendered HTML.
 */

/* ------------------------------------------------------------------ *
 * The arithmetic — exact, and never available without the count
 * ------------------------------------------------------------------ */

describe('the average is computed in integers and rounded half-up', () => {
  it('rounds the way the rest of this system rounds', () => {
    // 51/12 = 4.25 → 4.3 half-up, not 4.2 as `toFixed` on a double would give for 4.25.
    expect(averageText({ sum: 51n, count: 12n })).toBe('4.3');
    expect(averageText({ sum: 17n, count: 4n })).toBe('4.3'); // 4.25
    expect(averageText({ sum: 13n, count: 4n })).toBe('3.3'); // 3.25
    expect(averageTenths({ sum: 9n, count: 2n })).toBe(45n);
  });

  it('keeps the trailing tenth, so a rating never looks like a count', () => {
    expect(averageText({ sum: 5n, count: 1n })).toBe('5.0');
    expect(averageText({ sum: 20n, count: 4n })).toBe('5.0');
  });

  it('has no average for nothing, and does not call it zero', () => {
    expect(averageTenths({ sum: 0n, count: 0n })).toBeNull();
    expect(averageText({ sum: 0n, count: 0n })).toBeNull();
    // The renderer agrees, in all eight locales.
    expect(formattersFor('th').rating(0n, 0n)).toBe('—');
    expect(formattersFor('de').rating(0n, 0n)).toBe('—');
  });

  it('draws five stars, to the nearest half, from the same integers', () => {
    expect(starFills({ sum: 5n, count: 1n })).toEqual(['full', 'full', 'full', 'full', 'full']);
    expect(starFills({ sum: 9n, count: 2n })).toEqual(['full', 'full', 'full', 'full', 'half']);
    expect(starFills({ sum: 7n, count: 2n })).toEqual(['full', 'full', 'full', 'half', 'empty']);
    expect(starFills({ sum: 1n, count: 1n })).toEqual(['full', 'empty', 'empty', 'empty', 'empty']);
    expect(starFills({ sum: 0n, count: 0n })).toEqual(['empty', 'empty', 'empty', 'empty', 'empty']);
  });

  it('renders the rating in this locale’s numerals', () => {
    // Thai reads Western digits; Burmese does not, and that is the one that catches a
    // formatter that went round `@wewin/i18n` rather than through it.
    expect(formattersFor('th').rating(9n, 2n)).toBe('4.5');
    expect(formattersFor('my').rating(9n, 2n)).not.toBe('4.5');
  });
});

/* ------------------------------------------------------------------ *
 * Plan 9.5 — never an average without its count
 * ------------------------------------------------------------------ */

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

const sourceFiles = (directory: string): readonly string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });

/*
 * Comments stripped before every scan, for the reason `tests/cache-policy.test.ts` gives:
 * a guard that fires on the paragraph explaining it teaches contributors to delete the
 * explanation. `keys.ts` names `f.rating(sum, count)` in prose, which is exactly the case.
 */
const code = (source: string): string =>
  source.replaceAll(/\/\*[\s\S]*?\*\//g, ' ').replaceAll(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

const files = sourceFiles(sourceRoot).map((path) => ({
  name: relative(sourceRoot, path),
  source: code(readFileSync(path, 'utf8')),
  raw: readFileSync(path, 'utf8'),
}));

describe('plan 9.5 — an average cannot be rendered on its own', () => {
  it('found files to scan', () => {
    // The empty-scan failure this repo has met twice: a scan over nothing passes and
    // proves nothing.
    expect(files.length).toBeGreaterThanOrEqual(20);
  });

  it('`f.rating` is called from the catalogues and nowhere else', () => {
    /*
     * The structural half of the rule. `rating(sum, count)` cannot be called without the
     * denominator, and this asserts that the *only* callers are the two catalogue entries
     * for `review.summary` — which also render the count, in the same sentence, because
     * there is no second key to put it in.
     *
     * A component that wanted "just the stars, in the header" would have to appear in this
     * list, in front of a reviewer, which is the visibility the rule needs to survive.
     */
    const callers = files
      .filter(({ name, source }) => name !== join('i18n', 'format.ts') && /\bf\.rating\(/.test(source))
      .map(({ name }) => name)
      .sort();

    expect(callers).toEqual([join('i18n', 'catalogues', 'en.ts'), join('i18n', 'catalogues', 'th.ts')]);
  });

  it('the scan can still see — `f.baht(` is findable the same way', () => {
    // Without this the assertion above becomes decoration the moment the regex rots.
    const bahtCallers = files.filter(({ source }) => /\bf\.baht\(/.test(source));
    expect(bahtCallers.length).toBeGreaterThanOrEqual(2);
  });

  it('every rendering of the summary carries both numbers', () => {
    for (const locale of ['th', 'en'] as const) {
      const html = render(withReviews(), locale);
      // 4.3 from 51/12, and the 12 beside it.
      expect(html).toContain('4.3');
      expect(html).toContain('12');
    }
  });
});

/* ------------------------------------------------------------------ *
 * Plan 9.5 — the block is not there
 * ------------------------------------------------------------------ */

const review = (over: Partial<ProductReviewsWire['reviews'][number]> = {}) => ({
  id: 'r1',
  rating: 5,
  bodyTh: 'ติดตั้งเรียบร้อย ผ่านหน้าฝนมาแล้วไม่รั่ว',
  authorDisplayName: 'ส.',
  contentErasedAt: null,
  replyTh: null,
  repliedAt: null,
  publicSince: '2026-03-14T04:00:00.000Z',
  size: { widthUm: 1_200_000n, heightUm: 2_100_000n },
  photos: [],
  ...over,
});

/**
 * The block as a page renders it: inside `DisplayUnitProvider`.
 *
 * Not a test convenience. `ReviewCard` prints the size the customer ordered through
 * `UnitText`, which is the client half of plan 8.2's third trap — the server writes all
 * five units into the cached HTML and the browser indexes one. That component reads the
 * provider `AppShell` mounts, so the review block is only renderable underneath it, and a
 * refactor that moved the block outside the shell would fail here with the provider's own
 * error message rather than in a browser.
 */
const render = (data: ProductReviewsWire, locale: 'th' | 'en'): string =>
  renderToStaticMarkup(
    createElement(DisplayUnitProvider, {
      children: createElement(ReviewBlockContent, { data, locale }),
    }),
  );

const withReviews = (): ProductReviewsWire => ({
  productId: 'awn-4t',
  stats: { ratingCount: 12n, ratingSum: 51n, visibleCount: 12n, visibleWithTextCount: 9n },
  reviews: [review()],
  nextPublicationAt: null,
  pendingCount: 0,
});

describe('plan 9.5 — no reviews means no block, not an empty state', () => {
  it('renders nothing at all when the product has no stats', () => {
    const html = render(
      { productId: 'awn-4t', stats: null, reviews: [], nextPublicationAt: null, pendingCount: 0 },
      'th',
    );

    // Not "an empty section", not a heading with nothing under it. Nothing.
    expect(html).toBe('');
  });

  it('renders nothing when every moderated review is hidden', () => {
    const html = render(
      {
        productId: 'awn-4t',
        stats: { ratingCount: 3n, ratingSum: 6n, visibleCount: 0n, visibleWithTextCount: 0n },
        reviews: [],
        nextPublicationAt: null,
        pendingCount: 0,
      },
      'th',
    );

    expect(html).toBe('');
  });

  it('renders the block, the summary and the review when there is one', () => {
    const html = render(withReviews(), 'th');

    expect(html).toContain('reviews-heading');
    expect(html).toContain('ผ่านหน้าฝนมาแล้วไม่รั่ว');
    // Plan 9.1: the size the customer chose is on the card, in all five units, rendered on
    // the server — the `cm` default is what the cached page carries.
    expect(html).toContain('120 × 210 cm');
  });

  it('is deterministic — two renders of one body are the same bytes', () => {
    const once = render(withReviews(), 'th');
    const twice = render(withReviews(), 'th');
    expect(once).toBe(twice);
  });
});

/* ------------------------------------------------------------------ *
 * Plan 9.3 — hiding does not move the score, and the page says so
 * ------------------------------------------------------------------ */

describe('plan 9.3 — a hidden review still counts, visibly', () => {
  const partlyHidden: ProductReviewsWire = {
    productId: 'awn-4t',
    // Twelve moderated ratings, ten of them visible. The average is over twelve.
    stats: { ratingCount: 12n, ratingSum: 51n, visibleCount: 10n, visibleWithTextCount: 8n },
    reviews: [review()],
    nextPublicationAt: null,
    pendingCount: 0,
  };

  it('averages over every moderated rating, not over the visible ones', () => {
    const html = render(partlyHidden, 'th');

    // 51/12 = 4.3. Over the ten visible it would be 5.1, which is not even a rating —
    // and over a visible *sum* somebody had recomputed it would be plausible and wrong.
    expect(html).toContain('4.3');
    expect(html).toContain('12');
  });

  it('tells the reader the count and the list disagree, and why', () => {
    const html = render(partlyHidden, 'th');

    // Two hidden, said out loud. Without this a reader would reasonably conclude the
    // missing ones were deleted — which is the thing plan 9.3 spends three mechanisms
    // making impossible.
    expect(html).toContain('ยังนับรวมในค่าเฉลี่ย');
  });

  it('says nothing about hiding when nothing is hidden', () => {
    const html = render(withReviews(), 'th');
    expect(html).not.toContain('ยังนับรวมในค่าเฉลี่ย');
  });
});

/* ------------------------------------------------------------------ *
 * The wire — decoded, never cast
 * ------------------------------------------------------------------ */

const body = (over: Record<string, unknown> = {}): unknown => ({
  productId: 'awn-4t',
  stats: { ratingCount: '12', ratingSum: '51', visibleCount: '10', visibleWithTextCount: '8' },
  reviews: [],
  nextPublicationAt: null,
  pendingCount: 0,
  ...over,
});

describe('the decoder', () => {
  it('accepts a bigint that arrived as a string, which is what a JSON serialiser does', () => {
    const decoded = decodeProductReviews(body());
    expect(decoded.stats?.ratingCount).toBe(12n);
    expect(decoded.stats?.ratingSum).toBe(51n);
  });

  it('turns a zeroed stats object into no stats at all', () => {
    // `product_review_stats` is a GROUP BY and produces no row; an API that sends zeroes
    // instead would put "0.0 from 0 reviews" on 81 pages.
    const decoded = decodeProductReviews(
      body({ stats: { ratingCount: 0, ratingSum: 0, visibleCount: 0, visibleWithTextCount: 0 } }),
    );
    expect(decoded.stats).toBeNull();
  });

  it('refuses a sum that cannot come from that many 1–5 ratings', () => {
    expect(() => decodeProductReviews(body({ stats: { ratingCount: 2, ratingSum: 11, visibleCount: 2, visibleWithTextCount: 0 } }))).toThrow(TypeError);
    expect(() => decodeProductReviews(body({ stats: { ratingCount: 4, ratingSum: 3, visibleCount: 4, visibleWithTextCount: 0 } }))).toThrow(TypeError);
  });

  it('refuses a rating outside the five stars it can draw', () => {
    expect(() => decodeProductReviews(body({ reviews: [{ ...review(), rating: 6 }] }))).toThrow(TypeError);
    expect(() => decodeProductReviews(body({ reviews: [{ ...review(), rating: 0 }] }))).toThrow(TypeError);
  });

  it('refuses a count that is not a whole number rather than coercing it', () => {
    expect(() => decodeProductReviews(body({ stats: { ratingCount: '12abc', ratingSum: '51', visibleCount: 1, visibleWithTextCount: 0 } }))).toThrow(TypeError);
  });

  it('treats a missing photos array as none, because that is what it means', () => {
    const decoded = decodeProductReviews(
      body({ reviews: [{ ...review(), photos: undefined, size: null }] }),
    );
    expect(decoded.reviews[0]?.photos).toEqual([]);
  });

  it('reads an invitation, and answers null for every shape it does not know', () => {
    expect(decodeInvitation({ productSlug: 'awn-4t' })).toEqual({
      productSlug: 'awn-4t',
      size: null,
      submitted: false,
    });
    expect(decodeInvitation({ productSlug: 'awn-4t', size: { widthUm: '1200000', heightUm: 2100000 } })?.size)
      .toEqual({ widthUm: 1_200_000n, heightUm: 2_100_000n });
    expect(decodeInvitation({})).toBeNull();
    expect(decodeInvitation(null)).toBeNull();
    expect(decodeInvitation('ok')).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * The two halves of plan 9.5's cache rule, and the string between them
 * ------------------------------------------------------------------ */

describe('the tags the reader and the writer share', () => {
  it('is the spelling plan 8.2 names, plus one for reviews', () => {
    expect(productTag('awn-4t')).toBe('product:awn-4t');
    expect(reviewsTag('awn-4t')).toBe('reviews:awn-4t');
    expect(tagsForProduct('awn-4t')).toEqual(['product:awn-4t', 'reviews:awn-4t']);
  });

  it('neither half spells a tag by hand', () => {
    // The failure this stops is silent and permanent: a reader tagged `product:x` and a
    // writer poking `products:x` is a page that never updates and never errors.
    const api = files.find(({ name }) => name === join('lib', 'reviews', 'api.ts'));
    const route = files.find(({ name }) => name === join('app', 'api', 'revalidate', 'route.ts'));

    expect(api?.source).toContain('tagsForProduct(productId)');
    expect(route?.source).toContain('tagsForProduct(productId)');
    // No literal tag anywhere but `tags.ts` itself.
    const literals = files
      .filter(({ name, source }) => name !== join('lib', 'reviews', 'tags.ts') && /['"`]product:\$\{/.test(source))
      .map(({ name }) => name);
    expect(literals).toEqual([]);
  });
});

describe('the read: cached for ever, tagged, and never a time', () => {
  const originalBase = process.env.NEXT_PUBLIC_API_BASE_URL;

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    process.env.NEXT_PUBLIC_API_BASE_URL = 'https://api.example';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (originalBase === undefined) delete process.env.NEXT_PUBLIC_API_BASE_URL;
    else process.env.NEXT_PUBLIC_API_BASE_URL = originalBase;
  });

  it('asks the one path, with force-cache and both tags, and no revalidate interval', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body()), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const result = await loadProductReviews('awn-4t');
    expect(result.ok).toBe(true);

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit & { next?: { tags?: string[]; revalidate?: unknown } }];
    expect(url).toBe(`https://api.example${reviewsPath('awn-4t')}`);
    /*
     * `force-cache` is what keeps the 648 pages prerendered: since Next 15 an uncached
     * fetch in a server component opts its route out of the build, silently.
     */
    expect(init.cache).toBe('force-cache');
    expect(init.next?.tags).toEqual(['product:awn-4t', 'reviews:awn-4t']);
    // Plan 8.2 trap 1: there is no interval at which "the page disagrees with the
    // database" is false, so there is no interval here.
    expect(init.next?.revalidate).toBeUndefined();
  });

  it('hides the block for every failure rather than rendering half of one', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    expect(await loadProductReviews('awn-4t')).toMatchObject({ ok: false, reason: 'unreachable' });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 502 })));
    expect(await loadProductReviews('awn-4t')).toMatchObject({ ok: false, reason: 'refused' });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{', { status: 200 })));
    expect(await loadProductReviews('awn-4t')).toMatchObject({ ok: false, reason: 'malformed' });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ reviews: 'no' }), { status: 200 })),
    );
    expect(await loadProductReviews('awn-4t')).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('builds without an API rather than failing the build', async () => {
    delete process.env.NEXT_PUBLIC_API_BASE_URL;
    // In production a missing base URL is a deployment mistake and the block disappears;
    // it must never be a thrown error, or 648 working pages stop being built because an
    // optional block could not be configured.
    vi.stubEnv('NODE_ENV', 'production');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    expect(await loadProductReviews('awn-4t')).toMatchObject({ ok: false, reason: 'unconfigured' });
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.unstubAllEnvs();
  });
});
