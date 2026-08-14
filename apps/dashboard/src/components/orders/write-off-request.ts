import { readSatang } from '@wewin/core/money';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ ขออนุมัติตัดยอดค้างทิ้ง — what the form accepts, and what it refuses to send.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The owner's fifth payment requirement, asked from the order's money card: the customer will not
 * pay, or a settlement was agreed halfway, or the remainder is not worth chasing.
 *
 * No React here on purpose. `apps/dashboard`'s vitest is `environment: 'node'` and a `.test.tsx` is
 * **silently never collected**, so a decision left in the markup is a decision no test in this repo
 * can reach — the same reason `order-outstanding.ts` and `no-slip.ts` exist. What is in the `.tsx`
 * beside this file is the layout and nothing else.
 *
 * ── ⚠️ THIS FORM NAMES AN AMOUNT, AND THE SERVER IS STILL THE AUTHORITY ──────
 *
 * `apps/api/src/quotes/authority/authority.contract.ts` argues at length that an approval request
 * must not carry its own figure — *"a body that could name it is a body that asks for approval of
 * ฿100 and receives approval of ฿100,000"*. That argument is about a **measurable** concession: a
 * quote's discount is a fact in `quote_lines`. A write-off is not measurable — *"the customer
 * settled for half"* exists nowhere until somebody records it — so the amount is typed, and the
 * bound is the server's:
 *
 *     0 < amount ≤ order_outstanding_thb_minor(orderId)
 *
 * checked in `WriteOffService.request`, again by `approvals_write_off_within_balance` at the
 * database, and a third time at the decision because the balance moves in between.
 *
 * ⚠️ **What this file does is not that check.** It compares against the ค้างชำระ figure the order
 * read carries, which is a *snapshot* — a slip accepted a second ago makes it stale. So the refusal
 * below exists to save a round trip and to say something useful while somebody is typing; it is not
 * the guard, it does not claim to be, and removing it would change no invariant. That is why the
 * comparison is `>` against a figure this module was handed rather than a fetch of its own.
 */

/** As typed, and `orderId` from the row rather than from a field nobody can see. */
export interface WriteOffFields {
  /** In **baht**, as a person types it. `readSatang` decides whether it is a number at all. */
  readonly amount: string;
  readonly reasonTh: string;
}

/**
 * ⚠️ Long enough that *"ไม่จ่าย"* does not pass.
 *
 * `approvals.reason_th` is NOT NULL and it is the **entire** audit trail for money the company chose
 * not to collect — the row an owner reads next year asking why ฿20,000 left. The API's schema asks
 * for one character, which is the honest minimum for a wire; this asks for a sentence, which is what
 * makes the record worth keeping. Same call `no-slip.ts`'s `MIN_REASON_LENGTH` makes about the
 * evidence-free payment, and the same number, deliberately: two thresholds for "explain yourself in
 * writing" would be two numbers to keep in step.
 */
export const MIN_REASON_LENGTH = 10;

export interface WriteOffBody {
  /** The wire wants a bare digit string in satang — `authority.contract.ts`'s `minorSchema`. */
  readonly amountThbMinor: string;
  readonly reasonTh: string;
}

export type WriteOffFormResult =
  | { readonly ok: true; readonly body: WriteOffBody }
  | { readonly ok: false; readonly problemsTh: readonly string[] };

/**
 * Every refusal at once, in Thai, or the body to POST.
 *
 * ⚠️ All problems are collected rather than the first returned. A form that reveals one mistake at a
 * time makes somebody submit four times to learn four things, and the second submit is where they
 * start guessing.
 *
 * ⚠️ **Satang, as a `bigint`, and never a `number`.** `readSatang` is `@wewin/core/money`'s parser —
 * the same one the slip forms use — because `Number('')` is 0, `Number(' ')` is 0 and `Number('1e3')`
 * is 1000, which are three ways for a field somebody believes is empty to become a debt forgiveness.
 */
