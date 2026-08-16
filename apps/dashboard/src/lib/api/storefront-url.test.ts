import { afterEach, describe, expect, it } from 'vitest';

import { storefrontBaseUrl, storefrontProductUrl } from './config';

/**
 * ⛔ The link that answers "is the thing I published actually in the shop?".
 *
 * Reported as "the product I added is not on /th/products". It was — the dashboard's URL
 * uses the product **id** and the shop's uses the **slug**, and for the product in question
 * those were `uoio` and `sdfghjkl`. Getting this wrong produces a 404 for exactly the
 * products somebody most wants to check, which reads as a failed publish.
 */

const ORIGINAL = process.env['NEXT_PUBLIC_STOREFRONT_BASE_URL'];

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env['NEXT_PUBLIC_STOREFRONT_BASE_URL'];
  else process.env['NEXT_PUBLIC_STOREFRONT_BASE_URL'] = ORIGINAL;
});

describe('the link from a product to its page in the shop', () => {
  it('⭐ is built from the slug, in the catalogue’s own locale', () => {
    process.env['NEXT_PUBLIC_STOREFRONT_BASE_URL'] = 'https://shop.example';
    expect(storefrontProductUrl('sdfghjkl')).toBe('https://shop.example/th/products/sdfghjkl');
  });

  it('strips a trailing slash, so the path never doubles it', () => {
    process.env['NEXT_PUBLIC_STOREFRONT_BASE_URL'] = 'https://shop.example/';
    expect(storefrontProductUrl('a-slug')).toBe('https://shop.example/th/products/a-slug');
  });

  it('escapes the slug rather than trusting it', () => {
    process.env['NEXT_PUBLIC_STOREFRONT_BASE_URL'] = 'https://shop.example';
    expect(storefrontProductUrl('a b')).toBe('https://shop.example/th/products/a%20b');
  });

  it('⚠️ falls back to the dev port outside production', () => {
    delete process.env['NEXT_PUBLIC_STOREFRONT_BASE_URL'];
    expect(storefrontBaseUrl()).toBe('http://localhost:3002');
  });
});
