import type { QuoteLine } from '@wewin/core';
import { normalisePhone } from '@wewin/core/phone';

import { reviewsApiBaseUrl } from '../reviews/api';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ TURNING A CART INTO A SUBMITTED ORDER.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The storefront's catalogue is **compiled into the bundle**, so a cart line knows its
 * `productId`, its selections and its measurements — and knows nothing about
 * `productVersionId` or `documentHash`, the two fields the submit requires, because the API
 * prices against the *published* document and verifies its hash on the way in.
 *
 * Submitting therefore means asking the live catalogue what is published now and pairing it
 * with what the customer configured then. That pairing is `linesToSubmit`, and it is a pure
 * function with tests, because both ways it can go wrong are silent:
 *
 *   **Dropping an unplaceable line** submits part of a cart at a total the customer never saw.
 *   **Substituting another version** quotes them for a window they did not configure — the
 *   server would recompute the price against a document whose options may have been renamed,
 *   repriced or removed, and the only thing that would notice is the customer, on paper.
 *
 * So it refuses, and names the products it could not place, because removing that line is the
 * only thing the customer can do about it.
 *
 * ── ⚠️ Two calls, and the first one is not idempotent ────────────────────────
 *
 * `POST /orders` mints a cart *and a guest cookie*; the transition submits it. A caller that
 * retried the pair from the top after a failed submit would leave an abandoned draft per
 * attempt — so `submitQuote` creates once and reports a failed submit against the order it
 * already has, which is also what lets the caller retry the half that failed.
 *
 * ⚠️ **The nickname does not travel, and that is the API's gap rather than this file's.**
 * `PriceRequestWire` has no description field: `customerDescriptionTh` on the pinned document
 * comes from `quote_lines`, which sales edits, not from the submit body. So "หน้าต่างห้องนอน 1"
 * is lost at submit — the same class of gap as the zero-delta option labels recorded in
 * `@wewin/core/quotation`, and fixed in the same place: what `submit_for_payment` freezes.
 */

/** What the live catalogue says about one product. */
export interface CatalogRef {
  readonly productId: string;
  readonly productVersionId: string;
  readonly documentHash: string;
}

/** `PriceRequestWire`, restated — the same boundary debt every feature client here carries. */
export interface SubmitLine {
  readonly productVersionId: string;
  readonly documentHash: string;
  readonly productId: string;
  readonly selections: Readonly<Record<string, string>>;
  readonly measures: Readonly<Record<string, { readonly unit: 'um'; readonly digits: string }>>;
  readonly enteredUnits: Readonly<Record<string, string>>;
  readonly qty: number;
}

export type LinesResult =
  | { readonly ok: true; readonly lines: readonly SubmitLine[] }
  /** `unavailable` is empty for an empty cart, and names products otherwise. */
  | { readonly ok: false; readonly unavailable: readonly string[] };

export function linesToSubmit(cart: readonly QuoteLine[], refs: readonly CatalogRef[]): LinesResult {
  if (cart.length === 0) return { ok: false, unavailable: [] };

  const byProduct = new Map(refs.map((ref) => [ref.productId, ref]));
  const unavailable = [...new Set(cart.filter((l) => !byProduct.has(l.productId)).map((l) => l.productId))];

  if (unavailable.length > 0) return { ok: false, unavailable };

  return {
    ok: true,
    lines: cart.map((line) => {
      const ref = byProduct.get(line.productId);
      /* Unreachable: the filter above returned early. Narrowing, not defence. */
      if (ref === undefined) throw new Error(`submit: no catalogue ref for ${line.productId}`);

      const measures: Record<string, { unit: 'um'; digits: string }> = {};
      for (const [code, um] of Object.entries(line.measures)) {
        /*
         * ⚠️ Digits from a `bigint`, never a number. The API's `exactSchema` refuses anything
         * else, and a float here would be a rounding decision in the field that decides how
         * aluminium is cut.
         */
        measures[code] = { unit: 'um', digits: um.toString() };
      }

      return {
        productVersionId: ref.productVersionId,
        documentHash: ref.documentHash,
        productId: line.productId,
        selections: { ...line.selections },
        measures,
        /* Carried because the server phrases the step warning on the grid they measured to. */
        enteredUnits: { ...line.enteredUnits },
        qty: line.qty,
      };
    }),
  };
}

/* ------------------------------------------------------------------ *
 * The contact
 * ------------------------------------------------------------------ */

export type ContactProblem = 'name-missing' | 'no-channel' | 'bad-phone' | 'bad-email';

export interface ContactDraft {
  readonly name: string;
  readonly email: string;
  readonly phone: string;
  /** The picker's own value — always present, defaulting to `'TH'`. See `DestinationSelect`. */
  readonly destinationCountry: string;
}

export interface ContactWire {
  readonly name: string;
  readonly email?: string | undefined;
  readonly phone?: string | undefined;
  readonly locale: string;
  /** `OrderContactRequestWire.destinationCountry`, restated — sent on every submit. */
  readonly destinationCountry: string;
}

/**
 * ⭐ **At least one channel**, and the number in the one spelling the API stores.
 *
 * `orders_submitted_has_a_contact_channel` and `orderContactRequestSchema` both require an
 * address or a number; `orders_contact_phone_e164` requires the number canonical. Normalising
 * here — with `@wewin/core/phone`, the same function the API's identity table obeys — is what
 * lets a customer type `081-234-5678` and lets the row be written.
 *
 * ⚠️ Refusing rather than sending and hoping. A non-canonical number reaches the API as a
 * CHECK violation, which is a 500 and a sentence nobody can act on.
 */
