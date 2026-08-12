import { describe, expect, it, vi } from 'vitest';
import { CATALOG_STALE } from '@wewin/contract/errors';
import { encodeMinor } from '@wewin/contract/money';

import { ApiError } from '@/lib/api/errors';

import {
  QUOTE_BASELINES_STALE,
  QUOTE_STALE,
  conflictOf,
  preconditionOf,
  reviseQty,
} from './quote-api';
import { decodeQuote } from './quote-wire';
import type { QuoteWire } from './quote-wire';

/**
 * The refusals, and the one that never arrives as a refusal.
 *
 * Plan 7.9(จ) splits the 409 *"because the UI can only recover from one of them"*. This file
 * is the evidence that the split survives — a classifier that collapsed the arms would still
 * typecheck, still compile, and would quietly offer "reload and carry on" for a catalogue
 * publish that needs eleven prices re-agreed.
 */

const conflict = (details: unknown): ApiError =>
  new ApiError({ status: 409, code: 'CONFLICT', message: 'ขัดแย้ง', details });

describe('classifying a 409', () => {
  it('tells a colleague’s edit from a catalogue publish under a promise', () => {
    expect(conflictOf(conflict({ reason: QUOTE_STALE, sent: 'a', current: 'b' }))).toBe('quote_stale');
    expect(conflictOf(conflict({ reason: QUOTE_BASELINES_STALE, lines: [] }))).toBe('baselines_stale');
  });

  it('reads the nested catalogue body apps/api actually sends', () => {
    /*
     * `catalogStale()` wraps `catalogStaleBody(...)` under a `stale` key, and that body's own
     * `error` field is the reason string. A client that read only a flat `reason` would
     * classify a catalogue publish as `other` and offer the wrong recovery.
     */
    expect(conflictOf(conflict({ stale: { error: 'catalog_stale' } }))).toBe('catalogue_stale');
    /* And the flat spelling too, because `@wewin/contract/errors` documents that shape. */
    expect(conflictOf(conflict({ error: 'catalog_stale' }))).toBe('catalogue_stale');
  });

  it('uses the contract’s own constant, so a rename there fails here', () => {
    /*
     * The reason string is not spelled out a second time. `catalogStaleBody` builds the whole
     * envelope and needs a compiled product document to do it, which is more fixture than this
     * assertion is worth — but the *field* and the *value* both come from the contract, so a
     * rename in `@wewin/contract/errors` turns this red rather than turning the banner into a
     * shrug at runtime.
     */
    expect(conflictOf(conflict({ stale: { error: CATALOG_STALE } }))).toBe('catalogue_stale');
    expect(conflictOf(conflict({ stale: { error: `${CATALOG_STALE}_x` } }))).toBe('other');
  });

  it('falls back to `other` rather than guessing, including for a 409 with no body', () => {
    expect(conflictOf(conflict(undefined))).toBe('other');
    expect(conflictOf(conflict({ reason: 42 }))).toBe('other');
    expect(conflictOf(conflict({ somethingElse: true }))).toBe('other');
  });

  it('is null for everything that is not a conflict, so no other failure gets a reload prompt', () => {
    expect(conflictOf(new ApiError({ status: 403, code: 'FORBIDDEN', message: 'no' }))).toBeNull();
    /*
     * The integrity case is a 500, deliberately: `core` changed under a pinned document and no
     * retry helps. A classifier that turned it into a conflict would offer the one recovery
     * that cannot work.
     */
    expect(conflictOf(new ApiError({ status: 500, code: 'INTERNAL', message: 'boom' }))).toBeNull();
    expect(conflictOf(new Error('network'))).toBeNull();
    expect(conflictOf(null)).toBeNull();
  });
});

describe('the precondition', () => {
  it('carries one opaque handle and no money at all — plan 7.9(จ)', () => {
    const wire: QuoteWire = decodeQuote(SAMPLE);

    expect(preconditionOf(wire)).toEqual({ quoteRevision: '0123456789abcdef' });
    /*
     * The assertion that matters is the *absence*: one key, and it is not an amount. A second
     * key carrying a total is how the abandoned "recompute and 409 on mismatch" mitigation
     * would reappear after it was deliberately given up.
     */
    expect(Object.keys(preconditionOf(wire))).toHaveLength(1);
  });
});

