import { z } from 'zod';
import { type BasisPointsWire, basisPointsWireSchema, encodeBasisPoints } from './measure.js';
import { type MoneyWire, moneyWireSchema } from './money.js';
import { ORDER_STATUSES_WIRE, encodeThb, type OrderStatusWire } from './order.js';

/**
 * The instalment schedule on the wire — phase 5b.
 *
 * An instalment is **a basis and a gate** (plan 7.5(ก)), and that is the whole model:
 *
 *   basis   `percent` (basis points of the grand total) · `fixed` (a figure sales typed) ·
 *           `remainder` (whatever is left) — at most one remainder, always last.
 *   gate    the order status this instalment must be settled through before the order may
 *           enter it, or `null` for an instalment that gates nothing.
 *
 * No deposit, a 30/70 split and payment in full are then the same shape with different rows,
 * and no client needs a branch for any of them. Payment in full is one `remainder` row
 * gating `production_confirmed`; 30/70 is a `percent` row with that gate followed by a
 * `remainder` without one.
 *
 * ── Three things this module deliberately does not carry ─────────────────────────
 *
 * **No `awaiting_balance`, and no outstanding-balance field.** Plan 7.5(ข) refuses the
 * status, and the field would be the same mistake one layer down: an outstanding balance is
 * a *fold* over allocations, and shipping it beside `settledThroughSeq` invites a client to
 * compute it a second way. Plan 7.13's seam — `settled` and `cash` are different numbers and
 * neither substitutes for the other — is easiest to keep when the wire exposes the parts and
 * not a total somebody has to reconcile.
 *
 * **No frontier arithmetic.** `settledThroughSeq` is `MAX(seq)` over the settled prefix, and
 * it is computed by `order_settled_through()` in Postgres and by nothing else, anywhere
 * (plan 7.5(ค)). It travels here as a number so a client can render "งวดที่ 1 ชำระแล้ว"
 * without a second formula that disagrees the moment `seq` is not what somebody assumed.
 *
 * **No settlement of any kind.** Whether a slip was accepted, and what it settled, belongs
 * to the slip module. `allocatedThbMinor` appears per instalment because the schedule screen
 * has to grey out a locked row, and it is the only fact this module reads from that side.
 *
 * SEAM 5c: `ScheduleTermWire` is the authoring shape and nothing in 5b accepts it over HTTP.
 * Plan 7.10 puts sales-authored schedules behind an authority check (`approvals`, dimension
 * `cashflow`), and until that exists the terms are produced by the presets in the API.
 */

/* ------------------------------------------------------------------ *
 * Closed sets
 * ------------------------------------------------------------------ */

/**
 * Restated rather than imported, exactly as `ORDER_STATUSES_WIRE` is and for the same
 * reason: `@wewin/db` is server-only, so a browser cannot read the union Postgres holds.
 * `apps/api/tests/payments/schedule/contract-drift.pg.test.ts` compares this list member for
 * member with `INSTALMENT_BASES` in the schema.
 */
export const INSTALMENT_BASES_WIRE = ['percent', 'fixed', 'remainder'] as const;

export type InstalmentBasisWire = (typeof INSTALMENT_BASES_WIRE)[number];

export const SCHEDULE_CLOSE_REASONS_WIRE = ['cancelled', 'superseded'] as const;

export type ScheduleCloseReasonWire = (typeof SCHEDULE_CLOSE_REASONS_WIRE)[number];

const thb = moneyWireSchema('THB');
const gateSchema = z.literal(ORDER_STATUSES_WIRE).nullable();

/* ------------------------------------------------------------------ *
 * Authoring — the 5c seam, defined now so 5c adds a route and not a model
 * ------------------------------------------------------------------ */

