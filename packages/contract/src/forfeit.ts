import { z } from 'zod';

import { ORDER_STATUSES_WIRE, type OrderStatusWire } from './order.js';

/**
 * ⭐ อัตราริบมัดจำ — what a cancellation costs, as a thing a person may edit.
 *
 * ── Why this is its own module ──────────────────────────────────────────────────
 *
 * It belongs with the company's other settings and cannot live in `organisation.ts`: that file
 * is imported *by* `order.ts`, and this needs `ORDER_STATUSES_WIRE` from it. The cycle is not
 * hypothetical — `organisation.ts`'s own note on `orderIsLive` records choosing a boolean over
 * a status field for exactly that reason. A third module depending on both has no such problem.
 */

/**
 * One cell of the policy: what a cancellation from this status, with this fault, forfeits.
 *
 * ── Why a cell carries its own lock ─────────────────────────────────────────────
 *
 * Two of the constraints in `forfeit_policy_rules` fix certain cells at 0 and refuse anything
 * else, and neither is a default somebody may override by typing:
 *
 *   `company` fault           the company's own mistake never costs the customer money.
 *   `production_confirmed`    nothing has been cut yet — plan 7.8. Cutting starts at
 *                             `in_production`, which is the first row where a forfeit can be
 *                             about a real cost.
 *
 * A screen that offered those boxes would be offering a 400, so the server says which cells are
 * editable and why the others are not. The list is not restated on the client: the statuses a
 * cancellation can leave from come from `order_status_transitions`, which is also what the
 * database's own completeness check reads.
 */
export interface ForfeitCellWire {
  readonly fromStatus: OrderStatusWire;
  readonly fault: 'customer' | 'company';
  readonly forfeitBp: number;
  /** False when a CHECK fixes this cell at 0 — see `whyLockedTh`. */
  readonly editable: boolean;
  /** Thai, and only when `editable` is false. The reason, for the person looking at the box. */
  readonly whyLockedTh: string | null;
}

/**
 * The policy that applies to a cancellation happening now.
 *
 * ⚠️ `null` cells never appear: a policy that is effective and incomplete cannot exist, because
 * `assert_forfeit_policy_complete()` is a deferred constraint trigger that refuses the
 * transaction. Every cancellable status × fault is present or the read failed.
 */
export interface ForfeitPolicyWire {
  readonly code: string;
  readonly descriptionTh: string;
  readonly effectiveFrom: string;
  readonly cells: readonly ForfeitCellWire[];
}

/**
 * ⭐ Publishing a new policy — which is the only way to change one.
 *
 * An order pins `forfeit_policy_id` at submit, so editing a live policy in place would change
 * what a customer gets back on a contract they had already signed. Policies are therefore
 * versioned by `effective_from` and the newest effective one wins; publishing writes a new
 * version and leaves every existing order pointing at the one it agreed to.
 *
 * ⚠️ Only `customer` cells are sent, and only for statuses the server says are editable. The
 * company-fault half and the freeze-point row are written as 0 by the server, because they are
 * the same 0 in every policy that will ever exist.
 */
export interface PublishForfeitPolicyRequestWire {
  /** What changed and why — this is what somebody reads in a year to explain a refund. */
  readonly descriptionTh: string;
  readonly cells: readonly { readonly fromStatus: OrderStatusWire; readonly forfeitBp: number }[];
}

export const publishForfeitPolicyRequestSchema: z.ZodType<PublishForfeitPolicyRequestWire> =
  z.strictObject({
    descriptionTh: z.string().trim().min(1).max(500),
    cells: z
      .array(
        z.strictObject({
          fromStatus: z.literal(ORDER_STATUSES_WIRE),
          forfeitBp: z.int().min(0).max(10_000),
        }),
      )
      .min(1),
  });
