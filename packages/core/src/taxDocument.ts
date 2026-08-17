import { dateIn, money } from './quotation.js';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * เอกสารภาษี — turning a frozen body into the words that go on the page.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠️ Pure, and in `packages/core` rather than in a component, for two reasons that both
 * matter. Neither app's vitest renders a `.tsx` — `environment: 'node'` in both — so anything
 * decided inside a component is decided where no test can see it; and the storefront will
 * eventually show a customer their own ใบกำกับภาษี, which must be the same page the dashboard
 * prints rather than a second one that drifted.
 *
 * ── ⚠️ What this module may and may not decide ───────────────────────────────
 *
 * It formats. It never computes: every figure comes out of the frozen body exactly as it went
 * in, because a page that re-derives its own VAT is a page that can disagree with the row it
 * was issued from. The one thing it *checks* is that the figures add up, and its answer to a
 * discrepancy is to say so on the page rather than to correct it.
 *
 * ── ⚠️ The caption is the legal furniture, not a heading ─────────────────────
 *
 * มาตรา 86/4(1) requires the words "ใบกำกับภาษี" in a conspicuous place, 86/6 requires
 * "ใบกำกับภาษีอย่างย่อ", and 86/10 requires "ใบลดหนี้". They are constants keyed by kind and
 * asserted in the tests — never styleable text a later redesign could shorten. ใบแจ้งหนี้ is
 * deliberately NOT one of them: an invoice is a demand for payment and carries no tax-invoice
 * caption at all, and printing one on it would be a false statement about what the paper is.
 */

export type TaxDocumentKind =
  | 'invoice'
  | 'tax_invoice'
  | 'abbreviated_tax_invoice'
  | 'receipt'
  | 'tax_invoice_receipt'
  | 'credit_note';

/** The statutory caption, verbatim. Keyed by kind so no screen can invent a synonym. */
export const TAX_DOCUMENT_CAPTION_TH: Record<TaxDocumentKind, string> = {
  invoice: 'ใบแจ้งหนี้',
  tax_invoice: 'ใบกำกับภาษี',
  abbreviated_tax_invoice: 'ใบกำกับภาษีอย่างย่อ',
  receipt: 'ใบเสร็จรับเงิน',
  tax_invoice_receipt: 'ใบเสร็จรับเงิน/ใบกำกับภาษี',
  credit_note: 'ใบลดหนี้',
};

/**
 * Which kinds are a ใบกำกับภาษี in the eyes of the Revenue Code, and therefore carry the buyer
 * block, the seller's tax id and the separated VAT line.
 *
 * ⚠️ `invoice` is absent on purpose and `receipt` is absent on purpose: a demand for payment and
 * a proof of receipt are not tax invoices, whatever else is true of them.
 */
export const IS_TAX_INVOICE: Record<TaxDocumentKind, boolean> = {
  invoice: false,
  tax_invoice: true,
  abbreviated_tax_invoice: true,
  receipt: false,
  tax_invoice_receipt: true,
  credit_note: true,
};

export interface TaxDocumentPartyView {
  readonly legalName: string;
  readonly taxIdText: string | null;
  /** Already resolved to words: "สำนักงานใหญ่" or "สาขาที่ 00012". */
  readonly branchText: string;
  readonly addressText: string;
  readonly kindText: string | null;
}

export interface TaxDocumentLineView {
  readonly descriptionTh: string;
  readonly quantityText: string;
  readonly unitText: string;
  readonly amountText: string;
}

