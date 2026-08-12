import { reviewsApiBaseUrl } from '../reviews/api';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The two things a customer may do to their own order.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `order_status_transitions` grants `customer` and `guest` the authority on seven moves. Six of
 * them are cancellations and until now **nothing in this application posted any of them** — a
 * customer who changed their mind had to telephone somebody. The seventh is the submit, which
 * `lib/quote/submit.ts` has always posted. `POST /orders/:id/change-requests` had no caller
 * either, while the dashboard shipped a screen for staff to *resolve* objections that could
 * therefore never arrive.
 *
 * So there are two doors here, and the order they are offered in is a decision:
 *
 *   **objecting** blocks the order from entering `production_confirmed` until somebody answers
 *   it, costs nothing, and can be withdrawn. It is the customer's lever for "this is wrong".
 *
 *   **cancelling** is terminal and may keep money. It is the answer to "I no longer want this".
 *
 * A screen that offered only the second would be telling somebody with a fixable complaint that
 * their options are to accept it or to forfeit a deposit. The objection comes first on the page
 * for that reason, not for visual balance.
 *
 * ── 🔒 Why there is no `fault` anywhere in this file ─────────────────────────────
 *
 * `fault` decides how much money is kept, so a customer who could set it would be setting their
 * own refund. It is derived on the server from the actor and from the append-only spine
 * (`faultFor`), and `CancelOrderRequestWire` has **no field** through which a claim could be
 * made — `attributeFaultToCompany` exists only on the staff shape. A customer-initiated
 * cancellation is therefore always `fault = 'customer'`, by construction rather than by
 * agreement, and the body this file sends is `{ reason }` and nothing else.
 *
 * That also settles what a post-freeze customer cancellation *is*. The transitions table grants
 * the customer that move on all four post-freeze statuses, so it is an **act, not a request** —
 * turning it into a request would be this client overruling the table that decides
 * authorisation, which is the one thing `availableTransitions` exists to prevent. What the
 * customer needs before making it is not a fault selector; it is the figure.
 *
 * ── ⚠️ The figure comes from the server, always ─────────────────────────────────
 *
 * `GET /orders/:id/cancellation-preview`. The forfeit is
 * `least(held, pinned deposit) × forfeit_bp` clamped to money held, and two of those three
 * inputs are not on any wire — `held` is a fold of ledger postings and `forfeit_bp` comes from
 * the policy the order pinned *at submit*, not from today's table. There is no arithmetic this
 * bundle could do to arrive at it, and an approximation shown to somebody about to give up money
 * is worse than no figure at all. The endpoint answers by calling the same method the
 * cancellation itself calls, so the two cannot disagree.
 *
 * 🔗 **The seams**, stated so a mismatch is a conversation rather than a dead button:
 *
 *     GET  {API}/orders/{id}/cancellation-preview
 *       → 200 { fromStatus, heldThbMinor, forfeitThbMinor, refundThbMinor }
 *       → 409 the order cannot be cancelled from where it stands
 *     POST {API}/orders/{id}/transitions/cancelled   { reason }          → 200 OrderWire
 *     POST {API}/orders/{id}/change-requests         { noteTh }          → 201 ChangeRequestWire
 *     POST {API}/orders/{id}/change-requests/{crId}/resolution
 *                                                    { resolution: 'withdrawn' } → 200
 */

/**
 * Which cancellation the server is offering, if any.
 *
 * ⭐ **Derived from `availableTransitions`, never from a list of statuses in this app.** The API
 * builds that list from `order_status_transitions` filtered by the calling actor's kind, for the
 * express purpose that a client cannot render a button the server would refuse. A
 * `CANCELLABLE_STATUSES` constant here would be a second opinion about authorisation, and the
 * first time the two disagreed the customer would meet a 403 from a button we drew.
 *
 * `payloadKind` is what splits it, because that is what the table splits on: `cancel_pre_freeze`
 * before aluminium is committed, `cancel_post_freeze` after. Both take `{ reason }` from a
 * customer; the difference is what the screen has to say out loud.
 */
export type CancellationOffer =
  | { readonly kind: 'none' }
  | { readonly kind: 'pre-freeze' }
  | { readonly kind: 'post-freeze' };

/** An objection already open on this order — at most one, by partial unique index. */
export interface OpenObjection {
  readonly id: string;
  readonly noteTh: string | null;
  readonly openedAt: string;
}

/**
 * What this customer may do to this order, read off `GET /orders/:id`.
 *
 * `null` for a quotation opened with `?t=`, and that is deliberate — see `fetchQuotation`.
 */
export interface OrderActions {
  readonly orderId: string;
  readonly cancellation: CancellationOffer;
  readonly openChangeRequest: OpenObjection | null;
}

/** Priced by the server for the cancellation this caller could actually make. */
export interface CancellationPreview {
  readonly fromStatus: string;
  readonly heldThbMinor: bigint;
  readonly forfeitThbMinor: bigint;
  readonly refundThbMinor: bigint;
}

