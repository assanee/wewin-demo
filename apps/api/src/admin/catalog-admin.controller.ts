import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import { CONTRACT_VERSION, CONTRACT_VERSION_HEADER } from '@wewin/contract/version';
import {
  createProductRequestSchema,
  publishDraftRequestSchema,
  putDraftOptionRequestSchema,
  putDraftRuleRequestSchema,
  updateProductDraftRequestSchema,
  type AdminProductListWire,
  type AdminProductWire,
  type CreateProductRequestWire,
  type DraftWire,
  type PublishDraftRequestWire,
  type PublishResultWire,
  type PutDraftOptionRequestWire,
  type PutDraftRuleRequestWire,
  type UpdateProductDraftRequestWire,
} from '@wewin/contract/admin';

import { RequirePermissions } from '../rbac';
import { CatalogAdminService } from './catalog-admin.service';
import { ZodBodyPipe } from './zod-body.pipe';

/**
 * The dashboard's catalogue endpoints.
 *
 * The URL space is the model, and it is worth reading as one thing before reading any
 * handler:
 *
 *     GET    /admin/catalog/products                          what exists, and its state
 *     POST   /admin/catalog/products                          a product and its first draft
 *     GET    /admin/catalog/products/:id                      one product: published + draft
 *     POST   /admin/catalog/products/:id/draft                open the next version
 *     GET    /admin/catalog/products/:id/draft                the draft, compiled
 *     PATCH  /admin/catalog/products/:id/draft                product-level fields
 *     PUT    /admin/catalog/products/:id/draft/options/:group one group's offer
 *     DELETE /admin/catalog/products/:id/draft/options/:group
 *     PUT    /admin/catalog/products/:id/draft/rules/:rule    one rule
 *     DELETE /admin/catalog/products/:id/draft/rules/:rule
 *     DELETE /admin/catalog/products/:id/draft                throw the draft away
 *     POST   /admin/catalog/products/:id/draft/publish        freeze it
 *
 * **There is no route that addresses a published version.** Not because one was left out,
 * but because there is nothing a caller could do with it: the document is frozen by a
 * trigger, the rows it was compiled from are frozen by three more, and un-publishing would
 * leave every order that points at that version pointing at a draft. A caller who wants a
 * product to change opens a draft, and the shape of this table is the only documentation
 * of that fact anybody needs.
 *
 * **Every mutation carries `expectedDocumentHash`.** It is plan 5 point 5 turned inward:
 * the storefront sends back the hash it was priced from and gets 409 when a publish moved
 * under it; here it is a colleague rather than a publish, and the same field turns "last
 * write wins over an option list" into a reload.
 *
 * Permissions: reads need `catalog.read`, writes need `catalog.write`, and publishing needs
 * `catalog.publish` — which is a *separate* permission on purpose. Editing a draft is
 * reversible and affects nobody; publishing changes what every customer is quoted, and the
 * two are jobs that different people do. Every one of these is declared on the handler, so
 * the boot audit sees a decorator and not a line in `route-declarations.ts`; a new endpoint
 * added here without one stops the process from starting.
 */

const contractVersion = (): MethodDecorator =>
  Header(CONTRACT_VERSION_HEADER, String(CONTRACT_VERSION));

/**
 * A `DELETE` states which draft it means the same way every other mutation does.
 *
 * In the query string rather than a body: a body on `DELETE` has no defined semantics, is
 * dropped by some proxies, and is the kind of thing an HTTP client library makes awkward
 * for no benefit. The value is the same hash, checked the same way.
 */
const expectedHashQuerySchema = z.object({
  expectedDocumentHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/, 'must be a lowercase hex SHA-256 digest'),
});

type ExpectedHashQuery = z.infer<typeof expectedHashQuerySchema>;

@Controller('admin/catalog')
export class CatalogAdminController {
  constructor(private readonly catalog: CatalogAdminService) {}

  @Get('products')
  @contractVersion()
  @RequirePermissions('catalog.read')
  async list(): Promise<AdminProductListWire> {
    return this.catalog.listProducts();
  }

  @Get('products/:productId')
  @contractVersion()
  @RequirePermissions('catalog.read')
  async product(@Param('productId') productId: string): Promise<AdminProductWire> {
    return this.catalog.getProduct(productId);
  }

