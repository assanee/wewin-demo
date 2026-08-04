import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '@wewin/db/client';
import { sql } from '@wewin/db/sql';

import { DRIZZLE } from '../database/database.tokens';
import type { NotificationChannel, NotificationRecipientKind, NotificationStatus } from './notifications.types';

/**
 * The only thing in this app that reads or writes `notifications` and `notification_attempts`.
 *
 * Everything here is raw SQL rather than the query builder, and that is a decision rather
 * than a shortcut. The three statements that matter — the claim, the two records — each
 * depend on a Postgres behaviour that the builder either cannot express or would express
 * less legibly, and each of them is the difference between an outbox and a queue that loses
 * things:
 *
 *   `claimDue`      a `FOR UPDATE SKIP LOCKED` CTE feeding an UPDATE, so two workers never
 *                   take the same row and neither waits for the other.
 *   `recordSuccess` / `recordFailure`
 *                   `attempt_no` derived inside the statement from the row's own
 *                   `attempt_count`, so the attempt log cannot skip or repeat a number.
 *
 * ── Time comes from the database, never from this process ────────────────────
 *
 * Every `now()` below is Postgres's. `send_after` is compared against the same clock that
 * set it, so a worker whose container clock has drifted cannot decide a message is due an
 * hour early — or, worse, schedule a retry into a past that has already been polled. The
 * only durations this process supplies are *intervals* (the backoff, the lease), which are
 * clock-independent by construction.
 */

/** One claimed row, with the order facts a template needs. */
export interface ClaimedNotification {
  readonly id: string;
  readonly orderId: string;
  readonly eventId: string;
  readonly latestEventId: string;
  readonly recipientKind: NotificationRecipientKind;
  /** Never null on a claimed row — see the WHERE clause in `claimDue`. */
  readonly recipientKey: string;
  readonly channel: NotificationChannel;
  readonly templateKey: string;
  readonly attemptCount: number;
  readonly coalescedCount: number;
  readonly orderNo: string | null;
  readonly contactName: string | null;
  readonly contactLocale: string;
}

export interface AttemptRecord {
  readonly notificationId: string;
  readonly channel: NotificationChannel;
  readonly recipientKey: string;
  /** What the message was *rendered* in, which is not always what was asked for — see locale.ts. */
  readonly locale: string;
  readonly renderedSubject: string;
}

export interface DeadNotification {
  readonly id: string;
  readonly orderId: string;
  readonly orderNo: string | null;
  readonly eventId: string;
  readonly recipientKind: NotificationRecipientKind;
  readonly recipientKey: string | null;
  readonly channel: NotificationChannel;
  readonly templateKey: string;
  readonly attemptCount: number;
  readonly lastError: string | null;
  readonly deadAt: string;
  readonly createdAt: string;
}

export interface SuppressedNotification {
  readonly id: string;
  readonly orderId: string;
  readonly orderNo: string | null;
  readonly recipientKind: NotificationRecipientKind;
  readonly channel: NotificationChannel;
  readonly templateKey: string;
  readonly suppressedReason: string | null;
  readonly createdAt: string;
}

export type OutboxSummary = Readonly<Record<NotificationStatus, number>> & {
  /** The oldest thing still waiting. A number that climbs is a worker that has stopped. */
  readonly oldestPendingAt: string | null;
  readonly oldestDeadAt: string | null;
  /** Claimed but never recorded — a process that died mid-send. See `claimDue`'s lease. */
  readonly stuckSending: number;
};

