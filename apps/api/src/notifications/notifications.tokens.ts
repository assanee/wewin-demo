/**
 * Injection tokens for the outbox.
 *
 * Symbols rather than classes for the two things that are *configuration* and not code:
 * the parsed environment, and the set of channel adapters this process was built with.
 * The second one is the whole point of plan 10.1's last row — "adding LINE is one
 * adapter" is only true if the worker depends on a list it is handed, not on a `switch`
 * over channel names that it owns.
 */

/** The parsed `NotificationsConfig`. See notifications.config.ts. */
export const NOTIFICATIONS_CONFIG = Symbol('wewin.notifications.config');

/**
 * `readonly NotificationChannelAdapter[]`, in preference order.
 *
 * Order matters and is plan 10.2's decision as data: LINE first where it exists, email
 * always. Today the list holds email alone on most deployments, because plan 13's channel
 * question is unanswered and there are no LINE credentials here.
 */
export const NOTIFICATION_CHANNEL_ADAPTERS = Symbol('wewin.notifications.channelAdapters');

/** The `EmailTransport` the email adapter sends through — a file drop or SMTP. */
export const EMAIL_TRANSPORT = Symbol('wewin.notifications.emailTransport');
