import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, createPool, type Database, type Pool } from '@wewin/db/client';
import { sql } from '@wewin/db/sql';
import { orderEvents } from '@wewin/db/schema';
import { toBigInt } from '@wewin/contract/exact';
import { balanceReminderWireSchema, type BalanceReminderWire, type OrderLineRequestWire, type OrderWire } from '@wewin/contract/order';
import { formatDateTime, formatMoney } from '@wewin/i18n/format';

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
import { confirmQuotation } from '../support/confirm-quotation';

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

  const nextDueOf = async (orderId: string): Promise<bigint> => {
    const answer = await db.execute<{ due: string }>(
      sql`select coalesce(order_next_due_thb_minor(${orderId}::uuid), 0)::text as due`,
    );
    return BigInt(answer.rows[0]?.due ?? '0');
  };

  const outboxRowFor = async (eventId: string) => {
    const answer = await db.execute<{
      id: string;
      status: string;
      suppressed_reason: string | null;
      recipient_key: string | null;
      attempt_count: number;
      attempts: string;
    }>(sql`
      select n.id::text as id, n.status, n.suppressed_reason, n.recipient_key, n.attempt_count,
             (select count(*) from notification_attempts a where a.notification_id = n.id)::text as attempts
        from notifications n
       where n.event_id = ${eventId}::uuid
    `);
    return answer.rows[0];
  };

  /**
   * Turn this order's pay-in-full schedule into a 30/70 — one deposit, one remainder.
   *
   * ⚠️ Written in SQL rather than through `ScheduleService.open`, which the submit has already
   * called: opening a second schedule is refused, and this is a fixture, not a test of the
   * scheduler. `order_instalments_dense_seq` is `DEFERRABLE INITIALLY DEFERRED`, so the two
   * statements are judged together on what they leave behind — dense seq, the remainder last,
   * and the two footing the grand total exactly.
   */
  const splitIntoDeposit = async (orderId: string, grandTotal: bigint): Promise<bigint> => {
    const deposit = (grandTotal * 3n) / 10n;

    await db.transaction(async (tx) => {
      await tx.execute(sql`
        update order_instalments
           set basis = 'percent', percent_bp = 3000,
               due_thb_minor = ${deposit.toString()}::bigint, updated_at = now()
         where order_id = ${orderId}::uuid and seq = 1
      `);
      await tx.execute(sql`
        insert into order_instalments (order_id, seq, basis, due_thb_minor)
        values (${orderId}::uuid, 2, 'remainder', ${(grandTotal - deposit).toString()}::bigint)
      `);
    });

    return deposit;
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
    const order = await submittedOrder(db, call, customer, line, contactFor('asks'));
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
    const order = await submittedOrder(db, call, customer, line, contactFor('moves'));
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

  /**
   * ─────────────────────────────────────────────────────────────────────────
   * ⭐ ⓵ THE ORDER WAS SETTLED BETWEEN THE ASK AND THE DRAIN.
   * ─────────────────────────────────────────────────────────────────────────
   *
   * The service refuses `outstanding <= 0` at the ask, argues at length that chasing somebody
   * who has already paid is the worst thing this feature can do, correctly re-reads the figure
   * at send time — and then applied no such test there. The message went out reading
   * *"ยอดคงค้างทั้งหมด / ฿0.00"*, and `-฿150.00` on an overpaid order.
   *
   * The window is not contrived and this test is the shape of it: five retries with backoff, a
   * worker that can be down, a queue that can be backlogged, and an approved write-off that
   * moves a balance to zero as readily as a slip does.
   */
  it('⭐ sends nothing at all when the balance was settled before the worker reached it', async () => {
    const order = await submittedOrder(db, call, customer, line, contactFor('settled-late'));
    await quiesce();

    const answer = await remind(clerk, order.id);
    expect(answer.status, JSON.stringify(answer.body)).toBe(201);
    const wire = answer.body as BalanceReminderWire;
    expect(wire.queued).toBe(1);

    /* The slip that lands after the button and before the drain. */
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

    const recorder = await drain();

    /*
     * ⛔ THE ASSERTION. No message, for this order, at all — not one quoting ฿0.00 and not one
     * quoting the figure that was true when the button was pressed.
     *
     * Mutation that turns this red: drop `if (outstanding <= 0n) return undefined;` from
     * `balanceReminder` **and** the `sendSuppression` call in the worker. Either alone leaves
     * the other holding it, which is the point of there being two.
     */
    expect(recorder.sent.filter((sent) => sent.orderId === order.id)).toHaveLength(0);

    const row = await outboxRowFor(wire.eventId);

    /*
     * ⭐ …and the row says so, as **suppressed** rather than dead. A dead row is the queue whose
     * log line is "Nobody has been told" and whose one button re-renders and re-refuses; a
     * customer who paid promptly is not a delivery failure and must not be filed as one.
     */
    expect(row?.status).toBe('suppressed');
    expect(row?.status).not.toBe('dead');
    expect(row?.suppressed_reason).toBe('balance_settled');
    /* `notifications_addressed_unless_suppressed` — a suppressed row carries no address. */
    expect(row?.recipient_key).toBeNull();
    /*
     * ⚠️ And no attempt was logged, because none was made. `notification_attempts` is what a
     * dispute reads, and a row there saying we tried would be a false line in the one log that
     * must not contain any.
     */
    expect(row?.attempts).toBe('0');
    expect(row?.attempt_count).toBe(0);

    /* The ask is still on the spine: we did ask, and the answer arrived first. */
    expect(await remindersOn(order.id)).toHaveLength(1);
  });

  /* ---------------------------------------------------------------- *
   * ⓶ The email and the screen it links to name the same numbers
   * ---------------------------------------------------------------- */

  it('⭐ names what is payable now AND the whole balance, in the order the payment screen does', async () => {
    /*
     * The defect, exactly as found: on a 30/70 order with nothing paid the email said
     * "ยอดคงค้างทั้งหมด ฿14,791.68" and the link under it opened a screen whose amount field was
     * prefilled with `order_next_due_thb_minor()` — a different, smaller number, with nothing on
     * either surface to say which was which.
     *
     * ⚠️ The convention is `@wewin/core/owed-figures`, which `MyQuotations` and `PaymentIsland`
     * already render: the actionable figure leads, the total supports it. This asserts the email
     * is the third surface following it rather than the fourth inventing one.
     */
    const order = await submittedOrder(db, call, customer, line, contactFor('deposit'));
    const grandTotal = toBigInt(order.grandTotalThbMinor ?? never('a submitted order has a grand total'));
    const deposit = await splitIntoDeposit(order.id, grandTotal);
    await quiesce();

    const owed = await outstandingOf(order.id);
    const due = await nextDueOf(order.id);

    /* The fixture is only interesting if the two folds genuinely disagree. */
    expect(due).toBe(deposit);
    expect(due).toBeLessThan(owed);

    expect((await remind(clerk, order.id)).status).toBe(201);

    const recorder = await drain();
    const body = recorder.sent.find((sent) => sent.orderId === order.id)?.body;
    expect(body, 'the reminder was not delivered').toBeDefined();

    const dueLine = formatMoney('th', due, 'THB', 'exact');
    const owedLine = formatMoney('th', owed, 'THB', 'exact');

    /*
     * ⛔ Both figures, and the payable one first. Asserting only the second passes against the
     * implementation that shipped; asserting only the first passes against its mirror, where a
     * customer concludes the order costs the deposit.
     *
     * Mutation that turns this red: drop `order_next_due_thb_minor(n.order_id)` from the claim
     * query, or collapse `describeOwedFigures(...)` in `balanceReminder` back to the outstanding
     * alone. The first makes the email name the total twice; the second makes it name it once.
     */
    const lines = (body ?? '').split('\n');
    expect(lines).toContain(dueLine);
    expect(lines).toContain(owedLine);
    expect(lines.indexOf(dueLine)).toBeLessThan(lines.indexOf(owedLine));

    /* Under the storefront's own two labels, so the page one click away reads the same. */
    expect(body).toContain(`ยอดที่ต้องชำระตอนนี้\n${dueLine}`);
    expect(body).toContain(`ยอดคงค้างทั้งหมด\n${owedLine}`);
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

    /* Confirmed: a reminder is about a balance the customer has been asked for. */
    await confirmQuotation(db, draft.id);
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
    const order = await submittedOrder(db, call, customer, line, contactFor('twice'));
    await quiesce();

    const first = await remind(clerk, order.id);
    expect(first.status).toBe(201);
    const asked = first.body as BalanceReminderWire;

    const again = await remind(clerk, order.id);
    expect(again.status, JSON.stringify(again.body)).toBe(409);
    /* A sentence, not a silence: the person who pressed has to learn what happened. */
    expect(JSON.stringify(again.body)).toContain('แจ้งซ้ำได้อีกครั้งหลัง');

    /*
     * ⚠️ And the spine did not grow. A refusal that still wrote the event would be a cooldown
     * on the *message* and not on the ask, which is a different and much less useful thing.
     */
    expect(await remindersOn(order.id)).toHaveLength(1);

    /*
     * ─────────────────────────────────────────────────────────────────────
     * ⭐ ⓷ AND IT NAMES A TIME THAI STAFF CAN ACT ON.
     * ─────────────────────────────────────────────────────────────────────
     *
     * ⚠️ **The assertion above is blind by construction and this is why the block exists.** It
     * checks the prefix — "แจ้งซ้ำได้อีกครั้งหลัง" — and never the value after it, so it passed
     * while the sentence read `2026-08-15 19:05:21.28587+00`: microseconds, a space instead of a
     * `T`, and **UTC** shown to staff who read Asia/Bangkok. Seven hours early, in a refusal
     * whose only content is when they may try again. Everything below fails if the VALUE moves,
     * not if the wording does.
     */
    const error = (again.body as { error: { message: string; details: Record<string, unknown> } }).error;
    const lastRemindedAt = String(error.details['lastRemindedAt']);
    const nextAllowedAt = String(error.details['nextAllowedAt']);

    /*
     * ⓵ **The wire is ISO**, like every other timestamp this API emits. `details.nextAllowedAt`
     * was the one field in any envelope a client could not hand to `new Date()` and trust.
     */
    expect(lastRemindedAt).toBe(new Date(lastRemindedAt).toISOString());
    expect(nextAllowedAt).toBe(new Date(nextAllowedAt).toISOString());

    /*
     * ⓶ **The instants are right.** `lastRemindedAt` is the spine row this ask just wrote — the
     * same field the 201 answered with — and the next one is exactly the cooldown after it.
     * Postgres computed both; nothing here recomputes either, it only checks they agree.
     */
    expect(lastRemindedAt).toBe(asked.remindedAt);
    expect(new Date(nextAllowedAt).getTime() - new Date(lastRemindedAt).getTime()).toBe(
      24 * 60 * 60 * 1000,
    );

    /*
     * ⓷ ⛔ **The sentence names that instant in Bangkok**, in Thai, drawn by the same formatter
     * every other date a member of staff reads goes through. This is the assertion that moves
     * when the value is wrong: a UTC rendering of the same instant is a different string, and so
     * is a rendering of a different instant.
     */
    expect(error.message).toContain(formatDateTime('th', new Date(nextAllowedAt)));

    /* …and Postgres's own spelling is nowhere in it. */
    expect(error.message).not.toContain('+00');
    expect(error.message).not.toMatch(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/u);
  });

  it('refuses when the order owes nothing', async () => {
    const order = await submittedOrder(db, call, customer, line, contactFor('settled'));
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
    const order = await submittedOrder(db, call, customer, line, contactFor('unauthorised'));

    /* The customer's own token: an order cannot ask itself for money. */
    const asCustomer = await remind(customer, order.id);
    expect(asCustomer.status).toBe(403);
    expect(await remindersOn(order.id)).toHaveLength(0);
  });

  /* ---------------------------------------------------------------- *
   * ⓸ The rules the transition table cannot hold, held by the guard
   * ---------------------------------------------------------------- */

  it('⭐ the database refuses a balance_reminded written by anybody but staff', async () => {
    const order = await submittedOrder(db, call, customer, line, contactFor('actor-guard'));

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
    const order = await submittedOrder(db, call, customer, line, contactFor('payload-guard'));

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
