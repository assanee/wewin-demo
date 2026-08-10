import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, createPool, type Database, type Pool } from '@wewin/db/client';
import { eq } from '@wewin/db/sql';
import { orders } from '@wewin/db/schema';
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
} from './support/lifecycle-app';

/**
 * Task 8: `orders.destination_country` — stored at submit, read nowhere yet (Task 9 reads it).
 *
 * Three properties, over real HTTP against a real Postgres:
 *
 *   1. a code the customer sends at submit is stored;
 *   2. the store is `body.contact.destinationCountry ?? order.destinationCountry`, the same
 *      `??` shape every other contact field uses — a submit that names no destination must
 *      not erase one the cart already had;
 *   3. a lower-case code is refused by `orderContactRequestSchema`'s regex before it ever
 *      reaches the database's own `orders_destination_country_shape` CHECK.
 *
 * ── Why `setDestination` writes the column directly ───────────────────────────────
 *
 * There is no supported write path for `destinationCountry` before submit — `applySubmission`
 * is the only place this task wires one, and it runs exactly once per order (submit moves a
 * `draft` to `awaiting_payment`; nothing resubmits). So "a cart that already had a destination"
 * cannot be produced by calling the API twice. It is produced the way it will actually arise —
 * a value already sitting in the column when submit runs — by writing it with the same
 * `Database` handle a real future writer would use, then asserting the `??` fallback in
 * `orders.service.ts` reads it back rather than clobbering it with `undefined`.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

const tag = randomUUID().slice(0, 8);

describeWithPg('orders.destination_country, chosen at submit', () => {
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

    customerA = await makeActor(db, app, `destination submit probe ${tag}`, []);
    line = await liveLine(call);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  /* ---------------------------------------------------------------- *
   * Helpers
   * ---------------------------------------------------------------- */

  const move = (
    orderId: string,
    toStatus: string,
    body: unknown,
  ): Promise<Json> => call('POST', `/orders/${orderId}/transitions/${toStatus}`, { token: customerA.token, body });

  /**
   * A fresh cart, and the two ways this file needs to act on it: submit it (through the real
   * HTTP + service path this task changed), or give it a destination the way a future write
   * path would (direct, ahead of submit — see the file header).
   */
  const cart = async (): Promise<{
    readonly orderId: string;
    readonly submit: (body: { readonly contact: Record<string, unknown> }) => Promise<Json>;
    readonly setDestination: (code: string) => Promise<void>;
  }> => {
    const created = await call('POST', '/orders', { token: customerA.token, body: {} });
    expect(created.status).toBe(201);
    const draft = created.body as OrderWire;

    return {
      orderId: draft.id,
      submit: (body) => move(draft.id, 'awaiting_payment', { ...body, lines: [line] }),
      setDestination: async (code) => {
        await db.update(orders).set({ destinationCountry: code }).where(eq(orders.id, draft.id));
      },
    };
  };

  const destinationOf = async (orderId: string): Promise<string | null> => {
    const [row] = await db
      .select({ destinationCountry: orders.destinationCountry })
      .from(orders)
      .where(eq(orders.id, orderId));
    if (!row) throw new Error(`no order ${orderId}`);
    return row.destinationCountry;
  };

  /* ---------------------------------------------------------------- *
   * The three properties
   * ---------------------------------------------------------------- */

  it('stores the destination the customer chose', async () => {
    const { submit, orderId } = await cart();

    const submitted = await submit({ contact: { email: `dest-store-${tag}@probe.invalid`, destinationCountry: 'TH' } });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);

    expect(await destinationOf(orderId)).toBe('TH');
  });

  it('does not erase a destination the cart already had', async () => {
    /*
     * orders.service.ts:780-790 records why, for the three fields beside this one: "A submit
     * that carries only a telephone number must not *erase* an address a cart already had."
     * The destination follows the identical `body.contact.X ?? order.X` shape.
     */
    const { submit, orderId, setDestination } = await cart();
    await setDestination('TH');

    /* E.164 — `phoneSchema` (order.ts) refuses anything else, including a bare local number. */
    const submitted = await submit({ contact: { phone: '+66812345678' } });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);

    expect(await destinationOf(orderId)).toBe('TH');
  });

  it('refuses a lower-case code at the contract, not at the database', async () => {
    const { submit, orderId } = await cart();

    const refused = await submit({ contact: { email: `dest-refuse-${tag}@probe.invalid`, destinationCountry: 'th' } });
    expect(refused.status, JSON.stringify(refused.body)).toBe(400);

    /* And nothing was written: the order is still a cart, with no destination stored. */
    expect(await destinationOf(orderId)).toBeNull();
  });
});

/**
 * A line the *running* catalogue would accept, built from the published document it names.
 *
 * Copied from `lifecycle.pg.test.ts` / `traps.pg.test.ts` rather than shared, matching this
 * suite directory's own convention of one self-contained helper per `.pg.test.ts` file.
 */
async function liveLine(call: ReturnType<typeof client>): Promise<OrderLineRequestWire> {
  const listed = await call('GET', '/catalog/products', {});
  if (listed.status !== 200) throw new Error(`the catalogue is not being served: ${listed.status}`);

  const wire = listed.body as { products: readonly { productVersionId: string; documentHash: string; product: { id: string } }[] };

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
      qty: 2,
    };
  }

  throw new Error('no published product with a measurement to order');
}