export type OrderActionProblem =
  /** No API base URL. In production a deployment mistake; the page says so plainly. */
  | 'unconfigured'
  /** The network, or an API that is not running. Retrying may work. */
  | 'unreachable'
  /** No session, or a session that has expired since the page loaded. */
  | 'unauthorized'
  /**
   * The server said no, and its sentence is already in the reader's language — render `detail`
   * verbatim. A 409 here is usually "the order moved while you were reading this page", which is
   * exactly the kind of thing the API says better than a generic string could.
   */
  | 'refused'
  /** 2xx whose body this bundle cannot read. Never a partial or defaulted object. */
  | 'malformed';

export type OrderActionResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly problem: OrderActionProblem; readonly detail?: string | undefined };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** Satang out of a tagged wire amount. The tag is checked, never assumed. */
const asSatang = (value: unknown): bigint | null => {
  if (!isRecord(value) || value['unit'] !== 'THB.satang') return null;
  try {
    return BigInt(String(value['digits']));
  } catch {
    return null;
  }
};

/* ------------------------------------------------------------------ *
 * Reading what is on offer
 * ------------------------------------------------------------------ */

/**
 * ⭐ THE ONE RULE ABOUT WHICH BUTTON EXISTS.
 *
 * Given the `availableTransitions` the server sent, is a cancellation offered and which kind?
 * Anything this function cannot recognise is `'none'` — an unknown `payloadKind` on the
 * `cancelled` edge means the server has grown a shape this build does not understand, and the
 * safe reading of that is to offer nothing rather than to guess a body.
 *
 * ⚠️ It does not look at the order's status, and must not start. The status is not what decides
 * this; the row in `order_status_transitions` is, and whether the caller's actor kind appears in
 * its `allowed_actor_kinds` — a question already answered by the time this list arrives.
 */
export function cancellationOffer(transitions: unknown): CancellationOffer {
  if (!Array.isArray(transitions)) return { kind: 'none' };

  for (const entry of transitions) {
    if (!isRecord(entry) || entry['toStatus'] !== 'cancelled') continue;

    const payloadKind = entry['payloadKind'];
    if (payloadKind === 'cancel_pre_freeze') return { kind: 'pre-freeze' };
    if (payloadKind === 'cancel_post_freeze') return { kind: 'post-freeze' };

    return { kind: 'none' };
  }

  return { kind: 'none' };
}

/** The open objection off `GET /orders/:id`, or `null` when there is none. */
export function openObjection(value: unknown): OpenObjection | null {
  if (!isRecord(value)) return null;

  const id = asString(value['id']);
  const openedAt = asString(value['openedAt']);
  if (id === null || openedAt === null) return null;

  /* Resolved requests are history, not something the customer can still withdraw. */
  if (asString(value['resolution']) !== null) return null;

  return { id, openedAt, noteTh: asString(value['noteTh']) };
}

/**
 * What the order response says this customer may do.
 *
 * Both halves come from the same `GET /orders/:id` body the quotation heading is already read
 * from, so this costs no extra request.
 */
export function orderActionsFrom(orderId: string, summary: unknown): OrderActions {
  const body = isRecord(summary) ? summary : {};

  return {
    orderId,
    cancellation: cancellationOffer(body['availableTransitions']),
    openChangeRequest: openObjection(body['openChangeRequest']),
  };
}

/* ------------------------------------------------------------------ *
 * Transport
 * ------------------------------------------------------------------ */

type Sent =
  | { readonly ok: true; readonly response: Response }
  | { readonly ok: false; readonly problem: 'unconfigured' | 'unreachable' };

/**
 * ⚠️ `credentials: 'include'` **and** a bearer token, both.
 *
 * The same rule `lib/quotation/api.ts` states for the owned quotation path: `@RequirePrincipal()`
 * accepts a session or a guest cookie, and an order attached to `customer_user_id` is not the
 * guest's — so a call with the cookie alone reads a signed-in customer's own order as a
 * stranger's and gets 404. The cookie is what carries a guest's ownership; the header is what
 * carries a customer's. Sending both is what makes one function serve both.
 */
