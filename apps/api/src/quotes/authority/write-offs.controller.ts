import { Body, Controller, Header, HttpCode, Param, Post } from '@nestjs/common';

import { CONTRACT_VERSION, CONTRACT_VERSION_HEADER } from '@wewin/contract/version';

import { ZodBodyPipe } from '../../admin/zod-body.pipe';
import { AppError } from '../../common/errors/app-error';
import { CurrentScope, RequirePermissions, type Scope } from '../../rbac';
import { requestWriteOffSchema, type ApprovalWire, type RequestWriteOffWire } from './authority.contract';
import { approvalWire } from './authority.presenter';
import { WriteOffService } from './write-off.service';

/**
 * ⭐ ขออนุมัติตัดยอดค้างทิ้ง — ask for a balance the customer owes to be written off.
 *
 *     POST /orders/:orderId/write-offs      ask. The decision is taken in the approval inbox.
 *
 * The owner's fifth payment requirement: *"กระบวนการขอแบบยืดหยุ่นเพื่อให้รองรับสถานการณ์ที่คาดไม่ถึง"*
 * — the customer will not pay, or a settlement was agreed halfway, or the remainder is not worth
 * chasing.
 *
 * ── ⚠️ WHY THIS ROUTE IS NOT UNDER `quotes/approvals` ────────────────────────────
 *
 * It writes to the same table and is answered by the same endpoint. What differs is what is being
 * asked, and `POST /quotes/approvals` cannot express it:
 *
 *   ⓵ that route **measures** the concession from `quote_lines` and `quote_overrides` and refuses
 *     to accept a figure — *"a body that could name it is a body that asks for approval of ฿100
 *     and receives approval of ฿100,000."* Pointed at a write-off it measures the quote's
 *     `gate_below_floor` concession, which is about a deposit schedule and not about the debt.
 *     `dimension: 'cashflow'` on that body already means something else, today.
 *
 *   ⓶ **the resource is the order, not the quotation.** The quote was right, the customer agreed
 *     to it, and it was invoiced; what is being forgiven is an order's unpaid remainder months
 *     later. This is where the dashboard asks from — beside ค้างชำระ on the order's money card —
 *     and where an auditor reading `/orders/:id` would look.
 *
 * ⚠️ The service and this controller live in `src/quotes/authority/` regardless, because
 * `AuthorityRepository.insertApproval` is the one place that knows how an `approvals` row is made
 * and is deliberately not exported from this module. Directory ≠ route prefix.
 *
 * ── The permissions, and why requesting is not the same code as deciding ─────────
 *
 * Requesting is `orders.write` + `payments.read`; deciding is `quotes.approve` +
 * **`payments.write_off`**, checked on the decision route.
 *
 *   `payments.read`   because the ask is bounded by a figure the requester has to be able to see:
 *                     ค้างชำระ. Somebody asking to forgive a balance they may not read is somebody
 *                     naming an amount at random, and the refusal they would get ("more than the
 *                     outstanding") would disclose the figure anyway.
 *   `orders.write`    because this is an act on an order taken by staff who handle orders — the
 *                     collections clerk chasing the debt, not the salesperson who quoted it. It is
 *                     the widest code here and that is deliberate: **asking costs nothing.** The
 *                     ask forgives no money, moves no balance, and creates one obligation on
 *                     somebody else — to answer. The same call `AuthorityService.request` makes
 *                     about recording an ask on a database with no authority rows at all.
 *
 * ⚠️ It is deliberately **not** `payments.write_off`. If the requester needed the deciding code,
 * requester and decider would hold the same permission and the separation would collapse to the
 * four-eyes CHECK plus a ceiling — which is exactly the hole `quotes.approve` was split off to
 * close, one round ago, in this module.
 */
const contractVersion = (): MethodDecorator =>
  Header(CONTRACT_VERSION_HEADER, String(CONTRACT_VERSION));

/** A response naming a customer's debt and the person asking to forgive it is never shared cache. */
const privateToTheCaller = (): MethodDecorator => Header('Cache-Control', 'no-store');

/** A path segment reaching a `uuid` column is SQLSTATE 22P02, which is a 500 nobody caused. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

@Controller('orders/:orderId/write-offs')
export class WriteOffsController {
  constructor(private readonly writeOffs: WriteOffService) {}

  /**
   * Ask for part or all of this order's balance to be written off.
   *
   * 201, exactly as `POST /quotes/approvals` is: this creates something that did not exist — an
   * obligation on somebody else to answer — and the row it creates is the audit record of the ask
   * whether or not anybody ever says yes.
   *
   * ⚠️ It returns an `ApprovalWire`, the same shape the inbox lists, rather than a wire of its own.
   * The row *is* an approval; a second shape for it would be a second place for `kind` to go
   * missing from, and the dashboard's write-off panel and its inbox decode one type.
   */
  @Post()
  @HttpCode(201)
  @RequirePermissions('orders.write', 'payments.read')
  @contractVersion()
  @privateToTheCaller()
  async request(
    @CurrentScope() scope: Scope,
    @Param('orderId') orderId: string,
    @Body(new ZodBodyPipe(requestWriteOffSchema)) body: RequestWriteOffWire,
  ): Promise<ApprovalWire> {
    if (!UUID.test(orderId)) throw AppError.notFound('ไม่พบออเดอร์นี้');

    const row = await this.writeOffs.request(scope, {
      orderId,
      /*
       * The wire is a decimal string and this is where it becomes money — `BigInt` and never
       * `Number`, which is exact only to 2^53 and is therefore exact for every amount anybody
       * tests with. `requestWriteOffSchema` has already refused anything that is not canonical
       * digits, so this cannot throw.
       */
      amountThbMinor: BigInt(body.amountThbMinor),
      reasonTh: body.reasonTh,
    });

    return approvalWire(row);
  }
}
