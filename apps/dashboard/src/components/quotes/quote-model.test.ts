import { describe, expect, it } from 'vitest';
import { encodeMinor } from '@wewin/contract/money';
import type { MoneyWire } from '@wewin/contract';

import { foldQuote, hasHumanFigures, liveOverrideOf } from './quote-model';
import { thbMinorOf } from './quote-wire';
import type { QuoteLineWire, QuoteOverrideWire, QuoteWire, StaleBaselineWire } from './quote-wire';

/**
 * The fold, tested on the thing it exists for: **can a person tell where a figure came from?**
 *
 * Three provenances, three integrity alarms, and one distinction — a promise whose baseline
 * moved versus a calculator that changed — that decides whether a salesperson or an engineer
 * is the right response. Every fixture is a whole `QuoteWire` built through the contract's own
 * money encoder, so a field that changed shape fails here rather than rendering as
 * `[object Object]`.
 */

const thb = (minor: bigint): MoneyWire<'THB'> => encodeMinor(minor, 'THB');

const catalogLine = (
  id: string,
  seq: number,
  computedMinor: bigint,
  effectiveMinor = computedMinor,
  qty = 1,
): QuoteLineWire => ({
  id,
  seq,
  kind: 'catalog',
  productVersionId: 'pv-1',
  documentHash: 'a'.repeat(64),
  productId: '11111111-1111-4111-8111-111111111111',
  skuCode: 'SL2-T6-WH',
  selections: { glass: 'T6' },
  measures: {},
  qty,
  customerDescriptionTh: 'บานเลื่อน 2 ช่อง',
  isVatApplicable: true,
  computedTotalThbMinor: thb(computedMinor),
  chargeTotalThbMinor: null,
  effectiveTotalThbMinor: thb(effectiveMinor),
});

const chargeLine = (id: string, seq: number, chargeMinor: bigint): QuoteLineWire => ({
  id,
  seq,
  kind: 'freeform',
  productVersionId: null,
  documentHash: null,
  productId: null,
  skuCode: null,
  selections: null,
  measures: null,
  qty: 1,
  customerDescriptionTh: 'ค่าติดตั้งหน้างาน',
  isVatApplicable: true,
  computedTotalThbMinor: null,
  chargeTotalThbMinor: thb(chargeMinor),
  effectiveTotalThbMinor: thb(chargeMinor),
});

const lineOverride = (
  id: string,
  quoteLineId: string,
  computedMinor: bigint,
  overrideMinor: bigint,
): QuoteOverrideWire => ({
  id,
  anchor: 'line_total',
  quoteLineId,
  setByUserName: 'คุณสมชาย',
  computedThbMinor: thb(computedMinor),
  overrideThbMinor: thb(overrideMinor),
  computedDays: null,
  overrideDays: null,
  enteredAs: 'line_total',
  enteredValueText: '8500',
  reasonCode: 'price_match',
  noteTh: null,
  setByUserId: '3f2a1b90-0000-4000-8000-000000000001',
  createdAt: '2026-08-04T03:00:00.000Z',
});

const staleFor = (
  quoteLineId: string,
  kind: StaleBaselineWire['kind'],
  overrideId: string | null,
): StaleBaselineWire => ({
  kind,
  quoteLineId,
  seq: 1,
  overrideId,
  pinnedProductVersionId: 'pv-1',
  publishedProductVersionId: 'pv-2',
  promisedThbMinor: overrideId === null ? null : thb(850_000n),
  baselineThbMinor: thb(879_100n),
  currentComputedThbMinor: thb(950_000n),
});

/** A quote whose money block agrees with its lines unless a test says otherwise. */
const quote = (over: Partial<QuoteWire> = {}): QuoteWire => {
  const lines = over.lines ?? [catalogLine('l-1', 1, 879_100n)];
  /*
   * Read back through the app's own decoder rather than by reaching into the `Exact`. A test
   * that opened the opaque shape by hand would be the second reader `quote-wire.ts` exists to
   * prevent, and it would keep passing after the encoding changed.
   */
  const net = lines.reduce((sum, line) => sum + thbMinorOf(line.effectiveTotalThbMinor), 0n);

  return {
    orderId: '00000000-0000-4000-8000-000000000001',
    quoteRevision: '0123456789abcdef',
    currency: 'THB',
    lines,
    money: {
      netThbMinor: thb(net),
      taxableNetThbMinor: thb(net),
      exemptNetThbMinor: thb(0n),
      vatThbMinor: thb(0n),
      grandTotalThbMinor: thb(net),
      vat: { rateBp: 700, treatment: 'standard' },
    },
    computedLeadTimeDays: 30,
    effectiveLeadTimeDays: 30,
    sales: {
      overrides: [],
      marginConcessionThbMinor: thb(0n),
      baselineGrandTotalThbMinor: thb(net),
      staleBaselines: [],
    },
    ...over,
  };
};

