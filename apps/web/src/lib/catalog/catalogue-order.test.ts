import { describe, expect, it } from 'vitest';

import { catalogueOrder } from './published-product';

/**
 * ⛔ Reported as "the product I added is not on /th/products". It was — at position 83 of 83.
 *
 * The merge appended database products to the seeded eighty-one, so everything the owner
 * created landed on the last card of a long page. This test is the reason that cannot come
 * back by someone "tidying" the concatenation.
 */
describe('the order the catalogue is shown in', () => {
  it('⭐ puts products added through the dashboard before the seeded ones', () => {
    expect(catalogueOrder(['seed-1', 'seed-2'], ['added'])).toStrictEqual([
      'added',
      'seed-1',
      'seed-2',
    ]);
  });

  it('⚠️ keeps the seeded order exactly — it is arranged by hand', () => {
    const seeded = ['a', 'b', 'c', 'd'];
    expect(catalogueOrder(seeded, [])).toStrictEqual(seeded);
  });

  it('keeps the added ones in the order they arrived', () => {
    expect(catalogueOrder([], ['x', 'y'])).toStrictEqual(['x', 'y']);
  });

  it('does not mutate either list', () => {
    const seeded = ['a'];
    const added = ['b'];
    catalogueOrder(seeded, added);
    expect(seeded).toStrictEqual(['a']);
    expect(added).toStrictEqual(['b']);
  });
});
