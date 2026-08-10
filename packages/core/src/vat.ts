import { divRoundHalfUp } from './money.js';

/**
 * VAT as three amounts that always sit together.
 *
 * The business decision (plan 4.4) was "make VAT configurable". Taken literally that
 * would let a quote declare whether its own total includes tax, which makes the
 * figure filed on a ภ.พ.30 return something a salesperson types. So the configurable
 * part is the rate and the treatment, and the fixed part is this:
 *
 *   grandMinor always includes VAT.
 *
 * Everything downstream — instalments, deposit percentages, forfeits, refunds —
 * refers to `grandMinor` and nothing else. `vatMinor` is derived, never entered.
 * Inclusive-versus-exclusive is a property of the destination's settings — one row per
 * country in `tax_countries`, editable only by a holder of `organisation.write`, and never a
 * field on a quote. `TaxRule` still carries exactly a rate and a treatment, so no code path
 * can vary the basis per line or per quotation; the caller reads the destination and picks
 * `fromNet` or `fromGrand`. What a salesperson cannot do is still the point.
 */

export const TAX_TREATMENTS = ['standard', 'zero_rated', 'exempt', 'out_of_scope'] as const;

export type TaxTreatment = (typeof TAX_TREATMENTS)[number];

export interface TaxRule {
  /** Basis points, so 7% is 700. Integer everywhere: 7% is 7% in every currency. */
  readonly rateBp: number;
  readonly treatment: TaxTreatment;
}

export interface TaxedAmount {
  /** The tax base. */
  readonly netMinor: bigint;
  /** Derived. Never typed by a human. */
  readonly vatMinor: bigint;
  /** What the customer transfers. The only figure the rest of the system quotes. */
  readonly grandMinor: bigint;
}

const BP = 10_000n;

function assertRate({ rateBp }: TaxRule): void {
  if (!Number.isInteger(rateBp) || rateBp < 0) {
    throw new RangeError(`vat: rateBp must be a non-negative integer, got ${String(rateBp)}`);
  }
}

/** Whether this rule charges anything. `standard` at 0 bp still files differently from `exempt`. */
const charges = (rule: TaxRule): boolean => rule.treatment === 'standard' && rule.rateBp > 0;

/** Sales typed a figure before tax. */
export function fromNet(netMinor: bigint, rule: TaxRule): TaxedAmount {
  assertRate(rule);
  if (!charges(rule)) return { netMinor, vatMinor: 0n, grandMinor: netMinor };

  const vatMinor = divRoundHalfUp(netMinor * BigInt(rule.rateBp), BP);
  return { netMinor, vatMinor, grandMinor: netMinor + vatMinor };
}

/**
 * Sales typed the figure the customer will actually transfer.
 *
 * VAT comes out of the subtraction rather than a second multiplication. Multiplying
 * the derived net by the rate is off by a minor unit often enough to matter, and an
 * invoice whose three numbers do not add up is one nobody can sign.
 */
export function fromGrand(grandMinor: bigint, rule: TaxRule): TaxedAmount {
  assertRate(rule);
  if (!charges(rule)) return { netMinor: grandMinor, vatMinor: 0n, grandMinor };

  const netMinor = divRoundHalfUp(grandMinor * BP, BP + BigInt(rule.rateBp));
  return { netMinor, vatMinor: grandMinor - netMinor, grandMinor };
}