export interface PrintableTaxDocument {
  readonly captionTh: string;
  readonly isTaxInvoice: boolean;
  readonly documentNo: string;
  readonly issuedAtText: string;
  readonly orderNoText: string;
  readonly subjectText: string;
  readonly seller: TaxDocumentPartyView;
  readonly buyer: TaxDocumentPartyView | null;
  readonly lines: readonly TaxDocumentLineView[];
  /**
   * ⚠️ An abbreviated tax invoice shows ONE inclusive figure plus the prescribed words, not a
   * net line, a VAT line and a total. `showsSeparatedVat` is what the renderer branches on.
   */
  readonly showsSeparatedVat: boolean;
  readonly vatInclusiveNoteTh: string | null;
  readonly netText: string;
  readonly vatText: string;
  readonly vatRateText: string;
  readonly grandTotalText: string;
  /** Set on a credit note: the number of the document being reduced, and why. */
  readonly citesText: string | null;
  /**
   * ⛔ The four figures มาตรา 86/10 wants on the face of a ใบลดหนี้: what the original said,
   * what is correct, the difference, and the VAT on the difference. Null on every other kind,
   * and on a credit note issued before the body carried them.
   */
  readonly adjustment: {
    readonly originalText: string;
    readonly correctedText: string;
    readonly differenceText: string;
    readonly vatOnDifferenceText: string;
  } | null;
  readonly reasonTh: string | null;
  /**
   * ⛔ Struck out. Read from the ROW, never from the body — `tax_documents_freeze()` permits
   * issued → voided and freezes everything else, so a cancellation can never be inside the
   * jsonb. A renderer that printed from `document` alone would reprint a cancelled tax invoice
   * as though it were live.
   */
  readonly voidedNoticeTh: string | null;
  /**
   * ⚠️ Non-null when the printed column does not add up to the printed total.
   *
   * The API refuses to issue such a document, so this should be unreachable — but it is a page
   * of evidence, and evidence that quietly hides its own inconsistency is worse than evidence
   * that shows it. A reader deserves to see the discrepancy rather than a tidied total.
   */
  readonly footingProblemTh: string | null;
}

/** Everything the page needs, as it comes off the wire. */
export interface TaxDocumentSource {
  readonly kind: TaxDocumentKind;
  readonly status: 'issued' | 'voided';
  readonly documentNo: string;
  readonly issuedAt: string;
  readonly voidedAt: string | null;
  readonly voidReasonTh: string | null;
  readonly netThbMinor: string;
  readonly vatThbMinor: string;
  readonly grandTotalThbMinor: string;
  readonly body: {
    readonly orderNo: string | null;
    readonly seller: RawParty;
    readonly buyer: RawParty | null;
    readonly subject:
      | { readonly kind: 'instalment'; readonly instalmentNo: number; readonly labelTh: string }
      | { readonly kind: 'whole_order' };
    readonly lines: readonly {
      readonly descriptionTh: string;
      readonly quantity: number;
      readonly unitThbMinor: string;
      readonly amountThbMinor: string;
    }[];
    readonly vat: { readonly rateBp: number; readonly treatment: string };
    readonly linesSumTo?: 'net' | 'grand_total' | undefined;
    readonly citesDocumentNo: string | null;
    readonly adjustment?: TaxDocumentAdjustmentSource | undefined;
    readonly reasonTh: string | null;
  };
}

interface TaxDocumentAdjustmentSource {
  readonly originalNetThbMinor: string;
  readonly correctedNetThbMinor: string;
  readonly differenceThbMinor: string;
  readonly vatOnDifferenceThbMinor: string;
}

interface RawParty {
  readonly buyerKind: 'individual' | 'juristic' | null;
  readonly legalName: string;
  readonly taxId: string | null;
  readonly branchCode: string | null;
  readonly addressLine: string;
  readonly postalCode: string | null;
  readonly country: string;
}

/**
 * ⚠️ `null` means head office and prints the words สำนักงานใหญ่.
 *
 * The words are required on a full tax invoice for a juristic party, and an omitted line is not
 * the same as a stated one: a reader cannot tell a head office from a question nobody asked.
 * Storing the Thai here rather than in the database keeps a rendering decision out of the row.
 */
function branchWords(branchCode: string | null): string {
  return branchCode === null || branchCode.trim() === ''
    ? 'สำนักงานใหญ่'
    : `สาขาที่ ${branchCode.trim()}`;
}

