import { describe, expect, it } from 'vitest';

import {
  pinnedDocumentFrom,
  printableQuotation,
  quotationProblem,
  type PinnedDocument,
} from '../src/quotation.js';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ A REPRINT MUST BE THE SAME DOCUMENT.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Plan 10.6 states the requirement and the reason in one sentence: *"เอกสารที่พิมพ์ซ้ำแล้ว
 * ได้คนละภาษาคือเอกสารที่ใช้อ้างอิงไม่ได้"* — a document that reprints differently is one
 * nobody can cite. It is the whole argument for `order_documents` existing at all: eight
 * things are pinned at `submit_for_payment`, and the locale is one of them.
 *
 * So the renderer is a **pure function of the pinned document**, and these tests are about
 * that purity rather than about layout:
 *
 *   ⓵ the same document in, the same strings out — every time, for every reader;
 *   ⓶ the **pinned** locale wins over the reader's, always;
 *   ⓷ nothing that changes between two prints may be inside the document.
 *
 * ⓷ is the one that is easy to get wrong and hard to see. "Printed on 7 Aug 2026" belongs on
 * a reprint and *not* inside the thing the hash covers, or the document stops being the
 * document.
 */

const DOCUMENT: PinnedDocument = {
  revision: 3,
  documentHash: 'a5b1c0d2e3f40516',
  pinnedLocale: 'th',
  destinationCountry: null,
  taxBasis: 'exclusive',
  orderNo: 'WW-1000',
  contactName: 'สมหญิง ใจดี',
  submittedAt: '2026-08-07T00:52:17.000Z',
  vatRateBp: 700,
  leadTimeDays: 30,
  netThbMinor: 769_200n,
  vatThbMinor: 53_844n,
  grandTotalThbMinor: 823_044n,
  lines: [
    {
      lineNo: 1,
      nameTh: 'บานเลื่อนอะลูมิเนียม',
      skuCode: 'SLD-2P-CLR',
      qty: 2,
      customerDescriptionTh: 'ห้องนอนชั้นสอง',
      options: [
        { groupTh: 'สีกระจก', valueTh: 'ใส' },
        { groupTh: 'สีโปรไฟล์', valueTh: 'ขาว' },
      ],
      measures: { width: '1800 mm', height: '2100 mm' },
      netMinor: 769_200n,
      fxMinor: null,
    },
  ],
  charges: [{ labelTh: 'ค่าติดตั้ง', amountMinor: 0n, fxMinor: null }],
  fx: null,
  scheduledDepositThbMinor: null,
};

describe('⭐ the same document renders the same way', () => {
  it('gives byte-identical output twice', () => {
    /*
     * The plainest statement of the requirement. If anything inside the renderer reaches for
     * a clock, a random value, a locale from the environment or a `Set` whose order is not
     * fixed, this is where it shows.
     */
    expect(JSON.stringify(printableQuotation(DOCUMENT))).toBe(
      JSON.stringify(printableQuotation(DOCUMENT)),
    );
  });

  it('⚠️ contains nothing that changes between two prints', () => {
    /*
     * The subtler half. A renderer that folded "printed on …" into the document would pass
     * the test above only if both calls landed in the same second — and would then fail in
     * production, silently, as two prints of one quotation that do not match.
     *
     * The view model is walked for anything shaped like today, and the print date lives
     * *outside* it: `printedAt` is the page's business, not the document's.
     */
    const rendered = JSON.stringify(printableQuotation(DOCUMENT));
    const today = new Date().getFullYear();

    expect(rendered, 'the current year appears inside the document').not.toContain(String(today));
    expect(rendered).not.toContain('printedAt');
  });

  it('⭐ renders in the pinned locale, not the reader’s', () => {
    /*
     * Plan 10.6 in one assertion. A document pinned in Thai stays Thai for a reader whose
     * browser is English — the alternative is two colleagues quoting different documents at
     * the same customer from the same row.
     *
     * The Buddhist year is the visible consequence: `th` renders 2569, and any other
     * calendar would be a different document.
     */
    const thai = printableQuotation({ ...DOCUMENT, pinnedLocale: 'th' });
    const english = printableQuotation({ ...DOCUMENT, pinnedLocale: 'en' });

    expect(thai.submittedAtText).toContain('2569');
    expect(english.submittedAtText).not.toContain('2569');
    expect(english.submittedAtText).toContain('2026');
  });

  it('falls back to Thai for a locale this build cannot render', () => {
    /*
     * A document pinned in a locale a later release removed still has to print. Falling back
     * is right and silence is not — `localeDegraded` is what the page shows, so a reprint
     * that is *not* faithful says so on its face rather than passing as one that is.
     */
    const rendered = printableQuotation({ ...DOCUMENT, pinnedLocale: 'xx-XX' });

    expect(rendered.localeDegraded).toBe(true);
    expect(rendered.submittedAtText).toContain('2569');
  });
});

