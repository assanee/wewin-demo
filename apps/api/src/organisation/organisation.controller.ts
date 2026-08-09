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

import { ZodBodyPipe } from '../admin/zod-body.pipe';
import { AppError } from '../common/errors/app-error';
import { message } from '../i18n';
import { CurrentScope, RequirePermissions, type Scope } from '../rbac';
import { encodeAccount, encodeChange, encodeProfile } from './encode';
import { OrganisationRepository } from './organisation.repository';
import { OrganisationService } from './organisation.service';

const contractVersion = (): MethodDecorator =>
  Header(CONTRACT_VERSION_HEADER, String(CONTRACT_VERSION));

/**
 * The company's own profile and the bank accounts it is paid into.
 *
 *     GET   /admin/organisation
 *     PUT   /admin/organisation
 *     GET   /admin/organisation/bank-accounts
 *     POST  /admin/organisation/bank-accounts
 *     PATCH /admin/organisation/bank-accounts/:id
 *     PUT   /admin/organisation/bank-accounts/:id/availability
 *     GET   /admin/organisation/bank-accounts/:id/changes
 *
 * `availability` is its own route rather than a field `patchAccount` also accepts, the same
 * shape decision `option-catalog.controller.ts` makes for stock: it is the one write here a
 * client must never be able to smuggle in beside an unrelated edit, and `bankAccountPatchSchema`
 * enforces that by refusing the field outright. `OrganisationService.setAvailability` reuses
 * the patch path with a cast rather than a second write, so a deactivation is recorded in
 * `bank_account_changes` exactly like any other change — see that file.
 */
@Controller('admin/organisation')
export class OrganisationController {
  constructor(
    private readonly organisation: OrganisationService,
    private readonly repository: OrganisationRepository,
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
