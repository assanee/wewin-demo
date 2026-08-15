import 'client-only';

import { apiFetch, apiJson } from '@/lib/api/client';
import { apiErrorFromResponse } from '@/lib/api/errors';
import type { OrderStatus, PayloadKind } from './order-language';

/**
 * Every call the order screens make.
 *
 * ⚠️ Shapes restated from `packages/contract/src/order.ts`. See `order-language.ts` for why,
 * and `tests/order-transitions.test.ts` for what keeps the restatement honest.
 *
 * ── What is deliberately not here ────────────────────────────────────────────
 *
 * `POST /orders`, `POST /orders/:id/payment-slips` and the whole `/quote/*` family. The
 * first two are the customer's, and the quote editor already has its own screen and its own
 * client — a second copy of `POST /orders/:id/quote/lines` here would be two clients for one
 * endpoint, which is how two screens end up disagreeing about what a line looks like.
 */

export interface Money {
  /** Satang. Read through `formatBaht`, never divided by hand. */
  readonly minor: bigint;
}

export interface OrderSummary {
  readonly id: string;
  /** Null until submit — a cart is not numbered. */
  readonly orderNo: string | null;
  readonly status: OrderStatus;
  /**
   * Whether aluminium has been committed.
   *
   * ⚠️ Read this, never the status. `cancelled` and `superseded` are reachable from both
   * sides of the freeze, so after the fact the status cannot answer "was anything already
   * cut?" and this flag can. The list renders it as its own column for that reason.
   */
  readonly isFrozen: boolean;
  readonly frozenAt: string | null;
  readonly submittedAt: string | null;
  readonly grandTotalThbMinor: bigint | null;
  /**
   * What is still owed on this order — `order_outstanding_thb_minor()`, read as a column on
   * the same select that fetched the row. A list of fifty orders is still one query.
   *
   * ⚠️ **Null on exactly the same fact as `grandTotalThbMinor`: there is no contract yet.**
   * Never on its own, and never meaning zero. The fold itself answers ฿0.00 for a cart, which
   * is arithmetically right and reads on a queue as *settled* — so the API nulls all three
   * money fields together and `order-outstanding.ts` keeps the two apart the rest of the way
   * to the cell.
   *
   * ⛔ Never derived here. Not `grandTotal` minus anything, not a fold of the instalments —
   * `packages/contract/src/schedule.ts` refuses to ship a total beside the parts precisely so
   * that no client is tempted, and this field is the database's own answer travelling intact.
   */
  readonly outstandingThbMinor: bigint | null;
  /**
   * What to pay *now* — `order_next_due_thb_minor()`, the remainder of the first instalment no
   * accepted slip has settled.
   *
   * Equal to `outstandingThbMinor` on a pay-in-full order and smaller by the balance on a
   * 30/70, which is why both are sent: neither is derivable from the other. **฿0.00 rather
   * than null when an order is settled in full** — null is reserved for "no contract yet".
   */
  readonly nextDueThbMinor: bigint | null;
  /**
   * ⭐ How much of this balance the company has **forgiven** — `order_written_off_thb_minor()`
   * (0048), the sum of approved ขออนุมัติตัดยอดค้างทิ้ง on this order.
   *
   * ⛔ `outstandingThbMinor` is already net of this; Postgres subtracts it. Nothing here does.
   *
   * It travels beside the outstanding because it is the only thing that tells the two ฿0.00s apart:
   * the customer paid, or the company gave up. `order-outstanding.ts` reads it to keep
   * `ชำระครบแล้ว` off a written-off row, and the money card names the figure.
   *
   * ⚠️ Null on exactly the same fact as the two fields above — no contract, or a cancelled order
   * that states no money at all. ฿0.00 is the real answer *nothing was forgiven*.
   */
  readonly writtenOffThbMinor: bigint | null;
  /**
   * ⭐ What the company is still holding — stated only on a `cancelled` order.
   *
   * ⚠️ Decoded tolerantly, unlike `writtenOffThbMinor` above, and the asymmetry is the point.
   * An absent write-off figure makes the screen *assert* ชำระครบแล้ว at somebody who never
   * paid. An absent held figure can only make the ขอคืนเงิน button not appear — a smaller
   * answer, never a false one — so it degrades to null rather than failing the whole order.
   */
  readonly heldThbMinor: bigint | null;
  readonly updatedAt: string;
}

