import { describe, expect, test } from 'vitest';
import {
  emptyQuote,
  longestLeadTime,
  parseStoredQuote,
  quoteItemCount,
  quoteReducer,
  quoteTotal,
  repriceForQty,
  serialiseQuote,
  type QuoteLine,
  type QuoteState,
} from '../src/quote.js';
import { calcPrice } from '../src/pricing.js';
import { buildSkuCode } from '../src/skuCode.js';
import { configHash } from '../src/hash.js';
import { getProductById } from '../src/data/products.js';
import type { Product } from '../src/types/catalog.js';

const product = (id: string): Product => {
  const found = getProductById(id);
  if (!found) throw new Error(`fixture missing: ${id}`);
  return found;
};

/** Build a line the way the configurator would, but with ids supplied by the test. */
const lineFor = (
  productId: string,
  measures: Record<string, number>,
  overrides: Partial<QuoteLine> = {},
): QuoteLine => {
  const item = product(productId);
  const selections = Object.fromEntries(
    item.groups.filter((group) => group.kind === 'sku').map((group) => [group.code, group.defaultValue]),
  );
  const qty = overrides.qty ?? 1;
  const skuCode = buildSkuCode(item, selections);

  return {
    lineId: 'line-1',
    productId,
    nickname: item.nameTh,
    skuCode,
    selections,
    measures,
    qty,
    priceSnapshot: calcPrice(item, selections, measures, qty),
    configHash: configHash(skuCode, measures),
    addedAt: '2569-01-01T00:00:00.000Z',
    warnings: [],
    ...overrides,
  };
};

const state = (...lines: QuoteLine[]): QuoteState => ({ lines, hydrated: true });

/* ------------------------------------------------------------------ *
 * hydrated flag
 *
 * This lives in reducer state rather than in a ref because the persistence effect
 * has to read it from the same object it is about to write. With a ref, the two
 * mount effects run in one commit: the hydrate effect sets the flag and dispatches,
 * then the persist effect runs with the *stale* empty state, sees the flag already
 * set, and overwrites storage with an empty quote.
 * ------------------------------------------------------------------ */

