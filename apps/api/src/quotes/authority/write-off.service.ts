import { Injectable } from '@nestjs/common';

import { AppError } from '../../common/errors/app-error';
/*
 * ⭐ The *definition* of a live obligation, imported as the pure function it is — not
 * `OrdersModule`, and not a fourth list of statuses written here. `authority.module.ts`'s rule
 * ("this module deliberately does not import `OrdersModule` or `ScheduleModule`") is about the
 * domain modules and their verbs; `live-order.ts` has no Nest in it, reaches no repository and
 * moves nothing, exactly like `cashflowConcessionMinor`, which that same note names as the
 * precedent for importing a pure function directly.
 */
import { isLiveOrder } from '../../orders/live-order';
import type { Scope } from '../../rbac';
import { AuthorityRepository, type ApprovalRow } from './authority.repository';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ ขออนุมัติตัดยอดค้างทิ้ง — asking to forgive part or all of a balance owed.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The owner's fifth payment requirement was *"กระบวนการขอแบบยืดหยุ่นเพื่อให้รองรับสถานการณ์ที่คาดไม่
 * ถึง"*, and asked what would actually be requested they chose this one: the customer will not
 * pay, or a settlement was agreed halfway, or the remainder is not worth chasing.
 *
 * ── ⚠️ WHY THIS IS A ROUTE OF ITS OWN AND NOT `POST /quotes/approvals` ───────────
 *
 * It is the **same table**, the same inbox and the same decision endpoint — `approvals`, and one
 * of `AuthorityService.decide`. What is different is the *ask*, in three ways that a `dimension`
 * on an existing body cannot express:
 *
 *   ⓵ **The figure comes from a different place.** `POST /quotes/approvals` measures the
 *     concession from `quote_lines` and `quote_overrides` and refuses to accept an amount at all,
 *     for the reason its contract states: *a body that could name it is a body that asks for
 *     approval of ฿100 and receives approval of ฿100,000.* Pointed at a collection-time write-off
 *     that machinery measures the wrong number entirely — it would return the quote's
 *     `gate_below_floor` figure, which is about a deposit schedule and has nothing to do with the
 *     debt. See ⓶ for what replaces the refusal to accept an amount.
 *
 *   ⓶ **`quotes/*` is the wrong resource.** A write-off is not a concession on a quotation. The
 *     quote was correct, the customer agreed to it, and it was invoiced; what is being forgiven is
 *     an *order's* unpaid remainder, months later. The route is therefore
 *     `POST /orders/:orderId/write-offs`, which is where the dashboard asks from — beside the
 *     ค้างชำระ figure on the order's money card — and where an auditor would look for it.
 *
 *   ⓷ **The permission is different.** Requesting a quote concession is `quotes.write`, which
 *     every salesperson holds. See the controller for what this asks for instead and why.
 *
 * ⚠️ **The code lives here anyway, next to the machinery it reuses.** A Nest controller's route
 * prefix has nothing to do with its directory, and there must be exactly one place that knows how
 * an `approvals` row is made — `AuthorityRepository.insertApproval`, which is not exported from
 * this module for precisely that reason (`index.ts`: *"a second thing writing `approvals` would be
 * a second opinion about who decided what"*). A `src/payments/write-offs/` module would either
 * need that repository exported or would write the row itself.
 *
 * ── ⚠️ THE AMOUNT IS NAMED BY THE REQUESTER, WHICH THIS MODULE OTHERWISE FORBIDS ─
 *
 * `authority.contract.ts` argues at length that a request must not carry its own figure. That
 * argument is about a **measurable** concession: the quote's discount is a fact in `quote_lines`,
 * so accepting a number would be accepting a claim about rows the server can read.
 *
 * A write-off is not measurable. *"The customer settled for half"* is a commercial decision that
 * exists nowhere in the database until somebody records it, and a route that could only forgive
 * the **whole** balance would answer the wrong half of the owner's requirement — the settlement
 * case is the common one. So the amount is named, and what replaces the refusal is a **bound the
 * server computes**:
 *
 *     0 < amount ≤ order_outstanding_thb_minor(orderId)
 *
 * checked here inside the transaction that inserts the row, checked again by
 * `approvals_write_off_within_balance` at the database (because this service is not the only
 * writer), and checked a **third** time at the decision, because the balance moves in between.
 * `approvals_concession_positive` is the lower half.
 */
@Injectable()
export class WriteOffService {
  constructor(private readonly repository: AuthorityRepository) {}

  /**
   * Ask for a balance to be written off.
   *
   * Recording the ask is permitted whatever authority the requester has — the same call
   * `AuthorityService.request` makes, and for the same reason: refusing to record it would make
   * the inbox empty on a database with no authority rows, which is every database on day one.
   * What is *not* permitted is asking for more than is owed; that is a request no approver could
   * ever grant, so it is a trap in a queue rather than a queue item.
   *
   * ⭐ Nor is asking about an order whose remainder is **not a debt at all** — a cart, a
   * cancellation, or an order that has been superseded. Three refusals, two sentences (a cart's
   * own, and one for the two finished contracts), all 409, and all before a row exists.
   */
  async request(
    scope: Scope,
    input: {
      readonly orderId: string;
      readonly amountThbMinor: bigint;
      readonly reasonTh: string;
    },
  ): Promise<ApprovalRow> {
    const requestedByUserId = staffUserId(scope);

    const approvalId = await this.repository.transaction(async (tx) => {
      /*
       * ⚠️ The lock first, and it is the order row rather than the approval — there is no approval
       * yet. It serialises this request against a slip acceptance landing on the same order, so
       * the balance measured two lines down is the balance the insert is checked against.
       */
      const order = await this.repository.lockOrder(tx, input.orderId);
      if (order === undefined) throw AppError.notFound('ไม่พบออเดอร์นี้');

      /*
       * A cart has no contract and therefore no debt to forgive — `orders_money_shape` makes
       * `grand_total_thb_minor` NULL until submit, and the fold coalesces that to ฿0.00, so
       * without this the refusal below would be arithmetically right and unreadable ("ยอดคงค้าง
       * ฿0.00"). The honest sentence is that there is nothing to write off yet.
       */
      if (order.grandTotalThbMinor === null) {
        throw AppError.conflict('ออเดอร์นี้ยังไม่มีสัญญา จึงยังไม่มียอดคงค้างให้ตัดทิ้ง');
      }

      /*
       * ⭐ AND THE ORDER HAS TO BE SOMEBODY'S LIVE OBLIGATION.
       *
       * `order_outstanding_thb_minor()` answers about an order in **any** status — that is the right
       * question for the function and the wrong one to forgive against. A cancelled order that never
       * paid still folds to its whole grand total, so the two tests around this one both pass and the
       * ask used to be accepted: a request to forgive ฿14,791.68 of a debt the *cancellation* already
       * disposed of, through `forfeit_policy_rules` and the refund module. Approving it would spend
       * the role's `cashflow` ceiling on nothing and record a forgiven figure that no order wire ever
       * shows, because `encodeOrderSummary` nulls all four money fields on a non-live order. A
       * superseded order is the same statement twice: its remainder was *carried* to the order that
       * replaced it, so forgiving it here forgives money that is still owed over there.
       *
       * ⛔ `isLiveOrder` — the one list, in `src/orders/live-order.ts`. There were four readers of
       * that sentence before this line and every one of them takes it from that file; a fifth copy
       * written out here is how the ค้างชำระ column and this refusal come to disagree about
       * `delivered`, which is live and is exactly the order a write-off is most often asked about.
       *
       * ⚠️ After the no-contract test above, so a **cart** — also non-live — keeps the sentence that
       * is true about it ("ยังไม่มีสัญญา") rather than this one.
       *
       * ⚠️ Enforced again by `approvals_write_off_order_is_live` (0049), because this service is not
       * the only writer. See that migration for what the trigger does and does not cover.
       */
      if (!isLiveOrder(order.status)) {
        throw AppError.conflict(
          'ออเดอร์นี้ถูกยกเลิกหรือถูกแทนที่แล้ว ยอดคงค้างจึงไม่ใช่หนี้ที่ต้องตัดทิ้ง',
          { status: order.status },
        );
      }

      /* ⛔ Postgres's fold, read through the repository. See `AuthorityRepository`. */
      const outstanding = await this.repository.outstandingThbMinor(order.id, tx);

      if (outstanding <= 0n) {
        throw AppError.conflict('ออเดอร์นี้ไม่มียอดคงค้าง จึงไม่มีอะไรให้ตัดทิ้ง', {
          outstandingThbMinor: outstanding.toString(),
        });
      }

      if (input.amountThbMinor > outstanding) {
        throw AppError.conflict('ยอดที่ขอตัดทิ้งมากกว่ายอดคงค้างของออเดอร์นี้', {
          amountThbMinor: input.amountThbMinor.toString(),
          outstandingThbMinor: outstanding.toString(),
        });
      }

      /*
       * One open question per order per dimension — `approvals_one_open_per_order_dimension`, the
       * partial unique index. Refused with a sentence here so the caller does not meet a 23505,
       * and the sentence names which of the two it met: a second write-off, or a quote-time
       * cashflow concession that has not been answered yet.
       */
      const existing = await this.repository.approvalsForOrder(order.id, tx);
      const open = existing.find((row) => row.status === 'pending' && row.dimension === 'cashflow');
      if (open !== undefined) {
        throw AppError.conflict(
          open.kind === 'write_off'
            ? 'ออเดอร์นี้มีคำขออนุมัติตัดยอดค้างทิ้งที่ยังรอการตัดสินอยู่แล้ว'
            : 'ออเดอร์นี้มีคำขออนุมัติด้านเงินเข้าก่อนผลิตที่ยังรอการตัดสินอยู่ ต้องตัดสินคำขอนั้นก่อน',
          { approvalId: open.id, kind: open.kind },
        );
      }

      /*
       * ⭐ `quote_revision` — NOT NULL, and `^[0-9a-f]{16}$`.
       *
       * The column is the *subject* of a quote concession: an approval covers the quote it was
       * measured against and stops covering it the moment a line is edited. A write-off is not
       * about the quote at all, and yet the column is NOT NULL, so a value has to be chosen and
       * choosing badly would either fail the CHECK or record a lie.
       *
       * `quoteRevision()` is the answer: it is the digest of this order's live lines and overrides,
       * produced by the same function that stamps every other row in this table, so it satisfies
       * the CHECK by construction rather than by a hand-written literal that has to be sixteen
       * lowercase hex characters. `AuthorityRepository.quoteRevision` — not a constant, not
       * `'0'.repeat(16)` (which would pass the CHECK and mean nothing).
       *
       * What it records is genuinely useful: **which version of the contract this debt was
       * forgiven against.** An order that was superseded and re-quoted has a different digest, so
       * the row says which document the forgiven figure belongs to.
       *
       * ⚠️ It is deliberately *not* used the way `judge` uses it. `judge` refuses to let an
       * approval cover a quote whose digest has moved; nothing does that to a write-off, and
       * nothing should — editing a quote line does not un-forgive a debt. `order_document_id`
       * beside it is the pinned document, which post-submit always exists.
       */
      const revision = await this.repository.quoteRevision(order.id, tx);

      return this.repository.insertApproval(tx, {
        orderId: order.id,
        orderDocumentId: order.documentId,
        quoteRevision: revision,
        /*
         * `cashflow`, because forgiving cash the company is owed is measured against the cashflow
         * ceiling — `authority_limits` already carries the row and there is no fifth budget here.
         * `write_off` is what stops that sharing a meaning with a below-floor deposit schedule:
         * see `APPROVAL_KINDS` in `packages/db`.
         */
        dimension: 'cashflow',
        kind: 'write_off',
        concessionThbMinor: input.amountThbMinor,
        reasonTh: input.reasonTh,
        requestedByUserId,
      });
    });

    const row = await this.repository.approvalById(approvalId);
    if (row === undefined) throw new Error('the write-off that was just inserted cannot be read back');
    return row;
  }
}

/**
 * A write-off is an act by a member of staff. No guest variant, ever: a customer cannot forgive
 * their own debt, so `guest` and `public` are refused rather than modelled — and `system` with
 * them, because a worker that could write a balance off is a worker with an authority nobody
 * granted. The same function `AuthorityService` keeps for the same reason.
 */
function staffUserId(scope: Scope): string {
  if (scope.kind !== 'user') {
    throw AppError.unauthenticated('ต้องเข้าสู่ระบบด้วยบัญชีเจ้าหน้าที่จึงจะขออนุมัติตัดยอดค้างทิ้งได้');
  }
  return scope.userId;
}
