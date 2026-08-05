import { describe, expect, it } from 'vitest';

import {
  APPROVAL_DIMENSIONS,
  OVERRIDE_ANCHORS,
  OVERRIDE_ENTRY_MODES,
  OVERRIDE_REASONS,
  QUOTE_LINE_KINDS,
} from '@wewin/db/schema';
import {
  ENTRY_MODES_BY_ANCHOR,
  OVERRIDE_ANCHORS_WIRE,
  OVERRIDE_ENTRY_MODES_WIRE,
  OVERRIDE_REASONS_WIRE,
  QUOTE_LINE_KINDS_WIRE,
  setOverrideRequestSchema,
} from '@wewin/contract/quote';

/**
 * The wire's vocabularies against the schema's, member for member.
 *
 * `@wewin/db` is server-only by construction — its package note says so and `turbo boundaries`
 * enforces it — so the unions a browser reads *cannot* be the unions Postgres holds. Restating
 * them is therefore unavoidable; drifting is not. This is the same arrangement, and the same
 * argument, as `tests/orders/contract-drift.pg.test.ts` makes for the nine order statuses.
 *
 * It needs no database: both lists are compile-time constants in two packages, and the failure
 * being guarded against is a vocabulary that grew on one side only.
 */

const sorted = (values: readonly string[]): string[] => [...values].sort();

describe('the quote vocabularies do not drift', () => {
  it.each([
    ['line kinds', QUOTE_LINE_KINDS_WIRE, QUOTE_LINE_KINDS],
    ['override anchors', OVERRIDE_ANCHORS_WIRE, OVERRIDE_ANCHORS],
    ['entry modes', OVERRIDE_ENTRY_MODES_WIRE, OVERRIDE_ENTRY_MODES],
    ['reason codes', OVERRIDE_REASONS_WIRE, OVERRIDE_REASONS],
  ])('%s are the same set on both sides', (_label, wire, schema) => {
    expect(sorted(wire)).toEqual(sorted(schema));
  });

  /*
   * The two dimensions are imported by `authority_limits` from `payment.ts` rather than
   * redeclared, which is plan 7.13's whole point; this asserts the API's own reading of them
   * has not quietly gained a third.
   */
  it('there are exactly the two approval dimensions plan 7.13 settled on', () => {
    expect(sorted(APPROVAL_DIMENSIONS)).toEqual(['cashflow', 'margin']);
  });
});

/**
 * `ENTRY_MODES_BY_ANCHOR` restates `quote_overrides_entry_mode_fits_anchor`. Reading the CHECK
 * out of Postgres would be a better test and belongs to the Postgres suite; what this one buys
 * without a database is that the *request schema* and the table agree with each other, which is
 * the difference between a 400 with a path in it and a 23514 translated into a shrug.
 */
describe('every entry mode belongs to exactly the anchors that accept it', () => {
  it('covers the whole vocabulary and invents nothing', () => {
    const union = new Set(Object.values(ENTRY_MODES_BY_ANCHOR).flat());
    expect(sorted([...union])).toEqual(sorted(OVERRIDE_ENTRY_MODES_WIRE));
  });

  it('refuses a per-unit price typed against a document total', () => {
    const parsed = setOverrideRequestSchema.safeParse({
      expect: { quoteRevision: '0123456789abcdef' },
      anchor: 'grand_total',
      enteredAs: 'unit_price',
      enteredValueText: '9000',
      reasonCode: 'volume',
    });

    /* Plan 7.9(ข)'s "which one wins?", refused at the boundary rather than answered again. */
    expect(parsed.success).toBe(false);
  });

  it('requires a line on a line anchor and refuses one on a document anchor', () => {
    const base = {
      expect: { quoteRevision: '0123456789abcdef' },
      enteredValueText: '8500',
      reasonCode: 'goodwill' as const,
    };

    expect(
      setOverrideRequestSchema.safeParse({ ...base, anchor: 'line_total', enteredAs: 'line_total' })
        .success,
    ).toBe(false);

    expect(
      setOverrideRequestSchema.safeParse({
        ...base,
        anchor: 'grand_total',
        enteredAs: 'grand_total',
        quoteLineId: '11111111-1111-4111-8111-111111111111',
      }).success,
    ).toBe(false);
  });

  /* No request in this contract carries a money amount the server would otherwise compute. */
  it('has no field for a normalised figure to arrive in', () => {
    const parsed = setOverrideRequestSchema.safeParse({
      expect: { quoteRevision: '0123456789abcdef' },
      anchor: 'grand_total',
      enteredAs: 'grand_total',
      enteredValueText: '8500',
      reasonCode: 'goodwill',
      overrideThbMinor: { unit: 'THB.satang', digits: '1' },
    });

    expect(parsed.success).toBe(false);
  });
});
