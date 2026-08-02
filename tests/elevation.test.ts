import { describe, expect, test } from 'vitest';
import { louvreBladeCount, panelRects, resolvePanelWidths } from '../src/lib/elevation';
import { products } from '../src/data/products';

/**
 * Geometry for the elevation drawings. Pure so the visual can be checked by
 * arithmetic rather than by squinting at an SVG.
 */

describe('resolvePanelWidths', () => {
  test('splits evenly when no explicit widths are given', () => {
    expect(resolvePanelWidths(4, undefined)).toEqual([1, 1, 1, 1]);
  });

  test('keeps explicit relative widths, e.g. the 2:1 pair of a คู่แม่ลูก door', () => {
    expect(resolvePanelWidths(2, [2, 1])).toEqual([2, 1]);
  });

  test('ignores explicit widths that do not match the panel count', () => {
    // A mismatch is a data error; falling back to even keeps the drawing sane
    // while schema.ts is what actually rejects it at boot.
    expect(resolvePanelWidths(3, [2, 1])).toEqual([1, 1, 1]);
  });

  test('never returns an empty layout', () => {
    expect(resolvePanelWidths(0, undefined)).toEqual([1]);
    expect(resolvePanelWidths(-2, undefined)).toEqual([1]);
  });
});

describe('panelRects', () => {
  const frame = { x: 0, y: 0, width: 300, height: 100 };

  test('fills the frame exactly with a single panel', () => {
    const [only] = panelRects(frame, [1], 0);

    expect(only).toEqual({ x: 0, y: 0, width: 300, height: 100 });
  });

  test('divides equal panels edge to edge with no gaps or overlaps', () => {
    const rects = panelRects(frame, [1, 1, 1], 0);

    expect(rects.map((r) => r.width)).toEqual([100, 100, 100]);
    expect(rects.map((r) => r.x)).toEqual([0, 100, 200]);
  });

  test('honours relative widths', () => {
    const rects = panelRects(frame, [2, 1], 0);

    expect(rects.map((r) => r.width)).toEqual([200, 100]);
  });

  test('accounts for the mullion between panels', () => {
    // Two panels with a 10-wide mullion: 300 - 10 = 290 of glass, split evenly.
    const rects = panelRects(frame, [1, 1], 10);

    expect(rects[0]).toEqual({ x: 0, y: 0, width: 145, height: 100 });
    expect(rects[1]).toEqual({ x: 155, y: 0, width: 145, height: 100 });
  });

  test('the last panel still ends on the frame edge', () => {
    const rects = panelRects(frame, [1, 1, 1], 6);
    const last = rects[rects.length - 1];

    expect((last?.x ?? 0) + (last?.width ?? 0)).toBeCloseTo(300, 6);
  });

  test('degrades to a single full-width panel rather than negative widths', () => {
    // A mullion wider than the frame would otherwise produce inverted rects.
    const rects = panelRects(frame, [1, 1], 1000);

    expect(rects).toHaveLength(1);
    expect(rects[0]?.width).toBe(300);
  });
});

describe('louvreBladeCount', () => {
  test('scales with panel height so blades keep a roughly constant pitch', () => {
    expect(louvreBladeCount(100, 10)).toBe(10);
    expect(louvreBladeCount(200, 10)).toBe(20);
  });

  test('never returns fewer than two blades, however short the panel', () => {
    expect(louvreBladeCount(1, 10)).toBe(2);
  });

  test('caps the count so a tall panel does not turn into a solid block', () => {
    expect(louvreBladeCount(100000, 10)).toBeLessThanOrEqual(60);
  });
});

describe('every product carries a drawable elevation', () => {
  test('panels is at least one and operation is set', () => {
    for (const product of products) {
      expect(product.elevation.panels).toBeGreaterThanOrEqual(1);
      expect(product.elevation.operation).toBeTruthy();
      expect(product.elevation.infill).toBeTruthy();
    }
  });

  test('explicit panel widths, where present, match the panel count', () => {
    for (const product of products) {
      const widths = product.elevation.panelWidths;
      if (widths) expect(widths).toHaveLength(product.elevation.panels);
    }
  });

  test('louvre products draw louvre blades, screens draw mesh', () => {
    const louvre = products.find((p) => p.id === 'lvr-adj-3');
    const screen = products.find((p) => p.id === 'screen-fiber-single');

    expect(louvre?.elevation.infill).toBe('louvre');
    expect(screen?.elevation.infill).toBe('mesh');
  });

  test('the panel count matches what the product name says', () => {
    // The drawing is the first thing a customer checks against the name.
    expect(products.find((p) => p.id === 'fold-12')?.elevation.panels).toBe(12);
    expect(products.find((p) => p.id === 'awn-4t')?.elevation.panels).toBe(4);
    expect(products.find((p) => p.id === 'lvr-adj-3')?.elevation.panels).toBe(3);
    expect(products.find((p) => p.id === 'cas-door-single')?.elevation.panels).toBe(1);
  });

  test('a คู่แม่ลูก door is drawn as an unequal pair, not two equal leaves', () => {
    const uneven = products.find((p) => p.id === 'cas-door-uneven');

    expect(uneven?.elevation.panels).toBe(2);
    expect(uneven?.elevation.panelWidths).toEqual([2, 1]);
  });
});