  @Post('products')
  @contractVersion()
  @RequirePermissions('catalog.write')
  async create(
    @Body(new ZodBodyPipe(createProductRequestSchema)) request: CreateProductRequestWire,
  ): Promise<DraftWire> {
    return this.catalog.createProduct(request);
  }

  @Get('products/:productId/draft')
  @contractVersion()
  @RequirePermissions('catalog.read')
  async draft(@Param('productId') productId: string): Promise<DraftWire> {
    return this.catalog.getDraft(productId);
  }

  @Post('products/:productId/draft')
  @contractVersion()
  @RequirePermissions('catalog.write')
  async openDraft(@Param('productId') productId: string): Promise<DraftWire> {
    return this.catalog.openDraft(productId);
  }

  @Patch('products/:productId/draft')
  @contractVersion()
  @RequirePermissions('catalog.write')
  async updateDraft(
    @Param('productId') productId: string,
    @Body(new ZodBodyPipe(updateProductDraftRequestSchema)) request: UpdateProductDraftRequestWire,
  ): Promise<DraftWire> {
    return this.catalog.updateDraft(productId, request);
  }

  @Delete('products/:productId/draft')
  @HttpCode(204)
  @RequirePermissions('catalog.write')
  async discardDraft(
    @Param('productId') productId: string,
    @Query(new ZodBodyPipe(expectedHashQuerySchema)) query: ExpectedHashQuery,
  ): Promise<void> {
    await this.catalog.discardDraft(productId, query.expectedDocumentHash);
  }

  @Put('products/:productId/draft/options/:groupCode')
  @contractVersion()
  @RequirePermissions('catalog.write')
  async putOption(
    @Param('productId') productId: string,
    @Param('groupCode') groupCode: string,
    @Body(new ZodBodyPipe(putDraftOptionRequestSchema)) request: PutDraftOptionRequestWire,
  ): Promise<DraftWire> {
    return this.catalog.putOption(productId, groupCode, request);
  }

  @Delete('products/:productId/draft/options/:groupCode')
  @contractVersion()
  @RequirePermissions('catalog.write')
  async deleteOption(
    @Param('productId') productId: string,
    @Param('groupCode') groupCode: string,
    @Query(new ZodBodyPipe(expectedHashQuerySchema)) query: ExpectedHashQuery,
  ): Promise<DraftWire> {
    return this.catalog.deleteOption(productId, groupCode, query.expectedDocumentHash);
  }

  @Put('products/:productId/draft/rules/:ruleCode')
  @contractVersion()
  @RequirePermissions('catalog.write')
  async putRule(
    @Param('productId') productId: string,
    @Param('ruleCode') ruleCode: string,
    @Body(new ZodBodyPipe(putDraftRuleRequestSchema)) request: PutDraftRuleRequestWire,
  ): Promise<DraftWire> {
    return this.catalog.putRule(productId, ruleCode, request);
  }

  @Delete('products/:productId/draft/rules/:ruleCode')
  @contractVersion()
  @RequirePermissions('catalog.write')
  async deleteRule(
    @Param('productId') productId: string,
    @Param('ruleCode') ruleCode: string,
    @Query(new ZodBodyPipe(expectedHashQuerySchema)) query: ExpectedHashQuery,
  ): Promise<DraftWire> {
    return this.catalog.deleteRule(productId, ruleCode, query.expectedDocumentHash);
  }

  /**
   * Freeze the draft.
   *
   * `catalog.publish` and not `catalog.write`: this is the one action on this controller
   * that changes what a customer is quoted, and plan section 6 makes permissions the single
   * source of truth for who may do what. A dashboard that hides the button from somebody
   * without this permission is being tidy; this decorator is what makes it authorisation.
   */
  @Post('products/:productId/draft/publish')
  @contractVersion()
  @RequirePermissions('catalog.publish')
  async publish(
    @Param('productId') productId: string,
    @Body(new ZodBodyPipe(publishDraftRequestSchema)) request: PublishDraftRequestWire,
  ): Promise<PublishResultWire> {
    return this.catalog.publish(productId, request);
  }
}
