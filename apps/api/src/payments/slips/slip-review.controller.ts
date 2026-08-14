import { Body, Controller, Delete, Get, Header, HttpCode, Param, Post, Query } from '@nestjs/common';
import { CONTRACT_VERSION, CONTRACT_VERSION_HEADER } from '@wewin/contract/version';

import { ZodBodyPipe } from '../../admin/zod-body.pipe';
import { CurrentScope, RequirePermissions, RequirePrincipal, type Scope } from '../../rbac';
import {
  acceptSlipRequestSchema,
  imageGrantRequestSchema,
  recordSlipRequestSchema,
  recordedSlipQuerySchema,
  rejectSlipRequestSchema,
  slipQueueQuerySchema,
  type AcceptSlipRequestWire,
  type AcceptSlipResultWire,
  type ImageGrantRequestWire,
  type RecordSlipRequestWire,
  type RecordedSlipListWire,
  type RecordedSlipQuery,
  type RejectSlipRequestWire,
  type RejectSlipResultWire,
  type SlipImageGrantWire,
  type SlipQueueQuery,
  type SlipQueueWire,
  type SlipReviewWire,
  type SlipWire,
} from './slips.contract';
import { SlipsService } from './slips.service';

/**
 * The review — the one control this payment model has.
 *
 *     GET    /payments/slips                       the queue, oldest transfer first
 *     POST   /payments/slips/recorded              ⭐ a payment that arrived with no slip
 *     GET    /payments/slips/recorded              ⭐ the audit list of exactly those
 *     GET    /payments/slips/:slipId               the two-column comparison
 *     POST   /payments/slips/:slipId/acceptance    the money lands, and sometimes the order moves
 *     POST   /payments/slips/:slipId/rejection     the order does not move. Ever.
 *     POST   /payments/slips/:slipId/image-grant   a short-lived URL for the photograph
 *     DELETE /payments/slips/:slipId/image         PDPA erasure: the picture goes, the row stays
 *
 * ── ⚠️ THE ASYMMETRY IS IN THE URL SPACE AND IN THE PERMISSIONS ──────────────────
 *
 * There is no `POST …/decision` with a `verdict` field, and that is the whole design of
 * this file. Plan 7.3, sharpened by 7.5(ข):
 *
 *   **Accepting** the slip that closes the *gating* instalment **is** the transition
 *   `awaiting_payment → production_confirmed` — the freeze point, where aluminium is
 *   committed. So acceptance requires `orders.write` on top of `payments.verify`: a
 *   reviewer who may not move an order may not accept a slip that would move one. And
 *   because *which* slip is the gating one is not knowable until the allocations are
 *   planned — it depends on the schedule, on what is already settled, and on whether the
 *   order has ever been in production — the permission is required for **every**
 *   acceptance, not only for the ones that turn out to freeze something.
 *
 *   **Rejecting** one is not a transition at all. The order stays exactly where it was, so
 *   the route requires no authority over orders beyond reading them, the handler never
 *   locks the order row, and `RejectSlipResultWire` has nowhere to report a transition.
 *
 * A single route taking a verdict would have to demand the union of both permission sets,
 * which would mean a clerk who may only reject slips could not be given that and nothing
 * else. Two routes is not tidiness; it is the difference being expressible in a grant.
 *
 * ── Why `orders.read` appears on every route here ────────────────────────────────
 *
 * These handlers load the order through `ScopedOrderRepository`, and `orderReach` widens a
 * caller to the whole table only on `orders.read` (and `orders.write` for the acting
 * intent). A reviewer holding `payments.read` alone would reach *their own* orders,
 * normally none, and get a 404 for every slip in the queue. Stating it on the route makes
 * that a grant somebody deliberately gives rather than a mystery somebody debugs.
 */

const contractVersion = (): MethodDecorator =>
  Header(CONTRACT_VERSION_HEADER, String(CONTRACT_VERSION));

/** A reviewer's screen is one customer's bank details. No shared cache may hold it. */
const privateToTheCaller = (): MethodDecorator => Header('Cache-Control', 'no-store');