describe('decoding', () => {
  it('accepts a well-formed quote through the contract’s own schema', () => {
    const wire = decodeQuote(SAMPLE);
    expect(wire.lines).toHaveLength(1);
    expect(wire.money.grandTotalThbMinor).toEqual(encodeMinor(940_637n, 'THB'));
    expect(wire.sales?.staleBaselines).toEqual([]);
  });

  it('refuses an amount with no unit rather than reading the digits', () => {
    const broken = { ...SAMPLE, money: { ...SAMPLE.money, grandTotalThbMinor: '940637' } };
    expect(() => decodeQuote(broken)).toThrow();
  });

  it('refuses a measure whose unit is centimetres — plan 4.1’s failure mode', () => {
    const broken = {
      ...SAMPLE,
      lines: [{ ...SAMPLE.lines[0], measures: { width: { unit: 'cm', digits: '320' } } }],
    };
    expect(() => decodeQuote(broken)).toThrow();
  });

  it('refuses a vocabulary value it does not know', () => {
    expect(() => decodeQuote({ ...SAMPLE, lines: [{ ...SAMPLE.lines[0], kind: 'bundle' }] })).toThrow();
  });

  it('refuses a collection that is not a list rather than reading it as empty', () => {
    /*
     * The dangerous shape: a quote whose `overrides` failed to serialise would render as a
     * quote with no human-set prices on it — every figure looking like the machine's, which is
     * the exact opposite of what this screen exists to show.
     */
    expect(() =>
      decodeQuote({ ...SAMPLE, sales: { ...SAMPLE.sales, overrides: null } }),
    ).toThrow();
  });

  it('accepts a customer’s copy, which has no sales block at all', () => {
    const wire = decodeQuote({ ...SAMPLE, sales: null });
    expect(wire.sales).toBeNull();
  });
});

/** A minimal quote as apps/api sends it, written the long way so the shape stays readable. */
const SAMPLE = {
  orderId: '00000000-0000-4000-8000-000000000001',
  quoteRevision: '0123456789abcdef',
  currency: 'THB',
  /* Required by `quoteWireSchema`, so `decodeQuote` refuses a payload without it — which is the
   * point: `money.vat` names a rate but cannot say whether it is this country's. */
  destination: { country: 'TH', recognised: true, basis: 'exclusive' },
  lines: [
    {
      id: '00000000-0000-4000-8000-0000000000b1',
      seq: 1,
      kind: 'catalog',
      productVersionId: '00000000-0000-4000-8000-0000000000c1',
      /* The other half of the `CatalogRef` a revision request needs. Absent for one round, which
       * is why qty and options were read-only on the editor. */
      documentHash: 'b'.repeat(64),
      productId: '00000000-0000-4000-8000-0000000000d1',
      skuCode: 'SL2-T6-WH',
      selections: { glass: 'T6' },
      measures: { width: { unit: 'um', digits: '3200000' } },
      qty: 1,
      customerDescriptionTh: null,
      isVatApplicable: true,
      computedTotalThbMinor: { unit: 'THB.satang', digits: '879100' },
      chargeTotalThbMinor: null,
      effectiveTotalThbMinor: { unit: 'THB.satang', digits: '879100' },
    },
  ],
  money: {
    netThbMinor: { unit: 'THB.satang', digits: '879100' },
    taxableNetThbMinor: { unit: 'THB.satang', digits: '879100' },
    exemptNetThbMinor: { unit: 'THB.satang', digits: '0' },
    vatThbMinor: { unit: 'THB.satang', digits: '61537' },
    grandTotalThbMinor: { unit: 'THB.satang', digits: '940637' },
    vat: { rateBp: 700, treatment: 'standard' },
  },
  computedLeadTimeDays: 30,
  effectiveLeadTimeDays: 30,
  sales: {
    overrides: [],
    marginConcessionThbMinor: { unit: 'THB.satang', digits: '0' },
    baselineGrandTotalThbMinor: { unit: 'THB.satang', digits: '940637' },
    staleBaselines: [],
    /* A domestic sample, so there is no destination currency and therefore no indicative
     * conversion — `null` rather than an `available: false` payload naming a currency there is
     * not one of. Required by `quoteFxPreviewWireSchema`, which is the point of decoding this
     * fixture rather than casting it: a field the API started sending has to appear here too. */
    fxPreview: null,
  },
} as const;

/* ------------------------------------------------------------------ *
 * The revision request — the one write that changes a price with no figure in it
 * ------------------------------------------------------------------ */

