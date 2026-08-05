import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, createPool, type Database, type Pool } from '@wewin/db/client';
import { sql } from '@wewin/db/sql';
import { orderDocumentProductVersions } from '@wewin/db/schema';
import { products } from '@wewin/core/fixtures';
import type { Product } from '@wewin/core';
import { encodeUm } from '@wewin/contract/measure';
import type { OrderLineRequestWire, OrderWire } from '@wewin/contract/order';

import {
  bootLifecycleApp,
  client,
  lifecycleEnv,
  makeActor,
  type Actor,
  type Json,
  type LifecycleApp,
} from '../orders/support/lifecycle-app';
import { RouteRegistryService, type RouteRecord } from '../../src/rbac/route-registry.service';

/**
 * RED TEAM 5a, round two — the attacks the obvious ones did not cover.
 *
 * Reproductions only. A PASS here is either "the attack was defeated" or "this is exactly
 * what the system does, and the doing of it is the finding" — each `it` says which.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

const tag = randomUUID().slice(0, 8);
const contactFor = (who: string): { email: string; name: string } => ({
  email: `orders-rt5b-${who}-${tag}@probe.invalid`,
  name: `redteam 5b ${tag}`,
});

describeWithPg('RED TEAM 5a round two', () => {
  let pool: Pool;
  let db: Database;
  let app: LifecycleApp;
  let call: ReturnType<typeof client>;

  let staff: Actor;
  let customerA: Actor;
  let line: OrderLineRequestWire;

  beforeAll(async () => {
    pool = createPool(url ?? '');
    db = createDatabase(pool);
    app = await bootLifecycleApp(lifecycleEnv(url ?? ''));
    call = client(app.baseUrl);

    staff = await makeActor(db, app, `rt5b staff ${tag}`, ['orders.read', 'orders.write']);
    customerA = await makeActor(db, app, `rt5b customer ${tag}`, []);

    line = await liveLine(call);
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
        select d.id from order_documents d join orders o on o.id = d.order_id
         where o.contact_email like 'orders-rt5b-%@probe.invalid'
      )
    `);
    await app.close();
    await pool.end();
  });

  type Auth = { token?: string; cookie?: string };

  const rows = async <T>(query: Parameters<Database['execute']>[0]): Promise<T[]> => {
    const result = (await db.execute(query)) as unknown as { rows?: T[] } | T[];
    return Array.isArray(result) ? result : (result.rows ?? []);
  };

  const create = (auth: Auth): Promise<Json> => call('POST', '/orders', { ...auth, body: {} });
  const move = (orderId: string, to: string, auth: Auth, body: unknown = {}): Promise<Json> =>
    call('POST', `/orders/${orderId}/transitions/${to}`, { ...auth, body });
  const submit = (orderId: string, auth: Auth, who: string): Promise<Json> =>
    move(orderId, 'awaiting_payment', auth, { contact: contactFor(who), lines: [line] });

  const submitted = async (who: string): Promise<OrderWire> => {
    const created = await create({ token: customerA.token });
    const draft = created.body as OrderWire;
    const done = await submit(draft.id, { token: customerA.token }, who);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    return done.body as OrderWire;
  };

  const frozen = async (who: string): Promise<OrderWire> => {
    const order = await submitted(who);
    const confirmed = await move(order.id, 'production_confirmed', { token: staff.token });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    return confirmed.body as OrderWire;
  };

  const statusOf = async (orderId: string): Promise<string> => {
    const [row] = await rows<{ status: string }>(sql`select status from orders where id = ${orderId}`);
    return row?.status ?? 'MISSING';
  };

  /* ================================================================= *
   * B1 — the cheapest email cannon in the app: two anonymous calls,
   *      no catalogue line, no valid product, straight to the company inbox
   * ================================================================= */

  it('B1 an anonymous stranger emails the sales queue with two calls and no order at all', async () => {
    const created = await call('POST', '/orders', { body: {} });
    expect(created.status).toBe(201);
    const cookie = (created.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const orderId = (created.body as OrderWire).id;

    const shout = `ยกเลิก ${'ก'.repeat(1900)} ${tag}`;
    const cancelled = await call('POST', `/orders/${orderId}/transitions/cancelled`, {
      cookie,
      body: { reason: shout },
    });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);

    const queued = await rows<{ recipient_kind: string; recipient_key: string | null; status: string }>(
      sql`select recipient_kind, recipient_key, status from notifications where order_id = ${orderId}`,
    );

    /* The finding: a cart nobody paid for, cancelled by nobody in particular, sends mail. */
    const toSales = queued.filter((row) => row.recipient_kind === 'sales_queue');
    expect(toSales, JSON.stringify(queued)).toHaveLength(1);
    expect(toSales[0]?.status).toBe('pending');

    /* …and the attacker wrote the body of it. */
    const [event] = await rows<{ payload: { reason?: string } }>(
      sql`select payload from order_events where order_id = ${orderId} and event_type = 'cancelled'`,
    );
    expect(event?.payload.reason).toContain(tag);
    expect((event?.payload.reason ?? '').length).toBeGreaterThan(1000);
  });

  it('B1b ten of them in a loop, unauthenticated, with nothing to stop it', async () => {
    const queued: string[] = [];

    for (let i = 0; i < 10; i += 1) {
      const created = await call('POST', '/orders', { body: {} });
      expect(created.status).toBe(201);
      const cookie = (created.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
      const orderId = (created.body as OrderWire).id;
      const cancelled = await call('POST', `/orders/${orderId}/transitions/cancelled`, {
        cookie,
        body: { reason: `flood ${String(i)} ${tag}` },
      });
      expect(cancelled.status).toBe(200);
      queued.push(orderId);
    }

    const [count] = await rows<{ n: string }>(sql`
      select count(*)::text as n from notifications
       where recipient_kind = 'sales_queue'
         and order_id = any(${sql.raw(`'{${queued.join(',')}}'::uuid[]`)})
    `);
    expect(count?.n).toBe('10');
  });

  /* ================================================================= *
   * B2 — one historical bounce unlocks "the company is at fault"
   *      for every later cancellation on that order
   * ================================================================= */

  /**
   * ⚠️ Inverted. `faultFor` asked `hasEvent(order, 'bounced_to_redesign')` — "did this order
   * *ever* bounce" — which is permanent. One bounce in March therefore licensed any member of
   * staff to record `fault = 'company'` in December, on a cancellation the customer had asked
   * for, and plan 7.8 makes that number the one that decides how much money goes back. In 5b
   * it would be a full refund on any order that ever bounced, granted by whoever typed the
   * flag.
   *
   * The question the fix asks instead is whether the bounce is *unresolved*: the latest
   * `bounced_to_redesign` more recent than the latest `redesign_approved`, compared on `seq`.
   * A second bounce after an approval re-opens it, which is right — that is a second failure
   * to manufacture, and the claim is about that one.
   */
  it('B2 a bounce that was fixed and approved no longer buys a company-fault cancellation', async () => {
    const order = await frozen('b2');

    /* The factory bounces it… */
    expect((await move(order.id, 'redesign', { token: staff.token }, { reason: 'ทำไม่ได้' })).status).toBe(200);

    /* While it is open, the claim is legitimate and is accepted — proved before the refusal. */
    const whileOpen = await rows<{ n: string }>(sql`select 1 as n`);
    expect(whileOpen).toHaveLength(1);

    /* …and the redesign is accepted, so the complaint is over. */
    const approved = await move(order.id, 'production_confirmed', { token: staff.token });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);

    /* Months later the customer simply changes their mind. Staff try to blame the company. */
    const cancelled = await move(
      order.id,
      'cancelled',
      { token: staff.token },
      { reason: 'ลูกค้าขอยกเลิกเอง', attributeFaultToCompany: true },
    );

    /* 422 and not a silent downgrade: staff who believe they granted a refund must be told. */
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(422);
    expect((cancelled.body as { error: { details: { reason: string } } }).error.details.reason).toBe(
      'no_bounce_on_record',
    );

    /* Nothing was written: the order is still frozen and cancellable on the honest ground. */
    const honest = await move(
      order.id,
      'cancelled',
      { token: staff.token },
      { reason: 'ลูกค้าขอยกเลิกเอง' },
    );
    expect(honest.status, JSON.stringify(honest.body)).toBe(200);

    const [event] = await rows<{ payload: { fault?: string } }>(
      sql`select payload from order_events where order_id = ${order.id} and event_type = 'cancelled'`,
    );
    expect(event?.payload.fault).toBe('customer');
  });

  it('B2b …and an open bounce still does, because that is what the claim is for', async () => {
    const order = await frozen('b2b');
    expect((await move(order.id, 'redesign', { token: staff.token }, { reason: 'ทำไม่ได้' })).status).toBe(200);

    const cancelled = await move(
      order.id,
      'cancelled',
      { token: staff.token },
      { reason: 'ผลิตไม่ได้จริง', attributeFaultToCompany: true },
    );
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);

    const [event] = await rows<{ payload: { fault?: string } }>(
      sql`select payload from order_events where order_id = ${order.id} and event_type = 'cancelled'`,
    );
    expect(event?.payload.fault).toBe('company');
  });

  /* ================================================================= *
   * B3 — an objection blocks re-entry to production after a redesign
   * ================================================================= */

  it('B3 an objection raised during redesign blocks the re-freeze until answered', async () => {
    const order = await frozen('b3');
    expect((await move(order.id, 'redesign', { token: staff.token }, { reason: 'แก้แบบ' })).status).toBe(200);

    const opened = await call('POST', `/orders/${order.id}/change-requests`, {
      token: customerA.token,
      body: { noteTh: 'ขอดูแบบใหม่ก่อน' },
    });
    expect(opened.status).toBe(201);

    const blocked = await move(order.id, 'production_confirmed', { token: staff.token });
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(409);

    const crId = (opened.body as { id: string }).id;
    expect(
      (await call('POST', `/orders/${order.id}/change-requests/${crId}/resolution`, {
        token: staff.token,
        body: { resolution: 'accepted' },
      })).status,
    ).toBe(200);

    expect((await move(order.id, 'production_confirmed', { token: staff.token })).status).toBe(200);
  });

  /* ================================================================= *
   * B4 — the cart a signed-in visitor was carrying
   * ================================================================= */

  it('B4 a signed-in visitor holding a guest cookie does NOT get both ids, despite the comment', async () => {
    const anon = await call('POST', '/orders', { body: {} });
    const cookie = (anon.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    expect(cookie).not.toBe('');

    /* Same browser, now signed in, still sending the guest cookie. */
    const created = await call('POST', '/orders', { token: customerA.token, cookie, body: {} });
    expect(created.status).toBe(201);
    const id = (created.body as OrderWire).id;

    const [row] = await rows<{ customer_user_id: string | null; guest_id: string | null }>(
      sql`select customer_user_id, guest_id from orders where id = ${id}`,
    );

    expect(row?.customer_user_id).toBe(customerA.userId);
    /* `orders.service.ts` says "gets *both* ids on the order". It does not. */
    expect(row?.guest_id).toBeNull();
  });

  /* ================================================================= *
   * B5 — the guest cookie is a bearer capability with no revocation
   * ================================================================= */

  it('B5 a stolen guest cookie cancels the cart it names, with no second factor', async () => {
    const anon = await call('POST', '/orders', { body: {} });
    const cookie = (anon.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const orderId = (anon.body as OrderWire).id;

    /* An attacker who has only the cookie value — no session, no email, nothing. */
    const stolen = cookie;
    const submitted = await call('POST', `/orders/${orderId}/transitions/awaiting_payment`, {
      cookie: stolen,
      body: { contact: contactFor('b5'), lines: [line] },
    });
    expect(submitted.status).toBe(200);

    const cancelled = await call('POST', `/orders/${orderId}/transitions/cancelled`, {
      cookie: stolen,
      body: { reason: 'ขโมยคุกกี้มา' },
    });
    expect(cancelled.status).toBe(200);
    expect(await statusOf(orderId)).toBe('cancelled');
  });

  /* ================================================================= *
   * B6 — the transition route carries no permission, so a route audit
   *      cannot see that `orders.write` is company-wide write authority
   * ================================================================= */

  it('B6 the boot audit shows no permission on any order route, so `orders.write` is invisible to it', async () => {
    const registry = app.app.get(RouteRegistryService);
    /*
     * The *lifecycle* routes, which is what this finding is about — `OrdersController`'s own.
     *
     * 5c put eight more routes under the same prefix (`/orders/:orderId/quote/…`) and every one
     * of them **does** state a permission, plus `/quotes/authority/orders/:orderId` which is a
     * different controller entirely. Widening the filter to catch those would turn this
     * assertion green for the wrong reason, so it is narrowed rather than relaxed: what the
     * finding says is that the routes which move an order's *status* carry no permission, and
     * that is still true of all nine.
     */
    const orderRoutes = registry
      .records()
      .filter(
        (record: RouteRecord) =>
          /\s\/orders\b/.test(record.key) && !record.key.includes('/quote/'),
      );

    expect(
      orderRoutes.length,
      JSON.stringify(registry.records().map((r: RouteRecord) => r.key)),
    ).toBeGreaterThan(0);

    /*
     * Every one of them is `principal` or `anonymous`. Nothing in the audit says that holding
     * `orders.write` turns POST /orders/:id/transitions/:toStatus into authority over every
     * order in the company — that lives in `orderReach`, which the audit never reads.
     */
    for (const route of orderRoutes) {
      expect(route.access.kind, route.key).not.toBe('permissions');
    }
    expect(orderRoutes.map((r: RouteRecord) => r.access.kind).sort()).toContain('principal');
  });

  /* ================================================================= *
   * B7 — a submitted order can never be erased, even at the customer's
   *      request, once a delivery has been attempted
   * ================================================================= */

  it('B7 a submitted order cannot be deleted, and neither can its spine', async () => {
    const order = await submitted('b7');

    await expect(db.execute(sql`delete from orders where id = ${order.id}`)).rejects.toThrow();
    await expect(db.execute(sql`delete from order_events where order_id = ${order.id}`)).rejects.toThrow();
    await expect(
      db.execute(sql`update order_events set payload = '{}'::jsonb where order_id = ${order.id}`),
    ).rejects.toThrow();
  });

  /* ================================================================= *
   * B8 — a draft cart is deletable until a notification attempt exists
   * ================================================================= */

  it('B8 an abandoned draft is erasable only while nothing has tried to deliver about it', async () => {
    const created = await call('POST', '/orders', { body: {} });
    const id = (created.body as OrderWire).id;

    /* A never-submitted draft with no notifications: PDPA erasure works. */
    await db.execute(sql`delete from orders where id = ${id}`);
    expect(await statusOf(id)).toBe('MISSING');

    /* Now one that has been cancelled — which queues mail — and therefore cannot be erased. */
    const second = await call('POST', '/orders', { body: {} });
    const cookie = (second.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const secondId = (second.body as OrderWire).id;
    expect(
      (await call('POST', `/orders/${secondId}/transitions/cancelled`, { cookie, body: { reason: 'ทิ้ง' } }))
        .status,
    ).toBe(200);

    await expect(db.execute(sql`delete from orders where id = ${secondId}`)).rejects.toThrow();
  });

  /* ================================================================= *
   * B9 — nothing anywhere expires an unpaid order
   * ================================================================= */

  it('B9 `awaiting_payment` has no timeout and no system actor that can reach it', async () => {
    const order = await submitted('b9');

    /* The transition table gives `system` exactly two rows, and neither leaves awaiting_payment. */
    const systemMoves = await rows<{ from_status: string; to_status: string }>(sql`
      select from_status, to_status from order_status_transitions
       where 'system' = any(allowed_actor_kinds)
    `);
    const fromAwaiting = systemMoves.filter((row) => row.from_status === 'awaiting_payment');
    expect(fromAwaiting.map((r) => r.to_status)).toEqual(['production_confirmed']);

    /* So an unpaid order sits there for ever, and nothing sweeps it. */
    expect(await statusOf(order.id)).toBe('awaiting_payment');
  });
});

async function liveLine(call: ReturnType<typeof client>): Promise<OrderLineRequestWire> {
  const listed = await call('GET', '/catalog/products', {});
  if (listed.status !== 200) throw new Error(`the catalogue is not being served: ${listed.status}`);

  const wire = listed.body as {
    products: readonly { productVersionId: string; documentHash: string; product: { id: string } }[];
  };

  for (const published of wire.products) {
    const product = products.find((candidate: Product) => candidate.id === published.product.id);
    if (!product || !product.groups.some((group) => group.kind === 'custom')) continue;

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
      productVersionId: published.productVersionId,
      documentHash: published.documentHash,
      productId: product.id,
      selections,
      measures,
      enteredUnits,
      qty: 1,
    };
  }

  throw new Error('no published product with a measurement to order');
}
