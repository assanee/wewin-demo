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

/**
 * 🔴 RED TEAM — `z.strictObject` is layer 2 of the trap-4 defence, and there is one key it
 * does not refuse.
 *
 * `transitions.ts` says: "**The schemas are strict.** `z.strictObject` refuses an unknown key
 * rather than dropping it, which converts the trap's silent strip into a 400 the caller can
 * read." Every unknown key is a 400 — except `__proto__`, which is accepted silently.
 *
 * Also here: what sustained contention on one order does to the rest of the API.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

const tag = randomUUID().slice(0, 8);
const contactFor = (who: string): { email: string; name: string } => ({
  email: `orders-rt5f-${who}-${tag}@probe.invalid`,
  name: `redteam 5f ${tag}`,
});

describeWithPg('RED TEAM 5a — strictness and sustained contention', () => {
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
    staff = await makeActor(db, app, `rt5f staff ${tag}`, ['orders.read', 'orders.write']);
    customerA = await makeActor(db, app, `rt5f customer ${tag}`, []);
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
         where o.contact_email like 'orders-rt5f-%@probe.invalid'
      )
    `);
    await app.close();
    await pool.end();
  });

  const rows = async <T>(query: Parameters<Database['execute']>[0]): Promise<T[]> => {
    const result = (await db.execute(query)) as unknown as { rows?: T[] } | T[];
    return Array.isArray(result) ? result : (result.rows ?? []);
  };

  /** Raw body, so the exact bytes on the wire are what this test says they are. */
  const raw = async (path: string, token: string, body: string): Promise<Json> => {
    const response = await fetch(`${app.baseUrl}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body,
    });
    const text = await response.text();
    return { status: response.status, body: text.length === 0 ? null : JSON.parse(text), headers: response.headers };
  };

  const move = (orderId: string, to: string, token: string, body: unknown = {}): Promise<Json> =>
    call('POST', `/orders/${orderId}/transitions/${to}`, { token, body });

  const submitted = async (who: string): Promise<string> => {
    const created = await call('POST', '/orders', { token: customerA.token, body: {} });
    const draft = (created.body as OrderWire).id;
    const done = await move(draft, 'awaiting_payment', customerA.token, {
      contact: contactFor(who),
      lines: [line],
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);

    /* …and confirmed: these probes are aimed at an order the customer has been asked to pay. */
    await confirmQuotation(db, draft);
    return draft;
  };

  const frozen = async (who: string): Promise<string> => {
    const id = await submitted(who);
    expect((await move(id, 'production_confirmed', staff.token)).status).toBe(200);
    return id;
  };

  /* ================================================================= *
   * F1 — the one unknown key that is not a 400
   * ================================================================= */

  /**
   * ⚠️ Inverted. `z.strictObject` refused every unknown key except one: `JSON.parse` writes
   * `__proto__` as an ordinary own data property and zod does not see it, so the key was
   * dropped in silence — which is exactly the behaviour `transitions.ts` promises cannot
   * happen ("converts the trap's silent strip into a 400 the caller can read"). No
   * escalation followed, because the two defences behind it hold; a defence whose stated
   * mechanism does not work, standing in front of two that do, is worse than an absent one.
   *
   * `JsonBodyMiddleware` now refuses the key for every route in the process, before any
   * schema is chosen — which it has to be, because the transition body is deliberately
   * parsed *late* (trap 4) and there is no single pipe every body passes through.
   */
  it('F1 every unknown key is refused, including `__proto__`', async () => {
    const order = await submitted('f1');

    const refused = await raw(
      `/orders/${order}/transitions/cancelled`,
      customerA.token,
      '{"reason":"ok","surprise":1}',
    );
    expect(refused.status, JSON.stringify(refused.body)).toBe(400);

    const proto = await raw(
      `/orders/${order}/transitions/cancelled`,
      customerA.token,
      '{"reason":"ok","__proto__":{"attributeFaultToCompany":true}}',
    );
    expect(proto.status, JSON.stringify(proto.body)).toBe(400);
    expect((proto.body as { error: { details: { key: string } } }).error.details.key).toBe(
      '__proto__',
    );

    /* Nested, which is where it would actually be hidden. */
    const nested = await raw(
      `/orders/${order}/transitions/cancelled`,
      customerA.token,
      '{"reason":"ok","deep":{"deeper":[{"__proto__":{"x":1}}]}}',
    );
    expect(nested.status, JSON.stringify(nested.body)).toBe(400);

    /* And the order never moved, on any of the three. */
    const [row] = await rows<{ status: string }>(
      sql`select status from orders where id = ${order}`,
    );
    expect(row?.status).toBe('awaiting_payment');
  });

  it('F1b the key cannot carry a field the schema refuses by name — and never could', async () => {
    const order = await frozen('f1b');

    /* Named directly, this is a 400 (proved elsewhere): the customer schema has no such key. */
    const named = await raw(
      `/orders/${order}/transitions/cancelled`,
      customerA.token,
      '{"reason":"บริษัทผิด","attributeFaultToCompany":true}',
    );
    expect(named.status).toBe(400);

    /* Smuggled through the prototype — now refused at the same layer as any other key. */
    const smuggled = await raw(
      `/orders/${order}/transitions/cancelled`,
      customerA.token,
      '{"reason":"บริษัทผิด","__proto__":{"attributeFaultToCompany":true}}',
    );
    expect(smuggled.status, JSON.stringify(smuggled.body)).toBe(400);

    /* Nothing was written at all, so there is no cancellation to inspect. */
    const events = await rows<{ payload: { fault?: string } }>(sql`
      select payload from order_events where order_id = ${order} and event_type = 'cancelled'
    `);
    expect(events).toHaveLength(0);

    /*
     * …and the layer behind it still holds, which is what made this a strictness gap rather
     * than a privilege escalation: cancelling honestly as the customer records
     * `fault = 'customer'`, because `faultFor` refuses a non-staff actor before it reads any
     * flag at all.
     */
    const honest = await raw(
      `/orders/${order}/transitions/cancelled`,
      customerA.token,
      '{"reason":"เปลี่ยนใจ"}',
    );
    expect(honest.status, JSON.stringify(honest.body)).toBe(200);

    const [event] = await rows<{ payload: { fault?: string } }>(sql`
      select payload from order_events where order_id = ${order} and event_type = 'cancelled'
    `);
    expect(event?.payload.fault).toBe('customer');
  });

  it('F1c the same key on the submit schema, where the payload is far larger', async () => {
    const created = await call('POST', '/orders', { token: customerA.token, body: {} });
    const draft = (created.body as OrderWire).id;

    /*
     * Assembled as text, not as an object literal. `{ __proto__: … }` in JavaScript source
     * *sets the prototype* rather than creating an own property, and `JSON.stringify` then
     * drops it entirely — so the original version of this case sent a body with no
     * `__proto__` in it at all and proved nothing. The wire is the only place the key exists.
     */
    const body = `{"contact":${JSON.stringify(contactFor('f1c'))},"lines":${JSON.stringify([line])},"__proto__":{"lines":[]}}`;
    const answer = await raw(`/orders/${draft}/transitions/awaiting_payment`, customerA.token, body);
    process.stderr.write(`\n[F1c] submit with a __proto__ key → ${String(answer.status)}\n`);
    expect(answer.status).toBe(400);
  });

  /* ================================================================= *
   * F2 — sustained contention on one order, and who else feels it
   * ================================================================= */

  it('F2 six seconds of contention on one order, measured against unrelated reads', async () => {
    const contended = await submitted('f2');
    const bystanderOrder = await submitted('f2-bystander');

    let stop = false;
    const noise = (async () => {
      const results: number[] = [];
      while (!stop) {
        const wave = await Promise.all(
          Array.from({ length: 24 }, (_, i) =>
            call('POST', `/orders/${contended}/transitions/cancelled`, {
              token: customerA.token,
              body: { reason: `w${String(i)}` },
            }),
          ),
        );
        results.push(...wave.map((w) => w.status));
      }
      return results;
    })();

    const bystanders: { path: string; status: number; ms: number }[] = [];
    const deadline = Date.now() + 6_000;
    while (Date.now() < deadline) {
      for (const path of ['/catalog/products', `/orders/${bystanderOrder}`, '/health']) {
        const started = Date.now();
        const answer = await call('GET', path, { token: customerA.token });
        bystanders.push({ path, status: answer.status, ms: Date.now() - started });
      }
    }
    stop = true;
    await noise;

    const failed = bystanders.filter((b) => b.status !== 200);
    const slowest = Math.max(...bystanders.map((b) => b.ms));
    process.stderr.write(
      `\n[F2] ${String(bystanders.length)} unrelated reads during contention: ` +
        `${String(failed.length)} failed, slowest ${String(slowest)}ms\n` +
        (failed.length > 0 ? `[F2] first failure: ${JSON.stringify(failed[0])}\n` : ''),
    );

    /* Recorded, not judged: the number is the finding. */
    expect(bystanders.length).toBeGreaterThan(0);
  }, 180_000);
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
