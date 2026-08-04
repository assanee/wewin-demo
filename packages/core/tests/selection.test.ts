import { describe, expect, test } from 'vitest';

import { getProductById } from '../src/data/products.js';
import { calcPrice } from '../src/pricing.js';
import { resolveSelection, resolveSelections } from '../src/selection.js';
import { buildSkuCode } from '../src/skuCode.js';
import { toMicrons } from '../src/units.js';
import { hasBlockingError, validate } from '../src/validation.js';
import type { Product, SkuGroup } from '../src/types/catalog.js';

/**
 * One resolution for the price and for the SKU — the 12,840-baht defect, at the unit level.
 *
 * There used to be two answers to "what did the customer pick". `pricing.ts` matched the
 * selection against the group's values **exactly** and, on no match, contributed nothing at
 * all; `skuCode.ts` upper-cased whatever string it was handed. So `control=mot` on a louvre
 * was priced as manual and stamped `LVR1-SG-B150-MOT` — byte-identical to the motorised
 * contract, 48% cheaper, reachable by an anonymous guest, and the factory builds the stamp.
 *
 * The property to hold on to is not "lower case is accepted". It is that **no input produces
 * a SKU that names something the price did not charge for**, which is what the last test in
 * this file asserts over the whole catalogue rather than over one example.
 */

const product = (id: string): Product => {
  const found = getProductById(id);
  if (!found) throw new Error(`fixture missing: ${id}`);
  return found;
};

const cm = (value: number): bigint => toMicrons(value, 'cm');

const skuGroups = (item: Product): SkuGroup[] =>
  item.groups.filter((group): group is SkuGroup => group.kind === 'sku');

/** The first group of a product that has a value with a non-zero price delta. */
function pricedGroup(item: Product): { group: SkuGroup; code: string } {
  for (const group of skuGroups(item)) {
    const priced = group.values.find(
      (value) => value.delta.type !== 'none' && value.delta.amount !== 0,
    );
    if (priced) return { group, code: priced.code };
  }
  throw new Error(`no priced option on ${item.id}`);
}

describe('resolveSelection', () => {
  test('an exact match wins, and is checked before anything else', () => {
    const item = product('lvr-adj-3');
    const control = skuGroups(item).find((group) => group.code === 'control');
    if (!control) throw new Error('fixture changed: lvr-adj-3 has no control group');

    const resolved = resolveSelection(control, { control: 'MOT' });
    expect(resolved.value.code).toBe('MOT');
    expect(resolved.recognised).toBe(true);
  });

  test('a unique case-insensitive match normalises to the catalogue’s spelling', () => {
    const item = product('lvr-adj-3');
    const control = skuGroups(item).find((group) => group.code === 'control');
    if (!control) throw new Error('fixture changed: lvr-adj-3 has no control group');

    const resolved = resolveSelection(control, { control: 'mot' });
    expect(resolved.value.code).toBe('MOT');
    expect(resolved.recognised).toBe(true);
  });

  test('a missing selection is the group default, and counts as recognised', () => {
    const item = product('awn-4t');
    const colour = skuGroups(item)[0];
    if (!colour) throw new Error('fixture changed');

    const resolved = resolveSelection(colour, {});
    expect(resolved.value.code).toBe(colour.defaultValue);
    expect(resolved.recognised).toBe(true);
  });

  test('an unknown code falls back to the default and says it was not recognised', () => {
    const item = product('awn-4t');
    const colour = skuGroups(item)[0];
    if (!colour) throw new Error('fixture changed');

    const resolved = resolveSelection(colour, { [colour.code]: 'NO_SUCH_CODE' });
    expect(resolved.value.code).toBe(colour.defaultValue);
    expect(resolved.recognised).toBe(false);
  });

  test('two codes differing only in case resolve neither, rather than guessing', () => {
    /*
     * The catalogue has no such group and `productSchema` would be the place to forbid one.
     * The rule is asserted here because the *resolution* has to be safe on its own: a
     * case-insensitive match that picked the first of two would be a coin toss deciding
     * which option a customer bought.
     */
    const base = product('awn-4t');
    const colour = skuGroups(base)[0];
    if (!colour) throw new Error('fixture changed');

    const ambiguous: SkuGroup = {
      ...colour,
      values: [
        { ...colour.values[0]!, code: 'ZZ' },
        { ...colour.values[0]!, code: 'zz' },
        ...colour.values.slice(1),
      ],
      defaultValue: colour.values[1]?.code ?? colour.defaultValue,
    };

    expect(resolveSelection(ambiguous, { [colour.code]: 'Zz' }).recognised).toBe(false);
  });
});

describe('the price and the SKU cannot describe different windows', () => {
  test('a lower-case upgrade is charged for, and the SKU says the same thing', () => {
    const item = product('lvr-adj-3');
    const { group, code } = pricedGroup(item);
    const measures = { width: cm(150), height: cm(120) };

    const honest = { [group.code]: code };
    const shouted = { [group.code]: code.toLowerCase() };

    expect(calcPrice(item, shouted, measures, 1).totalMinor).toBe(
      calcPrice(item, honest, measures, 1).totalMinor,
    );
    expect(buildSkuCode(item, shouted)).toBe(buildSkuCode(item, honest));
  });

  test('an unknown code is a blocking error, not a silent discount', () => {
    const item = product('lvr-adj-3');
    const { group } = pricedGroup(item);
    const measures = { width: cm(150), height: cm(120) };

    const issues = validate(item, { [group.code]: 'NO_SUCH_CODE' }, measures);
    const reported = issues.find((issue) => issue.ruleId === `selection:${group.code}`);

    expect(reported?.severity).toBe('error');
    expect(reported?.affects).toStrictEqual([group.code]);
    expect(hasBlockingError(issues)).toBe(true);

    /* …and it is priced as the default rather than as free, so the two readers agree. */
    expect(calcPrice(item, { [group.code]: 'NO_SUCH_CODE' }, measures, 1).totalMinor).toBe(
      calcPrice(item, {}, measures, 1).totalMinor,
    );
    expect(buildSkuCode(item, { [group.code]: 'NO_SUCH_CODE' })).toBe(buildSkuCode(item, {}));
  });

  test('a leftover key from an older catalogue is not an error — only a wrong value is', () => {
    /*
     * Stored carts and share links carry keys for groups a product no longer has. They
     * contribute to nothing, and refusing the whole configuration over one would strand a
     * customer with an error they cannot clear.
     */
    const item = product('awn-4t');
    const issues = validate(item, { a_group_that_never_existed: 'X' }, { width: cm(320), height: cm(160) });

    expect(issues.filter((issue) => issue.ruleId.startsWith('selection:'))).toStrictEqual([]);
  });

  /**
   * The property, over the whole catalogue: every segment of every SKU names a value the
   * catalogue offers, for every product, at its defaults and with every code shouted.
   */
  test('every SKU segment names a real option, for every product in the catalogue', () => {
    for (const item of [product('awn-4t'), product('lvr-adj-3'), product('sld-2p')]) {
      const shouted = Object.fromEntries(
        skuGroups(item).map((group) => [group.code, group.defaultValue.toLowerCase()]),
      );

      const codes = new Set(
        resolveSelections(item, shouted).map((resolved) => resolved.value.code.toUpperCase()),
      );
      const segments = buildSkuCode(item, shouted).split('-').slice(1);

      for (const segment of segments) {
        expect(codes.has(segment), `${item.id}: ${segment} names no option`).toBe(true);
      }
    }
  });
});