describe('the money on the page', () => {
  it('shows satang, because a quotation is a number somebody pays', () => {
    /*
     * `formatBaht` rounds to the whole baht — right in a table, wrong on a document. ฿8,230
     * against a ฿8,230.44 total is a document whose own lines do not add up, and the
     * customer transfers the printed figure.
     */
    const rendered = printableQuotation(DOCUMENT);

    expect(rendered.grandTotalText).toBe('฿8,230.44');
    expect(rendered.netText).toBe('฿7,692.00');
    expect(rendered.vatText).toBe('฿538.44');
  });

  it('⚠️ its lines and charges add up to its total', () => {
    /*
     * Asserted rather than assumed. The renderer does no arithmetic — every figure comes
     * from the pinned document, which the API computed once — and this is what would notice
     * if somebody later "helpfully" recomputed one of them here.
     */
    const rendered = printableQuotation(DOCUMENT);
    const lines = DOCUMENT.lines.reduce((total, line) => total + line.netMinor, 0n);
    const charges = DOCUMENT.charges.reduce((total, charge) => total + charge.amountMinor, 0n);

    expect(lines + charges).toBe(DOCUMENT.netThbMinor);
    expect(DOCUMENT.netThbMinor + DOCUMENT.vatThbMinor).toBe(DOCUMENT.grandTotalThbMinor);
    expect(rendered.vatRateText).toBe('7%');
  });
});

describe('⭐ the basis the destination was quoted on', () => {
  /*
   * ⚠️ A wire-shaped fixture, not a `PinnedDocument` literal — these tests exercise
   * `pinnedDocumentFrom`, the decoder, not only the renderer. Money on the wire is tagged
   * (`{unit: 'THB.satang', digits}`, checked by `satang()` above), so a bare numeric string
   * would throw on the way in rather than decode — the same trap `quotation-wire.test.ts`
   * exists to catch.
   *
   * The figures are the ones `apps/api/tests/quotes/inclusive-basis.test.ts` pins for
   * `applyOverrides`: two lines at ฿20,000.00 and ฿9,000.00, one ฿1,000.00 charge, and a
   * 900bp (9%) inclusive destination whose net and VAT are divided back out of the
   * ฿30,000.00 grand total rather than added on top.
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

  const doc: Record<string, unknown> = {
    documentSchemaVersion: 2,
    revision: 1,
    documentHash: 'wire-hash',
    currency: 'THB',
    pinnedLocale: 'th',
    pinnedCoreVersion: 'dev',
    vat: { rateBp: 900, treatment: 'standard' },
    lines: [wireLine(1, 'เก้าอี้อะลูมิเนียม', '2000000'), wireLine(2, 'โต๊ะอะลูมิเนียม', '900000')],
    /* ⚠️ The field names `OrderDocumentChargeWire` really uses. This fixture said `labelTh` and
     `amountThbMinor`, which the API has never written — see `pinnedDocumentFrom`. */
  charges: [
    {
      lineNo: 3,
      customerDescriptionTh: 'ค่าติดตั้ง',
      netMinor: satangTag('100000'),
      isVatApplicable: true,
      override: null,
    },
  ],
    documentOverride: null,
    netThbMinor: satangTag('2752294'),
    vatThbMinor: satangTag('247706'),
    grandTotalThbMinor: satangTag('3000000'),
    leadTimeDays: 30,
  };

  const context = { orderNo: 'WW-2000', contactName: 'ลูกค้า', submittedAt: '2026-08-07T00:00:00.000Z' };

  it('reads a basis from the document and defaults to exclusive for older ones', () => {
    expect(pinnedDocumentFrom({ ...doc, taxBasis: 'inclusive' }, context).taxBasis).toBe('inclusive');
    /* Lenient, like its neighbours: a document older than the field is not a broken document. */
    expect(pinnedDocumentFrom(doc, context).taxBasis).toBe('exclusive');
    expect(pinnedDocumentFrom(doc, context).destinationCountry).toBeNull();
  });

  it('reports that VAT is included', () => {
    const pinned = pinnedDocumentFrom({ ...doc, taxBasis: 'inclusive' }, context);

    expect(printableQuotation(pinned).vatIsIncluded).toBe(true);
  });

  it('says nothing extra for an exclusive destination', () => {
    const pinned = pinnedDocumentFrom(doc, context);

    expect(printableQuotation(pinned).vatIsIncluded).toBe(false);
  });

  it('⚠️ foots: lines and charges together equal the grand total under an inclusive basis', () => {
    /*
     * Asserted on the `PinnedDocument`, NOT the `PrintableQuotation`. `PrintableLine` carries
     * `netText: string` and `charges` is `{ labelTh, amountText }` — formatted strings, no
     * minor units. The minor units live on `PinnedLine.netMinor` and `PinnedCharge.amountMinor`.
     */
    const pinned = pinnedDocumentFrom({ ...doc, taxBasis: 'inclusive' }, context);

    /*
     * Both arrays. `lines` and `charges` are separate in the document, and under an inclusive
     * basis the grand total is the sum of both, so a lines-only assertion would be false for
     * any quote carrying a charge — which is why this fixture has one.
     */
    const lineSum = pinned.lines.reduce((total, line) => total + line.netMinor, 0n);
    const chargeSum = pinned.charges.reduce((total, charge) => total + charge.amountMinor, 0n);

    expect(lineSum + chargeSum).toBe(pinned.grandTotalThbMinor);
    expect(pinned.netThbMinor + pinned.vatThbMinor).toBe(pinned.grandTotalThbMinor);
  });
});

