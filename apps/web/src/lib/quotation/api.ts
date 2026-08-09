import { pinnedDocumentFrom, type PinnedDocument } from '@wewin/core/quotation';

import { reviewsApiBaseUrl } from '../reviews/api';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The quotation, fetched with the token out of the emailed link.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ── The token is opaque here, and that is the design ─────────────────────────
 *
 * Exactly the arrangement `reviews/invitation.ts` argues for, and for the same reason: `t`
 * comes out of the URL as a string, goes back up as a string, and is never parsed, decoded,
 * validated or stored. It happens to be a signed JWT today; if it becomes a nonce tomorrow,
 * not one line here changes.
 *
 * What that buys is worth stating plainly: **there is no authorisation logic on the
 * storefront.** The server decides whether this token may read that order, and a client that
 * cannot tell a good token from a bad one cannot be talked into believing one.
 *
 * ── ⚠️ Client-side only, and never cached ────────────────────────────────────
 *
 * The URL *is* the credential. A server render would put one customer's quotation into a
 * response whose whole design is that it is cached and shared, and `cache: 'no-store'` here
 * is the same instinct as the API's `Cache-Control: private, no-cache` on the way out.
 *
 * ── ⚠️ The shape is decoded by `@wewin/core`, not here ───────────────────────
 *
 * The first version of this file had its own decoder, written from an *assumption* about the
 * payload: money as digits, lines carrying an `options` array. Both were wrong — money is
 * `{unit: 'THB.satang', digits}` and the option labels live under `price.lines[].label.params`
 * — and because the unit tests were written against that same invented fixture, they passed
 * while the page failed on the first real response.
 *
 * `pinnedDocumentFrom` is the decoder the dashboard already used against real payloads. Two
 * decoders would be two documents before either app rendered a character, which is the same
 * argument plan 10.6 makes about two renderers.
 *
 * 🔗 **The seam**, stated so a mismatch is a conversation rather than a blank page:
 *
 *     GET {API}/orders/documents/{token}
 *       → 200 { orderNo, status, contactName, submittedAt, document, seller }
 *       → 404 for every refusal, deliberately
 *
 * ⚠️ `seller` as of fix round 1 — beside `document`, never inside it, read live from
 * `organisation_profile` on every call. Fine to serve on this anonymous route for the same
 * reason `AppFooter` prints the same address with no session at all: it is the company's own
 * letterhead, not a fact about the customer or the order.
 */

/**
 * ⭐ Which of the two ways this URL is, and there are two.
 *
 * ⚠️ **The second one did not exist**, and the failure was mine twice over: the page read
 * `?t=` only, while `MyQuotations` and the success screen both linked without a token — under
 * a comment of mine asserting that "the ordinary owned-order route works for it". It did not.
 * Every customer opening their own quotation from their own list was told the link had expired.
 *
 *   `?t=…`      a bearer token from an email. Any device, no account, no cookie.
 *   `?order=…`  an id, for somebody **signed in who owns it**. `ownershipFilter` decides, in
 *               the query, so this cannot reach a stranger's order however it is called.
 *
 * ⚠️ **A token wins.** `document-link.pg.test.ts` pins the API half — the order id comes out
 * of the signature and never from a parameter, because a valid signature beside a chosen id
 * would be every quotation the company has issued. This is the same rule on the client: when
 * a token is present, `order` is not read at all.
 */
export type QuotationSource =
  | { readonly kind: 'token'; readonly token: string }
  | { readonly kind: 'owned'; readonly orderId: string }
  | { readonly kind: 'none' };

/** The shape the API's own `isOrderUuid` accepts; refused here so it never reaches a path. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function quotationSource(search: string): QuotationSource {
  const params = new URLSearchParams(search);

  const token = params.get('t') ?? '';
  if (token !== '') return { kind: 'token', token };

  const orderId = params.get('order') ?? '';
  return UUID.test(orderId) ? { kind: 'owned', orderId } : { kind: 'none' };
}

/**
 * Who is offering the quotation — `organisation_profile`, read live rather than pinned.
 *
 * ⚠️ Hand-decoded rather than imported from `@wewin/contract/organisation`, for the reason
 * `lib/reviews/wire.ts` gives at length: this app does not depend on `@wewin/contract` and
 * a company's address is content, not a UI string (`i18n/keys.ts`'s own rule) — so the
 * fields below are rendered exactly as the API sent them, in whatever language the company
 * typed them in.
 */
export interface Seller {
  readonly legalNameTh: string;
  readonly addressTh: string;
  readonly taxId: string | null;
  readonly phone: string;
}

/**
 * `null` on a decode failure and, defensively, on a response that has no `seller` key at
 * all — every current server response carries one (fix round 1 widened both
 * `GET /orders/documents/:token` and `GET /orders/:id/document`), but a caller a version
 * behind, or a future endpoint that forgets it, should render a quotation with no letterhead
 * rather than fail to render at all.
 */
function sellerFrom(value: unknown): Seller | null {
  if (!isRecord(value)) return null;

  const legalNameTh = asString(value['legalNameTh']);
  const addressTh = asString(value['addressTh']);
  const phone = asString(value['phone']);
  if (legalNameTh === null || addressTh === null || phone === null) return null;

  return { legalNameTh, addressTh, phone, taxId: asString(value['taxId']) };
}

export interface LinkedQuotation {
  readonly orderNo: string | null;
  readonly status: string;
  readonly document: PinnedDocument;
  readonly seller: Seller | null;
}

