import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import type { OrderDocumentWire } from '@wewin/contract/order';

import { AppError } from '../common/errors/app-error';
import { message } from '../i18n';
import { SESSION_CONFIG } from '../auth/session/session.tokens';
import type { SessionConfig } from '../auth/session/session.config';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ THE ONE WAY A CUSTOMER WITH NO COOKIE REACHES THEIR OWN QUOTATION.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ── The problem this exists for ──────────────────────────────────────────────
 *
 * Every other route into an order goes through `ownershipFilter`, which is
 * `customer_user_id = me` or `guest_id = my cookie`. Both are properties of a **browser**.
 *
 * The customer we are emailing does not have that browser open. `orders` requires a
 * `contact_email` on a submitted order (`orders_submitted_has_a_contact_channel`) and
 * requires no account whatsoever — the storefront's whole pitch is that you can price a
 * window without signing in — so the ordinary customer is a guest who typed an address on a
 * laptop and reads the mail on a phone. On that phone there is no guest cookie, and
 * `findOrFail` answers 404.
 *
 * `scoped-order.repository.ts` predicted the support call verbatim: *"it says not found and
 * I am looking at the email"*. This is the answer to it, and it is deliberately the only one.
 *
 * ── ⚠️ It is a bearer token ──────────────────────────────────────────────────
 *
 * Whoever holds the link sees the quotation. There is no cookie and no second factor, by
 * construction — requiring either would reinstate the problem. So what has to be true is that
 * the blast radius is small and stays small:
 *
 *   ⓵ **One order.** The id is inside the signed payload, so a holder cannot walk to a
 *     second one. A design with the id as a separate parameter beside a valid signature
 *     would put every quotation the company has ever issued one increment away.
 *   ⓶ **Read-only.** `document-link.controller.ts` is the only place this is verified, and
 *     it serves one GET. Nothing accepts it for a transition, a payment or a change request.
 *     A future route that wants to *act* on this token is a decision, not an extension.
 *   ⓷ **It expires.** A quotation is cited for months, so the window is long — but a
 *     forwarded link is otherwise a permanent read of somebody's prices, and there is no
 *     revocation to fall back on.
 *
 * ── Why stateless, when everything else here stores a digest ─────────────────
 *
 * `auth_tokens` is the obvious home and it does not fit twice over. Its `user_id` is NOT
 * NULL, and the customer in the common case has no account; loosening that column — on the
 * table that carries password resets — to make a quotation link fit would be trading a real
 * constraint for a convenience.
 *
 * The second reason is the one that actually decides it. Everything in that table is stored
 * as a **digest**, so nothing can read the token back — and the notification worker, which
 * renders the email minutes or thirty days later, needs the plaintext. It would have to be
 * stored recoverably, which is a decrypt-able secret in a table, or handed to the outbox at
 * enqueue time — and the outbox's producer is a Postgres trigger.
 *
 * Derived instead: the worker recomputes the same token from the order id whenever it needs
 * it. Nothing to store, nothing to sweep, nothing to leak at rest.
 *
 * ⚠️ **The cost is revocation, and it is real.** A link sent to a mistyped address cannot be
 * withdrawn; the remedy is that it expires. If a customer ever needs one killed sooner, this
 * is the paragraph to come back to — and the answer would be a table of revoked `jti`s
 * checked here, not a redesign.
 *
 * ── ⚠️ Rotating the session secret invalidates every link at once ────────────
 *
 * The key is derived from `AUTH_ACCESS_TOKEN_SECRET`, so rotating it expires every quotation
 * link in every customer's inbox in the same instant — six months of them, silently, all
 * answering the same 404 as a mistyped one.
 *
 * That is a change in what rotating costs. Before this, rotation signed everybody out; a
 * session is minutes old and its owner is at a keyboard, so they sign in again and never
 * notice. A quotation link is months old and its owner is not, and the failure reaches them
 * as "the company sent me a broken link".
 *
 * It is written down rather than designed around, because the alternative — a second secret
 * with its own rotation schedule — is a key somebody forgets to set. What a rotation needs is
 * a re-send, and this paragraph is where somebody planning one should find that out.
 *
 * ⚠️ In development there is no secret at all: `main.ts` mints an ephemeral one per boot and
 * says so in the log, so a link minted before a restart is dead after it. Expected, and worth
 * knowing before spending ten minutes on it as a bug.
 *
 * ── Key separation, not a claim ──────────────────────────────────────────────
 *
 * Signed with its own key, derived from the session secret over a fixed label. The long
 * version of the argument is in `auth/mfa/challenge.ts`; the short version is that a
 * `purpose` claim is an `if`, an `if` can be missing on a path somebody adds next year, and
 * a different key cannot be. An access token handed to `verify` here fails on the signature
 * before any claim is read — which is what stops a signed-in person from reading any order
 * by pasting their own token into the URL.
 */

/**
 * Six months.
 *
 * Long because a quotation is a document people come back to — "what did we agree in
 * August?" is asked in February. Bounded because ⓷ above: there is no revocation, so the
 * expiry is the only thing that ever takes a forwarded link out of circulation.
 *
 * ⚠️ Every email carries a **freshly derived** token, so a customer who is still being
 * written to never runs out of runway. The clock is on the link, not on the order.
 */
