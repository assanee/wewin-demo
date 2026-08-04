import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, createPool, type Database, type Pool } from '@wewin/db/client';
import { sql } from '@wewin/db/sql';
import { orderDocumentProductVersions } from '@wewin/db/schema';
import { products } from '@wewin/core/fixtures';
import type { Product } from '@wewin/core';
import { encodeUm } from '@wewin/contract/measure';
import { toBigInt } from '@wewin/contract/exact';
import type { OrderEventListWire, OrderLineRequestWire, OrderWire } from '@wewin/contract/order';

import { IdentityLinkService } from '../../src/auth/oauth/identity-link.service';
import { RouteRegistryService } from '../../src/rbac/route-registry.service';
import {
  bootLifecycleApp,
  client,
  lifecycleEnv,
  makeActor,
  type Actor,
  type Json,
  type LifecycleApp,
} from '../orders/support/lifecycle-app';

/**
 * RED TEAM 5 — phase 5a's order lifecycle, attacked over real HTTP against real Postgres.
 *
 * Every `it` is an attack and asserts *what actually happens*, not what should. Where the
 * defence holds, the assertion is the defence. Where it does not, the assertion pins the
 * hole. Nothing here fixes anything.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

const tag = randomUUID().slice(0, 8);
const contactFor = (who: string): { email: string; name: string } => ({
  email: `rt5-${who}-${tag}@probe.invalid`,
  name: `red team 5 ${tag}`,
});

const cookieHeader = (setCookie: string | null): string => {
  const first = setCookie?.split(';')[0];
  if (first === undefined) throw new Error('no cookie was set');
  return first;
};

/**
 * The guest id out of a `name=id.secret` cookie.
 *
 * A function rather than a `split('=')[1]` at each site, because the value stopped being the
 * id the day it gained a secret and every one of those sites started passing an `id.secret`
 * string into a `uuid` column. That is the sort of edit that makes a suite red for a reason
 * unrelated to what it is testing.
 */
const guestIdOf = (cookie: string): string => (cookie.split('=')[1] ?? '').split('.')[0] ?? '';

