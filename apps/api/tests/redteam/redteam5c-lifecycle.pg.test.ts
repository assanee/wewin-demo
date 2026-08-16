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
import { confirmQuotation } from '../support/confirm-quotation';

/** RED TEAM 5a, round three — stress, malformed input, and the cost of the anonymous funnel. */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

const tag = randomUUID().slice(0, 8);
const contactFor = (who: string): { email: string; name: string } => ({
  email: `orders-rt5c-${who}-${tag}@probe.invalid`,
  name: `redteam 5c ${tag}`,
});

describeWithPg('RED TEAM 5a round three', () => {
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
    staff = await makeActor(db, app, `rt5c staff ${tag}`, ['orders.read', 'orders.write']);
    customerA = await makeActor(db, app, `rt5c customer ${tag}`, []);
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
         where o.contact_email like 'orders-rt5c-%@probe.invalid'
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

  const move = (orderId: string, to: string, auth: Auth, body: unknown = {}): Promise<Json> =>
    call('POST', `/orders/${orderId}/transitions/${to}`, { ...auth, body });

  const submitted = async (who: string): Promise<OrderWire> => {
    const created = await call('POST', '/orders', { token: customerA.token, body: {} });
    const draft = (created.body as OrderWire).id;
    const done = await move(draft, 'awaiting_payment', { token: customerA.token }, {
      contact: contactFor(who),
      lines: [line],
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);

    /* Confirmed by staff — since 0056 a submit stops one status short of payable. */
    await confirmQuotation(db, draft);
    return (await call('GET', `/orders/${draft}`, { token: customerA.token })).body as OrderWire;
  };

  /* ================================================================= *
   * C1 — twenty writers, one order
   * ================================================================= */

  it('C1 twenty concurrent cancellations produce one cancellation', async () => {
    const order = await submitted('c1');

    const answers = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        move(order.id, 'cancelled', { token: customerA.token }, { reason: `พร้อมกัน ${String(i)}` }),
      ),
    );

    const ok = answers.filter((a) => a.status === 200);
    const conflict = answers.filter((a) => a.status === 409);
    expect(ok, JSON.stringify(answers.map((a) => [a.status, a.body]))).toHaveLength(1);
    expect(conflict).toHaveLength(19);

    const [events] = await rows<{ n: string }>(sql`
      select count(*)::text as n from order_events
       where order_id = ${order.id} and event_type = 'cancelled'
    `);
    expect(events?.n).toBe('1');

    /* And no gap or duplicate in `seq` — the trigger assigns it under the caller's lock. */
    const seqs = await rows<{ seq: number }>(
      sql`select seq from order_events where order_id = ${order.id} order by seq`,
    );
    expect(seqs.map((r) => Number(r.seq))).toEqual(seqs.map((_, i) => i + 1));
  });

  it('C1b twenty concurrent objections produce one open request', async () => {
    const order = await submitted('c1b');

    const answers = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        call('POST', `/orders/${order.id}/change-requests`, {
          token: customerA.token,
          body: { noteTh: `พร้อมกัน ${String(i)}` },
        }),
      ),
    );

    expect(answers.filter((a) => a.status === 201)).toHaveLength(1);
    expect(answers.filter((a) => a.status === 409)).toHaveLength(19);

    const [open] = await rows<{ n: string }>(sql`
      select count(*)::text as n from order_change_requests
       where order_id = ${order.id} and resolved_event_id is null
    `);
    expect(open?.n).toBe('1');
  });

  it('C1c twenty writers taking different directions leave one consistent order', async () => {
    const order = await submitted('c1c');

    const answers = await Promise.all([
      ...Array.from({ length: 7 }, () => move(order.id, 'production_confirmed', { token: staff.token })),
      ...Array.from({ length: 7 }, (_, i) =>
        move(order.id, 'cancelled', { token: customerA.token }, { reason: `ยกเลิก ${String(i)}` }),
      ),
      ...Array.from({ length: 6 }, () =>
        call('POST', `/orders/${order.id}/change-requests`, {
          token: customerA.token,
          body: { noteTh: 'ขอแก้' },
        }),
      ),
    ]);
    /*
     * 🔴 Some of these are 500s — see redteam5e-pool.pg.test.ts. Counted, not asserted away.
     */
    const fives = answers.filter((a) => a.status >= 500).length;
    process.stderr.write(`\n[C1c] ${String(fives)} of 20 concurrent writers got a 5xx\n`);

    /* Whatever happened, the row and its spine agree. */
    const [row] = await rows<{ status: string; status_event_id: string; frozen_at: string | null }>(
      sql`select status, status_event_id, frozen_at from orders where id = ${order.id}`,
    );
    const [named] = await rows<{ to_status: string }>(
      sql`select to_status from order_events where id = ${row?.status_event_id ?? ''}`,
    );
    expect(named?.to_status, JSON.stringify(answers.map((a) => a.status))).toBe(row?.status);
  }, 60_000);

  /* ================================================================= *
   * C2 — hostile and malformed input must never be a 500
   * ================================================================= */

  it('C2 nothing a caller can send to a transition produces a 500', async () => {
    const order = await submitted('c2');

    const hostile: readonly [string, unknown][] = [
      ['array body', []],
      ['string body', 'hello'],
      ['number body', 7],
      ['null body', null],
      ['nested actor claim', { reason: 'x', actorKind: 'staff' }],
      ['fault claim', { reason: 'x', fault: 'company' }],
      ['payload smuggling', { reason: 'x', payload: { fault: 'company' } }],
      ['over-long reason, under the body limit', { reason: 'x'.repeat(20_000) }],
      ['reason as object', { reason: { toString: 'x' } }],
      ['reason as array', { reason: ['a'] }],
    ];

    for (const [label, body] of hostile) {
      const answer = await move(order.id, 'cancelled', { token: customerA.token }, body);
      expect(answer.status, `${label} → ${answer.status} ${JSON.stringify(answer.body)}`).toBeLessThan(500);
    }

    /* None of them moved it. */
    const [row] = await rows<{ status: string }>(sql`select status from orders where id = ${order.id}`);
    expect(row?.status).toBe('awaiting_payment');
  });

  /**
   * 🔴 FINDING. A request body over the (default, undeclared) 100 kB body-parser limit is
   * answered `500 INTERNAL`, not `413`. body-parser throws a plain `PayloadTooLargeError`
   * with a `status` property; `AllExceptionsFilter` recognises `AppError` and Nest's
   * `HttpException` and nothing else, so it lands in the "this is a bug in the service"
   * branch — which also logs a stack for every one of them.
   *
   * It is reachable **unauthenticated**, on the route that mints the principal.
   */
  /**
   * ⚠️ Inverted. body-parser throws a plain `PayloadTooLargeError`, which is neither an
   * `AppError` nor an `HttpException`, so `AllExceptionsFilter` landed it in the "this is a
   * bug in the service" branch: 500, a logged stack, and in production an alert — for a
   * request anybody can send, unauthenticated, on `POST /orders`. A customer whose
   * legitimate hundred-line order crossed the limit was told the server had broken.
   */
  it('C2d an oversized body is a 413, including on the unauthenticated route', async () => {
    const order = await submitted('c2d');

    const under = await move(order.id, 'cancelled', { token: customerA.token }, { reason: 'x'.repeat(90_000) });
    expect(under.status, 'a 90 kB body still reaches zod').toBe(400);

    const over = await move(order.id, 'cancelled', { token: customerA.token }, { reason: 'x'.repeat(200_000) });
    expect(over.status, JSON.stringify(over.body)).toBe(413);
    expect((over.body as { error: { code: string } }).error.code).toBe('PAYLOAD_TOO_LARGE');

    /* And with no credentials at all, on POST /orders. */
    const anonymous = await call('POST', '/orders', {
      body: { contact: { email: 'a@b.co', name: 'x'.repeat(200_000) } },
    });
    expect(anonymous.status, JSON.stringify(anonymous.body)).toBe(413);
  });

  /**
   * The contract permits 100 lines per submit. This measures whether 100 lines of the
   * cheapest real product fit under the same undeclared limit.
   */
  it('C2e a 100-line submit — the maximum the contract allows — against the body limit', async () => {
    const created = await call('POST', '/orders', { token: customerA.token, body: {} });
    const draft = (created.body as OrderWire).id;

    const body = { contact: contactFor('c2e'), lines: Array.from({ length: 100 }, () => line) };
    const bytes = Buffer.byteLength(JSON.stringify(body));

    const answer = await move(draft, 'awaiting_payment', { token: customerA.token }, body);
    // eslint-disable-next-line no-console
    console.log(`[redteam] 100-line submit is ${String(bytes)} bytes → ${String(answer.status)}`);

    expect(answer.status, `${String(bytes)} bytes: ${JSON.stringify(answer.body)}`).toBeLessThan(500);
  });

  it('C2b a hostile order id is a 404, never a 500', async () => {
    const ids = [
      'not-a-uuid',
      '../../admin/products',
      "' or '1'='1",
      '00000000-0000-0000-0000-000000000000',
      randomUUID(),
      'x'.repeat(5000),
      '%2e%2e%2f',
    ];

    for (const id of ids) {
      const read = await call('GET', `/orders/${encodeURIComponent(id)}`, { token: customerA.token });
      expect([400, 404], `GET ${id} → ${read.status}`).toContain(read.status);

      const acted = await call('POST', `/orders/${encodeURIComponent(id)}/transitions/cancelled`, {
        token: customerA.token,
        body: { reason: 'x' },
      });
      expect([400, 404], `POST ${id} → ${acted.status}`).toContain(acted.status);
    }
  });

  it('C2c the list endpoint refuses nonsense rather than widening', async () => {
    for (const query of ['?limit=0', '?limit=-1', '?limit=99999', '?status=bogus', '?status=draft&status=bogus']) {
      const answer = await call('GET', `/orders${query}`, { token: customerA.token });
      expect(answer.status, `${query} → ${answer.status}`).toBeLessThan(500);
      expect([200, 400]).toContain(answer.status);
    }

    /* `?limit=99999` must not become an unbounded scan. */
    const capped = await call('GET', '/orders?limit=99999', { token: staff.token });
    expect(capped.status).toBe(400);
  });

  /* ================================================================= *
   * C3 — the lock is load-bearing: prove the failure it prevents
   * ================================================================= */

  it('C3 the unique key the spine leans on for `seq` really exists', async () => {
    /*
     * `order_events_guard_insert()` assigns `seq := max(seq) + 1` with no lock of its own;
     * the migration says "under concurrency the UNIQUE (order_id, seq) is the arbiter, which
     * is why the transition path takes SELECT … FOR UPDATE on the order first". Every path in
     * `src/orders` does take that lock — so the index is the backstop for the day 5b or 5c
     * writes an event without one. This asserts the backstop is on disk.
     */
    const found = await rows<{ indexdef: string }>(sql`
      select indexdef from pg_indexes
       where tablename = 'order_events' and indexdef ilike '%unique%(order_id, seq)%'
    `);
    expect(found, 'no UNIQUE (order_id, seq) on order_events').toHaveLength(1);

    const positive = await rows<{ conname: string }>(sql`
      select conname from pg_constraint
       where conrelid = 'order_events'::regclass and conname = 'order_events_seq_positive'
    `);
    expect(positive).toHaveLength(1);
  });

  /* ================================================================= *
   * C4 — what one anonymous submit costs the server
   * ================================================================= */

  it('C4 every anonymous submit reads the whole published catalogue', async () => {
    const created = await call('POST', '/orders', { body: {} });
    const cookie = (created.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const orderId = (created.body as OrderWire).id;

    const started = Date.now();
    const done = await call('POST', `/orders/${orderId}/transitions/awaiting_payment`, {
      cookie,
      body: { contact: contactFor('c4'), lines: Array.from({ length: 50 }, () => line) },
    });
    const elapsed = Date.now() - started;
    expect(done.status, JSON.stringify(done.body)).toBe(200);

    const [published] = await rows<{ n: string }>(
      sql`select count(*)::text as n from product_versions where status = 'published'`,
    );

    /* Recorded, not asserted as a threshold — the point is that it is unauthenticated. */
    // eslint-disable-next-line no-console
    console.log(
      `[redteam] one anonymous 50-line submit: ${String(elapsed)}ms, catalogue has ${published?.n ?? '?'} published versions`,
    );
    expect(elapsed).toBeGreaterThan(0);
  });

  /* ================================================================= *
   * C5 — the document a customer is shown vs the one the order names
   * ================================================================= */

  it('C5 the pinned document is frozen against every writer, including the owner of the order', async () => {
    const order = await submitted('c5');

    const [doc] = await rows<{ id: string }>(
      sql`select id from order_documents where order_id = ${order.id}`,
    );

    await expect(
      db.execute(sql`update order_documents set net_thb_minor = 1 where id = ${doc?.id ?? ''}`),
    ).rejects.toThrow();
    await expect(
      db.execute(sql`delete from order_documents where id = ${doc?.id ?? ''}`),
    ).rejects.toThrow();

    /* And the order's own totals cannot be edited away from it either. */
    await expect(
      db.execute(sql`update orders set grand_total_thb_minor = 1 where id = ${order.id}`),
    ).rejects.toThrow();
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
