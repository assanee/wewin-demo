import { describe, expect, it } from 'vitest';

import {
  IS_TAX_INVOICE,
  TAX_DOCUMENT_CAPTION_TH,
  printableTaxDocument,
  type TaxDocumentKind,
  type TaxDocumentSource,
} from '../src/taxDocument.js';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * What goes on the face of a tax document.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠️ These are the only tests that can see this page at all. Neither app's vitest renders a
 * `.tsx` — `environment: 'node'` in both — so a rule decided inside the component is a rule
 * nothing checks. That is not hypothetical here: a screen shipped this week with a switch that
 * could never be turned on, and it took opening a browser to find.
 */

const source = (over: Partial<TaxDocumentSource> = {}): TaxDocumentSource => ({
  kind: 'tax_invoice',
  status: 'issued',
  documentNo: 'TAX-2569-00007',
  issuedAt: '2026-08-17T03:00:00.000Z',
  voidedAt: null,
  voidReasonTh: null,
  netThbMinor: '11000',
  vatThbMinor: '770',
  grandTotalThbMinor: '11770',
  ...over,
  body: {
    orderNo: 'WW-1049',
    seller: {
      buyerKind: null,
      legalName: 'บริษัท วีวิน180 จำกัด',
      taxId: '0105560000001',
      branchCode: null,
      addressLine: '1 ถนนทดสอบ อำเภอเมือง จังหวัดพิษณุโลก',
      postalCode: '65000',
      country: 'TH',
    },
    buyer: {
      buyerKind: 'juristic',
      legalName: 'บริษัท ผู้ซื้อ จำกัด',
      taxId: '0105560123456',
      branchCode: null,
      addressLine: '99/1 ถนนทดสอบ',
      postalCode: '65000',
      country: 'TH',
    },
    subject: { kind: 'whole_order' },
    lines: [
      { descriptionTh: 'ชุดครัวสั่งทำ', quantity: 2, unitThbMinor: '5500', amountThbMinor: '11000' },
    ],
    vat: { rateBp: 700, treatment: 'standard' },
    citesDocumentNo: null,
    reasonTh: null,
    ...(over.body ?? {}),
  },
});

describe('the statutory caption', () => {
  it('⭐ every kind has one, and they are the words the Revenue Code names', () => {
    /*
     * มาตรา 86/4(1) requires "ใบกำกับภาษี" in a conspicuous place; 86/6 requires
     * "ใบกำกับภาษีอย่างย่อ"; 86/10 requires "ใบลดหนี้". Constants keyed by kind, never
     * styleable text a redesign could shorten to fit a column.
     */
    expect(TAX_DOCUMENT_CAPTION_TH.tax_invoice).toBe('ใบกำกับภาษี');
    expect(TAX_DOCUMENT_CAPTION_TH.abbreviated_tax_invoice).toBe('ใบกำกับภาษีอย่างย่อ');
    expect(TAX_DOCUMENT_CAPTION_TH.credit_note).toBe('ใบลดหนี้');
    expect(TAX_DOCUMENT_CAPTION_TH.receipt).toBe('ใบเสร็จรับเงิน');

    for (const kind of Object.keys(TAX_DOCUMENT_CAPTION_TH) as TaxDocumentKind[]) {
      expect(TAX_DOCUMENT_CAPTION_TH[kind], kind).toMatch(/[฀-๿]/u);
    }
  });

  it('⛔ ใบแจ้งหนี้ is never captioned as a tax invoice', () => {
    /*
     * An invoice is a demand for payment. Printing ใบกำกับภาษี on one would be a false
     * statement about what the paper is — and the switch that permits invoices
     * (`tax_doc_invoice_on_demand`) is separate from the one that permits tax invoices
     * precisely because they are different documents.
     */
    expect(TAX_DOCUMENT_CAPTION_TH.invoice).toBe('ใบแจ้งหนี้');
    expect(TAX_DOCUMENT_CAPTION_TH.invoice).not.toContain('ใบกำกับภาษี');
    expect(IS_TAX_INVOICE.invoice).toBe(false);
    expect(IS_TAX_INVOICE.receipt).toBe(false);
    expect(IS_TAX_INVOICE.tax_invoice_receipt).toBe(true);
  });

  it('⚠️ the six kinds are the six the database accepts, and no more', () => {
    /* The seventh copy of this enumeration. The count is what notices a member going missing. */
    expect(Object.keys(TAX_DOCUMENT_CAPTION_TH).sort()).toStrictEqual([
      'abbreviated_tax_invoice',
      'credit_note',
      'invoice',
      'receipt',
      'tax_invoice',
      'tax_invoice_receipt',
    ]);
    expect(Object.keys(IS_TAX_INVOICE).sort()).toStrictEqual(
      Object.keys(TAX_DOCUMENT_CAPTION_TH).sort(),
    );
  });
});

