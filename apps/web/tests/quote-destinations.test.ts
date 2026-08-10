import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DestinationSelect } from '@/components/quote/DestinationSelect';
import {
  destinationIsSubmittable,
  fetchDestinations,
  isKnownDestination,
  readDestinations,
} from '@/lib/quote/destinations';

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

describe('readDestinations — the tri-state read the guard actually needs', () => {
  /*
   * `fetchDestinations` collapses success and failure into the same shape on purpose, for the
   * caller that only wants something to render. `readDestinations` is the one the guard needs:
   * it says whether the list it is handing back is `ready` (a real answer) or `failed` (the
   * degrade) — a distinction `fetchDestinations`'s bare array cannot make, and the one the race
   * described below turns on.
   */
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

  it('reports ready with the real list, once one comes back', async () => {
    respond({ destinations: [thailand(), singapore()] });

    expect(await readDestinations()).toEqual({ kind: 'ready', options: [thailand(), singapore()] });
  });

  it('reports failed on every kind of failure, still carrying the Thailand-only degrade', async () => {
    respond({}, 503);
    expect(await readDestinations()).toEqual({ kind: 'failed', options: [thailand()] });

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    expect(await readDestinations()).toEqual({ kind: 'failed', options: [thailand()] });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{not json', { status: 200 })));
    expect(await readDestinations()).toEqual({ kind: 'failed', options: [thailand()] });
  });

  /*
   * ⭐ THE RACE A REVIEW ROUND CAUGHT LIVE — proved here at the level it actually lives.
   *
   * `GET /destinations` and the contact pre-fill are two independent, unsequenced requests. A
   * reviewer held the destinations read open while a returning customer's fast pre-fill set
   * `destinationCountry` to a real, previously-chosen code. During that window the form's
   * options were still sitting at their initial value — indistinguishable, by content alone,
   * from "the read failed and degraded to Thailand" — and a guard reading only that array
   * refused a perfectly good selection, telling the customer to choose again from the one
   * option visibly on screen. This is that window, held open on purpose: the destinations
   * fetch is stubbed to resolve only when this test says so, and while it is still pending,
   * `destinationIsSubmittable` must not refuse — there is nothing yet to refuse it against.
   */
  it('the loading window: a pending read must not make the guard refuse a valid code', async () => {
    let settleFetch: ((response: Response) => void) | undefined;
    const pending = new Promise<Response>((resolve) => {
      settleFetch = resolve;
    });
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(pending));

    const read = readDestinations(); // in flight — nothing has come back yet

    /*
     * Exactly the state `RequestQuotationForm`'s own `useState` holds until this promise
     * settles. A customer whose pre-fill already landed with `destinationCountry: 'SG'` must
     * still be able to submit — refusing here is the false refusal the review round observed.
     */
    expect(destinationIsSubmittable('SG', { kind: 'loading' })).toBe(true);
    expect(destinationIsSubmittable('ZZ', { kind: 'loading' })).toBe(true);

    settleFetch?.(
      new Response(JSON.stringify({ destinations: [thailand(), singapore()] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const settled = await read;

    expect(settled).toEqual({ kind: 'ready', options: [thailand(), singapore()] });
    // Once the read has actually settled, the guard is back to normal — SG was really on the
    // list and ZZ never was.
    expect(destinationIsSubmittable('SG', settled)).toBe(true);
    expect(destinationIsSubmittable('ZZ', settled)).toBe(false);
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

describe('⭐ destinationIsSubmittable — the guard as a function of the read’s state, not a bare list', () => {
  it('never refuses while the read is still loading — there is nothing yet to check against', () => {
    expect(destinationIsSubmittable('TH', { kind: 'loading' })).toBe(true);
    expect(destinationIsSubmittable('SG', { kind: 'loading' })).toBe(true);
    expect(destinationIsSubmittable('ZZ', { kind: 'loading' })).toBe(true);
  });

  it('applies the guard normally once the read is ready', () => {
    const ready = { kind: 'ready' as const, options: [thailand(), singapore()] };

    expect(destinationIsSubmittable('SG', ready)).toBe(true);
    expect(destinationIsSubmittable('ZZ', ready)).toBe(false);
  });

  it('applies the guard normally on a failed read too — the degrade is not an exemption', () => {
    const failed = { kind: 'failed' as const, options: [thailand()] };

    expect(destinationIsSubmittable('TH', failed)).toBe(true);
    expect(destinationIsSubmittable('SG', failed)).toBe(false);
  });
});