export interface AvailableTransition {
  readonly toStatus: OrderStatus;
  readonly eventType: string;
  readonly payloadKind: PayloadKind;
  readonly descriptionTh: string;
}

/**
 * A customer's objection, as this screen reads it.
 *
 * ⚠️ `openedAt`, spelled the way the wire spells it. It was `createdAt` here against an API that
 * has always sent `openedAt` (`encodeChangeRequest`), and because `asText` throws on `undefined`
 * the whole of `decodeDetail` raised `TypeError: changeRequest.createdAt: expected a string` for
 * every order carrying an open objection — which `OrderDetail.reload()` caught and rendered as
 * "เปิดออเดอร์นี้ไม่ได้". The resolution card was therefore unreachable, and so were the transition
 * buttons on the same page: one field name made the objection loop impossible to close from the
 * only screen that can close it. The names match now so the next reader cannot repeat it.
 *
 * `noteTh` is nullable because the column is and the wire says so. Nothing the API accepts today
 * can produce a null one — `createChangeRequestSchema` requires the note — but a decoder that
 * throws on a shape the contract permits is the same bug one release later.
 */
export interface ChangeRequest {
  readonly id: string;
  readonly noteTh: string | null;
  readonly resolution: string | null;
  readonly openedAt: string;
}

export interface OrderDetail extends OrderSummary {
  readonly createdAt: string;
  readonly contact: {
    readonly name: string | null;
    readonly email: string | null;
    readonly phone: string | null;
  };
  readonly money: {
    readonly netThbMinor: bigint;
    readonly vatThbMinor: bigint;
    readonly grandTotalThbMinor: bigint;
    readonly scheduledDepositThbMinor: bigint;
  } | null;
  readonly documentRevision: number | null;
  readonly supersedesOrderId: string | null;
  readonly supersededByOrderId: string | null;
  /**
   * ⭐ From `order_status_transitions`, not from a map in this app.
   *
   * "A dashboard that hides a button is being tidy; the transition table is what makes it
   * authorisation." The screen renders one button per entry and has no opinion about which
   * moves are legal — which is the only honest way to render `redesign`, whose outgoing
   * edges depend on data no client holds.
   */
  readonly availableTransitions: readonly AvailableTransition[];
  readonly openChangeRequest: ChangeRequest | null;
}

export interface OrderEvent {
  readonly id: string;
  readonly seq: number;
  readonly eventType: string;
  readonly fromStatus: OrderStatus | null;
  readonly toStatus: OrderStatus | null;
  readonly actorKind: 'customer' | 'guest' | 'staff' | 'system';
  readonly actorUserId: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
  /**
   * Which transaction wrote this row — `order_events.write_txid`, staff only.
   *
   * ⚠️ Nullable **on the wire**, not merely optional here: `encodeEvent` sends `null` to a
   * customer audience, so a decoder that required a string would throw on a response the
   * contract permits. This screen only ever holds `orders.read`, so in practice it is present —
   * but the whole `openChangeRequest`/`openedAt` scar on this file was a decoder refusing a
   * legal shape, and that is not worth repeating for the sake of a non-null type.
   *
   * Two adjacent events sharing it were **one atomic act**. Nothing else on the row can say so:
   * `created_at` defaults to `now()`, which is the transaction's *start* time.
   */
  readonly writeTxid: string | null;
  readonly createdAt: string;
}

