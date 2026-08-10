import { Body, Controller, Get, Header, HttpCode, Param, Patch, Post, Put } from '@nestjs/common';
import { CONTRACT_VERSION, CONTRACT_VERSION_HEADER } from '@wewin/contract/version';
import {
  availabilitySchema,
  bankAccountCreateSchema,
  bankAccountPatchSchema,
  organisationProfilePutSchema,
  type AvailabilityRequestWire,
  type BankAccountChangeWire,
  type BankAccountCreateRequestWire,
  type BankAccountPatchRequestWire,
  type BankAccountWire,
  type OrganisationProfilePutRequestWire,
  type OrganisationProfileWire,
} from '@wewin/contract/organisation';
import {
  taxCountryAvailabilitySchema,
  taxCountryCreateSchema,
  taxCountryPatchSchema,
  type SettingChangeWire,
  type TaxCountryAvailabilityRequest,
  type TaxCountryCreateRequest,
  type TaxCountryPatchRequest,
  type TaxCountryWire,
} from '@wewin/contract/tax';

import { ZodBodyPipe } from '../admin/zod-body.pipe';
import { AppError } from '../common/errors/app-error';
import { message } from '../i18n';
import { CurrentScope, RequirePermissions, type Scope } from '../rbac';
import { encodeAccount, encodeChange, encodeProfile } from './encode';
import { OrganisationRepository } from './organisation.repository';
import { OrganisationService } from './organisation.service';
import { TaxCountryService } from './tax-country.service';

const contractVersion = (): MethodDecorator =>
  Header(CONTRACT_VERSION_HEADER, String(CONTRACT_VERSION));

/**
 * The company's own profile, the bank accounts it is paid into, and the destinations it
 * sells to.
 *
 *     GET   /admin/organisation
 *     PUT   /admin/organisation
 *     GET   /admin/organisation/bank-accounts
 *     POST  /admin/organisation/bank-accounts
 *     PATCH /admin/organisation/bank-accounts/:id
 *     PUT   /admin/organisation/bank-accounts/:id/availability
 *     GET   /admin/organisation/bank-accounts/:id/changes
 *     GET   /admin/organisation/tax-countries
 *     POST  /admin/organisation/tax-countries
 *     PATCH /admin/organisation/tax-countries/:code
 *     PUT   /admin/organisation/tax-countries/:code/availability
 *     GET   /admin/organisation/tax-countries/:code/changes
 *
 * `availability` is its own route rather than a field `patchAccount`/`patchTaxCountry` also
 * accepts, the same shape decision `option-catalog.controller.ts` makes for stock: it is the
 * one write here a client must never be able to smuggle in beside an unrelated edit, and
 * `bankAccountPatchSchema`/`taxCountryPatchSchema` enforce that by refusing the field outright.
 * `OrganisationService.setAvailability`/`TaxCountryService.setAvailability` both reuse their
 * own patch path with a cast rather than a second write, so a deactivation is recorded in
 * `bank_account_changes`/`tax_country_changes` exactly like any other change — see those files.
 *
 * The five tax-country routes reuse `organisation.read`/`organisation.write` rather than a
 * new permission pair: tax settings are company settings, the same authority as the bank
 * accounts beside them. `TaxCountryService` already wraps its own writes in
 * `withTranslatedOrganisationErrors` (`pg-errors.ts`), so these handlers call it and return —
 * a second `try`/`catch` here would only re-wrap an already-translated `AppError`.
 *
 * The public, anonymous read a storefront needs before an order exists — `GET /destinations`
 * — is deliberately not here: see `destinations.controller.ts` for why it cannot share this
 * controller's `/admin` prefix.
 */
@Controller('admin/organisation')
export class OrganisationController {
  constructor(
    private readonly organisation: OrganisationService,
    private readonly repository: OrganisationRepository,
    private readonly taxCountries: TaxCountryService,
  ) {}

  @Get()
  @contractVersion()
  @RequirePermissions('organisation.read')
  async profile(): Promise<OrganisationProfileWire> {
    const [row] = await this.repository.profile();
    if (row === undefined) throw AppError.notFound(message('error.organisation.profile_missing'));
    return encodeProfile(row);
  }

  @Put()
  @contractVersion()
  @RequirePermissions('organisation.write')
  async putProfile(
    @CurrentScope() scope: Scope,
    @Body(new ZodBodyPipe(organisationProfilePutSchema)) body: OrganisationProfilePutRequestWire,
  ): Promise<OrganisationProfileWire> {
    return encodeProfile(await this.organisation.putProfile(userIdOf(scope), body));
  }

  @Get('bank-accounts')
  @contractVersion()
  @RequirePermissions('organisation.read')
  async accounts(): Promise<{ readonly accounts: readonly BankAccountWire[] }> {
    const rows = await this.repository.allAccounts();
    return { accounts: rows.map(encodeAccount) };
  }

  @Post('bank-accounts')
  @HttpCode(201)
  @contractVersion()
  @RequirePermissions('organisation.write')
  async createAccount(
    @CurrentScope() scope: Scope,
    @Body(new ZodBodyPipe(bankAccountCreateSchema)) body: BankAccountCreateRequestWire,
  ): Promise<BankAccountWire> {
    return encodeAccount(await this.organisation.createAccount(userIdOf(scope), body));
  }

