import type { NotificationsConfig } from '../../notifications.config';
import type { EmailTransport } from './email-transport';
import { FileEmailTransport } from './file.transport';
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
  config: Pick<NotificationsConfig, 'emailTransport' | 'emailDir' | 'smtp'>,
): EmailTransport {
  return config.emailTransport === 'smtp'
    ? new SmtpEmailTransport(config.smtp)
    : new FileEmailTransport(config.emailDir);
}
