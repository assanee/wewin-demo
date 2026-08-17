import { z } from 'zod';

import { ORDER_STATUSES_WIRE, type OrderStatusWire } from './order.js';

/**
 * ⭐ อัตราริบมัดจำ — what a cancellation costs, as a thing a person may edit.
 *
 * ── Why this is its own module ──────────────────────────────────────────────────
 *
 * It belongs with the company's other settings and cannot live in `organisation.ts`: that file
 * is imported *by* `order.ts`, and this needs `ORDER_STATUSES_WIRE` from it. The cycle is not
 * hypothetical — `organisation.ts`'s own note on `orderIsLive` records choosing a boolean over
 * a status field for exactly that reason. A third module depending on both has no such problem.
 */

/**
 * One cell of the policy: what a cancellation from this status, with this fault, forfeits.
 *
 * ── Why a cell carries its own lock ─────────────────────────────────────────────
 *
 * Two of the constraints in `forfeit_policy_rules` fix certain cells at 0 and refuse anything
 * else, and neither is a default somebody may override by typing:
 *
 *   `company` fault           the company's own mistake never costs the customer money.
 *   `production_confirmed`    nothing has been cut yet — plan 7.8. Cutting starts at
 *                             `in_production`, which is the first row where a forfeit can be
 *                             about a real cost.
 *
 * A screen that offered those boxes would be offering a 400, so the server says which cells are
 * editable and why the others are not. The list is not restated on the client: the statuses a
 * cancellation can leave from come from `order_status_transitions`, which is also what the
 * database's own completeness check reads.
 */
export interface ForfeitCellWire {
  readonly fromStatus: OrderStatusWire;
  readonly fault: 'customer' | 'company';
  readonly forfeitBp: number;
  /** False when a CHECK fixes this cell at 0 — see `whyLockedTh`. */
  readonly editable: boolean;
  /** Thai, and only when `editable` is false. The reason, for the person looking at the box. */
  readonly whyLockedTh: string | null;
}

/**
 * The policy that applies to a cancellation happening now.
 *
 * ⚠️ `null` cells never appear: a policy that is effective and incomplete cannot exist, because
 * `assert_forfeit_policy_complete()` is a deferred constraint trigger that refuses the
 * transaction. Every cancellable status × fault is present or the read failed.
 */
export interface ForfeitPolicyWire {
  readonly code: string;
  readonly descriptionTh: string;
  readonly effectiveFrom: string;
  readonly cells: readonly ForfeitCellWire[];
}

/**
 * ⭐ Publishing a new policy — which is the only way to change one.
 *
 * An order pins `forfeit_policy_id` at submit, so editing a live policy in place would change
 * what a customer gets back on a contract they had already signed. Policies are therefore
 * versioned by `effective_from` and the newest effective one wins; publishing writes a new
 * version and leaves every existing order pointing at the one it agreed to.
 *
 * ⚠️ Only `customer` cells are sent, and only for statuses the server says are editable. The
 * company-fault half and the freeze-point row are written as 0 by the server, because they are
 * the same 0 in every policy that will ever exist.
 */
export interface PublishForfeitPolicyRequestWire {
  /** What changed and why — this is what somebody reads in a year to explain a refund. */
  readonly descriptionTh: string;
  readonly cells: readonly { readonly fromStatus: OrderStatusWire; readonly forfeitBp: number }[];
}

export const publishForfeitPolicyRequestSchema: z.ZodType<PublishForfeitPolicyRequestWire> =
  z.strictObject({
    descriptionTh: z.string().trim().min(1).max(500),
    cells: z
      .array(
        z.strictObject({
          fromStatus: z.literal(ORDER_STATUSES_WIRE),
          forfeitBp: z.int().min(0).max(10_000),
        }),
      )
      .min(1),
  });

/* ------------------------------------------------------------------ *
 * ⭐ เอกสารภาษี — the switches, and who is billed
 * ------------------------------------------------------------------ */

/**
 * Whether and how the company issues tax documents.
 *
 * ⛔ **Deliberately NOT on `OrganisationProfileWire`.** That wire is the letterhead: it is read
 * by the storefront and by anybody holding a document link, because a quotation has to print the
 * seller's name and address. Whether this company issues tax invoices per instalment is nobody's
 * business but the company's, and a field added to the profile is a field published to every
 * customer by construction. Two wires, two audiences.
 *
 * The switches are all off as shipped. A company that has not decided must not start issuing
 * numbered tax documents because a default said so.
 */
