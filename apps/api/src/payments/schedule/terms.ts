import type { InstalmentBasis, OrderStatus } from '@wewin/db/schema';
import { toBigInt } from '@wewin/contract/exact';
import { decodeBasisPoints } from '@wewin/contract/measure';
import type { ScheduleTermWire } from '@wewin/contract/schedule';

import { FREEZE_GATE_STATUS } from './defaults';

/**
 * A schedule as somebody *states* it, before any total has been applied.
 *
 * The distinction between a term and an instalment is the whole reason a recompute is
 * possible at all: a term is the intent ("30% of whatever it comes to", "฿2,637 flat",
 * "whatever is left"), an instalment is that intent evaluated against one total. Plan 7.10
 * is explicit that the two forms of deposit behave differently when the price moves — a
 * percent deposit follows the price, a fixed one stays put and the remainder absorbs the
 * difference — and both are correct, so the model has to remember which was chosen.
 *
 * A discriminated union rather than three nullable fields, mirroring the database's
 * `order_instalments_basis_shape` CHECK: a row carries exactly the parameter its basis
 * needs. The alternative shape can express `{ basis: 'percent', fixedThbMinor: 500 }`, which
 * two readers will resolve differently, and one of those readers is the recompute.
 */
export type ScheduleTerm =
  | {
      readonly basis: 'percent';
      /** Basis points of the grand total. 3000 is the 30 of a 30/70. */
      readonly percentBp: number;
      readonly gatesEntryTo: OrderStatus | null;
    }
  | {
      readonly basis: 'fixed';
      readonly fixedThbMinor: bigint;
      readonly gatesEntryTo: OrderStatus | null;
    }
  | {
      readonly basis: 'remainder';
      readonly gatesEntryTo: OrderStatus | null;
    };

export const basisOf = (term: ScheduleTerm): InstalmentBasis => term.basis;

/* ------------------------------------------------------------------ *
 * The three presets plan 7.10 says the UI offers
 * ------------------------------------------------------------------ */

/**
 * Payment in full — the default, and plan 13's documented gate floor.
 *
 * **One row.** Not "no schedule", and not a special case anywhere downstream: a single
 * `remainder` gating `production_confirmed` is what makes "no deposit" and "30/70" the same
 * code path, which is the entire point of splitting the basis from the gate (plan 7.5(ก)).
 * A schedule that existed only when there was a deposit would put an `if` in every reader.
 */
export const payInFullTerms = (): readonly ScheduleTerm[] => [
  { basis: 'remainder', gatesEntryTo: FREEZE_GATE_STATUS },
];

/**
 * A percentage deposit, then the balance. 30/70 is `depositPercentTerms(3000)`.
 *
 * The balance is a `remainder` and never a second `percent` row, and that is the ฿1 in plan
 * 7.5(ก): two halves that each round land on ฿8,792 for an ฿8,791 order. Only "the last one
 * is the difference" foots, and `remainder` is how that is *said* rather than discovered.
 *
 * The balance gates nothing by default. Plan 7.5(ข): the deposit did not move the freeze
 * point, so the balance instalment is settled while the order is already in production, and
 * a gate on it would be a second freeze nobody designed. Callers who want the balance to
 * gate `awaiting_installation` pass their own terms — the model allows it and no preset
 * chooses it.
 */
export const depositPercentTerms = (percentBp: number): readonly ScheduleTerm[] => [
  { basis: 'percent', percentBp, gatesEntryTo: FREEZE_GATE_STATUS },
  { basis: 'remainder', gatesEntryTo: null },
];

/**
 * A deposit sales typed as an amount, then the balance.
 *
 * Plan 7.10's warning is the reason this is a separate preset rather than a percentage
 * computed at authoring time: when the price later moves, this deposit **does not**. ฿2,637
 * stays ฿2,637 and the remainder swallows the whole difference. Both behaviours are correct
 * and sales has to be told which one they are choosing — which cannot happen if the two
 * collapse into one shape the moment they are stored.
 */
export const depositFixedTerms = (fixedThbMinor: bigint): readonly ScheduleTerm[] => [
  { basis: 'fixed', fixedThbMinor, gatesEntryTo: FREEZE_GATE_STATUS },
  { basis: 'remainder', gatesEntryTo: null },
];

/* ------------------------------------------------------------------ *
 * The 5c seam
 * ------------------------------------------------------------------ */

/**
 * A term as it arrives from a client — the only conversion, and it is not wired to a route.
 *
 * Plan 7.10 puts sales-authored schedules behind an authority check: a gate below the floor,
 * or no gate at all, is the company extending credit and is a permission distinct from the
 * one that allows a discount. That check is 5c's, and until it exists nothing in this
 * application calls this function with a body a client sent. It is here so that when 5c adds
 * the route it adds a route, and not a second instalment model.
 */
export function termFromWire(wire: ScheduleTermWire): ScheduleTerm {
  switch (wire.basis) {
    case 'percent':
      return {
        basis: 'percent',
        percentBp: Number(decodeBasisPoints(wire.percentBp)),
        gatesEntryTo: wire.gatesEntryTo,
      };
    case 'fixed':
      return {
        basis: 'fixed',
        fixedThbMinor: toBigInt(wire.fixedThbMinor),
        gatesEntryTo: wire.gatesEntryTo,
      };
    default:
      return { basis: 'remainder', gatesEntryTo: wire.gatesEntryTo };
  }
}
