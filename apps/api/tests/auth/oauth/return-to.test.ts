import { describe, expect, it } from 'vitest';

import { isLocalReturnTo, parseReturnTo } from '../../../src/auth/oauth/return-to';

/**
 * The open-redirect surface, enumerated.
 *
 * A login callback that will redirect anywhere is a phishing page with our domain in front
 * of it, arriving at the moment the customer has just typed a password. The three shapes
 * below are the ones a "starts with a slash" check lets through.
 */
describe('returnTo', () => {
  it('accepts a path on this site', () => {
    expect(isLocalReturnTo('/')).toBe(true);
    expect(isLocalReturnTo('/quote/12')).toBe(true);
    expect(isLocalReturnTo('/search?q=window&sort=price')).toBe(true);
  });

  it.each([
    ['absolute', 'https://evil.example/phish'],
    ['scheme-relative', '//evil.example/phish'],
    ['backslash authority', '/\\evil.example/phish'],
    ['javascript', 'javascript:alert(1)'],
    ['relative', 'quote'],
    ['empty', ''],
  ])('rejects a %s target', (_label, value) => {
    expect(isLocalReturnTo(value)).toBe(false);
  });

  it('rejects anything that could split a Location header', () => {
    expect(isLocalReturnTo('/quote\r\nSet-Cookie: session=stolen')).toBe(false);
    expect(isLocalReturnTo('/quote with a space')).toBe(false);
  });

  it('defaults when absent and refuses rather than silently falling back', () => {
    expect(parseReturnTo(undefined)).toBe('/');
    expect(parseReturnTo('')).toBe('/');
    // Not '/': a client bug that produced `undefined` in a template must not look like a
    // customer who asked for the home page.
    expect(parseReturnTo('https://evil.example')).toBeUndefined();
  });
});
