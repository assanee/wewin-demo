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
 *     GET   /admin/organisation/changes
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

  /**
   * ⭐ Who changed the company's settings, and what they changed them from.
   *
   * `organisation_profile_changes` had a **writer and no reader**. `putProfile` has recorded every
   * field of this row since D4 — including `depositBp` — and `bank_account_changes` and
   * `tax_country_changes` each got a `GET …/changes` route beside them, but this table's only
   * consumers were tests. A history nothing can read short of `psql` is not an audit trail; it is
   * a table that will be trusted to answer a question nobody can actually ask it.
   *
   * That stopped being cosmetic in task 12. `deposit_bp` is now an authority control — it is the
   * `cashflow` floor, so lowering it lowers what counts as a concession needing approval — and it
   * is behind `organisation.write`, which previously only governed letterhead and bank accounts.
   * Without this route the answer to *"who lowered the approval floor?"* is nobody, through any
   * product surface.
   *
   * Mirrors its two siblings exactly: `organisation.read`, a `{ changes }` envelope like every
   * other list-returning GET in this file, and `OrganisationService.profileChanges()`'s own
   * oldest-first ordering, which is `TaxCountryService.changes`'s — so a reader comparing two
   * settings histories is not comparing two orderings.
   *
   * `changes` and not `profile/changes`: the profile *is* this controller's root (`GET` and `PUT`
   * with no segment), so the sibling shape — resource path, then `changes` — puts it here. No
   * route on this controller matches a bare `:param` at the root, so nothing shadows it.
   */
  @Get('changes')
  @contractVersion()
  @RequirePermissions('organisation.read')
  async profileChanges(): Promise<{ readonly changes: readonly SettingChangeWire[] }> {
    return { changes: await this.organisation.profileChanges() };
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
   * Wrapped, like every other list-returning GET in this file and everywhere else in
   * `apps/api/src` (`{ accounts }`, `{ changes }`, `{ products }`, `{ categories }`,
   * `{ users }`, `{ groups }`, …) — a bare array here would have been the one exception, not
   * a shape this task's brief actually asked for; its own Files list is silent on envelope
   * shape and the illustrative `toHaveLength(1)` in its Step-1 sample doesn't decide it either
   * way. `taxCountries`, not the shorter `countries` a strict parallel to `accounts` (dropping
   * `bank`/`tax` the way `bank-accounts` drops to `accounts`) would suggest: `bank`/`account`
   * already carries an unambiguous domain shorthand throughout this file (`accounts()`,
   * `createAccount()`, …), and there is no equivalent shorthand for "tax country" anywhere in
   * this codebase — `countries` alone would read as every country, not the configured subset
   * with a tax policy attached.
   */

  @Get('tax-countries')
  @contractVersion()
  @RequirePermissions('organisation.read')
  async listTaxCountries(): Promise<{ readonly taxCountries: readonly TaxCountryWire[] }> {
    // `false`: the admin list shows every destination, active or withdrawn.
    const rows = await this.taxCountries.list(false);
    return { taxCountries: rows };
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
  async taxCountryChanges(
    @Param('code') code: string,
  ): Promise<{ readonly changes: readonly SettingChangeWire[] }> {
    const rows = await this.taxCountries.changes(code);
    return { changes: rows };
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
