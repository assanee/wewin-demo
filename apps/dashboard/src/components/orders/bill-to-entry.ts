import type { OrderBillToWire } from '@wewin/contract/forfeit';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ผู้ซื้อ — what a person typed into the bill-to form, checked before it is sent.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠️ A **mirror** of the contract's own refusals, and it is allowed to be one only because it
 * decides what to say to the person typing, never what is permitted: the API refuses the same
 * things, and `order_bill_to_juristic_has_tax_id` refuses one of them in Postgres for every
 * writer. What this buys is a sentence under the field instead of a red box after a round trip.
 *
 * ⚠️ Thai digits are normalised in the tax id for the reason the deposit box accepts them: a
 * Thai keyboard produces them, and refusing them refuses the person rather than the input.
 */

export type BillToDraft = {
  buyerKind: 'individual' | 'juristic';
  legalName: string;
  taxId: string;
  branchCode: string;
  addressLine: string;
  postalCode: string;
};

export const emptyBillTo = (): BillToDraft => ({
  buyerKind: 'individual',
  legalName: '',
  taxId: '',
  branchCode: '',
  addressLine: '',
  postalCode: '',
});

export const billToDraftOf = (wire: OrderBillToWire): BillToDraft => ({
  buyerKind: wire.buyerKind,
  legalName: wire.legalName,
  taxId: wire.taxId ?? '',
  branchCode: wire.branchCode ?? '',
  addressLine: wire.addressLine,
  postalCode: wire.postalCode ?? '',
});

/** Arabic digits, whatever the keyboard produced. */
export const arabicDigits = (raw: string): string =>
  raw.replace(/[๐-๙]/gu, (digit) => String(digit.charCodeAt(0) - 0x0e50));

export type BillToProblem = { readonly field: keyof BillToDraft; readonly messageTh: string };

/**
 * Every problem at once, in the order the fields appear.
 *
 * ⚠️ All of them, not the first: a form that reports one problem per attempt makes somebody
 * press save four times to learn four things, which is the pattern the products screen was
 * corrected for.
 */
export function billToProblems(draft: BillToDraft): readonly BillToProblem[] {
  const problems: BillToProblem[] = [];

  if (draft.legalName.trim() === '') {
    problems.push({
      field: 'legalName',
      messageTh:
        draft.buyerKind === 'juristic'
          ? 'กรอกชื่อนิติบุคคลตามที่จดทะเบียน'
          : 'กรอกชื่อ-นามสกุลผู้ซื้อ',
    });
  }

  if (draft.addressLine.trim() === '') {
    problems.push({ field: 'addressLine', messageTh: 'กรอกที่อยู่ — ใบกำกับภาษีต้องมีที่อยู่ผู้ซื้อ' });
  }

  const taxId = arabicDigits(draft.taxId).trim();
  if (draft.buyerKind === 'juristic' && taxId === '') {
    problems.push({
      field: 'taxId',
      messageTh: 'ลูกค้านิติบุคคลต้องมีเลขประจำตัวผู้เสียภาษี 13 หลัก',
    });
  } else if (taxId !== '' && !/^\d{13}$/u.test(taxId)) {
    problems.push({ field: 'taxId', messageTh: 'เลขประจำตัวผู้เสียภาษีต้องเป็นตัวเลข 13 หลัก' });
  }

  return problems;
}

/** What goes on the wire: trimmed, digits normalised, blanks as `null`. */
export function billToRequest(draft: BillToDraft): Omit<OrderBillToWire, 'updatedAt'> {
  const blankToNull = (value: string): string | null => {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  };

  return {
    buyerKind: draft.buyerKind,
    legalName: draft.legalName.trim(),
    taxId: blankToNull(arabicDigits(draft.taxId)),
    /*
     * ⚠️ Blank means สำนักงานใหญ่ — the head office — which is what most buyers are, and is a
     * different fact from "nobody typed anything". The wire carries `null` and the document
     * renderer prints สำนักงานใหญ่; storing the Thai word here would put a rendering decision in
     * the database.
     */
    branchCode: blankToNull(draft.branchCode),
    addressLine: draft.addressLine.trim(),
    postalCode: blankToNull(arabicDigits(draft.postalCode)),
    country: 'TH',
  };
}
