import { describe, expect, it } from 'vitest';
import { changeRequestWireSchema, encodeThb, type OrderWire } from '@wewin/contract/order';

import { decodeDetail } from '@/components/orders/order-api';

/**
 * The order screen must survive an order that carries an objection.
 *
 * ── The bug this file exists for ────────────────────────────────────────────────
 *
 * `encodeChangeRequest` has always sent **`openedAt`**. This decoder read **`createdAt`**, and
 * `asText` throws on `undefined` — so `decodeDetail` raised
 * `TypeError: changeRequest.createdAt: expected a string` for *every* order with an open change
 * request. `OrderDetail.reload()` caught it and rendered "เปิดออเดอร์นี้ไม่ได้", which means the
 * resolution card never appeared and neither did the transition buttons beside it. The one screen
 * that can answer a customer's objection could not be opened once one existed.
 *
 * Nothing caught it, because nothing had ever decoded a change request: `tests/` held
 * `order-transitions.test.ts` and no test touched this branch, and the API's own suites assert the
 * wire rather than what the dashboard does with it. It is the seam between two packages that each
 * test themselves.
 *
 * ── Why the fixture is typed rather than hand-written ───────────────────────────
 *
 * A fixture written freehand is a third opinion about the wire, and a third opinion is how the
 * first two came to disagree. `WIRE` is annotated `OrderWire` — the API's own response type — so
 * `createdAt` on the change request is a **compile error** rather than a fixture that happily
 * reproduces the bug and a test that passes with it. `pnpm -r run typecheck` is therefore part of
 * this test, which is the only way a field-name mismatch can be caught without a browser.
 *
 * The objection half additionally goes through `changeRequestWireSchema` at runtime, because the
 * type says `openedAt: string` while the schema says it is an ISO datetime, and a decoder handed
 * `'yesterday'` should not be how anybody finds that out.
 */

const CHANGE_REQUEST = changeRequestWireSchema.parse({
  id: '7f000000-0000-4000-8000-00000000c001',
  noteTh: 'ขอเปลี่ยนสีเป็นสีดำครับ',
  openedAt: '2026-08-09T04:05:06.000Z',
  resolution: null,
  resolvedAt: null,
});

/** ⚠️ Annotated, not inferred. The annotation is the assertion — see the header. */
const WIRE: OrderWire = {
  id: '7f000000-0000-4000-8000-00000000a001',
  orderNo: 'WW-2026-000123',
  status: 'awaiting_payment',
  isFrozen: false,
  frozenAt: null,
  submittedAt: '2026-08-08T03:00:00.000Z',
  grandTotalThbMinor: encodeThb(1843200n),
  /*
   * The deposit has been accepted on this one, which is why the two differ: `outstanding` is
   * what is still owed on the contract and `nextDue` is the remainder of the first unsettled
   * instalment. Both are the API's, from `order_outstanding_thb_minor()` and
   * `order_next_due_thb_minor()`; this fixture only has to carry the shape.
   */
  outstandingThbMinor: encodeThb(1290240n),
  nextDueThbMinor: encodeThb(1290240n),
  updatedAt: '2026-08-09T09:09:09.000Z',
  createdAt: '2026-08-08T02:00:00.000Z',
  contact: {
    email: 'somchai@example.invalid',
    name: 'สมชาย',
    phone: '0812345678',
    locale: 'th',
    destinationCountry: null,
  },
  money: {
    netThbMinor: encodeThb(1722617n),
    vatThbMinor: encodeThb(120583n),
    grandTotalThbMinor: encodeThb(1843200n),
    scheduledDepositThbMinor: encodeThb(1843200n),
  },
  documentRevision: 1,
  supersedesOrderId: null,
  supersededByOrderId: null,
  availableTransitions: [
    {
      toStatus: 'cancelled',
      eventType: 'cancelled',
      payloadKind: 'cancel_pre_freeze',
      descriptionTh: 'ยกเลิกก่อนเข้าผลิต — ยังไม่มีอะไรถูกตัด',
    },
  ],
  openChangeRequest: CHANGE_REQUEST,
};