const asRecord = (value: unknown, what: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${what}: expected an object`);
  }
  return value as Record<string, unknown>;
};

const asArray = (value: unknown, what: string): readonly unknown[] => {
  if (!Array.isArray(value)) throw new TypeError(`${what}: expected an array`);
  return value;
};

const asText = (value: unknown, what: string): string => {
  if (typeof value !== 'string') throw new TypeError(`${what}: expected a string`);
  return value;
};

const asTextOrNull = (value: unknown, what: string): string | null =>
  value === null || value === undefined ? null : asText(value, what);

/**
 * A `MoneyWire` off the wire.
 *
 * The unit is checked rather than assumed. `MoneyWire` and `MoneyRateWire` differ only by
 * their tag — `THB.satang` against `THB.satang/m2` — and the whole reason the contract
 * package makes them opaque is that a rate rendered as a total is a number nobody catches
 * by looking.
 */
const asSatang = (value: unknown, what: string): bigint => {
  const money = asRecord(value, what);
  if (money['unit'] !== 'THB.satang') {
    throw new TypeError(`${what}: expected THB.satang, got ${JSON.stringify(money['unit'])}`);
  }
  return BigInt(asText(money['digits'], `${what}.digits`));
};

const asSatangOrNull = (value: unknown, what: string): bigint | null =>
  value === null || value === undefined ? null : asSatang(value, what);

/**
 * ⭐ A money field the wire must **state**, as a figure or as an explicit `null`.
 *
 * The same three-line function as `asSatangOrNull` with one difference: an *absent* key is a
 * `TypeError` rather than a null. `null` still decodes as null, because the contract really does
 * send one (`OrderSummaryWire` nulls every money figure on a cart and on a cancelled order).
 *
 * ── ⚠️ Why one field is held to this and the other three are not ─────────────────
 *
 * This file's bargain is leniency about *which* fields an older API sends. That bargain is only
 * payable while an absent field degrades to a **quieter** screen: a missing `grandTotalThbMinor`
 * or `outstandingThbMinor` becomes `noFigure`, which renders as a dash, and a missing
 * `nextDueThbMinor` degrades to the whole outstanding, which can only overstate what is due.
 * None of them makes the screen *assert* something false.
 *
 * `writtenOffThbMinor` does. Read as "nothing was forgiven", an absent figure sends a
 * written-off order down `readOutstanding`'s settled branch and prints **ชำระครบแล้ว** at the one
 * reader who knows the customer never paid — the exact sentence 0048 exists to stop saying. So
 * for this field, and only this field, silence is not a smaller answer; it is the wrong answer.
 * Failing the decode is loud and recoverable ("เปิดออเดอร์นี้ไม่ได้" plus a retry); the sentence
 * is neither.
 *
 * ⚠️ `apps/web/src/lib/payment/api.ts` made the same call on the same field for the same reason
 * (`satang(body['writtenOffThbMinor'])` with a hard `return null` beside it) — the two halves of
 * this round now agree. The shapes differ only where the contracts differ:
 * `PaymentInstructionsWire.writtenOffThbMinor` is non-nullable, so over there *any* absence of a
 * figure fails; here the contract permits an explicit null, so absence of the **key** is what
 * fails. Same rule, stated against two different wires.
 */
const asStatedSatangOrNull = (value: unknown, what: string): bigint | null => {
  if (value === undefined) {
    throw new TypeError(`${what}: expected THB.satang or null, and the field was absent`);
  }
  return asSatangOrNull(value, what);
};

const decodeSummary = (raw: unknown): OrderSummary => {
  const order = asRecord(raw, 'ออเดอร์');

  return {
    id: asText(order['id'], 'order.id'),
    orderNo: asTextOrNull(order['orderNo'], 'order.orderNo'),
    status: asText(order['status'], 'order.status') as OrderStatus,
    isFrozen: order['isFrozen'] === true,
    frozenAt: asTextOrNull(order['frozenAt'], 'order.frozenAt'),
    submittedAt: asTextOrNull(order['submittedAt'], 'order.submittedAt'),
    grandTotalThbMinor: asSatangOrNull(order['grandTotalThbMinor'], 'order.grandTotalThbMinor'),
    /*
     * `asSatangOrNull`, the same leniency `grandTotalThbMinor` above already has: an absent key
     * decodes as null rather than throwing. That is deliberate and it is the file's existing
     * bargain — lenient about *which* fields an older API sends, strict about what is in the
     * ones that arrive — so a `MoneyRateWire` in this slot is still a `TypeError` naming the
     * field, which is the mistake that has actually shipped here.
     */
    outstandingThbMinor: asSatangOrNull(order['outstandingThbMinor'], 'order.outstandingThbMinor'),
    nextDueThbMinor: asSatangOrNull(order['nextDueThbMinor'], 'order.nextDueThbMinor'),
    /*
     * ⭐ `asStatedSatangOrNull` and NOT the lenient reader the three fields above use — see that
     * function for the whole argument. An API a version behind sends no such key, and reading the
     * silence as ฿0.00 forgiven is how "ชำระครบแล้ว" gets printed on a written-off order.
     */
    writtenOffThbMinor: asStatedSatangOrNull(
      order['writtenOffThbMinor'],
      'order.writtenOffThbMinor',
    ),
    heldThbMinor: asSatangOrNull(order['heldThbMinor'], 'order.heldThbMinor'),
    updatedAt: asText(order['updatedAt'], 'order.updatedAt'),
  };
};

/**
 * Exported for `tests/change-request-decode.test.ts` and for nothing else.
 *
 * The one bug this decoder has actually shipped was a field name that did not match the wire,
 * and the only way to catch that class without a browser is to hand the function a payload the
 * contract has validated. Reaching it through `getOrder` would need a stubbed session and a
 * stubbed fetch to test a pure function.
 */
export const decodeDetail = (raw: unknown): OrderDetail => {
  const order = asRecord(raw, 'ออเดอร์');
  const contact = asRecord(order['contact'] ?? {}, 'order.contact');
  const money = order['money'] === null || order['money'] === undefined ? null : asRecord(order['money'], 'order.money');
  const change = order['openChangeRequest'];

  return {
    ...decodeSummary(raw),
    createdAt: asText(order['createdAt'], 'order.createdAt'),
    contact: {
      name: asTextOrNull(contact['name'], 'contact.name'),
      email: asTextOrNull(contact['email'], 'contact.email'),
      phone: asTextOrNull(contact['phone'], 'contact.phone'),
    },
    money:
      money === null
        ? null
        : {
            netThbMinor: asSatang(money['netThbMinor'], 'money.netThbMinor'),
            vatThbMinor: asSatang(money['vatThbMinor'], 'money.vatThbMinor'),
            grandTotalThbMinor: asSatang(money['grandTotalThbMinor'], 'money.grandTotalThbMinor'),
            scheduledDepositThbMinor: asSatang(
              money['scheduledDepositThbMinor'],
              'money.scheduledDepositThbMinor',
            ),
          },
    documentRevision:
      typeof order['documentRevision'] === 'number' ? order['documentRevision'] : null,
    supersedesOrderId: asTextOrNull(order['supersedesOrderId'], 'order.supersedesOrderId'),
    supersededByOrderId: asTextOrNull(order['supersededByOrderId'], 'order.supersededByOrderId'),
    availableTransitions: asArray(
      order['availableTransitions'] ?? [],
      'order.availableTransitions',
    ).map((entry) => {
      const transition = asRecord(entry, 'transition');
      return {
        toStatus: asText(transition['toStatus'], 'transition.toStatus') as OrderStatus,
        eventType: asText(transition['eventType'], 'transition.eventType'),
        payloadKind: asText(transition['payloadKind'], 'transition.payloadKind') as PayloadKind,
        descriptionTh: asText(transition['descriptionTh'], 'transition.descriptionTh'),
      };
    }),
    openChangeRequest:
      change === null || change === undefined
        ? null
        : (() => {
            const request = asRecord(change, 'changeRequest');
            return {
              id: asText(request['id'], 'changeRequest.id'),
              noteTh: asTextOrNull(request['noteTh'], 'changeRequest.noteTh'),
              resolution: asTextOrNull(request['resolution'], 'changeRequest.resolution'),
              openedAt: asText(request['openedAt'], 'changeRequest.openedAt'),
            };
          })(),
  };
};

const decodeEvent = (raw: unknown): OrderEvent => {
  const event = asRecord(raw, 'เหตุการณ์');

  return {
    id: asText(event['id'], 'event.id'),
    seq: typeof event['seq'] === 'number' ? event['seq'] : 0,
    eventType: asText(event['eventType'], 'event.eventType'),
    fromStatus: asTextOrNull(event['fromStatus'], 'event.fromStatus') as OrderStatus | null,
    toStatus: asTextOrNull(event['toStatus'], 'event.toStatus') as OrderStatus | null,
    actorKind: asText(event['actorKind'], 'event.actorKind') as OrderEvent['actorKind'],
    actorUserId: asTextOrNull(event['actorUserId'], 'event.actorUserId'),
    payload:
      event['payload'] === null || event['payload'] === undefined
        ? {}
        : asRecord(event['payload'], 'event.payload'),
    writeTxid: asTextOrNull(event['writeTxid'], 'event.writeTxid'),
    createdAt: asText(event['createdAt'], 'event.createdAt'),
  };
};

/**
 * The list.
 *
 * ⚠️ `limit` is the API's, and it caps. `listQuerySchema` bounds it, so a company with more
 * orders than the cap sees a page and not everything — the overview's count does not page,
 * which is why the two can differ and why the screen says how many it is showing.
 */
export const listOrders = (filter: {
  readonly status?: OrderStatus | undefined;
  /**
   * `'outstanding'` asks only for the orders that still owe money — a different axis from
   * `status`, and ANDed with it by the server rather than folded into it.
   *
   * ⚠️ Absent, not `'all'`, when the caller does not care: `?payment=all` is the API's default
   * and sending it would put a term in every URL that means "no restriction". The API's own
   * reasoning for why owing is not a ninth `status` value is in `orders.controller.ts`.
   */
  readonly payment?: 'outstanding' | undefined;
  readonly limit?: number | undefined;
}): Promise<readonly OrderSummary[]> => {
  const query = new URLSearchParams();
  if (filter.status !== undefined) query.set('status', filter.status);
  if (filter.payment !== undefined) query.set('payment', filter.payment);
  query.set('limit', String(filter.limit ?? 100));

  return apiJson(`/orders?${query.toString()}`, (body) =>
    asArray(asRecord(body, 'รายการออเดอร์')['orders'] ?? [], 'orders').map(decodeSummary),
  );
};

export const getOrder = (orderId: string): Promise<OrderDetail> =>
  apiJson(`/orders/${orderId}`, decodeDetail);

export const listEvents = (orderId: string): Promise<readonly OrderEvent[]> =>
  apiJson(`/orders/${orderId}/events`, (body) =>
    asArray(asRecord(body, 'ลำดับเหตุการณ์')['events'] ?? [], 'events').map(decodeEvent),
  );

/**
 * Move an order.
 *
 * The body comes from `transitionForm(payloadKind).body(values)` — this function does not
 * decide what goes in it. Keeping the two apart is what let the body composition be tested
 * without a network, and it is why `cancel`'s two shapes are a table entry rather than an
 * `if` buried in a submit handler.
 */
export const transition = async (
  orderId: string,
  toStatus: OrderStatus,
  body: Record<string, unknown>,
): Promise<OrderDetail> => {
  const response = await apiFetch(`/orders/${orderId}/transitions/${toStatus}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) throw await apiErrorFromResponse(response);
  return decodeDetail(await response.json());
};

