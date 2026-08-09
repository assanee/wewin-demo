/**
 * ─────────────────────────────────────────────────────────────────────────────
 * WHERE EVERY SATANG OF A TRANSFER GOES — the sum behind the accept button.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `acceptSlipRequestSchema` requires allocations and offers no "just accept it" shape,
 * because plan 7.6 asks for a two-column comparison **rather than a confirm button** — and a
 * request body that could be empty is a confirm button however the screen is drawn. This is
 * the arithmetic that decides whether the reviewer may press it.
 *
 * ── ⚠️ Three outcomes, and the third is why the API grew a field ─────────────
 *
 *   `balanced`  the allocations sum to the slip. Accept.
 *   `short`     they sum to less and no excess was named, so the remainder would land in
 *               `unallocated_thb_minor` — money the company has received that no instalment
 *               knows about. Nothing rejects that request; it is simply wrong afterwards.
 *   `over`      the transfer is larger than the order can absorb. ฿20,000.00 against a
 *               ฿19,722.24 order used to be unacceptable, undeletable and un-rejectable: the
 *               money was in the bank and the system held ฿0.00. Now the reviewer *names* the
 *               ฿277.76, and it has to match — so a mistyped allocation is refused rather
 *               than quietly absorbed as excess, which an acknowledgement checkbox would not
 *               have caught.
 *
 * ── Satang, as `bigint`, all the way ─────────────────────────────────────────
 *
 * No `number` anywhere in this file. Not because ฿90 trillion is reachable — it is not, for
 * this company — but because a `number` in a money path is a rounding decision hiding
 * somewhere on the way to a screen, and there is no version of that which is worth the
 * convenience. The wire carries digits as a string for the same reason.
 *
 * No React here on purpose: this is the part that is right or wrong, and it should be
 * provable without rendering anything.
 */

import { readSatang, satangField, type ParseResult } from '@wewin/core/money';

export { readSatang, satangField, type ParseResult };

export interface Draft {
  readonly instalmentId: string;
  /** Satang. Zero means the reviewer cleared the box — see `sendable`. */
  readonly amountThbMinor: bigint;
}

/** `MoneyWire` as it travels: an opaque tag plus digits. */
export interface MoneyBody {
  readonly unit: 'THB.satang';
  readonly digits: string;
}

export interface AllocationRequest {
  readonly instalmentId: string;
  readonly amountThbMinor: MoneyBody;
}

export interface AllocationPlan {
  /** What the reviewer has placed, in satang. */
  readonly allocated: bigint;
  /** `allocated − slip`. Negative is short, positive cannot happen — see below. */
  readonly differenceThbMinor: bigint;
  readonly state: 'balanced' | 'short' | 'over';
  /**
   * What `acknowledgeOverpaymentThbMinor` must be, or null when nothing is over.
   *
   * Derived rather than typed by hand: the field has to match the excess exactly, so a box
   * the reviewer fills in themselves would just be a second place to make the same mistake.
   */
  readonly acknowledgement: bigint | null;
  /** The allocations to POST. A cleared row is absent, never a zero. */
  readonly sendable: readonly AllocationRequest[];
}

const money = (minor: bigint): MoneyBody => ({ unit: 'THB.satang', digits: minor.toString() });

/**
 * ⚠️ `over` is decided by the *instalments*, not by the sum.
 *
 * A reviewer cannot allocate more than the slip — the boxes are bounded — so `allocated`
 * never exceeds `slipThbMinor` and the difference is never positive from that direction.
 * "Over" is the other shape: the order has less outstanding than the transfer, so the
 * reviewer has allocated everything there is to allocate and there is still money left.
 *
 * `absorbableThbMinor` is therefore **required**, not defaulted. It is the order's
 * outstanding balance, which the review response always carries, and a default of "the slip
 * amount" would make an overpayment structurally undetectable — the one case the field
 * exists for, silently absent. A parameter that can be forgotten is a parameter that will be.
 */
export function allocationPlan(
  slipThbMinor: bigint,
  absorbableThbMinor: bigint,
  drafts: readonly Draft[],
): AllocationPlan {
  /*
   * `positiveThbSchema` refuses an allocation of zero, so a cleared box has to leave the
   * request rather than travel in it. The distinction is not pedantry: a reviewer clearing
   * one line of three expects the other two to be sent, and a zero row would 422 the lot.
   */
  const placed = drafts.filter((draft) => draft.amountThbMinor > 0n);
  const allocated = placed.reduce((total, draft) => total + draft.amountThbMinor, 0n);
  const difference = allocated - slipThbMinor;

  const excess = slipThbMinor - absorbableThbMinor;
  const over = excess > 0n && allocated === absorbableThbMinor;

  return {
    allocated,
    differenceThbMinor: difference,
    state: over ? 'over' : difference === 0n ? 'balanced' : 'short',
    acknowledgement: over ? excess : null,
    sendable: placed.map((draft) => ({
      instalmentId: draft.instalmentId,
      amountThbMinor: money(draft.amountThbMinor),
    })),
  };
}
