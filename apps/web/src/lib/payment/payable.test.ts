import { describe, expect, it } from 'vitest';

import { PAYABLE_ORDER_STATUSES, acceptsPayment, isApproximatePrice } from './payable';

describe('whether the figures on a quotation are final', () => {
  /*
   * ⭐ The owner's "ราคาประมาณ": the customer sees a real total on a real pinned document while
   * staff are still agreeing it, and sees that it is not final.
   */

  it('⭐ calls an unconfirmed quotation approximate', () => {
    expect(isApproximatePrice('awaiting_confirmation')).toBe(true);
  });

  it('⛔ does NOT call a cancelled order approximate, though both are unpayable', () => {
    /*
     * The trap this test exists for: `isApproximatePrice` looks like `!acceptsPayment` and is
     * not. A cancelled order's figures are what was agreed before it ended — calling them a
     * guess would tell a customer the company is unsure what it charged them.
     */
    for (const status of ['cancelled', 'superseded', 'draft']) {
      expect(acceptsPayment(status), `${status} is not payable`).toBe(false);
      expect(isApproximatePrice(status), `${status} is not an estimate`).toBe(false);
    }

    /* ⚠️ `delivered` IS payable — 0046 opened it to slips, so it is not in this contrast. */
    expect(acceptsPayment('delivered')).toBe(true);
  });

  it('⚠️ a payable order is never an estimate — the confirmation is what makes it payable', () => {
    for (const status of PAYABLE_ORDER_STATUSES) {
      expect(isApproximatePrice(status), status).toBe(false);
    }
  });
});