/** Accept, reject or withdraw a customer's change request. */
export const resolveChangeRequest = async (
  orderId: string,
  changeRequestId: string,
  resolution: 'accepted' | 'rejected' | 'withdrawn',
  noteTh: string,
): Promise<void> => {
  const trimmed = noteTh.trim();
  const response = await apiFetch(
    `/orders/${orderId}/change-requests/${changeRequestId}/resolution`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resolution, ...(trimmed === '' ? {} : { noteTh: trimmed }) }),
    },
  );

  if (!response.ok) throw await apiErrorFromResponse(response);
};

/**
 * ⭐ ขออนุมัติตัดยอดค้างทิ้ง — ask for part or all of this order's balance to be forgiven.
 *
 * `POST /orders/:orderId/write-offs`, behind `orders.write` + `payments.read`. The route is under
 * `/orders` and not under `/quotes/approvals` because a collection-time write-off is not a
 * concession on a quotation — the quote was right and the customer agreed to it. See
 * `apps/api/src/quotes/authority/write-offs.controller.ts`.
 *
 * ⚠️ **Nothing is forgiven by this call.** It records a request; the balance moves when somebody
 * holding `quotes.approve` + `payments.write_off` approves it in the approval inbox. The dialog says
 * so above its own fields, for the reason `record-payment-dialog.tsx` gives about its own button: a
 * control beside a debt that does not change the debt is a control somebody presses twice.
 *
 * ⚠️ The response is an `approvals` row and is deliberately not decoded into a type here. The screen
 * needs nothing from it but the fact that it was created — the request then appears through
 * `GET /quotes/approvals?orderId=`, which is the one reader of that shape.
 */
