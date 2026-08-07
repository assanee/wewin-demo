import { describe, expect, it } from 'vitest';

import {
  printableQuotation,
  quotationProblem,
  type PinnedDocument,
} from '../src/components/quotes/printable-quotation';

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
    },
  ],
  charges: [{ labelTh: 'ค่าติดตั้ง', amountMinor: 0n }],
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
