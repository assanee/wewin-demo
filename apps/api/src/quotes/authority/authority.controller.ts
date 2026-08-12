import { Body, Controller, Delete, Get, Header, HttpCode, Param, Put } from '@nestjs/common';

import { CONTRACT_VERSION, CONTRACT_VERSION_HEADER } from '@wewin/contract/version';

import { ZodBodyPipe } from '../../admin/zod-body.pipe';
import { AppError } from '../../common/errors/app-error';
import { CurrentScope, RequirePermissions, type Scope } from '../../rbac';
import {
  setAuthorityLimitSchema,
  type AuthorityAssessmentWire,
  type AuthorityGroupListWire,
  type AuthorityLimitChangeListWire,
  type AuthorityLimitListWire,
  type SetAuthorityLimitWire,
} from './authority.contract';
import { assessmentWire, groupWire, limitChangeWire, limitWire } from './authority.presenter';
import { AuthorityService } from './authority.service';
import type { AuthorityLimitRow } from './authority.repository';

/**
 * The ceilings themselves, and what one quote concedes against them.
 *
 *     GET    /quotes/authority/groups                             the roles a ceiling attaches to
 *     GET    /quotes/authority/limits                             who may concede how much
 *     PUT    /quotes/authority/limits                             grant, change or reinstate one
 *     DELETE /quotes/authority/limits/:groupId/:dimension         withdraw it (a flag, not a delete)
 *     GET    /quotes/authority/limits/:groupId/:dimension/changes who moved it, and from what
 *     GET    /quotes/authority/orders/:orderId                    what this quote concedes, and may I
 *
 * ── Why the ceilings are behind `groups.write` and not `quotes.write` ────────────
 *
 * Authority attaches to a group. A salesperson who could write this table could raise their own
 * ceiling and then need nobody's approval for anything, which turns the whole module into a
 * form somebody fills in about themselves. Changing what a role may do is group
 * administration, so it is the group permission — and `groups.write` is held by nobody at boot
 * (see `permission-sync.service.ts`), which is the correct starting position for a table whose
 * documented default is that it stays empty.
 *
 * ── The table ships empty and the response says so ───────────────────────────────
 *
 * Plan 13: *"fail-closed — ยังไม่มีแถว = ยังลดราคาไม่ได้"*. `isFailClosed` is on the list response
 * so a dashboard renders a sentence rather than an empty table that looks like a feature nobody
 * has used. `tests/quotes/authority/authority.pg.test.ts` asserts the count is zero on a fresh
 * database, so seeding a "reasonable default" fails CI and has to be argued for out loud.
 *
 * ── The number that is deliberately missing ──────────────────────────────────────
 *
 * There is no percentage. Plan 13's instruction is literal — *do not invent a percentage* — and
 * a percentage ceiling is the more likely real answer for a business whose orders differ by an
 * order of magnitude, which is exactly why guessing it would be indistinguishable from a
 * decision three months from now. The column, and this route, take THB minor units.
 */

const contractVersion = (): MethodDecorator =>
  Header(CONTRACT_VERSION_HEADER, String(CONTRACT_VERSION));

const privateToTheCaller = (): MethodDecorator => Header('Cache-Control', 'no-store');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function uuidOrNotFound(value: string, message: string): string {
  if (!UUID.test(value)) throw AppError.notFound(message);
  return value;
}

/**
 * A path segment narrowed to the two dimensions `approvals` already has.
 *
 * A 404 and not a 422: `margin`/`cashflow` is part of the row's identity — it is half the
 * primary key — so a third word names a ceiling that cannot exist rather than a badly-formed
 * request. Same reading as `uuidOrNotFound` above.
 */
function knownDimension(value: string): 'margin' | 'cashflow' {
  if (value !== 'margin' && value !== 'cashflow') {
    throw AppError.notFound('ไม่พบมิติอำนาจอนุมัตินี้');
  }
  return value;
}

/**
 * ⚠️ `isFailClosed` counts **live** ceilings, not rows.
 *
 * It was `rows.length === 0`, which was the same question while a revocation was a `DELETE`.
 * Since 0038 a withdrawn ceiling stays in the table, so a company that had switched every limit
 * off would have been told the feature was on — the flag exists precisely so a dashboard can
 * say "nobody may concede anything" out loud, and that sentence is about authority, not rows.
 */
function listWire(rows: readonly AuthorityLimitRow[]): AuthorityLimitListWire {
  return {
    limits: rows.map(limitWire),
    isFailClosed: rows.every((row) => row.revokedAt !== null),
  };
}

@Controller('quotes/authority')
export class AuthorityController {
  constructor(private readonly authority: AuthorityService) {}

  @Get('limits')
  @RequirePermissions('groups.read')
  @contractVersion()
  @privateToTheCaller()
  async limits(): Promise<AuthorityLimitListWire> {
    return listWire(await this.authority.limits());
  }

