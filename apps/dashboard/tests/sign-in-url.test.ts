import { describe, expect, it } from 'vitest';

import { DEFAULT_RETURN_TO, oauthStartUrl, safeReturnTo, signInPath } from '@/lib/auth/sign-in-url';

/**
 * The same three shapes apps/api's `return-to.ts` rejects, asserted on this side too.
 *
 * Not because the client is the guarantee — the API's check and the CHECK constraint in
 * packages/db are — but because the value this app sends should never be one the API has to
 * refuse. A `?next=` that turns into a 400 from an endpoint the user did not choose to call
 * is a bug report about the login page.
 */
describe('safeReturnTo', () => {
  it('keeps an ordinary path on this site', () => {
    expect(safeReturnTo('/products/abc')).toBe('/products/abc');
    expect(safeReturnTo('/products?page=2')).toBe('/products?page=2');
  });

  it.each([
    ['absolute', 'https://evil.example'],
    ['protocol-relative — a browser reads this as https://evil.example', '//evil.example'],
    ['backslash authority — browsers normalise \\ to / here', '/\\evil.example'],
    ['not a path at all', 'products'],
    ['empty', ''],
  ])('collapses %s to the home page', (_why, raw) => {
    expect(safeReturnTo(raw)).toBe(DEFAULT_RETURN_TO);
  });

  it('rejects anything that could split a Location header', () => {
    expect(safeReturnTo('/a\r\nSet-Cookie: x=y')).toBe(DEFAULT_RETURN_TO);
    expect(safeReturnTo('/a b')).toBe(DEFAULT_RETURN_TO);
  });

  it('rejects a path longer than the API will accept', () => {
    expect(safeReturnTo(`/${'a'.repeat(512)}`)).toBe(DEFAULT_RETURN_TO);
  });

  it('treats a missing parameter as the home page rather than an error', () => {
    expect(safeReturnTo(null)).toBe(DEFAULT_RETURN_TO);
    expect(safeReturnTo(undefined)).toBe(DEFAULT_RETURN_TO);
  });
});

describe('signInPath', () => {
  it('carries the destination so the gate can put somebody back where they were', () => {
    expect(signInPath('/products/abc')).toBe('/login?next=%2Fproducts%2Fabc');
  });

  it('omits an empty round trip when the destination is the home page', () => {
    expect(signInPath('/')).toBe('/login');
  });

  it('does not carry a destination the API would refuse', () => {
    expect(signInPath('https://evil.example')).toBe('/login');
  });
});

describe('oauthStartUrl', () => {
  it('points at the API origin and encodes returnTo as a query parameter', () => {
    const url = new URL(oauthStartUrl('line', safeReturnTo('/products')));

    expect(url.pathname).toBe('/auth/oauth/line/start');
    expect(url.searchParams.get('returnTo')).toBe('/products');
  });

  it('escapes a provider name rather than letting it write the path', () => {
    const url = new URL(oauthStartUrl('../../admin', safeReturnTo('/')));

    expect(url.pathname).toBe('/auth/oauth/..%2F..%2Fadmin/start');
  });
});