/**
 * One row as an author states it, before any total is applied to it.
 *
 * A discriminated union rather than three nullable columns, because the database's
 * `order_instalments_basis_shape` CHECK says the same thing — a row carries exactly the
 * parameter its basis needs — and a wire shape that allowed `{ basis: 'percent',
 * fixedThbMinor: … }` would be a payload two readers can disagree about, one of which is
 * the recompute.
 *
 * ⚠️ `fixed` is the **first money a request body has ever carried** in this contract.
 * `order.ts` states flatly that no request carries money, and that rule was right for 5a
 * where the server prices everything. Plan 7.9 reverses it deliberately for the quote —
 * "sales is the authority, the system is the recorder" — and the replacement control is not
 * "is this number correct" (unanswerable) but "who produced it and were they allowed to".
 * So this field exists, it is inert in 5b, and 5c must not merge it without the authority
 * check plan 7.10 attaches to it.
 */
export type ScheduleTermWire =
  | {
      readonly basis: 'percent';
      readonly percentBp: BasisPointsWire;
      readonly gatesEntryTo: OrderStatusWire | null;
    }
  | {
      readonly basis: 'fixed';
      readonly fixedThbMinor: MoneyWire<'THB'>;
      readonly gatesEntryTo: OrderStatusWire | null;
    }
  | {
      readonly basis: 'remainder';
      readonly gatesEntryTo: OrderStatusWire | null;
    };

export const scheduleTermWireSchema: z.ZodType<ScheduleTermWire> = z.discriminatedUnion('basis', [
  z.object({
    basis: z.literal('percent'),
    percentBp: basisPointsWireSchema,
    gatesEntryTo: gateSchema,
  }),
  z.object({
    basis: z.literal('fixed'),
    fixedThbMinor: thb,
    gatesEntryTo: gateSchema,
  }),
  z.object({
    basis: z.literal('remainder'),
    gatesEntryTo: gateSchema,
  }),
]);

/**
 * A whole schedule, authored at once.
 *
 * Whole and not row-by-row: "at most one remainder, and it is last" and "the rows foot to
 * the total" are both properties of the *set*, and an endpoint that accepted one row at a
 * time would have to allow the set to be invalid in between — which is the state a
 * half-finished edit leaves behind when the second request never arrives.
 */
export interface AuthorScheduleRequestWire {
  readonly terms: readonly ScheduleTermWire[];
}

export const authorScheduleRequestWireSchema: z.ZodType<AuthorScheduleRequestWire> = z.object({
  terms: z.array(scheduleTermWireSchema).min(1),
});

/* ------------------------------------------------------------------ *
 * The schedule as it stands
 * ------------------------------------------------------------------ */

export interface InstalmentWire {
  /** 1-based and dense. The frontier is a `MAX(seq)`, which only agrees with a count here. */
  readonly seq: number;
  readonly basis: InstalmentBasisWire;
  readonly percentBp: BasisPointsWire | null;
  readonly fixedThbMinor: MoneyWire<'THB'> | null;
  readonly gatesEntryTo: OrderStatusWire | null;
  /** What is owed. Stored, not derived: the last row is *defined* as the difference. */
  readonly dueThbMinor: MoneyWire<'THB'>;
  /** What accepted slips have settled against this row. The slip module's fact, rendered here. */
  readonly allocatedThbMinor: MoneyWire<'THB'>;
  /**
   * Whether a recompute may still move this row.
   *
   * `allocated > 0` **and the basis is not `remainder`**. The second half is the one that
   * surprises: a remainder cannot be locked, because absorbing the difference is what it is
   * for (plan 7.5(ง)), so a paid remainder is still editable and the frontier can move
   * backwards when a price rises. A client that renders this flag as "paid" will be wrong;
   * it means "fixed", and that is why it is not called `isPaid`.
   */
  readonly isLocked: boolean;
}

