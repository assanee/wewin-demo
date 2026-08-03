import { describe, expect, it } from 'vitest';
import { getProductBySlug } from '@wewin/core/fixtures';
import type { Product } from '@wewin/core';
import {
  CATALOG_STALE,
  CATALOG_STALE_STATUS,
  catalogStaleBody,
  catalogStaleBodySchema,
  isCatalogStaleBody,
} from '../src/errors.js';
import { isCatalogRefFresh, toProductDocument } from '../src/catalog.js';
import { CONTRACT_VERSION, CONTRACT_VERSION_HEADER } from '../src/version.js';

const wire = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

function fixture(slug: string): Product {
  const product = getProductBySlug(slug);
  if (!product) throw new Error(`test fixture missing product "${slug}"`);
  return product;
}

// Real formats, because the schemas pin them: a uuid version id and a lowercase hex
// SHA-256 digest are what the server produces, and a placeholder that could never come
// out of it would only ever be testing itself.
const OLD_ID = '1b0f8c73-2d4a-4e91-8f6c-0a5b7d9e3c21';
const NEW_ID = '9e2d4a17-6c83-4b05-a71f-3d8c5e0b4f92';
const OLD_HASH = '0'.repeat(64);
const NEW_HASH = 'f'.repeat(64);

const sent = { productVersionId: OLD_ID, documentHash: OLD_HASH };
const current = {
  productVersionId: NEW_ID,
  documentHash: NEW_HASH,
  product: fixture('awn-4t'),
};

describe('the stale-document conflict', () => {
  it('is 409 and names itself', () => {
    expect(CATALOG_STALE_STATUS).toBe(409);
    expect(CATALOG_STALE).toBe('catalog_stale');
  });

  it('detects the mismatch on either half of the handle', () => {
    expect(isCatalogRefFresh(sent, sent)).toBe(true);
    expect(isCatalogRefFresh(sent, { ...sent, documentHash: NEW_HASH })).toBe(false);
    // A version republished in place keeps its id and changes its hash; a new version
    // changes its id. Checking only one of them misses one of the two.
    expect(isCatalogRefFresh(sent, { ...sent, productVersionId: NEW_ID })).toBe(false);
  });

  it('answers with the fresh document, not only with the refusal', () => {
    const body = wire(catalogStaleBody(sent, current));
    const parsed = catalogStaleBodySchema.parse(body);

    expect(parsed.sent).toEqual(sent);
    expect(isCatalogStaleBody(body)).toBe(true);

    // The client can re-render straight from the 409 — no second round trip at the
    // moment a publish has just made every open configurator ask at once.
    const document = toProductDocument(parsed.current);
    expect(document.productVersionId).toBe(NEW_ID);
    expect(document.product).toEqual(current.product);
    expect(isCatalogRefFresh(sent, document)).toBe(false);
  });

  it('is not confused with any other 409 a client might receive', () => {
    expect(isCatalogStaleBody({ error: 'catalog_stale' })).toBe(false);
    expect(isCatalogStaleBody('Conflict')).toBe(false);
    expect(isCatalogStaleBody(null)).toBe(false);
  });
});

describe('the contract version', () => {
  it('travels in a header, not in the body it describes', () => {
    expect(CONTRACT_VERSION).toBe(1);
    expect(CONTRACT_VERSION_HEADER).toBe('x-wewin-contract-version');

    // A version buried in the payload is read under the same rules the payload is in
    // question about — which is exactly the failure `parseStoredQuote` guards against
    // by discarding the whole payload rather than salvaging part of it (quote.ts:355).
    const body = wire(catalogStaleBody(sent, current));
    expect(JSON.stringify(body)).not.toContain('contractVersion');
  });
});