describe('the parties', () => {
  it('⭐ a null branch code prints the words สำนักงานใหญ่, never an empty line', () => {
    /*
     * The words are required on a full tax invoice, and an omitted line is not the same as a
     * stated one: a reader cannot tell a head office from a question nobody asked.
     */
    const page = printableTaxDocument(source());
    expect(page.seller.branchText).toBe('สำนักงานใหญ่');
    expect(page.buyer?.branchText).toBe('สำนักงานใหญ่');
  });

  it('⭐ a branch code prints as สาขาที่ …', () => {
    const page = printableTaxDocument(
      source({
        body: { ...source().body, buyer: { ...source().body.buyer!, branchCode: '00012' } },
      } as Partial<TaxDocumentSource>),
    );
    expect(page.buyer?.branchText).toBe('สาขาที่ 00012');
  });

  it('⭐ the buyer’s kind is shown, so a null tax id can be explained', () => {
    expect(printableTaxDocument(source()).buyer?.kindText).toBe('นิติบุคคล');
    /* The seller block is this company; there is nothing to say about its kind. */
    expect(printableTaxDocument(source()).seller.kindText).toBeNull();
  });

  it('⭐ an abbreviated tax invoice has no buyer block at all', () => {
    const page = printableTaxDocument(
      source({
        kind: 'abbreviated_tax_invoice',
        body: { ...source().body, buyer: null },
      } as Partial<TaxDocumentSource>),
    );
    expect(page.buyer).toBeNull();
  });
});

describe('the money', () => {
  it('⭐ a full tax invoice separates the VAT; an abbreviated one states it is included', () => {
    /*
     * มาตรา 86/6 turns the page inside out: one inclusive figure plus prescribed words, rather
     * than a net line, a VAT line and a total. Rendering the same table for both would put a
     * separated VAT line on a form that may not carry one.
     */
    const full = printableTaxDocument(source());
    expect(full.showsSeparatedVat).toBe(true);
    expect(full.vatInclusiveNoteTh).toBeNull();
    expect(full.vatText).toBe('฿7.70');
    expect(full.vatRateText).toBe('7%');

    const abbreviated = printableTaxDocument(
      source({
        kind: 'abbreviated_tax_invoice',
        netThbMinor: '11000',
        vatThbMinor: '770',
        grandTotalThbMinor: '11770',
        body: {
          ...source().body,
          buyer: null,
          linesSumTo: 'grand_total',
          lines: [
            {
              descriptionTh: 'ชุดครัวสั่งทำ',
              quantity: 2,
              unitThbMinor: '5885',
              amountThbMinor: '11770',
            },
          ],
        },
      } as Partial<TaxDocumentSource>),
    );
    expect(abbreviated.showsSeparatedVat).toBe(false);
    expect(abbreviated.vatInclusiveNoteTh).toBe('ราคานี้รวมภาษีมูลค่าเพิ่มไว้แล้ว');
  });

  it('⭐ every figure is copied, never recomputed', () => {
    /*
     * ⚠️ The page states what was issued. A renderer that derived VAT from the rate would
     * disagree with the row the moment rounding differed, and the row is the evidence.
     */
    const page = printableTaxDocument(
      source({ netThbMinor: '10000', vatThbMinor: '1', grandTotalThbMinor: '10001' }),
    );
    expect(page.vatText).toBe('฿0.01');
    expect(page.grandTotalText).toBe('฿100.01');
  });

  it('⛔ says so on the page when the column does not add up', () => {
    /*
     * The API refuses to issue such a document, so this should be unreachable — but a page of
     * evidence that quietly tidies its own inconsistency is worse than one that shows it.
     */
    const page = printableTaxDocument(
      source({
        body: {
          ...source().body,
          lines: [
            { descriptionTh: 'ชุดครัว', quantity: 1, unitThbMinor: '9000', amountThbMinor: '9000' },
          ],
        },
      } as Partial<TaxDocumentSource>),
    );
    expect(page.footingProblemTh).toContain('฿90.00');
    expect(page.footingProblemTh).toContain('฿110.00');
  });

  it('⭐ a correct document reports no footing problem', () => {
    /* The anti-vacuity half: if this ever fails, the check above proves nothing. */
    expect(printableTaxDocument(source()).footingProblemTh).toBeNull();
  });
});

describe('a document that was struck out', () => {
  it('⛔ carries the cancellation on its face, read from the row and not the body', () => {
    /*
     * `tax_documents_freeze()` permits issued → voided and freezes every other column, so the
     * cancellation can never be inside the frozen jsonb. A renderer that printed from `document`
     * alone would reprint a cancelled tax invoice as though it were live — which is the one
     * mistake this feature must never make.
     */
    const page = printableTaxDocument(
      source({
        status: 'voided',
        voidedAt: '2026-08-18T04:00:00.000Z',
        voidReasonTh: 'ออกผิดชื่อผู้ซื้อ',
      }),
    );
    expect(page.voidedNoticeTh).toContain('ยกเลิกแล้ว');
    expect(page.voidedNoticeTh).toContain('ออกผิดชื่อผู้ซื้อ');
  });

  it('⭐ an issued one carries no such notice', () => {
    expect(printableTaxDocument(source()).voidedNoticeTh).toBeNull();
  });
});

