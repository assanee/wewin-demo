import { randomUUID } from 'node:crypto';

import { createDatabase, createPool, type Database, type Pool } from '@wewin/db/client';
import { guests, notifications, orderEvents, orders, userEmails, users } from '@wewin/db/schema';
import { eq, sql } from '@wewin/db/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  DeliveryResult,
  NotificationChannelAdapter,
  RenderedMessage,
} from '../../src/notifications/channels/channel';
import { NotificationWorker } from '../../src/notifications/notification-worker.service';
import { parseNotificationsConfig } from '../../src/notifications/notifications.config';
import { DocumentLinkService } from '../../src/orders/document-link';
import { testSessionConfig } from '../support/app';
import { NotificationsRepository } from '../../src/notifications/notifications.repository';

/**
 * Does a message actually go out to somebody who asked to be forgotten?
 *
 * ── Why this exists, and why it is at this layer ─────────────────────────────────
 *
 * `packages/db/tests/erasure.test.ts` proves that `erase_user()` suppresses the queue and
 * that the fan-out refuses to address an erased customer. Both are assertions about *rows*.
 * The claim that matters to a person is about a *message*, and the two are only the same
 * thing while the worker's claim query and the suppression agree about what `pending` means.
 *
 * They did not always agree, and that is the whole reason this file exists. Erasure was
 * signed off with `users.status = 'erased'`, every credential deleted and a live session
 * refused with 401 — and a `NotificationWorker` driven by hand, minutes later, claimed a row
 * queued just before the erasure and delivered `มีการแก้ไขใบเสนอราคาของท่าน` to
 * `email:erased-…@example.test`. Nothing was red. Every row said the erasure had run.
 *
 * So this is the assertion at the layer where the harm is: an adapter that records everything
 * it is asked to send, and the requirement that the erased address is not in the list.
 *
 * ── The control is load-bearing ──────────────────────────────────────────────────
 *
 * "The adapter sent nothing" is also what a broken fixture, an empty queue, a worker with no
 * matching channel, or a `send_after` in the future looks like. So the same worker, in the
 * same run, must deliver the other order's message — the one whose customer is still active.
 * Without that half this file would pass with the whole outbox switched off.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

/** Records every message it is handed, and never fails. */
class Recorder implements NotificationChannelAdapter {
  readonly channel = 'email' as const;
  readonly sent: RenderedMessage[] = [];

  supports(recipientKey: string): boolean {
    return recipientKey.startsWith('email:') || recipientKey.startsWith('group:');
  }

  async send(message: RenderedMessage): Promise<DeliveryResult> {
    this.sent.push(message);
    return { ok: true, providerMessageId: `erasure-probe-${String(this.sent.length)}` };
  }
}

describeWithPg('the outbox against an erased recipient', () => {
  const tag = randomUUID().slice(0, 8);
  let pool: Pool;
  let db: Database;

  beforeAll(() => {
    pool = createPool(url ?? '');
    db = createDatabase(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  /** A customer with a verified address, an order of their own, and one event on its spine. */
  const customerWithAnOrder = async (
    label: string,
  ): Promise<{ userId: string; address: string; orderId: string }> => {
    const address = `outbox-erasure-${tag}-${label}@example.test`;

    const [user] = await db
      .insert(users)
      .values({ displayName: `สมชาย ${label}` })
      .returning({ id: users.id });
    if (!user) throw new Error('inserting a user returned no row');

    await db
      .insert(userEmails)
      .values({ userId: user.id, address, verifiedAt: new Date(), isPrimary: true });

    const [guest] = await db.insert(guests).values({}).returning({ id: guests.id });
    if (!guest) throw new Error('inserting a guest returned no row');

    const orderId = randomUUID();
    const createdEvent = randomUUID();

    await db.transaction(async (tx) => {
      await tx.insert(orders).values({
        id: orderId,
        statusEventId: createdEvent,
        guestId: guest.id,
        customerUserId: user.id,
        contactEmail: address,
        contactName: `สมชาย ${label}`,
      });
      await tx.insert(orderEvents).values({
        id: createdEvent,
        orderId,
        eventType: 'created',
        toStatus: 'draft',
        actorKind: 'customer',
        actorUserId: user.id,
      });
    });

    // `change_resolved` notifies the customer and nobody else, so what the adapter receives
    // for this order is unambiguously the message addressed to this person.
    await db.transaction(async (tx) => {
      await tx.execute(sql`select id from orders where id = ${orderId}::uuid for update`);
      await tx.insert(orderEvents).values({
        id: randomUUID(),
        orderId,
        eventType: 'change_resolved',
        actorKind: 'system',
      });
    });

    return { userId: user.id, address, orderId };
  };

  it('will not deliver a message that was queued before the erasure', async () => {
    const erased = await customerWithAnOrder('erased');
    const control = await customerWithAnOrder('control');

    // Both are queued and addressed at this point — asserted, so that a fixture which failed
    // to queue anything cannot be mistaken for a suppression that worked.
    const before = await db
      .select({ recipientKey: notifications.recipientKey })
      .from(notifications)
      .where(eq(notifications.orderId, erased.orderId));
    expect(before.map((row) => row.recipientKey)).toContain(`email:${erased.address}`);

    await db.execute(sql`select close_user(${erased.userId}::uuid)`);
    await db.execute(
      sql`select erase_user(${erased.userId}::uuid, null::uuid, 'self_service', 'PDPA s.33 right to erasure')`,
    );

    /*
     * Park everything else and pull these two into the past. The worker claims from *the*
     * queue rather than from a queue per order (see outbox.pg.test.ts's `quiesce`), so
     * without this the adapter would also receive whatever a previous file left behind and
     * the assertion below would be about somebody else's message.
     */
    await db.execute(sql`
      update notifications set send_after = now() + interval '1 day', updated_at = now()
       where status in ('pending', 'sending')
         and order_id not in (${erased.orderId}::uuid, ${control.orderId}::uuid)`);
    await db.execute(sql`
      update notifications set send_after = now() - interval '1 second'
       where status = 'pending' and order_id in (${erased.orderId}::uuid, ${control.orderId}::uuid)`);

    const recorder = new Recorder();
    await new NotificationWorker(
      parseNotificationsConfig({ NODE_ENV: 'test' }),
      [recorder],
      new NotificationsRepository(db),
      /* No `NOTIFICATIONS_WEB_BASE_URL` in that config, so nothing here mints a link. */
      new DocumentLinkService(testSessionConfig()),
    ).runOnce();

    const delivered = recorder.sent.map((message) => message.recipientKey);

    /*
     * The control first, deliberately. If it fails, the assertion after it proves nothing,
     * and reading them in this order is what makes that obvious in the output.
     */
    expect(delivered, 'the worker delivered nothing at all — this run proves nothing').toContain(
      `email:${control.address}`,
    );
    expect(
      delivered,
      'a message was delivered to a person who asked to be forgotten',
    ).not.toContain(`email:${erased.address}`);

    // And the row that was not sent is still there, saying so. A queue that quietly loses a
    // message is the failure plan 10.5(3) is about; this one loses the address and keeps the
    // fact — which is also what a DSAR answer needs.
    const after = await db
      .select({ status: notifications.status, reason: notifications.suppressedReason })
      .from(notifications)
      .where(eq(notifications.orderId, erased.orderId));

    expect(after.every((row) => row.status === 'suppressed')).toBe(true);
    expect(after.every((row) => row.reason === 'recipient_erased')).toBe(true);
  }, 60_000);
});
