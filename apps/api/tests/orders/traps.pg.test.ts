import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, createPool, type Database, type Pool } from '@wewin/db/client';
import { sql } from '@wewin/db/sql';
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
import { confirmQuotation } from '../support/confirm-quotation';

/**
 * ONE TEST PER TRAP — plan 7.4's seven, each one red the moment its fix is removed.
 *
 * ── Why this file exists when the properties are already covered elsewhere ───────
 *
 * They are, in six suites, mixed in with everything else those suites are about. That is
 * fine for catching a regression and useless for the question this file answers, which is
 * the one the phase brief asks directly: *remove the fix, does something go red, and is it
 * obvious which fix it was?* A trap whose only cover is an assertion inside a test named
 * after something else gets "fixed" by deleting the assertion.
 *
 * So each case below names its trap, names the exact mechanism it depends on, and says what
 * to break to see it fail. The mutation results are recorded in `docs/monorepo-plan.md`
 * §7.14 rather than here, because a comment claiming a test failed is not evidence.
 *
 * Everything runs over real HTTP against real Postgres. Six of the seven cannot be tested
 * any other way — the transition table, the payload-key check, the deferred foreign key, the
 * ownership WHERE clause and the child-row status guard are all in the database, and a
 * mocked repository has none of them.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

const tag = randomUUID().slice(0, 8);
const contactFor = (who: string): { email: string; name: string } => ({
  email: `traps-${who}-${tag}@probe.invalid`,
  name: `plan 7.4 traps ${tag}`,
});

describeWithPg('plan 7.4 — the seven traps, one test each', () => {
  let pool: Pool;
  let db: Database;
  let app: LifecycleApp;
  let call: ReturnType<typeof client>;

  let staff: Actor;
  let customerA: Actor;
  let customerB: Actor;
  let line: OrderLineRequestWire;

  beforeAll(async () => {
    pool = createPool(url ?? '');
    db = createDatabase(pool);
    app = await bootLifecycleApp(lifecycleEnv(url ?? ''));
    call = client(app.baseUrl);

    staff = await makeActor(db, app, `traps staff ${tag}`, ['orders.read', 'orders.write']);
    customerA = await makeActor(db, app, `traps customer A ${tag}`, []);
    customerB = await makeActor(db, app, `traps customer B ${tag}`, []);
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
    auth: { token?: string; cookie?: string },
    body: unknown = {},
  ): Promise<Json> => call('POST', `/orders/${orderId}/transitions/${toStatus}`, { ...auth, body });

  const draftOf = async (actor: Actor): Promise<string> => {
    const created = await call('POST', '/orders', { token: actor.token, body: {} });
    expect(created.status).toBe(201);
    return (created.body as OrderWire).id;
  };

  const submittedOf = async (actor: Actor, who: string): Promise<OrderWire> => {
    const draft = await draftOf(actor);
    const done = await move(draft, 'awaiting_payment', { token: actor.token }, {
      contact: contactFor(who),
      lines: [line],
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);

    /* A submit lands unconfirmed since 0056; the traps below are about a payable order. */
    await confirmQuotation(db, draft);
    const confirmed = await call('GET', `/orders/${draft}`, { token: actor.token });
    return confirmed.body as OrderWire;
  };

  const frozenOf = async (actor: Actor, who: string): Promise<OrderWire> => {
    const order = await submittedOf(actor, who);
    const confirmed = await move(order.id, 'production_confirmed', { token: staff.token });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    return confirmed.body as OrderWire;
  };

  /**
   * Raw rows.
   *
   * `db.execute` answers a `QueryResult`, whose `rows` is the array — Drizzle's own typings
   * describe it as an array-like and destructuring the result directly gives "not iterable"
   * at runtime, which is a confusing way to learn that.
   */
  const rows = async <T>(query: ReturnType<typeof sql>): Promise<T[]> =>
    (await db.execute(query)).rows as T[];

  /* ================================================================= *
   * TRAP 1 — the circular NOT NULL foreign key
   * ================================================================= */

  /**
   * `orders.status_event_id → order_events.id` and `order_events.order_id → orders.id`, both
   * NOT NULL, make an order impossible to insert at all: whichever row goes first names one
   * that does not exist.
   *
   * **The fix:** `orders_status_event_fk` is `DEFERRABLE INITIALLY DEFERRED`, so the
   * constraint is checked at COMMIT and both rows are there by then. It costs exactly one
   * thing — the caller has to choose the event's id before inserting either row, which is
   * the whole of `OrderRepository.createDraft`.
   *
   * **Remove it to watch this fail:** drop `DEFERRABLE INITIALLY DEFERRED` from
   * `orders_status_event_fk` in `0006_orders.sql`. Creating any order then fails outright.
   */
  it('TRAP 1 — an order can be created at all, and only because the FK defers to COMMIT', async () => {
    /* The half that proves the cycle is real rather than avoided: it must still be a cycle. */
    const [constraint] = await rows<{ condeferrable: boolean; condeferred: boolean }>(sql`
      select condeferrable, condeferred
        from pg_constraint
       where conname = 'orders_status_event_fk'
    `);
    expect(constraint?.condeferrable, 'orders_status_event_fk is no longer deferrable').toBe(true);
    expect(constraint?.condeferred).toBe(true);

    /* And the half that proves the deferral is what carries the insert. */
    const orderId = await draftOf(customerA);
    const [created] = await rows<{ status_event_id: string; event_id: string }>(sql`
      select o.status_event_id, e.id as event_id
        from orders o join order_events e on e.id = o.status_event_id
       where o.id = ${orderId}
    `);
    expect(created?.status_event_id).toBe(created?.event_id);

    /*
     * The deferral is not a licence to skip the event. An order naming an event that never
     * materialises fails at COMMIT — several statements after the cause, which is the price
     * of the deferral and the reason the repository writes both rows in one place.
     */
    const orphan = await db
      .transaction(async (tx) => {
        await tx.execute(sql`
          insert into orders (customer_user_id, status, status_event_id)
          values (${customerA.userId}, 'draft', ${randomUUID()})
        `);
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(String((orphan as { cause?: unknown } | undefined)?.cause)).toContain(
      'orders_status_event_fk',
    );
  });

  /* ================================================================= *
   * TRAP 2 — authorisation that checks the actor TYPE and not the actor
   * ================================================================= */

  /**
   * `actors: ['customer']` does not mean *this* customer. Any signed-in customer who learns
   * an id cancels somebody else's order.
   *
   * **The fix:** ownership is a term in the query that loads the order —
   * `ownershipFilter(reach)` in `src/orders/scope/order-ownership.ts` — and there is no other
   * loader. A row that did not come out of it is a `ScopedOrder` nothing can construct.
   *
   * **Remove it to watch this fail:** make the `owned` branch of `ownershipFilter` return
   * ``sql`true` ``. Every assertion below flips from 404 to 200.
   */
  it('TRAP 2 — a stranger reaches somebody else’s order on no route, read or write', async () => {
    const order = await submittedOf(customerA, 'trap2');

    for (const path of ['', '/events', '/document'] as const) {
      const answer = await call('GET', `/orders/${order.id}${path}`, { token: customerB.token });
      expect(answer.status, `GET ${path} -> ${JSON.stringify(answer.body)}`).toBe(404);
      expect(JSON.stringify(answer.body)).not.toContain(contactFor('trap2').email);
    }

    /* The write path is the same lock and not a second one. */
    const cancelled = await move(order.id, 'cancelled', { token: customerB.token }, {
      reason: 'not mine',
    });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(404);

    const objected = await call('POST', `/orders/${order.id}/change-requests`, {
      token: customerB.token,
      body: { noteTh: 'not mine either' },
    });
    expect(objected.status).toBe(404);

    /* Nothing moved, and it is still the owner's. */
    const owner = await call('GET', `/orders/${order.id}`, { token: customerA.token });
    expect((owner.body as OrderWire).status).toBe('awaiting_payment');

    /*
     * 404 and never 403. Two status codes would be an oracle for counting the company's
     * orders, so "does not exist" and "not yours" have to be indistinguishable.
     */
    const ghost = await call('GET', `/orders/${randomUUID()}`, { token: customerB.token });
    expect(ghost.status).toBe(404);
  });

  /* ================================================================= *
   * TRAP 3 — nothing pinned between submit and accept
   * ================================================================= */

  /**
   * Sales looks at the slip hours later. If a catalogue version was published in between, the
   * contract is built from a different document than the customer saw.
   *
   * **The fix:** submit pins. `order_documents` holds a frozen JSONB document with its hash,
   * and `order_document_product_versions` records which published catalogue version each line
   * was priced from — as a foreign key, so the citation cannot be re-pointed and the version
   * cannot be deleted out from under it.
   *
   * **Remove it to watch this fail:** stop inserting `order_document_product_versions` in
   * `OrderRepository.pinDocument`, or stop writing `order_documents` at all.
   */
  it('TRAP 3 — submit freezes a document and cites the catalogue version it was priced from', async () => {
    const order = await submittedOf(customerA, 'trap3');

    const document = await call('GET', `/orders/${order.id}/document`, { token: customerA.token });
    expect(document.status).toBe(200);
    /* ⚠️ `seller` is beside `document`, not inside it — see `OrderDocumentResponseWire`. */
    const pinned = (
      document.body as { document: { documentHash: string; lines: readonly { productVersionId: string }[] } }
    ).document;
    expect(pinned.documentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(pinned.lines[0]?.productVersionId).toBe(line.productVersionId);

    /* The citation is a real foreign key row, not a string inside the JSON. */
    const cited = await rows<{ product_version_id: string }>(sql`
      select v.product_version_id
        from order_document_product_versions v
        join order_documents d on d.id = v.order_document_id
       where d.order_id = ${order.id}
    `);
    expect(cited.map((row) => row.product_version_id)).toContain(line.productVersionId);

    /* And the pinned document is frozen: the database refuses to rewrite it. */
    const rewrite = await db
      .execute(sql`update order_documents set document_hash = repeat('0', 64) where order_id = ${order.id}`)
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(rewrite, 'a pinned document was rewritable').toBeDefined();

    /* …and refuses to delete the catalogue version the contract cites. */
    const unpin = await db
      .execute(sql`delete from product_versions where id = ${line.productVersionId}`)
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(unpin, 'a cited catalogue version was deletable').toBeDefined();
  });

  /* ================================================================= *
   * TRAP 4 — `Array.find` picking the wrong transition
   * ================================================================= */

  /**
   * `cancel` has two rows, before and after the freeze. Choosing the schema before loading the
   * order gets the pre-freeze one, and zod strips the `fault` the post-freeze one needs —
   * silently, in the caller's favour or against it depending on who typed the request.
   *
   * **The fix, in three layers:** the payload kind is a column on
   * `order_status_transitions`, whose primary key is `(from_status, to_status)`, so it cannot
   * be read without the locked row; the schemas are `z.strictObject`, so a wrongly-chosen one
   * is a 400 rather than a silent strip; and `required_payload_keys` is checked by the
   * database on the insert.
   *
   * **Remove it to watch this fail:** choose the schema from `toStatus` alone in
   * `OrdersService.transition` (the trap as written).
   */
  it('TRAP 4 — the payload schema is chosen after the lock, so the two cancellations differ', async () => {
    /* Pre-freeze: the schema has no `fault`, and the event carries none. */
    const early = await submittedOf(customerA, 'trap4-early');
    expect((await move(early.id, 'cancelled', { token: customerA.token }, { reason: 'เปลี่ยนใจ' })).status).toBe(200);

    const [earlyEvent] = await rows<{ payload: Record<string, unknown> }>(sql`
      select payload from order_events where order_id = ${early.id} and event_type = 'cancelled'
    `);
    expect(earlyEvent?.payload).not.toHaveProperty('fault');

    /* Post-freeze, same route, same destination, different schema — and `fault` is required. */
    const late = await frozenOf(customerA, 'trap4-late');
    expect((await move(late.id, 'cancelled', { token: staff.token }, { reason: 'ยกเลิกหลัง freeze' })).status).toBe(200);

    const [lateEvent] = await rows<{ payload: Record<string, unknown> }>(sql`
      select payload from order_events where order_id = ${late.id} and event_type = 'cancelled'
    `);
    expect(lateEvent?.payload['fault']).toBe('customer');

    /*
     * The strictness layer: a customer sending the staff-only key is a 400 and not a silent
     * strip — an attempt to decide one's own refund must not look to the client like it worked.
     */
    const smuggled = await frozenOf(customerA, 'trap4-smuggle');
    const refused = await move(smuggled.id, 'cancelled', { token: customerA.token }, {
      reason: 'บริษัทผิด',
      attributeFaultToCompany: true,
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(400);

    /*
     * The database layer, straight at it: the required key is declared as data, and an event
     * written without it is refused by `order_events_guard_insert()` rather than by any code.
     */
    const [row] = await rows<{ required_payload_keys: string[] }>(sql`
      select required_payload_keys from order_status_transitions
       where from_status = 'production_confirmed' and to_status = 'cancelled'
    `);
    expect(row?.required_payload_keys).toContain('fault');
  });

  /* ================================================================= *
   * TRAP 5 — `request_change` with nothing to clear it
   * ================================================================= */

  /**
   * The first objection blocks every later one for the life of the order, because the partial
   * unique index that allows one open request at a time *is* the bug when nothing closes one.
   *
   * **The fix:** `POST /orders/:id/change-requests/:crId/resolution` — staff accept or reject,
   * the customer withdraws — and the resolution is an event on the spine like everything else.
   *
   * **Remove it to watch this fail:** delete `resolveChangeRequest` from the controller, or
   * stop setting `resolution` in `OrderRepository.resolveChangeRequest`.
   */
  it('TRAP 5 — an objection can be answered, and a second one can then be raised', async () => {
    const order = await submittedOf(customerA, 'trap5');

    const first = await call('POST', `/orders/${order.id}/change-requests`, {
      token: customerA.token,
      body: { noteTh: 'ขอเปลี่ยนสี' },
    });
    expect(first.status, JSON.stringify(first.body)).toBe(201);

    /* While it is open a second is refused and the freeze is blocked — that is the block working. */
    const second = await call('POST', `/orders/${order.id}/change-requests`, {
      token: customerA.token,
      body: { noteTh: 'ขออีก' },
    });
    expect(second.status).toBe(409);
    expect((await move(order.id, 'production_confirmed', { token: staff.token })).status).toBe(409);

    /* The way out. */
    const crId = (first.body as { id: string }).id;
    const answered = await call('POST', `/orders/${order.id}/change-requests/${crId}/resolution`, {
      token: staff.token,
      body: { resolution: 'rejected', noteTh: 'ราคานี้ทำไม่ได้' },
    });
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    expect((answered.body as { resolution: string }).resolution).toBe('rejected');

    /* …and it is a way out for the *next* one too, which is the whole of the trap. */
    const third = await call('POST', `/orders/${order.id}/change-requests`, {
      token: customerA.token,
      body: { noteTh: 'งั้นขอแบบเดิม' },
    });
    expect(third.status, JSON.stringify(third.body)).toBe(201);

    const withdrawn = await call(
      'POST',
      `/orders/${order.id}/change-requests/${(third.body as { id: string }).id}/resolution`,
      { token: customerA.token, body: { resolution: 'withdrawn' } },
    );
    expect(withdrawn.status).toBe(200);

    /* Nothing is blocking the freeze any more. */
    expect((await move(order.id, 'production_confirmed', { token: staff.token })).status).toBe(200);
  });

  /* ================================================================= *
   * TRAP 6 — a child row written against an order that has moved on
   * ================================================================= */

  /**
   * Plan 7.4's wording is about slip upload, which is 5b's; the mechanism is general and is
   * the part that matters. `SELECT … FOR UPDATE` in the *transition* only orders the race. It
   * does not stop the loser inserting a child row against an order that has meanwhile moved,
   * because the child INSERT never looked at the order at all.
   *
   * **The fix:** `order_child_require_status()` is a trigger on the child table that takes
   * `FOR SHARE` on the parent — so it blocks behind the transition's own lock, re-reads the
   * row as the winner left it under READ COMMITTED, and refuses. 5a's only child table is
   * `order_change_requests`; `slips` attaches to the same function in 5b.
   *
   * **Remove it to watch this fail:** delete the `CREATE TRIGGER` and this case goes red.
   *
   * ⚠️ Dropping only the `FOR SHARE` does **not** turn this case red, and that was measured
   * rather than assumed. Through HTTP the child insert is preceded by an `order_events`
   * insert whose foreign key takes `FOR KEY SHARE` on the same order row, so the request
   * blocks behind the transition's `FOR UPDATE` either way — the lock this test can observe
   * is not the one the trigger takes. The half that isolates it has to insert into
   * `order_change_requests` directly from a second connection, and it exists:
   * `packages/db/tests/order.test.ts` → "loses the race it was already in — the half
   * `FOR UPDATE` does not buy", which goes red on exactly that mutation. Recorded here so
   * that nobody removes `FOR SHARE`, sees this file green, and concludes it was decoration.
   */
  it('TRAP 6 — a child row is refused by the order’s status, even when it races the move', async () => {
    /* Sequential: `delivered` is not a status an objection may be raised against. */
    const done = await frozenOf(customerA, 'trap6');
    for (const to of ['in_production', 'awaiting_installation', 'delivered']) {
      expect((await move(done.id, to, { token: staff.token })).status, to).toBe(200);
    }

    const late = await call('POST', `/orders/${done.id}/change-requests`, {
      token: customerA.token,
      body: { noteTh: 'หลังส่งมอบ' },
    });
    expect(late.status, JSON.stringify(late.body)).toBe(409);

    /*
     * Concurrent, which is the half `FOR SHARE` is for: the objection is sent at the same
     * instant as the move that makes it illegal. Whichever wins, the two must agree — an
     * accepted objection implies a status that permits one.
     */
    const racing = await frozenOf(customerA, 'trap6-race');
    for (const to of ['in_production', 'awaiting_installation']) {
      expect((await move(racing.id, to, { token: staff.token })).status, to).toBe(200);
    }

    const [deliver, object] = await Promise.all([
      move(racing.id, 'delivered', { token: staff.token }),
      call('POST', `/orders/${racing.id}/change-requests`, {
        token: customerA.token,
        body: { noteTh: 'ขอแก้ก่อนส่ง' },
      }),
    ]);

    const [state] = await rows<{ status: string; open_requests: string }>(sql`
      select o.status,
             (select count(*) from order_change_requests c
               where c.order_id = o.id and c.resolution is null)::text as open_requests
        from orders o where o.id = ${racing.id}
    `);

    const note = JSON.stringify([deliver.body, object.body, state]);
    expect(deliver.status, note).toBe(200);
    if (object.status === 201) {
      /*
       * The objection went first. Then the delivery had to wait for *it*, which is the same
       * lock seen from the other side — and the row is consistent either way.
       */
      expect(state?.open_requests, note).toBe('1');
    } else {
      expect(object.status, note).toBe(409);
      expect(state?.open_requests, note).toBe('0');
    }
    expect(state?.status).toBe('delivered');
  });

  /* ================================================================= *
   * TRAP 7 — a revision order that abandons the money already received
   * ================================================================= */

  /**
   * Plan 7.4's seventh, as 7.8 answers it: money already received has to be *carriable* to
   * the replacement order, as an allocation pointing back at where it came from — never as a
   * fresh instalment row on the new order, which is how one payment comes to be reported by
   * two orders forever.
   *
   * 5a owns the half that makes that possible and 5b owns the ledger. The half here is the
   * link and the status:
   *
   *   - superseding **creates the successor in the same transaction**, so there is never a
   *     window in which the predecessor is closed and nothing points anywhere;
   *   - `orders.supersedes_order_id` is that pointer, it is unique, and it is the anchor
   *     5b's `carried_from_order_id` allocation hangs from;
   *   - the predecessor becomes `superseded` and **not** `cancelled`, which is plan 7.1's
   *     whole reason for the ninth status: otherwise every post-freeze edit shows up in the
   *     cancellation report as lost business, and the number sales reads is wrong from day one.
   *
   * **Remove it to watch this fail:** stop creating the successor in
   * `OrdersService.applyTransition`'s `supersede` branch. `orders_guard_update()` refuses the
   * move outright — "a cancellation wearing a better word" — so the transition 409s.
   */
  it('TRAP 7 — superseding produces a successor that points back, and does not report as a cancellation', async () => {
    const order = await frozenOf(customerA, 'trap7');
    expect((await move(order.id, 'redesign', { token: staff.token }, { reason: 'ผลิตไม่ได้' })).status).toBe(200);

    const superseded = await move(order.id, 'superseded', { token: staff.token }, {
      reason: 'ส่วนต่างเกินที่บริษัทรับไหว',
    });
    expect(superseded.status, JSON.stringify(superseded.body)).toBe(200);

    const successorId = (superseded.body as OrderWire).supersededByOrderId;
    expect(successorId, 'no successor was created').not.toBeNull();

    const [successor] = await rows<{
      id: string;
      status: string;
      supersedes_order_id: string;
      customer_user_id: string;
      contact_email: string;
    }>(sql`select id, status, supersedes_order_id, customer_user_id, contact_email
             from orders where id = ${successorId}`);

    /* The pointer money will travel along, and the same customer at the other end of it. */
    expect(successor?.supersedes_order_id).toBe(order.id);
    expect(successor?.status).toBe('draft');
    expect(successor?.customer_user_id).toBe(customerA.userId);
    expect(successor?.contact_email).toBe(contactFor('trap7').email);

    /* One successor, enforced by the schema rather than by whoever writes the next path. */
    const duplicate = await db
      .execute(sql`
        insert into orders (customer_user_id, status, status_event_id, supersedes_order_id)
        values (${customerA.userId}, 'draft', ${randomUUID()}, ${order.id})
      `)
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(duplicate, 'a second successor was accepted').toBeDefined();

    /* And the predecessor is not lost business. */
    const [predecessor] = await rows<{ status: string }>(
      sql`select status from orders where id = ${order.id}`,
    );
    expect(predecessor?.status).toBe('superseded');

    const cancellations = await rows<{ n: string }>(sql`
      select count(*)::text as n from orders
       where status = 'cancelled' and contact_email = ${contactFor('trap7').email}
    `);
    expect(cancellations[0]?.n).toBe('0');
  });
});

/**
 * A line the *running* catalogue would accept, built from the published document it names.
 *
 * The same shape as the lifecycle suite's, and deliberately not shared with it: this file has
 * to keep working if that one is deleted, and a fixture helper imported across suites is the
 * thing that makes "which file seeded this" unanswerable.
 */
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
        enteredUnits[group.code] = 'cm';
      }
    }

    return {
      productId: product.id,
      productVersionId: published.productVersionId,
      documentHash: published.documentHash,
      selections,
      measures,
      enteredUnits,
      qty: 1,
    };
  }

  throw new Error('no published product with a custom group to configure');
}
