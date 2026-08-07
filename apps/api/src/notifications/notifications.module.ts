import { Module, type DynamicModule } from '@nestjs/common';

import type { NotificationChannelAdapter } from './channels/channel';
import { EmailChannelAdapter } from './channels/email.channel';
import { LineChannelAdapter } from './channels/line.channel';
import { createEmailTransport } from './channels/transports/create-transport';
import type { EmailTransport } from './channels/transports/email-transport';
import { NotificationWorker } from './notification-worker.service';
import { parseNotificationsConfig, type NotificationsConfig } from './notifications.config';
import { DocumentLinkService } from '../orders/document-link';
import { NotificationsController } from './notifications.controller';
import { NotificationsRepository } from './notifications.repository';
import { NotificationsService } from './notifications.service';
import { EMAIL_TRANSPORT, NOTIFICATIONS_CONFIG, NOTIFICATION_CHANNEL_ADAPTERS } from './notifications.tokens';

export interface NotificationsModuleOptions {
  /**
   * Omitted means this module parses `process.env` itself, exactly as `MediaModule` and
   * `OAuthModule` do — an SMTP password has no business in the frozen, logged `Env`.
   */
  readonly config?: NotificationsConfig;
  /**
   * ⭐ The application's one session graph, for the quotation link the worker puts in a
   * customer message.
   *
   * ⚠️ **Required, not optional, and that is the point.** `DocumentLinkService` derives its
   * signing key from `SESSION_CONFIG`; a graph assembled without this cannot resolve it and
   * fails at boot rather than sending every customer message with no link and saying nothing.
   * Typed as required so the mistake is a compile error, which is louder still.
   *
   * ⚠️ Passed in, never rebuilt. A second `SessionModule.forRoot(...)` derives a *different*
   * key, and a link this worker minted would then be refused by the route that reads it — in
   * the same process, with nothing in either log to explain it. See `auth.module.ts`.
   */
  readonly auth: DynamicModule;
}

/**
 * The outbox: its worker, its channels, and the queue a person reads.
 *
 * It imports nothing, on the same terms as `MediaModule`: `DatabaseModule` is `@Global` so
 * `DRIZZLE` is in scope, and `RbacModule` binds its guard over the whole graph — so the
 * controller here is enforced and audited whether or not this module knows either exists.
 *
 * Nothing is exported, and that is the load-bearing part rather than tidiness. Plan 10.1's
 * whole argument is that a transition handler must not be able to send a message: if this
 * module exported a service, the twenty call sites the plan is about would be one import
 * away, and the first "just send this one directly, it's urgent" would put them back. The
 * only way an order module can cause a notification is to append an `order_events` row —
 * which is what the fan-out trigger consumes, in the same transaction, whether the caller
 * wanted it or not.
 *
 * ── ⚠️ NOT WIRED IN, AND THAT IS NOT AN OVERSIGHT ────────────────────────────
 *
 * `src/app.module.ts` is outside this round's ownership, so `NotificationsModule.forRoot()`
 * is not in its imports list yet. Until it is, this module is compiled and tested but not
 * running. Two things must land together with that line, or the boot audit and the route
 * table will disagree with reality:
 *
 *   1. `AppModule.forRoot` gains `NotificationsModule.forRoot()`;
 *   2. `tests/admin/route-permissions.test.ts` gains the four routes below — that table
 *      asserts in *both* directions, so a new `/admin/*` route that it does not name fails
 *      it by design. This is the mechanism working, not the mechanism being in the way.
 *
 *        GET  /admin/notifications                       orders.read
 *        GET  /admin/notifications/summary               orders.read
 *        GET  /admin/notifications/:notificationId/attempts   orders.read
 *        POST /admin/notifications/:notificationId/retry orders.write
 */
@Module({})
export class NotificationsModule {
  /**
   * ⚠️ `auth` is the application's one session graph, passed in and never rebuilt.
   *
   * It is here for `DocumentLinkService`, which derives its signing key from `SESSION_CONFIG`
   * — and a second `SessionModule.forRoot(...)` would derive a *different* one, so a link this
   * worker put in an email would be refused by the route that reads it, in the same process,
   * with nothing in either log to say why. `auth.module.ts` makes the same argument at length.
   *
   * ⚠️ This module still does not import `OrdersModule`, and must not. It borrows one
   * stateless signer by class; it has no way to load, move or price an order.
   */
  static forRoot(options: NotificationsModuleOptions): DynamicModule {
    const auth = options.auth;
    const config = options.config ?? parseNotificationsConfig(process.env);

    return {
      module: NotificationsModule,
      imports: [auth],
      controllers: [NotificationsController],
      providers: [
        { provide: NOTIFICATIONS_CONFIG, useValue: config },
        DocumentLinkService,
        {
          provide: EMAIL_TRANSPORT,
          // One decision, in `create-transport.ts`, shared with `PasswordModule`.
          useFactory: (): EmailTransport => createEmailTransport(config),
        },
        EmailChannelAdapter,
        {
          /*
           * The list plan 10.1's last row is about, assembled once, in preference order.
           *
           * LINE first where it is configured, because plan 10.2 says Thai customers read
           * LINE and not email — and email always, because it is the guaranteed channel.
           * Today the order changes nothing: the worker matches an adapter by the row's
           * `channel`, and every seeded rule is an email rule. It is written in the intended
           * order anyway, so that the day a `line` rule is added the preference is already
           * expressed here rather than decided by whoever writes the rule.
           *
           * The LINE adapter is constructed only when a token exists. Absent, the worker
           * finds no adapter for a `line` row and fails it *permanently* with a message
           * naming the missing channel — which lands in the dead queue, visibly, instead of
           * retrying five times against a configuration that will not change.
           */
          provide: NOTIFICATION_CHANNEL_ADAPTERS,
          useFactory: (email: EmailChannelAdapter): readonly NotificationChannelAdapter[] =>
            config.line.accessToken === undefined ? [email] : [new LineChannelAdapter(config), email],
          inject: [EmailChannelAdapter],
        },
        NotificationsRepository,
        NotificationsService,
        NotificationWorker,
      ],
    };
  }
}
