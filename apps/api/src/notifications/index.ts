/**
 * What the rest of the app may import from the outbox — which is deliberately almost nothing.
 *
 * `NotificationsModule` and its options, for `app.module.ts`. Not the service, not the
 * repository, not the worker: plan 10.1's argument is that a transition handler must have no
 * way to send a message, and an export list is where that stops being true. An order module
 * causes a notification by appending an `order_events` row, and the fan-out trigger does the
 * rest inside the same transaction.
 *
 * The configuration parser and its error are exported because `main.ts` may want to fail
 * fast on a bad SMTP configuration at boot rather than at the first send — the same reason
 * `parseOAuthConfig` and `parseMediaConfig` are reachable.
 */

export { NotificationsModule, type NotificationsModuleOptions } from './notifications.module';
export {
  NotificationsConfigError,
  parseNotificationsConfig,
  type NotificationsConfig,
} from './notifications.config';
