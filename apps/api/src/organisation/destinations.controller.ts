import { Controller, Get, Header } from '@nestjs/common';
import { CONTRACT_VERSION, CONTRACT_VERSION_HEADER } from '@wewin/contract/version';
import type { DestinationWire } from '@wewin/contract/tax';

import { AllowAnonymous } from '../rbac';
import { TaxCountryService } from './tax-country.service';

const contractVersion = (): MethodDecorator =>
  Header(CONTRACT_VERSION_HEADER, String(CONTRACT_VERSION));

/**
 * Not under `/admin`, and that is load-bearing twice.
 *
 * `apps/api/tests/admin/route-permissions.test.ts` selects routes by `/admin` prefix and
 * asserts its table both ways, so an anonymous route under `/admin` would fail it. And a
 * customer must pick a destination *before* an order exists, so P1's order-scoping — the
 * shape it chose instead of publishing bank accounts — is unavailable here. What is withheld
 * instead is the policy: rate, treatment and basis never leave the admin routes.
 */
@Controller('destinations')
export class DestinationsController {
  constructor(private readonly taxCountries: TaxCountryService) {}

  @Get()
  /* The reason is mandatory and the boot-time route audit prints it. */
  @AllowAnonymous('a customer must choose a destination before an order exists')
  @contractVersion()
  async list(): Promise<DestinationWire[]> {
    const rows = await this.taxCountries.list(true);
    return rows.map((row) => ({ code: row.code, nameTh: row.nameTh }));
  }
}
