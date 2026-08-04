import { Body, Controller, Get, Header, HttpCode, Param, Patch, Post, Put } from '@nestjs/common';
import { CONTRACT_VERSION, CONTRACT_VERSION_HEADER } from '@wewin/contract/version';
import {
  createOptionGroupRequestSchema,
  createOptionValueRequestSchema,
  setOptionValueAvailabilityRequestSchema,
  updateOptionGroupRequestSchema,
  updateOptionValueRequestSchema,
  type AdminOptionGroupListWire,
  type CreateOptionGroupRequestWire,
  type CreateOptionValueRequestWire,
  type SetOptionValueAvailabilityRequestWire,
  type UpdateOptionGroupRequestWire,
  type UpdateOptionValueRequestWire,
} from '@wewin/contract/admin';

import { RequirePermissions } from '../rbac';
import { OptionCatalogService } from './option-catalog.service';
import { ZodBodyPipe } from './zod-body.pipe';

/**
 * The shared option catalogue — groups and their values, independent of any product.
 *
 *     GET   /admin/catalog/option-groups
 *     POST  /admin/catalog/option-groups
 *     PATCH /admin/catalog/option-groups/:group
 *     POST  /admin/catalog/option-groups/:group/values
 *     PATCH /admin/catalog/option-groups/:group/values/:value
 *     PUT   /admin/catalog/option-groups/:group/values/:value/availability
 *
 * Availability is its own route, and that is the plan-5-point-2 decision made visible: it
 * is the only write in this whole module that changes what a customer sees without a
 * publish, because stock is deliberately the one catalogue fact the frozen document does
 * not carry. Everything else here affects the *next* compile of each draft that uses it and
 * nothing already published.
 *
 * There is no DELETE. A value that any version ever offered is referenced by
 * `product_version_option_values`, whose foreign key is `ON DELETE RESTRICT`, so deleting
 * it would fail against every archived version that still mentions it — which is correct,
 * since those versions are what old orders were quoted from. Withdrawing a value is
 * `available: false` plus removing it from the drafts that offer it.
 */

const contractVersion = (): MethodDecorator =>
  Header(CONTRACT_VERSION_HEADER, String(CONTRACT_VERSION));

@Controller('admin/catalog/option-groups')
export class OptionCatalogController {
  constructor(private readonly options: OptionCatalogService) {}

  @Get()
  @contractVersion()
  @RequirePermissions('catalog.read')
  async list(): Promise<AdminOptionGroupListWire> {
    return this.options.list();
  }

  @Post()
  @HttpCode(204)
  @RequirePermissions('catalog.write')
  async createGroup(
    @Body(new ZodBodyPipe(createOptionGroupRequestSchema)) request: CreateOptionGroupRequestWire,
  ): Promise<void> {
    await this.options.createGroup(request);
  }

  @Patch(':groupCode')
  @HttpCode(204)
  @RequirePermissions('catalog.write')
  async updateGroup(
    @Param('groupCode') groupCode: string,
    @Body(new ZodBodyPipe(updateOptionGroupRequestSchema)) request: UpdateOptionGroupRequestWire,
  ): Promise<void> {
    await this.options.updateGroup(groupCode, request);
  }

  @Post(':groupCode/values')
  @HttpCode(204)
  @RequirePermissions('catalog.write')
  async createValue(
    @Param('groupCode') groupCode: string,
    @Body(new ZodBodyPipe(createOptionValueRequestSchema)) request: CreateOptionValueRequestWire,
  ): Promise<void> {
    await this.options.createValue(groupCode, request);
  }

  @Patch(':groupCode/values/:valueCode')
  @HttpCode(204)
  @RequirePermissions('catalog.write')
  async updateValue(
    @Param('groupCode') groupCode: string,
    @Param('valueCode') valueCode: string,
    @Body(new ZodBodyPipe(updateOptionValueRequestSchema)) request: UpdateOptionValueRequestWire,
  ): Promise<void> {
    await this.options.updateValue(groupCode, valueCode, request);
  }

  /**
   * Stock.
   *
   * `PUT` and not `PATCH`: the request states the whole of what it sets, there is exactly
   * one field, and sending it twice is the same as sending it once — which is what a
   * dashboard toggle needs when the network is unreliable.
   */
  @Put(':groupCode/values/:valueCode/availability')
  @HttpCode(204)
  @RequirePermissions('catalog.write')
  async setAvailability(
    @Param('groupCode') groupCode: string,
    @Param('valueCode') valueCode: string,
    @Body(new ZodBodyPipe(setOptionValueAvailabilityRequestSchema))
    request: SetOptionValueAvailabilityRequestWire,
  ): Promise<void> {
    await this.options.setAvailability(groupCode, valueCode, request);
  }
}
