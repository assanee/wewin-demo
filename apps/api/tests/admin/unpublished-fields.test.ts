import { describe, expect, it } from 'vitest';

import { toDocument } from '@wewin/db/compile';
import type { CatalogDocumentV1 } from '@wewin/db/document';
import { products as fixtureProducts } from '@wewin/core/fixtures';
import type { Product } from '@wewin/core';

import { unpublishedFieldsOf } from '../../src/admin/catalog-admin.service';
import type { DraftProductRow } from '../../src/admin/draft-document';

/**
 * ⭐ 0052. What the badge on the product list is counting.
 *
 * `unpublishedFieldsOf` answers "which of this product's fields differ from what customers
 * are being shown", and its answer is the only thing standing between a person and the
 * belief that their edit is live. It had no unit test — the two `.pg` suites reach it only
 * through a list endpoint that asserts the products come back.
 *
 * ⛔ The reason it gets one now: the gallery is the sixth hand-maintained list of "the
 * fields a product has" in this codebase, and two of the previous five silently dropped it
 * (see the commit that added `productFieldsShape`). Here the failure would be quieter than
 * either — not a refused request or a missing key, but a screen that says *nothing has
 * changed* about a product whose every picture was replaced.
 */

const PRODUCT = fixtureProducts[0] as Product;

/** The editable row, as the repository hands it over. */
const rowOf = (over: Partial<DraftProductRow> = {}): DraftProductRow => ({
  id: PRODUCT.id,
  slug: PRODUCT.slug,
  skuPrefix: PRODUCT.skuPrefix,
  categoryId: PRODUCT.categoryId,
  nameTh: PRODUCT.nameTh,
  summaryTh: PRODUCT.summaryTh,
  heroImage: PRODUCT.heroImage,
  leadTimeMinDays: PRODUCT.leadTimeDays[0],
  leadTimeMaxDays: PRODUCT.leadTimeDays[1],
  pricePerSqmMinor: BigInt(PRODUCT.pricePerSqm) * 100n,
  minBillableSqUm: PRODUCT.minBillableSqUm,
  elevation: PRODUCT.elevation,
  videoUrl: null,
  ...over,
});

/** The frozen document, as a publish wrote it. */
const publishedOf = (over: Partial<Product> = {}): CatalogDocumentV1 =>
  toDocument({ ...PRODUCT, ...over });

const A = '/media/11111111-1111-4111-8111-111111111111';
const B = '/media/22222222-2222-4222-8222-222222222222';

describe('which fields are edited but not published', () => {
  it('⚠️ a product frozen before 0052 existed reports nothing about pictures', () => {
    /*
     * The case every one of the 83 documents in `product_versions` is in today: the key is
     * absent from the document entirely. Read as "no pictures" — not as "unknown", which
     * would put a permanent unpublished badge on all 81 products.
     */
    const published = publishedOf();
    expect('images' in published).toBe(false);

    expect(unpublishedFieldsOf(rowOf(), [], published)).toStrictEqual([]);
  });

  it('⭐ adding the first picture is an unpublished change', () => {
    expect(unpublishedFieldsOf(rowOf(), [A], publishedOf())).toStrictEqual(['images']);
  });

  it('⭐ reordering is an unpublished change — order is content', () => {
    const published = publishedOf({ images: [A, B] });

    expect(unpublishedFieldsOf(rowOf(), [A, B], published)).toStrictEqual([]);
    expect(unpublishedFieldsOf(rowOf(), [B, A], published)).toStrictEqual(['images']);
  });

  it('⭐ removing every picture is an unpublished change', () => {
    expect(unpublishedFieldsOf(rowOf(), [], publishedOf({ images: [A] }))).toStrictEqual([
      'images',
    ]);
  });

  it('⭐ the video link, set and cleared', () => {
    const withVideo = publishedOf({ videoUrl: 'https://www.youtube.com/watch?v=abc' });

    expect(unpublishedFieldsOf(rowOf({ videoUrl: null }), [], withVideo)).toStrictEqual([
      'videoUrl',
    ]);
    expect(
      unpublishedFieldsOf(rowOf({ videoUrl: 'https://www.youtube.com/watch?v=abc' }), [], withVideo),
    ).toStrictEqual([]);
    expect(
      unpublishedFieldsOf(rowOf({ videoUrl: 'https://vimeo.com/1' }), [], publishedOf()),
    ).toStrictEqual(['videoUrl']);
  });

  it('⚠️ a product with no draft edits at all reports nothing', () => {
    /*
     * The guard on the whole function: if this ever returns a field for an untouched
     * product, every product on the list wears a badge and the badge stops meaning anything.
     */
    expect(unpublishedFieldsOf(rowOf(), [], publishedOf())).toStrictEqual([]);
  });

  it('⚠️ never-published products have nothing to differ from', () => {
    expect(unpublishedFieldsOf(rowOf(), [A, B], null)).toStrictEqual([]);
  });
});
