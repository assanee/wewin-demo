import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, createPool, type Database, type Pool } from '@wewin/db/client';
import type { OrderDocumentWire, OrderLineRequestWire, OrderWire } from '@wewin/contract/order';

import { DocumentLinkService } from '../../src/orders/document-link';
import { testSessionConfig } from '../support/app';
import {
  bootPaymentsApp,
  client,
  liveLine,
  makeActor,
  paymentsEnv,
  submittedOrder,
  type Actor,
  type Json,
  type PaymentsApp,
} from '../payments/support/payments-app';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ THE CUSTOMER READING THE EMAIL HAS NO COOKIE.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * This file exists because of a claim that turned out to be false. `GET /orders/:id/document`
 * was described as "already ready for an email link"; it is not, and could not be. Ownership
 * is `customer_user_id = me` or `guest_id = my cookie`, and neither travels to the phone the
 * customer opens the mail on. `orders_submitted_has_a_contact_channel` demands an email
 * address on a submitted order and demands **no account at all** — so a guest who typed an
 * address on a laptop is the ordinary case, not the edge one.
 *
 * The assertions are all about one boundary, from both sides:
 *
 *   ⓵ **carrying nothing** — no cookie, no bearer — the token reads that one order. A test
 *     that sent any credential would prove nothing, because the credential would be doing
 *     the work.
 *   ⓶ a token for order A reads order A and never order B.
 *   ⓷ the ordinary cookie route is **unchanged**. This round adds a door; it must not widen
 *     one.
 *
 * ⚠️ Over real HTTP against a real Postgres. The ownership term is a WHERE clause and the
 * policy is a boot-audited guard; neither is observable from a service call, and the failure
 * that matters — a route that quietly accepts something else as proof — lives exactly there.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

const tag = randomUUID().slice(0, 8);
const contactFor = (who: string): { email: string; name: string } => ({
  email: `doclink-${who}-${tag}@probe.invalid`,
  name: `document link probe ${tag}`,
});