export interface TaxDocumentSettingsWire {
  /** 2.1 — the master switch. Everything below is inert while this is false. */
  readonly enabled: boolean;
  /** 2.2 — issue as each instalment is received. */
  readonly onInstalment: boolean;
  /**
   * 2.2 — issue one document at delivery.
   *
   * ⚠️ Independent of `onInstalment` at the owner's explicit instruction. They were told that
   * this alone can under-declare output VAT when a deposit was taken before delivery — the tax
   * point on that money has already passed — and chose to keep both switches free. The settings
   * screen says so beside the switch; this is the other half of that record.
   */
  readonly onDelivery: boolean;
  /** 2.2/2.3 — one combined ใบเสร็จรับเงิน/ใบกำกับภาษี, or a receipt and a tax invoice apart. */
  readonly combinedReceipt: boolean;
  /** 2.3 — the invoice is its own document, issued when a customer asks for one. */
  readonly invoiceOnDemand: boolean;
  /** ใบกำกับภาษีอย่างย่อ for a retail sale, where the buyer block is not required. */
  readonly abbreviatedAllowed: boolean;
}

export const taxDocumentSettingsSchema: z.ZodType<TaxDocumentSettingsWire> = z.strictObject({
  enabled: z.boolean(),
  onInstalment: z.boolean(),
  onDelivery: z.boolean(),
  combinedReceipt: z.boolean(),
  invoiceOnDemand: z.boolean(),
  abbreviatedAllowed: z.boolean(),
});

/**
 * ⭐ Who the document is made out to — the block a tax invoice cannot omit.
 *
 * Held per ORDER rather than per customer: a walk-in owns their order through a guest row that
 * holds nothing personal, and in made-to-measure work the party who orders and the party who is
 * billed are often different people — a landlord, a company, a spouse.
 *
 * ⚠️ `taxId` is required for a `juristic` buyer and the database enforces it, because a full
 * ใบกำกับภาษี made out to a company without one is not a document that company can use.
 */
export interface OrderBillToWire {
  readonly buyerKind: 'individual' | 'juristic';
  readonly legalName: string;
  readonly taxId: string | null;
  /** `null` means สำนักงานใหญ่ — the head office, which is what most buyers are. */
  readonly branchCode: string | null;
  readonly addressLine: string;
  readonly postalCode: string | null;
  readonly country: string;
  readonly updatedAt: string;
}

export const putOrderBillToSchema: z.ZodType<
  Omit<OrderBillToWire, 'updatedAt'>
> = z
  .strictObject({
    buyerKind: z.literal(['individual', 'juristic']),
    legalName: z.string().trim().min(1).max(300),
    taxId: z.string().regex(/^[0-9]{13}$/u, 'เลขผู้เสียภาษีต้องเป็นตัวเลข 13 หลัก').nullable(),
    branchCode: z.string().trim().max(20).nullable(),
    addressLine: z.string().trim().min(1).max(500),
    postalCode: z.string().trim().max(10).nullable(),
    country: z.string().regex(/^[A-Z]{2}$/u).default('TH'),
  })
  /*
   * ⛔ The same rule as `order_bill_to_juristic_has_tax_id`, restated here so the refusal is a
   * 400 with a path rather than a CHECK violation translated into a shrug. Two expressions of
   * one rule, and `tests/organisation/bill-to.pg.test.ts` asserts they agree.
   */
  .refine((value) => value.buyerKind !== 'juristic' || value.taxId !== null, {
    message: 'ลูกค้านิติบุคคลต้องมีเลขประจำตัวผู้เสียภาษี',
    path: ['taxId'],
  });

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * เอกสารภาษี — the frozen body of an issued document.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠️ A **copy**, not a view. Everything a printed page needs is written into this object at
 * issue and never read live again: the seller's own block, the buyer's block, the lines, the
 * rate. `organisation_profile` says a letterhead is not frozen, which is right for a quotation
 * — a reprint should carry today's telephone number — and wrong here, where the page is
 * evidence of what was filed and the company's registered name on the day it was filed is part
 * of what was filed.
 *
 * ⚠️ Every amount is POSITIVE, a credit note's included. The direction is the `kind`. A sign
 * in a money field is a sign somebody eventually forgets to apply.
 */
export const TAX_DOCUMENT_KINDS_WIRE = [
  'invoice',
  'tax_invoice',
  'abbreviated_tax_invoice',
  'receipt',
  'tax_invoice_receipt',
  'credit_note',
] as const;