async function send(path: string, accessToken: string, init: RequestInit): Promise<Sent> {
  const base = reviewsApiBaseUrl();
  if (base === null) return { ok: false, problem: 'unconfigured' };

  try {
    const response = await fetch(`${base}${path}`, {
      credentials: 'include',
      cache: 'no-store',
      ...init,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${accessToken}`,
        ...(init.headers ?? {}),
      },
    });
    return { ok: true, response };
  } catch {
    return { ok: false, problem: 'unreachable' };
  }
}

/** The API's own sentence, which is already in the caller's language. */
async function refusal(
  response: Response,
): Promise<{ readonly problem: OrderActionProblem; readonly detail?: string | undefined }> {
  const body: unknown = await response.json().catch(() => null);
  const detail =
    isRecord(body) && isRecord(body['error']) && typeof body['error']['message'] === 'string'
      ? body['error']['message']
      : undefined;

  return { problem: response.status === 401 ? 'unauthorized' : 'refused', detail };
}

const json = { 'content-type': 'application/json' } as const;

/* ------------------------------------------------------------------ *
 * The calls
 * ------------------------------------------------------------------ */

/**
 * What cancelling would cost, before anything is cancelled.
 *
 * A 409 arrives as `'refused'` carrying the API's sentence, which is the honest rendering: it
 * means the order moved out from under the page, and the reader needs to reload rather than to
 * be told a number.
 */
export async function fetchCancellationPreview(
  orderId: string,
  accessToken: string,
): Promise<OrderActionResult<CancellationPreview>> {
  const sent = await send(`/orders/${encodeURIComponent(orderId)}/cancellation-preview`, accessToken, {
    method: 'GET',
  });
  if (!sent.ok) return { ok: false, problem: sent.problem };
  if (!sent.response.ok) return { ok: false, ...(await refusal(sent.response)) };

  const body: unknown = await sent.response.json().catch(() => null);
  if (!isRecord(body)) return { ok: false, problem: 'malformed' };

  const fromStatus = asString(body['fromStatus']);
  const heldThbMinor = asSatang(body['heldThbMinor']);
  const forfeitThbMinor = asSatang(body['forfeitThbMinor']);
  const refundThbMinor = asSatang(body['refundThbMinor']);

  /*
   * ⚠️ All four or nothing. A preview missing its forfeit rendered as ฿0.00 would be a screen
   * telling somebody their cancellation is free because a field failed to decode.
   */
  if (
    fromStatus === null ||
    heldThbMinor === null ||
    forfeitThbMinor === null ||
    refundThbMinor === null
  ) {
    return { ok: false, problem: 'malformed' };
  }

  return { ok: true, data: { fromStatus, heldThbMinor, forfeitThbMinor, refundThbMinor } };
}

/**
 * Cancel the order.
 *
 * 🔒 `{ reason }`. There is no second field, and `cancelOrderRequestSchema` is a `strictObject`
 * that would 422 one — see the file header on why that is the design and not a limitation.
 */
export async function cancelOrder(
  orderId: string,
  reason: string,
  accessToken: string,
): Promise<OrderActionResult<{ readonly status: string }>> {
  const sent = await send(`/orders/${encodeURIComponent(orderId)}/transitions/cancelled`, accessToken, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ reason: reason.trim() }),
  });
  if (!sent.ok) return { ok: false, problem: sent.problem };
  if (!sent.response.ok) return { ok: false, ...(await refusal(sent.response)) };

  const body: unknown = await sent.response.json().catch(() => null);
  const status = isRecord(body) ? asString(body['status']) : null;

  return status === null ? { ok: false, problem: 'malformed' } : { ok: true, data: { status } };
}

/** Raise an objection. It blocks entry to `production_confirmed` until somebody answers it. */
export async function openChangeRequest(
  orderId: string,
  noteTh: string,
  accessToken: string,
): Promise<OrderActionResult<OpenObjection>> {
  const sent = await send(`/orders/${encodeURIComponent(orderId)}/change-requests`, accessToken, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ noteTh: noteTh.trim() }),
  });
  if (!sent.ok) return { ok: false, problem: sent.problem };
  if (!sent.response.ok) return { ok: false, ...(await refusal(sent.response)) };

  const body: unknown = await sent.response.json().catch(() => null);
  const opened = openObjection(body);

  return opened === null ? { ok: false, problem: 'malformed' } : { ok: true, data: opened };
}

/**
 * Take an objection back.
 *
 * `withdrawn` is the one resolution a customer may post — `accepted` and `rejected` are staff
 * answers and the service refuses them with a 403. Without this the partial unique index that
 * allows one open request at a time becomes the bug it was meant to prevent: a customer who
 * objected by mistake could never object again.
 */
export async function withdrawChangeRequest(
  orderId: string,
  changeRequestId: string,
  accessToken: string,
): Promise<OrderActionResult<{ readonly resolution: string }>> {
  const sent = await send(
    `/orders/${encodeURIComponent(orderId)}/change-requests/${encodeURIComponent(changeRequestId)}/resolution`,
    accessToken,
    { method: 'POST', headers: json, body: JSON.stringify({ resolution: 'withdrawn' }) },
  );
  if (!sent.ok) return { ok: false, problem: sent.problem };
  if (!sent.response.ok) return { ok: false, ...(await refusal(sent.response)) };

  const body: unknown = await sent.response.json().catch(() => null);
  const resolution = isRecord(body) ? asString(body['resolution']) : null;

  return resolution === null
    ? { ok: false, problem: 'malformed' }
    : { ok: true, data: { resolution } };
}
