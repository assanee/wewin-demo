import type { NotificationsConfig } from '../notifications.config';
import { parseRecipientKey, type NotificationChannel } from '../notifications.types';
import {
  describeThrown,
  permanentFailure,
  transientFailure,
  type DeliveryResult,
  type NotificationChannelAdapter,
  type RenderedMessage,
} from './channel';

/**
 * LINE — the channel Thai customers actually read, and the one nothing here can prove.
 *
 * ── ⚠️ WHAT IS UNVERIFIED, PLAINLY ───────────────────────────────────────────
 *
 * There are no LINE credentials in this repository and no sandbox to point at. What is
 * tested (`tests/notifications/line.test.ts`) is the *request this adapter builds* and how
 * it classifies each answer, against an injected `fetch`. What is **not** tested, and must
 * be smoke-tested by whoever first sets `NOTIFICATIONS_LINE_CHANNEL_ACCESS_TOKEN`:
 *
 *   - that the push endpoint and body shape still match LINE's current Messaging API;
 *   - that a `userId` obtained from this app's LINE sign-in (`auth/oauth/providers/line.provider.ts`)
 *     is a valid push target for *this* OA — it is not, unless the customer has added the
 *     account as a friend, which is plan 10.2's funnel cost;
 *   - the real rate limits and what they answer with.
 *
 * ── ⚠️ AND IT IS UNREACHABLE TODAY, WHICH IS A DATABASE FACT, NOT A CODE ONE ─
 *
 * Two things stand between this file and a delivered LINE message, and neither is here:
 *
 *   1. `notification_rules` has no `line` rows. Plan 13's channel question is unanswered
 *      (LINE OA charges per push), so the seeded rules are email only. Adding one is an
 *      INSERT — which is the entire argument of plan 10.1's last row.
 *   2. `order_events_fan_out_notifications()` in `drizzle/0007_order_guards.sql` resolves a
 *      recipient for `email` and suppresses every other channel with `channel_disabled`. It
 *      has no `line:` address to resolve *because there is no column holding a LINE user id
 *      on an order* — auth stores it on `provider_identities`. So enabling LINE is: a rule
 *      row, a recipient resolution in that trigger, and this adapter registered by
 *      configuration. **This module can only supply the third.**
 *
 * Written now anyway, because the seam is the deliverable: the worker asks a list of
 * adapters, and adding this one changed nothing else.
 */
export class LineChannelAdapter implements NotificationChannelAdapter {
  readonly channel: NotificationChannel = 'line';

  constructor(
    private readonly config: NotificationsConfig,
    /** Injected so the request shape is testable without a network or a token. */
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  supports(recipientKey: string): boolean {
    return parseRecipientKey(recipientKey)?.scheme === 'line' && this.config.line.accessToken !== undefined;
  }

  async send(message: RenderedMessage): Promise<DeliveryResult> {
    const token = this.config.line.accessToken;
    if (token === undefined) {
      return permanentFailure('no LINE channel access token is configured');
    }

    const parsed = parseRecipientKey(message.recipientKey);
    if (parsed?.scheme !== 'line') {
      return permanentFailure(`recipient key ${message.recipientKey} is not a LINE user id`);
    }

    try {
      const response = await this.fetchImpl(`${this.config.line.apiBase}/v2/bot/message/push`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          /*
           * LINE's own idempotency header. The notification id is the right value for it for
           * the same reason it is the right `Message-ID`: it is stable across retries, so a
           * retry after a timeout — where the push may well have succeeded — does not become
           * a second message. Plan 10.5(1) is about not sending twice; this is that rule at
           * the far end of the wire, where our unique constraint cannot reach.
           */
          'x-line-retry-key': message.notificationId,
        },
        body: JSON.stringify({
          to: parsed.value,
          /*
           * The subject is folded into the text because LINE has no subject line. Dropping
           * it would silently lose the part of the message written to be readable in a
           * notification preview.
           */
          messages: [{ type: 'text', text: `${message.subject}\n\n${message.body}`.slice(0, 4_000) }],
        }),
      });

      if (response.ok) {
        const requestId = response.headers.get('x-line-request-id');
        return requestId === null ? { ok: true } : { ok: true, providerMessageId: requestId };
      }

      const detail = (await response.text().catch(() => '')).slice(0, 300);

      /*
       * 429 is a rate limit and 5xx is LINE having a bad afternoon — both come back. A 4xx
       * that is neither means this message is wrong (unknown user id, not a friend, invalid
       * token) and will be wrong on the fifth attempt too.
       */
      const description = `line ${response.status}: ${detail || response.statusText}`;
      return response.status === 429 || response.status >= 500
        ? transientFailure(description)
        : permanentFailure(description);
    } catch (error) {
      return transientFailure(`line: ${describeThrown(error)}`);
    }
  }
}