@Injectable()
export class NotificationsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * Take up to `batchSize` messages that are due, and mark them as being sent.
   *
   * ── `FOR UPDATE SKIP LOCKED`, and what it is and is not for ──────────────
   *
   * It orders concurrent workers: two processes polling at the same moment take disjoint
   * sets rather than fighting over the same rows or serialising behind each other. It does
   * **not** prevent a second delivery on its own — that comes from the status flipping to
   * `sending` in the same statement, which is why the claim is an UPDATE and not a SELECT
   * followed by one.
   *
   * ── The lease, which is the failure mode nobody sees ─────────────────────
   *
   * A row claimed by a process that is then killed stays `sending` forever: not pending, so
   * never retried; not dead, so never in the queue plan 10.5(3) demands. It is invisible in
   * exactly the way the plan warns about. So the claim also picks up rows that have been
   * `sending` longer than the lease, and `updated_at` is the marker — set explicitly here,
   * because nothing in the schema touches it automatically.
   *
   * The cost of the lease is a possible duplicate: a worker that was merely slow, not dead,
   * may still be talking to an SMTP server when another takes the row. That trade is
   * deliberate and is the right way round — a customer who receives a notice twice is
   * annoyed, a customer who never receives it is uninformed while the company believes
   * otherwise. The far end is given what idempotency it can use (`Message-ID`,
   * `X-Line-Retry-Key`), and the attempt log records both attempts, so the duplicate is
   * visible rather than mysterious.
   *
   * `recipient_key is not null` is not defensive noise: `notifications_addressed_unless_suppressed`
   * already makes a `pending` row with no address impossible. It is here so the narrowing
   * to a non-null `recipientKey` above is a fact the query established, rather than a `!`
   * asserting something the column type denies.
   */
  async claimDue(batchSize: number, leaseMs: number): Promise<readonly ClaimedNotification[]> {
    const leaseSeconds = leaseMs / 1000;

    const result = await this.db.execute(sql`
      with claimed as (
        select id
          from notifications
         where recipient_key is not null
           and (
             (status = 'pending' and send_after <= now())
             or (status = 'sending' and updated_at < now() - make_interval(secs => ${leaseSeconds}))
           )
         order by send_after
         for update skip locked
         limit ${batchSize}
      )
      update notifications n
         set status = 'sending', updated_at = now()
        from claimed, orders o
       where n.id = claimed.id
         and o.id = n.order_id
      returning
        n.id, n.order_id, n.event_id, n.latest_event_id,
        n.recipient_kind, n.recipient_key, n.channel, n.template_key,
        n.attempt_count, n.coalesced_count,
        o.order_no, o.contact_name, o.contact_locale
    `);

    return rowsOf(result).flatMap((row) => {
      const claimed = toClaimed(row);
      return claimed === undefined ? [] : [claimed];
    });
  }

  /**
   * The message went out. Append the evidence and close the row, in one transaction.
   *
   * Two statements and not one because they are two different facts: `notification_attempts`
   * is append-only evidence (a trigger refuses UPDATE and DELETE on it) and `notifications`
   * is current state. Writing them together is what makes "sent, but no record of sending"
   * unrepresentable.
   */
  async recordSuccess(attempt: AttemptRecord, providerMessageId: string | undefined): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`
        insert into notification_attempts
          (notification_id, attempt_no, outcome, channel, recipient_key, locale, rendered_subject, provider_message_id)
        select n.id, n.attempt_count + 1, 'sent', ${attempt.channel}, ${attempt.recipientKey},
               ${attempt.locale}, ${attempt.renderedSubject}, ${providerMessageId ?? null}
          from notifications n
         where n.id = ${attempt.notificationId}
      `);

      await tx.execute(sql`
        update notifications
           set status = 'sent',
               sent_at = now(),
               attempt_count = attempt_count + 1,
               last_error = null,
               updated_at = now()
         where id = ${attempt.notificationId}
      `);
    });
  }

  /**
   * The message did not go out. Decide, in SQL, whether it comes back.
   *
   * The decision is made inside the statement rather than in TypeScript so that it reads
   * the row's real `attempt_count` — the one the attempt insert just advanced — instead of
   * the value the worker happened to claim, which is stale the moment a lease hands the row
   * to a second process.
   *
   * `permanent` short-circuits the count: an address that does not exist will not start
   * existing on the fifth attempt, and four more tries delay the dead queue by a quarter of
   * an hour during which the company believes the customer was told (plan 10.5(3)).
   */
  async recordFailure(
    attempt: AttemptRecord,
    failure: { readonly error: string; readonly permanent: boolean; readonly maxAttempts: number; readonly retryDelayMs: number },
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`
        insert into notification_attempts
          (notification_id, attempt_no, outcome, channel, recipient_key, locale, rendered_subject, error)
        select n.id, n.attempt_count + 1, 'failed', ${attempt.channel}, ${attempt.recipientKey},
               ${attempt.locale}, ${attempt.renderedSubject}, ${failure.error}
          from notifications n
         where n.id = ${attempt.notificationId}
      `);

      await tx.execute(sql`
        update notifications
           set attempt_count = attempt_count + 1,
               last_error = ${failure.error},
               status = case
                 when ${failure.permanent} or attempt_count + 1 >= ${failure.maxAttempts} then 'dead'
                 else 'pending'
               end,
               dead_at = case
                 when ${failure.permanent} or attempt_count + 1 >= ${failure.maxAttempts} then now()
                 else null
               end,
               send_after = case
                 when ${failure.permanent} or attempt_count + 1 >= ${failure.maxAttempts} then send_after
                 else now() + make_interval(secs => ${failure.retryDelayMs / 1000})
               end,
               updated_at = now()
         where id = ${attempt.notificationId}
      `);
    });
  }

  /**
   * The queue plan 10.5(3) demands: everything we gave up on, newest first.
   *
   * Reads `notifications_dead_idx`, which is partial on `status = 'dead'` — so looking at
   * this costs nothing whether there are two dead rows or none, which is the property that
   * decides whether anybody ever looks.
   */
  async deadQueue(limit: number): Promise<readonly DeadNotification[]> {
    const result = await this.db.execute(sql`
      select n.id, n.order_id, o.order_no, n.event_id, n.recipient_kind, n.recipient_key,
             n.channel, n.template_key, n.attempt_count, n.last_error,
             n.dead_at, n.created_at
        from notifications n
        join orders o on o.id = n.order_id
       where n.status = 'dead'
       order by n.dead_at desc
       limit ${limit}
    `);

    return rowsOf(result).flatMap((row) => {
      const dead = toDead(row);
      return dead === undefined ? [] : [dead];
    });
  }

  /**
   * Messages that were never addressable — plan 10.5(3)'s quieter half.
   *
   * A `suppressed` row is not a failure and never will be: the fan-out could not find an
   * address at all (a quote with no contact channel, a LINE rule with no LINE address book)
   * and wrote a visible terminal row instead of silently writing nothing. It belongs beside
   * the dead queue because the operational question is the same one — *who did we fail to
   * tell?* — and the answers are different enough that mixing them into one list would let
   * the fixable ones hide among the ones that need a policy decision.
   */
  async suppressed(limit: number): Promise<readonly SuppressedNotification[]> {
    const result = await this.db.execute(sql`
      select n.id, n.order_id, o.order_no, n.recipient_kind, n.channel, n.template_key,
             n.suppressed_reason, n.created_at
        from notifications n
        join orders o on o.id = n.order_id
       where n.status = 'suppressed'
       order by n.created_at desc
       limit ${limit}
    `);

    return rowsOf(result).flatMap((row) => {
      const suppressedRow = toSuppressed(row);
      return suppressedRow === undefined ? [] : [suppressedRow];
    });
  }

  /** Every attempt at one message, oldest first. The dispute answer, in full. */
  async attemptsFor(notificationId: string): Promise<readonly Record<string, unknown>[]> {
    const result = await this.db.execute(sql`
      select attempt_no, outcome, channel, recipient_key, locale,
             rendered_subject, provider_message_id, error, attempted_at
        from notification_attempts
       where notification_id = ${notificationId}
       order by attempt_no
    `);

    return rowsOf(result).flatMap((row) =>
      typeof row === 'object' && row !== null ? [row as Record<string, unknown>] : [],
    );
  }

  /**
   * Put a dead message back on the queue.
   *
   * `attempt_count` is **not** reset, and the consequence is deliberate: a requeued message
   * that fails again is dead again immediately, because `attempt_count + 1 >= maxAttempts`
   * is already true. A human decided to retry this one; they get one attempt and then the
   * row is back in front of them. Resetting the counter would turn one click into another
   * fifteen minutes of retries and would erase how many times this message has now been
   * attempted, which is the number a dispute asks about.
   *
   * Returns false when the row was not dead — so a double-click, or a retry of something a
   * colleague already requeued, is a visible no-op rather than a second delivery.
   */
  async requeue(notificationId: string): Promise<boolean> {
    const result = await this.db.execute(sql`
      update notifications
         set status = 'pending',
             dead_at = null,
             send_after = now(),
             updated_at = now()
       where id = ${notificationId}
         and status = 'dead'
      returning id
    `);

    return rowsOf(result).length > 0;
  }

  /**
   * The two numbers the worker needs, and only those, as index-only scans.
   *
   * Separate from `summary()` because they are read on very different schedules. The
   * summary is a page somebody opens; this runs on every poll, forever, and a full-table
   * `count(*) FILTER` would grow with `sent` — the status that grows without limit — until
   * the poll is the most expensive thing the process does and somebody turns the warning
   * off. That is a slow path to plan 10.5(3)'s failure: the queue stops being watched, and
   * the reason is a performance complaint rather than a decision.
   *
   * Each of these is a `WHERE` that matches a partial index (`notifications_dead_idx`, and
   * `notifications_due_idx` for the `sending` scan), so the cost is proportional to the
   * number of *problems* rather than to the size of the table.
   */
  async deadSnapshot(leaseMs: number): Promise<{
    readonly dead: number;
    readonly oldestDeadAt: string | null;
    readonly stuckSending: number;
  }> {
    const [deadResult, stuckResult] = await Promise.all([
      this.db.execute(sql`
        select count(*) as dead, min(dead_at) as oldest_dead_at
          from notifications
         where status = 'dead'
      `),
      this.db.execute(sql`
        select count(*) as stuck
          from notifications
         where status = 'sending' and updated_at < now() - make_interval(secs => ${leaseMs / 1000})
      `),
    ]);

    const dead = recordOf(rowsOf(deadResult)[0]);
    const stuck = recordOf(rowsOf(stuckResult)[0]);

    return {
      dead: countOf(dead['dead']),
      oldestDeadAt: timestampOf(dead['oldest_dead_at']),
      stuckSending: countOf(stuck['stuck']),
    };
  }

  /** The whole outbox at a glance, for the dashboard. One query, read when a page is opened. */
  async summary(leaseMs: number): Promise<OutboxSummary> {
    const result = await this.db.execute(sql`
      select
        count(*) filter (where status = 'pending')    as pending,
        count(*) filter (where status = 'sending')    as sending,
        count(*) filter (where status = 'sent')       as sent,
        count(*) filter (where status = 'dead')       as dead,
        count(*) filter (where status = 'suppressed') as suppressed,
        count(*) filter (
          where status = 'sending' and updated_at < now() - make_interval(secs => ${leaseMs / 1000})
        ) as stuck_sending,
        min(send_after) filter (where status = 'pending') as oldest_pending_at,
        min(dead_at)    filter (where status = 'dead')    as oldest_dead_at
      from notifications
    `);

    const record = recordOf(rowsOf(result)[0]);

    return {
      pending: countOf(record['pending']),
      sending: countOf(record['sending']),
      sent: countOf(record['sent']),
      dead: countOf(record['dead']),
      suppressed: countOf(record['suppressed']),
      stuckSending: countOf(record['stuck_sending']),
      oldestPendingAt: timestampOf(record['oldest_pending_at']),
      oldestDeadAt: timestampOf(record['oldest_dead_at']),
    };
  }
}

