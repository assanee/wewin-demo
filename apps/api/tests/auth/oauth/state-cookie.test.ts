import { describe, expect, it } from 'vitest';

import {
  clearStateCookie,
  decodeStateCookieValue,
  encodeStateCookieValue,
  readCookie,
  serialiseStateCookie,
  stateCookieName,
} from '../../../src/auth/oauth/state-cookie';

/**
 * ⓑ The cookie's attributes are the fix, so they are asserted as attributes.
 *
 * Every expectation below is a sentence from plan 6(b) or from the Apple round trip that
 * forces it. If one of these is ever "simplified" — `SameSite=Lax` because `None` looks
 * alarming, the `__Host-` prefix dropped because it forces `Path=/` — the binding stops
 * covering the provider that most needs it, and these are the tests that say so.
 */
describe('OAuth state cookie', () => {
  const attributes = (cookie: string): string[] =>
    cookie
      .split(';')
      .slice(1)
      .map((part) => part.trim());

  it('is HttpOnly, Secure, SameSite=None and __Host- prefixed in the secure profile', () => {
    const name = stateCookieName('a'.repeat(64), true);
    const cookie = serialiseStateCookie(name, 'value', { cookieSecure: true, maxAgeSeconds: 600 });

    expect(name.startsWith('__Host-')).toBe(true);
    expect(attributes(cookie)).toContain('HttpOnly');
    expect(attributes(cookie)).toContain('Secure');
    // None and not Lax: Apple's callback is a cross-site POST and a Lax cookie is not sent on it.
    expect(attributes(cookie)).toContain('SameSite=None');
    // __Host- is only honoured with Path=/, and Path=/ is what stops a sibling subdomain
    // planting a binding secret in the victim's browser.
    expect(attributes(cookie)).toContain('Path=/');
    expect(attributes(cookie)).toContain('Max-Age=600');
  });

  it('drops Secure and falls back to Lax without https, where SameSite=None would be dropped entirely', () => {
    const name = stateCookieName('b'.repeat(64), false);
    const cookie = serialiseStateCookie(name, 'value', { cookieSecure: false, maxAgeSeconds: 600 });

    expect(name.startsWith('__Host-')).toBe(false);
    expect(attributes(cookie)).not.toContain('Secure');
    expect(attributes(cookie)).toContain('SameSite=Lax');
    expect(attributes(cookie)).toContain('HttpOnly');
  });

  it('names the cookie after the flow, so two tabs do not overwrite each other', () => {
    const first = stateCookieName('1'.repeat(64), true);
    const second = stateCookieName('2'.repeat(64), true);

    expect(first).not.toBe(second);
    // Derived from the state hash, so the callback finds it with nothing else stored.
    expect(first.endsWith('1'.repeat(16))).toBe(true);
  });

  it('clears with the same name and path it was set with', () => {
    const name = stateCookieName('c'.repeat(64), true);
    const cleared = clearStateCookie(name, true);

    expect(cleared.startsWith(`${name}=;`)).toBe(true);
    expect(attributes(cleared)).toContain('Max-Age=0');
    expect(attributes(cleared)).toContain('Path=/');
  });

  it('round-trips the two secrets it carries', () => {
    const binding = 'b'.repeat(43);
    const verifier = 'v'.repeat(43);
    expect(decodeStateCookieValue(encodeStateCookieValue({ binding, verifier }))).toEqual({
      binding,
      verifier,
    });
  });

  it('refuses a cookie value that could not have been minted here', () => {
    // Attacker-supplied input: anything that is not two base64url secrets is rejected
    // before it is hashed or compared.
    expect(decodeStateCookieValue(undefined)).toBeUndefined();
    expect(decodeStateCookieValue('no-separator')).toBeUndefined();
    expect(decodeStateCookieValue('short.short')).toBeUndefined();
    expect(decodeStateCookieValue(`${'a'.repeat(32)}.${'b/c+d'.repeat(8)}`)).toBeUndefined();
  });

  it('reads one named value out of a Cookie header and ignores the rest', () => {
    const header = 'other=1; __Host-wewin_oauth_abc=binding.verifier; another=2';
    expect(readCookie(header, '__Host-wewin_oauth_abc')).toBe('binding.verifier');
    expect(readCookie(header, 'wewin_oauth_abc')).toBeUndefined();
    expect(readCookie(undefined, 'anything')).toBeUndefined();
  });
});