function party(raw: RawParty): TaxDocumentPartyView {
  return {
    legalName: raw.legalName,
    taxIdText: raw.taxId,
    branchText: branchWords(raw.branchCode),
    addressText: [raw.addressLine, raw.postalCode].filter((part) => part !== null && part !== '').join(' '),
    kindText:
      raw.buyerKind === 'juristic'
        ? 'นิติบุคคล'
        : raw.buyerKind === 'individual'
          ? 'บุคคลธรรมดา'
          : null,
  };
}

export function printableTaxDocument(source: TaxDocumentSource): PrintableTaxDocument {
  const thb = (minor: string): string => money(BigInt(minor), 'th', 'THB');

  const abbreviated = source.kind === 'abbreviated_tax_invoice';
  const summed = source.body.lines.reduce(
    (total, line) => total + BigInt(line.amountThbMinor),
    0n,
  );
  /*
   * ⚠️ Read from the body, not re-derived here.
   *
   * This used to ask whether the document was abbreviated, which is a PRESENTATION choice, while
   * the issuing service asked the quotation's `taxBasis`, which is a FACT about what the line
   * figures contain. The two agree only when an abbreviated invoice happens to sit on an
   * inclusive quotation; everywhere else one of them was wrong. The body now states the fact,
   * decided once where the basis is known.
   *
   * `'net'` for a `bodySchemaVersion: 1` body, which is the only basis anything was issued
   * under before the field existed.
   */
  const columnTotal = BigInt(
    source.body.linesSumTo === 'grand_total' ? source.grandTotalThbMinor : source.netThbMinor,
  );

  return {
    captionTh: TAX_DOCUMENT_CAPTION_TH[source.kind],
    isTaxInvoice: IS_TAX_INVOICE[source.kind],
    documentNo: source.documentNo,
    issuedAtText: dateIn(source.issuedAt, 'th'),
    orderNoText: source.body.orderNo ?? '—',
    subjectText:
      source.body.subject.kind === 'instalment'
        ? source.body.subject.labelTh
        : 'ทั้งใบสั่งซื้อ',
    seller: party(source.body.seller),
    /*
     * ⚠️ An abbreviated tax invoice carries no buyer block by design — it is the
     * over-the-counter form. Rendering an empty one would look like a missing field.
     */
    buyer: source.body.buyer === null ? null : party(source.body.buyer),
    lines: source.body.lines.map((line) => ({
      descriptionTh: line.descriptionTh,
      quantityText: line.quantity.toLocaleString('th-TH'),
      unitText: thb(line.unitThbMinor),
      amountText: thb(line.amountThbMinor),
    })),
    showsSeparatedVat: !abbreviated,
    vatInclusiveNoteTh: abbreviated ? 'ราคานี้รวมภาษีมูลค่าเพิ่มไว้แล้ว' : null,
    netText: thb(source.netThbMinor),
    vatText: thb(source.vatThbMinor),
    vatRateText: `${(source.body.vat.rateBp / 100).toLocaleString('th-TH')}%`,
    grandTotalText: thb(source.grandTotalThbMinor),
    citesText:
      source.body.citesDocumentNo === null
        ? null
        : `อ้างถึงเอกสารเลขที่ ${source.body.citesDocumentNo}`,
    adjustment:
      source.body.adjustment === undefined
        ? null
        : {
            originalText: thb(source.body.adjustment.originalNetThbMinor),
            correctedText: thb(source.body.adjustment.correctedNetThbMinor),
            differenceText: thb(source.body.adjustment.differenceThbMinor),
            vatOnDifferenceText: thb(source.body.adjustment.vatOnDifferenceThbMinor),
          },
    reasonTh: source.body.reasonTh,
    voidedNoticeTh:
      source.status === 'voided'
        ? `ยกเลิกแล้ว${source.voidedAt === null ? '' : ` เมื่อ ${dateIn(source.voidedAt, 'th')}`}${
            source.voidReasonTh === null ? '' : ` — ${source.voidReasonTh}`
          }`
        : null,
    footingProblemTh:
      summed === columnTotal
        ? null
        : `รายการรวมได้ ${money(summed, 'th', 'THB')} แต่ยอดของเอกสารคือ ${money(columnTotal, 'th', 'THB')}`,
  };
}