/* ------------------------------------------------------------------------- *
 * Row parsing.
 *
 * `db.execute` hands back `unknown` rows — a raw statement has no schema to infer from —
 * so every field is checked rather than cast. A `as ClaimedNotification` here would be the
 * one place in this module where a column rename becomes a runtime `undefined` instead of a
 * compile error, and the columns being renamed would be the ones deciding who gets told
 * what.
 * ------------------------------------------------------------------------- */

function recordOf(row: unknown): Record<string, unknown> {
  return typeof row === 'object' && row !== null ? (row as Record<string, unknown>) : {};
}

function rowsOf(result: unknown): readonly unknown[] {
  if (typeof result !== 'object' || result === null || !('rows' in result)) return [];
  const { rows } = result as { rows: unknown };
  return Array.isArray(rows) ? rows : [];
}

/** `count(*)` arrives as a string: Postgres `bigint`, which `pg` will not silently narrow. */
function countOf(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function timestampOf(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return null;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function nullableStringOf(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function toClaimed(row: unknown): ClaimedNotification | undefined {
  if (typeof row !== 'object' || row === null) return undefined;
  const record = row as Record<string, unknown>;

  const id = stringOf(record['id']);
  const orderId = stringOf(record['order_id']);
  const eventId = stringOf(record['event_id']);
  const latestEventId = stringOf(record['latest_event_id']);
  const recipientKind = stringOf(record['recipient_kind']);
  const recipientKey = stringOf(record['recipient_key']);
  const channel = stringOf(record['channel']);
  const templateKey = stringOf(record['template_key']);
  const contactLocale = stringOf(record['contact_locale']);

  if (
    id === undefined ||
    orderId === undefined ||
    eventId === undefined ||
    latestEventId === undefined ||
    recipientKind === undefined ||
    recipientKey === undefined ||
    channel === undefined ||
    templateKey === undefined ||
    contactLocale === undefined
  ) {
    return undefined;
  }

  return {
    id,
    orderId,
    eventId,
    latestEventId,
    recipientKind: recipientKind as NotificationRecipientKind,
    recipientKey,
    channel: channel as NotificationChannel,
    templateKey,
    attemptCount: countOf(record['attempt_count']),
    coalescedCount: countOf(record['coalesced_count']),
    orderNo: nullableStringOf(record['order_no']),
    contactName: nullableStringOf(record['contact_name']),
    contactLocale,
  };
}

function toDead(row: unknown): DeadNotification | undefined {
  if (typeof row !== 'object' || row === null) return undefined;
  const record = row as Record<string, unknown>;

  const id = stringOf(record['id']);
  const orderId = stringOf(record['order_id']);
  const eventId = stringOf(record['event_id']);
  const recipientKind = stringOf(record['recipient_kind']);
  const channel = stringOf(record['channel']);
  const templateKey = stringOf(record['template_key']);
  const deadAt = timestampOf(record['dead_at']);
  const createdAt = timestampOf(record['created_at']);

  if (
    id === undefined ||
    orderId === undefined ||
    eventId === undefined ||
    recipientKind === undefined ||
    channel === undefined ||
    templateKey === undefined ||
    deadAt === null ||
    createdAt === null
  ) {
    return undefined;
  }

  return {
    id,
    orderId,
    orderNo: nullableStringOf(record['order_no']),
    eventId,
    recipientKind: recipientKind as NotificationRecipientKind,
    recipientKey: nullableStringOf(record['recipient_key']),
    channel: channel as NotificationChannel,
    templateKey,
    attemptCount: countOf(record['attempt_count']),
    lastError: nullableStringOf(record['last_error']),
    deadAt,
    createdAt,
  };
}

function toSuppressed(row: unknown): SuppressedNotification | undefined {
  if (typeof row !== 'object' || row === null) return undefined;
  const record = row as Record<string, unknown>;

  const id = stringOf(record['id']);
  const orderId = stringOf(record['order_id']);
  const recipientKind = stringOf(record['recipient_kind']);
  const channel = stringOf(record['channel']);
  const templateKey = stringOf(record['template_key']);
  const createdAt = timestampOf(record['created_at']);

  if (
    id === undefined ||
    orderId === undefined ||
    recipientKind === undefined ||
    channel === undefined ||
    templateKey === undefined ||
    createdAt === null
  ) {
    return undefined;
  }

  return {
    id,
    orderId,
    orderNo: nullableStringOf(record['order_no']),
    recipientKind: recipientKind as NotificationRecipientKind,
    channel: channel as NotificationChannel,
    templateKey,
    suppressedReason: nullableStringOf(record['suppressed_reason']),
    createdAt,
  };
}
