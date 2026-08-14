import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, createPool, type Database, type Pool } from '@wewin/db/client';
import { sql } from '@wewin/db/sql';
import { orderEvents } from '@wewin/db/schema';
import { toBigInt } from '@wewin/contract/exact';
import { balanceReminderWireSchema, type BalanceReminderWire, type OrderLineRequestWire, type OrderWire } from '@wewin/contract/order';
import { formatMoney } from '@wewin/i18n/format';

import type {
  DeliveryResult,
  NotificationChannelAdapter,
  RenderedMessage,
} from '../../src/notifications/channels/channel';
import { NotificationWorker } from '../../src/notifications/notification-worker.service';
import { parseNotificationsConfig } from '../../src/notifications/notifications.config';
import { NotificationsRepository } from '../../src/notifications/notifications.repository';
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
  type PaymentsApp,
} from '../payments/support/payments-app';
import { giveOrderHeldMoney } from '../payments/support/money-fixture';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ แจ้งเตือนยอดค้างชำระ — asking the customer for the balance, end to end.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Five rounds made the balance payable, visible, recordable and forgivable, and nothing asked
 * the customer for it. This file is the proof that something does, and it is written against
 * the four things that could be wrong in ways nobody would notice:
 *
 *   ⓵ **The spine row.** The message exists only because an `order_events` row does (plan
 *     10.1). Nothing in this file calls a "send" function, because there is none to call —
 *     the POST appends an event and the fan-out trigger queues the message in the same
 *     transaction. Asserted by looking at `notifications` after an HTTP call that mentions
 *     no notification.
 *
 *   ⓶ **The amount in the email is read at *send* time.** The most seductive wrong
 *     implementation is to put the figure from the ask into the message. It passes every
 *     obvious test, because in the obvious test nothing happens in between. So the test below
 *     accepts a payment *after* the button is pressed and before the worker runs, and asserts
 *     the email carries the **new** balance and not the old one. Chasing a customer for money
 *     they have already paid is the worst thing this feature can do.
 *
 *   ⓷ **The refusals.** Nothing owed, not a live obligation, and too soon after the last one.
 *     Each is a 409 with a sentence, because a button that silently does nothing is a button
 *     somebody presses five times.
 *
 *   ⓸ **The database's own guard.** `order_status_transitions` cannot carry the actor rule or
 *     the payload rule for an event with a null status pair, so `order_events_guard_insert()`
 *     does — and it is tested by writing the row directly, which is the only way to prove the
 *     service is not the only thing enforcing them.
 *
 * Skipped, not failed, without a database.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

const tag = randomUUID().slice(0, 8);
/** A money field the wire promised and did not send is a broken fixture, not a zero. */
const never = (what: string): never => {
  throw new Error(what);
};

const contactFor = (who: string): { email: string; name: string } => ({
  email: `balance-reminder-${who}-${tag}@probe.invalid`,
  name: `สมชาย ${tag}`,
});

/** An adapter that accepts everything and keeps what it was handed. */
class Recorder implements NotificationChannelAdapter {
  readonly channel = 'email' as const;
  readonly sent: RenderedMessage[] = [];

  supports(recipientKey: string): boolean {
    return recipientKey.startsWith('email:');
  }

  async send(message: RenderedMessage): Promise<DeliveryResult> {
    this.sent.push(message);
    return { ok: true, providerMessageId: `recorded-${this.sent.length}` };
  }
}