export interface PaymentScheduleWire {
  readonly orderId: string;
  /** The single base everything here foots to. Plan 7.13; never derived from a presentment currency. */
  readonly grandTotalThbMinor: MoneyWire<'THB'>;
  /**
   * The deposit obligation this schedule implies — the prefix that must be settled before
   * the order may enter `production_confirmed`.
   *
   * The *prefix*, not the sum of gate-holding rows: the frontier is a settled prefix, so an
   * ungated instalment sitting in front of the gating one is just as required. On a 20/10/70
   * where the gate is on the second row, the obligation is 30% and not 10%.
   *
   * ⚠️ Compare it with `OrderMoneyWire.scheduledDepositThbMinor`, which is the figure
   * **pinned at submit** and is the ceiling on any forfeit. They are the same number on the
   * day the order is submitted and they are allowed to diverge afterwards — the pin is a
   * term of the contract and this is what the schedule says today. A client showing "what
   * you owe before production" wants this one; anything about a cancellation wants the pin.
   */
  readonly scheduledDepositThbMinor: MoneyWire<'THB'>;
  /**
   * `MAX(seq)` over the settled prefix, from `order_settled_through()` and from nowhere else.
   *
   * `MIN(seq) - 1` — so `0` on a dense schedule — when nothing is settled, and `null` when
   * there is no schedule at all. Zero and null are different answers and the second is not a
   * tidier spelling of the first.
   */
  readonly settledThroughSeq: number | null;
  /** Set when the order became `cancelled` or `superseded`; the footing assertion then stops. */
  readonly closedAt: string | null;
  readonly closedReason: ScheduleCloseReasonWire | null;
  readonly instalments: readonly InstalmentWire[];
}

export const instalmentWireSchema: z.ZodType<InstalmentWire> = z.object({
  seq: z.int().min(1),
  basis: z.literal(INSTALMENT_BASES_WIRE),
  percentBp: basisPointsWireSchema.nullable(),
  fixedThbMinor: thb.nullable(),
  gatesEntryTo: gateSchema,
  dueThbMinor: thb,
  allocatedThbMinor: thb,
  isLocked: z.boolean(),
});

export const paymentScheduleWireSchema: z.ZodType<PaymentScheduleWire> = z.object({
  orderId: z.string().min(1),
  grandTotalThbMinor: thb,
  scheduledDepositThbMinor: thb,
  settledThroughSeq: z.int().nullable(),
  closedAt: z.string().nullable(),
  closedReason: z.literal(SCHEDULE_CLOSE_REASONS_WIRE).nullable(),
  instalments: z.array(instalmentWireSchema),
});

/* ------------------------------------------------------------------ *
 * Codecs
 * ------------------------------------------------------------------ */

/**
 * Basis points travel as an `Exact` with a `bp` tag, like every other exact integer here.
 *
 * The tag is doing the same job it does for money: `3000` alone is a number that reads as
 * plausible whether it means 30%, 3000% or ฿30. `{ "unit": "bp", "digits": "3000" }` reads
 * only one way.
 */
export const encodeInstalmentPercent = (percentBp: number): BasisPointsWire =>
  encodeBasisPoints(BigInt(percentBp));

export interface InstalmentSource {
  readonly seq: number;
  readonly basis: InstalmentBasisWire;
  readonly percentBp: number | null;
  readonly fixedThbMinor: bigint | null;
  readonly gatesEntryTo: OrderStatusWire | null;
  readonly dueThbMinor: bigint;
  readonly allocatedThbMinor: bigint;
}

/**
 * The one place `isLocked` is computed on the way out.
 *
 * It is derived here rather than stored anywhere because the database derives it the same
 * way — `order_instalments_guard_write()` asks `EXISTS (an allocation)` and refuses the
 * UPDATE — and a boolean column would be a second copy of a fact that is already stored
 * exactly once, in the allocations.
 */
export const encodeInstalment = (row: InstalmentSource): InstalmentWire => ({
  seq: row.seq,
  basis: row.basis,
  percentBp: row.percentBp === null ? null : encodeInstalmentPercent(row.percentBp),
  fixedThbMinor: row.fixedThbMinor === null ? null : encodeThb(row.fixedThbMinor),
  gatesEntryTo: row.gatesEntryTo,
  dueThbMinor: encodeThb(row.dueThbMinor),
  allocatedThbMinor: encodeThb(row.allocatedThbMinor),
  isLocked: row.basis !== 'remainder' && row.allocatedThbMinor > 0n,
});