describeWithPg('RED TEAM 5: getting at an order that is not yours', () => {
  let pool: Pool;
  let db: Database;
  let app: LifecycleApp;
  let call: ReturnType<typeof client>;

  let staff: Actor;
  let writeOnly: Actor;
  let victim: Actor;
  let attacker: Actor;

  /** A line the running catalogue accepts, plus the fixture product behind it. */
  let line: OrderLineRequestWire;
  let lineProduct: Product;

  beforeAll(async () => {
    pool = createPool(url ?? '');
    db = createDatabase(pool);

    app = await bootLifecycleApp(lifecycleEnv(url ?? ''));
    call = client(app.baseUrl);

    staff = await makeActor(db, app, `rt5 staff ${tag}`, ['orders.read', 'orders.write']);
    writeOnly = await makeActor(db, app, `rt5 writeonly ${tag}`, ['orders.write']);
    victim = await makeActor(db, app, `rt5 victim ${tag}`, []);
    attacker = await makeActor(db, app, `rt5 attacker ${tag}`, []);

    const built = await liveLine(call);
    line = built.line;
    lineProduct = built.product;
  }, 60_000);

  afterAll(async () => {
    /*
     * ⚠️ Deleting citation rows was a workaround for `seedCatalog` refusing to run on a
     * database that carries a contract, and it is no longer needed: `globalSetup` creates
     * this suite's database empty on every run (`tests/test-db.ts`). Left in place only
     * where it is harmless, because a red-team file that has to remember to launder evidence
     * is the wrong shape — see the note in `tests/orders/lifecycle.pg.test.ts`.
     */
    await db.delete(orderDocumentProductVersions).where(sql`
      order_document_id in (
        select d.id from order_documents d
          join orders o on o.id = d.order_id
         where o.contact_email like 'rt5-%@probe.invalid'
      )
    `);
    await app.close();
    await pool.end();
  });

  /* ------------------------------------------------------------------ */

  const create = (auth: { token?: string; cookie?: string }): Promise<Json> =>
    call('POST', '/orders', { ...auth, body: {} });

  const move = (
    orderId: string,
    toStatus: string,
    auth: { token?: string; cookie?: string },
    body: unknown = {},
  ): Promise<Json> => call('POST', `/orders/${orderId}/transitions/${toStatus}`, { ...auth, body });

  const submitWith = (
    orderId: string,
    auth: { token?: string; cookie?: string },
    who: string,
    lines: readonly OrderLineRequestWire[],
  ): Promise<Json> => move(orderId, 'awaiting_payment', auth, { contact: contactFor(who), lines });

  /** A submitted order owned by the victim. */
  const victimOrder = async (who: string): Promise<OrderWire> => {
    const created = await create({ token: victim.token });
    expect(created.status).toBe(201);
    const draft = created.body as OrderWire;
    const submitted = await submitWith(draft.id, { token: victim.token }, who, [line]);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    return submitted.body as OrderWire;
  };

  /* ================================================================== *
   * ① The straightforward cross-tenant sweep — every order route
   * ================================================================== */

  describe('① every registered order route, called with somebody else\'s id', () => {
    it('never answers 2xx and never echoes a marker from the victim\'s row', async () => {
      const order = await victimOrder('sweep');

      const opened = await call('POST', `/orders/${order.id}/change-requests`, {
        token: victim.token,
        body: { noteTh: `red team 5 objection ${tag}` },
      });
      expect(opened.status).toBe(201);
      const changeRequestId = (opened.body as { id: string }).id;

      const registry = app.app.get(RouteRegistryService);
      const orderRoutes = registry
        .records()
        .flatMap((record) => record.keys)
        .filter((key) => /\border/i.test(key) && key.includes(':') && !key.includes('*'))
        .map((key) => {
          const space = key.indexOf(' ');
          return { method: key.slice(0, space), path: key.slice(space + 1) };
        });
      expect(orderRoutes.length).toBeGreaterThan(0);

      const attackerGuest = await create({});
      const attackerCookie = cookieHeader(attackerGuest.headers.get('set-cookie'));

      const impostors: { label: string; auth: { token?: string; cookie?: string } }[] = [
        { label: 'another signed-in customer', auth: { token: attacker.token } },
        { label: 'an unrelated guest', auth: { cookie: attackerCookie } },
        { label: 'nobody at all', auth: {} },
      ];

      const marker = contactFor('sweep').email;
      const leaks: string[] = [];
      const seen: string[] = [];

      for (const route of orderRoutes) {
        const path = route.path
          .replace(':orderId', order.id)
          .replace(':changeRequestId', changeRequestId)
          .replace(/:toStatus/, 'cancelled');

        for (const impostor of impostors) {
          /*
           * A body each route would *accept* from its owner. With `{}` the two
           * change-request routes answer 400 from the body pipe before the ownership term
           * ever runs, and a sweep that never reaches the check proves nothing about it.
           */
          const body = route.path.endsWith('/resolution')
            ? { resolution: 'withdrawn' }
            : route.path.endsWith('/change-requests')
              ? { noteTh: `red team 5 impostor ${tag}` }
              : { reason: `red team 5 impostor ${tag}` };

          const answer = await call(route.method, path, {
            ...impostor.auth,
            ...(route.method === 'POST' ? { body } : {}),
          });
          const text = JSON.stringify(answer.body ?? '');
          seen.push(`${route.method} ${route.path} as ${impostor.label} → ${String(answer.status)}`);

          if (answer.status >= 200 && answer.status < 300) {
            leaks.push(`${route.method} ${path} as ${impostor.label} → ${String(answer.status)}`);
          }
          if (text.includes(marker) || text.includes(order.orderNo ?? ' ')) {
            leaks.push(`${route.method} ${path} as ${impostor.label} echoed the victim's row`);
          }
        }
      }

      expect(leaks, leaks.join('\n')).toEqual([]);

      // Not vacuous: say out loud what was actually swept.
      /*
       * Printed rather than merely counted. The interesting evidence is that the POST
       * transition answers 404 and not 400: the body is only parsed *after* the scoped
       * `FOR UPDATE` load, so an impostor never reaches the payload schema at all. A 400
       * here would have meant the schema was chosen before the row was.
       */
      // eslint-disable-next-line no-console
      console.log(`RT5 ① swept ${String(orderRoutes.length)} routes:\n  ${seen.join('\n  ')}`);
    }, 120_000);

    it('cannot resolve the victim\'s change request by hanging it off an order the attacker owns', async () => {
      const order = await victimOrder('child-swap');
      const opened = await call('POST', `/orders/${order.id}/change-requests`, {
        token: victim.token,
        body: { noteTh: `red team 5 child swap ${tag}` },
      });
      expect(opened.status).toBe(201);
      const victimChangeRequest = (opened.body as { id: string }).id;

      const mine = await create({ token: attacker.token });
      const myOrderId = (mine.body as OrderWire).id;

      const swapped = await call(
        'POST',
        `/orders/${myOrderId}/change-requests/${victimChangeRequest}/resolution`,
        { token: attacker.token, body: { resolution: 'withdrawn' } },
      );
      expect(swapped.status).toBe(404);

      // …and it is still open on the victim's order.
      const still = await call('GET', `/orders/${order.id}`, { token: victim.token });
      expect((still.body as OrderWire).openChangeRequest?.id).toBe(victimChangeRequest);
    });
  });

  /* ================================================================== *
   * ② The permission whose name understates it
   * ================================================================== */

  describe('② `orders.write` alone — "Create and advance orders"', () => {
    it('cannot GET a stranger\'s order …', async () => {
      const order = await victimOrder('writeonly-read');
      const read = await call('GET', `/orders/${order.id}`, { token: writeOnly.token });
      expect(read.status).toBe(404);
    });

    /**
     * ⚠️ This assertion is inverted from the one that found the hole, and that is the record.
     *
     * It used to read "… but reads the whole of it — contact, phone, money — out of a
     * transition response", and it passed: the write path ends in `decorate()`, so a holder
     * of `orders.write` alone got 404 from the GET and then the same order in full — contact
     * email, name, telephone, all four money figures, order number — in the 200 body of the
     * cancellation they had just written onto the append-only spine with their name on it.
     * They read by writing.
     *
     * The fix is not in this response. It is in `orderReach`: staff-wide reach now requires
     * `orders.read` for *both* intents and `orders.write` on top of it to act. Acting on an
     * order you may not read was never an authority anybody meant to grant — it also meant
     * that grant, described honestly, was "may cancel, bounce or supersede every order in
     * the company while unable to look at any of them". Both halves are gone together.
     */
    it('… and cannot reach it through the write path either — the write is a 404 as well', async () => {
      const order = await victimOrder('writeonly-write');

      const cancelled = await move(order.id, 'cancelled', { token: writeOnly.token }, {
        reason: 'red team 5: a write-only clerk cancelling a stranger\'s order',
      });

      expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(404);
      /* No marker of the victim's row anywhere in the refusal. */
      expect(JSON.stringify(cancelled.body)).not.toContain(contactFor('writeonly-write').email);
      expect(JSON.stringify(cancelled.body)).not.toContain(order.orderNo);

      /* And the order did not move: the refusal is the whole outcome. */
      const asVictim = await call('GET', `/orders/${order.id}`, { token: victim.token });
      expect((asVictim.body as OrderWire).status).toBe('awaiting_payment');
    });

    it('and a holder of both codes still can — the read-only clerk is what the split was for', async () => {
      const order = await victimOrder('bothcodes');
      const read = await call('GET', `/orders/${order.id}`, { token: staff.token });
      expect(read.status).toBe(200);
    });
  });

  /* ================================================================== *
   * ③ The guest cookie: a bearer capability, and what a claim does to it
   * ================================================================== */

  describe('③ the guest cookie', () => {
    it('is a bearer capability: whoever replays the id gets the cart, in full', async () => {
      const minted = await create({});
      expect(minted.status).toBe(201);
      const cookie = cookieHeader(minted.headers.get('set-cookie'));
      const draft = minted.body as OrderWire;

      const submitted = await submitWith(draft.id, { cookie }, 'guest-bearer', [line]);
      expect(submitted.status).toBe(200);

      // A second browser that holds the whole cookie value — no session, nothing else.
      const replay = await call('GET', `/orders/${draft.id}`, { cookie });
      expect(replay.status).toBe(200);
      expect((replay.body as OrderWire).contact.email).toBe(contactFor('guest-bearer').email);

      /*
       * …and holding only the *id* is now worth nothing. That is the change: the cookie is
       * `id.secret`, the id is what appears in log lines and in a shared browser's history,
       * and it alone no longer identifies anybody. A cart is still a bearer capability —
       * that is inherent to shopping without an account — but the bearer token is now a
       * secret rather than a name.
       */
      const [name = '', value = ''] = cookie.split('=');
      const idOnly = value.split('.')[0] ?? '';
      const nameOnly = await call('GET', `/orders/${draft.id}`, { cookie: `${name}=${idOnly}` });
      expect(nameOnly.status).toBe(401);
    });

    /**
     * ⚠️ Inverted, and this is the most valuable inversion in the file.
     *
     * This case used to be titled "a stolen cookie becomes a PERMANENT account-level grant
     * once the thief signs in, and the owner is locked out", and every assertion in it
     * passed. The chain was: learn a guest id (two log lines print them) → put it in your own
     * cookie jar → sign in → `claimGuest` succeeds → the victim's submitted order, with their
     * contact details on it, is readable from the attacker's account for ever, the victim's
     * own cookie answers 401, and their *later* sign-in returns `claimGuest === false`, which
     * `OAuthService.callback` treats as success. Working login, missing order, no incident.
     *
     * Two things changed, and the test now proves both. The cookie carries a secret, so a
     * bare id claims nothing; and the claim *attributes the guest's orders to the account*,
     * so the funnel's own conversion no longer orphans the row (which is what the
     * `includeClaimedGuests` rescue predicate used to paper over).
     */
    it('a stolen guest id claims nothing, and the real owner keeps the order through their own sign-in', async () => {
      // The victim's anonymous cart.
      const minted = await create({});
      const cookie = cookieHeader(minted.headers.get('set-cookie'));
      const guestId = guestIdOf(cookie);
      const draft = minted.body as OrderWire;
      const submitted = await submitWith(draft.id, { cookie }, 'claim-hijack', [line]);
      expect(submitted.status).toBe(200);

      // Before: the attacker's account has no reach over it at all.
      const before = await call('GET', `/orders/${draft.id}`, { token: attacker.token });
      expect(before.status).toBe(404);

      /*
       * The attacker knows the id — from a log line, a shared browser, an old cookie — and
       * puts it in their own jar. `OAuthStateService.knownGuest` is what the sign-in runs
       * against that cookie, and it now verifies the secret before the id is written to
       * `oauth_states.guest_id`, so the id never reaches `claimGuest` at all.
       */
      const bareCookie = `${cookie.split('=')[0] ?? ''}=${guestId}`;
      const asBareCookie = await call('GET', `/orders/${draft.id}`, { cookie: bareCookie });
      expect(asBareCookie.status).toBe(401);

      /*
       * And straight at the statement the callback makes, in case a future route ever hands
       * it an id from somewhere else: even a *successful* claim by the wrong account is now
       * an ownership transfer with a witness, because the backfill attributes the orders. So
       * this is the case that must not be reachable, and the check above is what stops it.
       * Here the *rightful* owner claims their own cart, which is the ordinary end of the
       * funnel, and the order follows them.
       */
      const claimed = await app.app.get(IdentityLinkService).claimGuest(guestId, victim.userId);
      expect(claimed).toBe(true);

      const asOwnerSignedIn = await call('GET', `/orders/${draft.id}`, { token: victim.token });
      expect(asOwnerSignedIn.status).toBe(200);
      expect((asOwnerSignedIn.body as OrderWire).contact.email).toBe(
        contactFor('claim-hijack').email,
      );

      const listed = await call('GET', '/orders', { token: victim.token });
      expect(
        (listed.body as { orders: readonly { id: string }[] }).orders.map((o) => o.id),
      ).toContain(draft.id);

      /* The attacker's account still reaches nothing, before or after. */
      const asAttacker = await call('GET', `/orders/${draft.id}`, { token: attacker.token });
      expect(asAttacker.status).toBe(404);

      /* A late claim by anybody else finds the row taken, and changes nothing. */
      const lateClaim = await app.app.get(IdentityLinkService).claimGuest(guestId, attacker.userId);
      expect(lateClaim).toBe(false);
      expect((await call('GET', `/orders/${draft.id}`, { token: attacker.token })).status).toBe(404);
    });

    it('refuses a live cookie on an order that a claim has attributed to an account', async () => {
      /*
       * ⚠️ Inverted. This used to be titled "the guest predicate has no `customer_user_id is
       * null` term — an unclaimed cookie reads an account-owned order", and it was filed as
       * *not reachable through today's API*, because nothing wrote `customer_user_id` on a
       * row that already had a `guest_id`.
       *
       * The claim backfill is exactly the thing that writes it. So the shape the red team
       * described as hypothetical is now produced on every conversion, and the missing term
       * went from a latent defect to a live one in the same commit that fixed something
       * else — which is the interesting part and the reason this case is kept.
       */
      const minted = await create({});
      const cookie = cookieHeader(minted.headers.get('set-cookie'));
      const guestId = guestIdOf(cookie);
      const draft = minted.body as OrderWire;
      const submitted = await submitWith(draft.id, { cookie }, 'two-owners', [line]);
      expect(submitted.status).toBe(200);

      // The backfill, as the schema comment describes it: add the user, leave the guest.
      await db.execute(
        sql`update orders set customer_user_id = ${victim.userId} where id = ${draft.id}`,
      );

      // The guest row is still unclaimed, so the cookie is still honoured …
      const stillOpen = await db.execute(
        sql`select claimed_by_user_id from guests where id = ${guestId}`,
      );
      expect(
        (stillOpen as unknown as { rows: readonly Record<string, unknown>[] }).rows[0]?.[
          'claimed_by_user_id'
        ],
      ).toBeNull();

      // … and it reaches nothing, because the order names an account now.
      const asCookie = await call('GET', `/orders/${draft.id}`, { cookie });
      expect(asCookie.status).toBe(404);
      expect(JSON.stringify(asCookie.body)).not.toContain(contactFor('two-owners').email);
    });
  });

  /* ================================================================== *
   * ④ Pricing your own contract — the submit endpoint
   * ================================================================== */

  describe('④ the pinned contract', () => {
    /**
     * ⚠️ Inverted, and it was the largest number in the round: 12,840 baht — 48% of the
     * order — on one lower-case option code, reachable by an anonymous guest.
     *
     * `pricing.ts` matched a selection against the catalogue's values *exactly* and, on no
     * match, contributed nothing at all ("better a missing surcharge than a crash", a
     * configurator decision that phase 5a promoted into a contract). `skuCode.ts`
     * upper-cased whatever string it was handed. So `control=mot` was priced as manual and
     * stamped `…-MOT`, byte-identical to the motorised contract, and the factory builds what
     * the stamp says.
     *
     * The fix is one resolution shared by both readers (`packages/core/src/selection.ts`):
     * exact match, then a unique case-insensitive match normalised to the catalogue's own
     * spelling, then the group default with `recognised: false` — which `validate()` turns
     * into a blocking error, so an unknown code cannot reach a document at all.
     */
    it('prices a lower-case option code as the option it names, and pins the SKU it charged for', async () => {
      const upgrade = pricedUpgrade(lineProduct);
      if (upgrade === undefined) throw new Error('no priced sku option in the fixture product');

      const honest: OrderLineRequestWire = {
        ...line,
        selections: { ...line.selections, [upgrade.groupCode]: upgrade.valueCode },
      };
      const tampered: OrderLineRequestWire = {
        ...line,
        selections: { ...line.selections, [upgrade.groupCode]: upgrade.valueCode.toLowerCase() },
      };

      const honestOrder = await create({ token: victim.token });
      const honestSubmit = await submitWith(
        (honestOrder.body as OrderWire).id,
        { token: victim.token },
        'price-honest',
        [honest],
      );
      expect(honestSubmit.status, JSON.stringify(honestSubmit.body)).toBe(200);

      const cheapOrder = await create({ token: victim.token });
      const cheapSubmit = await submitWith(
        (cheapOrder.body as OrderWire).id,
        { token: victim.token },
        'price-tampered',
        [tampered],
      );
      expect(cheapSubmit.status, JSON.stringify(cheapSubmit.body)).toBe(200);

      const paid = grandTotalOf(honestSubmit.body as OrderWire);
      const dodged = grandTotalOf(cheapSubmit.body as OrderWire);

      /*
       * Not one satang between them. The tampered order is the *honest* order — the code was
       * normalised to the catalogue's spelling and charged accordingly — which is a better
       * answer than a refusal: links and stored carts survive, and the money is right.
       */
      expect(dodged).toBe(paid);

      // And the two frozen documents name the same stocked variant, which is now the truth.
      const honestDoc = await call(
        'GET',
        `/orders/${(honestSubmit.body as OrderWire).id}/document`,
        { token: victim.token },
      );
      const cheapDoc = await call(
        'GET',
        `/orders/${(cheapSubmit.body as OrderWire).id}/document`,
        { token: victim.token },
      );
      const skuOf = (answer: Json): string =>
        (answer.body as { lines: readonly { skuCode: string }[] }).lines[0]?.skuCode ?? '';

      expect(skuOf(cheapDoc)).toBe(skuOf(honestDoc));

      // eslint-disable-next-line no-console
      console.log(
        `RT5 ④ ${lineProduct.id} ${upgrade.groupCode}=${upgrade.valueCode}: ` +
          `honest=${String(paid)} lower-case=${String(dodged)} ` +
          `difference=${String(paid - dodged)} satang, sku=${skuOf(cheapDoc)}`,
      );
    }, 60_000);

    it('refuses a selection that names nothing the product offers, rather than dropping the surcharge', async () => {
      /*
       * The other half of the same resolution. A code that is not a case variant of anything
       * cannot be guessed, so it is a blocking error — 422 — and never a document. Before the
       * fix it was priced as if the group had not been configured at all, silently.
       */
      const upgrade = pricedUpgrade(lineProduct);
      if (upgrade === undefined) throw new Error('no priced sku option in the fixture product');

      const nonsense: OrderLineRequestWire = {
        ...line,
        selections: { ...line.selections, [upgrade.groupCode]: 'NO_SUCH_OPTION' },
      };

      const order = await create({ token: victim.token });
      const answer = await submitWith(
        (order.body as OrderWire).id,
        { token: victim.token },
        'price-nonsense',
        [nonsense],
      );

      expect(answer.status, JSON.stringify(answer.body)).toBe(422);
      expect(JSON.stringify(answer.body)).toContain(`selection:${upgrade.groupCode}`);
    });
  });

  /* ================================================================== *
   * ⑤ Odds and ends that fall over
   * ================================================================== */

  describe('⑤ input that reaches a uuid column unchecked', () => {
    /**
     * ⚠️ Inverted. This used to assert a 500, and it got one: `:orderId` was shape-checked in
     * `ScopedOrderRepository` and `:changeRequestId` was not, so it reached a `uuid` column,
     * raised 22P02, and fell through `AllExceptionsFilter` into the "this is a bug in the
     * service" branch — a logged stack and, in production, a page, for a request anybody
     * could send by typing. The answer for an id that names nothing is the answer for every
     * other id that names nothing.
     */
    it('answers a malformed change-request id with the same 404 as one that names nothing', async () => {
      const order = await victimOrder('bad-cr-id');

      for (const bad of ['not-a-uuid', '../../etc/passwd', "' or 1=1--"]) {
        const answer = await call(
          'POST',
          `/orders/${order.id}/change-requests/${encodeURIComponent(bad)}/resolution`,
          { token: staff.token, body: { resolution: 'rejected' } },
        );
        expect(answer.status, `${bad} -> ${JSON.stringify(answer.body)}`).toBe(404);
      }
    });
  });

  describe('⑥ what the customer can read of what staff wrote', () => {
    /**
     * ⚠️ Inverted. The prose reached the customer verbatim and so did the staff member's
     * uuid — the mirror image of plan 7.9(ค) ("sales prose must not reach the production
     * sheet"), with the same cause: one field doing duty as an internal note and a
     * customer-facing sentence.
     *
     * What is *not* withheld is as important: `fault`, `absorbed_delta_thb_minor`, the
     * revisions and the document hash all still reach the customer, because those are
     * precisely the numbers they are entitled to see the basis of.
     */
    it('withholds staff prose and the staff user id from the customer, and keeps both for staff', async () => {
      const order = await victimOrder('staff-prose');
      const secret = `internal note ${tag}: do not tell the customer`;

      const cancelled = await move(order.id, 'cancelled', { token: staff.token }, { reason: secret });
      expect(cancelled.status).toBe(200);

      const feed = await call('GET', `/orders/${order.id}/events`, { token: victim.token });
      expect(feed.status).toBe(200);
      const events = (feed.body as OrderEventListWire).events;
      const cancellation = events.find((event) => event.eventType === 'cancelled');

      expect(JSON.stringify(feed.body)).not.toContain(secret);
      expect(JSON.stringify(feed.body)).not.toContain(staff.userId);
      expect(cancellation?.actorUserId).toBeNull();
      /* The event itself is still there — the customer is told *that* it happened. */
      expect(cancellation?.actorKind).toBe('staff');
      /*
       * This cancellation is pre-freeze, so its payload is `{reason}` and nothing else —
       * withholding the prose leaves it empty, which is the honest answer. The derived
       * numbers that *are* served to the customer (`fault`, `absorbed_delta_thb_minor`, the
       * revisions) are asserted on the post-freeze path in redteam5b.
       */
      expect(cancellation?.payload).toStrictEqual({});

      const staffFeed = await call('GET', `/orders/${order.id}/events`, { token: staff.token });
      expect(JSON.stringify(staffFeed.body)).toContain(secret);
      expect(
        (staffFeed.body as OrderEventListWire).events.find((e) => e.eventType === 'cancelled')
          ?.actorUserId,
      ).toBe(staff.userId);
    });
  });

  describe('⑦ the anonymous funnel as an outbound mailer', () => {
    it('lets somebody with no account queue mail to an address they do not control', async () => {
      const minted = await create({});
      const cookie = cookieHeader(minted.headers.get('set-cookie'));
      const draft = minted.body as OrderWire;

      const target = `rt5-mail-target-${tag}@probe.invalid`;
      const submitted = await move(draft.id, 'awaiting_payment', { cookie }, {
        contact: { email: target, name: 'somebody else' },
        lines: [line],
      });
      expect(submitted.status).toBe(200);

      const queued = await db.execute(sql`
        select status, recipient_key from notifications
         where order_id = ${draft.id} and recipient_kind = 'customer'
      `);
      const rows = (queued as unknown as { rows: readonly Record<string, unknown>[] }).rows;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.map((row) => row['recipient_key'])).toContain(`email:${target}`);
    });
  });
});

