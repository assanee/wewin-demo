import { Body, Controller, Get, Header, HttpCode, Param, Post, Query } from '@nestjs/common';

import { CONTRACT_VERSION, CONTRACT_VERSION_HEADER } from '@wewin/contract/version';

import { ZodBodyPipe } from '../../admin/zod-body.pipe';
import { AppError } from '../../common/errors/app-error';
import { CurrentScope, RequirePermissions, type Scope } from '../../rbac';
import {
  approvalQuerySchema,
  decideApprovalSchema,
  requestApprovalSchema,
  type ApprovalDetailWire,
  type ApprovalListWire,
  type ApprovalQuery,
  type ApprovalWire,
  type DecideApprovalWire,
  type RequestApprovalWire,
} from './authority.contract';
import { approvalWire, bareMeasurementWire } from './authority.presenter';
import { AuthorityService } from './authority.service';

/**
 * Concessions waiting for an answer — plan 7.13's *"กล่องขาเข้าของผู้อนุมัติ"*.
 *
 *     POST /quotes/approvals                  ask — the size is measured, never sent
 *     GET  /quotes/approvals                  the queue, oldest first, `?status=pending`
 *     GET  /quotes/approvals/:id              one request, with what the quote concedes *now*
 *     POST /quotes/approvals/:id/decision     approve or refuse
 *
 * ── Why the inbox is the point and not a convenience ─────────────────────────────
 *
 * Plan 7.13 lists *"หน้าจอที่งานนี้ต้องมีแต่ยังไม่มีใครออกแบบ"* and the approver's inbox is on it.
 * The design that produced the `approvals` table produced requests with **nowhere to arrive**:
 * a row appears, a quote is blocked, and the only way anybody learns of it is a salesperson
 * telephoning somebody. `GET /quotes/approvals` is the fix and it reads
 * `approvals_pending_idx` — the index that was created for a screen that did not exist.
 *
 * ⚠️ It is a queue and **not a notification**. Nothing here tells an approver that something
 * arrived; the module writes no `order_events` row and has no outbox (plan 10.1 makes
 * notifications consumers of the spine, and a concession is not a status change). So an
 * approver who does not open the screen sees nothing. That is a gap, it is reported, and it is
 * not papered over with a `sendEmail` in a service.
 *
 * ── The permission, and the one that should exist ────────────────────────────────
 *
 * Reading is `quotes.read`, asking is `quotes.write`, and **deciding is `quotes.approve`** —
 * its own code, held by nobody at boot.
 *
 * Deciding was `quotes.write` for one round, which every salesperson holds, so the permission
 * system did not separate the approver from the requester at all: what separated them was the
 * two-person CHECK plus the decider's ceiling, and on a database with no `authority_limits`
 * rows only the CHECK was left. Two colleagues defeat a two-person rule by taking turns.
 *
 * ⚠️ Because nobody holds `quotes.approve` at boot, the first effect of this split is that
 * **no approval can be granted until the owner grants the permission**. That is deliberate and
 * it is the same shape as the empty ceiling table: plan 13 asks how many people actually review
 * anything here and warns that a rubber-stamped rule is worse than none, so the code exists,
 * the grant does not, and the answer is a decision rather than a default.
 */

const contractVersion = (): MethodDecorator =>
  Header(CONTRACT_VERSION_HEADER, String(CONTRACT_VERSION));

/**
 * Never stored between here and the browser.
 *
 * Every response names a customer's order, a discount somebody negotiated and the person who
 * asked for it. A shared cache that decided two staff requests were the same request would
 * serve one operator another operator's queue, and would keep it.
 */
const privateToTheCaller = (): MethodDecorator => Header('Cache-Control', 'no-store');

/** A path segment reaching a `uuid` column is SQLSTATE 22P02, which is a 500 nobody caused. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function approvalIdOrNotFound(value: string): string {
  if (!UUID.test(value)) throw AppError.notFound('ไม่พบคำขออนุมัตินี้');
  return value;
}

@Controller('quotes/approvals')
export class ApprovalsController {
  constructor(private readonly authority: AuthorityService) {}

  /**
   * Ask for a concession to be approved.
   *
   * 201, because this creates something that did not exist: an obligation on somebody else to
   * answer. The body carries no amount — see `authority.contract.ts`.
   */
  @Post()
  @HttpCode(201)
  @RequirePermissions('quotes.write')
  @contractVersion()
  @privateToTheCaller()
  async request(
    @CurrentScope() scope: Scope,
    @Body(new ZodBodyPipe(requestApprovalSchema)) body: RequestApprovalWire,
  ): Promise<ApprovalWire> {
    const row = await this.authority.request(scope, {
      orderId: body.orderId,
      dimension: body.dimension,
      reasonTh: body.reasonTh,
    });
    return approvalWire(row);
  }

  /** The queue. Defaults to `pending` — the requests nobody has answered. */
  @Get()
  @RequirePermissions('quotes.read')
  @contractVersion()
  @privateToTheCaller()
  async list(
    @Query(new ZodBodyPipe(approvalQuerySchema)) query: ApprovalQuery,
  ): Promise<ApprovalListWire> {
    const rows = await this.authority.inbox(
      { status: query.status, orderId: query.orderId },
      query.limit,
    );
    return { approvals: rows.map(approvalWire) };
  }

  /** One request, plus the concession as it stands right now. The two can differ — see the contract. */
  @Get(':approvalId')
  @RequirePermissions('quotes.read')
  @contractVersion()
  @privateToTheCaller()
  async get(@Param('approvalId') approvalId: string): Promise<ApprovalDetailWire> {
    const { row, live, quoteRevisionNow } = await this.authority.approval(
      approvalIdOrNotFound(approvalId),
    );

    const liveForDimension =
      row.dimension === 'margin' ? live.margin : live.cashflow;

    return {
      approval: approvalWire(row),
      /*
       * The sharper warning than `hasMovedSinceRequest`, and the one an approver can act on:
       * when this differs from `approval.quoteRevision`, saying yes grants nothing at all,
       * because `judge` matches an approval to the quote it was measured against.
       */
      quoteRevisionNow,
      liveConcession: {
        margin: bareMeasurementWire(live.margin),
        cashflow: bareMeasurementWire(live.cashflow),
        hasMovedSinceRequest: liveForDimension.concessionThbMinor > row.concessionThbMinor,
      },
    };
  }

  /**
   * Approve or refuse — one route, because it is one decision with two answers.
   *
   * Splitting them into two would let a caller take neither, and the queue would have no way
   * to record that a request was *considered*. The same argument the refund module makes.
   */
  @Post(':approvalId/decision')
  @HttpCode(200)
  @RequirePermissions('quotes.approve')
  @contractVersion()
  @privateToTheCaller()
  async decide(
    @CurrentScope() scope: Scope,
    @Param('approvalId') approvalId: string,
    @Body(new ZodBodyPipe(decideApprovalSchema)) body: DecideApprovalWire,
  ): Promise<ApprovalWire> {
    /*
     * A rejection without a sentence is a request that comes back with nothing to act on, and
     * the requester's only move is to ask again. Checked here rather than in the schema because
     * the rule is about the *decision*, and a zod refinement would say so less clearly.
     */
    if (body.decision === 'rejected' && body.noteTh === undefined) {
      throw AppError.validationFailed('การไม่อนุมัติต้องระบุเหตุผลให้ผู้ขอทราบ');
    }

    const row = await this.authority.decide(scope, approvalIdOrNotFound(approvalId), {
      decision: body.decision,
      noteTh: body.noteTh ?? null,
    });
    return approvalWire(row);
  }
}
