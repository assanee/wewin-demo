import { describe, expect, it } from 'vitest';

import {
  MIN_REASON_LENGTH,
  writeOffAvailability,
  writeOffFormBody,
  type WriteOffFields,
} from './write-off-request';

/**
 * ⭐ ขออนุมัติตัดยอดค้างทิ้ง — the form's decisions, where a test can reach them.
 *
 * `apps/dashboard`'s vitest is `environment: 'node'` and a `.test.tsx` is **silently never
 * collected**, so every one of these lives in the `.ts` beside `write-off-dialog.tsx` rather than in
 * its markup. The dialog is layout and a fetch; this is what it refuses.
 *
 * ⚠️ Whole strings with `toBe`, never `toContain` — the house rule.
 */

const OUTSTANDING = 994_000n; // ฿9,940.00

const fields = (over: Partial<WriteOffFields>): WriteOffFields => ({
  amount: '9940',
  reasonTh: 'ลูกค้าตกลงชำระครึ่งหนึ่งเพื่อยุติเรื่อง',
  ...over,
});

describe('the body a write-off request sends', () => {
  it('turns baht into a bare satang digit string, which is what the wire wants', () => {
    /*
     * ⚠️ `'994000'` and not `994000` — `authority.contract.ts`'s `minorSchema` is a string of digits,
     * because `JSON.parse` on a large integer is where a satang goes missing silently.
     */
    const result = writeOffFormBody(fields({ amount: '9940' }), OUTSTANDING);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.amountThbMinor).toBe('994000');
    expect(result.body.reasonTh).toBe('ลูกค้าตกลงชำระครึ่งหนึ่งเพื่อยุติเรื่อง');
  });

  it('keeps the satang a person typed', () => {
    const result = writeOffFormBody(fields({ amount: '4970.55' }), OUTSTANDING);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.amountThbMinor).toBe('497055');
  });

  it('accepts a PARTIAL write-off — the settlement case, which is the common one', () => {
    const result = writeOffFormBody(fields({ amount: '4970' }), OUTSTANDING);

    expect(result.ok).toBe(true);
  });

  it('accepts exactly the whole balance', () => {
    /*
     * The boundary, in the direction it has to fail. A `>=` here would refuse the
     * customer-will-not-pay-anything case, which is the requirement's central example, and
     * `approvals_write_off_within_balance` refuses only what drives the fold *below* zero.
     */
    const result = writeOffFormBody(fields({ amount: '9940' }), OUTSTANDING);

    expect(result.ok).toBe(true);
  });
});

describe('what the form refuses', () => {
  it('⭐ refuses an amount above the outstanding, and says which figure it is against', () => {
    const result = writeOffFormBody(fields({ amount: '9940.01' }), OUTSTANDING);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problemsTh).toStrictEqual(['ยอดที่ขอตัดทิ้งมากกว่ายอดคงค้างของออเดอร์นี้']);
  });

  it('refuses zero and a negative, which the CHECK would refuse as a 500', () => {
    /*
     * `approvals_concession_positive` is `> 0`. Reaching it means a 23514, which arrives at a client
     * as a `DrizzleQueryError` in a 500 — so this refuses first, in a sentence.
     */
    expect(writeOffFormBody(fields({ amount: '0' }), OUTSTANDING).ok).toBe(false);
    expect(writeOffFormBody(fields({ amount: '-100' }), OUTSTANDING).ok).toBe(false);
  });

  it('⚠️ refuses an empty box and a space, which `Number` would read as zero', () => {
    /*
     * `Number('')` is 0 and `Number(' ')` is 0 — two ways for a field somebody believes is empty to
     * become a debt forgiveness. `readSatang` is why neither happens.
     */
    expect(writeOffFormBody(fields({ amount: '' }), OUTSTANDING).ok).toBe(false);
    expect(writeOffFormBody(fields({ amount: '   ' }), OUTSTANDING).ok).toBe(false);
  });

  it('⚠️ refuses exponent notation, which `Number` would happily widen', () => {
    /* `Number('1e3')` is 1000 — a thousand baht from three characters nobody meant as money. */
    expect(writeOffFormBody(fields({ amount: '1e3' }), OUTSTANDING).ok).toBe(false);
  });

  it('⭐ refuses a reason too short to be an audit trail', () => {
    const result = writeOffFormBody(fields({ reasonTh: 'ไม่จ่าย' }), OUTSTANDING);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problemsTh).toStrictEqual([
      `ต้องระบุเหตุผล อย่างน้อย ${String(MIN_REASON_LENGTH)} ตัวอักษร — เหตุผลนี้จะถูกเก็บไว้ถาวรเพื่อการตรวจสอบย้อนหลัง`,
    ]);
  });

  it('reports every problem at once rather than one per submit', () => {
    const result = writeOffFormBody({ amount: '99999', reasonTh: 'x' }, OUTSTANDING);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problemsTh).toHaveLength(2);
  });

  it('⚠️ does NOT compare against a balance the wire withheld', () => {
    /*
     * `null` is a cart or a cancelled order — the wire states no ค้างชำระ at all. Reading it as ฿0.00
     * here would refuse every write-off on such an order with a sentence about a figure the screen
     * does not have, where the server's refusal ("ยังไม่มีสัญญา จึงยังไม่มียอดคงค้างให้ตัดทิ้ง") is the
     * correct and better-worded one. So the amount check is skipped and the reason check is not.
     */
    const result = writeOffFormBody(fields({ amount: '99999999' }), null);

    expect(result.ok).toBe(true);
  });
});

