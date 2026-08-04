import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_RECIPIENT_KINDS,
  NOTIFICATION_STATUSES,
} from '@wewin/db/schema';

/**
 * The outbox unions, derived from the arrays the schema exports.
 *
 * `packages/db` now exports the unions beside `OrderStatus`, where they belong, so this
 * file is a pass-through: one definition per closed set, and adding `'sms'` to
 * `NOTIFICATION_CHANNELS` in the schema makes every `switch` over a channel in this module
 * a compile error.
 *
 * It used to derive its own `(typeof ARRAY)[number]` copies, with a note saying they
 * belonged in the schema — correct, and the sort of note that outlives the reason for it.
 * The file is kept rather than deleted because the rest of the module imports its outbox
 * types from here, and a re-export costs nothing.
 */

/*
 * Re-exported, not re-derived. These three used to be `(typeof ARRAY)[number]` here, with a
 * note that they belonged beside `OrderStatus` in `packages/db` — they now are, so this is a
 * pass-through and there is one definition of each closed set again.
 */
export type {
  NotificationChannel,
  NotificationRecipientKind,
  NotificationStatus,
} from '@wewin/db/schema';

export { NOTIFICATION_CHANNELS, NOTIFICATION_RECIPIENT_KINDS, NOTIFICATION_STATUSES };

/**
 * `email:a@b.test` → `a@b.test`, `group:sales_queue` → `sales_queue`, anything else → undefined.
 *
 * One parser, because the recipient key is half of the idempotency constraint
 * (`notifications_idempotency_key`) and its shape is enforced by `notifications_recipient_key_shape`
 * in Postgres. Two places that split it on `:` are two places that can disagree about
 * an address containing one.
 */
export function parseRecipientKey(
  key: string,
): { readonly scheme: string; readonly value: string } | undefined {
  const separator = key.indexOf(':');
  if (separator <= 0 || separator === key.length - 1) return undefined;

  return { scheme: key.slice(0, separator), value: key.slice(separator + 1) };
}