describeWithPg('⭐ POST /orders/:orderId/balance-reminders', () => {
  let pool: Pool;
  let db: Database;
  let app: PaymentsApp;
  let call: ReturnType<typeof client>;

  let customer: Actor;
  let clerk: Actor;
  let line: OrderLineRequestWire;

  const session = testSessionConfig();

  /**
   * Park everything already queued, so a worker run in this file delivers this file's message.
   *
   * The worker claims from *the* queue and not from a queue per order — that is the design, and
   * `outbox.pg.test.ts` records the fourteen-failures-then-two run that found it out. Submitting
   * an order queues two messages of its own, and they are not what any assertion here is about.
   */
  const quiesce = async (): Promise<void> => {
    await db.execute(sql`
      update notifications
         set send_after = now() + interval '1 day', updated_at = now()
       where status in ('pending', 'sending')
    `);
  };

  /** One worker run with an adapter that records, and nothing else in the queue. */
  const drain = async (): Promise<Recorder> => {
    const recorder = new Recorder();
    const worker = new NotificationWorker(
      parseNotificationsConfig({ NODE_ENV: 'test' }),
      [recorder],
      new NotificationsRepository(db),
      new DocumentLinkService(session),
    );

    await worker.runOnce();
    return recorder;
  };

  const remind = async (who: Actor, orderId: string) =>
    call('POST', `/orders/${orderId}/balance-reminders`, { token: who.token });

  const outstandingOf = async (orderId: string): Promise<bigint> => {
    const answer = await db.execute<{ owed: string }>(
      sql`select coalesce(order_outstanding_thb_minor(${orderId}::uuid), 0)::text as owed`,
    );
    return BigInt(answer.rows[0]?.owed ?? '0');
  };

  const remindersOn = async (orderId: string) => {
    const answer = await db.execute<{ seq: number; from_status: string | null; to_status: string | null; payload: Record<string, unknown> }>(
      sql`select seq, from_status, to_status, payload
            from order_events
           where order_id = ${orderId}::uuid and event_type = 'balance_reminded'
           order by seq`,
    );
    return answer.rows;
  };

  beforeAll(async () => {
    pool = createPool(url ?? '');
    db = createDatabase(pool);

    app = await bootPaymentsApp(paymentsEnv(url ?? ''), session);
    call = client(app.baseUrl);

    customer = await makeActor(db, app, `balance reminder customer ${tag}`, []);
    /*
     * ⚠️ Exactly the three codes the route declares, and no fourth. `orders.read` is in the
     * list because `order-reach.ts` widens a staff caller to every order only when they hold
     * read *and* write — an actor without it is not forbidden, they are 404, which is a
     * different and much more confusing failure.
     */
    clerk = await makeActor(db, app, `balance reminder clerk ${tag}`, [
      'orders.read',
      'orders.write',
      'payments.read',
    ]);
    line = await liveLine(call);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  /* ---------------------------------------------------------------- *
   * ⓵ The ask is a spine row, and the spine row is what sends
   * ---------------------------------------------------------------- */

  it('writes one event with no status pair, and queues one message, from one HTTP call', async () => {
    const order = await submittedOrder(call, customer, line, contactFor('asks'));
    await quiesce();

    const owed = await outstandingOf(order.id);
    expect(owed).toBeGreaterThan(0n);

    const answer = await remind(clerk, order.id);
    expect(answer.status, JSON.stringify(answer.body)).toBe(201);

    /* The response is the contract's shape, checked by the contract's own schema. */
    const wire = balanceReminderWireSchema.parse(answer.body) as BalanceReminderWire;
    expect(toBigInt(wire.outstandingThbMinor)).toBe(owed);
    expect(wire.queued).toBe(1);
    expect(wire.suppressedReason).toBeNull();

    /*
     * ⭐ The event: a null pair, staff, and the figure that was owed at the moment of the ask.
     * The null pair is the whole reason 0050 had to touch `order_events_guard_insert()`.
     */
    const events = await remindersOn(order.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.from_status).toBeNull();
    expect(events[0]?.to_status).toBeNull();
    expect(events[0]?.payload['outstanding_thb_minor']).toBe(owed.toString());
    expect(events[0]?.seq).toBe(wire.seq);

    /*
     * ⓵. Nothing in this test asked for a notification: the call was a POST that appends an
     * event. The row exists because the fan-out trigger ran inside that transaction.
     *
     * ⚠️ Mutation that turns this red: delete the `notification_rules` row in 0050. The event
     * is still written and the customer is told nothing — which is the exact silence
     * `event-coverage.ts` exists to make impossible, and this is the other half of it.
     */
    const queued = await db.execute<{ template_key: string; status: string }>(sql`
      select template_key, status from notifications where event_id = ${wire.eventId}::uuid
    `);
    expect(queued.rows.map((row) => row.template_key)).toStrictEqual(['order.balance_reminded.customer']);
    expect(queued.rows[0]?.status).toBe('pending');
  });

  /* ---------------------------------------------------------------- *
   * ⓶ The amount in the message is Postgres's, at send time
   * ---------------------------------------------------------------- */

  it('⭐ names the balance as it stands when the message is SENT, not as it stood when asked', async () => {
    const order = await submittedOrder(call, customer, line, contactFor('moves'));
    await quiesce();

    const atAsk = await outstandingOf(order.id);
    const answer = await remind(clerk, order.id);
    expect(answer.status, JSON.stringify(answer.body)).toBe(201);
    expect(toBigInt((answer.body as BalanceReminderWire).outstandingThbMinor)).toBe(atAsk);

    /*
     * ⭐ The payment that lands between the ask and the delivery. This is not a contrived
     * scenario: the outbox has a coalescing window, a five-second poll and five retries with
     * backoff, so a message can leave hours after the button was pressed — and a customer who
     * paid in between must not be chased for the old figure.
     */
    const paid = atAsk / 3n;
    await giveOrderHeldMoney(db, {
      orderId: order.id,
      grandTotalThbMinor: toBigInt(order.grandTotalThbMinor ?? never('a submitted order has a grand total')),
      paidThbMinor: paid,
      payerName: `payer ${tag}`,
      payerAccountLast4: '4821',
      reviewerUserId: clerk.userId,
    });

    const atSend = await outstandingOf(order.id);
    expect(atSend).toBeLessThan(atAsk);

    const recorder = await drain();
    const message = recorder.sent.find((sent) => sent.orderId === order.id);
    expect(message, 'the reminder was not delivered').toBeDefined();

    /*
     * ⚠️ The two assertions have to be made together. Asserting only the first passes against
     * an implementation that puts both numbers in the message; asserting only the second passes
     * against one that puts no number in it at all.
     *
     * Mutation that turns this red: in `notifications.repository.ts`, drop
     * `order_outstanding_thb_minor(n.order_id)` from the claim and carry the payload's figure
     * instead — the email then quotes ฿X when the customer owes ฿X minus what they just paid.
     */
    expect(message?.body).toContain(formatMoney('th', atSend, 'THB', 'exact'));
    expect(message?.body).not.toContain(formatMoney('th', atAsk, 'THB', 'exact'));

    /* And the spine still records what was owed *when we asked* — two facts, two homes. */
    const events = await remindersOn(order.id);
    expect(events[0]?.payload['outstanding_thb_minor']).toBe(atAsk.toString());
  });

  it('tells the person who pressed it that there was nobody to write to', async () => {
    /*
     * ⭐ A phone-only customer. `orders_submitted_has_a_contact_channel` permits it, the
     * fan-out writes a **suppressed** row with `no_contact_channel`, and that is the correct
     * outcome — but it is indistinguishable from a queued one on every screen in this
     * application unless the response says so. Somebody believing a chase is on its way to a
     * customer who never gave an address is a week of silence nobody explains.
     */
    const created = await call('POST', '/orders', { token: customer.token, body: {} });
    const draft = created.body as OrderWire;
    const submitted = await call('POST', `/orders/${draft.id}/transitions/awaiting_payment`, {
      token: customer.token,
      body: { contact: { phone: '+66812345678', name: `สมชาย ${tag}` }, lines: [line] },
    });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    const order = submitted.body as OrderWire;
    await quiesce();

    const answer = await remind(clerk, order.id);
    expect(answer.status, JSON.stringify(answer.body)).toBe(201);

    const wire = answer.body as BalanceReminderWire;
    expect(wire.queued).toBe(0);
    expect(wire.suppressedReason).toBe('no_contact_channel');

    /* The ask still happened, and is still on the spine. Recorded is not the same as sent. */
    expect(await remindersOn(order.id)).toHaveLength(1);
  });

  /* ---------------------------------------------------------------- *
   * ⓷ The refusals
   * ---------------------------------------------------------------- */

  it('refuses a second reminder inside the cooldown, and says when the next one may go', async () => {
    const order = await submittedOrder(call, customer, line, contactFor('twice'));
    await quiesce();

    expect((await remind(clerk, order.id)).status).toBe(201);

    const again = await remind(clerk, order.id);
    expect(again.status, JSON.stringify(again.body)).toBe(409);
    /* A sentence, not a silence: the person who pressed has to learn what happened. */
    expect(JSON.stringify(again.body)).toContain('แจ้งซ้ำได้อีกครั้งหลัง');

    /*
     * ⚠️ And the spine did not grow. A refusal that still wrote the event would be a cooldown
     * on the *message* and not on the ask, which is a different and much less useful thing.
     */
    expect(await remindersOn(order.id)).toHaveLength(1);
  });

  it('refuses when the order owes nothing', async () => {
    const order = await submittedOrder(call, customer, line, contactFor('settled'));
    const grandTotal = toBigInt(order.grandTotalThbMinor ?? never('a submitted order has a grand total'));

    await giveOrderHeldMoney(db, {
      orderId: order.id,
      grandTotalThbMinor: grandTotal,
      paidThbMinor: grandTotal,
      payerName: `payer ${tag}`,
      payerAccountLast4: '4821',
      reviewerUserId: clerk.userId,
    });
    expect(await outstandingOf(order.id)).toBe(0n);

    const answer = await remind(clerk, order.id);
    expect(answer.status, JSON.stringify(answer.body)).toBe(409);
    expect(await remindersOn(order.id)).toHaveLength(0);
  });

  it('refuses on a cart, which has agreed to owe nothing', async () => {
    /*
     * `draft` is one of the three statuses `isLiveOrder` refuses, and the reason it is refused
     * here rather than allowed to fall through to the ฿0.00 check is that the sentences differ:
     * a cart has no contract, where a settled order has one and has paid it.
     */
    const created = await call('POST', '/orders', { token: customer.token, body: {} });
    const draft = created.body as OrderWire;

    const answer = await remind(clerk, draft.id);
    expect(answer.status, JSON.stringify(answer.body)).toBe(409);
    expect(await remindersOn(draft.id)).toHaveLength(0);
  });

  it('refuses a caller who does not hold both codes', async () => {
    const order = await submittedOrder(call, customer, line, contactFor('unauthorised'));

    /* The customer's own token: an order cannot ask itself for money. */
    const asCustomer = await remind(customer, order.id);
    expect(asCustomer.status).toBe(403);
    expect(await remindersOn(order.id)).toHaveLength(0);
  });

  /* ---------------------------------------------------------------- *
   * ⓸ The rules the transition table cannot hold, held by the guard
   * ---------------------------------------------------------------- */

  it('⭐ the database refuses a balance_reminded written by anybody but staff', async () => {
    const order = await submittedOrder(call, customer, line, contactFor('actor-guard'));

    /*
     * Written directly, past every line of TypeScript in this application — which is the only
     * way to prove the rule is the database's. `system` is the actor kind a scheduler would
     * arrive as, so this assertion is also what stops the cron this round deliberately did not
     * build from being added later by a caller instead of by a decision.
     */
    await expect(
      db.insert(orderEvents).values({
        orderId: order.id,
        eventType: 'balance_reminded',
        fromStatus: null,
        toStatus: null,
        actorKind: 'system',
        actorUserId: null,
        actorGuestId: null,
        payload: { outstanding_thb_minor: '100' },
      }),
    ).rejects.toThrow();

    expect(await remindersOn(order.id)).toHaveLength(0);
  });

  it('⭐ the database refuses a balance_reminded with no amount in its payload', async () => {
    const order = await submittedOrder(call, customer, line, contactFor('payload-guard'));

    /*
     * `required_payload_keys` is a column on `order_status_transitions`, and this event has no
     * transition row to carry one — so the guard carries it. Without this rule a reminder could
     * be recorded with nothing in it, and next year's reader could not reconstruct what was
     * owed at the time, because the balance moves.
     */
    await expect(
      db.insert(orderEvents).values({
        orderId: order.id,
        eventType: 'balance_reminded',
        fromStatus: null,
        toStatus: null,
        actorKind: 'staff',
        actorUserId: clerk.userId,
        actorGuestId: null,
        payload: {},
      }),
    ).rejects.toThrow();

    expect(await remindersOn(order.id)).toHaveLength(0);
  });
});
