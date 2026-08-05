import { describe, expect, it } from 'vitest';

import { toBigInt, unitOf } from '../src/exact.js';
import { encodeBasisPoints } from '../src/measure.js';
import { encodeThb } from '../src/order.js';
import {
  INSTALMENT_BASES_WIRE,
  authorScheduleRequestWireSchema,
  encodeInstalment,
  instalmentWireSchema,
  paymentScheduleWireSchema,
  scheduleTermWireSchema,
  type InstalmentSource,
} from '../src/schedule.js';

/**
 * The schedule on the wire.
 *
 * Two properties are worth a test rather than a reading, and both are about a payload that
 * would otherwise be accepted and then mean something else:
 *
 *   a term carries exactly the parameter its basis needs — the same rule the database's
 *   `order_instalments_basis_shape` CHECK enforces, restated here so a `percent` row with an
 *   amount beside it cannot even be parsed;
 *
 *   `isLocked` is derived, and it is false for a remainder however much money is on it.
 *   A client that renders it as "paid" will be wrong, which is why the flag is computed in
 *   one place and never sent as a stored fact.
 */

const source = (over: Partial<InstalmentSource> = {}): InstalmentSource => ({
  seq: 1,
  basis: 'percent',
  percentBp: 3_000,
  fixedThbMinor: null,
  gatesEntryTo: 'production_confirmed',
  dueThbMinor: 552_960n,
  allocatedThbMinor: 0n,
  ...over,
});

describe('schedule terms on the wire', () => {
  it('accepts one shape per basis and refuses the parameters of another', () => {
    expect(
      scheduleTermWireSchema.safeParse({
        basis: 'percent',
        percentBp: encodeBasisPoints(3_000n),
        gatesEntryTo: 'production_confirmed',
      }).success,
    ).toBe(true);

    expect(
      scheduleTermWireSchema.safeParse({
        basis: 'remainder',
        gatesEntryTo: null,
      }).success,
    ).toBe(true);

    /* A percent row carrying an amount is the row two readers disagree about. */
    expect(
      scheduleTermWireSchema.safeParse({
        basis: 'percent',
        fixedThbMinor: encodeThb(263_700n),
        gatesEntryTo: null,
      }).success,
    ).toBe(false);

    /* And a money field cannot arrive as a bare number, here or anywhere else. */
    expect(
      scheduleTermWireSchema.safeParse({ basis: 'fixed', fixedThbMinor: 263_700, gatesEntryTo: null })
        .success,
    ).toBe(false);
  });

  it('refuses a gate that is not an order status, and an empty authoring request', () => {
    expect(
      scheduleTermWireSchema.safeParse({ basis: 'remainder', gatesEntryTo: 'awaiting_balance' })
        .success,
    ).toBe(false);

    expect(authorScheduleRequestWireSchema.safeParse({ terms: [] }).success).toBe(false);
  });

  it('lists the three bases and no fourth', () => {
    expect([...INSTALMENT_BASES_WIRE]).toEqual(['percent', 'fixed', 'remainder']);
  });
});

describe('an instalment on the wire', () => {
  it('round-trips through its own schema with every amount tagged', () => {
    const wire = encodeInstalment(source({ allocatedThbMinor: 552_960n }));

    expect(instalmentWireSchema.parse(wire)).toEqual(wire);
    expect(toBigInt(wire.dueThbMinor)).toBe(552_960n);
    expect(unitOf(wire.dueThbMinor)).toBe('THB.satang');
    expect(wire.percentBp === null ? null : unitOf(wire.percentBp)).toBe('bp');
  });

  it('locks a paid percent instalment and never a remainder', () => {
    expect(encodeInstalment(source({ allocatedThbMinor: 1n })).isLocked).toBe(true);
    expect(encodeInstalment(source()).isLocked).toBe(false);

    const remainder = source({
      seq: 2,
      basis: 'remainder',
      percentBp: null,
      gatesEntryTo: null,
      allocatedThbMinor: 1_290_240n,
    });
    expect(encodeInstalment(remainder).isLocked).toBe(false);
  });
});

describe('a whole schedule on the wire', () => {
  it('carries the frontier as a seq, and distinguishes "none settled" from "no schedule"', () => {
    const base = {
      orderId: 'aa5a4a2e-0000-4000-8000-000000000001',
      grandTotalThbMinor: encodeThb(1_843_200n),
      scheduledDepositThbMinor: encodeThb(552_960n),
      closedAt: null,
      closedReason: null,
      instalments: [encodeInstalment(source())],
    };

    expect(paymentScheduleWireSchema.safeParse({ ...base, settledThroughSeq: 0 }).success).toBe(true);
    expect(paymentScheduleWireSchema.safeParse({ ...base, settledThroughSeq: null }).success).toBe(
      true,
    );
    expect(paymentScheduleWireSchema.safeParse({ ...base, settledThroughSeq: '1' }).success).toBe(
      false,
    );
  });

  it('accepts only the two reasons a schedule stops having to foot', () => {
    const base = {
      orderId: 'aa5a4a2e-0000-4000-8000-000000000001',
      grandTotalThbMinor: encodeThb(1_843_200n),
      scheduledDepositThbMinor: encodeThb(552_960n),
      settledThroughSeq: 1,
      closedAt: '2026-08-05T00:00:00.000Z',
      instalments: [],
    };

    expect(paymentScheduleWireSchema.safeParse({ ...base, closedReason: 'cancelled' }).success).toBe(
      true,
    );
    expect(paymentScheduleWireSchema.safeParse({ ...base, closedReason: 'superseded' }).success).toBe(
      true,
    );
    expect(paymentScheduleWireSchema.safeParse({ ...base, closedReason: 'delivered' }).success).toBe(
      false,
    );
  });
});