const salesOf = (base: QuoteWire, over: Partial<NonNullable<QuoteWire['sales']>>) => ({
  ...base,
  sales: { ...(base.sales ?? emptySales()), ...over },
});

const emptySales = (): NonNullable<QuoteWire['sales']> => ({
  overrides: [],
  marginConcessionThbMinor: thb(0n),
  baselineGrandTotalThbMinor: thb(0n),
  staleBaselines: [],
});

describe('provenance', () => {
  it('calls an untouched catalogue line computed and puts nobody’s name on it', () => {
    const view = foldQuote(quote());
    const [first] = view.lines;

    expect(first?.provenance.kind).toBe('computed');
    expect(first?.effectiveThbMinor).toBe(879_100n);
    expect(first === undefined ? undefined : liveOverrideOf(first)).toBeNull();
    expect(hasHumanFigures(view)).toBe(false);
  });

  it('calls a free-form charge typed — it is not an override, because nothing was conceded', () => {
    const view = foldQuote(quote({ lines: [chargeLine('c-1', 1, 200_000n)] }));
    const [first] = view.lines;

    expect(first?.provenance.kind).toBe('typed');
    expect(first?.baselineThbMinor).toBe(200_000n);
    /* A human wrote it, so the screen says a human was here — without calling it a discount. */
    expect(hasHumanFigures(view)).toBe(true);
    expect(view.alarms).toHaveLength(0);
  });

  it('shows the server’s effective figure beside the baseline it replaced', () => {
    const base = quote({ lines: [catalogLine('l-1', 1, 879_100n, 850_000n)] });
    const view = foldQuote(salesOf(base, { overrides: [lineOverride('ov-1', 'l-1', 879_100n, 850_000n)] }));
    const [first] = view.lines;

    expect(first?.provenance.kind).toBe('overridden');
    expect(first?.effectiveThbMinor).toBe(850_000n);
    expect(first?.baselineThbMinor).toBe(879_100n);
    expect(first === undefined ? null : liveOverrideOf(first)?.setByUserId).toBe(
      '3f2a1b90-0000-4000-8000-000000000001',
    );
    /* Plan 7.9(ง)(2): a reprice would drop the promise silently, so the line is locked. */
    expect(first?.locked).toBe(true);
  });

  it('shows nothing about provenance to a caller with no sales block', () => {
    /* A customer looking at their own quote. Not a failure and not an empty state. */
    const view = foldQuote(quote({ sales: null }));

    expect(view.showsProvenance).toBe(false);
    expect(view.concession).toBeNull();
    expect(view.lines[0]?.provenance.kind).toBe('computed');
    expect(view.hasStaleBaselines).toBe(false);
  });
});

