import { describe, expect, it } from 'vitest';

import { ORDER_STATUSES } from '@wewin/db/schema';

import { isLiveOrder, NON_LIVE_ORDER_STATUSES } from '../../../src/orders/live-order';
import { SLIP_ATTACHABLE_STATUSES, acceptsPayment } from '../../../src/payments/slips/attachable';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Which orders can still be paid — and the day it became the same list as "live".
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `slips.pg.test.ts` proves the enforcement half against a real database: the service refuses
 * an upload against a cancelled order with a 409, and `payment_slips_live_orders_only`
 * refuses the row underneath it. `attachable-drift.pg.test.ts` proves this list is still the
 * trigger's mirror, by reading the trigger out of the live catalogue rather than out of a
 * migration file. `payment-instructions.pg.test.ts` proves the *wire* half over real HTTP.
 *
 * What none of them can see is the membership over the whole status set — the ones they
 * exercise are the ones a customer can reach with one request. So it is pinned here, where
 * adding a tenth status without classifying it is a failure rather than a silent default.
 */

describe('acceptsPayment', () => {
  it('answers about every status the schema has, and accepts exactly the six on the list', () => {
    const accepted = ORDER_STATUSES.filter((status) => acceptsPayment(status));

    expect([...accepted]).toStrictEqual([...SLIP_ATTACHABLE_STATUSES]);
  });

  it('refuses a slip against a dead contract', () => {
    /*
     * ⚠️ THE GUARD THAT MUST NOT BE WEAKENED BY OPENING `delivered`.
     *
     * Money arriving on one of these is a reconciliation exception, not a payment — 0011's
     * words, and still right about these two. A cancelled order's residue is a *refund*
     * question and may be owed the other way; a superseded order's was carried to the order
     * that replaced it and is already counted there.
     */
    expect(acceptsPayment('cancelled')).toBe(false);
    expect(acceptsPayment('superseded')).toBe(false);
  });

  it('⭐ accepts a slip against a delivered order, which is a contract FULFILLED', () => {
    /*
     * ⚠️ THE OWNER'S DEFECT: *"ถ้าส่งมอบไปก่อนเก็บครบ จะเก็บผ่านระบบไม่ได้อีก"* — deliver before
     * collecting in full and the money could never be taken through the software again.
     * `delivered` has no outgoing transition, so the status could not be walked back to one
     * that accepted a slip; the balance was stranded, visible on the customer's own payment
     * screen and on the staff money card, and collectable by neither.
     *
     * The customer received the goods. If the balance was not collected on the day, they owe
     * it — an ordinary payment arriving late, with no direction to be uncertain about. That is
     * what separates it from the two above, and `0046_slips_after_delivery.sql` carries the
     * argument at length against 0011's comment, which grouped all three under "finished".
     */
    expect(acceptsPayment('delivered')).toBe(true);
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

describe('⭐ this IS `isLiveOrder` now, and `delivered` is where they used to part', () => {
  /*
   * ⚠️ THE ASSERTION THE WIRE'S SIMPLIFICATION RESTS ON.
   *
   * "Does this order still owe money?" and "can this order still be paid through the
   * storefront?" were different questions, and a delivered job with an unpaid balance answered
   * yes to the first and no to the second: the debt was real — `GET /orders` printed it and the
   * money card chased it — while another slip against it was refused. The gap was not a
   * distinction worth carrying; it was the defect, and `0046_slips_after_delivery.sql` closed
   * it.
   *
   * `PaymentInstructionsWire` used to carry both answers as two booleans. It now carries
   * `orderIsLive` alone, and *this* test is what makes that safe: if the two lists ever part
   * again, this fails and names the status that parted them, rather than a screen quietly
   * offering a form the upload route would refuse.
   *
   * ⚠️ Enumerated over `ORDER_STATUSES`, deliberately, and not written as a comparison of the
   * two arrays. The lists are ordered differently and one is expressed as its complement, so
   * comparing them by eye — or by `toStrictEqual` — proves a spelling rather than a predicate.
   * A tenth status added to the schema and classified in only one of the two files fails here.
   */
  it('agrees with `isLiveOrder` about every status the schema has', () => {
    const disagreements = ORDER_STATUSES.filter(
      (status) => isLiveOrder(status) !== acceptsPayment(status),
    );

    expect([...disagreements]).toStrictEqual([]);
  });

  it('calls a delivered order live AND open to payment — the two that used to disagree', () => {
    expect(isLiveOrder('delivered')).toBe(true);
    expect(acceptsPayment('delivered')).toBe(true);
  });

  it('still refuses both, on the statuses where the answer is genuinely no', () => {
    /*
     * The other direction of the same equality, spelled out on the statuses that matter: an
     * accidental widening that made everything payable would satisfy the enumeration above
     * only by also making everything live, which this refuses.
     */
    for (const status of NON_LIVE_ORDER_STATUSES) {
      expect(isLiveOrder(status), status).toBe(false);
      expect(acceptsPayment(status), status).toBe(false);
    }
  });
});
