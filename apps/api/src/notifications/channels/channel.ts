import type { NotificationChannel } from '../notifications.types';

/**
 * The seam plan 10.1's last row is about: "adding LINE = one adapter, not twenty call sites".
 *
 * An adapter knows how to turn one rendered message into one delivery on one channel, and
 * knows nothing about orders, retries, the outbox or why it is being asked. Everything that
 * decides *whether* to send, *when*, and *what happens next* lives in the worker, so a
 * second channel cannot accidentally grow its own retry policy or its own idea of what
 * `dead` means.
 *
 * ── The one interesting decision: failures are classified, not just reported ──
 *
 * `retryable: false` is the difference between a queue that is honest and a queue that
 * looks busy. A mailbox that does not exist will not start existing on the fifth attempt,
 * and burning four more attempts on it delays the moment a human sees it in the dead queue
 * by a quarter of an hour — during which the company believes the customer was told, which
 * is plan 10.5(3) exactly. So a permanent failure goes to `dead` on the first attempt, with
 * the provider's own words attached.
 *
 * When in doubt an adapter says `retryable: true`. Retrying something permanent wastes four
 * attempts; giving up on something transient loses the message.
 */

export interface RenderedMessage {
  /** `email:a@b.test`, `group:sales_queue`, `line:U…` — exactly as it is stored on the row. */
  readonly recipientKey: string;
  readonly subject: string;
  readonly body: string;
  /** What the body was actually rendered in. Recorded on the attempt — see locale.ts. */
  readonly locale: string;
  /** For headers a mail client threads on, and for a provider's own idempotency key. */
  readonly notificationId: string;
  readonly orderId: string;
  readonly eventId: string;
}

export interface DeliverySuccess {
  readonly ok: true;
  /** The provider's id for this message, when it gives one. The audit trail's other half. */
  readonly providerMessageId?: string;
}

export interface DeliveryFailure {
  readonly ok: false;
  /** One line, for `notifications.last_error` and the dead queue. Never a stack trace. */
  readonly error: string;
  /** False means "this will fail the same way forever" — go straight to `dead`. */
  readonly retryable: boolean;
}

export type DeliveryResult = DeliverySuccess | DeliveryFailure;

export interface NotificationChannelAdapter {
  readonly channel: NotificationChannel;
  /**
   * Can this adapter address that recipient key at all?
   *
   * Separate from `send` so the worker can tell "no adapter for this channel" (a
   * deployment fact, and a permanent failure) apart from "the adapter tried and the
   * network was down" (a transient one). A `send` that returned a failure for both would
   * make a missing LINE token look like an outage for five attempts.
   */
  supports(recipientKey: string): boolean;
  send(message: RenderedMessage): Promise<DeliveryResult>;
}

/** Convenience for adapters, so the two failure shapes are constructed the same way everywhere. */
export function permanentFailure(error: string): DeliveryFailure {
  return { ok: false, error, retryable: false };
}

export function transientFailure(error: string): DeliveryFailure {
  return { ok: false, error, retryable: true };
}

/**
 * A short, safe description of a thrown value.
 *
 * `last_error` is read on a dashboard and stored forever; a stack trace there is both
 * useless to the person reading it and a copy of internal paths in a table with a
 * different retention policy. The message and the code (`ECONNREFUSED`, `ETIMEDOUT`) are
 * the parts that decide what somebody does next.
 */
export function describeThrown(error: unknown): string {
  if (!(error instanceof Error)) return String(error) || 'unknown error';

  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  const message = error.message.trim();

  if (message && code) return `${code}: ${message}`;
  return message || code || error.name || 'unknown error';
}
