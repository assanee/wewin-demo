import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  cancelOrder,
  cancellationOffer,
  fetchCancellationPreview,
  openChangeRequest,
  orderActionsFrom,
  withdrawChangeRequest,
} from '../src/lib/orders/actions';

/**
 * A customer acting on their own order — the two properties that must be provably able to fail.
 *
 *   1. **A customer is never offered a cancellation they are not permitted to make**, and the
 *      authority for that is `order_status_transitions`, not a list retyped in this app.
 *   2. **No request this app sends can carry `fault`**, in any spelling, because `fault` decides
 *      how much money is kept.
 *
 * ⚠️ `environment: 'node'` and there is no jsdom in this package, so nothing here renders a
 * component. What is tested is the two pure functions that decide which button exists and the
 * four functions that build the requests — which is where both properties actually live. The
 * rendering is verified in a browser.
 */

const originalBase = process.env.NEXT_PUBLIC_API_BASE_URL;

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_BASE_URL = 'https://api.example';
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalBase === undefined) delete process.env.NEXT_PUBLIC_API_BASE_URL;
  else process.env.NEXT_PUBLIC_API_BASE_URL = originalBase;
});

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** Every request the code under test made, as `[url, init]` pairs. */
function spyOnFetch(...responses: readonly Response[]): ReturnType<typeof vi.fn> {
  const spy = vi.fn();
  for (const response of responses) spy.mockResolvedValueOnce(response);
  vi.stubGlobal('fetch', spy);
  return spy;
}

const sentBody = (spy: ReturnType<typeof vi.fn>, call = 0): Record<string, unknown> => {
  const [, init] = spy.mock.calls[call] as [string, RequestInit];
  return JSON.parse(String(init.body)) as Record<string, unknown>;
};

/* ================================================================ *
 * 1. Which cancellation is offered
 * ================================================================ */

describe('the cancellation a customer is offered', () => {
  const edge = (payloadKind: string) => ({
    toStatus: 'cancelled',
    eventType: 'cancelled',
    payloadKind,
    descriptionTh: 'ทดสอบ',
  });

  it('offers nothing when the server offers no cancelled edge', () => {
    /*
     * ⭐ The load-bearing case. `availableTransitions` is the API's answer to "what may *this*
     * actor do", already filtered by actor kind against `allowed_actor_kinds`. An order whose
     * list has no `cancelled` edge is one this caller may not cancel — because of their status,
     * their actor kind, or both — and the button must not exist.
     */
    expect(cancellationOffer([])).toStrictEqual({ kind: 'none' });
    expect(
      cancellationOffer([
        { toStatus: 'awaiting_payment', eventType: 'submitted_for_payment', payloadKind: 'submit', descriptionTh: '' },
        { toStatus: 'in_production', eventType: 'production_started', payloadKind: 'none', descriptionTh: '' },
      ]),
    ).toStrictEqual({ kind: 'none' });
  });

  it('splits on the payload kind, which is what the table splits on', () => {
    expect(cancellationOffer([edge('cancel_pre_freeze')])).toStrictEqual({ kind: 'pre-freeze' });
    expect(cancellationOffer([edge('cancel_post_freeze')])).toStrictEqual({ kind: 'post-freeze' });
  });

  /**
   * An unrecognised shape offers nothing rather than guessing a body.
   *
   * If a migration ever adds a third cancellation payload kind, this build does not know what
   * body it takes — and a button that posts the wrong body to a route that cancels an order is
   * worse than a missing button. The SQL-pinned test below is what makes anybody notice.
   */
  it('offers nothing for a payload kind this build does not know', () => {
    expect(cancellationOffer([edge('cancel_with_new_rules')])).toStrictEqual({ kind: 'none' });
    expect(cancellationOffer(undefined)).toStrictEqual({ kind: 'none' });
    expect(cancellationOffer('cancelled')).toStrictEqual({ kind: 'none' });
  });

  it('does not look at the order status', () => {
    /*
     * A `delivered` order with — hypothetically — a cancelled edge would be offered one, and an
     * `in_production` order without one would not. That is the point: the status is not the
     * authority, the row is. A regression here would look like reading `summary.status`.
     */
    const offered = orderActionsFrom('order-1', {
      status: 'delivered',
      availableTransitions: [edge('cancel_post_freeze')],
      openChangeRequest: null,
    });
    expect(offered.cancellation).toStrictEqual({ kind: 'post-freeze' });

    const withheld = orderActionsFrom('order-1', {
      status: 'in_production',
      availableTransitions: [],
      openChangeRequest: null,
    });
    expect(withheld.cancellation).toStrictEqual({ kind: 'none' });
  });

  it('reads an open objection, and ignores a resolved one', () => {
    const open = orderActionsFrom('order-1', {
      availableTransitions: [],
      openChangeRequest: {
        id: 'cr-1',
        noteTh: 'ขอเปลี่ยนสี',
        openedAt: '2026-08-09T04:05:06.000Z',
        resolution: null,
        resolvedAt: null,
      },
    });
    expect(open.openChangeRequest?.id).toBe('cr-1');

    /* A resolved request is history; offering to withdraw it would be a 409. */
    const answered = orderActionsFrom('order-1', {
      availableTransitions: [],
      openChangeRequest: {
        id: 'cr-1',
        noteTh: 'ขอเปลี่ยนสี',
        openedAt: '2026-08-09T04:05:06.000Z',
        resolution: 'accepted',
        resolvedAt: '2026-08-10T04:05:06.000Z',
      },
    });
    expect(answered.openChangeRequest).toBeNull();
  });
});

