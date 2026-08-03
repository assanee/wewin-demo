import { Controller, Get, Inject } from '@nestjs/common';

import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { CatalogSourceService, type CatalogSourceInfo } from './catalog-source';

export interface MetaResponse {
  readonly service: 'wewin-api';
  readonly version: string;
  readonly environment: Env['NODE_ENV'];
  readonly catalog: CatalogSourceInfo;
}

/**
 * What is running and what conventions it speaks.
 *
 * It does touch the database now — counting what is published, rather than counting the
 * TS table it used to import and calling that the catalogue. It never fails on it:
 * `catalog.counts` goes null and the rest of the answer stands, because "which build is
 * this" has to stay answerable during the outage you are asking it during.
 */
@Controller('meta')
export class MetaController {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly catalog: CatalogSourceService,
  ) {}

  @Get()
  async meta(): Promise<MetaResponse> {
    return {
      service: 'wewin-api',
      version: this.env.SERVICE_VERSION,
      environment: this.env.NODE_ENV,
      catalog: await this.catalog.info(),
    };
  }
}