export type TaxDocumentKindWire = (typeof TAX_DOCUMENT_KINDS_WIRE)[number];

/** A party's block, as it stood at issue — the seller's, or the buyer's. */
export interface TaxDocumentPartyWire {
  /**
   * ⚠️ Individual or company, frozen with the rest.
   *
   * Without it, a document whose `taxId` is null cannot be shown to have been legitimately an
   * individual's rather than a company's issued in breach of the juristic rule — which is the
   * question an audit asks. `null` on the seller block, which is always this company.
   */
  readonly buyerKind: 'individual' | 'juristic' | null;
  readonly legalName: string;
  readonly taxId: string | null;
  /** `null` prints as สำนักงานใหญ่. */
  readonly branchCode: string | null;
  readonly addressLine: string;
  readonly postalCode: string | null;
  readonly country: string;
}

export interface TaxDocumentLineWire {
  readonly descriptionTh: string;
  readonly quantity: number;
  readonly unitThbMinor: string;
  readonly amountThbMinor: string;
}

/**
 * What money this document is about.
 *
 * ⚠️ The distinction the whole feature turns on. A document raised at a payment covers ONE
 * instalment; a document raised at delivery covers the order once. Both modes may be switched
 * on at the same time by the owner's instruction, so three partial unique indexes — not a
 * service — are what stop the same supply being tax-invoiced twice.
 */
export type TaxDocumentSubjectWire =
  | { readonly kind: 'instalment'; readonly instalmentNo: number; readonly labelTh: string }
  | { readonly kind: 'whole_order' };

export interface TaxDocumentBodyWire {
  readonly bodySchemaVersion: 1;
  readonly kind: TaxDocumentKindWire;
  readonly documentNo: string;
  readonly issuedAt: string;
  readonly orderNo: string | null;
  readonly seller: TaxDocumentPartyWire;
  /**
   * ⚠️ Nullable only for `abbreviated_tax_invoice` — ใบกำกับภาษีอย่างย่อ, which by design
   * carries no buyer name or address. Every other kind has one, and the issuing service refuses
   * to make one without.
   */
  readonly buyer: TaxDocumentPartyWire | null;
  readonly subject: TaxDocumentSubjectWire;
  readonly lines: readonly TaxDocumentLineWire[];
  readonly vat: { readonly rateBp: number; readonly treatment: string };
  readonly netThbMinor: string;
  readonly vatThbMinor: string;
  readonly grandTotalThbMinor: string;
  /** The document this one reduces. Set on a credit note and on nothing else. */
  readonly citesDocumentNo: string | null;
  readonly reasonTh: string | null;
  readonly documentHash: string;
}

/** One issued document, as a list or a screen reads it. */
export interface TaxDocumentWire {
  readonly id: string;
  readonly kind: TaxDocumentKindWire;
  readonly status: 'issued' | 'voided';
  readonly documentNo: string;
  readonly issuedAt: string;
  readonly voidedAt: string | null;
  readonly voidReasonTh: string | null;
  readonly instalmentId: string | null;
  readonly netThbMinor: string;
  readonly vatThbMinor: string;
  readonly grandTotalThbMinor: string;
  readonly body: TaxDocumentBodyWire;
}

/**
 * ออกเอกสาร — what staff send to raise one by hand.
 *
 * ⚠️ `kind` is chosen by the caller rather than derived, because the same moment can legitimately
 * produce different documents at different companies: some issue ใบแจ้งหนี้ before payment, some
 * a combined ใบเสร็จรับเงิน/ใบกำกับภาษี after it. What the settings decide is which kinds are
 * *permitted*; what this field decides is which permitted kind to raise now.
 */
export const issueTaxDocumentSchema: z.ZodType<{
  kind: TaxDocumentKindWire;
  instalmentId: string | null;
}> = z.strictObject({
  kind: z.literal(TAX_DOCUMENT_KINDS_WIRE),
  /** `null` means the whole order — the delivery-mode document. */
  instalmentId: z.uuid().nullable(),
});

/**
 * ยกเลิกเอกสาร — striking one out.
 *
 * ⛔ Not a delete and not an edit: an issued document is frozen by `tax_documents_freeze()`,
 * which compares every other column. A void sets two fields and says why, and the replacement
 * is a new numbered document.
 */
export const voidTaxDocumentSchema: z.ZodType<{ reasonTh: string }> = z.strictObject({
  reasonTh: z.string().trim().min(1, 'ระบุเหตุผลที่ยกเลิก').max(500),
});