/* ================================================================ *
 * 2. The table is the authority — pinned against the migration
 * ================================================================ */

/**
 * ⭐ THE SIX CANCELLATIONS, READ OUT OF THE MIGRATION RATHER THAN RETYPED.
 *
 * `cancellationOffer` recognises exactly two payload kinds. That is only correct while the
 * transitions table grants customers exactly those two, so this reads
 * `0007_order_guards.sql` — the file that seeds the table — and checks the claim against it.
 *
 * The failure this is for: somebody adds a `('delivered', 'cancelled', …, 'cancel_after_delivery')`
 * row with `customer` in its actor kinds. The API would then offer that edge, `cancellationOffer`
 * would answer `'none'`, and the customer would silently lose a right the database granted them.
 * A list of statuses in this app would not have noticed at all.
 */
describe('the transitions table, as the source of the two kinds', () => {
  const sql = readFileSync(
    resolve(process.cwd(), '../../packages/db/drizzle/0007_order_guards.sql'),
    'utf8',
  );

  /** The `INSERT INTO order_status_transitions … VALUES (…)` tuples, one string each. */
  const tuples = (() => {
    const start = sql.indexOf('INSERT INTO order_status_transitions');
    expect(start, 'the transitions seed moved out of 0007').toBeGreaterThan(-1);

    const body = sql.slice(start, sql.indexOf('--> statement-breakpoint', start));
    return body.split('\n  (').slice(1);
  })();

  /** Only the cancellations a customer or a guest is granted. */
  const customerCancellations = tuples.filter(
    (tuple) =>
      tuple.includes("'cancelled'") &&
      /\{[^}]*\b(customer|guest)\b[^}]*\}/u.test(tuple) &&
      tuple.includes('cancel_'),
  );

  it('grants a customer or guest exactly six cancellations', () => {
    /*
     * Six, and the brief that asked for this work said the table grants six transitions in
     * total — it grants **seven**. The seventh is `draft → awaiting_payment`, the submit, which
     * `lib/quote/submit.ts` has posted since the funnel was built. Six is the number of
     * *cancellations*, which is what had no caller.
     */
    expect(customerCancellations).toHaveLength(6);
  });

  it('uses only the two payload kinds this app knows how to build a body for', () => {
    const kinds = new Set(
      customerCancellations.map((tuple) => {
        const found = /'(cancel_[a-z_]+)'/u.exec(tuple);
        expect(found, `no payload kind in: ${tuple.slice(0, 80)}`).not.toBeNull();
        return found?.[1];
      }),
    );

    expect([...kinds].sort()).toStrictEqual(['cancel_post_freeze', 'cancel_pre_freeze']);

    /* And each one is a kind `cancellationOffer` answers with something other than 'none'. */
    for (const payloadKind of kinds) {
      expect(
        cancellationOffer([{ toStatus: 'cancelled', eventType: 'cancelled', payloadKind, descriptionTh: '' }]),
        `${payloadKind} is granted to customers but this app offers nothing for it`,
      ).not.toStrictEqual({ kind: 'none' });
    }
  });

  /**
   * ⚠️ `redesign` is among them — plan 7.8 calls it the one everybody forgets.
   *
   * Named explicitly rather than counted, because a count of six stays six if somebody swaps
   * `redesign` for a status they found easier to reason about.
   */
  it('includes every status the table says, redesign among them', () => {
    const from = customerCancellations
      .map((tuple) => /^'([a-z_]+)'/u.exec(tuple)?.[1])
      .sort();

    expect(from).toStrictEqual([
      'awaiting_installation',
      'awaiting_payment',
      'draft',
      'in_production',
      'production_confirmed',
      'redesign',
    ]);
  });
});

