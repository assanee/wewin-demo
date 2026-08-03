import { describe, expect, test } from 'vitest';
import {
  buildShareParams,
  readSharedConfig,
  SHARE_RESERVED_KEYS,
  SHARE_SCHEMA_VERSION,
} from '../src/shareLink.js';
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

/** awn-4t builds 60–400 cm wide by 60–250 cm tall, i.e. these bounds in micrometres. */
const AWN_WIDTH_MIN_UM = 600_000n;
const AWN_HEIGHT_MIN_UM = 600_000n;

const params = (search: string) => new URLSearchParams(search);

/** Every readable link carries the version; spelling it out here keeps the cases short. */
const v = (search: string) => params(`?v=${SHARE_SCHEMA_VERSION}${search}`);

/**
 * A shared link has to survive being pasted into a chat and back out again, and it
 * arrives as untrusted input — anything unreadable is dropped rather than trusted.
 *
 * Since micrometres, the numbers in a link are raw canonical integers and the link
 * converts nothing in either direction. That moves the whole burden onto the version
 * tag: `?width=250` means 250 cm in a v2 link and 250 µm in a v3 one, so a link that
 * does not say which it is cannot be read at all.
 */

describe('buildShareParams', () => {
  test('writes every sku selection and measurement under its own group code', () => {
    const search = buildShareParams(
      product('awn-4t'),
      AWN,
      { width: 2_500_000n, height: 1_800_000n },
      {},
      2,
    );

    expect(search.get('profile_color')).toBe('BK');
    expect(search.get('glass_color')).toBe('GRN');
    expect(search.get('width')).toBe('2500000');
    expect(search.get('height')).toBe('1800000');
    expect(search.get('qty')).toBe('2');
  });

  test('stamps the schema version on every link', () => {
    // The recipient has no other way to tell canonical micrometres from the
    // centimetres a link built before the flip carries under the same key.
    const search = buildShareParams(product('awn-4t'), AWN, { width: 2_500_000n }, {}, 1);

    expect(search.get('v')).toBe(SHARE_SCHEMA_VERSION);
  });

  test('omits a quantity of one, so the common link stays short', () => {
    const search = buildShareParams(
      product('awn-4t'),
      AWN,
      { width: 2_500_000n, height: 1_800_000n },
      {},
      1,
    );

    expect(search.has('qty')).toBe(false);
  });

  test('writes the measurement whole, at the resolution it was entered', () => {
    // Was: "writes measurements through the formatter, not raw floats", guarding
    // 160.5 against arriving as 160.50000000000003. Nothing formats here any more —
    // and the formatter it used to guard through was itself the lossy part: it capped
    // at one decimal and turned 250.34 cm into "250.3", before imperial entry existed
    // to complicate anything.
    const search = buildShareParams(
      product('awn-4t'),
      AWN,
      { width: 2_503_400n, height: 1_605_000n },
      {},
      1,
    );

    expect(search.get('width')).toBe('2503400');
    expect(search.get('height')).toBe('1605000');
  });

  test('records the unit a measurement was typed in, per group', () => {
    // Per group and not once per link: a customer may well have the sill width off a
    // tape in inches and the head height off an architect's drawing in centimetres.
    const search = buildShareParams(
      product('awn-4t'),
      AWN,
      { width: 2_501_900n, height: 1_800_000n },
      { width: 'in' },
      1,
    );

    expect(search.get('width_u')).toBe('in');
    expect(search.has('height_u')).toBe(false);
  });

  test('ignores groups the product does not have', () => {
    const search = buildShareParams(
      product('awn-4t'),
      { ...AWN, lock_type: 'LK2' },
      { width: 2_500_000n, height: 1_800_000n },
      {},
      1,
    );

    expect(search.has('lock_type')).toBe(false);
  });
});

