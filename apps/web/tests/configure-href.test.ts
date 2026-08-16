import { describe, expect, it } from 'vitest';
import type { QuoteLine } from '@wewin/core/quote';

import { configureHref } from '../src/components/quote/configureHref';

/**
 * ⛔ The pencil button in the cart, which answered 404.
 *
 * `configureHref` built the path from `line.productId` and its own comment explained why
 * that was safe — every seeded product is built with `id: row.slug` — and then warned:
 * *"if ids ever stop being slugs, this is the call site that breaks, and it breaks as a
 * 404"*. Products created in the dashboard set the two independently, so it did. A customer
 * with such a product in their cart could not reopen the line at all.
 *
 * There was no test on this file. That is why the warning could be right and still not stop
 * anything.
 */

const line = (over: Partial<QuoteLine> = {}): QuoteLine =>
  ({
    lineId: '9f8ab408-34aa-4a7d-ab86-60f8848f86b9',
    productId: 'uoio',
    nickname: 'สินค้าทดสอบ',
    skuCode: 'OOP-BBB',
    selections: {},
    measures: {},
    enteredUnits: {},
    qty: 1,
    priceSnapshot: {} as QuoteLine['priceSnapshot'],
    configHash: 'hash',
    addedAt: '2026-08-16T00:00:00.000Z',
    warnings: [],
    ...over,
  }) as QuoteLine;

describe('where "edit this line" goes', () => {
  it('⭐ uses the slug, not the product id — the reported 404', () => {
    /*
     * Exactly the case from the report: id `uoio`, slug `sdfghjkl`. The old link went to
     * /th/products/uoio and answered 404 · ไม่พบหน้านี้.
     */
    expect(configureHref('th', line({ productSlug: 'sdfghjkl' }))).toBe(
      '/th/products/sdfghjkl?line=9f8ab408-34aa-4a7d-ab86-60f8848f86b9',
    );
  });

  it('⚠️ falls back to the id for a line stored before the slug was recorded', () => {
    /*
     * Carts live in `localStorage` and survive a deploy. A line written by the previous
     * build has no `productSlug`; falling back to the id keeps it working for all 81 seeded
     * products, where the two are the same string.
     */
    const stored = line();
    delete (stored as { productSlug?: string }).productSlug;
    expect(configureHref('th', stored)).toBe(
      '/th/products/uoio?line=9f8ab408-34aa-4a7d-ab86-60f8848f86b9',
    );
  });

  it('keeps the reader in their own language', () => {
    /*
     * An internal navigation must not drop the locale prefix: doing so sends the reader
     * through `proxy.ts` and back to whatever their cookie says, which is a redirect at
     * best and a different language mid-session at worst. The contrast with a *share* link
     * — which deliberately carries no locale — is in the file's own header.
     */
    for (const locale of ['th', 'en', 'de'] as const) {
      expect(configureHref(locale, line({ productSlug: 'a-slug' }))).toBe(
        `/${locale}/products/a-slug?line=9f8ab408-34aa-4a7d-ab86-60f8848f86b9`,
      );
    }
  });

  it('carries the line id, which is what makes it an edit rather than a new window', () => {
    const href = configureHref('th', line({ productSlug: 's', lineId: 'other-line' }));
    expect(href).toContain('?line=other-line');
  });
});
