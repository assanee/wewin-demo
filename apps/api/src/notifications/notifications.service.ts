import { Inject, Injectable } from '@nestjs/common';

import type { NotificationsConfig } from './notifications.config';
import {
  maskRecipientKey,
  type DeadNotificationWire,
  type DeadQueueWire,
  type NotificationAttemptWire,
  type OutboxSummaryWire,
  type RetryResultWire,
  type SuppressedNotificationWire,
} from './notifications.contract';
import { NotificationsRepository } from './notifications.repository';
import { NOTIFICATIONS_CONFIG } from './notifications.tokens';

/**
 * The read side of the outbox — plan 10.5(3)'s queue, and the dispute answer.
 *
 * Thin on purpose. There is no business logic in a dead-letter queue; there is a list, a
 * summary, a per-message history, and one button. What this layer *does* own is the shape
 * that leaves the process — specifically the masking of recipient addresses, which is
 * applied here rather than in the controller so that a second endpoint cannot be added
 * later that forgets it.
 */
@Injectable()
export class NotificationsService {
  constructor(
    @Inject(NOTIFICATIONS_CONFIG) private readonly config: NotificationsConfig,
    private readonly repository: NotificationsRepository,
  ) {}

  /**
   * Everything a person needs to answer "who did we fail to tell?" in one response.
   *
   * The summary and both lists together, rather than three endpoints, because the failure
   * this is guarding against is nobody looking. A page that needs three requests to say
   * whether anything is wrong is a page that gets built with two of them.
   */
  async deadQueue(limit: number): Promise<DeadQueueWire> {
    const [summary, dead, suppressed] = await Promise.all([
      this.repository.summary(this.config.claimLeaseMs),
      this.repository.deadQueue(limit),
      this.repository.suppressed(limit),
    ]);

    return {
      summary: toSummaryWire(summary),
      dead: dead.map(toDeadWire),
      suppressed: suppressed.map(toSuppressedWire),
    };
  }

  async summary(): Promise<OutboxSummaryWire> {
    return toSummaryWire(await this.repository.summary(this.config.claimLeaseMs));
  }

  /** Every attempt at one message, in order. Plan 10.1: "what did we actually send them". */
  async attempts(notificationId: string): Promise<readonly NotificationAttemptWire[]> {
    const rows = await this.repository.attemptsFor(notificationId);
    return rows.map(toAttemptWire);
  }

  /**
   * Put a dead message back on the queue.
   *
   * Deliberately not a 404 when the row is not dead: `requeued: false` is the honest answer
   * to a second click, and an operator watching a colleague work the same queue should see
   * "already done" rather than "does not exist".
   */
  async retry(notificationId: string): Promise<RetryResultWire> {
    return { id: notificationId, requeued: await this.repository.requeue(notificationId) };
  }
}

function toSummaryWire(summary: {
  readonly pending: number;
  readonly sending: number;
  readonly sent: number;
  readonly dead: number;
  readonly suppressed: number;
  readonly stuckSending: number;
  readonly oldestPendingAt: string | null;
  readonly oldestDeadAt: string | null;
}): OutboxSummaryWire {
  return {
    pending: summary.pending,
    sending: summary.sending,
    sent: summary.sent,
    dead: summary.dead,
    suppressed: summary.suppressed,
    stuckSending: summary.stuckSending,
    oldestPendingAt: summary.oldestPendingAt,
    oldestDeadAt: summary.oldestDeadAt,
  };
}

function toDeadWire(row: {
  readonly id: string;
  readonly orderId: string;
  readonly orderNo: string | null;
  readonly eventId: string;
  readonly recipientKind: string;
  readonly recipientKey: string | null;
  readonly channel: string;
  readonly templateKey: string;
  readonly attemptCount: number;
  readonly lastError: string | null;
  readonly deadAt: string;
  readonly createdAt: string;
}): DeadNotificationWire {
  return {
    id: row.id,
    orderId: row.orderId,
    orderNo: row.orderNo,
    eventId: row.eventId,
    recipientKind: row.recipientKind,
    recipient: maskRecipientKey(row.recipientKey),
    channel: row.channel,
    templateKey: row.templateKey,
    attemptCount: row.attemptCount,
    lastError: row.lastError,
    deadAt: row.deadAt,
    createdAt: row.createdAt,
  };
}

function toSuppressedWire(row: {
  readonly id: string;
  readonly orderId: string;
  readonly orderNo: string | null;
  readonly recipientKind: string;
  readonly channel: string;
  readonly templateKey: string;
  readonly suppressedReason: string | null;
  readonly createdAt: string;
}): SuppressedNotificationWire {
  return {
    id: row.id,
    orderId: row.orderId,
    orderNo: row.orderNo,
    recipientKind: row.recipientKind,
    channel: row.channel,
    templateKey: row.templateKey,
    reason: row.suppressedReason,
    createdAt: row.createdAt,
  };
}

function toAttemptWire(row: Record<string, unknown>): NotificationAttemptWire {
  const string = (value: unknown): string | null => (typeof value === 'string' ? value : null);
  const timestamp = (value: unknown): string =>
    value instanceof Date ? value.toISOString() : (string(value) ?? '');

  return {
    attemptNo: typeof row['attempt_no'] === 'number' ? row['attempt_no'] : 0,
    outcome: string(row['outcome']) ?? 'unknown',
    channel: string(row['channel']) ?? 'unknown',
    recipient: maskRecipientKey(string(row['recipient_key'])),
    locale: string(row['locale']) ?? '',
    renderedSubject: string(row['rendered_subject']),
    providerMessageId: string(row['provider_message_id']),
    error: string(row['error']),
    attemptedAt: timestamp(row['attempted_at']),
  };
}