/**
 * Qty was read-only on the editor for a whole round because a quote line carried neither the
 * `documentHash` it was pinned against nor its `productId`, and `POST lines/:id/revision` takes
 * a whole `PriceRequestWire` which needs both. Both are on the line now, so these assertions
 * are about the two ways the request can still be wrong:
 *
 *   ① it invents a handle it was not given — the staleness a `CatalogRef` exists to catch,
 *      arriving as a plausible-looking hash instead of a 409;
 *   ② it carries a number. A revision is the `computed` layer: the count goes up, the server
 *      re-runs `calcPrice`, and any money in this body would be a client pricing a line.
 */
describe('revising a line’s quantity', () => {
  /*
   * Decoded rather than written out: `measures` is a branded `Exact<'um'>`, so a literal that
   * looked right would not be one, and the whole point of the request is that every field in it
   * came from the server rather than from this file.
   */
  const line = decodeQuote(SAMPLE).lines[0];
  if (line === undefined) throw new Error('the sample quote has no lines');

  const captureBody = async (
    run: () => Promise<unknown> | null,
  ): Promise<{ readonly url: string; readonly body: Record<string, unknown> }> => {
    let seen: { url: string; body: Record<string, unknown> } | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        seen = {
          url: typeof input === 'string' ? input : input.toString(),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        };
        return new Response(JSON.stringify(SAMPLE), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );

    const request = run();
    expect(request).not.toBeNull();
    await request;
    vi.unstubAllGlobals();

    if (seen === null) throw new Error('no request was made');
    return seen;
  };

  it('sends the line’s own catalogue handle back, and never a hash from anywhere else', async () => {
    const { url, body } = await captureBody(() =>
      reviseQty('order-1', line, 3, { quoteRevision: '0123456789abcdef' }),
    );

    expect(url).toContain(`/orders/order-1/quote/lines/${line.id}/revision`);
    expect(body['line']).toMatchObject({
      productVersionId: line.productVersionId,
      documentHash: line.documentHash,
      productId: line.productId,
      qty: 3,
      selections: line.selections,
    });
    expect(body['expect']).toEqual({ quoteRevision: '0123456789abcdef' });
  });

  it('carries no money at all — a quantity, and the machine prices it', async () => {
    const { body } = await captureBody(() =>
      reviseQty('order-1', line, 2, { quoteRevision: '0123456789abcdef' }),
    );

    /*
     * The assertion is over the serialised text, not over the keys: a total nested three
     * levels down inside `line` would pass a key check on the top level and is exactly the
     * shape that would reintroduce the mitigation plan 7.9 gave up.
     */
    expect(JSON.stringify(body)).not.toMatch(/ThbMinor|satang|amount|total/i);
    expect(Object.keys(body).sort()).toEqual(['expect', 'line']);
  });

  it('states the unit it is showing rather than claiming to know what was typed', async () => {
    const { body } = await captureBody(() =>
      reviseQty('order-1', line, 2, { quoteRevision: '0123456789abcdef' }),
    );

    /*
     * `enteredUnits` is the grid a *step* warning is judged on (plan 4.1) and nobody recorded
     * what the customer originally typed. `measureText` renders centimetres, so centimetres is
     * what this screen can honestly say — and it says it for every measured group, because a
     * missing key is a group the server would judge on a grid nobody chose.
     */
    const request = body['line'] as Record<string, unknown>;
    expect(request['enteredUnits']).toEqual({ width: 'cm' });
  });

  it('returns null rather than a half-formed body when there is no handle to send', () => {
    const expect_ = { quoteRevision: '0123456789abcdef' };

    /* A free-form line: nothing to recompute, and every catalogue field null. */
    expect(reviseQty('order-1', { ...line, productId: null, documentHash: null, productVersionId: null, selections: null, measures: null }, 2, expect_)).toBeNull();

    /*
     * ⭐ And the case that matters: a line whose pinned version is no longer published. The
     * server nulls `documentHash` and `productId` together for precisely this state, and the
     * recovery is the per-line one `staleBaselines` names — not a guess at a hash.
     */
    expect(reviseQty('order-1', { ...line, documentHash: null, productId: null }, 2, expect_)).toBeNull();
    expect(reviseQty('order-1', { ...line, documentHash: null }, 2, expect_)).toBeNull();
    expect(reviseQty('order-1', { ...line, productId: null }, 2, expect_)).toBeNull();
  });
});