/* ================================================================ *
 * 3. What goes on the wire
 * ================================================================ */

describe('the requests a customer actually sends', () => {
  it('cancels with a reason and nothing else', async () => {
    const spy = spyOnFetch(jsonResponse({ status: 'cancelled' }));

    const result = await cancelOrder('order-1', '  เปลี่ยนใจ  ', 'token-1');
    expect(result).toStrictEqual({ ok: true, data: { status: 'cancelled' } });

    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example/orders/order-1/transitions/cancelled');
    expect(init.method).toBe('POST');

    /*
     * 🔒 THE ASSERTION THAT MATTERS. `fault` decides how much money is kept and is derived on
     * the server from the actor and the append-only spine. A body with exactly one key is the
     * only body that cannot influence it — `toStrictEqual` and not a `fault`-shaped
     * `not.toHaveProperty`, because the next hole would be spelled something else.
     */
    expect(sentBody(spy)).toStrictEqual({ reason: 'เปลี่ยนใจ' });
  });

  it('sends both the cookie and the bearer token', async () => {
    const spy = spyOnFetch(jsonResponse({ status: 'cancelled' }));
    await cancelOrder('order-1', 'เปลี่ยนใจ', 'token-1');

    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    /*
     * The cookie carries a guest's ownership, the header carries a customer's. Dropping either
     * makes this function serve only half the storefront — and the failure is a 404 that looks
     * like a missing order rather than a missing credential.
     */
    expect(init.credentials).toBe('include');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer token-1');
    expect(init.cache).toBe('no-store');
  });

  it('raises an objection with a trimmed note and nothing else', async () => {
    const spy = spyOnFetch(
      jsonResponse(
        { id: 'cr-1', noteTh: 'ขอเปลี่ยนสี', openedAt: '2026-08-09T04:05:06.000Z', resolution: null, resolvedAt: null },
        201,
      ),
    );

    const result = await openChangeRequest('order-1', '  ขอเปลี่ยนสี  ', 'token-1');
    expect(result.ok).toBe(true);

    const [url] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example/orders/order-1/change-requests');
    expect(sentBody(spy)).toStrictEqual({ noteTh: 'ขอเปลี่ยนสี' });
  });

  it('withdraws with the one resolution a customer may post', async () => {
    const spy = spyOnFetch(jsonResponse({ id: 'cr-1', noteTh: null, openedAt: '2026-08-09T04:05:06.000Z', resolution: 'withdrawn', resolvedAt: '2026-08-09T05:00:00.000Z' }));

    const result = await withdrawChangeRequest('order-1', 'cr-1', 'token-1');
    expect(result).toStrictEqual({ ok: true, data: { resolution: 'withdrawn' } });

    const [url] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example/orders/order-1/change-requests/cr-1/resolution');
    /* `accepted` and `rejected` are staff answers — the service 403s a customer who sends one. */
    expect(sentBody(spy)).toStrictEqual({ resolution: 'withdrawn' });
  });
});

/* ================================================================ *
 * 4. The figure
 * ================================================================ */

