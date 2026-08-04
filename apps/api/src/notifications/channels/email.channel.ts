import { Inject, Injectable } from '@nestjs/common';

import type { NotificationsConfig } from '../notifications.config';
import { EMAIL_TRANSPORT, NOTIFICATIONS_CONFIG } from '../notifications.tokens';
import { parseRecipientKey, type NotificationChannel } from '../notifications.types';
import {
  describeThrown,
  permanentFailure,
  transientFailure,
  type DeliveryResult,
  type NotificationChannelAdapter,
  type RenderedMessage,
} from './channel';
import { PermanentTransportError, type EmailTransport } from './transports/email-transport';

/**
 * Email — the channel plan 10.2 calls the guaranteed one.
 *
 * "Guaranteed" is a design constraint and not a compliment: LINE is what Thai customers
 * actually read, and it costs money per push and requires the customer to have added the
 * account as a friend, so it can never be the only way a message arrives. Every rule seeded
 * in `notification_rules` is therefore an email rule, and this adapter is the one that has
 * to work.
 *
 * ── Two recipient shapes, and why the second one can fail permanently ────────
 *
 * `email:someone@example.com` — a customer. The address came from `user_emails` (proved by
 *   the auth flow) or from `orders.contact_email` (given at submit, and CHECK-constrained
 *   into shape by Postgres), so it is not re-validated here; a second, weaker regex in front
 *   of a stronger one is a way to reject addresses the database accepted.
 *
 * `group:sales_queue` — a work queue. The fan-out cannot know which mailbox that is, because
 *   it is a deployment fact rather than an order fact, so it is resolved here from
 *   configuration. **An unconfigured queue is a permanent failure**, on purpose: it goes
 *   straight to the dead queue naming the variable that is missing, rather than retrying
 *   five times against a fact that will not change. Plan 10.5(3) is the reasoning — the
 *   failure mode to avoid is not "the message did not arrive", it is "the company believes
 *   somebody was told".
 */
@Injectable()
export class EmailChannelAdapter implements NotificationChannelAdapter {
  readonly channel: NotificationChannel = 'email';

  constructor(
    @Inject(NOTIFICATIONS_CONFIG) private readonly config: NotificationsConfig,
    @Inject(EMAIL_TRANSPORT) private readonly transport: EmailTransport,
  ) {}

  supports(recipientKey: string): boolean {
    const parsed = parseRecipientKey(recipientKey);
    return parsed?.scheme === 'email' || parsed?.scheme === 'group';
  }

  async send(message: RenderedMessage): Promise<DeliveryResult> {
    const address = this.addressOf(message.recipientKey);
    if (typeof address !== 'string') return address;

    try {
      const providerMessageId = await this.transport.send({
        from: this.config.emailFrom,
        to: address,
        subject: message.subject,
        body: message.body,
        messageId: message.notificationId,
        /*
         * Diagnostics that survive into the mailbox. During a dispute the question is "is
         * this email the one your system says it sent", and answering it from the headers
         * of the message the customer forwarded beats answering it from a timestamp.
         */
        headers: {
          'X-Wewin-Order': message.orderId,
          'X-Wewin-Event': message.eventId,
          'X-Wewin-Notification': message.notificationId,
          'Content-Language': message.locale,
          /* A notice, never a conversation. Replies go to a human inbox, not to the worker. */
          'Auto-Submitted': 'auto-generated',
        },
      });

      return providerMessageId === undefined ? { ok: true } : { ok: true, providerMessageId };
    } catch (error) {
      /*
       * The only classification in this file, and it defers to the transport: a transport
       * says "permanent" when the server rejected *this message* (SMTP 5xx). Anything else
       * — a refused socket, a timeout, a DNS failure — is the mail server having a bad
       * afternoon, and the outbox exists so that a bad afternoon does not lose a message.
       */
      const description = `${this.transport.name}: ${describeThrown(error)}`;
      return error instanceof PermanentTransportError ? permanentFailure(description) : transientFailure(description);
    }
  }

  /** The address, or the failure that explains why there is not one. */
  private addressOf(recipientKey: string): string | DeliveryResult {
    const parsed = parseRecipientKey(recipientKey);

    if (parsed === undefined) {
      return permanentFailure(`recipient key ${recipientKey} is not addressable by email`);
    }

    if (parsed.scheme === 'email') return parsed.value;

    if (parsed.scheme === 'group') {
      if (parsed.value === 'sales_queue' || parsed.value === 'approver_queue') {
        const configured = this.config.queueAddresses[parsed.value];
        if (configured !== undefined) return configured;

        return permanentFailure(
          `no mailbox is configured for ${recipientKey}: set NOTIFICATIONS_${parsed.value.toUpperCase()}_EMAIL`,
        );
      }
      return permanentFailure(`unknown recipient group ${parsed.value}`);
    }

    return permanentFailure(`recipient key scheme ${parsed.scheme} is not an email address`);
  }
}