@Controller('payments/slips')
export class SlipReviewController {
  constructor(private readonly slips: SlipsService) {}

  @Get()
  @contractVersion()
  @privateToTheCaller()
  @RequirePermissions('payments.read', 'orders.read')
  async queue(
    @Query(new ZodBodyPipe(slipQueueQuerySchema)) query: SlipQueueQuery,
  ): Promise<SlipQueueWire> {
    return this.slips.queue(query.limit);
  }

  /**
   * ⭐ Record a payment that arrived with no slip — the owner's *"ปิดยอดการชำระได้โดยไม่มีการ
   * ยืนยันสลิป แต่ต้องระบุเหตุผล"*.
   *
   * 201, and what is created is a **`submitted` slip**, not a payment. It joins the queue above,
   * is compared on the same screen and is accepted through `POST :slipId/acceptance` like every
   * other slip — see `SlipsService.recordSlip` for why recording and accepting are two requests
   * and not one, and `slips.contract.ts` for what that buys.
   *
   * ── ⚠️ THE PERMISSION SET, AND WHY IT IS THESE FOUR ──────────────────────────────
   *
   * `RequirePermissions` in this codebase means EVERY listed code, never any.
   *
   *   `payments.record_without_slip`  the new authority, and the only new one. Held by no group
   *                                   at boot — see `src/rbac/permissions.ts`.
   *   `payments.read`/`orders.read`   the same pair every route in this controller states, for
   *                                   the same reason: the handler loads the order through
   *                                   `ScopedOrderRepository`, and a caller without `orders.read`
   *                                   reaches only their own orders and gets a 404 for every
   *                                   order in the company.
   *   `orders.write`                  the `act` reach. `recordSlip` takes `lockOrFail(…, 'act')`,
   *                                   exactly as `createSlip` does, because writing a child row
   *                                   against an order is acting on it.
   *
   * ⚠️ **`payments.verify` is deliberately absent.** Recording is not reviewing. A clerk who
   * takes the telephone call may be given this and nothing else, and their entry then waits for
   * somebody who does hold `payments.verify` — which is the two-person rule surviving this
   * feature rather than being spent by it.
   */
  @Post('recorded')
  @HttpCode(201)
  @contractVersion()
  @privateToTheCaller()
  @RequirePermissions('payments.record_without_slip', 'payments.read', 'orders.read', 'orders.write')
  async record(
    @CurrentScope() scope: Scope,
    @Body(new ZodBodyPipe(recordSlipRequestSchema)) body: RecordSlipRequestWire,
  ): Promise<SlipWire> {
    return this.slips.recordSlip(scope, body);
  }

  /**
   * ⭐ THE AUDIT SURFACE — every payment recorded with no slip, and what happened to it.
   *
   * The owner accepted this feature on one condition: *"สิ่งสำคัญคือต้องสามารถตรวจสอบย้อนหลังได้
   * ถ้าทำได้ก็โอเค"*. This route is that condition. `?only=self_reviewed` narrows it to the rows
   * where one person did both halves.
   *
   * ⚠️ **Declared before `@Get(':slipId')`, and it has to be.** Nest matches in declaration
   * order, so a `recorded` segment below the parameterised route would be swallowed by it — and
   * swallowed *quietly*, answering 404 ("ไม่พบสลิปใบนี้") because `recorded` is not a uuid. That
   * is a broken audit list that looks like an empty one.
   *
   * `payments.read` and `orders.read`, and no more. This list is a *read* of rows that already
   * exist; requiring `payments.verify` to look at it would mean the person auditing the reviewers
   * has to hold the reviewers' own authority, which is the control inspecting itself.
   */
  @Get('recorded')
  @contractVersion()
  @privateToTheCaller()
  @RequirePermissions('payments.read', 'orders.read')
  async recorded(
    @Query(new ZodBodyPipe(recordedSlipQuerySchema)) query: RecordedSlipQuery,
  ): Promise<RecordedSlipListWire> {
    return this.slips.recordedWithoutSlip(query.limit, query.only);
  }