describe('⭐ whether the money card offers the button at all', () => {
  it('offers it on a live balance, and carries the figure the form is bounded by', () => {
    const availability = writeOffAvailability({
      outstandingThbMinor: OUTSTANDING,
      pendingCashflowApprovalId: null,
    });

    expect(availability).toStrictEqual({ kind: 'available', outstandingThbMinor: OUTSTANDING });
  });

  it('⚠️ hides it when nothing is owed — no disabled button under a ฿0.00 balance', () => {
    /*
     * A greyed control under a settled order invites somebody to work out what is wrong with an order
     * that has nothing wrong with it. `nothingOwed` renders nothing and says nothing.
     */
    expect(
      writeOffAvailability({ outstandingThbMinor: 0n, pendingCashflowApprovalId: null }).kind,
    ).toBe('nothingOwed');
    /* An overpaid order is a modelled state and equally has nothing to forgive. */
    expect(
      writeOffAvailability({ outstandingThbMinor: -150n, pendingCashflowApprovalId: null }).kind,
    ).toBe('nothingOwed');
    /* A cart, or a cancelled order: the wire states no figure. */
    expect(
      writeOffAvailability({ outstandingThbMinor: null, pendingCashflowApprovalId: null }).kind,
    ).toBe('nothingOwed');
  });

  it('⭐ says a request is already waiting rather than offering a button that answers 409', () => {
    /*
     * `approvals_one_open_per_order_dimension` would refuse a second pending cashflow request. This
     * state carries a sentence where `nothingOwed` carries none, because the reader needs to know the
     * ask has been made and is being held up by somebody else.
     */
    const availability = writeOffAvailability({
      outstandingThbMinor: OUTSTANDING,
      pendingCashflowApprovalId: 'a1b2c3d4-0000-4000-8000-000000000001',
    });

    expect(availability).toStrictEqual({
      kind: 'pending',
      approvalId: 'a1b2c3d4-0000-4000-8000-000000000001',
    });
  });

  it('⚠️ the pending request wins over a zero balance, and the order between them matters', () => {
    /*
     * An order whose whole balance a *pending* request covers still owes the money — a pending
     * write-off forgives nothing. But an order that was written off to zero and then had a second
     * question raised on it would report `nothingOwed` if the balance were tested first, hiding the
     * fact that something is waiting for an answer. Pending is checked first for that reason.
     */
    const availability = writeOffAvailability({
      outstandingThbMinor: 0n,
      pendingCashflowApprovalId: 'a1b2c3d4-0000-4000-8000-000000000002',
    });

    expect(availability.kind).toBe('pending');
  });
});
