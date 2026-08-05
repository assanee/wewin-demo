import { describe, expect, it } from 'vitest';
import type { Product } from '@wewin/core';
import { products } from '@wewin/core/fixtures';
import { calcPrice } from '@wewin/core/pricing';
import { toBigInt } from '@wewin/contract/exact';

import type { PublishedProduct } from '../../src/catalog/catalog.repository';
import type { QuoteLineRow, QuoteOverrideRow } from '../../src/quotes/quote.repository';
import { verifyBaselines } from '../../src/quotes/verification';

/**
 * Plan 7.9(จ), and the distinction the whole pass exists to draw.
 *
 * > ลดราคา ฿18,432 → ฿17,000 ตอนบ่าย · ทีมอื่น publish ราคาใหม่ ฿20,000 ตอนเย็น · ถ้าไม่
 * > re-verify ระบบยังโชว์ ฿17,000 โดยไม่มีใครรู้ว่าตอนนี้มันคือส่วนลด 15% ไม่ใช่ 7.8%
 *
 * A stored baseline can stop matching for two reasons and they are **not the same kind of
 * event**:
 *
 *   the catalogue moved   → a 409 and a decision per line. Somebody published.
 *   the catalogue did not → an integrity alarm. `calcPrice` returned a different figure from a
 *                           frozen document that did not change, which means the *code* moved
 *                           under every signed contract in the system at once.
 *
 * A test that only checked "detects a mismatch" would pass with the two collapsed, and the
 * collapsed version answers 409 — telling a salesperson to reload their way out of a pricing
 * regression, forever.
 */

/** The first fixture product with a measurement, so `calcPrice` has something to price. */
const product: Product = (() => {
  const found = products.find((candidate: Product) =>
    candidate.groups.some((group) => group.kind === 'custom'),
  );
  if (!found) throw new Error('no fixture product with a measurement');
  return found;
})();

const selections: Record<string, string> = {};
const measures: Record<string, bigint> = {};
for (const group of product.groups) {
  if (group.kind === 'sku') selections[group.code] = group.defaultValue;
  else measures[group.code] = group.defaultUm;
}

const computed = calcPrice(product, selections, measures, 2).totalMinor;

const PINNED = '11111111-1111-4111-8111-111111111111';
const SUCCESSOR = '22222222-2222-4222-8222-222222222222';

const published = (versionId: string): PublishedProduct => ({
  productVersionId: versionId,
  documentHash: 'a'.repeat(64),
  product,
});

const line = (over: Partial<QuoteLineRow> = {}): QuoteLineRow => ({
  id: 'line-1',
  seq: 1,
  kind: 'catalog',
  productVersionId: PINNED,
  skuCode: 'SKU',
  selections,
  measures: Object.fromEntries(Object.entries(measures).map(([code, um]) => [code, um.toString()])),
  configHash: 'b'.repeat(64),
  qty: 2,
  computedTotalThbMinor: computed,
  chargeTotalThbMinor: null,
  isVatApplicable: true,
  customerDescriptionTh: null,
  ...over,
});

const promise = (): QuoteOverrideRow => ({
  id: 'ov-1',
  anchor: 'line_total',
  quoteLineId: 'line-1',
  computedThbMinor: computed,
  overrideThbMinor: computed - 100_000n,
  computedDays: null,
  overrideDays: null,
  enteredAs: 'line_total',
  enteredValueText: '17000',
  reasonCode: 'volume',
  noteTh: null,
  setByUserId: 'user-1',
  setByUserName: 'คุณสมชาย',
  createdAt: new Date(),
});

const verify = (input: {
  lines: readonly QuoteLineRow[];
  overrides?: readonly QuoteOverrideRow[];
  publishedVersionId?: string | null;
  /** The document as it stands with the line promises applied — `applyOverrides`' figure. */
  documentBaselineThbMinor?: bigint;
}) =>
  verifyBaselines({
    orderId: 'order-1',
    lines: input.lines,
    liveOverrides: input.overrides ?? [],
    documentBaselineThbMinor: input.documentBaselineThbMinor ?? 0n,
    publishedByVersionId:
      input.publishedVersionId === null
        ? new Map()
        : new Map([
            [input.publishedVersionId ?? PINNED, published(input.publishedVersionId ?? PINNED)],
          ]),
    productIdByVersionId: new Map([[PINNED, product.id]]),
    publishedByProductId:
      input.publishedVersionId === null
        ? new Map()
        : new Map([[product.id, published(input.publishedVersionId ?? PINNED)]]),
  });

describe('nothing to report', () => {
  it('passes a line pinned to the version that is still published', () => {
    expect(verify({ lines: [line()], overrides: [promise()] })).toHaveLength(0);
  });

  it('ignores a free-form line, which has no catalogue behind it', () => {
    const freeform = line({
      kind: 'freeform',
      productVersionId: null,
      skuCode: null,
      selections: null,
      measures: null,
      configHash: null,
      computedTotalThbMinor: null,
      chargeTotalThbMinor: 200_000n,
    });

    expect(verify({ lines: [freeform] })).toHaveLength(0);
  });
});

