import type { NotificationsConfig } from '../../notifications.config';
import type { EmailTransport } from './email-transport';
import { FileEmailTransport } from './file.transport';
import { ResendEmailTransport } from './resend.transport';
import { SmtpEmailTransport } from './smtp.transport';

/**
 * Which transport a configuration means.
 *
 * Extracted so `NotificationsModule` and `PasswordModule` cannot disagree about it, and in
 * its own file so `email-transport.ts` — which the two concrete transports import — does not
 * have to import them back.
 *
 * ⚠️ The two modules hold **separate instances** on purpose. Sharing one would mean
 * `PasswordModule` importing `NotificationsModule`, which brings `NotificationWorker` with it
 * and starts a second poller against the same outbox — a much worse problem than two objects
 * that each know how to open a socket. A transport is stateless either way:
 * `FileEmailTransport` writes a file per message, `SmtpEmailTransport` opens a connection
 * per send.
 */
export function createEmailTransport(
  config: Pick<NotificationsConfig, 'emailTransport' | 'emailDir' | 'smtp' | 'resendApiKey'>,
): EmailTransport {
  if (config.emailTransport === 'resend') {
    /*
     * `parseNotificationsConfig` refuses `NOTIFICATIONS_EMAIL_TRANSPORT=resend` without
     * `RESEND_API_KEY` at boot (see notifications.config.ts), so this branch only fires for
     * a `NotificationsConfig` assembled by hand — a test, most plausibly — that skipped
     * that check. Failing loudly here rather than handing `ResendEmailTransport` an
     * `undefined` key is the same trade `PasswordModule` makes for `SESSION_CONFIG`.
     */
    if (config.resendApiKey === undefined) {
      throw new Error('createEmailTransport: NOTIFICATIONS_EMAIL_TRANSPORT is "resend" but RESEND_API_KEY is not set');
    }
    return new ResendEmailTransport(config.resendApiKey);
  }

  return config.emailTransport === 'smtp'
    ? new SmtpEmailTransport(config.smtp)
    : new FileEmailTransport(config.emailDir);
}