/**
 * ⭐ แจ้งเตือนยอดค้างชำระ — what the API answers when the ask is recorded.
 *
 * ⚠️ `queued` is **not** `sent`, and the field is named for what it is. The row goes into the
 * outbox in the transaction that wrote the spine event; the worker polls, renders and talks to
 * an SMTP server afterwards. `/admin/notifications` is where delivery is visible.
 *
 * `suppressedReason` is the database's own machine word (`no_contact_channel`,
 * `recipient_erased`) and is decoded as a bare string on purpose: a migration may add a reason
 * without this bundle being rebuilt, and a decoder that refused an unknown one would turn a more
 * informative server into a broken screen. `balance-reminder.ts` maps the known ones to Thai and
 * prints the rest verbatim.
 */
export interface BalanceReminderResult {
  readonly eventId: string;
  readonly outstandingThbMinor: bigint;
  readonly queued: number;
  readonly suppressedReason: string | null;
}

/**
 * ⭐ Ask the customer for the outstanding balance.
 *
 * `POST /orders/:orderId/balance-reminders`, behind `orders.read` + `orders.write` +
 * `payments.read`. No body: the amount is the server's (`order_outstanding_thb_minor()`), the
 * recipient is the order's, the language is the recipient's and the wording is
 * `notification_rules`'. A body would be a place for one of those four to be overridden by a
 * client.
 *
 * ⚠️ **Nothing here sends anything.** The call appends one row to `order_events`; the fan-out
 * trigger turns that into an outbox row in the same transaction. That is why the response is
 * decoded at all — `queued` and `suppressedReason` are the only way this screen can tell a
 * message that is on its way from one the fan-out had nowhere to send.
 */