export function contactToWire(
  draft: ContactDraft,
  locale: string,
): { readonly ok: true; readonly contact: ContactWire } | { readonly ok: false; readonly problem: ContactProblem } {
  const name = draft.name.trim();
  if (name === '') return { ok: false, problem: 'name-missing' };

  const email = draft.email.trim().toLowerCase();
  const phone = draft.phone.trim();

  if (email === '' && phone === '') return { ok: false, problem: 'no-channel' };

  /*
   * The API's own shape, restated. Deliberately loose — an address is a lookup key, not a
   * thing to be clever about, and a stricter rule here would refuse addresses that work.
   */
  if (email !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
    return { ok: false, problem: 'bad-email' };
  }

  const normalised = phone === '' ? null : normalisePhone(phone);
  if (phone !== '' && normalised === null) return { ok: false, problem: 'bad-phone' };

  return {
    ok: true,
    contact: {
      name,
      ...(email === '' ? {} : { email }),
      ...(normalised === null ? {} : { phone: normalised }),
      /* The language the customer is reading in — pinned on the document at submit (plan 10.6). */
      locale,
      /* Where the order is going — the picker's value, sent every time rather than left to fall
       * back to whatever the cart already carried, so what the customer sees on screen is what
       * gets pinned. */
      destinationCountry: draft.destinationCountry,
    },
  };
}

/* ------------------------------------------------------------------ *
 * The two calls
 * ------------------------------------------------------------------ */

export type SubmitFailure =
  | 'unconfigured'
  | 'unreachable'
  /** The API refused. `detail` carries what it said, which is already in the reader's language. */
  | 'refused';

export type SubmitResult =
  | { readonly ok: true; readonly orderId: string; readonly orderNo: string | null }
  | { readonly ok: false; readonly reason: SubmitFailure; readonly detail?: string | undefined };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `{ products: [{ productVersionId, documentHash, product: { id } }] }` — the published set. */
export async function fetchCatalogRefs(): Promise<readonly CatalogRef[] | null> {
  const base = reviewsApiBaseUrl();
  if (base === null) return null;

  try {
    const response = await fetch(`${base}/catalog/products?limit=200`, {
      headers: { accept: 'application/json' },
      /*
       * ⚠️ `no-store`. This is the answer to "what may be ordered *right now*", and a cached
       * one is how a withdrawn product keeps being submittable for as long as the entry lives.
       */
      cache: 'no-store',
    });
    if (!response.ok) return null;

    const body: unknown = await response.json();
    if (!isRecord(body) || !Array.isArray(body['products'])) return null;

    return body['products'].flatMap((raw) => {
      if (!isRecord(raw) || !isRecord(raw['product'])) return [];
      const productId = raw['product']['id'];
      const productVersionId = raw['productVersionId'];
      const documentHash = raw['documentHash'];

      return typeof productId === 'string' &&
        typeof productVersionId === 'string' &&
        typeof documentHash === 'string'
        ? [{ productId, productVersionId, documentHash }]
        : [];
    });
  } catch {
    return null;
  }
}

/**
 * Create the cart, then submit it.
 *
 * ⚠️ `credentials: 'include'` on both. `POST /orders` sets the `__Host-` guest cookie that
 * makes the order findable by this browser afterwards, and the transition needs it back — a
 * pair of calls without it creates an order the customer cannot open two minutes later.
 */
export async function submitQuote(input: {
  readonly lines: readonly SubmitLine[];
  readonly contact: ContactWire;
  /**
   * ⭐ The customer's access token, and it is what makes the order *theirs*.
   *
   * `OrdersService.createDraft` attaches `customer_user_id` when a session is present and
   * falls back to a guest cookie when it is not. Without this header the order would be a
   * guest's — findable by one browser, lost the moment that cookie is cleared, which is the
   * whole reason the submit now stands behind an account.
   */
  readonly accessToken: string;
}): Promise<SubmitResult> {
  const base = reviewsApiBaseUrl();
  if (base === null) return { ok: false, reason: 'unconfigured' };

  const post = async (path: string, body: unknown): Promise<Response | null> => {
    try {
      return await fetch(`${base}${path}`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Bearer ${input.accessToken}`,
        },
        cache: 'no-store',
        body: JSON.stringify(body),
      });
    } catch {
      return null;
    }
  };

  const created = await post('/orders', {});
  if (created === null) return { ok: false, reason: 'unreachable' };
  if (!created.ok) return { ok: false, reason: 'refused', detail: await messageOf(created) };

  const draft: unknown = await created.json().catch(() => null);
  if (!isRecord(draft) || typeof draft['id'] !== 'string') {
    return { ok: false, reason: 'refused' };
  }
  const orderId = draft['id'];

  const submitted = await post(`/orders/${orderId}/transitions/awaiting_payment`, {
    contact: input.contact,
    lines: input.lines,
  });
  if (submitted === null) return { ok: false, reason: 'unreachable' };
  if (!submitted.ok) return { ok: false, reason: 'refused', detail: await messageOf(submitted) };

  const order: unknown = await submitted.json().catch(() => null);

  return {
    ok: true,
    orderId,
    orderNo: isRecord(order) && typeof order['orderNo'] === 'string' ? order['orderNo'] : null,
  };
}

/**
 * The API's own sentence, which is already in the caller's language.
 *
 * Every refusal from this application carries `error.message` rendered through the same
 * catalogue the pages use — so showing it beats inventing a second vocabulary for the same
 * conditions, and beats "something went wrong" by a distance.
 */
async function messageOf(response: Response): Promise<string | undefined> {
  const body: unknown = await response.json().catch(() => null);
  if (!isRecord(body) || !isRecord(body['error'])) return undefined;

  const message = body['error']['message'];
  return typeof message === 'string' ? message : undefined;
}