describe('readSharedConfig', () => {
  test('round-trips a configuration', () => {
    const search = buildShareParams(
      product('awn-4t'),
      AWN,
      { width: 2_500_000n, height: 1_800_000n },
      { width: 'in', height: 'cm' },
      3,
    );
    const read = readSharedConfig(product('awn-4t'), search);

    expect(read).toEqual({
      selections: AWN,
      measures: { width: 2_500_000n, height: 1_800_000n },
      enteredUnits: { width: 'in', height: 'cm' },
      qty: 3,
    });
  });

  test('carries a value off the catalogue grid through untouched', () => {
    // Opening a link must not snap. The sender is looking at 250.19 cm; if the
    // recipient's copy silently became 250.5 the two would quote different windows
    // from what they both believe is the same link.
    const search = buildShareParams(product('awn-4t'), AWN, { width: 2_501_900n }, {}, 1);
    const read = readSharedConfig(product('awn-4t'), search);

    expect(read?.measures).toEqual({ width: 2_501_900n });
  });

  test('refuses a link that does not say what its numbers mean', () => {
    // The whole link, not the unreadable key: `?width=250` is a perfectly plausible
    // 250 µm and a perfectly plausible 250 cm, and the only honest answer to a link
    // that does not say which is to fail loudly enough that someone asks the sender.
    expect(readSharedConfig(product('awn-4t'), params('?width=250&qty=2'))).toBeNull();
    expect(readSharedConfig(product('awn-4t'), params('?v=2&width=250'))).toBeNull();
    expect(readSharedConfig(product('awn-4t'), params('?v=4&width=2500000'))).toBeNull();
    expect(readSharedConfig(product('awn-4t'), params('?v=3.0&width=2500000'))).toBeNull();
  });

  test('returns null when the link carries no configuration at all', () => {
    expect(readSharedConfig(product('awn-4t'), params(''))).toBeNull();
    expect(readSharedConfig(product('awn-4t'), v(''))).toBeNull();
    expect(readSharedConfig(product('awn-4t'), v('&category=doors'))).toBeNull();
  });

  test('accepts a partial link and leaves the rest to the product defaults', () => {
    const read = readSharedConfig(product('awn-4t'), v('&width=2000000'));

    expect(read?.measures).toEqual({ width: 2_000_000n });
    expect(read?.selections).toEqual({});
    expect(read?.enteredUnits).toEqual({});
  });

  test('drops a selection whose value the product does not offer', () => {
    // A link built against an older catalog must not select a colour that is gone.
    const read = readSharedConfig(product('awn-4t'), v('&profile_color=NOPE&glass_color=GRN'));

    expect(read?.selections).toEqual({ glass_color: 'GRN' });
  });

  test('refuses the whole link over one unreadable measurement', () => {
    // Was: "drops a measurement that is not a finite number", keeping the rest. A
    // dropped width is not a missing width — the configurator opens on the product
    // default, which is a real, sane, ordinary window, and nothing on screen says it
    // is not the one that was shared.
    expect(readSharedConfig(product('awn-4t'), v('&width=abc&height=1800000'))).toBeNull();
    expect(readSharedConfig(product('awn-4t'), v('&width=&height=1800000'))).toBeNull();
    expect(readSharedConfig(product('awn-4t'), v('&width=-2500000'))).toBeNull();
    expect(readSharedConfig(product('awn-4t'), v('&width=%2B2500000'))).toBeNull();
    expect(readSharedConfig(product('awn-4t'), v('&width=%202500000%20'))).toBeNull();
  });

  test('refuses a measurement that is not a whole micrometre', () => {
    // A canonical length is an integer count. A fraction of a micrometre in a link is
    // either a pre-micrometre centimetre figure or a hand edit, and `BigInt` would
    // throw on it rather than quietly truncate.
    expect(readSharedConfig(product('awn-4t'), v('&width=2500000.5'))).toBeNull();
    expect(readSharedConfig(product('awn-4t'), v('&width=2.5e6'))).toBeNull();
  });

  test('refuses a measurement outside the range the product can build', () => {
    // Was: "clamps a measurement into the range the product can actually build",
    // asserting that ?width=9000 came back as 400 cm. Clamping is exactly how a
    // wrong-unit number turns into a right-looking one: a pre-micrometre `?width=250`
    // is 250 µm here, which clamps up to the 60 cm minimum and opens a configurator
    // showing an unremarkable window nobody ever configured. Out of range is now a
    // refusal, and the version gate above catches that particular link first.
    expect(readSharedConfig(product('awn-4t'), v('&width=90000000&height=1'))).toBeNull();
    expect(readSharedConfig(product('awn-4t'), v('&width=250'))).toBeNull();
    expect(readSharedConfig(product('awn-4t'), v(`&width=${AWN_WIDTH_MIN_UM - 1n}`))).toBeNull();
    expect(readSharedConfig(product('awn-4t'), v('&width=4000001'))).toBeNull();

    // The bounds themselves are buildable.
    expect(readSharedConfig(product('awn-4t'), v(`&width=${AWN_WIDTH_MIN_UM}`))?.measures).toEqual({
      width: AWN_WIDTH_MIN_UM,
    });
    expect(readSharedConfig(product('awn-4t'), v('&width=4000000'))?.measures).toEqual({
      width: 4_000_000n,
    });
  });

  test('refuses a link whose entered unit it does not recognise', () => {
    // The unit decides which grid the next edit snaps to, so an unreadable one is not
    // a cosmetic loss. `inch` is the plausible near-miss — the units are named `in`
    // and `ft`, and a hand-written link is the place that difference shows up.
    expect(readSharedConfig(product('awn-4t'), v('&width=2500000&width_u=inch'))).toBeNull();
    expect(readSharedConfig(product('awn-4t'), v('&width=2500000&width_u='))).toBeNull();
    expect(readSharedConfig(product('awn-4t'), v('&width=2500000&width_u=IN'))).toBeNull();

    const read = readSharedConfig(product('awn-4t'), v('&width=2500000&width_u=ft'));
    expect(read?.enteredUnits).toEqual({ width: 'ft' });
  });

  test('clamps quantity and ignores a non-numeric one', () => {
    // Quantity keeps its clamp where the measurements lost theirs: a count carries no
    // unit, so there is no wrong reading of it to launder — 500 of something means
    // 500 of it whatever version wrote the link, and 99 is a policy ceiling.
    expect(readSharedConfig(product('awn-4t'), v('&width=2000000&qty=500'))?.qty).toBe(99);
    expect(readSharedConfig(product('awn-4t'), v('&width=2000000&qty=0'))?.qty).toBe(1);
    expect(readSharedConfig(product('awn-4t'), v('&width=2000000&qty=x'))?.qty).toBe(1);
  });

  test('ignores the reserved keys the app uses for its own routing', () => {
    // `line` drives edit mode and `category` drives the catalog filter; neither is
    // a group code, and treating them as one would be a silent collision.
    const read = readSharedConfig(product('awn-4t'), v('&line=abc&category=doors&width=2000000'));

    expect(read?.selections).toEqual({});
    expect(read?.measures).toEqual({ width: 2_000_000n });
  });

  test('no product uses a group code that collides with a reserved key', () => {
    // The encoding puts group codes straight into the query string, so a product
    // named its group `qty` would quietly shadow the quantity — or `v`, which would
    // shadow the one key that decides whether the link is readable at all.
    expect(SHARE_RESERVED_KEYS).toContain('v');

    for (const id of ['awn-4t', 'lvr-adj-3', 'sld-2p', 'screen-fiber-single']) {
      for (const group of product(id).groups) {
        expect(SHARE_RESERVED_KEYS).not.toContain(group.code);
      }
    }
  });

  test('no group code collides with the entered-unit key of another group', () => {
    // The unit companion key is the group code plus `_u` (the suffix is private to
    // shareLink, hence the literal). A group actually named `width_u` would be read
    // as a measurement and written over as a unit in the same link.
    for (const id of ['awn-4t', 'lvr-adj-3', 'sld-2p', 'screen-fiber-single']) {
      const codes = product(id).groups.map((group) => group.code);
      for (const code of codes) {
        expect(codes).not.toContain(`${code}_u`);
      }
    }
  });

  test('reads back a height-only link, so `found` does not depend on width', () => {
    // The custom-group loop sets `found` after the sku loop already may have; a link
    // carrying nothing but one measurement is the case that proves neither loop is
    // load-bearing for the other.
    const read = readSharedConfig(product('awn-4t'), v(`&height=${AWN_HEIGHT_MIN_UM}`));

    expect(read?.measures).toEqual({ height: AWN_HEIGHT_MIN_UM });
    expect(read?.qty).toBe(1);
  });
});
