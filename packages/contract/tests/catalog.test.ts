import { describe, expect, it } from 'vitest';
import { categories, products } from '@wewin/core/fixtures';
import type { Product } from '@wewin/core';
import {
  decodeProduct,
  decodeProductDocument,
  encodeCategory,
  encodeProduct,
  encodeProductDocument,
  isCatalogRefFresh,
  productWireSchema,
  referencedGroupCodes,
  toCategory,
} from '../src/catalog.js';

/**
 * Everything here goes through `JSON.parse(JSON.stringify(...))` rather than handing
 * the encoded object straight to the decoder. The round trip is the claim: an object
 * that only survives in-process proves nothing about a payload that crossed a socket.
 */
const wire = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

// A real uuid and a real hex digest: the schemas pin both formats, and a placeholder
// that could never come out of the server would only ever test itself.
const ref = {
  productVersionId: '3f1c9d2e-5b47-4a10-9c8e-71d2f0a6b3e4',
  documentHash: 'a'.repeat(64),
};

describe('the product document', () => {
  it('round-trips all 81 catalogue products byte for byte in meaning', () => {
    expect(products).toHaveLength(81);

    for (const product of products) {
      const decoded: Product = decodeProduct(wire(encodeProduct(product)));
      expect(decoded).toEqual(product);
    }
  });

  /*
   * ⭐ 0052. The 81 catalogue products have no gallery, so the round trip above passes over
   * `images` and `videoUrl` without ever touching them — which is exactly how `encodeProduct`
   * came to drop both fields on the floor with a green suite and a clean typecheck. This is
   * the test that makes the four separate spellings of "what a product has" agree.
   */
  it('⭐ round-trips a gallery and a video link, in order', () => {
    const withMedia: Product = {
      ...(products[0] as Product),
      images: ['/media/11111111-1111-4111-8111-111111111111', '/products/b.svg'],
      videoUrl: 'https://www.youtube.com/watch?v=abc',
    };

    const decoded = decodeProduct(wire(encodeProduct(withMedia)));

    expect(decoded.images).toStrictEqual([
      '/media/11111111-1111-4111-8111-111111111111',
      '/products/b.svg',
    ]);
    expect(decoded.videoUrl).toBe('https://www.youtube.com/watch?v=abc');
    expect(decoded).toEqual(withMedia);
  });

  it('⚠️ a product with no gallery encodes exactly as it did before 0052', () => {
    /*
     * Absent must stay absent rather than become `[]` or `null`. `documentHash` is computed
     * over this shape, so an encoder that helpfully filled in an empty list would move the
     * hash of all 81 published products and invalidate every stored catalogue reference.
     */
    const encoded = encodeProduct(products[0] as Product) as unknown as Record<string, unknown>;

    expect('images' in encoded).toBe(false);
    expect('videoUrl' in encoded).toBe(false);
  });

  it('round-trips the categories', () => {
    for (const category of categories) {
      expect(toCategory(categoryWire(category))).toEqual(category);
    }
  });

  it('carries the handle a priced request has to send back', () => {
    const document = { ...ref, product: products[0] as Product };
    const decoded = decodeProductDocument(wire(encodeProductDocument(document)));

    expect(decoded.productVersionId).toBe(ref.productVersionId);
    expect(decoded.documentHash).toBe(ref.documentHash);
    expect(decoded.product).toEqual(products[0]);
    expect(isCatalogRefFresh(decoded, ref)).toBe(true);
    expect(isCatalogRefFresh(decoded, { ...ref, documentHash: 'b'.repeat(64) })).toBe(false);
  });

  it('refuses a handle that is not the shape the server issues', () => {
    const document = { ...ref, product: products[0] as Product };
    const encoded = wire(encodeProductDocument(document)) as Record<string, unknown>;

    /*
     * These were `z.string().min(1)` while the server side was still being built, which
     * meant the wire accepted handles the server could never have produced. The version
     * id reaches a Postgres `uuid` comparison, where a non-uuid is a 22P02 from the
     * driver — a 500 for what is plainly a bad request — and two spellings of one digest
     * are two digests, so the case is pinned too.
     */
    for (const bad of ['pv_01J8Z', '', '3f1c9d2e5b474a109c8e71d2f0a6b3e4', 'not-a-uuid']) {
      expect(() => decodeProductDocument({ ...encoded, productVersionId: bad })).toThrow();
    }
    for (const bad of ['sha256:abc123', '', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)]) {
      expect(() => decodeProductDocument({ ...encoded, documentHash: bad })).toThrow();
    }
  });

  it('puts no bare number where an exact quantity belongs', () => {
    const awning = product('awn-4t');
    const json = JSON.stringify(encodeProduct(awning));

    expect(json).toContain('"minBillableSqUm":{"unit":"um2"');
    expect(json).toContain('"minUm":{"unit":"um"');
    // The catalogue writes ฿1,500/m²; the document carries the satang the database
    // column holds, and says so.
    expect(awning.pricePerSqm).toBe(1500);
    expect(json).toContain('"pricePerSqm":{"unit":"THB.satang/m2","digits":"150000"}');
  });

  it('rejects a measurement whose unit is the one on the customer’s screen', () => {
    const encoded = wire(encodeProduct(product('awn-4t'))) as {
      groups: { code: string; minUm?: { unit: string; digits: string } }[];
    };
    const width = encoded.groups.find((group) => group.code === 'width');
    expect(width?.minUm).toBeDefined();
    // 60 cm and 60 µm both read as a number a window could be described by. Only one
    // of them is a window.
    if (width?.minUm) width.minUm = { unit: 'cm', digits: '60' };

    expect(productWireSchema.safeParse(encoded).success).toBe(false);
  });

  it('refuses to publish a price core could not reproduce', () => {
    // Both ends refuse rather than one rounding: rounding on the way out would publish
    // a figure the server itself cannot price, since `calcPrice` reaches
    // `BigInt(product.pricePerSqm)` (pricing.ts:196).
    const fractional = { ...product('awn-4t'), pricePerSqm: 1500.5 };
    expect(() => encodeProduct(fractional)).toThrow(/core cannot price/);
  });

  it('refuses a price core would then throw on', () => {
    const encoded = wire(encodeProduct(product('awn-4t'))) as {
      pricePerSqm: { unit: string; digits: string };
    };
    // ฿1,200.50 per m². `calcPrice` reaches `BigInt(product.pricePerSqm)`, and
    // `BigInt(1200.5)` throws — better to name the field here than to crash there.
    encoded.pricePerSqm = { unit: 'THB.satang/m2', digits: '120050' };

    expect(() => decodeProduct(encoded)).toThrow(/not a whole baht/);
  });

  it('carries percent deltas as basis points and refuses a fractional percent', () => {
    const withPercent = products.find((candidate) =>
      candidate.groups.some(
        (group) =>
          group.kind === 'sku' && group.values.some((value) => value.delta.type === 'percent'),
      ),
    );
    expect(withPercent).toBeDefined();
    if (!withPercent) return;

    const json = JSON.stringify(encodeProduct(withPercent));
    expect(json).toContain('"unit":"bp"');
    expect(json).toMatch(/"unit":"bp","digits":"(?:500|800)"/);

    const encoded = wire(encodeProduct(withPercent)) as {
      groups: { values?: { delta: { type: string; amount?: { unit: string; digits: string } } }[] }[];
    };
    for (const group of encoded.groups) {
      for (const value of group.values ?? []) {
        if (value.delta.type === 'percent') value.delta.amount = { unit: 'bp', digits: '850' };
      }
    }
    expect(() => decodeProduct(encoded)).toThrow(/not a whole percent/);
  });

  it('gives a rule constant its dimension through its unit, not beside it', () => {
    const json = JSON.stringify(encodeProduct(product('awn-4t')));
    // A length constant is micrometres and an area constant is square micrometres, so
    // `{ value: 200n, dim: 'scalar' }` for a width — rule.ts:20-28's warning — has no
    // encoding at all.
    expect(json).toMatch(/"n":"const","value":\{"unit":"(?:um|um2|count)"/);
    expect(json).not.toContain('"dim"');
  });

  it('derives the referenced group codes, and every one of them exists', () => {
    for (const candidate of products) {
      const codes = new Set(candidate.groups.map((group) => group.code));
      for (const rule of candidate.rules) {
        const referenced = referencedGroupCodes(rule.when);
        // Plan 5 wants this column as a handle for integrity checks; a handle that
        // named a group the product does not have would be worse than none.
        for (const code of referenced) expect([rule.id, codes.has(code)]).toEqual([rule.id, true]);
        // Sorted and deduplicated, so re-compiling one document twice hashes the same.
        expect(referenced).toEqual([...new Set(referenced)].sort());
      }
    }
  });
});

function product(slug: string): Product {
  const found = products.find((candidate) => candidate.slug === slug);
  if (!found) throw new Error(`test fixture missing product "${slug}"`);
  return found;
}

function categoryWire(category: (typeof categories)[number]): ReturnType<typeof encodeCategory> {
  return JSON.parse(JSON.stringify(encodeCategory(category))) as ReturnType<typeof encodeCategory>;
}