describe('an order carrying a customer objection', () => {
  /**
   * ⭐ The assertion the outage would have failed on: the page decodes at all.
   *
   * Before the fix this threw, and every expectation below it is unreachable — which is why the
   * first thing asserted is that the call returns.
   */
  it('decodes without throwing, and carries the objection through', () => {
    const detail = decodeDetail(WIRE);

    expect(detail.openChangeRequest).not.toBeNull();
    expect(detail.openChangeRequest?.id).toBe(CHANGE_REQUEST.id);
    expect(detail.openChangeRequest?.noteTh).toBe('ขอเปลี่ยนสีเป็นสีดำครับ');
    expect(detail.openChangeRequest?.resolution).toBeNull();
  });

  /**
   * The field the card actually renders — `เปิดเมื่อ {at(...)}`.
   *
   * Compared against the wire's own `openedAt`, and then explicitly against the other two
   * timestamps on the payload, so a decoder that reached for `order.createdAt` or
   * `order.updatedAt` could not pass by picking up a plausible-looking string.
   */
  it("reads the opening time from the wire's openedAt and not another timestamp", () => {
    const detail = decodeDetail(WIRE);

    expect(detail.openChangeRequest?.openedAt).toBe(CHANGE_REQUEST.openedAt);
    expect(detail.openChangeRequest?.openedAt).not.toBe(detail.createdAt);
    expect(detail.openChangeRequest?.openedAt).not.toBe(detail.updatedAt);
  });

  /**
   * A null note is a shape the contract permits, so the decoder may not throw on it.
   *
   * `ChangeRequestWire.noteTh` is `string | null` and `order_change_requests.note_th` is
   * nullable. No route can produce one today — `createChangeRequestSchema` requires the note —
   * but this decoder used `asText` on it, so the day one appears the page stops opening again,
   * for the second time, for the same reason.
   */
  it('accepts the null note the contract allows', () => {
    const withoutNote: OrderWire = {
      ...WIRE,
      openChangeRequest: { ...CHANGE_REQUEST, noteTh: null },
    };

    expect(decodeDetail(withoutNote).openChangeRequest?.noteTh).toBeNull();
  });

  /** No objection is the ordinary case and must stay null rather than becoming an empty object. */
  it('leaves an order with no objection null', () => {
    const plain: OrderWire = { ...WIRE, openChangeRequest: null };

    expect(decodeDetail(plain).openChangeRequest).toBeNull();
  });
});

/**
 * The two figures the ค้างชำระ column and the ยอดเงิน card read.
 *
 * ⭐ Same seam, same class of bug. `openedAt`/`createdAt` was a field name that did not match
 * the wire, and the only reason it reached production is that nothing decoded the branch. These
 * two are decoded by the same file, are `asSatangOrNull` (so a missing key is a silent `null`
 * rather than a throw), and a `null` here renders as "no contract yet" — an order that owes
 * ฿12,902 would quietly read as a cart. The annotated `OrderWire` fixture is what makes a
 * misspelling a compile error; these assert that the right one is picked up at runtime.
 */
describe('what an order still owes', () => {
  it('carries both folds through under the names the wire uses', () => {
    const detail = decodeDetail(WIRE);

    expect(detail.outstandingThbMinor).toBe(1290240n);
    expect(detail.nextDueThbMinor).toBe(1290240n);
  });

  it('does not read one fold for the other on a 30/70', () => {
    /*
     * ⚠️ The fixture above has the two equal, which is the honest shape of a pay-in-full order
     * and is also the one shape that cannot catch a decoder reading `outstandingThbMinor` twice.
     * They differ by the balance the moment a deposit is scheduled, so this is the case that
     * pins each to its own key — and the order detail drops the งวดถัดไปต้องการ row entirely
     * when they are equal, so a swap here is invisible on the screen as well.
     */
    const thirtySeventy: OrderWire = {
      ...WIRE,
      outstandingThbMinor: encodeThb(1843200n),
      nextDueThbMinor: encodeThb(552960n),
    };

    const detail = decodeDetail(thirtySeventy);

    expect(detail.outstandingThbMinor).toBe(1843200n);
    expect(detail.nextDueThbMinor).toBe(552960n);
  });

  it('keeps a cart null on all three money fields rather than zero', () => {
    /*
     * `orders_money_shape` is "three columns or none", and the API nulls the two folds on the
     * same fact as the grand total. ฿0.00 here would read as *settled* on a queue, which is the
     * one thing a cart is not — `order-outstanding.ts` is where that distinction is kept, and it
     * can only keep it if the decoder hands it a null.
     */
    const cart: OrderWire = {
      ...WIRE,
      status: 'draft',
      orderNo: null,
      submittedAt: null,
      grandTotalThbMinor: null,
      outstandingThbMinor: null,
      nextDueThbMinor: null,
      money: null,
      openChangeRequest: null,
    };

    const detail = decodeDetail(cart);

    expect(detail.grandTotalThbMinor).toBeNull();
    expect(detail.outstandingThbMinor).toBeNull();
    expect(detail.nextDueThbMinor).toBeNull();
  });
});
