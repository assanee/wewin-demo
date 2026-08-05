import { z } from 'zod';

import { REFUND_STATUSES } from '@wewin/db/schema';

/**
 * What a refund looks like on the wire, and what a client may send.
 *
 * Declared here rather than in `@wewin/contract` for the reason `media.contract.ts` and
 * `notifications.contract.ts` both give: that package is read by `apps/web` and
 * `apps/dashboard` and is not this round's to change. These shapes move there when somebody
 * builds the screen, and the move is a copy — nothing here depends on where the type lives.
 *
 * ── Three fields a request deliberately does not have ────────────────────────────
 *
 *   `amountThbMinor`            the amount is the obligation the ledger recorded, not a figure
 *                               typed beside one (plan 7.12(1)). It is computed from money
 *                               held minus the forfeit and written to `refunds.amount_thb_minor`
 *                               *and* to the accrual entry, and `refunds_match_accrual` refuses
 *                               them if they disagree. A request that could name the amount
 *                               would make that constraint a comparison of a number with
 *                               itself.
 *
 *   `fault`                     🔒 derived from the `cancelled` event on the spine — who
 *                               cancelled, and whether there was an unresolved bounce. Plan
 *                               7.8: it decides how much money goes back, so it is never read
 *                               from a body. 5a already refuses to record it any other way;
 *                               this module reads what 5a recorded.
 *
 *   `payeeIsOriginalAccount`    derived by comparing the payee against the accepted slips —
 *                               see `payee.ts`. A flag the requester sets is a flag the
 *                               requester sets to `yes`.
 *
 * ── Money on the wire is a string of digits ──────────────────────────────────────
 *
 * Same rule as `@wewin/contract`: `JSON.parse` on a large integer is where a satang goes
 * missing silently, so every amount below is a decimal string in minor units and the client
 * does the widening it chooses.
 */

export const refundStatusSchema = z.enum(REFUND_STATUSES);

/** Thai bank codes are three digits; the shape is checked, the value is not verifiable here. */
const bankCodeSchema = z
  .string()
  .trim()
  .min(2)
  .max(16)
  .regex(/^[A-Za-z0-9_-]+$/u, 'bank code must be alphanumeric');

const payeeSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  bankCode: bankCodeSchema,
  accountLast4: z.string().regex(/^[0-9]{4}$/u, 'the last four digits of the account'),
});

export type PayeeWire = z.infer<typeof payeeSchema>;

/**
 * Ask for a refund on an order that holds money.
 *
 * `payee` is **optional and that is the default path**: omit it and the money goes back to the
 * account it came from, which is what plan 7.12 says must happen without anybody choosing it.
 * Supplying one is allowed, is compared against the slips, and is flagged and separately
 * approved when it does not match — which is why `reasonTh` becomes required in that case, and
 * why the requirement is enforced in the service against the *derived* flag rather than here
 * against the body.
 */
export const createRefundSchema = z.strictObject({
  orderId: z.uuid(),
  payee: payeeSchema.optional(),
  /** Required when the derived payee is not the original account. Free text, read by a human. */
  reasonTh: z.string().trim().min(1).max(1000).optional(),
});

export type CreateRefundWire = z.infer<typeof createRefundSchema>;

/**
 * Approve or refuse — one endpoint, because they are one decision.
 *
 * `acknowledgeDifferentAccount` is the separate approval plan 7.12 asks for, and it is a
 * *second, explicit act* rather than a second permission because `rbac/permissions.ts` is not
 * this agent's file to extend (see the note in `refunds.service.ts`). What it buys: approving a
 * refund to an unrecognised account cannot be done by the same click that approves an ordinary
 * one, so it cannot be done without reading the field that says the account is unrecognised.
 */
export const decideRefundSchema = z.strictObject({
  decision: z.enum(['approved', 'rejected']),
  /** Required on a rejection — `refunds_status_shape` demands it, and so does the requester. */
  noteTh: z.string().trim().min(1).max(1000).optional(),
  acknowledgeDifferentAccount: z.literal(true).optional(),
});

export type DecideRefundWire = z.infer<typeof decideRefundSchema>;

/**
 * Record the transfer that actually happened.
 *
 * `disbursementReference` is not optional and not generated: it is the outbound half of the
 * evidence a slip provides on the way in (plan 7.12, *"ขาออกต้องเข้มเท่ากัน"*). A refund marked
 * paid with no reference is a refund nobody can find in a statement.
 */
export const disburseRefundSchema = z.strictObject({
  disbursementReference: z.string().trim().min(3).max(200),
});

export type DisburseRefundWire = z.infer<typeof disburseRefundSchema>;

export const refundQuerySchema = z.object({
  /** Default `approved` — the payable queue, which is the one plan 7.12 says must be visible. */
  status: z.union([refundStatusSchema, z.array(refundStatusSchema)]).optional(),
  /** The report: every refund going somewhere other than the account that paid. */
  payee: z.enum(['any', 'different']).default('any'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export type RefundQuery = z.infer<typeof refundQuerySchema>;

export interface RefundWire {
  readonly id: string;
  readonly orderId: string;
  readonly orderNo: string | null;
  readonly status: string;
  readonly amountThbMinor: string;
  readonly currency: string;
  readonly accrualEntryId: string;
  readonly payeeName: string;
  readonly payeeBankCode: string;
  readonly payeeAccountLast4: string;
  /** ⚠️ `'no'` is the fraud-shaped path. Derived, never sent. */
  readonly payeeIsOriginalAccount: 'yes' | 'no';
  readonly requestedByUserId: string;
  readonly requestedAt: string;
  readonly approvedByUserId: string | null;
  readonly approvedAt: string | null;
  readonly disbursedByUserId: string | null;
  readonly disbursedAt: string | null;
  readonly disbursementReference: string | null;
  readonly rejectedReasonTh: string | null;
}

/** A refund plus the balances that explain it — the numbers plan 7.13 insists are named apart. */
export interface RefundDetailWire {
  readonly refund: RefundWire;
  readonly money: {
    /** Cash received: the `bank_thb` fold. */
    readonly cashThbMinor: string;
    /** Money in hand: the `deposit_held` fold, negated. NOT cash — a carried revision has none. */
    readonly heldThbMinor: string;
    /** The fold of allocations from accepted slips. Diverges from cash on a bank fee. */
    readonly settledThbMinor: string;
    readonly refundPayableThbMinor: string;
    readonly forfeitedThbMinor: string;
    readonly queueBucket: string;
  };
  /** Which accepted slip the payee matched, when it matched one. See `payee.ts`. */
  readonly matchedSlipId: string | null;
}

export interface RefundListWire {
  readonly refunds: readonly RefundWire[];
  /** The size of the promise, in one number, so the queue does not have to be added up by eye. */
  readonly payableTotalThbMinor: string;
}
