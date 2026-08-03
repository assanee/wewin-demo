import { describe, expect, test } from 'vitest';
import { buildShareParams, readSharedConfig, SHARE_RESERVED_KEYS } from '../src/shareLink.js';
import { getProductById } from '../src/data/products.js';
import type { Product } from '../src/types/catalog.js';

const product = (id: string): Product => {
  const found = getProductById(id);
  if (!found) throw new Error(`fixture missing: ${id}`);
  return found;
};

const AWN = {
  profile_color: 'BK',
  glass_color: 'GRN',
  glass_thickness: 'T5',
  insect_screen: 'NS1',
};

const params = (search: string) => new URLSearchParams(search);

/**
 * A shared link has to survive being pasted into a chat and back out again, and it
 * arrives as untrusted input — anything unreadable is dropped rather than trusted.
 */

describe('buildShareParams', () => {
  test('writes every sku selection and measurement under its own group code', () => {
    const search = buildShareParams(product('awn-4t'), AWN, { width: 250, height: 180 }, 2);

    expect(search.get('profile_color')).toBe('BK');
    expect(search.get('glass_color')).toBe('GRN');
    expect(search.get('width')).toBe('250');
    expect(search.get('height')).toBe('180');
    expect(search.get('qty')).toBe('2');
  });

  test('omits a quantity of one, so the common link stays short', () => {
    const search = buildShareParams(product('awn-4t'), AWN, { width: 250, height: 180 }, 1);

    expect(search.has('qty')).toBe(false);
  });

  test('writes measurements through the formatter, not raw floats', () => {
    // 160.5 must not arrive as 160.50000000000003 after a few stepper presses.
    const search = buildShareParams(product('awn-4t'), AWN, { width: 320, height: 160.5 }, 1);

    expect(search.get('height')).toBe('160.5');
  });

  test('ignores groups the product does not have', () => {
    const search = buildShareParams(
      product('awn-4t'),
      { ...AWN, lock_type: 'LK2' },
      { width: 250, height: 180 },
      1,
    );

    expect(search.has('lock_type')).toBe(false);
  });
});

describe('readSharedConfig', () => {
  test('round-trips a configuration', () => {
    const search = buildShareParams(product('awn-4t'), AWN, { width: 250, height: 180 }, 3);
    const read = readSharedConfig(product('awn-4t'), search);

    expect(read).toEqual({
      selections: AWN,
      measures: { width: 250, height: 180 },
      qty: 3,
    });
  });

  test('returns null when the link carries no configuration at all', () => {
    expect(readSharedConfig(product('awn-4t'), params(''))).toBeNull();
    expect(readSharedConfig(product('awn-4t'), params('?category=doors'))).toBeNull();
  });

  test('accepts a partial link and leaves the rest to the product defaults', () => {
    const read = readSharedConfig(product('awn-4t'), params('?width=200'));

    expect(read?.measures).toEqual({ width: 200 });
    expect(read?.selections).toEqual({});
  });

  test('drops a selection whose value the product does not offer', () => {
    // A link built against an older catalog must not select a colour that is gone.
    const read = readSharedConfig(product('awn-4t'), params('?profile_color=NOPE&glass_color=GRN'));

    expect(read?.selections).toEqual({ glass_color: 'GRN' });
  });

  test('drops a measurement that is not a finite number', () => {
    const read = readSharedConfig(product('awn-4t'), params('?width=abc&height=180'));

    expect(read?.measures).toEqual({ height: 180 });
  });

  test('clamps a measurement into the range the product can actually build', () => {
    // Someone editing the URL by hand should not be able to price a 9-metre window.
    const read = readSharedConfig(product('awn-4t'), params('?width=9000&height=1'));

    expect(read?.measures).toEqual({ width: 400, height: 60 });
  });

  test('clamps quantity and ignores a non-numeric one', () => {
    expect(readSharedConfig(product('awn-4t'), params('?width=200&qty=500'))?.qty).toBe(99);
    expect(readSharedConfig(product('awn-4t'), params('?width=200&qty=0'))?.qty).toBe(1);
    expect(readSharedConfig(product('awn-4t'), params('?width=200&qty=x'))?.qty).toBe(1);
  });

  test('ignores the reserved keys the app uses for its own routing', () => {
    // `line` drives edit mode and `category` drives the catalog filter; neither is
    // a group code, and treating them as one would be a silent collision.
    const read = readSharedConfig(product('awn-4t'), params('?line=abc&category=doors&width=200'));

    expect(read?.selections).toEqual({});
    expect(read?.measures).toEqual({ width: 200 });
  });

  test('no product uses a group code that collides with a reserved key', () => {
    // The encoding puts group codes straight into the query string, so a product
    // named its group `qty` would quietly shadow the quantity.
    for (const id of ['awn-4t', 'lvr-adj-3', 'sld-2p', 'screen-fiber-single']) {
      for (const group of product(id).groups) {
        expect(SHARE_RESERVED_KEYS).not.toContain(group.code);
      }
    }
  });
});
