import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';

import { backoffMs } from './backoff';
import type { DeliveryResult, NotificationChannelAdapter, RenderedMessage } from './channels/channel';
import { preferredLocaleOf, resolveRenderLocale, type SupportedLocale } from './locale';
import type { NotificationsConfig } from './notifications.config';
import { DocumentLinkService, documentLinkUrl } from '../orders/document-link';
import { NotificationsRepository, type ClaimedNotification } from './notifications.repository';
import { NOTIFICATIONS_CONFIG, NOTIFICATION_CHANNEL_ADAPTERS } from './notifications.tokens';
import { hasTemplate, renderTemplate, sendSuppression, type TemplateContext } from './templates/templates';

/**
 * The consumer half of plan 10.1: `order_events` produces, this delivers.
 *
 * ── The two properties the brief asks for, and where each one lives ──────────
 *
 * **A state change nobody was told about is impossible.** Not because of anything in this
 * file — that is the point. The outbox row is written by `order_events_fan_out_notifications()`,
 * a trigger on the spine, inside the transaction that appended the event. There is no call
 * for a service to forget and no ordering for one to get wrong, and `notifications_guard_insert()`
 * refuses a row that did not come from that trigger, so this worker could not queue a
 * message by hand even if it wanted to. This file only *drains* what the database already
 * guaranteed exists. (The other half of that guarantee — that a rule exists at all for each
 * event type — is `event-coverage.ts` and its test.)
 *
 * **A delivery failure cannot roll back a state change.** Also structural, and for the same
 * reason inverted: nothing here runs inside a transition's transaction. The worker polls
 * rows that were committed minutes ago by a process that has already answered its HTTP
 * request. SMTP being down produces a failed attempt row and a retry; it cannot produce an
 * order that is not in the status the customer was shown.
 *
 * ── Why a poller and not LISTEN/NOTIFY ───────────────────────────────────────
 *
 * `NOTIFY` does not survive a worker being down, and the coalescing window in front of this
 * queue is ten minutes wide (plan 13's default), so "instant" was never on the table. A
 * five-second poll on a partial index (`notifications_due_idx`) is a few hundred microseconds
 * of work and, unlike a notification channel, it recovers from a restart by itself. The
 * seam is here if that changes: `runOnce` is the whole worker, and something else could
 * call it.
 */
