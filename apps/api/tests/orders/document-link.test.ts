import { randomBytes, randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { DOCUMENT_LINK_TTL_SECONDS, DocumentLinkService } from '../../src/orders/document-link';
import { MfaChallengeService } from '../../src/auth/mfa/challenge';
import { AccessTokenService } from '../../src/auth/session/access-token';
import { parseSessionConfig } from '../../src/auth/session/session.config';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ THE ONE WAY A CUSTOMER WITH NO COOKIE REACHES THEIR OWN QUOTATION.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Every other route into an order is `ownershipFilter`: `customer_user_id = me`, or
 * `guest_id = my cookie`. Both are properties of a *browser*, and the customer we are
 * writing to does not have that browser open — `orders_submitted_has_a_contact_channel`
 * requires an email address on a submitted order and requires no account at all, so the
 * ordinary case is a guest who typed an address on a laptop and reads the mail on a phone.
 *
 * `scoped-order.repository.ts` already names the support call this produces: *"it says not
 * found and I am looking at the email"*. This token is the answer to it.
 *
 * ── ⚠️ It is a bearer token, and that is the whole risk ──────────────────────
 *
 * Whoever holds the link sees the quotation. There is no second factor and no cookie, by
 * design — demanding one would recreate the problem. What bounds the damage is the scope:
 *
 *   ⓵ it names **one order**, so it cannot be walked to a second;
 *   ⓶ it is **read-only** — no route accepts it for a transition, a payment or a change
 *     request, and `document-link.controller.ts` is the only place it is verified;
 *   ⓷ it **expires**, because a quotation link forwarded once lives in that mailbox
 *     forever otherwise.
 *
 * ── Key separation, not a claim ──────────────────────────────────────────────
 *
 * Signed with its own key, derived from the session secret by domain separation — the
 * same argument `challenge.ts` makes at length, and the reason the tests below check that
 * this verifier and the other two reject each other's tokens. A `purpose` claim would be
 * an `if`, and an `if` can go missing on a path somebody adds later. A different key
 * cannot.
 */

const secret = () => ({ AUTH_ACCESS_TOKEN_SECRET: randomBytes(32).toString('base64url') });

const config = parseSessionConfig(secret());

const links = new DocumentLinkService(config);
const challenges = new MfaChallengeService(config);
const access = new AccessTokenService(config);

const ORDER = randomUUID();

describe('⭐ a link names one order and proves it was issued here', () => {
  it('verifies back to the order it was issued for', () => {
    const issued = links.issue(ORDER);
    const verified = links.verify(issued.token);

    expect(verified.ok).toBe(true);
    expect(verified.ok && verified.orderId).toBe(ORDER);
  });

  it('⭐ refuses a token whose order id was edited', () => {
    /*
     * The attack the signature exists for, and the reason the order id is *inside* the
     * signed payload rather than a second path segment beside it. A link of the shape
     * `/orders/documents/{token}?order={id}` would verify a real signature against an id
     * the holder chose, and every quotation the company has ever issued is one increment
     * away.
     */
    const issued = links.issue(ORDER);
    const [header, payload, signature] = issued.token.split('.');
    const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    claims['sub'] = randomUUID();
    const forged = `${header ?? ''}.${Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')}.${signature ?? ''}`;

    expect(links.verify(forged)).toStrictEqual({ ok: false, reason: 'bad_signature' });
  });

  it('refuses one signed with a different deployment’s secret', () => {
    const elsewhere = new DocumentLinkService(parseSessionConfig(secret()));

    expect(links.verify(elsewhere.issue(ORDER).token).ok).toBe(false);
  });

  it('⚠️ expires', () => {
    /*
     * A quotation is referenced for months, so the window is long — but not unbounded. A
     * forwarded link is a permanent read of somebody's prices otherwise, and there is no
     * revocation on a stateless token to fall back on.
     */
    const atMs = Date.UTC(2026, 0, 1);
    const issued = links.issue(ORDER, atMs);

    expect(links.verify(issued.token, atMs + (DOCUMENT_LINK_TTL_SECONDS - 60) * 1000).ok).toBe(true);
    expect(links.verify(issued.token, atMs + (DOCUMENT_LINK_TTL_SECONDS + 60) * 1000)).toStrictEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('reports the expiry it issued, so a caller need not re-derive it', () => {
    const atMs = Date.UTC(2026, 0, 1);

    expect(links.issue(ORDER, atMs).expiresAt.getTime()).toBe(atMs + DOCUMENT_LINK_TTL_SECONDS * 1000);
  });
});

describe('⭐ the three token kinds cannot be swapped', () => {
  /*
   * The property that makes this safe to add. Three signers now share one secret, and the
   * thing that keeps them apart is the derivation label — not a claim any of them checks.
   *
   * ⚠️ A quotation link accepted as an access token would be a session belonging to nobody;
   * an access token accepted as a quotation link would let any signed-in person read any
   * order by pasting their own token into the URL. Both are one shared key away.
   */
  it('⭐ a document link is not an access token', () => {
    const link = links.issue(ORDER).token;

    expect(access.verify(link).ok).toBe(false);
  });

  it('⭐ an access token is not a document link', () => {
    const token = access.sign({ userId: randomUUID(), sessionId: randomUUID() }).token;

    expect(links.verify(token).ok).toBe(false);
  });

  it('⭐ an MFA challenge is not a document link, and the reverse', () => {
    expect(links.verify(challenges.issue(randomUUID()).token).ok).toBe(false);
    expect(challenges.verify(links.issue(ORDER).token).ok).toBe(false);
  });
});

describe('rubbish in the URL is a refusal, never a throw', () => {
  /*
   * Everything here arrives from a URL somebody typed, a chat client mangled, or a scanner
   * generated. A parse that throws is a 500 and a stack trace in the logs for every one of
   * them.
   */
  it.each([
    ['empty', ''],
    ['not a token', 'hello'],
    ['two segments', 'a.b'],
    ['four segments', 'a.b.c.d'],
    ['payload is not base64', `${'a'.repeat(8)}.!!!.${'c'.repeat(8)}`],
    ['payload is not JSON', 'eyJhbGciOiJIUzI1NiJ9.bm90LWpzb24.c2ln'],
  ])('refuses %s', (_name, token) => {
    expect(() => links.verify(token)).not.toThrow();
    expect(links.verify(token).ok).toBe(false);
  });

  it('⚠️ refuses a signed token whose subject is not a uuid', () => {
    /*
     * Belt and braces against the id going straight into a query. `ScopedOrderRepository`
     * already checks `isUuid` before it builds one, and this keeps a malformed subject from
     * reaching that far in the first place.
     */
    const issued = links.issue('not-a-uuid');

    expect(links.verify(issued.token).ok).toBe(false);
  });
});
