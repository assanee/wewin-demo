import { describe, expect, it } from 'vitest';
import { INTL_TAG, LOCALES, SOURCE_LOCALE } from '@wewin/i18n/locales';

import {
  firstSegment,
  languageAlternates,
  localeFromSegment,
  localeHref,
  localeStaticParams,
} from '@/lib/routing';

describe('locale segments', () => {
  it('prerenders exactly the eight, and nothing else', () => {
    expect(localeStaticParams().map((entry) => entry.locale)).toEqual([...LOCALES]);
  });

  it('refuses an unknown segment rather than falling back to Thai', () => {
    // The fallback would be the plausible-wrong-answer failure `@wewin/i18n` documents for
    // `Intl` and `la`: a Thai page served at /xx, looking like it worked.
    expect(localeFromSegment('xx')).toBeNull();
    expect(localeFromSegment('')).toBeNull();
    expect(localeFromSegment('TH')).toBeNull();
    expect(localeFromSegment('th-TH')).toBeNull();
  });

  it('accepts every one of the eight', () => {
    for (const locale of LOCALES) expect(localeFromSegment(locale)).toBe(locale);
  });
});

describe('firstSegment', () => {
  it.each([
    ['/', ''],
    ['/th', 'th'],
    ['/th/products', 'th'],
    ['/products/fold-nt-12', 'products'],
  ])('%s -> %s', (pathname, expected) => {
    expect(firstSegment(pathname)).toBe(expected);
  });
});

describe('localeHref', () => {
  it('has no trailing slash on the home route', () => {
    // `/de/` is a second URL for the same document and Next redirects it, costing a round
    // trip on every link that carries one.
    expect(localeHref('de', '/')).toBe('/de');
  });

  it('prefixes Thai like every other locale', () => {
    // The whole cache-key argument in src/lib/routing.ts depends on this being true for
    // the default locale too — an unprefixed default is the one that reopens plan 8.7(2).
    expect(localeHref(SOURCE_LOCALE, '/products')).toBe('/th/products');
  });
});

describe('languageAlternates', () => {
  const alternates = languageAlternates('/products');

  it('keys hreflang by ICU tag, never by path segment', () => {
    // `hreflang="la"` would tell every crawler the Lao pages are written in Latin.
    expect(alternates['lo-LA']).toBe('/la/products');
    expect(alternates['la']).toBeUndefined();
  });

  it('covers all eight plus x-default', () => {
    expect(Object.keys(alternates)).toHaveLength(LOCALES.length + 1);
    for (const locale of LOCALES) {
      expect(alternates[INTL_TAG[locale]]).toBe(`/${locale}/products`);
    }
  });

  it('points x-default at the source language', () => {
    expect(alternates['x-default']).toBe(`/${SOURCE_LOCALE}/products`);
  });
});
