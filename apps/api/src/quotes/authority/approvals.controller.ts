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
  type ApprovalQueueWire,
  type ApprovalWire,
  type DecideApprovalWire,
  type RequestApprovalWire,
} from './authority.contract';
import {
  approvalQueueWire,
  approvalRightsWire,
  approvalWire,
  bareMeasurementWire,
} from './authority.presenter';
import { AuthorityService } from './authority.service';

/**
 * Concessions waiting for an answer — plan 7.13's *"กล่องขาเข้าของผู้อนุมัติ"*.
 *
 *     POST /quotes/approvals                  ask — the size is measured, never sent
 *     GET  /quotes/approvals                  everything waiting, oldest first, `?status=pending`
 *     GET  /quotes/approvals/queue            ⭐ what **the caller** may decide, and what they may not
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
 * ⚠️ For a whole round that was the *entire* fix, and it was half of one: the list is unfiltered,
 * so an approver opened it onto every pending request in the company, most of which their own
 * ceiling did not cover, and the only way to learn which was which was to press the button and
 * read the 403. `GET /quotes/approvals/queue` is the other half — `approval-rights.ts` decides,
 * once, what `decide` would accept, and the queue is the rows that pass. The unfiltered list
 * stays, because a requester checking on their own ask and an auditor reading the backlog are
 * both real readers and neither has a ceiling to filter by.
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
 * its own code, held by nobody at boot. The queue asks for **both** read codes, because it is a
 * work list rather than a report: see `queue` below.
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

  /**
   * ⭐ THE QUEUE THIS PERSON MAY ACTUALLY DECIDE — the screen plan 7.13 asks for.
   *
   * ── Why a route of its own rather than a flag on the list above ───────────────────
   *
   * The two answer different questions and one of them takes the caller as an argument.
   * `GET /quotes/approvals` is *"what is waiting?"*, unfiltered, for anybody who may read a
   * quotation — a requester checking their own ask, somebody reading the backlog. This is
   * *"what is waiting for me?"*, and it is filtered by the caller's own ceiling. A `?mine=true`
   * on one endpoint would make the response's meaning depend on a query parameter, which is how
   * a client ends up reading an audit list as a work queue.
   *
   * ⚠️ **Declared before `:approvalId`, and that is load-bearing.** Nest matches in declaration
   * order, so `queue` below the parameterised route would be swallowed by it. The `UUID` guard on
   * that handler would then answer 404 — a screen that "does not exist" while its code is right
   * there. Moving this method down the file is enough to break it, which is why
   * `authority.pg.test.ts` asks for the queue by path and not through a service call.
   *
   * ── The permission is BOTH codes, and neither is decoration ──────────────────────
   *
   * `quotes.read` because this serves `approvals` rows, exactly as the list above does, and
   * `quotes.approve` because a queue is a work list: it is filtered to what the caller may decide,
   * so serving it to somebody who may decide nothing would be serving a list whose every row is a
   * lie. Same shape as the slip queue asking for two codes — see `overview/sections.ts`, which now
   * gates the pending-approvals card on this pair for the same reason.
   *
   * ⚠️ `@RequirePermissions` means **every** listed code. A holder of `quotes.approve` alone gets
   * 403 here, deliberately: they could not read the request they were being asked to judge.
   */
  @Get('queue')
  @RequirePermissions('quotes.read', 'quotes.approve')
  @contractVersion()
  @privateToTheCaller()
  async queue(@CurrentScope() scope: Scope): Promise<ApprovalQueueWire> {
    return approvalQueueWire(await this.authority.queue(scope));
  }

  /** One request, plus the concession as it stands right now. The two can differ — see the contract. */
  @Get(':approvalId')
  @RequirePermissions('quotes.read')
  @contractVersion()
  @privateToTheCaller()
  async get(
    @CurrentScope() scope: Scope,
    @Param('approvalId') approvalId: string,
  ): Promise<ApprovalDetailWire> {
    const { row, live, quoteRevisionNow, rights, ceilingThbMinor, outstandingThbMinor } =
      await this.authority.approval(scope, approvalIdOrNotFound(approvalId));

    const liveForDimension =
      row.dimension === 'margin' ? live.margin : live.cashflow;

    return {
      approval: approvalWire(row),
      /*
       * What the caller may do, decided by the same function `decide` and the queue use. A
       * screen that worked this out from `concessionThbMinor` and a ceiling it fetched elsewhere
       * would be a second implementation of the one rule this module has.
       */
      rights: approvalRightsWire(rights, ceilingThbMinor),
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
      /*
       * ⭐ A write-off's own warning, and the reason it cannot reuse `hasMovedSinceRequest`.
       *
       * `outstandingThbMinor` is `undefined` unless the row is a write-off — `AuthorityService`
       * reads the fold only for those — so this block is present exactly when it means something.
       * A screen that had to infer that from `kind` would be one release away from reading the
       * cashflow measurement (a *deposit schedule*) as the state of a debt.
       */
      writeOff:
        outstandingThbMinor === undefined
          ? null
          : {
              outstandingThbMinor: outstandingThbMinor.toString(),
              stillCovered: row.concessionThbMinor <= outstandingThbMinor,
            },
    };
  }

  /**
   * Approve or refuse — one route, because it is one decision with two answers.
   *
   * Splitting them into two would let a caller take neither, and the queue would have no way
   * to record that a request was *considered*. The same argument the refund module makes.
   *
   * ── ⭐ AND IT DECIDES WRITE-OFFS TOO, WITH ONE MORE PERMISSION CHECKED INSIDE ────
   *
   * ขออนุมัติตัดยอดค้างทิ้ง is asked for on `POST /orders/:orderId/write-offs` — a different
   * resource, a different figure, a different permission — and answered **here**, because it is
   * one inbox and one decision. A second decision route would be a second copy of the two-person
   * rule, the ceiling comparison and the pinned `decided_ceiling_thb_minor`, which is plan 7.13's
   * opening finding arriving again.
   *
   * ⚠️ `@RequirePermissions('quotes.approve')` and **not** `payments.write_off` beside it, even
   * though a write-off needs both. The guard runs before the row is read, so it cannot know which
   * kind this is, and listing the second code here would demand it of every quote-concession
   * decision — locking out every approver the owner has already trusted. The conjunction is
   * completed in `AuthorityService.decide`, which reads the row first; `approvalRights` mirrors it
   * so the queue and this endpoint cannot disagree, and `rights.because` reports
   * `not_a_write_off_approver` to the screen before a button is offered.
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