@Injectable()
export class NotificationWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('NotificationWorker');
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;
  /** So the dead-queue warning is one line when something breaks, not one line every poll. */
  private lastReportedDead = 0;

  constructor(
    @Inject(NOTIFICATIONS_CONFIG) private readonly config: NotificationsConfig,
    @Inject(NOTIFICATION_CHANNEL_ADAPTERS) private readonly adapters: readonly NotificationChannelAdapter[],
    private readonly repository: NotificationsRepository,
    /**
     * ⭐ Mints the quotation link that goes in a customer message.
     *
     * ⚠️ Not `@Optional()`, deliberately. A graph wired without it would send every customer
     * message with no link and say nothing — the "fails silent" shape this module's own notes
     * warn about twice. Missing *wiring* is a code mistake and stops the boot; missing
     * *configuration* (`NOTIFICATIONS_WEB_BASE_URL`) is a deployment choice and degrades to a
     * message with no link, which is why only the second one is allowed to be absent.
     */
    private readonly links: DocumentLinkService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.workerEnabled) {
      this.logger.log('Notification worker disabled — the outbox will fill and nothing will drain it');
      return;
    }

    this.logger.log(
      `Notification worker polling every ${this.config.pollIntervalMs}ms ` +
        `(channels: ${this.adapters.map((adapter) => adapter.channel).join(', ') || 'none'})`,
    );

    // `unref` so a poller never keeps the process alive on its own: a shutdown that hangs
    // for five seconds because of a timer is a shutdown somebody eventually SIGKILLs, and a
    // SIGKILL mid-send is exactly the row that gets stuck in `sending`.
    this.timer = setInterval(() => void this.tick(), this.config.pollIntervalMs);
    this.timer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearInterval(this.timer);

    // Let an in-flight batch finish recording its attempts. Without this, shutting down
    // during a send leaves the row `sending` and the attempt unrecorded — recoverable via
    // the lease, but recoverable is worse than not broken.
    for (let waited = 0; this.running && waited < 5_000; waited += 50) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /**
   * Guards against overlap. A poll that is still working when the next tick arrives must not
   * start a second batch: the claim would be safe (it is `SKIP LOCKED`), but the process
   * would quietly grow its own concurrency every time the mail server got slow.
   */
  private async tick(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      await this.runOnce();
    } catch (error) {
      // A failure here is the *worker* failing, not a message failing — a lost database
      // connection, usually. Logged and swallowed, because an unhandled rejection in a
      // timer callback takes the process down and the process is also serving HTTP.
      this.logger.error(`Notification poll failed: ${String(error)}`);
    } finally {
      this.running = false;
    }
  }

  /**
   * One batch: claim, send, record. Public because it is the whole worker.
   *
   * Tests call this directly instead of waiting on a timer, which is the difference between
   * a suite that proves the delivery path and one that proves `setInterval` works.
   */
  async runOnce(): Promise<number> {
    const claimed = await this.repository.claimDue(this.config.batchSize, this.config.claimLeaseMs);

    for (const notification of claimed) {
      await this.deliver(notification);
    }

    await this.reportDeadQueue();
    return claimed.length;
  }

  /**
   * ⭐ The quotation link, for a customer message, or `undefined`.
   *
   * ⚠️ **`recipientKind === 'customer'` and nothing else.** The internal queue is read by
   * people who hold `orders.read` and can open the order properly; a bearer link in a staff
   * inbox is one forward away from being outside the company, and buys nothing.
   *
   * The token is **derived here, on the spot**, from the order id the outbox row already
   * carries — see `orders/document-link.ts` for why nothing is stored. That has a consequence
   * worth stating: every message carries a *fresh* link, so a customer who is still being
   * written to never runs out of runway, and a message delivered on its fifth retry a day
   * later is not shipping a token that is a day closer to expiry.
   *
   * `locale` picks the storefront path, so the page opens in the language this message was
   * written in rather than making somebody switch after arriving.
   */
  private documentUrl(notification: ClaimedNotification, locale: SupportedLocale): string | undefined {
    if (this.config.webBaseUrl === undefined) return undefined;
    if (notification.recipientKind !== 'customer') return undefined;

    /* The same builder the dashboard's copy button uses — one shape, one place. */
    return documentLinkUrl(this.config.webBaseUrl, locale, this.links.issue(notification.orderId).token);
  }

  private async deliver(notification: ClaimedNotification): Promise<void> {
    /*
     * Plan 10.6: the recipient's language *now*, not the one pinned on the document. See
     * locale.ts — `contactLocale` is where "now" lives for a guest, and `accountLocale` is
     * the phase-6 seam for a signed-in customer.
     */
    const preferred = preferredLocaleOf({ contactLocale: notification.contactLocale });
    /*
     * Per template, not per language — see locale.ts. `SUPPORTED_LOCALES` is eight now and
     * the template catalogue is one, so asking "is `my` supported?" would answer yes and
     * then fail to render.
     */
    const locale = resolveRenderLocale(preferred, notification.templateKey);

    const context: TemplateContext = {
      orderNo: notification.orderNo,
      contactName: notification.contactName,
      coalescedCount: notification.coalescedCount,
      documentUrl: this.documentUrl(notification, locale.rendered),
      /*
       * ⭐ The two balances, as Postgres computed them in the claim statement — see
       * `ClaimedNotification.outstandingThbMinor` for why they are read at claim time and not
       * snapshotted when the event was written, and `nextDueThbMinor` for why the message
       * carries the instalment beside the total.
       *
       * ⛔ Handed over as satang, untouched. The renderer picked for `locale.rendered` formats
       * them with that locale's own formatter; this file never turns either into a string,
       * because a string formatted here would be one locale's typography imposed on all eight.
       */
      outstandingThbMinor: notification.outstandingThbMinor,
      nextDueThbMinor: notification.nextDueThbMinor,
    };

    /*
     * ⭐ **The message is still queued, and it must no longer be sent.**
     *
     * Asked before rendering and answered from the facts read at claim time: today, a balance
     * reminder for an order that has been settled since the button was pressed. `templates.ts`
     * carries the whole argument, including why this is `suppressed` rather than a dead row —
     * in one line, because a customer who paid promptly is not a delivery failure and must not
     * arrive in the queue whose sentence is "nobody has been told".
     *
     * ⚠️ No attempt is recorded, because nothing was attempted. The renderer refuses the same
     * case independently; that refusal is the backstop for any path that does not come through
     * here, and this is the one that keeps the outbox honest about what happened.
     */
    const suppression = sendSuppression(notification.templateKey, context);
    if (suppression !== undefined) {
      await this.repository.suppress(notification.id, suppression);
      this.logger.debug(
        `Notification ${notification.id} (${notification.templateKey}) was not sent: ${suppression}`,
      );
      return;
    }

    const rendered = renderTemplate(locale.rendered, notification.templateKey, context);

    if (rendered === undefined) {
      /*
       * Two different failures wearing one `undefined`, and the dead row has to say which,
       * because they are fixed by different people:
       *
       *   **no template for this key in this locale** — a deployment mismatch, a migration
       *   ahead of the code. Fixed by deploying.
       *
       *   **the renderer refused** — the template exists and declined to produce a message
       *   because the context was missing something it requires. Today that is the balance
       *   reminder with no `outstandingThbMinor`, which means a caller built a context the
       *   claim query is supposed to fill. Fixed by fixing the caller.
       *
       * Both are permanent: neither fixes itself on the fifth attempt, and four more tries
       * delay the dead queue by a quarter of an hour during which the company believes the
       * customer was told (plan 10.5(3)). What neither may do is send a placeholder —
       * "order.delivered.customer" in a customer's inbox, or a reminder with no figure in it,
       * are both worse than a row in a queue an engineer reads.
       */
      const error = hasTemplate(locale.rendered, notification.templateKey)
        ? `template '${notification.templateKey}' for locale '${locale.rendered}' refused to render: the notification did not carry a fact the message requires`
        : `no template '${notification.templateKey}' for locale '${locale.rendered}'`;

      await this.record(notification, locale.rendered, '(no template)', {
        ok: false,
        error,
        retryable: false,
      });
      return;
    }

    const adapter = this.adapters.find(
      (candidate) => candidate.channel === notification.channel && candidate.supports(notification.recipientKey),
    );

    if (adapter === undefined) {
      /*
       * Permanent, and the message says which of the two things is missing. A LINE row in a
       * build with no LINE token is this case, and it should surface as a configuration
       * problem in the dead queue rather than as five failed sends.
       */
      await this.record(notification, locale.rendered, rendered.subject, {
        ok: false,
        error: `no adapter for channel '${notification.channel}' that can address '${notification.recipientKey}'`,
        retryable: false,
      });
      return;
    }

    const message: RenderedMessage = {
      recipientKey: notification.recipientKey,
      subject: rendered.subject,
      body: rendered.body,
      locale: locale.rendered,
      notificationId: notification.id,
      orderId: notification.orderId,
      eventId: notification.eventId,
    };

    /*
     * An adapter that throws instead of returning a failure is a bug in the adapter, and it
     * must not become an unrecorded attempt: the row would stay `sending` until the lease
     * expires and the reason would be nowhere. Caught, classified as transient — the
     * conservative direction, because a bug that is fixed on the next deploy is transient.
     */
    const result: DeliveryResult = await adapter
      .send(message)
      .catch((error: unknown) => ({ ok: false as const, error: `adapter threw: ${String(error)}`, retryable: true }));

    await this.record(notification, locale.rendered, rendered.subject, result);

    if (locale.rendered !== locale.requested) {
      this.logger.debug(
        `Notification ${notification.id} requested locale '${locale.requested}' and was rendered in '${locale.rendered}'`,
      );
    }
  }

  private async record(
    notification: ClaimedNotification,
    locale: string,
    subject: string,
    result: DeliveryResult,
  ): Promise<void> {
    const attempt = {
      notificationId: notification.id,
      channel: notification.channel,
      recipientKey: notification.recipientKey,
      locale,
      renderedSubject: subject,
    };

    if (result.ok) {
      await this.repository.recordSuccess(attempt, result.providerMessageId);
      return;
    }

    /*
     * `attemptCount` here is the value at claim time, so the delay computed from it is one
     * attempt behind if a lease handed the row over mid-flight. That is deliberately not
     * corrected: the authoritative count lives in the UPDATE (`attempt_count + 1`), which is
     * what decides `dead`, and a backoff that is occasionally one step short is a message
     * that arrives sooner — not a message that is lost or one that is sent twice.
     */
    await this.repository.recordFailure(attempt, {
      error: result.error,
      permanent: !result.retryable,
      maxAttempts: this.config.maxAttempts,
      retryDelayMs: backoffMs(notification.attemptCount + 2, {
        baseMs: this.config.retryBaseMs,
        maxMs: this.config.retryMaxMs,
      }),
    });
  }

  /**
   * Plan 10.5(3), as a log line: **a dead queue nobody sees is worse than no queue at all**.
   *
   * The HTTP endpoint (`GET /admin/notifications/dead`) is the queue a person opens. This is
   * the part that makes them open it, because nobody opens a page they have no reason to
   * suspect. It logs at `error` — not `warn` — because the fact it reports is that a customer
   * believes they were told something and was not, and that is what an alerting rule should
   * be able to key on without a regex over the message.
   *
   * Only on change, so a queue with three dead rows produces one line and not one every five
   * seconds; a queue that empties says so too, which is the line that tells somebody the
   * retry they clicked worked.
   */
  private async reportDeadQueue(): Promise<void> {
    const summary = await this.repository.deadSnapshot(this.config.claimLeaseMs);

    if (summary.dead !== this.lastReportedDead) {
      if (summary.dead > 0) {
        this.logger.error(
          `${summary.dead} notification(s) could not be delivered and are in the dead queue ` +
            `(oldest ${summary.oldestDeadAt ?? 'unknown'}). Nobody has been told: GET /admin/notifications/dead`,
        );
      } else {
        this.logger.log('Notification dead queue is empty');
      }
      this.lastReportedDead = summary.dead;
    }

    if (summary.stuckSending > 0) {
      this.logger.warn(
        `${summary.stuckSending} notification(s) have been 'sending' longer than the lease and will be reclaimed`,
      );
    }
  }
}