  /**
   * ⭐ The roles a ceiling can be granted to — the screen's picker, under `groups.read`.
   *
   * ⚠️ **This route exists because of a permission dead-end, and that is the whole of it.**
   * The only list of groups was `GET /admin/groups`, gated on `users.read` — sight of the
   * entire staff directory. So a person holding `groups.read` + `groups.write`, the permission
   * that owns this very table, could not reach the ceiling screen at all: verified in a browser
   * by a reviewer, who got a 403 on the group list and an English refusal on a Thai page.
   * `groups.write` is held by nobody at boot, so the first person granted it landed there.
   *
   * Serving it here rather than relaxing `/admin/groups` is deliberate. `@RequirePermissions`
   * means *every* code, not any, so widening that route would have taken the group tab away
   * from `users.read` holders; and `/admin/groups` answers a richer question — permission
   * grants and member counts — than a `<select>` has any business buying. This answers the
   * narrow one: three columns that name a role, and nothing about any person.
   */
  @Get('groups')
  @RequirePermissions('groups.read')
  @contractVersion()
  @privateToTheCaller()
  async groups(): Promise<AuthorityGroupListWire> {
    return { groups: (await this.authority.groups()).map(groupWire) };
  }

  /**
   * `PUT` and not `POST`: the row is identified by `(group, dimension)` and the body carries
   * both, so sending it twice must leave one ceiling and not two. That is also what the
   * composite primary key says, and an endpoint that disagreed with the key would produce a
   * 23505 for the ordinary act of correcting a number.
   */
  @Put('limits')
  @HttpCode(200)
  @RequirePermissions('groups.write')
  @contractVersion()
  @privateToTheCaller()
  async setLimit(
    @CurrentScope() scope: Scope,
    @Body(new ZodBodyPipe(setAuthorityLimitSchema)) body: SetAuthorityLimitWire,
  ): Promise<AuthorityLimitListWire> {
    const rows = await this.authority.setLimit(scope, {
      groupId: body.groupId,
      dimension: body.dimension,
      maxConcessionThbMinor: BigInt(body.maxConcessionThbMinor),
      noteTh: body.noteTh ?? null,
    });
    return listWire(rows);
  }

  /**
   * Revoking is the fail-closed direction. It needs no second person and gets none.
   *
   * ⭐ It is a `DELETE` on the wire and a **flag** in the database — `revoked_at`, with
   * `authority_limits_block_delete` refusing the alternative. The row is who granted this role
   * its authority; taking the ceiling away must not take that with it. The response still lists
   * the row, dimmed, and `PUT`ting a number on it is how it comes back.
   */
  @Delete('limits/:groupId/:dimension')
  @HttpCode(200)
  @RequirePermissions('groups.write')
  @contractVersion()
  @privateToTheCaller()
  async removeLimit(
    @CurrentScope() scope: Scope,
    @Param('groupId') groupId: string,
    @Param('dimension') dimension: string,
  ): Promise<AuthorityLimitListWire> {
    const rows = await this.authority.removeLimit(
      scope,
      uuidOrNotFound(groupId, 'ไม่พบบทบาทนี้'),
      knownDimension(dimension),
    );
    return listWire(rows);
  }

  /**
   * Who moved this ceiling, from what, and when.
   *
   * Behind `groups.read` and not `groups.write`, matching every other history read in the
   * dashboard (`GET …/tax-countries/:code/changes`, `…/bank-accounts/:id/changes`): being able
   * to see that authority was widened for one deal and narrowed back afterwards is exactly the
   * thing that should *not* require the permission to do it.
   */
  @Get('limits/:groupId/:dimension/changes')
  @RequirePermissions('groups.read')
  @contractVersion()
  @privateToTheCaller()
  async limitChanges(
    @Param('groupId') groupId: string,
    @Param('dimension') dimension: string,
  ): Promise<AuthorityLimitChangeListWire> {
    const rows = await this.authority.limitChanges(
      uuidOrNotFound(groupId, 'ไม่พบบทบาทนี้'),
      knownDimension(dimension),
    );
    return { changes: rows.map(limitChangeWire) };
  }

  /**
   * What this quote concedes, and whether the caller may send it as it stands.
   *
   * The read the editor makes before it enables the submit button, so that "you cannot send
   * this" arrives while the salesperson is still looking at the numbers rather than as a 409
   * after they have told the customer. It is the same *measurement* `gate` makes — the same
   * method, not a second one.
   *
   * ⚠️ **It is not always the same number, and the claim that it could not disagree was false.**
   * `measureMargin` grosses a concession up at a `TaxRule`, and `vatRuleFor` sources that rule
   * differently either side of the pin: `DEFAULT_VAT_RULE` while `order.document_id` is null,
   * the pinned rate afterwards. So on an unsubmitted order for a destination that is not 700 bp
   * this endpoint measures at 7% while the quote screen measures at the destination's rate —
   * ฿1,988.16 against ฿1,951.68 on a Singapore order at 900 bp, measured.
   *
   * The quote screen was aligned with **`gate`** rather than with this endpoint, deliberately:
   * `gate` runs after `pinDocument` and is the number that actually refuses a submit, and
   * `overrides.ts`' header records what it costs to show a figure the gate will not honour. The
   * residual gap is therefore this read being stale before the pin, in the direction that it
   * *understates* — which is the fail-open direction and is why it is written down here rather
   * than left to be rediscovered.
   *
   * Closing it means giving `AuthorityService` the destination, which is a decision about
   * whether a draft's ceiling should move with a country the customer can still change. That
   * predates the per-destination VAT work and is not settled here.
   */
  @Get('orders/:orderId')
  @RequirePermissions('quotes.read')
  @contractVersion()
  @privateToTheCaller()
  async assess(
    @CurrentScope() scope: Scope,
    @Param('orderId') orderId: string,
  ): Promise<AuthorityAssessmentWire> {
    const assessment = await this.authority.assess(
      scope,
      uuidOrNotFound(orderId, 'ไม่พบใบเสนอราคานี้'),
    );
    return assessmentWire(assessment);
  }
}
