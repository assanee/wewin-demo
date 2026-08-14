import { randomUUID } from 'node:crypto';

import { createDatabase, createPool, type Database, type Pool } from '@wewin/db/client';
import { guests, orderEvents, orders, users } from '@wewin/db/schema';
import { eq, sql } from '@wewin/db/sql';
import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  DeliveryResult,
  NotificationChannelAdapter,
  RenderedMessage,
} from '../../src/notifications/channels/channel';
import { NotificationWorker } from '../../src/notifications/notification-worker.service';
import { parseNotificationsConfig, type NotificationsConfig } from '../../src/notifications/notifications.config';
import { DocumentLinkService } from '../../src/orders/document-link';
import { testSessionConfig } from '../support/app';
import { NotificationsRepository } from '../../src/notifications/notifications.repository';
import { NotificationsService } from '../../src/notifications/notifications.service';

/**
 * The outbox, end to end, against a real Postgres — plan 10.
 *
 * ── The two claims this file exists to prove ─────────────────────────────────
 *
 * ⓐ **A committed state change with nobody told is impossible.** Appending to the spine
 *   queues the messages, in the same transaction, by trigger; nothing here calls a "queue
 *   this" function, because there is no such function to call and no way for a service to
 *   forget one.
 *
 * ⓑ **A delivery failure cannot roll back a state change.** The worker runs long after the
 *   transition committed. SMTP being down produces a failed attempt and a retry; it cannot
 *   produce an order in a status the customer was not shown.
 *
 * Both are asserted by making the delivery fail on purpose and then looking at the order.
 *
 * ── How to make each of these fail, which is the point of writing them ───────
 *
 * Each block names the mutation that turns it red. They were chosen so that removing the
 * mechanism — not merely changing a number — is what breaks the assertion.
 *
 * ── Fixtures ────────────────────────────────────────────────────────────────
 *
 * Every test builds its own order and asserts only on that order's notifications, so this
 * file is independent of what else is in the database (`apps/api/vitest.config.ts` explains
 * why that matters here), and `quiesce()` below parks anything already queued so one test's
 * leftovers cannot be delivered by the next one's adapter. Teardown is best-effort and the
 * reason it cannot be complete is written down beside it — it is a finding, not a shortcut.
 *
 * Skipped, not failed, without a database.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

const CONTACT = 'somchai@example.test';

let pool: Pool;
let db: Database;
let repository: NotificationsRepository;
let staffUserId: string;
/** Reset per test, so a test's own assertions are about its own order. */
const createdOrders: string[] = [];
/** Never reset: the teardown has to close every message this file created, not the last one's. */
const allOrders: string[] = [];

/** An adapter whose next answer is whatever the test says it is. */
class ScriptedAdapter implements NotificationChannelAdapter {
  readonly channel = 'email' as const;
  readonly sent: RenderedMessage[] = [];
  outcome: DeliveryResult | 'throw' = { ok: true, providerMessageId: 'scripted-1' };

  supports(recipientKey: string): boolean {
    return recipientKey.startsWith('email:') || recipientKey.startsWith('group:');
  }

  async send(message: RenderedMessage): Promise<DeliveryResult> {
    this.sent.push(message);
    if (this.outcome === 'throw') throw new Error('adapter exploded');
    return this.outcome;
  }
}

const config = (overrides: Partial<NotificationsConfig> = {}): NotificationsConfig => ({
  ...parseNotificationsConfig({ NODE_ENV: 'test' }),
  ...overrides,
});

/**
 * A draft order, created the only way trap 1 permits: order first with the event id chosen
 * up front, event second, both in one transaction. Copied in shape from
 * `packages/db/tests/order.test.ts` on purpose — a fixture that built orders a different
 * way would be testing a different system.
 */
async function createDraft(options: { contactEmail?: string | null; contactName?: string } = {}): Promise<string> {
  const orderId = randomUUID();
  const eventId = randomUUID();

  const [guest] = await db.insert(guests).values({}).returning({ id: guests.id });
  if (!guest) throw new Error('could not create a guest');

  await db.transaction(async (tx) => {
    await tx.insert(orders).values({
      id: orderId,
      statusEventId: eventId,
      guestId: guest.id,
      contactEmail: options.contactEmail === undefined ? CONTACT : options.contactEmail,
      contactName: options.contactName ?? 'สมชาย',
    });
    await tx.insert(orderEvents).values({
      id: eventId,
      orderId,
      eventType: 'created',
      toStatus: 'draft',
      actorKind: 'guest',
      actorGuestId: guest.id,
    });
  });

  createdOrders.push(orderId);
  allOrders.push(orderId);
  return orderId;
}