describe('the catalogue moved — a 409 and a decision per line', () => {
  it('reports a promised line as a promise whose baseline moved, with all three figures', () => {
    const [stale] = verify({
      lines: [line()],
      overrides: [promise()],
      publishedVersionId: SUCCESSOR,
    });

    expect(stale?.kind).toBe('promise_baseline_moved');
    expect(stale?.overrideId).toBe('ov-1');
    expect(stale?.pinnedProductVersionId).toBe(PINNED);
    expect(stale?.publishedProductVersionId).toBe(SUCCESSOR);
    /* All three: what was promised, what it was promised against, and what it costs now — a
     * person cannot decide with fewer. */
    expect(toBigInt(stale?.promisedThbMinor as never)).toBe(computed - 100_000n);
    expect(toBigInt(stale?.baselineThbMinor as never)).toBe(computed);
    expect(toBigInt(stale?.currentComputedThbMinor as never)).toBe(computed);
  });

  /* A line with no promise needs a re-render, not a renegotiation, and a screen that showed
   * them identically would send a salesperson to renegotiate a price nobody changed. */
  it('reports an unpromised line as one that merely needs repricing', () => {
    const [stale] = verify({ lines: [line()], publishedVersionId: SUCCESSOR });

    expect(stale?.kind).toBe('line_needs_repricing');
    expect(stale?.overrideId).toBeNull();
    expect(stale?.promisedThbMinor).toBeNull();
  });

  it('says so plainly when the product is not published at all any more', () => {
    const [stale] = verify({ lines: [line()], overrides: [promise()], publishedVersionId: null });

    expect(stale?.publishedProductVersionId).toBeNull();
    expect(stale?.currentComputedThbMinor).toBeNull();
  });
});

describe('the catalogue did NOT move — an integrity alarm, not a 409', () => {
  /*
   * ⭐ The pinned version is still the published one, so the document is byte-for-byte the
   * document this line was priced from, and `calcPrice` disagrees with the stored figure. There
   * is no client action that recovers from that and no retry that helps: every frozen
   * `order_documents` row in the system was produced by the same pair, so if the pair stops
   * being reproducible, every contract the company has signed becomes unverifiable at once.
   */
  it('throws rather than reporting when core disagrees with a document that did not change', () => {
    expect(() => verify({ lines: [line({ computedTotalThbMinor: computed + 1n })] })).toThrow(
      /INTEGRITY/,
    );
  });

  /* Checked on every catalog line, not only the promised ones: a pricing regression does not
   * care whether anybody negotiated. */
  it('checks a line that carries no promise at all', () => {
    expect(() =>
      verify({ lines: [line({ computedTotalThbMinor: computed + 1n })], overrides: [] }),
    ).toThrow(/INTEGRITY/);
  });

  it('and the alarm names the order, the line and both figures', () => {
    try {
      verify({ lines: [line({ computedTotalThbMinor: computed + 1n })] });
      expect.unreachable('the alarm did not fire');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('order-1');
      expect(message).toContain('line-1');
      expect(message).toContain(PINNED);
      expect(message).toContain((computed + 1n).toString());
      expect(message).toContain(computed.toString());
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════ *
 * ⭐ THE ANCHOR THIS PASS DID NOT CHECK FOR A WHOLE ROUND
 * ═══════════════════════════════════════════════════════════════════════ */

/**
 * This function iterated **lines**, so a `grand_total` promise — whose stored baseline is by
 * definition a figure about every line at once — was never verified at all. Two red teams walked
 * through the gap from opposite ends and `POST …/quote/verification` answered 200 on both
 * exploited quotes:
 *
 *   add a line under a ฿7,495.84 document promise: billed ฿7,495.84 against a ฿66,562.56
 *   document, 88.7% off, measured by the submit gate as ฿0.00, approvals required: none.
 *
 *   remove the only line under one: an invoice for ฿14,291.68 with nothing on it, carrying
 *   ฿934.97 of VAT on ฿0.00 of goods.
 */
describe('the document promise, re-verified against the document', () => {
  const documentPromise = (computed: bigint): QuoteOverrideRow => ({
    ...promise(),
    id: 'ov-doc',
    anchor: 'grand_total',
    quoteLineId: null,
    computedThbMinor: computed,
    overrideThbMinor: computed - 50_000n,
  });

  it('says nothing while the figure it was promised against still stands', () => {
    expect(
      verify({
        lines: [line()],
        overrides: [documentPromise(940_637n)],
        documentBaselineThbMinor: 940_637n,
      }),
    ).toHaveLength(0);
  });

  it('reports the promise, the baseline it was taken against, and the figure now', () => {
    const [stale, ...rest] = verify({
      lines: [line()],
      overrides: [documentPromise(940_637n)],
      /* Two more lines were added underneath it. */
      documentBaselineThbMinor: 6_656_256n,
    });

    expect(rest).toHaveLength(0);
    expect(stale?.kind).toBe('document_baseline_moved');
    expect(stale?.overrideId).toBe('ov-doc');
    /* It hangs off no line, and the wire says so rather than naming one at random: the recovery
     * is the whole-document one, and a `quoteLineId` would send somebody to the wrong screen. */
    expect(stale?.quoteLineId).toBeNull();
    expect(stale?.seq).toBeNull();
    expect(stale?.pinnedProductVersionId).toBeNull();
    expect(toBigInt(stale?.promisedThbMinor as never)).toBe(890_637n);
    expect(toBigInt(stale?.baselineThbMinor as never)).toBe(940_637n);
    expect(toBigInt(stale?.currentComputedThbMinor as never)).toBe(6_656_256n);
  });

  it('has nothing to say about a quote with no document promise on it', () => {
    expect(verify({ lines: [line()], documentBaselineThbMinor: 6_656_256n })).toHaveLength(0);
  });
});
