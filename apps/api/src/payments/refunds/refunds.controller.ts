import { Body, Controller, Get, Header, HttpCode, Param, Post, Query } from '@nestjs/common';

import { CONTRACT_VERSION, CONTRACT_VERSION_HEADER } from '@wewin/contract/version';

import { ZodBodyPipe } from '../../admin/zod-body.pipe';
import { AppError } from '../../common/errors/app-error';
import { CurrentScope, RequirePermissions, type Scope } from '../../rbac';
import {
  createRefundSchema,
  decideRefundSchema,
  disburseRefundSchema,
  refundQuerySchema,
  type CreateRefundWire,
  type DecideRefundWire,
  type DisburseRefundWire,
  type RefundDetailWire,
  type RefundListWire,
  type RefundQuery,
} from './refunds.contract';
import { RefundsService } from './refunds.service';

/**
 * Money going back out, over HTTP.
 *
 *     POST /payments/refunds                       ask for one — the amount is not yours to name
 *     GET  /payments/refunds                       the payable queue, and the different-account report
 *     GET  /payments/refunds/:id                   one of them, with the balances that explain it
 *     POST /payments/refunds/:id/decision          approve or refuse
 *     POST /payments/refunds/:id/disbursement      record the transfer that happened
 *
 * ── Why the three write steps are three routes ───────────────────────────────────
 *
 * The opposite of `POST /orders/:id/transitions/:toStatus`, and deliberately. That route is one
 * door because plan 7.4 trap 4 is about a controller choosing a body schema from its own name
 * when the legal move — and therefore the schema — can only be known after loading the row.
 * Nothing of the kind applies here: a refund has one path (`requested → approved → disbursed`),
 * each step takes a different body, and each step is performed by a *different person*. Three
 * routes is what makes "the disburser is not the approver" a statement about who may call what
 * rather than a branch inside one handler.
 *
 * ── The permissions, and the one that should exist ───────────────────────────────
 *
 * Reading is `payments.read`; requesting, deciding and paying are `orders.refund` — *"Return
 * money that was already received"*, which is exactly this. All three write steps share it, so
 * the separation between requester, approver and disburser is carried entirely by the two-person
 * CHECKs on the row and not by the permission system.
 *
 * ⚠️ That is a deliberate limit, not an oversight, and it is the answer to plan 7.13's warning
 * that eight two-person gates in one workflow kills the single control that means anything:
 * nobody has answered how many people the company has (plan 13, the *"จำนวนคน"* row), so this
 * phase spends the rules the schema already carries and invents no new ones. The one permission
 * that genuinely should exist —`payments.refund_other_account`, held by fewer people, for the
 * fraud-shaped path — is not added here because `rbac/permissions.ts` is not this agent's file.
 * Until it is added, that path is gated by an explicit acknowledgement and a report.
 */

const contractVersion = (): MethodDecorator =>
  Header(CONTRACT_VERSION_HEADER, String(CONTRACT_VERSION));

/**
 * Never stored between here and the browser.
 *
 * Every response on this controller names a customer, a bank account's last four digits and an
 * amount of money. A shared cache that decided two staff requests were the same request would
 * serve one operator another operator's queue — and, worse, would keep it.
 */
const privateToTheCaller = (): MethodDecorator => Header('Cache-Control', 'no-store');

/** A path segment reaching a `uuid` column is SQLSTATE 22P02, which is a 500 nobody caused. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function refundIdOrNotFound(value: string): string {
  if (!UUID.test(value)) throw AppError.notFound('ไม่พบคำขอคืนเงินนี้');
  return value;
}

@Controller('payments/refunds')
export class RefundsController {
  constructor(private readonly refunds: RefundsService) {}

  /**
   * Ask for a refund on an order that holds money.
   *
   * 201, because this creates two things that did not exist: the obligation in the ledger and
   * the request to discharge it. The body carries no amount — see `refunds.contract.ts`.
   */
  @Post()
  @HttpCode(201)
  @RequirePermissions('orders.refund')
  @contractVersion()
  @privateToTheCaller()
  async request(
    @CurrentScope() scope: Scope,
    @Body(new ZodBodyPipe(createRefundSchema)) body: CreateRefundWire,
  ): Promise<RefundDetailWire> {
    return this.refunds.request(scope, body);
  }

  /** The queue plan 7.12 demands. Defaults to `approved` — the promises that are not yet paid. */
  @Get()
  @RequirePermissions('payments.read')
  @contractVersion()
  @privateToTheCaller()
  async list(
    @Query(new ZodBodyPipe(refundQuerySchema)) query: RefundQuery,
  ): Promise<RefundListWire> {
    return this.refunds.list(query);
  }

  @Get(':refundId')
  @RequirePermissions('payments.read')
  @contractVersion()
  @privateToTheCaller()
  async get(@Param('refundId') refundId: string): Promise<RefundDetailWire> {
    return this.refunds.get(refundIdOrNotFound(refundId));
  }

  /**
   * Approve or refuse.
   *
   * `decision` and not two routes: they are one decision with two answers, taken by one person
   * at one moment, and splitting them would mean a caller could take neither and the queue would
   * have no way to say a refund was *considered*.
   */
  @Post(':refundId/decision')
  @HttpCode(200)
  @RequirePermissions('orders.refund')
  @contractVersion()
  @privateToTheCaller()
  async decide(
    @CurrentScope() scope: Scope,
    @Param('refundId') refundId: string,
    @Body(new ZodBodyPipe(decideRefundSchema)) body: DecideRefundWire,
  ): Promise<RefundDetailWire> {
    return this.refunds.decide(scope, refundIdOrNotFound(refundId), body);
  }

  /** Record the transfer. The only call in this phase that takes cash out of the company. */
  @Post(':refundId/disbursement')
  @HttpCode(200)
  @RequirePermissions('orders.refund')
  @contractVersion()
  @privateToTheCaller()
  async disburse(
    @CurrentScope() scope: Scope,
    @Param('refundId') refundId: string,
    @Body(new ZodBodyPipe(disburseRefundSchema)) body: DisburseRefundWire,
  ): Promise<RefundDetailWire> {
    return this.refunds.disburse(scope, refundIdOrNotFound(refundId), body);
  }
}
