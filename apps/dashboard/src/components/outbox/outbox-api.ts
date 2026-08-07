import 'client-only';

import { apiFetch, apiJson } from '@/lib/api/client';
import { apiErrorFromResponse } from '@/lib/api/errors';

/**
 * Every call the outbox screen makes.
 *
 * ⚠️ Shapes restated from `apps/api/src/notifications/notifications.contract.ts`. Same
 * boundary debt, plan 12.1.
 *
 * ⚠️ These endpoints borrow `orders.read` and `orders.write`. There is no `notifications.*`
 * permission and there should be — `notifications.controller.ts` records the borrow, and the
 * honest split it names is `notifications.read` / `notifications.retry`, because re-sending a
 * message to a customer is a customer-facing act and the set of people who should be able to
 * take it is not obviously the set who may edit an order.
 */

export interface Summary {
  readonly pending: number;
  readonly sending: number;
  readonly sent: number;
  readonly dead: number;
  readonly suppressed: number;
  /** Claimed by a worker that never finished. A number above zero here means somebody died mid-send. */
  readonly stuckSending: number;
  readonly oldestPendingAt: string | null;
  readonly oldestDeadAt: string | null;
}

export interface DeadMessage {
  readonly id: string;
  readonly orderId: string;
  readonly orderNo: string | null;
  readonly recipientKind: string;
  readonly recipient: string | null;
  readonly channel: string;
  readonly templateKey: string;
  readonly attemptCount: number;
  readonly lastError: string | null;
  readonly deadAt: string;
}

export interface SuppressedMessage {
  readonly id: string;
  readonly orderId: string;
  readonly orderNo: string | null;
  readonly recipientKind: string;
  readonly channel: string;
  readonly templateKey: string;
  readonly reason: string | null;
  readonly createdAt: string;
}

export interface Attempt {
  readonly attemptNo: number;
  readonly outcome: string;
  readonly channel: string;
  readonly recipient: string | null;
  readonly locale: string;
  readonly renderedSubject: string | null;
  readonly error: string | null;
  readonly attemptedAt: string;
}

const asRecord = (value: unknown, what: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${what}: expected an object`);
  }
  return value as Record<string, unknown>;
};

const asArray = (value: unknown, what: string): readonly unknown[] => {
  if (!Array.isArray(value)) throw new TypeError(`${what}: expected an array`);
  return value;
};

const asText = (value: unknown, what: string): string => {
  if (typeof value !== 'string') throw new TypeError(`${what}: expected a string`);
  return value;
};

const asTextOrNull = (value: unknown, what: string): string | null =>
  value === null || value === undefined ? null : asText(value, what);

const asCount = (value: unknown, what: string): number => {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new TypeError(`${what}: expected a whole count, got ${JSON.stringify(value)}`);
  }
  return value;
};

export interface Outbox {
  readonly summary: Summary;
  readonly dead: readonly DeadMessage[];
  readonly suppressed: readonly SuppressedMessage[];
}

export const getOutbox = (): Promise<Outbox> =>
  apiJson('/admin/notifications', (body) => {
    const outbox = asRecord(body, 'คิวแจ้งเตือน');
    const summary = asRecord(outbox['summary'], 'summary');

    return {
      summary: {
        pending: asCount(summary['pending'], 'summary.pending'),
        sending: asCount(summary['sending'], 'summary.sending'),
        sent: asCount(summary['sent'], 'summary.sent'),
        dead: asCount(summary['dead'], 'summary.dead'),
        suppressed: asCount(summary['suppressed'], 'summary.suppressed'),
        stuckSending: asCount(summary['stuckSending'], 'summary.stuckSending'),
        oldestPendingAt: asTextOrNull(summary['oldestPendingAt'], 'summary.oldestPendingAt'),
        oldestDeadAt: asTextOrNull(summary['oldestDeadAt'], 'summary.oldestDeadAt'),
      },
      dead: asArray(outbox['dead'] ?? [], 'dead').map((raw) => {
        const message = asRecord(raw, 'dead');
        return {
          id: asText(message['id'], 'dead.id'),
          orderId: asText(message['orderId'], 'dead.orderId'),
          orderNo: asTextOrNull(message['orderNo'], 'dead.orderNo'),
          recipientKind: asText(message['recipientKind'], 'dead.recipientKind'),
          recipient: asTextOrNull(message['recipient'], 'dead.recipient'),
          channel: asText(message['channel'], 'dead.channel'),
          templateKey: asText(message['templateKey'], 'dead.templateKey'),
          attemptCount: asCount(message['attemptCount'], 'dead.attemptCount'),
          lastError: asTextOrNull(message['lastError'], 'dead.lastError'),
          deadAt: asText(message['deadAt'], 'dead.deadAt'),
        };
      }),
      suppressed: asArray(outbox['suppressed'] ?? [], 'suppressed').map((raw) => {
        const message = asRecord(raw, 'suppressed');
        return {
          id: asText(message['id'], 'suppressed.id'),
          orderId: asText(message['orderId'], 'suppressed.orderId'),
          orderNo: asTextOrNull(message['orderNo'], 'suppressed.orderNo'),
          recipientKind: asText(message['recipientKind'], 'suppressed.recipientKind'),
          channel: asText(message['channel'], 'suppressed.channel'),
          templateKey: asText(message['templateKey'], 'suppressed.templateKey'),
          reason: asTextOrNull(message['reason'], 'suppressed.reason'),
          createdAt: asText(message['createdAt'], 'suppressed.createdAt'),
        };
      }),
    };
  });

export const listAttempts = (notificationId: string): Promise<readonly Attempt[]> =>
  apiJson(`/admin/notifications/${notificationId}/attempts`, (body) =>
    asArray(asRecord(body, 'ประวัติการส่ง')['attempts'] ?? [], 'attempts').map((raw) => {
      const attempt = asRecord(raw, 'attempt');
      return {
        attemptNo: asCount(attempt['attemptNo'], 'attempt.attemptNo'),
        outcome: asText(attempt['outcome'], 'attempt.outcome'),
        channel: asText(attempt['channel'], 'attempt.channel'),
        recipient: asTextOrNull(attempt['recipient'], 'attempt.recipient'),
        locale: asText(attempt['locale'], 'attempt.locale'),
        renderedSubject: asTextOrNull(attempt['renderedSubject'], 'attempt.renderedSubject'),
        error: asTextOrNull(attempt['error'], 'attempt.error'),
        attemptedAt: asText(attempt['attemptedAt'], 'attempt.attemptedAt'),
      };
    }),
  );

/** Put a dead message back on the queue. Only `dead` — see the screen for why. */
export const retry = async (notificationId: string): Promise<void> => {
  const response = await apiFetch(`/admin/notifications/${notificationId}/retry`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });

  if (!response.ok) throw await apiErrorFromResponse(response);
};
