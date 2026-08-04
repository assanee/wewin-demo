import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { DRIZZLE } from '../../src/database/database.tokens';
import type { NotificationChannelAdapter } from '../../src/notifications/channels/channel';
import { EmailChannelAdapter } from '../../src/notifications/channels/email.channel';
import { LineChannelAdapter } from '../../src/notifications/channels/line.channel';
import { FileEmailTransport } from '../../src/notifications/channels/transports/file.transport';
import { SmtpEmailTransport } from '../../src/notifications/channels/transports/smtp.transport';
import { NotificationWorker } from '../../src/notifications/notification-worker.service';
import { parseNotificationsConfig } from '../../src/notifications/notifications.config';
import { NotificationsController } from '../../src/notifications/notifications.controller';
import { NotificationsModule } from '../../src/notifications/notifications.module';
import { EMAIL_TRANSPORT, NOTIFICATION_CHANNEL_ADAPTERS } from '../../src/notifications/notifications.tokens';

/**
 * The graph builds, before anybody wires it into `app.module.ts`.
 *
 * This module is finished and not connected — `src/app.module.ts` is outside this round's
 * ownership — which means the usual proof that a module is constructible (the app boots)
 * is not available. A DI mistake would therefore be discovered by whoever adds the import
 * line, in a failure that looks like *their* change broke the boot. So the container is
 * built here, with the same `forRoot` the app will call.
 *
 * `DatabaseModule` is `@Global` in the real graph, which is why `NotificationsModule`
 * imports nothing; the stub below plays that part so the shape under test is the shape that
 * ships rather than a version with an extra import added to make a test work.
 */

@Global()
@Module({ providers: [{ provide: DRIZZLE, useValue: {} }], exports: [DRIZZLE] })
class StubDatabaseModule {}

const build = (config: Parameters<typeof NotificationsModule.forRoot>[0]) =>
  Test.createTestingModule({ imports: [StubDatabaseModule, NotificationsModule.forRoot(config)] }).compile();

let close: (() => Promise<void>) | undefined;

afterEach(async () => {
  await close?.();
  close = undefined;
});

describe('NotificationsModule', () => {
  it('resolves the worker, the controller and the email adapter', async () => {
    const moduleRef = await build({ config: parseNotificationsConfig({ NODE_ENV: 'test' }) });
    close = () => moduleRef.close();

    expect(moduleRef.get(NotificationWorker)).toBeInstanceOf(NotificationWorker);
    expect(moduleRef.get(NotificationsController)).toBeInstanceOf(NotificationsController);
    expect(moduleRef.get(EmailChannelAdapter)).toBeInstanceOf(EmailChannelAdapter);
  });

  it('picks the transport from configuration', async () => {
    const file = await build({ config: parseNotificationsConfig({ NODE_ENV: 'test' }) });
    expect(file.get(EMAIL_TRANSPORT)).toBeInstanceOf(FileEmailTransport);
    await file.close();

    const smtp = await build({
      config: parseNotificationsConfig({ NODE_ENV: 'test', NOTIFICATIONS_EMAIL_TRANSPORT: 'smtp' }),
    });
    close = () => smtp.close();
    expect(smtp.get(EMAIL_TRANSPORT)).toBeInstanceOf(SmtpEmailTransport);
  });

  it('registers LINE only when there is a token, and puts it in front of email', async () => {
    const withoutToken = await build({ config: parseNotificationsConfig({ NODE_ENV: 'test' }) });
    const emailOnly = withoutToken.get<readonly NotificationChannelAdapter[]>(NOTIFICATION_CHANNEL_ADAPTERS);

    // Plan 13's channel question is unanswered and there are no credentials here, so the
    // absence is the default rather than something a deployment opts out of.
    expect(emailOnly.map((adapter) => adapter.channel)).toStrictEqual(['email']);
    await withoutToken.close();

    const withToken = await build({
      config: parseNotificationsConfig({ NODE_ENV: 'test', NOTIFICATIONS_LINE_CHANNEL_ACCESS_TOKEN: 'token' }),
    });
    close = () => withToken.close();
    const both = withToken.get<readonly NotificationChannelAdapter[]>(NOTIFICATION_CHANNEL_ADAPTERS);

    // Plan 10.2's preference as an order: LINE where it exists, email always. It changes
    // nothing today — every seeded rule is an email rule — and it is expressed here so the
    // day a `line` rule is added the preference is already decided.
    expect(both.map((adapter) => adapter.channel)).toStrictEqual(['line', 'email']);
    expect(both[0]).toBeInstanceOf(LineChannelAdapter);
  });

  it('exports nothing, so a transition handler cannot reach in and send', async () => {
    const moduleRef = await build({ config: parseNotificationsConfig({ NODE_ENV: 'test' }) });
    close = () => moduleRef.close();

    /*
     * Plan 10.1's whole argument is that a transition handler must have no way to send a
     * message directly. An exported service would put those twenty call sites one import
     * away, and the first "just send this one directly, it's urgent" would put them back.
     * An order module causes a notification by appending an `order_events` row and in no
     * other way.
     */
    const dynamic = NotificationsModule.forRoot({ config: parseNotificationsConfig({ NODE_ENV: 'test' }) });
    expect(dynamic.exports ?? []).toStrictEqual([]);
  });
});