/**
 * One non-status event on the spine.
 *
 * `quote_revised`, `change_requested` and `change_resolved` are the three event types the
 * schema allows with no `to_status` — they are on the spine precisely because plan 10.3 has
 * to notify about them. That makes them the right fixture here: they exercise the fan-out
 * without dragging a whole status chain (and its pinned document, and its money) into a
 * test about notifications.
 */
async function appendEvent(
  orderId: string,
  eventType: 'quote_revised' | 'change_requested' | 'change_resolved',
): Promise<string> {
  const eventId = randomUUID();

  await db.transaction(async (tx) => {
    await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId)).for('update');
    await tx.insert(orderEvents).values({
      id: eventId,
      orderId,
      eventType,
      actorKind: 'staff',
      actorUserId: staffUserId,
    });
  });

  return eventId;
}

interface NotificationRow {
  readonly id: string;
  readonly status: string;
  readonly recipient_key: string | null;
  readonly template_key: string;
  readonly attempt_count: number;
  readonly coalesced_count: number;
  readonly last_error: string | null;
  readonly suppressed_reason: string | null;
  readonly dead_at: Date | null;
  readonly sent_at: Date | null;
}

async function notificationsFor(orderId: string): Promise<readonly NotificationRow[]> {
  const result = await db.execute(sql`
    select id, status, recipient_key, template_key, attempt_count, coalesced_count,
           last_error, suppressed_reason, dead_at, sent_at
      from notifications
     where order_id = ${orderId}
     order by created_at, template_key
  `);
  return (result as unknown as { rows: NotificationRow[] }).rows;
}

async function attemptCountFor(orderId: string): Promise<number> {
  const result = await db.execute(sql`
    select count(*)::int as total
      from notification_attempts a
      join notifications n on n.id = a.notification_id
     where n.order_id = ${orderId}
  `);
  return (result as unknown as { rows: { total: number }[] }).rows[0]?.total ?? 0;
}

/** Pull a pending message's window into the past, so a coalesced row becomes claimable. */
async function makeDue(orderId: string): Promise<void> {
  await db.execute(sql`
    update notifications set send_after = now() - interval '1 second'
     where order_id = ${orderId} and status = 'pending'
  `);
}

/**
 * Park everything that already exists, so a test about one message is about one message.
 *
 * The worker claims from *the* queue, not from a queue per order — that is the design, and
 * it is why `claimDue` has a batch size rather than an order id. It also means a test whose
 * predecessor left a pending row will deliver that row too, through its own scripted
 * adapter, and assertions about "what was sent" start counting somebody else's message. The
 * first run of this file found exactly that: fourteen failures that became two on a second
 * run, because the leftovers had been consumed.
 *
 * Pushing `send_after` into tomorrow (and refreshing `updated_at`, which is what the lease
 * reads) makes every pre-existing row invisible to the claim without deleting anything —
 * and deleting is not available here anyway, see the teardown note.
 */
async function quiesce(): Promise<void> {
  await db.execute(sql`
    update notifications
       set send_after = now() + interval '1 day', updated_at = now()
     where status in ('pending', 'sending')
  `);
}

/**
 * Everything a Postgres error actually said.
 *
 * Drizzle wraps a driver error in one whose message is the SQL it tried to run, so
 * `String(error)` is the statement and not the refusal. `src/admin/pg-errors.ts` walks the
 * cause chain for the same reason — this is that walk, in a test, kept local because the
 * production one turns errors into HTTP responses rather than strings.
 */
function describeError(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;

  for (let depth = 0; current instanceof Error && depth < 5; depth += 1) {
    parts.push(current.message);
    current = (current as { readonly cause?: unknown }).cause;
  }

  return parts.join(' | ');
}

/** One config for the whole file, so a token minted here verifies against a link built here. */
const session = testSessionConfig();
const links = new DocumentLinkService(session);

const workerWith = (adapter: NotificationChannelAdapter, overrides: Partial<NotificationsConfig> = {}) =>
  new NotificationWorker(config(overrides), [adapter], repository, links);

