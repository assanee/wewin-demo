import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, createPool, type Database, type Pool } from '@wewin/db/client';
import { sql } from '@wewin/db/sql';
import { orderDocumentProductVersions } from '@wewin/db/schema';
import { products } from '@wewin/core/fixtures';
import type { Product } from '@wewin/core';
import { encodeUm } from '@wewin/contract/measure';
import type { OrderLineRequestWire, OrderWire } from '@wewin/contract/order';

import { MAX_CHANGE_REQUESTS_PER_ORDER_DEFAULT } from '../../src/orders/defaults';

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
 * RED TEAM — phase 5a lifecycle. Reproductions only; nothing here is a fix.
 *
 * Every `it` below is an attempt to break a stated guarantee. A test that PASSES here means
 * the attack was defeated; a test that FAILS is a finding with a reproduction attached.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

const tag = randomUUID().slice(0, 8);
const contactFor = (who: string): { email: string; name: string } => ({
  email: `orders-rt5-${who}-${tag}@probe.invalid`,
  name: `redteam 5a ${tag}`,
});

describeWithPg('RED TEAM 5a — the order lifecycle', () => {
  let pool: Pool;
  let db: Database;
  let app: LifecycleApp;
  let call: ReturnType<typeof client>;

  let staff: Actor;
  let staffWriteOnly: Actor;
  let staffReadOnly: Actor;
  let customerA: Actor;
  let customerB: Actor;
  let line: OrderLineRequestWire;

  beforeAll(async () => {
    pool = createPool(url ?? '');
    db = createDatabase(pool);
    app = await bootLifecycleApp(lifecycleEnv(url ?? ''));
    call = client(app.baseUrl);

    staff = await makeActor(db, app, `rt5 staff ${tag}`, ['orders.read', 'orders.write']);
    staffWriteOnly = await makeActor(db, app, `rt5 write only ${tag}`, ['orders.write']);
    staffReadOnly = await makeActor(db, app, `rt5 read only ${tag}`, ['orders.read']);
    customerA = await makeActor(db, app, `rt5 customer A ${tag}`, []);
    customerB = await makeActor(db, app, `rt5 customer B ${tag}`, []);

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
         where o.contact_email like 'orders-rt5-%@probe.invalid'
      )
    `);
    await app.close();
    await pool.end();
  });

  type Auth = { token?: string; cookie?: string };

  const create = (auth: Auth): Promise<Json> => call('POST', '/orders', { ...auth, body: {} });

  const move = (orderId: string, to: string, auth: Auth, body: unknown = {}): Promise<Json> =>
    call('POST', `/orders/${orderId}/transitions/${to}`, { ...auth, body });

  const submit = (orderId: string, auth: Auth, who: string): Promise<Json> =>
    move(orderId, 'awaiting_payment', auth, { contact: contactFor(who), lines: [line] });

  /** A submitted order owned by customer A, at `awaiting_payment`. */
  const submitted = async (who: string): Promise<OrderWire> => {
    const created = await create({ token: customerA.token });
    expect(created.status).toBe(201);
    const draft = created.body as OrderWire;
    const done = await submit(draft.id, { token: customerA.token }, who);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    return done.body as OrderWire;
  };

  /** A frozen order (`production_confirmed`) owned by customer A. */
  const frozen = async (who: string): Promise<OrderWire> => {
    const order = await submitted(who);
    const confirmed = await move(order.id, 'production_confirmed', { token: staff.token });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    return confirmed.body as OrderWire;
  };

  /** `db.execute` hands back a pg `Result`; every probe below wants the rows. */
  const rows = async <T>(query: Parameters<Database['execute']>[0]): Promise<T[]> => {
    const result = (await db.execute(query)) as unknown as { rows?: T[] } | T[];
    return Array.isArray(result) ? result : (result.rows ?? []);
  };

  const statusOf = async (orderId: string): Promise<string> => {
    const [row] = await rows<{ status: string }>(
      sql`select status from orders where id = ${orderId}`,
    );
    return row?.status ?? 'MISSING';
  };

  const eventRows = async (orderId: string): Promise<{ seq: number; event_type: string; to_status: string | null }[]> =>
    rows(sql`select seq, event_type, to_status from order_events where order_id = ${orderId} order by seq`);

  const notificationRows = async (
    orderId: string,
  ): Promise<{ event_id: string; recipient_kind: string; recipient_key: string | null; status: string }[]> =>
    rows(
      sql`select event_id, recipient_kind, recipient_key, status from notifications where order_id = ${orderId}`,
    );

  /* ================================================================= *
   * ATTACK 1 — race two transitions on one order
   * ================================================================= */

  it('A1 two concurrent confirm_payment calls produce one freeze, not two', async () => {
    const order = await submitted('a1');

    const [first, second] = await Promise.all([
      move(order.id, 'production_confirmed', { token: staff.token }),
      move(order.id, 'production_confirmed', { token: staff.token }),
    ]);

    const codes = [first.status, second.status].sort();
    expect(codes, JSON.stringify([first.body, second.body])).toEqual([200, 409]);

    const events = await eventRows(order.id);
    expect(events.filter((e) => e.event_type === 'payment_confirmed')).toHaveLength(1);
    expect(await statusOf(order.id)).toBe('production_confirmed');
  });

  /**
   * ⚠️ Rewritten, because the assertion it used to make was not an invariant.
   *
   * It asserted "exactly one lands" and passed on the run that produced it — the cancel
   * happened to win the lock, which makes the confirm a 409 out of `cancelled`. When the
   * *confirm* wins, the cancel arrives at `production_confirmed`, which has a legal
   * post-freeze cancellation (plan 7.8: forfeit 0 at that status, because nothing has been
   * cut yet) — so both succeed, and that is correct rather than a race being lost.
   *
   * The property that actually holds under either ordering is the one below: the two writes
   * serialise, the spine records exactly what happened in order, and the row agrees with the
   * event it names. Pinning the accidental ordering instead would have made this test fail
   * on a faster machine and be "fixed" by somebody who did not know which half was the bug.
   */
  it('A1b cancel racing confirm_payment: the two serialise, and the row agrees with the spine', async () => {
    const order = await submitted('a1b');

    const [cancel, confirm] = await Promise.all([
      move(order.id, 'cancelled', { token: customerA.token }, { reason: 'เปลี่ยนใจ' }),
      move(order.id, 'production_confirmed', { token: staff.token }),
    ]);

    const codes = [cancel.status, confirm.status];
    const events = await eventRows(order.id);
    const moves = events.filter((e) => e.to_status !== null && e.event_type !== 'created');
    const note = JSON.stringify([cancel.body, confirm.body]);

    if (cancel.status === 200 && confirm.status === 200) {
      /* The confirm went first: the cancellation is the legal post-freeze one. */
      expect(moves.map((e) => e.event_type), note).toStrictEqual([
        'submitted_for_payment',
        'payment_confirmed',
        'cancelled',
      ]);
    } else {
      /* The cancel went first: `cancelled` is terminal, so the confirm is a conflict. */
      expect(codes.sort(), note).toStrictEqual([200, 409]);
      expect(moves.map((e) => e.event_type), note).toStrictEqual([
        'submitted_for_payment',
        'cancelled',
      ]);
    }

    /* Either way: contiguous seq, and the order's status is the last event's destination. */
    expect(events.map((e) => e.seq)).toStrictEqual(events.map((_, i) => i + 1));
    expect(await statusOf(order.id)).toBe(moves.at(-1)?.to_status);
  });

  it('A1c two concurrent submits produce one order_no and one document', async () => {
    const created = await create({ token: customerA.token });
    const draft = (created.body as OrderWire).id;

    const [one, two] = await Promise.all([
      submit(draft, { token: customerA.token }, 'a1c'),
      submit(draft, { token: customerA.token }, 'a1c'),
    ]);

    expect([one.status, two.status].sort(), JSON.stringify([one.body, two.body])).toEqual([200, 409]);

    const [docs] = await rows<{ n: string }>(
      sql`select count(*)::text as n from order_documents where order_id = ${draft}`,
    );
    expect(docs?.n).toBe('1');
  });

  /* ================================================================= *
   * ATTACK 2 — illegal moves, especially across the freeze
   * ================================================================= */

  it('A2 no route back across the freeze, and terminal means terminal', async () => {
    const order = await frozen('a2');

    /* Thawing. */
    expect((await move(order.id, 'awaiting_payment', { token: staff.token })).status).toBe(409);
    expect((await move(order.id, 'draft', { token: staff.token })).status).toBe(409);

    /* Skipping production. */
    expect((await move(order.id, 'delivered', { token: staff.token })).status).toBe(409);
    expect((await move(order.id, 'awaiting_installation', { token: staff.token })).status).toBe(409);

    /* Self-transition. */
    expect((await move(order.id, 'production_confirmed', { token: staff.token })).status).toBe(409);

    expect(await statusOf(order.id)).toBe('production_confirmed');
  });

  it('A2b a cancelled order accepts nothing at all', async () => {
    const order = await submitted('a2b');
    expect((await move(order.id, 'cancelled', { token: customerA.token }, { reason: 'พอแล้ว' })).status).toBe(200);

    for (const to of [
      'draft',
      'awaiting_payment',
      'production_confirmed',
      'in_production',
      'awaiting_installation',
      'delivered',
      'redesign',
      'cancelled',
      'superseded',
    ]) {
      const answer = await move(order.id, to, { token: staff.token }, { reason: 'x' });
      expect([409, 400], `${to} → ${answer.status} ${JSON.stringify(answer.body)}`).toContain(
        answer.status,
      );
    }
    expect(await statusOf(order.id)).toBe('cancelled');
  });

  it('A2c a delivered order is terminal — no bounce, no cancellation, no warranty path', async () => {
    const order = await frozen('a2c');
    expect((await move(order.id, 'in_production', { token: staff.token })).status).toBe(200);
    expect((await move(order.id, 'awaiting_installation', { token: staff.token })).status).toBe(200);
    expect((await move(order.id, 'delivered', { token: staff.token })).status).toBe(200);

    for (const to of ['redesign', 'cancelled', 'superseded', 'in_production']) {
      const answer = await move(order.id, to, { token: staff.token }, { reason: 'x' });
      expect([409, 400], `${to} → ${answer.status}`).toContain(answer.status);
    }
  });

  /* ================================================================= *
   * ATTACK 3 — the payload-schema trap
   * ================================================================= */

  it('A3 a post-freeze cancellation keeps `fault`; the pre-freeze one has none', async () => {
    const post = await frozen('a3-post');
    const cancelled = await move(post.id, 'cancelled', { token: customerA.token }, { reason: 'หยุดก่อน' });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);

    const [postEvent] = await rows<{ payload: Record<string, unknown> }>(
      sql`select payload from order_events where order_id = ${post.id} and event_type = 'cancelled'`,
    );
    expect(postEvent?.payload).toMatchObject({ fault: 'customer' });

    const pre = await submitted('a3-pre');
    expect((await move(pre.id, 'cancelled', { token: customerA.token }, { reason: 'ยังไม่จ่าย' })).status).toBe(200);
    const [preEvent] = await rows<{ payload: Record<string, unknown> }>(
      sql`select payload from order_events where order_id = ${pre.id} and event_type = 'cancelled'`,
    );
    expect(preEvent?.payload).not.toHaveProperty('fault');
  });

  it('A3b a customer cannot set their own fault, and is told so rather than ignored', async () => {
    const order = await frozen('a3b');
    const answer = await move(
      order.id,
      'cancelled',
      { token: customerA.token },
      { reason: 'บริษัทผิด', attributeFaultToCompany: true },
    );
    expect(answer.status, JSON.stringify(answer.body)).toBe(400);
    expect(await statusOf(order.id)).toBe('production_confirmed');
  });

  it('A3c staff cannot invent a company fault without a bounce on the spine', async () => {
    const order = await frozen('a3c');
    const answer = await move(
      order.id,
      'cancelled',
      { token: staff.token },
      { reason: 'ยกให้ลูกค้า', attributeFaultToCompany: true },
    );
    expect(answer.status, JSON.stringify(answer.body)).toBe(422);
    expect(await statusOf(order.id)).toBe('production_confirmed');
  });

  it('A3d a cancellation with no reason at all is refused on both sides of the freeze', async () => {
    const post = await frozen('a3d-post');
    expect((await move(post.id, 'cancelled', { token: staff.token }, {})).status).toBe(400);

    const pre = await submitted('a3d-pre');
    expect((await move(pre.id, 'cancelled', { token: customerA.token }, {})).status).toBe(400);

    expect(await statusOf(post.id)).toBe('production_confirmed');
    expect(await statusOf(pre.id)).toBe('awaiting_payment');
  });

  /* ================================================================= *
   * ATTACK 4 — a change request with nothing to clear it
   * ================================================================= */

  it('A4 an objection can always be answered, from every status it can be raised in', async () => {
    /* Raised while in production, then the order is delivered on top of it. */
    const order = await frozen('a4');
    expect((await move(order.id, 'in_production', { token: staff.token })).status).toBe(200);

    const opened = await call('POST', `/orders/${order.id}/change-requests`, {
      token: customerA.token,
      body: { noteTh: 'ขอเปลี่ยนสี' },
    });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    const crId = (opened.body as { id: string }).id;

    /* Delivery is NOT blocked by an open objection — only entry to production is. */
    expect((await move(order.id, 'awaiting_installation', { token: staff.token })).status).toBe(200);
    expect((await move(order.id, 'delivered', { token: staff.token })).status).toBe(200);

    const resolved = await call('POST', `/orders/${order.id}/change-requests/${crId}/resolution`, {
      token: staff.token,
      body: { resolution: 'rejected' },
    });
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
  });

  it('A4b an objection open on a cancelled order can still be closed', async () => {
    const order = await submitted('a4b');
    const opened = await call('POST', `/orders/${order.id}/change-requests`, {
      token: customerA.token,
      body: { noteTh: 'ขอแก้ขนาด' },
    });
    expect(opened.status).toBe(201);
    const crId = (opened.body as { id: string }).id;

    expect((await move(order.id, 'cancelled', { token: customerA.token }, { reason: 'ไม่เอาแล้ว' })).status).toBe(200);

    const resolved = await call('POST', `/orders/${order.id}/change-requests/${crId}/resolution`, {
      token: staff.token,
      body: { resolution: 'rejected' },
    });
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
  });

  it('A4c a customer can hold the freeze open indefinitely by re-objecting', async () => {
    const order = await submitted('a4c');

    for (let round = 0; round < 5; round += 1) {
      const opened = await call('POST', `/orders/${order.id}/change-requests`, {
        token: customerA.token,
        body: { noteTh: `รอบที่ ${String(round)}` },
      });
      expect(opened.status, JSON.stringify(opened.body)).toBe(201);

      const blocked = await move(order.id, 'production_confirmed', { token: staff.token });
      expect(blocked.status, JSON.stringify(blocked.body)).toBe(409);

      const crId = (opened.body as { id: string }).id;
      const answered = await call('POST', `/orders/${order.id}/change-requests/${crId}/resolution`, {
        token: staff.token,
        body: { resolution: 'rejected' },
      });
      expect(answered.status).toBe(200);
    }

    /* Nothing caps it, nothing rate-limits it, nothing records it as abuse. */
    const [count] = await rows<{ n: string }>(
      sql`select count(*)::text as n from order_change_requests where order_id = ${order.id}`,
    );
    expect(count?.n).toBe('5');
    expect(await statusOf(order.id)).toBe('awaiting_payment');
  });

  it('A4d a second objection while one is open is a conflict, not a silent second row', async () => {
    const order = await submitted('a4d');
    const first = await call('POST', `/orders/${order.id}/change-requests`, {
      token: customerA.token,
      body: { noteTh: 'หนึ่ง' },
    });
    expect(first.status).toBe(201);

    const second = await call('POST', `/orders/${order.id}/change-requests`, {
      token: customerA.token,
      body: { noteTh: 'สอง' },
    });
    expect(second.status, JSON.stringify(second.body)).toBe(409);
  });

  it('A4e two concurrent objections on one order: one row, one conflict', async () => {
    const order = await submitted('a4e');
    const [one, two] = await Promise.all([
      call('POST', `/orders/${order.id}/change-requests`, { token: customerA.token, body: { noteTh: 'ก' } }),
      call('POST', `/orders/${order.id}/change-requests`, { token: customerA.token, body: { noteTh: 'ข' } }),
    ]);
    expect([one.status, two.status].sort(), JSON.stringify([one.body, two.body])).toEqual([201, 409]);
  });

  /**
   * ⚠️ Inverted. There was no actor-kind restriction on opening an objection at all, so a
   * member of staff could raise one — and then answer it, which turns the block on entering
   * production into something the company does to itself and calls consent. Plan 10.4 is
   * explicit about whose button it is.
   */
  it('A4f staff cannot raise an objection on the customer’s behalf', async () => {
    const order = await submitted('a4f');
    const opened = await call('POST', `/orders/${order.id}/change-requests`, {
      token: staff.token,
      body: { noteTh: 'เจ้าหน้าที่เปิดเอง' },
    });
    expect(opened.status, JSON.stringify(opened.body)).toBe(403);

    const written = await rows<{ actor_kind: string }>(sql`
      select e.actor_kind from order_events e
       where e.order_id = ${order.id} and e.event_type = 'change_requested'
    `);
    expect(written).toHaveLength(0);

    /* …and the order can still be frozen, because nothing is blocking it. */
    expect((await move(order.id, 'production_confirmed', { token: staff.token })).status).toBe(200);
  });

  /**
   * The customer's own button, capped — plan 13 has no number for this, and the cap is this
   * module's own default (`MAX_CHANGE_REQUESTS_PER_ORDER_DEFAULT`). Five rounds of
   * open → reject → open were demonstrated with nothing to stop a sixth, which holds an order
   * out of production for ever with every individual step legitimate.
   */
  it('A4g the objection cycle is bounded, and the bound is a documented default', async () => {
    const order = await submitted('a4g');

    let refusal: Awaited<ReturnType<typeof call>> | undefined;
    for (let round = 0; round < MAX_CHANGE_REQUESTS_PER_ORDER_DEFAULT + 1; round += 1) {
      const opened = await call('POST', `/orders/${order.id}/change-requests`, {
        token: customerA.token,
        body: { noteTh: `รอบที่ ${String(round + 1)}` },
      });

      if (opened.status === 409) {
        refusal = opened;
        break;
      }

      expect(opened.status, JSON.stringify(opened.body)).toBe(201);
      const crId = (opened.body as { id: string }).id;
      const answered = await call('POST', `/orders/${order.id}/change-requests/${crId}/resolution`, {
        token: staff.token,
        body: { resolution: 'rejected' },
      });
      expect(answered.status).toBe(200);
    }

    expect(refusal, 'the cycle was never refused').toBeDefined();
    expect(refusal?.status).toBe(409);

    const body = refusal?.body as { error: { details: { limit: number } } } | undefined;
    expect(body?.error.details.limit).toBe(MAX_CHANGE_REQUESTS_PER_ORDER_DEFAULT);
  }, 60_000);

  /* ================================================================= *
   * ATTACK 5 — the outbox: an event without its row, a row without its event
   * ================================================================= */

  it('A5 a refused child write takes its event and its notifications with it', async () => {
    /* `delivered` is not a status a change request may be opened against. */
    const order = await frozen('a5');
    expect((await move(order.id, 'in_production', { token: staff.token })).status).toBe(200);
    expect((await move(order.id, 'awaiting_installation', { token: staff.token })).status).toBe(200);
    expect((await move(order.id, 'delivered', { token: staff.token })).status).toBe(200);

    const before = (await eventRows(order.id)).length;
    const refused = await call('POST', `/orders/${order.id}/change-requests`, {
      token: customerA.token,
      body: { noteTh: 'หลังส่งมอบ' },
    });
    expect([409, 422]).toContain(refused.status);

    const after = await eventRows(order.id);
    expect(after).toHaveLength(before);
    expect(after.filter((e) => e.event_type === 'change_requested')).toHaveLength(0);

    const notifs = await notificationRows(order.id);
    const spine = new Set((await eventRows(order.id)).map((_, i) => i));
    expect(spine.size).toBeGreaterThan(0);
    /* No orphan: every notification names an event that is on this order's spine. */
    const [orphans] = await rows<{ n: string }>(sql`
      select count(*)::text as n from notifications n
       where n.order_id = ${order.id}
         and not exists (select 1 from order_events e where e.id = n.event_id)
    `);
    expect(orphans?.n).toBe('0');
    expect(notifs.length).toBeGreaterThan(0);
  });

  it('A5b every status event on a probe order has the outbox rows its rules demand', async () => {
    const order = await frozen('a5b');
    expect((await move(order.id, 'in_production', { token: staff.token })).status).toBe(200);

    const gaps = await rows<{ event_type: string; recipient_kind: string }>(sql`
      select e.event_type, r.recipient_kind
        from order_events e
        join notification_rules r on r.event_type = e.event_type and r.is_enabled
       where e.order_id = ${order.id}
         and not exists (
           select 1 from notifications n
            where n.event_id = e.id
              and n.recipient_kind = r.recipient_kind
              and n.channel = r.channel
         )
    `);
    expect(gaps, JSON.stringify(gaps)).toHaveLength(0);
  });

  it('A5c a notification cannot be written by hand', async () => {
    const order = await submitted('a5c');
    const [event] = await rows<{ id: string }>(
      sql`select id from order_events where order_id = ${order.id} limit 1`,
    );
    await expect(
      db.execute(sql`
        insert into notifications (order_id, event_id, latest_event_id, recipient_kind, recipient_key, channel, template_key, status)
        values (${order.id}, ${event?.id}, ${event?.id}, 'customer', 'email:attacker@evil.invalid', 'email', 'order.cancelled.customer', 'pending')
      `),
    ).rejects.toThrow();
  });

  /* ================================================================= *
   * ATTACK 6 — trap 1, the circular foreign key
   * ================================================================= */

  it('A6 an order inserted without its genesis event fails at COMMIT', async () => {
    await expect(
      db.execute(sql`insert into orders (id, status, status_event_id, guest_id)
        values (${randomUUID()}, 'draft', ${randomUUID()}, null)`),
    ).rejects.toThrow();
  });

  /* ================================================================= *
   * ATTACK 7 — authority
   * ================================================================= */

  it('A7 customer B cannot touch customer A order at all', async () => {
    const order = await submitted('a7');

    expect((await call('GET', `/orders/${order.id}`, { token: customerB.token })).status).toBe(404);
    expect((await call('GET', `/orders/${order.id}/events`, { token: customerB.token })).status).toBe(404);
    expect((await call('GET', `/orders/${order.id}/document`, { token: customerB.token })).status).toBe(404);
    expect(
      (await move(order.id, 'cancelled', { token: customerB.token }, { reason: 'ของคนอื่น' })).status,
    ).toBe(404);
    expect(
      (await call('POST', `/orders/${order.id}/change-requests`, { token: customerB.token, body: { noteTh: 'x' } }))
        .status,
    ).toBe(404);

    expect(await statusOf(order.id)).toBe('awaiting_payment');
  });

  it('A7b a read-only clerk cannot act on somebody else order', async () => {
    const order = await submitted('a7b');
    const answer = await move(order.id, 'production_confirmed', { token: staffReadOnly.token });
    /* reach for `act` needs orders.write, so the row is simply not there. */
    expect(answer.status, JSON.stringify(answer.body)).toBe(404);
  });

  /**
   * ⚠️ Inverted. `orders.write` alone used to act on every order in the company and read
   * none of them — and then hand the whole order back in the 200 body of the write. Both
   * halves of that were accidents of treating the two codes as independent axes; staff-wide
   * reach now needs `orders.read` for either intent. See `orderReach`.
   */
  it('A7c orders.write without orders.read reaches nothing at all', async () => {
    const order = await submitted('a7c');

    const acted = await move(order.id, 'production_confirmed', { token: staffWriteOnly.token });
    expect(acted.status, JSON.stringify(acted.body)).toBe(404);

    const read = await call('GET', `/orders/${order.id}`, { token: staffWriteOnly.token });
    expect(read.status).toBe(404);

    /* The order did not move. */
    expect(await statusOf(order.id)).toBe('awaiting_payment');
  });

  it('A7d a customer cannot make a staff-only move on their own order', async () => {
    const order = await frozen('a7d');
    const answer = await move(order.id, 'in_production', { token: customerA.token });
    expect(answer.status, JSON.stringify(answer.body)).toBe(403);
  });

  it('A7e a customer cannot accept or reject their own objection', async () => {
    const order = await submitted('a7e');
    const opened = await call('POST', `/orders/${order.id}/change-requests`, {
      token: customerA.token,
      body: { noteTh: 'ขอลดราคา' },
    });
    const crId = (opened.body as { id: string }).id;

    const accepted = await call('POST', `/orders/${order.id}/change-requests/${crId}/resolution`, {
      token: customerA.token,
      body: { resolution: 'accepted' },
    });
    expect(accepted.status).toBe(403);

    const withdrawn = await call('POST', `/orders/${order.id}/change-requests/${crId}/resolution`, {
      token: customerA.token,
      body: { resolution: 'withdrawn' },
    });
    expect(withdrawn.status).toBe(200);
  });

  /* ================================================================= *
   * ATTACK 8 — the anonymous funnel as an email cannon
   * ================================================================= */

  it('A8 an anonymous stranger makes the company email an address they do not own', async () => {
    const victim = `orders-rt5-victim-${tag}@probe.invalid`;

    const created = await call('POST', '/orders', { body: {} });
    expect(created.status).toBe(201);
    const cookie = (created.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    expect(cookie).not.toBe('');
    const orderId = (created.body as OrderWire).id;

    const done = await call('POST', `/orders/${orderId}/transitions/awaiting_payment`, {
      cookie,
      body: { contact: { email: victim, name: 'ไม่ใช่ฉัน' }, lines: [line] },
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);

    const rows = await notificationRows(orderId);
    const toVictim = rows.filter((r) => r.recipient_key === `email:${victim}`);
    expect(toVictim.length, JSON.stringify(rows)).toBeGreaterThan(0);
    expect(toVictim[0]?.status).toBe('pending');
  });

  it('A8b the funnel has no rate limit — ten carts from one stranger in one loop', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const created = await call('POST', '/orders', { body: {} });
      expect(created.status).toBe(201);
      ids.push((created.body as OrderWire).id);
    }
    expect(new Set(ids).size).toBe(10);

    const [guests] = await rows<{ n: string }>(
      sql`select count(*)::text as n from orders where id = any(${sql.raw(`'{${ids.join(',')}}'::uuid[]`)})`,
    );
    expect(guests?.n).toBe('10');
  });

  /* ================================================================= *
   * ATTACK 9 — what the customer is shown
   * ================================================================= */

  /** ⚠️ Inverted — see `encodeEvent`. The prose and the employee's uuid both reached the customer. */
  it('A9 staff prose and staff user ids do not reach the customer', async () => {
    const order = await frozen('a9');
    const secret = `ภายใน: ลูกค้ารายนี้จ่ายช้าเสมอ ${tag}`;
    expect((await move(order.id, 'redesign', { token: staff.token }, { reason: secret })).status).toBe(200);

    const seen = await call('GET', `/orders/${order.id}/events`, { token: customerA.token });
    expect(seen.status).toBe(200);
    const events = (seen.body as { events: readonly { eventType: string; actorUserId: string | null; writeTxid: string | null; payload: Record<string, unknown> }[] }).events;
    const bounce = events.find((e) => e.eventType === 'bounced_to_redesign');

    expect(bounce).toBeDefined();
    expect(JSON.stringify(seen.body)).not.toContain(secret);
    expect(JSON.stringify(seen.body)).not.toContain(staff.userId);
    expect(bounce?.payload['reason']).toBeUndefined();
    expect(bounce?.actorUserId).toBeNull();

    /*
     * ⚠️ And neither does `write_txid`, which is the third withheld field rather than a
     * decoration on the first two.
     *
     * A transaction id is not personal data and not a secret, but it is monotonic across the
     * **whole database**: two of them subtracted give the number of write transactions the
     * company committed in between. A customer holding the spines of two of their own orders
     * could read the company's throughput off them — WW-1045's own rows differ by ~53,000 across
     * six and a half hours. Staff hold `orders.read` over the whole table and can see that
     * traffic directly, so the same figure tells them nothing they could not already count.
     */
    for (const event of events) {
      expect(event.writeTxid, `${event.eventType} leaked its txid to the customer`).toBeNull();
    }

    /* Staff still see all three — an audit trail that cannot attribute its writes is not one. */
    const asStaff = await call('GET', `/orders/${order.id}/events`, { token: staff.token });
    expect(JSON.stringify(asStaff.body)).toContain(secret);

    const staffEvents = (asStaff.body as { events: readonly { seq: number; writeTxid: string | null }[] }).events;
    /*
     * Digits off `pg_current_xact_id()`, and **distinct per event** — which is the fact the
     * dashboard's `groupByTransaction` is written against. Every API path appends exactly one
     * event per order per transaction, so nothing on a single order's spine shares a txid today;
     * the one request that writes two (`supersede`) puts them on two different orders.
     */
    for (const event of staffEvents) {
      expect(event.writeTxid, `seq ${event.seq} has no txid`).toMatch(/^\d+$/);
    }
    expect(new Set(staffEvents.map((event) => event.writeTxid)).size).toBe(staffEvents.length);
  });

  /* ================================================================= *
   * ATTACK 10 — supersede
   * ================================================================= */

  it('A10 the successor exists, and the customer is never told about it', async () => {
    const order = await frozen('a10');
    expect((await move(order.id, 'redesign', { token: staff.token }, { reason: 'ทำไม่ได้' })).status).toBe(200);
    const superseded = await move(order.id, 'superseded', { token: staff.token }, { reason: 'ส่วนต่างสูง' });
    expect(superseded.status, JSON.stringify(superseded.body)).toBe(200);

    const successorId = (superseded.body as OrderWire).supersededByOrderId;
    expect(successorId).not.toBeNull();

    /* Nothing was queued about the successor itself — `created` is deliberately silent. */
    const successorNotifs = await notificationRows(successorId ?? '');
    expect(successorNotifs).toHaveLength(0);

    /* The message that WAS queued is on the predecessor, and reaches the customer. */
    const predecessor = await notificationRows(order.id);
    expect(predecessor.some((n) => n.recipient_kind === 'customer')).toBe(true);

    /*
     * …and it can now *name* the successor. The event payload carries `successor_order_id`,
     * which is the difference between "your order was replaced" and a message the customer
     * can act on — plan 7.2 requires them to approve the new quote.
     */
    const [event] = await rows<{ payload: { successor_order_id?: string } }>(sql`
      select payload from order_events
       where order_id = ${order.id} and event_type = 'superseded'
    `);
    expect(event?.payload.successor_order_id).toBe(successorId);
  });

  it('A10b a superseded order accepts nothing further', async () => {
    const order = await frozen('a10b');
    expect((await move(order.id, 'redesign', { token: staff.token }, { reason: 'x' })).status).toBe(200);
    expect((await move(order.id, 'superseded', { token: staff.token }, { reason: 'y' })).status).toBe(200);

    for (const to of ['redesign', 'cancelled', 'production_confirmed', 'superseded']) {
      const answer = await move(order.id, to, { token: staff.token }, { reason: 'z' });
      expect([409, 400], `${to} → ${answer.status}`).toContain(answer.status);
    }
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
