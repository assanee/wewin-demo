import { describe, expect, test } from 'vitest';
import { getProductById, products } from '@wewin/core/fixtures';
import {
  CONTENT_CATALOGUES,
  refKey,
  resolveContent,
  type ContentCatalogues,
  type ContentRef,
} from './content';
import { isLocale, LOCALES, negotiateLocale, SOURCE_LOCALE } from './locales';

/*
 * Catalogue content: the 81 products × 8 languages plan section 13 calls a bottleneck
 * that is not code.
 *
 * Nothing shipped in this round translates any of it, and that is the decision rather
 * than the gap. What is tested here is that the *mechanism* works when the content
 * eventually arrives, and that until it does the fallback is visible rather than
 * silent — because an empty catalogue is the condition this app runs in for the
 * foreseeable future, not an edge case.
 */

const WIDTH: ContentRef = { on: 'groupLabel', productId: 'awn-4t', groupCode: 'width' };

describe('resolution', () => {
  test('a translation wins when there is one', () => {
    const catalogues: ContentCatalogues = { en: { [refKey(WIDTH)]: 'Width' } };

    expect(resolveContent(WIDTH, 'ความกว้าง', 'en', catalogues)).toEqual({
      text: 'Width',
      fallback: false,
    });
  });

  test('the Thai source stands in when there is not, and says so', () => {
    expect(resolveContent(WIDTH, 'ความกว้าง', 'en', {})).toEqual({
      text: 'ความกว้าง',
      fallback: true,
    });
  });

  test('an empty translation counts as a miss', () => {
    // An empty string is exactly what a half-finished export produces, and it renders
    // as a product with no name. Treating it as a hit is the failure this whole file
    // is arranged to prevent.
    const catalogues: ContentCatalogues = { en: { [refKey(WIDTH)]: '' } };

    expect(resolveContent(WIDTH, 'ความกว้าง', 'en', catalogues)).toEqual({
      text: 'ความกว้าง',
      fallback: true,
    });
  });

  test('Thai never falls back to itself', () => {
    // The distinction the `lang="th"` marker is switched on: Thai text on a Thai page
    // is not a degraded rendering, and marking it would be noise on every element.
    expect(resolveContent(WIDTH, 'ความกว้าง', SOURCE_LOCALE, {}).fallback).toBe(false);
  });

  test('a translation for one locale is not used for another', () => {
    const catalogues: ContentCatalogues = { en: { [refKey(WIDTH)]: 'Width' } };

    expect(resolveContent(WIDTH, 'ความกว้าง', 'de', catalogues).text).toBe('ความกว้าง');
    expect(resolveContent(WIDTH, 'ความกว้าง', 'de', catalogues).fallback).toBe(true);
  });

  test('the shipped catalogues are empty, so every locale falls back today', () => {
    // Stated as an assertion rather than left as a fact somebody has to notice: if a
    // machine-translated catalogue is ever dropped in here, this test is where it
    // announces itself.
    expect(Object.keys(CONTENT_CATALOGUES)).toEqual([]);

    for (const locale of LOCALES) {
      const resolved = resolveContent(WIDTH, 'ความกว้าง', locale);
      expect(resolved.text).toBe('ความกว้าง');
      expect(resolved.fallback).toBe(locale !== SOURCE_LOCALE);
    }
  });
});

describe('refs address exactly one string each', () => {
  test('two products with the same group code get different keys', () => {
    // Every product in the catalogue has a `width` group. A key that dropped
    // `productId` would return *some* product's translation and read as a plausible
    // one, which is the worst kind of wrong.
    const a = refKey({ on: 'groupLabel', productId: 'awn-4t', groupCode: 'width' });
    const b = refKey({ on: 'groupLabel', productId: 'awn-2t', groupCode: 'width' });

    expect(a).not.toBe(b);
  });

  test('a group label and an option label never collide', () => {
    const group = refKey({ on: 'groupLabel', productId: 'p', groupCode: 'glass_color' });
    const option = refKey({
      on: 'optionLabel',
      productId: 'p',
      groupCode: 'glass_color',
      valueCode: 'GRN',
    });

    expect(group).not.toBe(option);
  });

  test('every ref the storefront can build across the whole catalogue is unique', () => {
    // Swept over the real 81 products rather than a handful: this is the property that
    // makes a translated catalogue a flat map at all, and a collision anywhere in it
    // would silently give one product another's words.
    const keys = new Set<string>();
    let built = 0;

    for (const product of products) {
      for (const ref of [
        { on: 'productName', productId: product.id },
        { on: 'productSummary', productId: product.id },
      ] as const satisfies readonly ContentRef[]) {
        keys.add(refKey(ref));
        built += 1;
      }

      for (const group of product.groups) {
        keys.add(refKey({ on: 'groupLabel', productId: product.id, groupCode: group.code }));
        built += 1;

        if (group.kind === 'sku') {
          for (const value of group.values) {
            keys.add(
              refKey({
                on: 'optionLabel',
                productId: product.id,
                groupCode: group.code,
                valueCode: value.code,
              }),
            );
            built += 1;
          }
        } else {
          keys.add(refKey({ on: 'groupHelper', productId: product.id, groupCode: group.code }));
          built += 1;
        }
      }

      for (const rule of product.rules) {
        keys.add(refKey({ on: 'ruleMessage', productId: product.id, ruleId: rule.id }));
        built += 1;
      }
    }

    expect(keys.size).toBe(built);
    expect(built).toBeGreaterThan(1_000);
  });

  test('a ref built from a real product resolves that product’s own string', () => {
    const product = getProductById('awn-4t');
    if (!product) throw new Error('fixture missing: awn-4t');

    const ref: ContentRef = { on: 'productName', productId: product.id };
    const catalogues: ContentCatalogues = { en: { [refKey(ref)]: '4-blade awning window' } };

    expect(resolveContent(ref, product.nameTh, 'en', catalogues).text).toBe(
      '4-blade awning window',
    );
    expect(resolveContent(ref, product.nameTh, 'en', {}).text).toBe(product.nameTh);
  });
});

describe('choosing a locale', () => {
  test('a browser preference is matched by language, ignoring the region', () => {
    // One German catalogue, so refusing `de-AT` over a region subtag would hand an
    // Austrian visitor Thai for no reason.
    expect(negotiateLocale(['de-AT', 'en-GB'])).toBe('de');
    expect(negotiateLocale(['en-GB'])).toBe('en');
    expect(negotiateLocale(['TH'])).toBe('th');
  });

  test('the browser’s own ranking decides', () => {
    expect(negotiateLocale(['fr-FR', 'vi-VN', 'en-US'])).toBe('vi');
  });

  test('nothing matched is reported as nothing matched', () => {
    // `null`, not `SOURCE_LOCALE`. Today both land on Thai; the difference matters the
    // moment there is a banner offering a language the visitor did not get.
    expect(negotiateLocale(['fr-FR', 'ja-JP'])).toBeNull();
    expect(negotiateLocale([])).toBeNull();
  });

  test('a stored preference from another build is rejected rather than trusted', () => {
    expect(isLocale('th')).toBe(true);
    expect(isLocale('TH')).toBe(false);
    expect(isLocale('en-US')).toBe(false);
    expect(isLocale(null)).toBe(false);
    expect(isLocale(7)).toBe(false);
  });
});