describe('integrity alarms', () => {
  it('shouts when the lines do not foot to the net the server sent', () => {
    const base = quote();
    const view = foldQuote({
      ...base,
      money: { ...base.money, netThbMinor: thb(879_101n) },
    });

    expect(view.alarms).toEqual([
      { kind: 'lines_do_not_foot', serverThbMinor: 879_101n, foldedThbMinor: 879_100n },
    ]);
  });

  it('does not shout about footing when a document override is the reason for the gap', () => {
    const base = quote();
    const view = foldQuote(
      salesOf(
        { ...base, money: { ...base.money, netThbMinor: thb(800_000n) } },
        {
          overrides: [
            {
              ...lineOverride('ov-doc', 'unused', 940_637n, 856_000n),
              anchor: 'grand_total',
              quoteLineId: null,
              enteredAs: 'grand_total',
            },
          ],
        },
      ),
    );

    expect(view.grandTotalOverride).not.toBeNull();
    expect(view.alarms).toHaveLength(0);
  });

  it('shouts when two live overrides share an anchor, instead of rendering the first', () => {
    const base = quote({ lines: [catalogLine('l-1', 1, 879_100n, 850_000n)] });
    const view = foldQuote(
      salesOf(base, {
        overrides: [
          lineOverride('ov-1', 'l-1', 879_100n, 850_000n),
          lineOverride('ov-2', 'l-1', 879_100n, 800_000n),
        ],
      }),
    );

    expect(view.alarms).toContainEqual({
      kind: 'duplicate_live_override',
      anchor: 'line_total',
      subjectId: 'l-1',
      count: 2,
    });
  });

  it('calls a moved baseline an integrity alarm when the server did not report it stale', () => {
    /* The promise was made against ฿8,791; the line now reports ฿9,500 and nothing explains it. */
    const base = quote({ lines: [catalogLine('l-1', 1, 950_000n, 850_000n)] });
    const view = foldQuote(salesOf(base, { overrides: [lineOverride('ov-1', 'l-1', 879_100n, 850_000n)] }));

    expect(view.alarms).toContainEqual({
      kind: 'baseline_moved_under_core',
      lineId: 'l-1',
      frozenThbMinor: 879_100n,
      currentThbMinor: 950_000n,
    });
    /* Nothing to re-confirm: no person can fix a calculator that changed. */
    expect(view.staleLines).toHaveLength(0);
  });

  it('says nothing of the sort when the server did report the line stale', () => {
    const base = quote({ lines: [catalogLine('l-1', 1, 950_000n, 850_000n)] });
    const view = foldQuote(
      salesOf(base, {
        overrides: [lineOverride('ov-1', 'l-1', 879_100n, 850_000n)],
        staleBaselines: [staleFor('l-1', 'promise_baseline_moved', 'ov-1')],
      }),
    );

    expect(view.alarms.filter((alarm) => alarm.kind === 'baseline_moved_under_core')).toHaveLength(0);
    expect(view.staleLines.map((line) => line.line.id)).toEqual(['l-1']);
    expect(view.lines[0]?.stale?.kind).toBe('promise_baseline_moved');
    expect(view.hasStaleBaselines).toBe(true);
  });

  it('carries the other stale kind through as itself, because the two jobs differ', () => {
    const base = quote();
    const view = foldQuote(salesOf(base, { staleBaselines: [staleFor('l-1', 'line_needs_repricing', null)] }));

    expect(view.lines[0]?.stale?.kind).toBe('line_needs_repricing');
    /* No promise on this line, so nothing is locked and nothing needs renegotiating. */
    expect(view.lines[0]?.locked).toBe(false);
  });
});

describe('the concession, and what this module refuses to decide about it', () => {
  it('renders the server\u2019s one subtraction and never re-derives it', () => {
    const view = foldQuote(
      salesOf(quote(), {
        marginConcessionThbMinor: thb(29_100n),
        baselineGrandTotalThbMinor: thb(940_637n),
      }),
    );

    expect(view.concession?.concessionThbMinor).toBe(29_100n);
    expect(view.concession?.baselineGrandTotalThbMinor).toBe(940_637n);
  });

  it('holds no ceiling and no verdict — that question belongs to the authority endpoint', () => {
    const view = foldQuote(salesOf(quote(), { marginConcessionThbMinor: thb(29_100n) }));

    /*
     * The contract says it in as many words on `marginConcessionThbMinor`: whether a
     * concession is *allowed* is `approvals` and `authority_limits`. A `ceilingThbMinor` or a
     * `requiresApproval` appearing on this view would be a second mechanism answering a
     * question that already has an owner \u2014 plan 7.13's opening finding.
     */
    expect(Object.keys(view.concession ?? {})).toEqual([
      'concessionThbMinor',
      'baselineGrandTotalThbMinor',
    ]);
  });

  it('blocks a send only for a stale baseline, which is the server\u2019s own list', () => {
    const conceded = foldQuote(salesOf(quote(), { marginConcessionThbMinor: thb(29_100n) }));
    expect(conceded.hasStaleBaselines).toBe(false);

    const stale = foldQuote(
      salesOf(quote(), { staleBaselines: [staleFor('l-1', 'promise_baseline_moved', null)] }),
    );
    expect(stale.hasStaleBaselines).toBe(true);
  });

  it('does not block the smoke path, which has no approval and no authority row at all', () => {
    /* Plan 13: \u0e3f8,791, 30% deposit, one slip, confirm, produce, deliver \u2014 no approval. */
    const view = foldQuote(quote());

    expect(view.concession?.concessionThbMinor).toBe(0n);
    expect(view.hasStaleBaselines).toBe(false);
    expect(view.alarms).toHaveLength(0);
  });
});
