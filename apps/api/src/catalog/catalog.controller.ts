import { Controller, Get, Header, Param } from '@nestjs/common';
import type { CategoryWire, ProductDocumentWire } from '@wewin/contract';
import { encodeCategory, encodeProductDocument } from '@wewin/contract/catalog';
import { CONTRACT_VERSION, CONTRACT_VERSION_HEADER } from '@wewin/contract/version';

import { AppError } from '../common/errors/app-error';
import { CatalogRepository, type PublishedProduct } from './catalog.repository';

/**
 * The catalogue, as published.
 *
 * Every response goes out through `@wewin/contract`'s encoders and never as a hand-built
 * object literal. That is what puts a unit on every exact quantity — `{"unit":"um",
 * "digits":"3200000"}` rather than a bare `3200000` a client is free to read as
 * millimetres — and it is why a bigint never reaches `JSON.stringify`, which would throw
 * on it. `tests/catalog-fidelity.pg.test.ts` decodes these bodies with the same package
 * and compares the result to the fixture table, so the two halves of the codec cannot
 * drift apart without a failure.
 *
 * `productVersionId` and `documentHash` ride along with each product because plan 5
 * point 5 requires them back on every price and order request; a client that never sees
 * them cannot send them.
 */

export interface ProductListResponse {
  readonly products: readonly ProductDocumentWire[];
}

export interface CategoryListResponse {
  readonly categories: readonly CategoryWire[];
}

const encode = (published: PublishedProduct): ProductDocumentWire =>
  encodeProductDocument({
    productVersionId: published.productVersionId,
    documentHash: published.documentHash,
    product: published.product,
  });

/*
 * `@Header` is a method decorator in Nest, so the contract version is stamped on each
 * route rather than once on the class. It is a header and not a field in the body for the
 * reason `@wewin/contract`'s version.ts gives: a client that misreads the body would
 * misread a version buried inside it too, and a proxy or a log line can read a header
 * regardless.
 */
const contractVersion = (): MethodDecorator =>
  Header(CONTRACT_VERSION_HEADER, String(CONTRACT_VERSION));

@Controller('catalog')
export class CatalogController {
  constructor(private readonly catalog: CatalogRepository) {}

  @Get('products')
  @contractVersion()
  async list(): Promise<ProductListResponse> {
    const published = await this.catalog.findAll();
    return { products: published.map(encode) };
  }

  @Get('products/:slug')
  @contractVersion()
  async bySlug(@Param('slug') slug: string): Promise<ProductDocumentWire> {
    const published = await this.catalog.findBySlug(slug);
    if (!published) {
      /*
       * 404 and not an empty document: a slug that has no *published* version is
       * indistinguishable here from one that never existed, and inventing a body for it
       * would let a configurator open on a product nobody can be quoted for.
       */
      throw AppError.notFound(`No published product with slug "${slug}".`, { slug });
    }
    return encode(published);
  }

  @Get('categories')
  @contractVersion()
  async categories(): Promise<CategoryListResponse> {
    const found = await this.catalog.findCategories();
    return { categories: found.map(encodeCategory) };
  }
}
