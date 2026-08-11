import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { describe, expect, it } from 'vitest';
import { pinnedDocumentFrom, printableQuotation, type PinnedDocument } from '@wewin/core/quotation';

import { LocaleProvider } from '@/state/LocaleProvider';
import { QuotationIsland } from '@/components/quotation/QuotationIsland';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ THE ONE VAT STRING THE STOREFRONT KEEPS.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Task 14 removed every prerendered VAT-rate claim from the storefront, because a
 * browsing page cannot know a customer's destination and a rate baked into static HTML
 * goes stale the moment `tax_countries` changes. A quotation is the opposite of that page:
 * it is per-order, data-driven, and the basis it prints is the one `taxBasis` actually
 * pinned at submit. `quotation.vatIncluded` is that one exception, and it renders only
 * when `PrintableQuotation.vatIsIncluded` is true.
 *
 * ── ⚠️ Why this file does not render `QuotationIsland` through its `'ready'` phase ────
 *
 * The task brief this file was written against assumed `QuotationIsland` takes a
 * `quotation` prop it could be handed directly. It does not: `QuotationIsland` takes no
 * props at all and reads its document with a `useEffect` that calls `fetchQuotation`
 * against `window.location.search`. `renderToStaticMarkup` never runs effects — that is
 * true of every SSR render, not a gap in this harness — so no amount of wrapping reaches
 * the `'ready'` phase where the VAT row lives. The brief's own escape hatch for exactly
 * this shape of problem is to assert on `printableQuotation` alone and let Step 7's
 * browser pass (print an inclusive-destination order to PDF) cover the markup. That is
 * what this file does, plus a smoke test that the island still renders its loading phase
 * with no browser globals available, so a future prop-free refactor cannot make the
 * import graph itself throw without anything here noticing.
 */

const BASE: PinnedDocument = {
  revision: 1,
  documentHash: 'inclusive-layout-fixture',
  pinnedLocale: 'th',
  destinationCountry: 'SG',
  taxBasis: 'exclusive',
  orderNo: 'WW-3000',
  contactName: null,
  submittedAt: '2026-08-07T00:00:00.000Z',
  vatRateBp: 900,
  leadTimeDays: 30,
  /* The exact figures apps/api/tests/quotes/inclusive-basis.test.ts pins for a 900bp
   * inclusive destination: a ฿30,000.00 catalogue sum divided back into net and VAT. */
  netThbMinor: 2_752_294n,
  vatThbMinor: 247_706n,
  grandTotalThbMinor: 3_000_000n,
  lines: [
    {
      lineNo: 1,
      nameTh: 'เก้าอี้อะลูมิเนียม',
      skuCode: 'CHR-1',
      qty: 2,
      customerDescriptionTh: null,
      options: [],
      measures: {},
      netMinor: 2_000_000n,
    },
    {
      lineNo: 2,
      nameTh: 'โต๊ะอะลูมิเนียม',
      skuCode: 'TBL-1',
      qty: 1,
      customerDescriptionTh: null,
      options: [],
      measures: {},
      netMinor: 900_000n,
    },
  ],
  /* At least one charge, or the footing this fixture exists to check would be silently
   * true only for the case — no charge — that cannot expose a lines-only bug. */
  charges: [{ labelTh: 'ค่าติดตั้ง', amountMinor: 100_000n }],
};

/*
 * ⚠️ Wire-shaped, and used only by the footing test below. `BASE` above is a hand-built
 * `PinnedDocument` — useful for asserting what `printableQuotation` does with a given
 * document, but reducing over `BASE.lines`/`BASE.charges` directly never calls
 * `pinnedDocumentFrom` or `printableQuotation` at all, so it cannot fail when either one
 * does — a review round on this branch caught exactly that shape of test here and asked
 * for a decode through the real functions instead. Same figures as `BASE` and as
 * `packages/core/tests/quotation.test.ts`'s own destination-basis fixture, tagged the way
 * the wire actually carries money (`satang()` in `quotation.ts` throws on anything else).
 */
const satangTag = (digits: string) => ({ unit: 'THB.satang', digits });