  /**
   * Everything the reviewer needs to disagree with the photograph.
   *
   * Plan 7.6 asks for a comparison and not a confirm button, because forged slips are a
   * known problem in Thailand and this is the only place a human looks. The server computes
   * the difference so that a client cannot fail to have it.
   */
  @Get(':slipId')
  @contractVersion()
  @privateToTheCaller()
  @RequirePermissions('payments.read', 'orders.read')
  async review(
    @CurrentScope() scope: Scope,
    @Param('slipId') slipId: string,
  ): Promise<SlipReviewWire> {
    return this.slips.review(scope, slipId);
  }

  /**
   * Accept. 200 and not 201: nothing is created, a slip that already existed is decided.
   *
   * `orders.write` is required here and nowhere else in this controller — see the module
   * comment. It is the permission that says "this person may freeze an order", and an
   * acceptance may be exactly that.
   */
  @Post(':slipId/acceptance')
  @HttpCode(200)
  @contractVersion()
  @privateToTheCaller()
  @RequirePermissions('payments.verify', 'payments.read', 'orders.read', 'orders.write')
  async accept(
    @CurrentScope() scope: Scope,
    @Param('slipId') slipId: string,
    @Body(new ZodBodyPipe(acceptSlipRequestSchema)) body: AcceptSlipRequestWire,
  ): Promise<AcceptSlipResultWire> {
    return this.slips.accept(scope, slipId, body);
  }

  /**
   * Reject. **No `orders.write`.**
   *
   * Rejecting a slip is a payment-level event: the order stays in `awaiting_payment`, the
   * customer is told why, and they transfer again. Requiring the authority to move an order
   * for an act that moves none would be a permission granted for nothing — and, worse, it
   * would be a permission a clerk would then hold for the acceptance path too.
   */
  @Post(':slipId/rejection')
  @HttpCode(200)
  @contractVersion()
  @privateToTheCaller()
  @RequirePermissions('payments.verify', 'payments.read', 'orders.read')
  async reject(
    @CurrentScope() scope: Scope,
    @Param('slipId') slipId: string,
    @Body(new ZodBodyPipe(rejectSlipRequestSchema)) body: RejectSlipRequestWire,
  ): Promise<RejectSlipResultWire> {
    return this.slips.reject(scope, slipId, body);
  }

  /**
   * A short-lived URL to the photograph — plan 7.6.
   *
   * `RequirePrincipal` and not a permission, because the customer who uploaded it must be
   * able to look at their own slip. Which slips a principal reaches is decided in the
   * query, and the *purpose* — view against download — is decided in the service, where the
   * permission set can be read. See `SlipsService.mintGrant` for the split and for the
   * permission this repository does not yet have.
   */
  @Post(':slipId/image-grant')
  @HttpCode(201)
  @contractVersion()
  @privateToTheCaller()
  @RequirePrincipal()
  async grant(
    @CurrentScope() scope: Scope,
    @Param('slipId') slipId: string,
    @Body(new ZodBodyPipe(imageGrantRequestSchema)) body: ImageGrantRequestWire,
  ): Promise<SlipImageGrantWire> {
    return this.slips.mintGrant(scope, slipId, body.purpose);
  }

  /**
   * Destroy the picture, keep the accounting record — plan 7.6's PDPA line.
   *
   * `users.erase` and not `payments.verify`: this is irreversible destruction of personal
   * data, which is the authority that code names, and it is held by no group at boot so the
   * route fails closed until somebody grants it deliberately. The honest split is a
   * `payments.erase_slip_image` of its own, and `src/rbac/permissions.ts` is the whole
   * application's catalogue and outside what this round owns — reported, not invented.
   *
   * ⚠️ There is no scheduled sweep behind this. Plan 7.16: the columns exist, the clock does
   * not, and the retention period is a number the accountant supplies.
   */
  @Delete(':slipId/image')
  @HttpCode(200)
  @contractVersion()
  @privateToTheCaller()
  @RequirePermissions('payments.read', 'orders.read', 'users.erase')
  async eraseImage(
    @CurrentScope() scope: Scope,
    @Param('slipId') slipId: string,
  ): Promise<SlipWire> {
    return this.slips.eraseImage(scope, slipId);
  }
}