export function writeOffFormBody(
  fields: WriteOffFields,
  /**
   * ค้างชำระ as the order read reported it, or `null` when the wire states no figure (a cart, or a
   * cancelled order). ⚠️ A snapshot, not the guard — see the header.
   */
  outstandingThbMinor: bigint | null,
): WriteOffFormResult {
  const problemsTh: string[] = [];

  const amount = readSatang(fields.amount.trim());
  if (!amount.ok || amount.value <= 0n) {
    problemsTh.push('ยอดที่ขอตัดทิ้งต้องเป็นตัวเลขที่มากกว่าศูนย์');
  }

  /*
   * ⚠️ Only when both figures are known. `null` means the wire stated no ค้างชำระ at all, and
   * inventing ฿0.00 for it here would refuse every write-off on an order this screen simply has no
   * balance for — where the server's own refusal is the correct and better-worded one.
   */
  if (amount.ok && outstandingThbMinor !== null && amount.value > outstandingThbMinor) {
    problemsTh.push('ยอดที่ขอตัดทิ้งมากกว่ายอดคงค้างของออเดอร์นี้');
  }

  const reason = fields.reasonTh.trim();
  if (reason.length < MIN_REASON_LENGTH) {
    problemsTh.push(
      `ต้องระบุเหตุผล อย่างน้อย ${String(MIN_REASON_LENGTH)} ตัวอักษร — เหตุผลนี้จะถูกเก็บไว้ถาวรเพื่อการตรวจสอบย้อนหลัง`,
    );
  }

  if (problemsTh.length > 0 || !amount.ok) return { ok: false, problemsTh };

  return {
    ok: true,
    body: { amountThbMinor: amount.value.toString(), reasonTh: reason },
  };
}

/**
 * ⭐ Whether the order's money card offers the button at all — and why, when it does not.
 *
 * Three states rather than a boolean, because *"there is nothing to write off"* and *"you may not
 * ask"* are different news and only one of them is worth a sentence on the screen.
 *
 *   `available`     a live contract with a balance. The button is offered.
 *   `nothingOwed`   ฿0.00 or no figure — a cart, a cancelled order, a settled one, or one already
 *                   written off. ⚠️ **The button is hidden and nothing is said.** A disabled control
 *                   under a ฿0.00 balance is an invitation to work out what is wrong with an order
 *                   that has nothing wrong with it.
 *   `pending`       a request is already waiting for an answer.
 *                   `approvals_one_open_per_order_dimension` would refuse a second, so offering the
 *                   button would offer a 409 — and *this* one does carry a sentence, because the
 *                   reader needs to know the ask has been made and by whom it is being held up.
 */
export type WriteOffAvailability =
  | { readonly kind: 'available'; readonly outstandingThbMinor: bigint }
  | { readonly kind: 'nothingOwed' }
  | { readonly kind: 'pending'; readonly approvalId: string };

export function writeOffAvailability(facts: {
  readonly outstandingThbMinor: bigint | null;
  /**
   * The order's pending `cashflow` request, if any — from `GET /quotes/approvals?orderId=`.
   *
   * ⚠️ Either kind occupies the slot: the unique index is `(order_id, dimension) WHERE status =
   * 'pending'` and knows nothing about `kind`, so a pending *quote* cashflow concession blocks a
   * write-off too. The caller passes whichever it found rather than filtering, so this screen and the
   * database agree about what is in the way.
   */
  readonly pendingCashflowApprovalId: string | null;
}): WriteOffAvailability {
  if (facts.pendingCashflowApprovalId !== null) {
    return { kind: 'pending', approvalId: facts.pendingCashflowApprovalId };
  }

  const outstanding = facts.outstandingThbMinor;
  /* `<= 0n` and not `=== 0n`: an overpaid order is a modelled state and has nothing to forgive. */
  if (outstanding === null || outstanding <= 0n) return { kind: 'nothingOwed' };

  return { kind: 'available', outstandingThbMinor: outstanding };
}
