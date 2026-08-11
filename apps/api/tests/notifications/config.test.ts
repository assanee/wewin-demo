import { NOTIFICATION_MAX_ATTEMPTS_DEFAULT } from '@wewin/db/schema';
import { describe, expect, it } from 'vitest';

import {
  NotificationsConfigError,
  parseNotificationsConfig,
} from '../../src/notifications/notifications.config';

/**
 * Configuration, and the four things it must refuse.
 *
 * Every assertion here is about a value that is *plausible* and wrong — the class of
 * mistake that boots successfully and is discovered by a customer. A missing variable is
 * caught by anybody; `NOTIFICATIONS_EMAIL_TRANSPORT=file` in production is caught by nobody,
 * because it works: messages are marked `sent`, attempts are recorded, the dead queue is
 * empty, and the mail is in a directory on a container that will be replaced tonight.
 */

describe('notification configuration', () => {
  it('takes plan 13’s retry count from packages/db rather than restating it', () => {
    const config = parseNotificationsConfig({});

    // ⚠️ Five is a plan 13 *default*, not a decision, and it is written down once — in
    // `packages/db/src/schema/order.ts` beside the coalescing window that shares its row in
    // the plan. A literal `5` here would be a second copy that drifts the day somebody
    // answers the question.
    expect(config.maxAttempts).toBe(NOTIFICATION_MAX_ATTEMPTS_DEFAULT);
  });

  it('turns the worker off under the test runner and on everywhere else', () => {
    // `bootApp()` builds the real module list with NODE_ENV=test, so a poller that defaulted
    // to on would race every suite in this directory against a shared database.
    expect(parseNotificationsConfig({ NODE_ENV: 'test' }).workerEnabled).toBe(false);
    expect(parseNotificationsConfig({ NODE_ENV: 'development' }).workerEnabled).toBe(true);

    // An explicit value still wins in both directions — this module's own suite turns it on.
    expect(parseNotificationsConfig({ NODE_ENV: 'test', NOTIFICATIONS_WORKER_ENABLED: 'true' }).workerEnabled).toBe(
      true,
    );
    expect(
      parseNotificationsConfig({ NODE_ENV: 'development', NOTIFICATIONS_WORKER_ENABLED: 'false' }).workerEnabled,
    ).toBe(false);
  });

  it('gives the work queues a local mailbox outside production, and none inside it', () => {
    // Local development has to deliver `group:sales_queue` somewhere or every staff-facing
    // rule dead-letters on a fresh checkout. Production must not inherit that: the address
    // would be a domain nobody owns, and unlike a wrong customer address nobody complains,
    // because the person who would complain is the one who never got the message.
    expect(parseNotificationsConfig({}).queueAddresses.sales_queue).toBe('sales-queue@wewin.local');

    const problems = refusal({
      NODE_ENV: 'production',
      NOTIFICATIONS_EMAIL_TRANSPORT: 'smtp',
    });
    expect(problems.join('\n')).toContain('NOTIFICATIONS_SALES_QUEUE_EMAIL is required in production');
  });

  it('refuses the file transport in production', () => {
    // It reports success for every message and sends none of them, which is the single most
    // dangerous state this feature can be in: the dead queue stays empty and the company
    // believes every customer was told.
    const problems = refusal({
      NODE_ENV: 'production',
      NOTIFICATIONS_SALES_QUEUE_EMAIL: 'sales@example.com',
      NOTIFICATIONS_EMAIL_TRANSPORT: 'file',
    });

    expect(problems.join('\n')).toContain('writes messages to a directory instead of sending them');
  });

  it('refuses an SMTP password on a plaintext socket in production', () => {
    const problems = refusal({
      NODE_ENV: 'production',
      NOTIFICATIONS_SALES_QUEUE_EMAIL: 'sales@example.com',
      NOTIFICATIONS_EMAIL_TRANSPORT: 'smtp',
      NOTIFICATIONS_SMTP_USER: 'wewin',
      NOTIFICATIONS_SMTP_PASSWORD: 'not-a-real-password',
      NOTIFICATIONS_SMTP_SECURE: 'false',
    });

    expect(problems.join('\n')).toContain('would send the password in the clear');
  });

  it('refuses a retry ceiling below the base delay', () => {
    // Silly-looking, and it is the shape of a real edit: somebody lowers the ceiling to make
    // retries quicker and leaves the base where it was. The result is a "ceiling" below every
    // delay it is meant to cap, which reads as working.
    const problems = refusal({ NOTIFICATIONS_RETRY_BASE_MS: '600000', NOTIFICATIONS_RETRY_MAX_MS: '1000' });
    expect(problems.join('\n')).toContain('NOTIFICATIONS_RETRY_MAX_MS must not be smaller');
  });

  it('defaults to the file transport — a developer with no Resend account still boots', () => {
    expect(parseNotificationsConfig({}).emailTransport).toBe('file');
    expect(parseNotificationsConfig({}).resendApiKey).toBeUndefined();
  });

  it('refuses NOTIFICATIONS_EMAIL_TRANSPORT=resend without RESEND_API_KEY, in every environment', () => {
    // Not gated on production: a boot with no Resend account is exactly the case `file`'s
    // default protects, and the mistake is just as real on a laptop.
    const dev = refusal({ NOTIFICATIONS_EMAIL_TRANSPORT: 'resend' });
    expect(dev.join('\n')).toContain('NOTIFICATIONS_EMAIL_TRANSPORT=resend requires RESEND_API_KEY');

    const prod = refusal({
      NODE_ENV: 'production',
      NOTIFICATIONS_SALES_QUEUE_EMAIL: 'sales@example.com',
      NOTIFICATIONS_EMAIL_TRANSPORT: 'resend',
    });
    expect(prod.join('\n')).toContain('NOTIFICATIONS_EMAIL_TRANSPORT=resend requires RESEND_API_KEY');
  });

  it('accepts resend once a key is present', () => {
    const config = parseNotificationsConfig({
      NOTIFICATIONS_EMAIL_TRANSPORT: 'resend',
      RESEND_API_KEY: 're_' + 'x'.repeat(33),
    });
    expect(config.emailTransport).toBe('resend');
    expect(config.resendApiKey).toBe('re_' + 'x'.repeat(33));
  });

  it('does not construct a LINE adapter without a token', () => {
    // Plan 13's channel question is unanswered and there are no credentials here, so the
    // absence has to be the default rather than something a deployment opts out of.
    expect(parseNotificationsConfig({}).line.accessToken).toBeUndefined();
    expect(parseNotificationsConfig({ NOTIFICATIONS_LINE_CHANNEL_ACCESS_TOKEN: 'x' }).line.accessToken).toBe('x');
  });
});

function refusal(source: Record<string, string | undefined>): readonly string[] {
  try {
    parseNotificationsConfig(source);
  } catch (error) {
    if (error instanceof NotificationsConfigError) return error.problems;
    throw error;
  }
  throw new Error('expected the configuration to be refused, and it was accepted');
}