describe('⭐ a cart is not a quotation', () => {
  it('refuses an order that has never been submitted', () => {
    /*
     * Before `submit_for_payment` there is no pinned document — no revision, no hash, no
     * frozen locale. Printing the editable cart as a "quotation" is how a customer ends up
     * holding a price the company never committed to, and the difference is invisible on
     * paper.
     */
    expect(quotationProblem({ hasDocument: false, status: 'draft' })).toBe('not-a-quotation-yet');
  });

  it('prints one that has been', () => {
    expect(quotationProblem({ hasDocument: true, status: 'awaiting_payment' })).toBeNull();
  });

  it('⚠️ still prints a cancelled order’s quotation', () => {
    /*
     * The document survives the order. "What did we quote them in August?" is asked most
     * often about the orders that did not proceed, and refusing to reprint one would delete
     * the answer at exactly the moment it is wanted.
     */
    expect(quotationProblem({ hasDocument: true, status: 'cancelled' })).toBeNull();
  });
});

describe('⭐ the option labels come from the document, not the catalogue', () => {
  it('renders the pinned Thai text rather than the warehouse code', () => {
    /*
     * The pinned document carries `catalogText` — `{ th: 'ลายไม้เข้ม', ref: { … } }` — frozen
     * at submit beside the locale and the prices. Rendering `selections` instead would put
     * `DW` on a document a customer reads, and would silently change the day somebody
     * renames the option in the catalogue.
     *
     * That second half is the one plan 10.6 is actually about: the reprint would be a
     * different document, and nothing would say so.
     */
    const [line] = printableQuotation(DOCUMENT).lines;

    expect(line?.detail).toContain('สีกระจก: ใส');
    expect(line?.detail.join(' ')).not.toMatch(/\bCLR\b|\bDW\b/u);
  });

  it('keeps measures ahead of options, in the document’s own order', () => {
    const [line] = printableQuotation(DOCUMENT).lines;

    expect(line?.detail[0]).toContain('width');
    expect(line?.detail.at(-1)).toContain('สีโปรไฟล์');
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ A CURRENCY WITH NO MINOR UNIT — the 100× hazard, in the one place it lands
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `MINOR_EXPONENT` calls itself "a fact, not a policy" and is `0` for VND and LAK. `money`
 * divided by a hardcoded `100n` for as long as baht was the only currency it could be handed,
 * and that constant surviving the change would render ₫1,234,567 as "12,345.67" — plan 4.3(c)'s
 * named failure, on a document somebody transfers against.
 *
 * Two currencies, not one: LAK proves the branch reads the table rather than special-casing the
 * three letters `VND`.
 */
describe('⚠️ a currency with no minor unit prints whole units, not hundredths', () => {
  const inCurrency = (currency: 'VND' | 'LAK' | 'SGD', minor: bigint) =>
    printableQuotation({
      ...DOCUMENT,
      fx: {
        currency,
        source: 'mid_market',
        spreadBp: 0,
        rateText: '0.001500',
        observedAt: null,
        netMinor: minor,
        vatMinor: 0n,
        grandTotalMinor: minor,
      },
    }).grandTotalText;

  it('renders đồng whole, with no decimal point at all', () => {
    /* 1,234,567 đồng is 1,234,567 minor units — the minor unit *is* the đồng. */
    expect(inCurrency('VND', 1_234_567n)).toBe('VND 1,234,567');
  });

  it('renders kip the same way, off the table rather than a special case', () => {
    expect(inCurrency('LAK', 987_654n)).toBe('LAK 987,654');
  });

  it('still renders a two-decimal currency with its two decimals', () => {
    /* The control. A fix that dropped the fraction everywhere would pass the two above. */
    expect(inCurrency('SGD', 1_234_567n)).toBe('SGD 12,345.67');
  });
});