export const sendBalanceReminder = async (orderId: string): Promise<BalanceReminderResult> => {
  const response = await apiFetch(`/orders/${orderId}/balance-reminders`, { method: 'POST' });
  if (!response.ok) throw await apiErrorFromResponse(response);

  const body = asRecord(await response.json(), 'การแจ้งเตือนยอดค้างชำระ');

  return {
    eventId: asText(body['eventId'], 'reminder.eventId'),
    /*
     * ⛔ `asSatang` and not a bare number: the unit tag is checked, for the reason that function
     * gives — a `MoneyRateWire` in this slot is a hundredfold error nobody catches by looking.
     */
    outstandingThbMinor: asSatang(body['outstandingThbMinor'], 'reminder.outstandingThbMinor'),
    /*
     * ⚠️ Absent decodes as 0, which is the *fail-closed* direction here and the opposite call
     * from `writtenOffThbMinor` above. Reading a missing `queued` as "something was sent" would
     * make this screen claim a delivery on the word of an API that said nothing; reading it as
     * "nothing was sent" costs a cautious sentence about a message that may well be on its way.
     */
    queued: typeof body['queued'] === 'number' ? body['queued'] : 0,
    suppressedReason: asTextOrNull(body['suppressedReason'], 'reminder.suppressedReason'),
  };
};

export const requestWriteOff = async (
  orderId: string,
  body: { readonly amountThbMinor: string; readonly reasonTh: string },
): Promise<void> => {
  const response = await apiFetch(`/orders/${orderId}/write-offs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) throw await apiErrorFromResponse(response);
};