/* ------------------------------------------------------------------ */

/** The contracted total, or a failure that says which order had none. No `!` — house rules. */
function grandTotalOf(order: OrderWire): bigint {
  if (order.money === null) throw new Error(`order ${order.id} was submitted with no money on it`);
  return toBigInt(order.money.grandTotalThbMinor);
}

interface PricedUpgrade {
  readonly groupCode: string;
  readonly valueCode: string;
}

/**
 * The most expensive non-default sku option on this product whose code has an upper-case
 * letter in it — i.e. the one whose surcharge a lower-case spelling would dodge.
 */
function pricedUpgrade(product: Product): PricedUpgrade | undefined {
  let best: (PricedUpgrade & { weight: number }) | undefined;

  for (const group of product.groups) {
    if (group.kind !== 'sku') continue;
    for (const value of group.values) {
      if (value.code === group.defaultValue) continue;
      if (value.delta.type === 'none') continue;
      if (value.code.toLowerCase() === value.code) continue;

      // Not a price, just an ordering: flat baht dominate a per-sqm or percent delta here.
      const weight = value.delta.type === 'flat' ? value.delta.amount * 100 : value.delta.amount;
      if (best === undefined || weight > best.weight) {
        best = { groupCode: group.code, valueCode: value.code, weight };
      }
    }
  }

  return best === undefined ? undefined : { groupCode: best.groupCode, valueCode: best.valueCode };
}