describeWithPg('⭐ a quotation link is read by somebody carrying nothing', () => {
  let pool: Pool;
  let db: Database;
  let app: PaymentsApp;
  let call: ReturnType<typeof client>;
  let links: DocumentLinkService;
  let customer: Actor;
  let staff: Actor;
  let line: OrderLineRequestWire;

  beforeAll(async () => {
    pool = createPool(url ?? '');
    db = createDatabase(pool);
    /*
     * ⚠️ One config, handed to both. `testSessionConfig()` mints a fresh random key on every
     * call, so building one here and letting the app build its own would sign with two
     * different keys — and every assertion below would fail on a token that is perfectly
     * valid.
     */
    const session = testSessionConfig();
    app = await bootPaymentsApp(paymentsEnv(url ?? ''), session);
    call = client(app.baseUrl);
    links = new DocumentLinkService(session);
    customer = await makeActor(db, app, `doclink customer ${tag}`, []);
    staff = await makeActor(db, app, `doclink staff ${tag}`, ['orders.read']);
    line = await liveLine(call);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  const order = (who: string): Promise<OrderWire> =>
    submittedOrder(call, customer, line, contactFor(who));

  const byLink = (token: string): Promise<Json> => call('GET', `/orders/documents/${token}`);

  it('⭐ serves the pinned document to a caller with no cookie and no bearer', async () => {
    const mine = await order('a');

    const answer = await byLink(links.issue(mine.id).token);

    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    const body = answer.body as { readonly orderNo: string | null; readonly document: OrderDocumentWire };
    expect(body.orderNo).toBe(mine.orderNo);
    expect(body.document.lines.length).toBeGreaterThan(0);
  });

  it('⭐ a token for one order never reads another', async () => {
    /*
     * ⓶. The id is inside the signature, so this is really a test that the handler takes it
     * from the **verified token** and from nowhere else — not a path parameter, not a query
     * string, not a header. Any of those beside a valid signature puts every quotation the
     * company has ever issued one increment away.
     */
    const mine = await order('b');
    const theirs = await order('c');

    const answer = await byLink(links.issue(theirs.id).token);
    const body = answer.body as { readonly orderNo: string | null };

    expect(answer.status).toBe(200);
    expect(body.orderNo).toBe(theirs.orderNo);
    expect(body.orderNo).not.toBe(mine.orderNo);
  });

  it('⭐ ignores an order id offered beside the token', async () => {
    /*
     * ⚠️ This test exists because the obvious version of it does not work.
     *
     * Rewriting the handler to read `sub` out of the payload it just verified is a *sound*
     * change — the signature was checked first, so the two values are always equal — and no
     * assertion above can tell the difference. The failure worth guarding is a different
     * shape: the handler growing a **second** way to name the order, beside the signature.
     * A `?order=`, a header, a path segment. Each looks harmless in a diff and each turns one
     * valid link into a reader for every quotation the company has issued.
     *
     * So this sends exactly that: a real token for one order, and somebody else's id beside
     * it. The right answer is that the parameter is not even looked at.
     */
    const mine = await order('g');
    const theirs = await order('h');

    const answer = await call(
      'GET',
      `/orders/documents/${links.issue(mine.id).token}?order=${theirs.id}&orderId=${theirs.id}&id=${theirs.id}`,
    );
    const body = answer.body as { readonly orderNo: string | null };

    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(body.orderNo).toBe(mine.orderNo);
    expect(body.orderNo).not.toBe(theirs.orderNo);
  });

  it('⚠️ answers 404 for anything that is not one of our tokens', async () => {
    expect((await byLink('not-a-token')).status).toBe(404);
    expect((await byLink(randomUUID())).status).toBe(404);
  });

  it('⚠️ answers 404 for a well-signed token naming an order that does not exist', async () => {
    /*
     * The same answer as a bad signature, deliberately — the reasoning
     * `scoped-order.repository.ts` gives for collapsing "missing" and "not yours" into one
     * reply. Two different codes here would let a holder of one valid link probe for others.
     */
    expect((await byLink(links.issue(randomUUID()).token)).status).toBe(404);
  });

  it('⚠️ answers 404 for an order that has never been submitted', async () => {
    /*
     * A cart has no pinned document. Nothing emails a draft, so the link cannot arise in
     * practice — but a token is derivable for any id, so the handler is asked anyway.
     */
    const created = await call('POST', '/orders', { token: customer.token, body: {} });
    const draft = created.body as OrderWire;

    expect((await byLink(links.issue(draft.id).token)).status).toBe(404);
  });

  it('⚠️ refuses an expired token', async () => {
    const mine = await order('d');
    const longAgo = Date.now() - 400 * 24 * 60 * 60 * 1000;

    expect((await byLink(links.issue(mine.id, longAgo).token)).status).toBe(404);
  });

  it('⭐ does not accept an access token in the token position', async () => {
    /*
     * The failure that would matter most, and the reason the signing key is domain-separated
     * rather than shared behind a `purpose` claim: any signed-in person could otherwise read
     * any order by pasting their own bearer into the URL.
     */
    const mine = await order('e');

    expect((await byLink(customer.token)).status).toBe(404);
    expect((await byLink(staff.token)).status).toBe(404);
    /* And the order *is* readable by its own link — so the two 404s above are the check. */
    expect((await byLink(links.issue(mine.id).token)).status).toBe(200);
  });

  it('⭐ hands staff the same link, so a phone-only customer can be sent one by hand', async () => {
    /*
     * An order with a telephone number and no address receives **nothing**: the fan-out
     * resolves recipients for email alone and suppresses the rest. That is a real gap and
     * this route is how it is survived rather than hidden — staff copy the link and paste it
     * into LINE.
     *
     * ⚠️ The URL is built by the API, not by the dashboard, and this is what pins it: the
     * token needs the signing key and the origin needs the deployment's configuration. A
     * client concatenating its own base URL would be a second opinion about where the
     * storefront is.
     */
    const mine = await order('i');

    const answer = await call('GET', `/orders/${mine.id}/customer-link`, { token: staff.token });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);

    const body = answer.body as { readonly url: string; readonly expiresAt: string };
    const url = new URL(body.url);
    const opened = await byLink(url.searchParams.get('t') ?? '');

    /* ⭐ The link staff copy is the link that works. Asserted by following it. */
    expect(opened.status).toBe(200);
    expect((opened.body as { orderNo: string | null }).orderNo).toBe(mine.orderNo);
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());
  });

  it('⭐ refuses the link to a caller without orders.read', async () => {
    /*
     * The route hands out a bearer credential for somebody else's quotation. `RequirePrincipal`
     * would let the *customer* fetch their own — harmless — and would also let any signed-in
     * stranger fetch anybody's, because the token is minted from the id in the path.
     */
    const mine = await order('j');

    expect((await call('GET', `/orders/${mine.id}/customer-link`)).status).toBe(401);
    expect((await call('GET', `/orders/${mine.id}/customer-link`, { token: customer.token })).status).toBe(403);
  });

  it('⚠️ leaves the id-addressed route exactly as it was', async () => {
    /*
     * ⓷. A caller with no credential still gets nothing from the route the dashboard and the
     * owning browser use. Adding a door must not widen one.
     */
    const mine = await order('f');

    expect((await call('GET', `/orders/${mine.id}/document`)).status).toBe(401);
    expect((await call('GET', `/orders/${mine.id}/document`, { token: customer.token })).status).toBe(200);
  });
});
