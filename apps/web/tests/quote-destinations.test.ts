import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DestinationSelect } from '@/components/quote/DestinationSelect';
import { fetchDestinations, isKnownDestination } from '@/lib/quote/destinations';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ THE PICKER, AND WHAT MAKES IT TESTABLE WITH NO DOM AT ALL.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * There is no `@testing-library/*`, no `jsdom`, no msw anywhere in this repo, and
 * `apps/web/vitest.config.ts` runs `environment: 'node'` on purpose. Three behaviours are worth
 * pinning here and every one is reachable without a browser: the fetcher's fallback (a plain
 * `vi.stubGlobal('fetch', …)`, the idiom `apps/web/tests/reviews.test.ts:385-410` already uses),
 * the rendered option list (`renderToStaticMarkup`, no interaction needed to read markup), and
 * the unknown-code guard (a pure function, no network and no DOM either).
 */

const thailand = () => ({ code: 'TH', nameTh: 'ไทย' });
const singapore = () => ({ code: 'SG', nameTh: 'สิงคโปร์' });

describe('the destinations read', () => {
  const originalBase = process.env.NEXT_PUBLIC_API_BASE_URL;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_API_BASE_URL = 'https://api.example';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalBase === undefined) delete process.env.NEXT_PUBLIC_API_BASE_URL;
    else process.env.NEXT_PUBLIC_API_BASE_URL = originalBase;
  });

  const respond = (body: unknown, status = 200) =>
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
      ),
    );

  it('returns what the API published, in the order it published it', async () => {
    respond({ destinations: [thailand(), singapore()] });

    /* Server-side order is `sort_order`; the browser must not re-sort it. */
    expect(await fetchDestinations()).toStrictEqual([thailand(), singapore()]);
  });

  it('degrades to Thailand alone when the read fails, rather than throwing', async () => {
    /* A settings endpoint being down must not stop somebody asking for a price. */
    respond({}, 503);

    expect(await fetchDestinations()).toStrictEqual([thailand()]);
  });

  it('degrades to Thailand alone on a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    expect(await fetchDestinations()).toStrictEqual([thailand()]);
  });

  it('degrades to Thailand alone on a body it cannot read', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{not json', { status: 200 })));

    expect(await fetchDestinations()).toStrictEqual([thailand()]);
  });

  it('degrades to Thailand alone without a network call when no API is configured', async () => {
    delete process.env.NEXT_PUBLIC_API_BASE_URL;
    vi.stubEnv('NODE_ENV', 'production');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    expect(await fetchDestinations()).toStrictEqual([thailand()]);
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.unstubAllEnvs();
  });
});

describe('the select', () => {
  it('defaults to Thailand and lists every option it was given', () => {
    const markup = renderToStaticMarkup(
      createElement(DestinationSelect, {
        options: [thailand(), singapore()],
        value: 'TH',
        onChange: () => {},
      }),
    );

    expect(markup).toContain('สิงคโปร์');
    expect(markup).toMatch(/value="TH"[^>]*selected/u);
  });

  it('starts on the destination a returning customer used last time', () => {
    const markup = renderToStaticMarkup(
      createElement(DestinationSelect, { options: [thailand(), singapore()], value: 'SG', onChange: () => {} }),
    );

    expect(markup).toMatch(/value="SG"[^>]*selected/u);
  });

  it('renders a real <label>, not a bare <select>', () => {
    const markup = renderToStaticMarkup(
      createElement(DestinationSelect, { options: [thailand()], value: 'TH', onChange: () => {} }),
    );

    expect(markup).toContain('<label');
  });
});

describe('⭐ the unknown-code guard — Task 9’s finding, closed on the storefront side', () => {
  /*
   * `POST /orders` accepts any `/^[A-Z]{2}$/` code without checking it against `tax_countries`,
   * deliberately — resolving is `resolveDestination`'s job, at submit. So a value that never was
   * one of the options this customer was shown — most likely a destination pre-filled from a
   * prior order that has since been withdrawn — must be caught here, before a round trip is
   * spent reaching a refusal far from the mistake.
   */
  it('accepts a code that is one of the options shown', () => {
    expect(isKnownDestination('SG', [thailand(), singapore()])).toBe(true);
  });

  it('refuses a code that dropped off the active list, or was never on it', () => {
    expect(isKnownDestination('ZZ', [thailand()])).toBe(false);
  });

  it('refuses everything against an empty list, including TH', () => {
    expect(isKnownDestination('TH', [])).toBe(false);
  });
});
