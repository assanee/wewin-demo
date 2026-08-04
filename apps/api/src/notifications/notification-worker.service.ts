import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';

import { backoffMs } from './backoff';
import type { DeliveryResult, NotificationChannelAdapter, RenderedMessage } from './channels/channel';
import { preferredLocaleOf, resolveRenderLocale } from './locale';
import type { NotificationsConfig } from './notifications.config';
import { NotificationsRepository, type ClaimedNotification } from './notifications.repository';
import { NOTIFICATIONS_CONFIG, NOTIFICATION_CHANNEL_ADAPTERS } from './notifications.tokens';
import { renderTemplate } from './templates/templates';

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

  private async deliver(notification: ClaimedNotification): Promise<void> {
    /*
     * Plan 10.6: the recipient's language *now*, not the one pinned on the document. See
     * locale.ts — `contactLocale` is where "now" lives for a guest, and `accountLocale` is
     * the phase-6 seam for a signed-in customer.
     */
    const preferred = preferredLocaleOf({ contactLocale: notification.contactLocale });
    const locale = resolveRenderLocale(preferred);

    const rendered = renderTemplate(locale.rendered, notification.templateKey, {
      orderNo: notification.orderNo,
      contactName: notification.contactName,
      coalescedCount: notification.coalescedCount,
    });

    if (rendered === undefined) {
      /*
       * A rule names a template this build cannot render. That is a deployment mismatch —
       * a migration ahead of the code — and it will not fix itself on the fifth attempt, so
       * it goes to the dead queue immediately with the key that is missing. What it must
       * never do is send a placeholder: "order.delivered.customer" in a customer's inbox is
       * worse than a row in a queue an engineer reads.
       */
      await this.record(notification, locale.rendered, '(no template)', {
        ok: false,
        error: `no template '${notification.templateKey}' for locale '${locale.rendered}'`,
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