describe('quoteReducer — hydration flag', () => {
  test('a fresh quote is not hydrated, so nothing may be written over storage yet', () => {
    expect(emptyQuote().hydrated).toBe(false);
  });

  test('hydrate marks the quote loaded in the same state object as the lines', () => {
    const a = lineFor('awn-4t', { width: 320, height: 160 }, { lineId: 'a' });
    const next = quoteReducer(emptyQuote(), { type: 'hydrate', lines: [a] });

    expect(next.hydrated).toBe(true);
    expect(next.lines).toEqual([a]);
  });

  test('every other action preserves the flag rather than resetting it', () => {
    const a = lineFor('awn-4t', { width: 320, height: 160 }, { lineId: 'a' });
    const loaded = quoteReducer(emptyQuote(), { type: 'hydrate', lines: [a] });

    expect(quoteReducer(loaded, { type: 'setQty', lineId: 'a', qty: 2 }).hydrated).toBe(true);
    expect(quoteReducer(loaded, { type: 'remove', lineId: 'a' }).hydrated).toBe(true);
    expect(quoteReducer(loaded, { type: 'clear' }).hydrated).toBe(true);
  });

  test('an action on a quote that has not loaded yet does not fake hydration', () => {
    const a = lineFor('awn-4t', { width: 320, height: 160 }, { lineId: 'a' });

    expect(quoteReducer(emptyQuote(), { type: 'add', line: a }).hydrated).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * add
 * ------------------------------------------------------------------ */

describe('quoteReducer — add', () => {
  test('appends a line to an empty quote', () => {
    const line = lineFor('awn-4t', { width: 320, height: 160 });
    const next = quoteReducer(emptyQuote(), { type: 'add', line });

    expect(next.lines).toEqual([line]);
  });

  test('keeps a second, differently sized line separate', () => {
    const a = lineFor('awn-4t', { width: 320, height: 160 }, { lineId: 'a' });
    const b = lineFor('awn-4t', { width: 200, height: 160 }, { lineId: 'b' });

    const next = quoteReducer(state(a), { type: 'add', line: b });

    expect(next.lines.map((line) => line.lineId)).toEqual(['a', 'b']);
  });

  test('merges quantity into the existing line when the configuration is identical', () => {
    // configHash is what makes this "the same window", per spec section 3.
    const a = lineFor('awn-4t', { width: 320, height: 160 }, { lineId: 'a', qty: 2 });
    const b = lineFor('awn-4t', { width: 320, height: 160 }, { lineId: 'b', qty: 3 });

    const next = quoteReducer(state(a), { type: 'add', line: b });

    expect(next.lines).toHaveLength(1);
    expect(next.lines[0]?.lineId).toBe('a');
    expect(next.lines[0]?.qty).toBe(5);
  });

  test('reprices the merged line from its own locked unit price', () => {
    const a = lineFor('awn-4t', { width: 320, height: 160 }, { lineId: 'a', qty: 2 });
    const b = lineFor('awn-4t', { width: 320, height: 160 }, { lineId: 'b', qty: 3 });

    const next = quoteReducer(state(a), { type: 'add', line: b });
    const merged = next.lines[0];

    expect(merged?.priceSnapshot.qty).toBe(5);
    expect(merged?.priceSnapshot.total).toBe(Math.round((a.priceSnapshot.unitPrice ?? 0) * 5));
  });

  test('keeps the existing nickname when merging, rather than silently overwriting it', () => {
    const a = lineFor('awn-4t', { width: 320, height: 160 }, { lineId: 'a', nickname: 'ห้องนอน 1' });
    const b = lineFor('awn-4t', { width: 320, height: 160 }, { lineId: 'b', nickname: 'ห้องนอน 2' });

    const next = quoteReducer(state(a), { type: 'add', line: b });

    expect(next.lines[0]?.nickname).toBe('ห้องนอน 1');
  });

  test('does not merge lines from different products that happen to share measurements', () => {
    const a = lineFor('awn-4t', { width: 320, height: 160 }, { lineId: 'a' });
    const b = lineFor('cas-win-3', { width: 320, height: 160 }, { lineId: 'b' });

    const next = quoteReducer(state(a), { type: 'add', line: b });

    expect(next.lines).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ *
 * duplicate
 * ------------------------------------------------------------------ */

describe('quoteReducer — duplicate', () => {
  test('creates a separate line even though the configuration is identical', () => {
    // The point of the feature (spec section 7) is five same-shaped windows at
    // different sizes: duplicate, then edit. Deduping here would break it.
    const a = lineFor('awn-4t', { width: 320, height: 160 }, { lineId: 'a' });

    const next = quoteReducer(state(a), {
      type: 'duplicate',
      lineId: 'a',
      newLineId: 'a-copy',
      addedAt: '2569-01-02T00:00:00.000Z',
    });

    expect(next.lines).toHaveLength(2);
    expect(next.lines[1]?.lineId).toBe('a-copy');
    expect(next.lines[1]?.configHash).toBe(a.configHash);
  });

  test('inserts the copy directly after the original', () => {
    const a = lineFor('awn-4t', { width: 320, height: 160 }, { lineId: 'a' });
    const b = lineFor('awn-4t', { width: 200, height: 160 }, { lineId: 'b' });

    const next = quoteReducer(state(a, b), {
      type: 'duplicate',
      lineId: 'a',
      newLineId: 'a-copy',
      addedAt: '2569-01-02T00:00:00.000Z',
    });

    expect(next.lines.map((line) => line.lineId)).toEqual(['a', 'a-copy', 'b']);
  });

  test('stamps the copy with its own timestamp', () => {
    const a = lineFor('awn-4t', { width: 320, height: 160 }, { lineId: 'a' });

    const next = quoteReducer(state(a), {
      type: 'duplicate',
      lineId: 'a',
      newLineId: 'a-copy',
      addedAt: '2569-01-02T00:00:00.000Z',
    });

    expect(next.lines[1]?.addedAt).toBe('2569-01-02T00:00:00.000Z');
  });

  test('is a no-op for an unknown lineId', () => {
    const a = lineFor('awn-4t', { width: 320, height: 160 }, { lineId: 'a' });
    const before = state(a);

    const next = quoteReducer(before, {
      type: 'duplicate',
      lineId: 'nope',
      newLineId: 'x',
      addedAt: '2569-01-02T00:00:00.000Z',
    });

    expect(next.lines).toEqual(before.lines);
  });
});

/* ------------------------------------------------------------------ *
 * setQty / remove / update
 * ------------------------------------------------------------------ */

describe('quoteReducer — setQty', () => {
  test('reprices from the locked unit price, not from current product prices', () => {
    // The whole point of priceSnapshot: material prices move, a quote does not.
    const a = lineFor('awn-4t', { width: 320, height: 160 }, { lineId: 'a' });
    const frozen = { ...a, priceSnapshot: { ...a.priceSnapshot, unitPrice: 1000, total: 1000 } };

    const next = quoteReducer(state(frozen), { type: 'setQty', lineId: 'a', qty: 4 });

    expect(next.lines[0]?.priceSnapshot.total).toBe(4000);
  });

  test('clamps to at least one — removing is a separate, explicit action', () => {
    const a = lineFor('awn-4t', { width: 320, height: 160 }, { lineId: 'a' });

    expect(quoteReducer(state(a), { type: 'setQty', lineId: 'a', qty: 0 }).lines[0]?.qty).toBe(1);
    expect(quoteReducer(state(a), { type: 'setQty', lineId: 'a', qty: -5 }).lines[0]?.qty).toBe(1);
  });

  test('clamps to the 99 maximum', () => {
    const a = lineFor('awn-4t', { width: 320, height: 160 }, { lineId: 'a' });

    expect(quoteReducer(state(a), { type: 'setQty', lineId: 'a', qty: 500 }).lines[0]?.qty).toBe(99);
  });

  test('ignores a non-finite quantity instead of writing NaN into the quote', () => {
    const a = lineFor('awn-4t', { width: 320, height: 160 }, { lineId: 'a', qty: 3 });

    const next = quoteReducer(state(a), { type: 'setQty', lineId: 'a', qty: Number.NaN });

    expect(next.lines[0]?.qty).toBe(3);
  });

  test('leaves other lines untouched', () => {
    const a = lineFor('awn-4t', { width: 320, height: 160 }, { lineId: 'a' });
    const b = lineFor('awn-4t', { width: 200, height: 160 }, { lineId: 'b', qty: 7 });

    const next = quoteReducer(state(a, b), { type: 'setQty', lineId: 'a', qty: 2 });

    expect(next.lines[1]?.qty).toBe(7);
  });
});

describe('quoteReducer — remove and update', () => {
  test('removes by lineId', () => {
    const a = lineFor('awn-4t', { width: 320, height: 160 }, { lineId: 'a' });
    const b = lineFor('awn-4t', { width: 200, height: 160 }, { lineId: 'b' });

    const next = quoteReducer(state(a, b), { type: 'remove', lineId: 'a' });

    expect(next.lines.map((line) => line.lineId)).toEqual(['b']);
  });

  test('replaces a line in place, keeping its position', () => {
    const a = lineFor('awn-4t', { width: 320, height: 160 }, { lineId: 'a' });
    const b = lineFor('awn-4t', { width: 200, height: 160 }, { lineId: 'b' });
    const edited = lineFor('awn-4t', { width: 250, height: 160 }, { lineId: 'a', nickname: 'แก้แล้ว' });

    const next = quoteReducer(state(a, b), { type: 'update', lineId: 'a', line: edited });

    expect(next.lines.map((line) => line.lineId)).toEqual(['a', 'b']);
    expect(next.lines[0]?.nickname).toBe('แก้แล้ว');
    expect(next.lines[0]?.measures['width']).toBe(250);
  });

  test('clear empties the quote', () => {
    const a = lineFor('awn-4t', { width: 320, height: 160 }, { lineId: 'a' });

    expect(quoteReducer(state(a), { type: 'clear' }).lines).toEqual([]);
  });

  test('hydrate replaces the whole quote', () => {
    const a = lineFor('awn-4t', { width: 320, height: 160 }, { lineId: 'a' });

    expect(quoteReducer(emptyQuote(), { type: 'hydrate', lines: [a] }).lines).toEqual([a]);
  });

  test('never mutates the state it is given', () => {
    const a = lineFor('awn-4t', { width: 320, height: 160 }, { lineId: 'a', qty: 1 });
    const before = state(a);
    const snapshot = structuredClone(before);

    quoteReducer(before, { type: 'setQty', lineId: 'a', qty: 9 });
    quoteReducer(before, { type: 'remove', lineId: 'a' });

    expect(before).toEqual(snapshot);
  });
});

/* ------------------------------------------------------------------ *
 * repriceForQty
 * ------------------------------------------------------------------ */

describe('repriceForQty', () => {
  test('multiplies the locked unit price and rounds once', () => {
    const base = calcPrice(product('sld-2p'), {}, { width: 180, height: 220 }, 1);

    // unitPrice 8791.2 — rounding per unit first would give 26373, not 26374.
    expect(repriceForQty(base, 3).total).toBe(26374);
  });

  test('leaves the per-unit figures untouched', () => {
    const base = calcPrice(product('awn-4t'), {}, { width: 320, height: 160 }, 1);
    const next = repriceForQty(base, 4);

    expect(next.unitPrice).toBe(base.unitPrice);
    expect(next.base).toBe(base.base);
    expect(next.lines).toEqual(base.lines);
  });
});

/* ------------------------------------------------------------------ *
 * Selectors
 * ------------------------------------------------------------------ */

describe('quote selectors', () => {
  const a = lineFor('awn-4t', { width: 320, height: 160 }, { lineId: 'a', qty: 2 });
  const b = lineFor('sld-2p', { width: 180, height: 220 }, { lineId: 'b', qty: 1 });

  test('quoteTotal sums the locked line totals', () => {
    expect(quoteTotal([a, b])).toBe(a.priceSnapshot.total + b.priceSnapshot.total);
  });

  test('quoteTotal is zero for an empty quote, never NaN', () => {
    expect(quoteTotal([])).toBe(0);
  });

  test('quoteItemCount counts pieces, not rows', () => {
    expect(quoteItemCount([a, b])).toBe(3);
  });

  test('longestLeadTime reports the slowest line, since the job ships together', () => {
    // awn-4t is [10,14]; sld-2p is [14,20].
    expect(longestLeadTime([a, b], getProductById)).toEqual([14, 20]);
  });

  test('longestLeadTime is null for an empty quote', () => {
    expect(longestLeadTime([], getProductById)).toBeNull();
  });

  test('longestLeadTime ignores a line whose product no longer exists', () => {
    const orphan = { ...a, productId: 'deleted-product' };

    expect(longestLeadTime([orphan, b], getProductById)).toEqual([14, 20]);
  });
});

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */

describe('quote persistence', () => {
  test('round-trips through storage', () => {
    const a = lineFor('awn-4t', { width: 320, height: 160 }, { lineId: 'a', qty: 2 });

    expect(parseStoredQuote(serialiseQuote(state(a)))).toEqual([a]);
  });

  test('returns an empty quote for missing storage', () => {
    expect(parseStoredQuote(null)).toEqual([]);
  });

  test('discards corrupt JSON rather than crashing the app on boot', () => {
    expect(parseStoredQuote('{not json')).toEqual([]);
  });

  test('discards a payload of the wrong shape', () => {
    expect(parseStoredQuote('{"lines":"nope"}')).toEqual([]);
    expect(parseStoredQuote('[1,2,3]')).toEqual([]);
  });

  test('drops individual lines that are missing required fields, keeping the good ones', () => {
    // A half-written line from an older build should cost that line, not the quote.
    const a = lineFor('awn-4t', { width: 320, height: 160 }, { lineId: 'a' });
    const payload = JSON.stringify({ lines: [a, { lineId: 'broken' }] });

    expect(parseStoredQuote(payload)).toEqual([a]);
  });
});