export type QuotationFailure =
  /** No API base URL. In production a deployment mistake; the page says so plainly. */
  | 'unconfigured'
  /** No `?t=` in the URL at all — somebody opened the bare path. */
  | 'no-token'
  /** The network, or an API that is not running. Retrying may work. */
  | 'unreachable'
  /**
   * ⚠️ **The API's one answer to four different problems.**
   *
   * Expired, mistyped, revoked by a key rotation, or an order that never existed — the server
   * refuses to say which, on purpose, because distinguishing them would let somebody holding
   * one valid link learn about ids they do not hold. The page therefore cannot say "your link
   * has expired" however much it would like to, and offers the one action that always works:
   * ask the sales team for a fresh one.
   */
  | 'refused'
  /** 2xx whose body this bundle cannot read — including unreadable money. */
  | 'malformed';

export type QuotationResult =
  | { readonly ok: true; readonly data: LinkedQuotation }
  | { readonly ok: false; readonly reason: QuotationFailure };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * ⚠️ A throw from `pinnedDocumentFrom` becomes `malformed`, and that is the strict half.
 *
 * It throws on money it cannot read, and the alternative — defaulting a missing total to zero
 * — would render a quotation for ฿0.00 that is indistinguishable from a real one, in front of
 * somebody who transfers the printed figure. A refusal is the only safe answer.
 */
export function decodeQuotation(body: unknown): LinkedQuotation | null {
  if (!isRecord(body) || !isRecord(body['document'])) return null;

  try {
    return {
      orderNo: asString(body['orderNo']),
      status: asString(body['status']) ?? 'unknown',
      document: pinnedDocumentFrom(body['document'], {
        orderNo: asString(body['orderNo']),
        contactName: asString(body['contactName']),
        submittedAt: asString(body['submittedAt']),
      }),
      seller: sellerFrom(body['seller']),
    };
  } catch {
    return null;
  }
}

/**
 * ⚠️ Two endpoints with **two different shapes**, and that is why this is not one fetch.
 *
 * `GET /orders/documents/:token` answers
 * `{orderNo, status, contactName, submittedAt, document, seller}` — assembled by
 * `DocumentLinkReader` precisely because a holder of a link cannot call anything else. `GET
 * /orders/:id/document` answers `{document, seller}` only — the heading fields come from `GET
 * /orders/:id` beside it instead, which is what the dashboard has always done. `seller` is the
 * one field both shapes carry the same way: beside the pinned document, never inside it, read
 * live from `organisation_profile` on every call.
 *
 * ⚠️ The owned path needs a **bearer token**, not merely a cookie. `@RequirePrincipal()` reads
 * a session or a guest cookie, and an order attached to `customer_user_id` is not the guest's
 * — so a fetch with `credentials: 'include'` and no `Authorization` reads the customer's own
 * quotation as a stranger's and answers 404.
 */
export async function fetchQuotation(
  source: QuotationSource,
  accessToken?: string | undefined,
): Promise<QuotationResult> {
  if (source.kind === 'none') return { ok: false, reason: 'no-token' };

  const base = reviewsApiBaseUrl();
  if (base === null) return { ok: false, reason: 'unconfigured' };

  const get = async (path: string): Promise<Response | null> => {
    try {
      return await fetch(`${base}${path}`, {
        headers: {
          accept: 'application/json',
          ...(accessToken === undefined ? {} : { authorization: `Bearer ${accessToken}` }),
        },
        credentials: 'include',
        /* The URL is the credential on one path and the session on the other; cache neither. */
        cache: 'no-store',
      });
    } catch {
      return null;
    }
  };

  if (source.kind === 'token') {
    const response = await get(`/orders/documents/${encodeURIComponent(source.token)}`);
    if (response === null) return { ok: false, reason: 'unreachable' };
    if (!response.ok) return { ok: false, reason: 'refused' };

    const body: unknown = await response.json().catch(() => null);
    const data = decodeQuotation(body);
    return data === null ? { ok: false, reason: 'malformed' } : { ok: true, data };
  }

  /* Owned: the order for the heading, the document for the body. Both must succeed. */
  const [order, document] = await Promise.all([
    get(`/orders/${source.orderId}`),
    get(`/orders/${source.orderId}/document`),
  ]);

  if (order === null || document === null) return { ok: false, reason: 'unreachable' };
  /*
   * 404 covers "not yours" as well as "no such order" — `scoped-order.repository.ts` collapses
   * them deliberately — and 404 on the document alone means a cart that was never submitted.
   */
  if (!order.ok || !document.ok) return { ok: false, reason: 'refused' };

  const summary: unknown = await order.json().catch(() => null);
  /* ⚠️ `{document, seller}` — `seller` beside the pinned document, never merged into it. */
  const wrapped: unknown = await document.json().catch(() => null);
  if (!isRecord(summary) || !isRecord(wrapped) || !isRecord(wrapped['document'])) {
    return { ok: false, reason: 'malformed' };
  }

  const contact = isRecord(summary['contact']) ? summary['contact'] : {};
  const data = decodeQuotation({
    orderNo: summary['orderNo'],
    status: summary['status'],
    contactName: contact['name'],
    submittedAt: summary['submittedAt'],
    document: wrapped['document'],
    seller: wrapped['seller'],
  });

  return data === null ? { ok: false, reason: 'malformed' } : { ok: true, data };
}