describe('the date and the subject', () => {
  it('⭐ the date is Buddhist and in Bangkok, like every other date this system prints', () => {
    /* 03:00 UTC on 17 August 2026 is 10:00 in Bangkok on the same day — 2569 in the BE calendar. */
    const page = printableTaxDocument(source());
    expect(page.issuedAtText).toContain('2569');
    expect(page.documentNo).toContain('2569');
  });

  it('⭐ an instalment document says which งวด it covers', () => {
    const page = printableTaxDocument(
      source({
        body: {
          ...source().body,
          subject: { kind: 'instalment', instalmentNo: 1, labelTh: 'งวดที่ 1' },
        },
      } as Partial<TaxDocumentSource>),
    );
    expect(page.subjectText).toBe('งวดที่ 1');
  });
});

describe('a credit note', () => {
  const creditNote = () =>
    printableTaxDocument(
      source({
        kind: 'credit_note',
        netThbMinor: '11000',
        vatThbMinor: '770',
        grandTotalThbMinor: '11770',
        body: {
          ...source().body,
          citesDocumentNo: 'TAX-2569-00007',
          reasonTh: 'ออกผิดชื่อผู้ซื้อ',
          adjustment: {
            originalNetThbMinor: '11000',
            correctedNetThbMinor: '0',
            differenceThbMinor: '11000',
            vatOnDifferenceThbMinor: '770',
          },
        },
      } as Partial<TaxDocumentSource>),
    );

  it('⭐ carries the four figures มาตรา 86/10 wants, all positive', () => {
    /*
     * A reader has to see the value the original stated, the value that is now correct, the
     * difference and the VAT on the difference — on the page, without fetching the document
     * being reduced. The body had one net/vat/grand triple and nowhere to put the other three.
     */
    expect(creditNote().adjustment).toStrictEqual({
      originalText: '฿110.00',
      correctedText: '฿0.00',
      differenceText: '฿110.00',
      vatOnDifferenceText: '฿7.70',
    });
  });

  it('⭐ names the document it reduces, and why', () => {
    expect(creditNote().captionTh).toBe('ใบลดหนี้');
    expect(creditNote().citesText).toContain('TAX-2569-00007');
    expect(creditNote().reasonTh).toBe('ออกผิดชื่อผู้ซื้อ');
  });

  it('⭐ no other kind carries an adjustment block', () => {
    /* The anti-vacuity half: if this returned an object for everything, the test above is empty. */
    expect(printableTaxDocument(source()).adjustment).toBeNull();
  });
});

describe('what the line column adds up to', () => {
  it('⛔ is read from the body, not guessed from the kind', () => {
    /*
     * Two places were deriving this by different rules: the issuing service asked the
     * quotation's `taxBasis` — a fact about what the figures contain — and this module asked
     * whether the document was abbreviated, which is a presentation choice. They agree only
     * when an abbreviated invoice happens to sit on an inclusive quotation.
     *
     * Here is the case that separated them: an ABBREVIATED invoice whose lines are exclusive.
     * The old rule compared the column against the grand total and reported a false problem.
     */
    const page = printableTaxDocument(
      source({
        kind: 'abbreviated_tax_invoice',
        netThbMinor: '11000',
        vatThbMinor: '770',
        grandTotalThbMinor: '11770',
        body: { ...source().body, buyer: null, linesSumTo: 'net' },
      } as Partial<TaxDocumentSource>),
    );

    expect(page.footingProblemTh).toBeNull();
  });

  it('⭐ a body that says grand_total is footed against the grand total', () => {
    const page = printableTaxDocument(
      source({
        netThbMinor: '11000',
        vatThbMinor: '770',
        grandTotalThbMinor: '11770',
        body: {
          ...source().body,
          linesSumTo: 'grand_total',
          lines: [
            {
              descriptionTh: 'ชุดครัวสั่งทำ',
              quantity: 1,
              unitThbMinor: '11770',
              amountThbMinor: '11770',
            },
          ],
        },
      } as Partial<TaxDocumentSource>),
    );

    expect(page.footingProblemTh).toBeNull();
  });

  it('⚠️ a bodySchemaVersion 1 body has no such field and is footed against the net', () => {
    /* Frozen documents cannot be migrated, so the absent case must keep reading correctly. */
    const page = printableTaxDocument(source());
    expect(page.footingProblemTh).toBeNull();
  });
});
