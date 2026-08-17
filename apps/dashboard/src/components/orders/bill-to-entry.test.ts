import { describe, expect, it } from 'vitest';

import {
  arabicDigits,
  billToProblems,
  billToRequest,
  emptyBillTo,
  type BillToDraft,
} from './bill-to-entry';

/**
 * ผู้ซื้อ — the form that fills the block a tax document cannot omit.
 *
 * The rule worth pinning hardest is the one the database also holds: a company buyer without a
 * tax id cannot be issued a full tax invoice, so the form must say so before the round trip
 * rather than relay a CHECK violation afterwards.
 */

const draft = (over: Partial<BillToDraft> = {}): BillToDraft => ({
  ...emptyBillTo(),
  legalName: 'สมชาย ใจดี',
  addressLine: '99/1 หมู่ 4 จังหวัดพิษณุโลก',
  ...over,
});

describe('what the bill-to form refuses', () => {
  it('⭐ accepts an individual with a name and an address and nothing else', () => {
    expect(billToProblems(draft())).toStrictEqual([]);
  });

  it('⛔ refuses a company with no tax id — the same rule the database holds', () => {
    const problems = billToProblems(draft({ buyerKind: 'juristic' }));

    expect(problems).toHaveLength(1);
    expect(problems[0]?.field).toBe('taxId');
    expect(problems[0]?.messageTh).toContain('13 หลัก');
  });

  it('⛔ refuses a tax id that is not thirteen digits, even for an individual who typed one', () => {
    /* An individual need not give one — but a wrong one is worse than none on a document. */
    expect(billToProblems(draft({ taxId: '123' }))[0]?.field).toBe('taxId');
    expect(billToProblems(draft({ taxId: '12345678901234' }))[0]?.field).toBe('taxId');
  });

  it('⚠️ reports every problem at once, not the first', () => {
    /*
     * A form that reports one problem per attempt makes somebody press save three times to
     * learn three things — the pattern the products screen was corrected for.
     */
    const problems = billToProblems({
      ...emptyBillTo(),
      buyerKind: 'juristic',
      legalName: '',
      addressLine: '',
      taxId: '',
    });

    expect(problems.map((problem) => problem.field)).toStrictEqual([
      'legalName',
      'addressLine',
      'taxId',
    ]);
  });

  it('⚠️ names the buyer the way the person on the screen would', () => {
    /* "ชื่อนิติบุคคลตามที่จดทะเบียน" and "ชื่อ-นามสกุล" are not the same request. */
    expect(billToProblems(draft({ legalName: '' }))[0]?.messageTh).toContain('ชื่อ-นามสกุล');
    expect(
      billToProblems(draft({ legalName: '', buyerKind: 'juristic', taxId: '1234567890123' }))[0]
        ?.messageTh,
    ).toContain('นิติบุคคล');
  });
});

describe('what goes on the wire', () => {
  it('⭐ trims, and turns a blank into null rather than an empty string', () => {
    const request = billToRequest(
      draft({ legalName: '  สมชาย  ', branchCode: '   ', postalCode: '' }),
    );

    expect(request.legalName).toBe('สมชาย');
    expect(request.branchCode).toBeNull();
    expect(request.postalCode).toBeNull();
  });

  it('⭐ normalises Thai digits, because a Thai keyboard produces them', () => {
    expect(arabicDigits('๑๒๓๔๕๖๗๘๙๐๑๒๓')).toBe('1234567890123');
    expect(billToRequest(draft({ taxId: '๑๒๓๔๕๖๗๘๙๐๑๒๓' })).taxId).toBe('1234567890123');
    expect(billToRequest(draft({ postalCode: '๖๕๐๐๐' })).postalCode).toBe('65000');
  });

  it('⚠️ a blank branch code is null, which the renderer prints as สำนักงานใหญ่', () => {
    /*
     * Blank means head office — a real fact, and a different one from "nobody typed anything".
     * Storing the Thai word here would put a rendering decision in the database.
     */
    expect(billToRequest(draft()).branchCode).toBeNull();
    expect(billToRequest(draft({ branchCode: '00012' })).branchCode).toBe('00012');
  });
});
