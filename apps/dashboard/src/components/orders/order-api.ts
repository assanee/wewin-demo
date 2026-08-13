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
  readonly limit?: number | undefined;
}): Promise<readonly OrderSummary[]> => {
  const query = new URLSearchParams();
  if (filter.status !== undefined) query.set('status', filter.status);
  query.set('limit', String(filter.limit ?? 100));

  return apiJson(`/orders?${query.toString()}`, (body) =>
    asArray(asRecord(body, 'รายการออเดอร์')['orders'] ?? [], 'orders').map(decodeSummary),
  );
};

export const getOrder = (orderId: string): Promise<OrderDetail> =>
  apiJson(`/orders/${orderId}`, decodeDetail);

export const listEvents = (orderId: string): Promise<readonly OrderEvent[]> =>
  apiJson(`/orders/${orderId}/events`, (body) =>
    asArray(asRecord(body, 'สันประวัติ')['events'] ?? [], 'events').map(decodeEvent),
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
