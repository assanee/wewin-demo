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

/**
 * 🔴 RED TEAM — the pool.
 *
 * `DATABASE_POOL_MAX` is 10 and `DATABASE_CONNECT_TIMEOUT_MS` is 5 000 (apps/api
 * src/config/env.ts). Every order write opens a transaction and holds its connection
 * across a `SELECT … FOR UPDATE` that is *designed* to block on the other writers. So the
 * eleventh concurrent write to one order waits for a connection, times out, and the pg
 * error is not an `AppError` or a Nest `HttpException` — it lands in
 * `AllExceptionsFilter`'s "this is a bug in the service" branch and is answered `500`.
 *
 * These tests measure the threshold and the blast radius.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

const tag = randomUUID().slice(0, 8);
const contactFor = (who: string): { email: string; name: string } => ({
  email: `orders-rt5e-${who}-${tag}@probe.invalid`,
  name: `redteam 5e ${tag}`,
});

describeWithPg('RED TEAM 5a — connection pool exhaustion', () => {
  let pool: Pool;
  let db: Database;
  let app: LifecycleApp;
  let call: ReturnType<typeof client>;
  let customerA: Actor;
  let line: OrderLineRequestWire;

  beforeAll(async () => {
    pool = createPool(url ?? '');
    db = createDatabase(pool);
    app = await bootLifecycleApp(lifecycleEnv(url ?? ''));
    call = client(app.baseUrl);
    customerA = await makeActor(db, app, `rt5e customer ${tag}`, []);
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
         where o.contact_email like 'orders-rt5e-%@probe.invalid'
      )
    `);
    await app.close();
    await pool.end();
  });

  const move = (orderId: string, to: string, body: unknown = {}): Promise<Json> =>
    call('POST', `/orders/${orderId}/transitions/${to}`, { token: customerA.token, body });

  const submitted = async (who: string): Promise<string> => {
    const created = await call('POST', '/orders', { token: customerA.token, body: {} });
    const draft = (created.body as OrderWire).id;
    const done = await move(draft, 'awaiting_payment', { contact: contactFor(who), lines: [line] });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    return draft;
  };

  it('E1 eleven concurrent writes to one order start answering 500', async () => {
    const report: string[] = [];
    let firstBadWidth: number | null = null;

    for (const width of [4, 8, 11, 16, 24]) {
      const orderId = await submitted(`e1-${String(width)}`);
      const answers = await Promise.all(
        Array.from({ length: width }, (_, i) => move(orderId, 'cancelled', { reason: `w${String(i)}` })),
      );
      const fives = answers.filter((a) => a.status >= 500).length;
      const ok = answers.filter((a) => a.status === 200).length;
      report.push(`width ${String(width)}: ${String(ok)}×200 ${String(fives)}×5xx`);
      if (fives > 0 && firstBadWidth === null) firstBadWidth = width;

      /* Exactly one cancellation still happened, whatever the noise. */
      expect(ok).toBe(1);
    }

    process.stderr.write(`\n[E1] ${report.join(' | ')}\n`);
    expect(firstBadWidth, `no width produced a 5xx: ${report.join(' | ')}`).not.toBeNull();
    expect(firstBadWidth).toBeLessThanOrEqual(16);
  }, 180_000);

  it('E2 the blast radius is the whole API, not the contended order', async () => {
    const orderId = await submitted('e2');
    const other = await submitted('e2-other');

    /* Sixteen writers pile onto ONE order… */
    const burst = Promise.all(
      Array.from({ length: 16 }, (_, i) => move(orderId, 'cancelled', { reason: `w${String(i)}` })),
    );

    /* …while an unrelated visitor reads the catalogue and their own unrelated order. */
    await new Promise((resolve) => setTimeout(resolve, 50));
    const bystanders = await Promise.all([
      call('GET', '/catalog/products', {}),
      call('GET', `/orders/${other}`, { token: customerA.token }),
      call('GET', '/orders', { token: customerA.token }),
      call('GET', '/health', {}),
    ]);

    await burst;

    const codes = bystanders.map((b) => b.status);
    process.stderr.write(`\n[E2] bystanders: ${codes.join(', ')}\n`);
    expect(codes, 'an unrelated read was collateral damage of one contended order').toEqual([
      200, 200, 200, 200,
    ]);
  }, 180_000);

  it('E3 the API recovers once the burst is over', async () => {
    const orderId = await submitted('e3');
    await Promise.all(
      Array.from({ length: 24 }, (_, i) => move(orderId, 'cancelled', { reason: `w${String(i)}` })),
    );

    const after = await Promise.all([
      call('GET', '/orders', { token: customerA.token }),
      call('GET', '/catalog/products', {}),
    ]);
    process.stderr.write(`\n[E3] after the burst: ${after.map((a) => a.status).join(', ')}\n`);
    expect(after.map((a) => a.status)).toEqual([200, 200]);
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
