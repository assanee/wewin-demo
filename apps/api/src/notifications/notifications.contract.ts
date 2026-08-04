import { z } from 'zod';

import { NOTIFICATION_CHANNELS, NOTIFICATION_RECIPIENT_KINDS, NOTIFICATION_STATUSES } from './notifications.types';

/**
 * What the dead-letter queue looks like on the wire.
 *
 * Declared here rather than in `@wewin/contract` for the same reason `media.contract.ts`
 * is: that package is shared with `apps/web` and `apps/dashboard` and is not this round's
 * to change. These shapes move there when somebody builds the screen — and the move is a
 * copy, because nothing here depends on where the type is declared.
 *
 * ── The recipient key is redacted, and that is not paranoia ──────────────────
 *
 * `recipient_key` is `email:somebody@example.com` — a customer's address, in a list an
 * operator can read, in a response that will end up in a browser cache and possibly a
 * screenshot in a chat. Plan 7.6 makes the same distinction for payment slips ("separate
 * *viewing* from *downloading*") and the reasoning carries: deciding whether to retry a
 * failed message needs to know *which kind of address failed*, not what it was. So the list
 * shows `email:s•••@example.com`, the order id is right there for anyone who genuinely needs
 * the real address, and PDPA's data-minimisation is satisfied by default rather than by a
 * later decision to add masking.
 */

export const notificationStatusSchema = z.enum(NOTIFICATION_STATUSES);
export const notificationChannelSchema = z.enum(NOTIFICATION_CHANNELS);
export const notificationRecipientKindSchema = z.enum(NOTIFICATION_RECIPIENT_KINDS);

export const deadQueueQuerySchema = z.object({
  /* A queue, not an archive: fifty is a screen, and anything past it is a report. */
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export type DeadQueueQuery = z.infer<typeof deadQueueQuerySchema>;

export interface DeadNotificationWire {
  readonly id: string;
  readonly orderId: string;
  readonly orderNo: string | null;
  readonly eventId: string;
  readonly recipientKind: string;
  /** Masked — see the note above. */
  readonly recipient: string | null;
  readonly channel: string;
  readonly templateKey: string;
  readonly attemptCount: number;
  readonly lastError: string | null;
  readonly deadAt: string;
  readonly createdAt: string;
}

export interface SuppressedNotificationWire {
  readonly id: string;
  readonly orderId: string;
  readonly orderNo: string | null;
  readonly recipientKind: string;
  readonly channel: string;
  readonly templateKey: string;
  readonly reason: string | null;
  readonly createdAt: string;
}

export interface NotificationAttemptWire {
  readonly attemptNo: number;
  readonly outcome: string;
  readonly channel: string;
  readonly recipient: string | null;
  readonly locale: string;
  readonly renderedSubject: string | null;
  readonly providerMessageId: string | null;
  readonly error: string | null;
  readonly attemptedAt: string;
}

export interface OutboxSummaryWire {
  readonly pending: number;
  readonly sending: number;
  readonly sent: number;
  readonly dead: number;
  readonly suppressed: number;
  readonly stuckSending: number;
  readonly oldestPendingAt: string | null;
  readonly oldestDeadAt: string | null;
}

export interface DeadQueueWire {
  readonly summary: OutboxSummaryWire;
  readonly dead: readonly DeadNotificationWire[];
  readonly suppressed: readonly SuppressedNotificationWire[];
}

export interface RetryResultWire {
  readonly id: string;
  /** False when the row was not dead — somebody else already requeued it. */
  readonly requeued: boolean;
}

/**
 * `email:somebody@example.com` → `email:s•••@example.com`; `group:sales_queue` is left alone.
 *
 * A group is an internal work queue and masking it would hide the only useful fact in the
 * row. A customer address keeps its first character and its domain, which is enough to
 * recognise "the address is a typo" — the commonest reason a message is in this list — and
 * not enough to be a copy of the address book.
 */
export function maskRecipientKey(key: string | null): string | null {
  if (key === null) return null;

  const separator = key.indexOf(':');
  if (separator <= 0) return key;

  const scheme = key.slice(0, separator);
  const value = key.slice(separator + 1);
  if (scheme !== 'email') return key;

  const at = value.lastIndexOf('@');
  if (at <= 0) return `${scheme}:•••`;

  const local = value.slice(0, at);
  const domain = value.slice(at);
  return `${scheme}:${local.slice(0, 1)}•••${domain}`;
}
