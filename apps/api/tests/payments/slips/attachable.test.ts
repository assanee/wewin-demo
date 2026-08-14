import { describe, expect, it } from 'vitest';

import { ORDER_STATUSES } from '@wewin/db/schema';

import { isLiveOrder } from '../../../src/orders/live-order';
import { SLIP_ATTACHABLE_STATUSES, acceptsPayment } from '../../../src/payments/slips/attachable';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Which orders can still be paid — and why it is not the same list as "live".
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `slips.pg.test.ts` proves the enforcement half against a real database: the service refuses
 * an upload against a cancelled order with a 409, and `payment_slips_live_orders_only`
 * refuses the row underneath it. `payment-instructions.pg.test.ts` proves the *wire* half:
 * `acceptsPayment` goes false on the same statuses, over real HTTP, on an order with real
 * money on it.
 *
 * What neither can see is the membership over the whole status set — the two they exercise
 * are the two a customer can reach with one request. So it is pinned here, where adding a
 * tenth status without classifying it is a failure rather than a silent default.
 */

describe('acceptsPayment', () => {
  it('answers about every status the schema has, and accepts exactly the five on the list', () => {
    const accepted = ORDER_STATUSES.filter((status) => acceptsPayment(status));

    expect([...accepted]).toStrictEqual([...SLIP_ATTACHABLE_STATUSES]);
  });

  it('refuses a slip against a finished contract', () => {
    /* Money arriving on one of these is a reconciliation exception, not a payment. */
    expect(acceptsPayment('delivered')).toBe(false);
    expect(acceptsPayment('cancelled')).toBe(false);
    expect(acceptsPayment('superseded')).toBe(false);
  });

  it('refuses a cart, which has no document, no number and no total to pay against', () => {
    expect(acceptsPayment('draft')).toBe(false);
  });

  it('accepts the four past `awaiting_payment`, which is the half a naive rule gets wrong', () => {
    /*
     * The deposit's doing: the balance is transferred while the order is already in
     * production, so a rule reading only `awaiting_payment` would close the screen on every
     * customer paying the second instalment.
     */
    expect(acceptsPayment('awaiting_payment')).toBe(true);
    expect(acceptsPayment('production_confirmed')).toBe(true);
    expect(acceptsPayment('in_production')).toBe(true);
    expect(acceptsPayment('awaiting_installation')).toBe(true);
    expect(acceptsPayment('redesign')).toBe(true);
  });
});

describe('⭐ this is not `isLiveOrder`, and `delivered` is where they part', () => {
  /*
   * ⚠️ THE DISTINCTION THE PAYMENT SCREEN'S GATE DEPENDS ON, and the reason the wire field is
   * computed from this list rather than from the encoder's.
   *
   * "Does this order still owe money?" and "can this order still be paid through the
   * storefront?" are different questions, and a delivered job with an unpaid balance answers
   * yes to the first and no to the second: the debt is real — `GET /orders` prints it and the
   * money card chases it — while another slip against it is refused, because collecting it is
   * a phone call and a reconciliation.
   *
   * A single list serving both would have to choose which of those two truths to break.
   */
  it('calls a delivered order live, and closed to payment, at the same time', () => {
    expect(isLiveOrder('delivered')).toBe(true);
    expect(acceptsPayment('delivered')).toBe(false);
  });

  it('agrees with `isLiveOrder` about every other status', () => {
    const disagreements = ORDER_STATUSES.filter(
      (status) => isLiveOrder(status) !== acceptsPayment(status),
    );

    expect([...disagreements]).toStrictEqual(['delivered']);
  });
});