describeWithPg('the outbox against Postgres', () => {
  beforeAll(async () => {
    pool = createPool(url ?? '');
    db = createDatabase(pool);
    repository = new NotificationsRepository(db);

    const [staff] = await db
      .insert(users)
      .values({ displayName: 'notification outbox probe' })
      .returning({ id: users.id });
    if (!staff) throw new Error('could not create the staff fixture');
    staffUserId = staff.id;
  });

  /**
   * Best-effort, and the part that fails is a finding rather than a flaky teardown.
   *
   * `orders_block_delete()` permits deleting a never-submitted draft, and `notifications`
   * cascades from the order — but `notification_attempts` cascades from *that*, and
   * `notification_attempts_append_only()` refuses a DELETE unconditionally. So an order
   * becomes undeletable the moment one delivery has been attempted against it, draft or not.
   *
   * That is a real collision between two rules that were each written for a good reason
   * (evidence is append-only; a draft cart must be erasable), and it is reported upward
   * rather than worked around here — a test that disabled a trigger to tidy up would be a
   * test that removes the guard it is meant to be running under. Orders that cannot be
   * deleted are left behind, as `packages/db/tests/order.test.ts` also does and says.
   */
  afterAll(async () => {
    /*
     * Close every message this file deliberately failed.
     *
     * The dead queue is a real operational surface in the development database, and it is
     * the one surface whose whole value is that somebody looks at it (plan 10.5(3)). A test
     * suite that leaves eighty fake failures in it every run is a test suite that teaches
     * everybody to stop looking — which is the failure this module exists to prevent,
     * arriving by way of its own tests.
     *
     * An UPDATE and not a DELETE, because `notification_attempts` cannot be deleted (see
     * below) and the attempt log is the honest record of what these tests did. `suppressed`
     * rows are left alone: they are terminal by design and cost nobody a second look.
     */
    if (allOrders.length > 0) {
      await db.execute(sql`
        update notifications
           set status = 'sent', sent_at = coalesce(sent_at, now()), dead_at = null
         where order_id = any(${sql.param(allOrders)}::uuid[])
           and status in ('pending', 'sending', 'dead')
      `);
    }

    /*
     * Best-effort, and the part that fails is a finding rather than a flaky teardown.
     *
     * `orders_block_delete()` permits deleting a never-submitted draft, and `notifications`
     * cascades from the order — but `notification_attempts` cascades from *that*, and
     * `notification_attempts_append_only()` refuses a DELETE unconditionally. So an order
     * becomes undeletable the moment one delivery has been attempted against it, draft or
     * not.
     *
     * That is a real collision between two rules that were each written for a good reason
     * (evidence is append-only; a draft cart must be erasable, so PDPA erasure can clear the
     * funnel). It is reported upward rather than worked around here — a test that disabled a
     * trigger to tidy up would be a test that removes the guard it is running under.
     */
    for (const orderId of allOrders) {
      await db.delete(orders).where(eq(orders.id, orderId)).catch(() => undefined);
    }
    await db.delete(users).where(eq(users.id, staffUserId)).catch(() => undefined);
    await pool.end();
  });

  beforeEach(async () => {
    createdOrders.length = 0;
    await quiesce();
  });

  describe('ⓐ a state change nobody was told about is impossible', () => {
    it('queues the message as part of the transaction that appended the event', async () => {
      const orderId = await createDraft();
      await appendEvent(orderId, 'change_resolved');

      const rows = await notificationsFor(orderId);

      /*
       * Nothing in this test asked for a notification. The only call was an INSERT into
       * `order_events`, and the row below exists because of a trigger on that table.
       *
       * MUTATION: `DROP TRIGGER order_events_fan_out_notifications ON order_events` — this
       * assertion is the first thing that goes red, and it goes red for every event type.
       */
      expect(rows).toHaveLength(1);
      expect(rows[0]?.template_key).toBe('order.change_resolved.customer');
      expect(rows[0]?.recipient_key).toBe(`email:${CONTACT}`);
      expect(rows[0]?.status).toBe('pending');
    });

    it('refuses an outbox row written by hand', async () => {
      const orderId = await createDraft();
      const eventId = await appendEvent(orderId, 'change_resolved');

      const failure = await db
        .execute(
          sql`insert into notifications (order_id, event_id, latest_event_id, recipient_kind, recipient_key, channel, template_key)
              values (${orderId}, ${eventId}, ${eventId}, 'customer', 'email:attacker@example.test', 'email', 'order.delivered.customer')`,
        )
        .then(() => undefined, (error: unknown) => error);

      /*
       * This is what makes plan 10.1's sentence a rule rather than a convention. Without it,
       * a service could still queue a message an hour later against an event that committed
       * long ago — which is `sendEmail()` in a transition handler wearing a table.
       *
       * MUTATION: `DROP TRIGGER notifications_guard_insert ON notifications` → the insert
       * succeeds and this goes red.
       */
      expect(describeError(failure)).toMatch(/another transaction|not written by hand/);
    });

    it('writes a visible suppressed row when there is nowhere to send', async () => {
      const orderId = await createDraft({ contactEmail: null });
      await appendEvent(orderId, 'change_resolved');

      const rows = await notificationsFor(orderId);

      /*
       * Plan 10.5(3) in its quietest form. A quote with no contact channel produces a row
       * that says so, in a terminal state, with a reason — not an absence. An absence is
       * indistinguishable from "we told them", which is the failure the whole section is
       * about.
       */
      expect(rows[0]?.status).toBe('suppressed');
      expect(rows[0]?.suppressed_reason).toBe('no_contact_channel');
      expect(rows[0]?.recipient_key).toBeNull();

      // And it is never claimed: retrying an unaddressable message would fail identically
      // forever, and burning attempts on it would hide the addressable failures beside it.
      const adapter = new ScriptedAdapter();
      await workerWith(adapter).runOnce();
      expect(adapter.sent.filter((message) => message.orderId === orderId)).toHaveLength(0);
      expect(await attemptCountFor(orderId)).toBe(0);
    });

    it('⭐ says whether it actually closed the row, so the worker cannot log a suppression that never happened', async () => {
      /*
       * `suppress()` updates `where … and status = 'sending'`, so it can only close a row *this*
       * worker holds the claim on — a row another process took back under the lease is left alone.
       * The boolean is how the caller learns which happened, and the worker was discarding it and
       * logging "was not sent: <reason>" either way.
       *
       * That log line matters more than a log line usually does: this branch deliberately writes
       * no `notification_attempts` row (nothing was attempted), so the line is the *only* trace it
       * leaves anywhere. A false one is the entire record of the event being wrong.
       */
      const orderId = await createDraft();
      await appendEvent(orderId, 'change_resolved');

      const queued = (await notificationsFor(orderId))[0];
      if (queued === undefined) throw new Error('the fan-out queued nothing to claim');
      expect(queued.status).toBe('pending');
      const notificationId = queued.id;

      /* Claim it the way the worker's own claim statement would. */
      await db.execute(sql`update notifications set status = 'sending' where id = ${notificationId}`);

      /*
       * MUTATION: drop `and status = 'sending'` from `suppress()` in
       * `notifications.repository.ts` → the second call updates a `suppressed` row and answers
       * `true`, and the second assertion goes red.
       */
      expect(await repository.suppress(notificationId, 'balance_settled')).toBe(true);
      expect(await repository.suppress(notificationId, 'balance_settled')).toBe(false);

      /* And the first call is the one that did the work — the row is closed exactly once. */
      const after = (await notificationsFor(orderId))[0];
      expect(after?.status).toBe('suppressed');
      expect(after?.suppressed_reason).toBe('balance_settled');
      expect(after?.recipient_key).toBeNull();
    });
  });

  describe('⭐ the message about a quotation contains the quotation', () => {
    /*
     * Until this round every customer message described something that had happened to a
     * document the customer had no way to open. `order.quote_revised.customer` was the worst
     * of them: it told somebody their agreed price had been changed and that they had a right
     * to object, and then admitted in brackets that the screen for doing so did not exist.
     *
     * ⚠️ The link is asserted **end to end**, not as a substring. A body containing
     * `https://…?t=…` proves the template interpolated something; extracting that token and
     * verifying it names *this* order is what proves a customer clicking it lands on their own
     * quotation rather than a 404 or, worse, somebody else's.
     */
    const WEB = 'https://shop.wewin.test';

    it('⭐ carries a link whose token resolves to this order', async () => {
      const orderId = await createDraft();
      await appendEvent(orderId, 'quote_revised');
      await makeDue(orderId);

      const adapter = new ScriptedAdapter();
      await workerWith(adapter, { webBaseUrl: WEB }).runOnce();

      const message = adapter.sent.find((sent) => sent.orderId === orderId);
      expect(message, 'no message was sent for this order').toBeDefined();

      const found = /https:\/\/\S+/u.exec(message?.body ?? '');
      expect(found, `no link in the body:\n${message?.body ?? ''}`).not.toBeNull();

      const url = new URL(found?.[0] ?? '');
      expect(url.origin).toBe(WEB);
      /* The locale the message was rendered in, so the page opens in the same language. */
      expect(url.pathname).toBe(`/${message?.locale ?? ''}/orders`);

      const token = url.searchParams.get('t') ?? '';
      expect(links.verify(token)).toStrictEqual({ ok: true, orderId });
    });

    it('⚠️ sends the message anyway when the storefront is not configured', async () => {
      /*
       * `NOTIFICATIONS_WEB_BASE_URL` unset is a deployment mistake and must not become a
       * customer who is never told their quotation changed. It degrades to a message with no
       * link — and, in particular, not to a sentence with `undefined` in it.
       */
      const orderId = await createDraft();
      await appendEvent(orderId, 'quote_revised');
      await makeDue(orderId);

      const adapter = new ScriptedAdapter();
      await workerWith(adapter).runOnce();

      const message = adapter.sent.find((sent) => sent.orderId === orderId);
      expect(message?.body).toBeDefined();
      expect(message?.body).not.toContain('http');
      expect(message?.body).not.toContain('undefined');
    });

    it('⭐ never puts a bearer link in a staff message', async () => {
      /*
       * `change_requested` fans out to `…​.sales`, which is read by people who hold
       * `orders.read` and can open the order properly. A bearer link in an internal inbox is
       * one forward away from being outside the company, for no benefit at all.
       */
      const orderId = await createDraft();
      await appendEvent(orderId, 'change_requested');

      const adapter = new ScriptedAdapter();
      await workerWith(adapter, { webBaseUrl: WEB }).runOnce();

      const staffMessages = adapter.sent.filter(
        (sent) => sent.orderId === orderId && sent.recipientKey.startsWith('group:'),
      );

      expect(staffMessages.length, 'the fixture sent no staff message').toBeGreaterThan(0);
      for (const message of staffMessages) expect(message.body).not.toContain(WEB);
    });
  });

  describe('ⓑ a delivery failure cannot roll back a state change', () => {
    it('leaves the event and the order untouched when every attempt fails', async () => {
      const orderId = await createDraft();
      const eventId = await appendEvent(orderId, 'change_resolved');

      const adapter = new ScriptedAdapter();
      adapter.outcome = { ok: false, error: 'connect ECONNREFUSED 127.0.0.1:25', retryable: true };
      await workerWith(adapter).runOnce();

      const event = await db.select().from(orderEvents).where(eq(orderEvents.id, eventId));
      const order = await db.select().from(orders).where(eq(orders.id, orderId));

      /*
       * The point of the outbox, stated as an assertion: the transition is a fact regardless
       * of what the mail server did. There is no arrangement of this code in which SMTP can
       * reach the transaction that wrote the event, because the worker runs minutes later in
       * a different one.
       */
      expect(event).toHaveLength(1);
      expect(order[0]?.status).toBe('draft');

      const rows = await notificationsFor(orderId);
      expect(rows[0]?.status).toBe('pending'); // Comes back, rather than being lost.
      expect(rows[0]?.attempt_count).toBe(1);
      expect(rows[0]?.last_error).toContain('ECONNREFUSED');
    });

    it('records an attempt even when the adapter throws instead of returning a failure', async () => {
      const orderId = await createDraft();
      await appendEvent(orderId, 'change_resolved');

      const adapter = new ScriptedAdapter();
      adapter.outcome = 'throw';
      await workerWith(adapter).runOnce();

      const rows = await notificationsFor(orderId);

      /*
       * A bug in an adapter must not leave a row `sending` with the reason nowhere — that
       * row is invisible until the lease expires, and "invisible" is the failure mode this
       * whole module is built against.
       *
       * MUTATION: remove the `.catch` in `NotificationWorker.deliver` → the row stays
       * `sending` with attempt_count 0 and this goes red.
       */
      expect(rows[0]?.status).toBe('pending');
      expect(rows[0]?.attempt_count).toBe(1);
      expect(rows[0]?.last_error).toContain('adapter threw');
    });
  });

  describe('idempotency — plan 10.5(1)', () => {
    it('does not send the same message twice when the worker runs twice', async () => {
      const orderId = await createDraft();
      await appendEvent(orderId, 'change_resolved');

      const adapter = new ScriptedAdapter();
      const worker = workerWith(adapter);

      await worker.runOnce();
      await worker.runOnce();
      await worker.runOnce();

      /*
       * The claim is an UPDATE and not a SELECT, so the first run takes the row out of
       * `pending` in the same statement that reads it. `SKIP LOCKED` orders concurrent
       * workers; this is what stops a *sequential* second pass.
       *
       * MUTATION: make `claimDue` a plain SELECT and mark the row afterwards → three sends.
       */
      expect(adapter.sent.filter((message) => message.orderId === orderId)).toHaveLength(1);
      expect(await attemptCountFor(orderId)).toBe(1);

      const rows = await notificationsFor(orderId);
      expect(rows[0]?.status).toBe('sent');
      expect(rows[0]?.sent_at).not.toBeNull();
    });

    it('takes the message out of the queue in the same statement that reads it', async () => {
      const orderId = await createDraft();
      await appendEvent(orderId, 'change_resolved');

      /*
       * ── This test exists because a mutation survived ────────────────────────
       *
       * Removing the `set status = 'sending'` from the claim broke nothing: the sequential
       * "runs three times" test above still passed, because by the second run the row had
       * already been marked `sent` by the *record*, not by the claim. The property that was
       * actually untested is the one that matters under two workers — and two workers is the
       * normal deployment, not an edge case.
       *
       * So the claim is called directly, and then a second worker polls. `SKIP LOCKED` does
       * not help here: the first claim's lock is gone the moment it committed, so a row left
       * `pending` is a row the next poller sends a second time. The flip inside the UPDATE is
       * the only thing standing between the customer and two identical emails.
       */
      const claimed = await repository.claimDue(20, 60_000);
      expect(claimed.filter((row) => row.orderId === orderId)).toHaveLength(1);

      const adapter = new ScriptedAdapter();
      await workerWith(adapter).runOnce();

      expect(adapter.sent.filter((message) => message.orderId === orderId)).toHaveLength(0);
    });

    it('does not resurrect a sent message when a later event arrives', async () => {
      const orderId = await createDraft();
      await appendEvent(orderId, 'change_resolved');

      const adapter = new ScriptedAdapter();
      await workerWith(adapter).runOnce();

      await appendEvent(orderId, 'change_resolved');
      await workerWith(adapter).runOnce();

      // Two events, two messages. Folding the second into the first — which is what a
      // coalescing index that was not partial on `pending` would do — would be a message
      // nobody receives, because the row it folded into has already been sent.
      expect(adapter.sent.filter((message) => message.orderId === orderId)).toHaveLength(2);
      expect(await notificationsFor(orderId)).toHaveLength(2);
    });
  });

  describe('coalescing — plan 10.5(2)', () => {
    it('folds five edits in ten minutes into one message that says it was five', async () => {
      const orderId = await createDraft();
      for (let index = 0; index < 5; index += 1) {
        await appendEvent(orderId, 'quote_revised');
      }

      const rows = await notificationsFor(orderId);

      /*
       * Five events on the spine, one message. The fold happens in the fan-out's
       * `ON CONFLICT`, against the partial unique index on `(order_id, coalesce_key,
       * recipient_key, channel) WHERE status = 'pending'`.
       *
       * MUTATION: drop `notifications_pending_coalesce_key` → five rows, five messages, and
       * this goes red on the first assertion.
       */
      expect(rows).toHaveLength(1);
      expect(rows[0]?.coalesced_count).toBe(4);

      // Not due yet: the window is plan 13's ten minutes and the storm has only just ended.
      const adapter = new ScriptedAdapter();
      await workerWith(adapter).runOnce();
      expect(adapter.sent.filter((message) => message.orderId === orderId)).toHaveLength(0);

      await makeDue(orderId);
      await workerWith(adapter).runOnce();

      const delivered = adapter.sent.find((message) => message.orderId === orderId);
      expect(delivered).toBeDefined();
      // The customer is told it was five. A message about one edit when there were five is
      // how the next phone call becomes about the four they never heard of.
      expect(delivered?.body).toContain('5 ครั้ง');
      expect(await attemptCountFor(orderId)).toBe(1);
    });

    it('does not fold two different kinds of message together', async () => {
      const orderId = await createDraft();
      await appendEvent(orderId, 'quote_revised');
      await appendEvent(orderId, 'change_requested');

      const rows = await notificationsFor(orderId);

      // Folding is by *meaning*: a revision notice to the customer and a work item for sales
      // are two facts with two recipients. Coalescing on time alone would lose one of them.
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.template_key).sort()).toStrictEqual([
        'order.change_requested.sales',
        'order.quote_revised.customer',
      ]);
      expect(rows.find((row) => row.template_key.endsWith('.sales'))?.recipient_key).toBe('group:sales_queue');
    });
  });

  describe('the dead queue — plan 10.5(3)', () => {
    it('gives up after the configured attempts and surfaces the message', async () => {
      const orderId = await createDraft();
      await appendEvent(orderId, 'change_resolved');

      const adapter = new ScriptedAdapter();
      adapter.outcome = { ok: false, error: 'connect ETIMEDOUT', retryable: true };
      // Three attempts and no backoff, so the test exercises the *decision* rather than the
      // clock. The count is `maxAttempts` and the plan-13 default of five is asserted in
      // config.test.ts, where it belongs.
      const worker = workerWith(adapter, { maxAttempts: 3, retryBaseMs: 1, retryMaxMs: 1 });

      for (let attempt = 0; attempt < 3; attempt += 1) {
        await makeDue(orderId);
        await worker.runOnce();
      }

      const rows = await notificationsFor(orderId);
      expect(rows[0]?.status).toBe('dead');
      expect(rows[0]?.attempt_count).toBe(3);
      expect(rows[0]?.dead_at).not.toBeNull();

      /*
       * And it is *visible*, which is the whole of plan 10.5(3): a dead-lettered
       * notification nobody sees is worse than none, because the company believes the
       * customer was told.
       */
      const service = new NotificationsService(config(), repository);
      const queue = await service.deadQueue(200);
      const mine = queue.dead.find((row) => row.orderId === orderId);

      expect(mine).toBeDefined();
      expect(mine?.attemptCount).toBe(3);
      expect(mine?.lastError).toContain('ETIMEDOUT');
      // The address is masked: deciding whether to retry needs the kind of address, not the
      // address. Plan 7.6 draws the same line for slips.
      expect(mine?.recipient).toBe('email:s•••@example.test');
      expect(queue.summary.dead).toBeGreaterThan(0);
    });

    it('says so in the log, because a queue nobody opens is the failure', async () => {
      const orderId = await createDraft();
      await appendEvent(orderId, 'change_resolved');

      const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      try {
        const adapter = new ScriptedAdapter();
        adapter.outcome = { ok: false, error: '550 5.1.1 user unknown', retryable: false };
        await workerWith(adapter).runOnce();

        /*
         * The endpoint is the queue a person opens; this is the part that makes them open
         * it, because nobody opens a page they have no reason to suspect. It logs at `error`
         * rather than `warn` because the fact being reported is that a customer believes
         * they were told something and was not — and an alerting rule should be able to key
         * on the level rather than on a regex over the message.
         */
        const lines = logged.mock.calls.map((call) => String(call[0]));
        expect(lines.some((line) => line.includes('dead queue'))).toBe(true);
        expect(lines.some((line) => line.includes('Nobody has been told'))).toBe(true);
      } finally {
        logged.mockRestore();
      }
    });

    it('gives up immediately on a failure that will never succeed', async () => {
      const orderId = await createDraft();
      await appendEvent(orderId, 'change_resolved');

      const adapter = new ScriptedAdapter();
      adapter.outcome = { ok: false, error: '550 5.1.1 user unknown', retryable: false };
      await workerWith(adapter, { maxAttempts: 5 }).runOnce();

      const rows = await notificationsFor(orderId);

      /*
       * A mailbox that does not exist will not start existing on the fifth attempt, and four
       * more tries delay the dead queue by a quarter of an hour — during which the company
       * believes the customer was told.
       *
       * MUTATION: drop `permanent` from `recordFailure`'s CASE → status is `pending` and
       * this goes red.
       */
      expect(rows[0]?.status).toBe('dead');
      expect(rows[0]?.attempt_count).toBe(1);
    });

    it('dead-letters a message this build cannot render, rather than sending a placeholder', async () => {
      const orderId = await createDraft();
      await appendEvent(orderId, 'change_resolved');

      // A migration ahead of the deploy: the rule names a template this build does not have.
      await db.execute(sql`
        update notifications set template_key = 'order.from_the_future.customer'
         where order_id = ${orderId}
      `);

      const adapter = new ScriptedAdapter();
      await workerWith(adapter).runOnce();

      const rows = await notificationsFor(orderId);

      expect(adapter.sent.filter((message) => message.orderId === orderId)).toHaveLength(0);
      expect(rows[0]?.status).toBe('dead');
      expect(rows[0]?.last_error).toContain('order.from_the_future.customer');
    });

    it('dead-letters a channel with no adapter, naming the channel', async () => {
      const orderId = await createDraft();
      await appendEvent(orderId, 'change_resolved');
      await db.execute(sql`update notifications set channel = 'line' where order_id = ${orderId}`);

      // A LINE row in a build with no LINE token. It must surface as a configuration problem
      // in the queue, not as five failed sends that look like an outage.
      await workerWith(new ScriptedAdapter()).runOnce();

      const rows = await notificationsFor(orderId);
      expect(rows[0]?.status).toBe('dead');
      expect(rows[0]?.last_error).toContain("channel 'line'");
    });

    it('requeues a dead message once, and says so when there is nothing to requeue', async () => {
      const orderId = await createDraft();
      await appendEvent(orderId, 'change_resolved');

      const adapter = new ScriptedAdapter();
      adapter.outcome = { ok: false, error: '550 5.1.1 user unknown', retryable: false };
      await workerWith(adapter).runOnce();

      const [dead] = await notificationsFor(orderId);
      expect(dead?.status).toBe('dead');

      const service = new NotificationsService(config(), repository);
      expect(await service.retry(dead?.id ?? '')).toStrictEqual({ id: dead?.id ?? '', requeued: true });

      // A second click, or a colleague working the same queue, is a visible no-op rather
      // than a second delivery.
      expect((await service.retry(dead?.id ?? '')).requeued).toBe(false);

      adapter.outcome = { ok: true };
      await workerWith(adapter).runOnce();

      const rows = await notificationsFor(orderId);
      expect(rows[0]?.status).toBe('sent');
      /*
       * `attempt_count` was not reset by the requeue, so the number of times this message
       * has been attempted is still the truth — which is the number a dispute asks about,
       * and the reason a requeued message gets exactly one more try before it is back in
       * front of the person who clicked.
       */
      expect(rows[0]?.attempt_count).toBe(2);
    });
  });

  describe('the lease — the failure nobody sees', () => {
    it('reclaims a message left `sending` by a process that died', async () => {
      const orderId = await createDraft();
      await appendEvent(orderId, 'change_resolved');

      // Exactly what a SIGKILL between the claim and the record leaves behind.
      await db.execute(sql`
        update notifications
           set status = 'sending', updated_at = now() - interval '10 minutes'
         where order_id = ${orderId}
      `);

      const adapter = new ScriptedAdapter();
      await workerWith(adapter, { claimLeaseMs: 60_000 }).runOnce();

      /*
       * Without the lease this row is not `pending`, so it is never retried, and not `dead`,
       * so it is not in the queue anybody reads. It is the one state in this system that is
       * silent in both directions.
       *
       * MUTATION: delete the `status = 'sending' and updated_at < …` arm of `claimDue`'s
       * WHERE clause → nothing is claimed and this goes red.
       */
      expect(adapter.sent.filter((message) => message.orderId === orderId)).toHaveLength(1);
      expect((await notificationsFor(orderId))[0]?.status).toBe('sent');
    });

    it('does not steal a message another worker is still sending', async () => {
      const orderId = await createDraft();
      await appendEvent(orderId, 'change_resolved');
      await db.execute(sql`update notifications set status = 'sending', updated_at = now() where order_id = ${orderId}`);

      const adapter = new ScriptedAdapter();
      await workerWith(adapter, { claimLeaseMs: 60_000 }).runOnce();

      // The lease is a recovery mechanism, not a free-for-all: a worker that is merely slow
      // keeps its row until the lease actually expires.
      expect(adapter.sent.filter((message) => message.orderId === orderId)).toHaveLength(0);
    });
  });

  describe('the attempt log — plan 10.1’s "what did we actually send them"', () => {
    it('records every attempt with the language it was actually rendered in', async () => {
      const orderId = await createDraft();
      await appendEvent(orderId, 'change_resolved');

      // The customer asked for English. There is no English catalogue (phase 6), so the
      // message goes out in Thai — and the *rendered* language is what is recorded, so the
      // fallback is a fact in the evidence rather than a reconstruction during a dispute.
      await db.execute(sql`update orders set contact_locale = 'en' where id = ${orderId}`);

      const adapter = new ScriptedAdapter();
      adapter.outcome = { ok: false, error: 'connect ECONNREFUSED', retryable: true };
      await workerWith(adapter, { retryBaseMs: 1, retryMaxMs: 1 }).runOnce();

      await makeDue(orderId);
      adapter.outcome = { ok: true, providerMessageId: 'queued-as-ABC123' };
      await workerWith(adapter).runOnce();

      const [row] = await notificationsFor(orderId);
      const service = new NotificationsService(config(), repository);
      const attempts = await service.attempts(row?.id ?? '');

      // `last_error` remembers only the most recent failure; a dispute asks about all of them.
      expect(attempts).toHaveLength(2);
      expect(attempts[0]?.outcome).toBe('failed');
      expect(attempts[0]?.error).toContain('ECONNREFUSED');
      expect(attempts[1]?.outcome).toBe('sent');
      expect(attempts[1]?.providerMessageId).toBe('queued-as-ABC123');
      expect(attempts[1]?.locale).toBe('th');
      expect(attempts[1]?.renderedSubject).toContain('ตอบกลับคำขอของท่านแล้ว');
      expect(attempts[1]?.recipient).toBe('email:s•••@example.test');
    });

    it('cannot be edited after the fact', async () => {
      const orderId = await createDraft();
      await appendEvent(orderId, 'change_resolved');
      await workerWith(new ScriptedAdapter()).runOnce();

      const failure = await db
        .execute(sql`update notification_attempts set outcome = 'failed'
                      where notification_id in (select id from notifications where order_id = ${orderId})`)
        .then(() => undefined, (error: unknown) => error);

      // The evidence is append-only, like the spine it hangs off. A dispute record that can
      // be rewritten is not a record.
      expect(describeError(failure)).toContain('append-only');
    });
  });
});