export const DOCUMENT_LINK_TTL_SECONDS = 180 * 24 * 60 * 60;

const HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' }), 'utf8').toString('base64url');

/**
 * The label that makes the key a different key.
 *
 * Versioned so that changing the shape one day is a rolling deploy that accepts both, rather
 * than every quotation link in every customer's inbox breaking at once.
 */
const DOMAIN = 'wewin/order-document/v1';

export type DocumentLinkRejection = 'malformed' | 'bad_signature' | 'bad_claims' | 'wrong_issuer' | 'expired';

export type DocumentLinkVerification =
  | { readonly ok: true; readonly orderId: string }
  | { readonly ok: false; readonly reason: DocumentLinkRejection };

export interface IssuedDocumentLink {
  readonly token: string;
  readonly expiresAt: Date;
}

/** The shape `ScopedOrderRepository.find` would reject anyway; refused before it gets there. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

@Injectable()
export class DocumentLinkService {
  private readonly key: Buffer;
  private readonly issuer: string;

  constructor(@Inject(SESSION_CONFIG) config: SessionConfig) {
    /* HMAC as a KDF over a fixed label — one derivation, no salt to manage. */
    this.key = createHmac('sha256', config.accessTokenKey.export()).update(DOMAIN).digest();
    this.issuer = config.issuer;
  }

  /** `atMs` is for tests, and for a worker that wants the expiry it is about to promise. */
  issue(orderId: string, atMs: number = Date.now()): IssuedDocumentLink {
    const issuedAt = Math.floor(atMs / 1000);
    const expiresAt = issuedAt + DOCUMENT_LINK_TTL_SECONDS;

    /*
     * ⚠️ No `sid`, and no `uid`. This token says which *order* may be read and nothing about
     * who is reading — there is deliberately no person behind it, because the person we are
     * writing to may not have an account at all. A claim about identity here would be a
     * claim nothing could check.
     */
    const claims = { iss: this.issuer, sub: orderId, jti: randomUUID(), iat: issuedAt, exp: expiresAt };
    const body = `${HEADER}.${Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')}`;

    return { token: `${body}.${this.mac(body).toString('base64url')}`, expiresAt: new Date(expiresAt * 1000) };
  }

  verify(token: string, atMs: number = Date.now()): DocumentLinkVerification {
    const parts = token.split('.');
    if (parts.length !== 3) return { ok: false, reason: 'malformed' };

    const [header, payload, signature] = parts;
    if (header === undefined || payload === undefined || signature === undefined) {
      return { ok: false, reason: 'malformed' };
    }

    /*
     * ⚠️ Signature first, before anything in the payload is parsed or trusted. Reading claims
     * from an unverified token and *then* checking the MAC is how a parser becomes attack
     * surface — and how a `sub` an attacker chose reaches a log line even on the refusal path.
     */
    const expected = this.mac(`${header}.${payload}`);
    const presented = Buffer.from(signature, 'base64url');
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
      return { ok: false, reason: 'bad_signature' };
    }

    let claims: unknown;
    try {
      claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      return { ok: false, reason: 'malformed' };
    }

    if (typeof claims !== 'object' || claims === null || Array.isArray(claims)) {
      return { ok: false, reason: 'bad_claims' };
    }

    const { iss, sub, exp } = claims as Record<string, unknown>;

    if (typeof sub !== 'string' || !UUID.test(sub)) return { ok: false, reason: 'bad_claims' };
    if (typeof exp !== 'number' || !Number.isSafeInteger(exp)) return { ok: false, reason: 'bad_claims' };
    if (iss !== this.issuer) return { ok: false, reason: 'wrong_issuer' };
    if (Math.floor(atMs / 1000) >= exp) return { ok: false, reason: 'expired' };

    return { ok: true, orderId: sub };
  }

  private mac(body: string): Buffer {
    return createHmac('sha256', this.key).update(body).digest();
  }
}

/** What the customer's page needs: the document, and just enough around it to head a page. */
export interface LinkedDocumentWire {
  readonly orderNo: string | null;
  readonly status: string;
  /**
   * ⚠️ These two live on the **order**, not inside the pinned document, so a renderer that
   * only had `document` could not head the page with the customer's name or the date they
   * confirmed. The dashboard reads them from `GET /orders/:id`, which the holder of a link
   * cannot call — so they come along here rather than being fetched a second way.
   */
  readonly contactName: string | null;
  readonly submittedAt: string | null;
  readonly document: OrderDocumentWire;
}

/**
 * ⚠️ The one answer to every refusal on this path.
 *
 * Bad signature, expired, unknown order, an order with no pinned document — all 404, all the
 * same sentence. `scoped-order.repository.ts` gives the reasoning for a logged-in caller and
 * it applies harder to a stranger: distinguishable failures let somebody holding one valid
 * link learn things about ids they do not hold, and "your link has expired" versus "no such
 * order" is exactly that oracle in a friendlier voice.
 *
 * The cost is a worse support conversation than the one this feature fixes — a six-month-old
 * link and a mistyped one look identical to the customer. Staff hold `orders.read` and can
 * see which it is.
 */
export const gone = (): AppError => AppError.notFound(message('error.order.document_link_unusable'));