  @Patch('bank-accounts/:id')
  @contractVersion()
  @RequirePermissions('organisation.write')
  async patchAccount(
    @CurrentScope() scope: Scope,
    @Param('id') id: string,
    @Body(new ZodBodyPipe(bankAccountPatchSchema)) body: BankAccountPatchRequestWire,
  ): Promise<BankAccountWire> {
    return encodeAccount(await this.organisation.patchAccount(userIdOf(scope), id, body));
  }

  @Put('bank-accounts/:id/availability')
  @contractVersion()
  @RequirePermissions('organisation.write')
  async setAvailability(
    @CurrentScope() scope: Scope,
    @Param('id') id: string,
    @Body(new ZodBodyPipe(availabilitySchema)) body: AvailabilityRequestWire,
  ): Promise<BankAccountWire> {
    return encodeAccount(await this.organisation.setAvailability(userIdOf(scope), id, body.isActive));
  }

  @Get('bank-accounts/:id/changes')
  @contractVersion()
  @RequirePermissions('organisation.read')
  async changes(
    @Param('id') id: string,
  ): Promise<{ readonly changes: readonly BankAccountChangeWire[] }> {
    const rows = await this.repository.changes(id);
    return { changes: rows.map(encodeChange) };
  }

  /*
   * ── Tax countries ────────────────────────────────────────────────────────────
   *
   * Bare arrays, not `{ countries: [...] }` / `{ changes: [...] }` wrappers like the bank-
   * account routes above: `TaxCountryService.list`/`.changes` already return exactly
   * `TaxCountryWire[]` / `SettingChangeWire[]`, and wrapping them here would be an envelope
   * this task's interface never asked for.
   */

  @Get('tax-countries')
  @contractVersion()
  @RequirePermissions('organisation.read')
  async listTaxCountries(): Promise<TaxCountryWire[]> {
    // `false`: the admin list shows every destination, active or withdrawn.
    return this.taxCountries.list(false);
  }

  @Post('tax-countries')
  @HttpCode(201)
  @contractVersion()
  @RequirePermissions('organisation.write')
  async createTaxCountry(
    @CurrentScope() scope: Scope,
    @Body(new ZodBodyPipe(taxCountryCreateSchema)) body: TaxCountryCreateRequest,
  ): Promise<TaxCountryWire> {
    return this.taxCountries.create(body, userIdOf(scope));
  }

  @Patch('tax-countries/:code')
  @contractVersion()
  @RequirePermissions('organisation.write')
  async patchTaxCountry(
    @CurrentScope() scope: Scope,
    @Param('code') code: string,
    @Body(new ZodBodyPipe(taxCountryPatchSchema)) body: TaxCountryPatchRequest,
  ): Promise<TaxCountryWire> {
    return this.taxCountries.patch(code, body, userIdOf(scope));
  }

  @Put('tax-countries/:code/availability')
  @contractVersion()
  @RequirePermissions('organisation.write')
  async setTaxCountryAvailability(
    @CurrentScope() scope: Scope,
    @Param('code') code: string,
    @Body(new ZodBodyPipe(taxCountryAvailabilitySchema)) body: TaxCountryAvailabilityRequest,
  ): Promise<TaxCountryWire> {
    return this.taxCountries.setAvailability(code, body.isActive, userIdOf(scope));
  }

  @Get('tax-countries/:code/changes')
  @contractVersion()
  @RequirePermissions('organisation.read')
  async taxCountryChanges(@Param('code') code: string): Promise<SettingChangeWire[]> {
    return this.taxCountries.changes(code);
  }
}

/**
 * The staff user id behind this request.
 *
 * ⚠️ Deliberately local, and deliberately not `requireActor` from `orders/scope` or from
 * `payments/slips/slips.service.ts`. Both of those answer "who is acting — a customer, a
 * guest, staff, or the system itself", which is a real question in the orders domain because
 * a caller there might genuinely be any of the four. It is not a real question here: every
 * route on this controller is gated by `organisation.read` or `organisation.write`, so by the
 * time a handler runs the guard has already established `scope.kind === 'user'` — there is no
 * second case for this function to model, and importing an orders-domain type to restate a
 * fact the guard already settled would couple this module to that one for nothing.
 *
 * `media/media-admin.controller.ts`'s `userIdOf` answers the exact same question the exact
 * same way, for the exact same reason (a permission-gated admin route). This is a third
 * private copy of that shape, not a second — `orders.service.ts` and `slips.service.ts`
 * already each carry their own `requireActor`. Lifting the four into one shared helper is a
 * real refactor with its own review; it is not a side effect of adding a fourth call site.
 */
function userIdOf(scope: Scope): string {
  if (scope.kind !== 'user') {
    throw AppError.unauthenticated('การแก้ไขข้อมูลบริษัทต้องทำในนามผู้ใช้ที่ลงชื่อเข้าใช้แล้ว');
  }
  return scope.userId;
}