const wireLine = (lineNo: number, nameTh: string, netDigits: string): Record<string, unknown> => ({
  lineNo,
  nameTh,
  skuCode: `SKU-${String(lineNo)}`,
  qty: 1,
  customerDescriptionTh: null,
  measures: {},
  price: { lines: [] },
  netMinor: satangTag(netDigits),
});

const wireDoc: Record<string, unknown> = {
  documentSchemaVersion: 2,
  revision: 1,
  documentHash: 'inclusive-layout-wire-fixture',
  currency: 'THB',
  pinnedLocale: 'th',
  pinnedCoreVersion: 'dev',
  vat: { rateBp: 900, treatment: 'standard' },
  lines: [wireLine(1, 'เก้าอี้อะลูมิเนียม', '2000000'), wireLine(2, 'โต๊ะอะลูมิเนียม', '900000')],
  charges: [{ labelTh: 'ค่าติดตั้ง', amountThbMinor: satangTag('100000') }],
  documentOverride: null,
  netThbMinor: satangTag('2752294'),
  vatThbMinor: satangTag('247706'),
  grandTotalThbMinor: satangTag('3000000'),
  leadTimeDays: 30,
  taxBasis: 'inclusive',
};

const wireContext = { orderNo: 'WW-3000', contactName: null, submittedAt: '2026-08-07T00:00:00.000Z' };

describe('⭐ vatIsIncluded, off the pinned document', () => {
  it('is true for an inclusive destination', () => {
    const inclusive = printableQuotation({ ...BASE, taxBasis: 'inclusive' });

    expect(inclusive.vatIsIncluded).toBe(true);
  });

  it('is false for an exclusive destination — nothing changes', () => {
    const exclusive = printableQuotation({ ...BASE, taxBasis: 'exclusive' });

    expect(exclusive.vatIsIncluded).toBe(false);
  });

  it('computes nothing new: the three money figures are unaffected by the basis', () => {
    const inclusive = printableQuotation({ ...BASE, taxBasis: 'inclusive' });
    const exclusive = printableQuotation({ ...BASE, taxBasis: 'exclusive' });

    expect(inclusive.netText).toBe(exclusive.netText);
    expect(inclusive.vatText).toBe(exclusive.vatText);
    expect(inclusive.grandTotalText).toBe(exclusive.grandTotalText);
    expect(inclusive.lines.map((line) => line.netText)).toStrictEqual(
      exclusive.lines.map((line) => line.netText),
    );
  });

  it('⚠️ lines and charges together foot to the grand total, decoded through the real functions', () => {
    /*
     * Both halves of the pipeline, not a reduction over a hand-typed literal: decode with
     * `pinnedDocumentFrom` (this is what actually failed, silently returning `undefined`
     * for `vatIsIncluded`, the first time this suite ran against a stale `packages/core`
     * build), then render with `printableQuotation`. A mutation that breaks either one
     * — confirmed with the same "make `printableQuotation` throw unconditionally" check a
     * review round used to prove the old version of this test never called it — reddens
     * this test.
     */
    const pinned = pinnedDocumentFrom(wireDoc, wireContext);

    const lineSum = pinned.lines.reduce((total, line) => total + line.netMinor, 0n);
    const chargeSum = pinned.charges.reduce((total, charge) => total + charge.amountMinor, 0n);

    expect(lineSum + chargeSum).toBe(pinned.grandTotalThbMinor);
    expect(pinned.netThbMinor + pinned.vatThbMinor).toBe(pinned.grandTotalThbMinor);

    /* Ties the minor-unit footing above to what a reader actually sees: the rendered grand
     * total is the same ฿30,000.00 the lines and charges just summed to. */
    expect(printableQuotation(pinned).grandTotalText).toBe('฿30,000.00');
  });
});

describe('the island still renders its loading phase with no browser globals', () => {
  it('does not throw when statically rendered under LocaleProvider', () => {
    const html = renderToStaticMarkup(
      createElement(LocaleProvider, { locale: 'th', children: createElement(QuotationIsland) }),
    );

    /* `quotation.loading` — the only phase reachable without effects running. */
    expect(html).toContain('กำลังเปิดใบเสนอราคา');
  });
});