describe('the priced preview', () => {
  const money = (digits: string) => ({ unit: 'THB.satang', digits });

  it('reads all three figures as satang', async () => {
    spyOnFetch(
      jsonResponse({
        fromStatus: 'in_production',
        heldThbMinor: money('1843267'),
        forfeitThbMinor: money('921634'),
        refundThbMinor: money('921633'),
      }),
    );

    const result = await fetchCancellationPreview('order-1', 'token-1');
    expect(result).toStrictEqual({
      ok: true,
      data: {
        fromStatus: 'in_production',
        heldThbMinor: 1_843_267n,
        forfeitThbMinor: 921_634n,
        refundThbMinor: 921_633n,
      },
    });
  });

  /**
   * ⚠️ A missing forfeit is `malformed`, never ฿0.00.
   *
   * This is the one decode failure in the file with a money consequence: a preview whose forfeit
   * did not decode, defaulted to zero, is a screen telling somebody their cancellation is free
   * on the strength of a field that never arrived.
   */
  it('refuses a preview whose forfeit did not decode', async () => {
    spyOnFetch(
      jsonResponse({
        fromStatus: 'in_production',
        heldThbMinor: money('1843267'),
        forfeitThbMinor: { unit: 'THB', digits: '921634' },
        refundThbMinor: money('921633'),
      }),
    );

    const result = await fetchCancellationPreview('order-1', 'token-1');
    expect(result).toStrictEqual({ ok: false, problem: 'malformed' });
  });

  /** A 409 means the order moved; the API's own sentence is better than anything local. */
  it('passes the API sentence through on a refusal', async () => {
    spyOnFetch(
      jsonResponse({ error: { message: 'ออร์เดอร์นี้ยกเลิกจากสถานะปัจจุบันไม่ได้' } }, 409),
    );

    const result = await fetchCancellationPreview('order-1', 'token-1');
    expect(result).toStrictEqual({
      ok: false,
      problem: 'refused',
      detail: 'ออร์เดอร์นี้ยกเลิกจากสถานะปัจจุบันไม่ได้',
    });
  });

  it('reports an expired session as unauthorized rather than refused', async () => {
    spyOnFetch(jsonResponse({ error: { message: 'ไม่ได้เข้าสู่ระบบ' } }, 401));

    const result = await fetchCancellationPreview('order-1', 'token-1');
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.problem).toBe('unauthorized');
  });
});

/* ================================================================ *
 * 5. The emailed link stays read-only
 * ================================================================ */

/**
 * ⭐ `?t=` MUST NOT ACQUIRE AN ACTION, and this is the test that says so.
 *
 * `LinkedDocumentWire` carries no order UUID — `document-link.controller.ts` refuses
 * `/orders/{id}?t=…` so that a valid signature beside a chosen id cannot become every quotation
 * the company has issued. `decodeQuotation` therefore sets `actions: null`, and the only place an
 * `OrderActions` is built is the owned branch, from an id that came out of `?order=`.
 *
 * Asserted by reading the source, because this package cannot render the component and the
 * property is about which call site exists.
 */
describe('the emailed document link', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/lib/quotation/api.ts'), 'utf8');
  /* ⚠️ Comments stripped first — this file's own prose quotes the strings being forbidden. */
  const code = source.replaceAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, '');

  it('builds order actions only on the owned branch', () => {
    /* One call site, and it takes its id from `source.orderId` — never from the response body. */
    expect(code.match(/orderActionsFrom\(/gu)).toHaveLength(1);
    expect(code).toContain('orderActionsFrom(source.orderId, summary)');
  });

  it('defaults the decoder to no actions at all', () => {
    expect(code).toContain('actions: null');
  });

  it('never reads an id out of a document-link response', () => {
    /*
     * The token branch's decode must not start reaching for an `id`. If `LinkedDocumentWire` ever
     * grows one, that is a conversation about the security property, not a silent client change.
     */
    /*
     * ⚠️ Both markers are *code*, not comments — the slice is taken from the comment-stripped
     * copy, so anchoring the end on `/* Owned` (as this test first did) ran to end-of-file and
     * quietly swallowed the owned branch, passing for the wrong reason.
     */
    const from = code.indexOf("source.kind === 'token'");
    const to = code.indexOf('const [order, document] = await Promise.all');
    expect(from, 'the token branch moved').toBeGreaterThan(-1);
    expect(to, 'the owned branch moved').toBeGreaterThan(from);

    const tokenBranch = code.slice(from, to);
    expect(tokenBranch).not.toContain('orderActionsFrom');
    expect(tokenBranch).not.toContain("body['id']");
  });
});
