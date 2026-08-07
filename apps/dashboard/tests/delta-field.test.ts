import { describe, expect, it } from 'vitest';
import type { AdminOptionGroupWire } from '@wewin/contract/admin';
import type { PriceDeltaWire } from '@wewin/contract';

import {
  amountFieldText,
  groupMatches,
  readDeltaBaht,
  readDeltaPercent,
} from '@/components/option-groups/delta-field';
import { deltaWire } from '@/components/products/wire';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Opening a value to rename it must not change its price.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `ValueDialog` re-parses and re-encodes the amount on **every** save, including the saves
 * where nobody touched it — the person came to fix a typo in the label. So the render and
 * the parse have to be exact inverses, and the failure mode if they are not is the quietest
 * one in the catalogue: a surcharge that drifts by a rounding step each time somebody edits
 * the label, on a value cited by every product that offers it.
 *
 * The round trip is asserted, not either half. `amountFieldText` alone could be checked
 * against a string and would still pass while `readBaht` disagreed with it about what that
 * string means.
 */

/** What the dialog does between opening and saving, when the amount is left alone. */
function roundTrip(delta: PriceDeltaWire): PriceDeltaWire {
  const text = amountFieldText(delta);
  if (delta.type === 'none') return { type: 'none' };

  const parsed = delta.type === 'percent' ? readDeltaPercent(text) : readDeltaBaht(text);
  if (!parsed.ok) throw new Error(`the field it rendered will not parse: "${text}" — ${parsed.reasonTh}`);

  return deltaWire(delta.type, parsed.value);
}

const flat = (minor: bigint): PriceDeltaWire => deltaWire('flat', minor);
const perSqm = (minor: bigint): PriceDeltaWire => deltaWire('per_sqm', minor);
const percent = (bp: bigint): PriceDeltaWire => deltaWire('percent', bp);

describe('the amount survives being rendered into a field and read back', () => {
  const cases: readonly [string, PriceDeltaWire][] = [
    ['no surcharge', { type: 'none' }],
    ['฿1,200 a set', flat(120_000n)],
    ['฿1 a set — the smallest whole baht', flat(100n)],
    ['a discount of ฿500', flat(-50_000n)],
    ['฿2,400 per m²', perSqm(240_000n)],
    ['฿1 per m²', perSqm(100n)],
    ['8%', percent(800n)],
    ['-15%', percent(-1500n)],
    ['0%', percent(0n)],
  ];

  it.each(cases)('%s', (_name, delta) => {
    expect(roundTrip(delta)).toEqual(delta);
  });
});

describe('each arm carries its own unit, and the compiler is what enforces it', () => {
  /*
   * ⚠️ **Read this before adding a runtime assertion here.**
   *
   * Swapping `rateMinorOf` for `flatMinorOf` in the `per_sqm` arm was tried as a mutation
   * and left every test green — including two written specifically to catch it. The reason
   * is not a gap in the tests: at *runtime* the two decoders are the same function over the
   * same digits, so no assertion over values can distinguish them.
   *
   * What distinguishes them is the type. `MoneyWire<'THB'>` is `THB.satang` and
   * `MoneyRateWire<'THB'>` is `THB.satang/m2`, and the swap does not compile:
   *
   *     Type '"THB.satang/m2"' is not assignable to type '"THB.satang"'.
   *
   * So the guard is `tsc`, it is already in the gate, and the honest thing is to say so
   * rather than to keep a test that cannot fail. What *is* asserted below is the fact that
   * makes the type matter: the two render identically, so nothing a person sees would ever
   * reveal the confusion.
   */
  it('renders ฿1,200 a set and ฿1,200 per m² as the same digits', () => {
    expect(amountFieldText(flat(120_000n))).toBe(amountFieldText(perSqm(120_000n)));
    // Identical text, different money. Which is why the unit lives in the type and not in
    // the field, and why `deltaWire` takes the arm as an argument rather than inferring it.
    expect(flat(120_000n)).not.toEqual(perSqm(120_000n));
  });
});

describe('the field never offers a figure that cannot be read back', () => {
  it('renders nothing at all for `none`, rather than a zero somebody would keep', () => {
    /*
     * An empty string and not `"0"`. `"0"` parses, so a person who switched the arm from
     * `none` to `flat` would be looking at a valid ฿0 surcharge they did not choose — and
     * `error.quote.line_charge_zero` exists in the API precisely because zero-baht rows are
     * a thing this system refuses to treat as meaningful.
     */
    expect(amountFieldText({ type: 'none' })).toBe('');
    expect(amountFieldText(undefined)).toBe('');
  });

  it('renders whole units, because that is all the parsers accept', () => {
    // `readBaht` refuses anything with a decimal point. A renderer that produced `"1200.00"`
    // would make every existing value unsaveable until the person deleted the decimals.
    for (const [, delta] of [
      ['', flat(120_000n)],
      ['', perSqm(240_000n)],
      ['', percent(800n)],
    ] as const) {
      expect(amountFieldText(delta)).not.toContain('.');
    }
  });
});

/* ------------------------------------------------------------------ *
 * The search
 * ------------------------------------------------------------------ */

const group: AdminOptionGroupWire = {
  code: 'glass_color',
  kind: 'sku',
  labelTh: 'สีกระจก',
  input: 'swatch',
  includeInSkuCode: true,
  values: [
    {
      code: 'GRN',
      labelTh: 'เขียวใส',
      swatchHex: '#2E5B45',
      delta: { type: 'none' },
      available: true,
      sortOrder: 0,
    },
    { code: 'CLR', labelTh: 'ใส', delta: { type: 'none' }, available: false, sortOrder: 1 },
  ],
};

describe('finding a group by what somebody actually knows', () => {
  it('matches on a value’s label, not only on the group’s', () => {
    /*
     * ⭐ The assertion this function exists for. An operator looking for a colour knows
     * "เขียวใส"; they do not know it lives under `glass_color`. A search restricted to group
     * names answers "not found" for the question this screen is opened to answer.
     */
    expect(groupMatches(group, 'เขียวใส')).toBe(true);
    expect(groupMatches(group, 'GRN')).toBe(true);
  });

  it('matches on the group’s own code and label', () => {
    expect(groupMatches(group, 'glass')).toBe(true);
    expect(groupMatches(group, 'สีกระจก')).toBe(true);
  });

  it('ignores case, so a typed code finds a stored one', () => {
    // Value codes are upper case in the catalogue and nobody types them that way.
    expect(groupMatches(group, 'grn')).toBe(true);
    expect(groupMatches(group, 'GLASS_COLOR')).toBe(true);
  });

  it('treats an empty or blank needle as “everything”', () => {
    expect(groupMatches(group, '')).toBe(true);
    expect(groupMatches(group, '   ')).toBe(true);
  });

  it('does not match something that is in neither', () => {
    expect(groupMatches(group, 'อะลูมิเนียม')).toBe(false);
  });
});