async function liveLine(
  call: ReturnType<typeof client>,
): Promise<{ line: OrderLineRequestWire; product: Product }> {
  const listed = await call('GET', '/catalog/products', {});
  if (listed.status !== 200) throw new Error(`the catalogue is not being served: ${String(listed.status)}`);

  const wire = listed.body as {
    products: readonly { productVersionId: string; documentHash: string; product: { id: string } }[];
  };

  // The product with the largest dodgeable surcharge, so the reproduction shows the size
  // of the hole rather than whichever product happens to be listed first.
  const ranked = [...wire.products].sort((left, right) => weightOf(right) - weightOf(left));

  for (const published of ranked) {
    const product = products.find((candidate: Product) => candidate.id === published.product.id);
    if (!product || !product.groups.some((group) => group.kind === 'custom')) continue;
    if (pricedUpgrade(product) === undefined) continue;

    const selections: Record<string, string> = {};
    const measures: Record<string, ReturnType<typeof encodeUm>> = {};
    const enteredUnits: Record<string, 'cm' | 'mm'> = {};

    for (const group of product.groups) {
      if (group.kind === 'sku') selections[group.code] = group.defaultValue;
      else {
        measures[group.code] = encodeUm(group.defaultUm);
        enteredUnits[group.code] = group.unit;
      }
    }

    return {
      line: {
        productVersionId: published.productVersionId,
        documentHash: published.documentHash,
        productId: product.id,
        selections,
        measures,
        enteredUnits,
        qty: 1,
      },
      product,
    };
  }

  throw new Error('no published product with both a measurement and a priced option');
}

/** How much the biggest dodgeable option on this published product is worth. */
function weightOf(published: { readonly product: { readonly id: string } }): number {
  const product = products.find((candidate: Product) => candidate.id === published.product.id);
  if (!product) return -1;

  const upgrade = pricedUpgrade(product);
  if (upgrade === undefined) return -1;

  for (const group of product.groups) {
    if (group.kind !== 'sku' || group.code !== upgrade.groupCode) continue;
    const value = group.values.find((candidate) => candidate.code === upgrade.valueCode);
    if (!value || value.delta.type === 'none') return -1;
    return value.delta.type === 'flat' ? value.delta.amount * 100 : value.delta.amount;
  }

  return -1;
}
