import { Body, Controller, Get, Header, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { CONTRACT_VERSION, CONTRACT_VERSION_HEADER } from '@wewin/contract/version';

import { ZodBodyPipe } from '../../admin/zod-body.pipe';
import { readBoundedBody } from '../../media/read-body';
import { AppError } from '../../common/errors/app-error';
import { CurrentScope, RequirePrincipal, type Scope } from '../../rbac';
import {
  createSlipRequestSchema,
  type CreateSlipRequestWire,
  type SlipImageUploadWire,
  type SlipListWire,
  type SlipWire,
} from './slips.contract';
import { SlipsService } from './slips.service';

/**
 * The customer's half of a payment slip.
 *
 *     POST /orders/:orderId/payment-slips/image     the raw bytes of one photograph
 *     POST /orders/:orderId/payment-slips           the slip itself, naming those bytes
 *     GET  /orders/:orderId/payment-slips           this order's slips, with their outcome
 *
 * ── `RequirePrincipal`, and why it cannot be anything else ───────────────────────
 *
 * A slip belongs to an order, and an order belongs to a signed-in user *or* to a guest —
 * plan section 6 is explicit that the anonymous visitor is the main funnel, and a customer
 * who configured, was quoted and submitted as a guest is the same person who now has to
 * upload a slip. `RequireAuthenticated` would close that door; `RequirePermissions` is
 * meaningless, because a customer holds no permission over their own order and never will.
 *
 * *Which* order a principal reaches is not a question a guard can answer — it has never
 * read the row — so it is answered in the query, by `src/orders/scope`.
 *
 * ── Two requests to upload one slip ──────────────────────────────────────────────
 *
 * The body of the first **is** the file, exactly as `POST /admin/media` takes an image:
 * that removes a multipart parser from the path between the network and the bytes, and this
 * API refuses to believe a declared content type or a filename anyway. What comes back is
 * an opaque signed handle, and the second request presents it. `slip-grant.ts` argues why
 * that handle is signed rather than being the storage key in plain text; the short version
 * is that an unsigned key lets somebody attach a stranger's slip image to a slip of their
 * own and then read it back legitimately.
 */

const contractVersion = (): MethodDecorator =>
  Header(CONTRACT_VERSION_HEADER, String(CONTRACT_VERSION));

/**
 * Never stored by anything between here and the browser.
 *
 * Every response here is scoped to one principal, and two of the three ways a caller
 * identifies themselves — the guest cookie and the session cookie — are exactly what a
 * shared cache is entitled to ignore when deciding two requests are the same. A cached slip
 * list is somebody else's bank details served to the next person through the proxy.
 */
const privateToTheCaller = (): MethodDecorator => Header('Cache-Control', 'no-store');

/**
 * What a client may claim it is sending.
 *
 * A hint check and **not** the security check — the bytes decide, in `media/image`. This
 * exists because Express's JSON body parser consumes bodies whose content type it
 * recognises, so a request labelled `application/json` would arrive here already drained,
 * and the caller would be told "no file in the request" about a file they did send.
 */
const ACCEPTED_UPLOAD_TYPES = ['image/', 'application/octet-stream'];

@Controller('orders/:orderId/payment-slips')
export class SlipsController {
  constructor(private readonly slips: SlipsService) {}

  @Post('image')
  @HttpCode(201)
  @contractVersion()
  @privateToTheCaller()
  @RequirePrincipal()
  async uploadImage(
    @CurrentScope() scope: Scope,
    @Param('orderId') orderId: string,
    @Req() request: Request,
  ): Promise<SlipImageUploadWire> {
    requireImageContentType(request);

    const bytes = await readBoundedBody(request, this.slips.maxImageBytes);
    return this.slips.uploadImage(scope, orderId, bytes);
  }

  @Post()
  @HttpCode(201)
  @contractVersion()
  @privateToTheCaller()
  @RequirePrincipal()
  async create(
    @CurrentScope() scope: Scope,
    @Param('orderId') orderId: string,
    @Body(new ZodBodyPipe(createSlipRequestSchema)) body: CreateSlipRequestWire,
  ): Promise<SlipWire> {
    return this.slips.createSlip(scope, orderId, body);
  }

  /**
   * The order's slips, oldest transfer first.
   *
   * Served to the customer as well as to staff, and that is a decision of the same kind
   * `GET /orders/:id/events` makes: "did you get my money, and if not, why not" is the
   * question the company otherwise answers by telephone. What the customer does not get is
   * the internal user id of whoever uploaded or reviewed it — see `encodeSlip`, where the
   * audience comes from the caller's reach and not from a flag on the request.
   */
  @Get()
  @contractVersion()
  @privateToTheCaller()
  @RequirePrincipal()
  async list(
    @CurrentScope() scope: Scope,
    @Param('orderId') orderId: string,
  ): Promise<SlipListWire> {
    return this.slips.listForOrder(scope, orderId);
  }
}

function requireImageContentType(request: Request): void {
  const declared = (request.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (!ACCEPTED_UPLOAD_TYPES.some((accepted) => declared.startsWith(accepted))) {
    throw AppError.badRequest(
      'ต้องส่งไฟล์รูปสลิปเป็นเนื้อหาของคำขอโดยตรง พร้อมระบุ Content-Type เป็น image/* หรือ application/octet-stream',
      { received: declared },
    );
  }
}
