import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { EMAIL_TRANSPORT } from '../notifications/notifications.tokens';
import type { EmailTransport } from '../notifications/channels/transports/email-transport';
import { FxRatesRepository } from './fx-rates.repository';
import {
  FX_RATE_REFUSE_AFTER_HOURS,
  FX_RATE_WARN_AFTER_HOURS,
  fxRateAgeHours,
  fxRateHealthStatus,
} from './staleness';

/** Injected rather than read from `process.env` inline, so a test can hand it both halves. */
export interface FxStalenessConfig {
  readonly from: string;
  /** `undefined` when no staff queue is configured at all — see `FxStalenessService.check`. */
  readonly recipient: string | undefined;
}

export const FX_STALENESS_CONFIG = Symbol('wewin.fx.stalenessConfig');

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ TELLING SOMEBODY, BEFORE THE REFUSAL DOES IT FOR US.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `QuotationRateService` refuses past 72 hours and that is the load-bearing guarantee. This
 * exists so the refusal is never the first anyone hears of it: at 36 hours a mail goes out
 * while the cost of acting is still zero, and the thing that gets refused a day and a half
 * later is a submit somebody was already told about twice.
 *
 * Ordering, said plainly, because it is the design: the *stop* is the guarantee and the *warn*
 * is the courtesy. If this service is never deployed, never configured, or silently failing,
 * nothing wrong is ever quoted — the refusal does not depend on it. A warning system that had
 * to work for correctness to hold would be a second thing to monitor.
 *
 * ── ⭐ 02:00, and why not the same tick as the fetch ─────────────────────────────
 *
 * `FxRatesService` fetches at 01:00. This runs an hour later rather than at the end of
 * `fetchAndStore`, for a reason that is the whole point of the round: **the failure mode this
 * warns about includes the fetch not running at all.** A check hanging off the end of the
 * fetch is a check that is skipped in exactly the case it exists for — a crashed scheduler, a
 * container that never started, `OPENEXCHANGERATES_APP_ID` unset — and it would report health
 * only on the days it was healthy. A separate tick asks the database a question about rows,
 * and rows are there or they are not regardless of what happened at 01:00.
 *
 * An hour's gap so a slow provider on the 01:00 tick is not reported as an outage at 01:00:01.
 *
 * ── ⭐ WHO GETS IT, and the honest answer about "organisation settings" ──────────
 *
 * The brief said to find the recipient in the existing organisation settings rather than
 * invent one. Having read them: **there is no staff mailbox in organisation settings.** The
 * only email column anywhere near them is `organisation_profile.email`, and its own table
 * header rules it out — *"The company, as a document prints it… read at render time and never
 * pinned into a document"*. It is letterhead. It is nullable, it has never been sent to by
 * anything, and it is as likely to be `info@` on a website as a mailbox a person opens.
 * Choosing it would have been inventing a recipient out of a print field, which is the thing
 * the brief was warning against.
 *
 * What the system *does* already have is two configured staff queues, resolved by
 * `EmailChannelAdapter.addressOf` from `group:` keys. This sends to **`sales_queue`**
 * (`NOTIFICATIONS_SALES_QUEUE_EMAIL`), and the case is:
 *
 *   - it is the address the four existing staff notices already go to, so this adds a message
 *     to a mailbox somebody is demonstrably already reading rather than opening a new channel;
 *   - `notifications.config.ts` refuses to boot in production without it, so unlike every
 *     other candidate it cannot be silently unroutable — a warning nobody receives is the
 *     failure this whole round is about, and it would be a poor joke to reintroduce it here;
 *   - the people behind it are the people the 72-hour refusal will block. They compose the
 *     quotations, so they are who experiences the consequence and who will chase it.
 *
 * ⚠️ **An owner's decision, flagged rather than settled.** The *fix* — typing
 * `fxManualRate` — needs `organisation.write`, which sales may not hold, so this warns the
 * people who feel the problem and not necessarily the person who can end it.
 * `approver_queue` is built, resolvable and currently used by no rule, and pointing this at it
 * (or at both) is a one-line change if the owner would rather it reached an administrator.
 *
 * ── Its own transport instance ───────────────────────────────────────────────────
 *
 * Same shape as `PasswordModule`'s and for the reason stated there: `NotificationsModule`
 * exports nothing, and importing it to share a transport would bring `NotificationWorker` and
 * start a second poller against the same outbox. `createEmailTransport` remains the one place
 * that decides file-versus-smtp-versus-resend, so the two cannot drift.
 *
 * ⚠️ **Not through the outbox**, and not by preference. `notifications.order_id` is `NOT NULL`
 * and the table is written only by the `order_events` fan-out trigger — a rate that has gone
 * stale belongs to no order, so there is no row it could legally be. This is the identical
 * constraint that put `PasswordResetService` on a direct send.
 */
@Injectable()
export class FxStalenessService {
  private readonly logger = new Logger(FxStalenessService.name);

  constructor(
    private readonly rates: FxRatesRepository,
    @Inject(EMAIL_TRANSPORT) private readonly mail: EmailTransport,
    @Inject(FX_STALENESS_CONFIG) private readonly config: FxStalenessConfig,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async warnIfStale(): Promise<void> {
    await this.check(new Date());
  }

  /**
   * ⭐ The check itself, with `now` as an argument.
   *
   * A parameter rather than `new Date()` inside, so a test can put the clock where it needs it
   * without either mutating time globally or waiting three days. The `@Cron` above is the only
   * caller that supplies the real one, which keeps this method a pure-ish function of (rows,
   * instant) — see the test, which drives it entirely through this seam.
   *
   * Returns whether it sent, for the same reason: a test asserting "an email went out" is
   * asserting on the transport, and a test asserting "it decided to" is asserting on this.
   */
  async check(now: Date): Promise<boolean> {
    let health;
    try {
      health = await this.rates.health();
    } catch (error) {
      /* The database being unreachable is not a stale rate, and it is already every other
       * subsystem's alarm. Warning about the wrong thing is worse than not warning. */
      this.logger.warn(`could not read exchange-rate health: ${String(error)}`);
      return false;
    }

    const ageHours =
      health.newest === undefined ? null : fxRateAgeHours(health.newest.rateTimestamp, now);
    const status = fxRateHealthStatus(ageHours);

    if (status === 'ok') return false;

    const recipient = this.config.recipient;
    if (recipient === undefined) {
      /*
       * Loud, and on the path that is *already* an alarm. Outside production the queue address
       * defaults to `sales-queue@wewin.local`, and inside it `parseNotificationsConfig` refuses
       * to boot without one — so reaching this is a deployment that opted out of both, and the
       * only honest thing left is to say the warning could not be delivered.
       */
      this.logger.error(
        `exchange rates are ${status} (${describeAge(ageHours)}) and no staff mailbox is ` +
          'configured to say so; set NOTIFICATIONS_SALES_QUEUE_EMAIL',
      );
      return false;
    }

    try {
      await this.mail.send({
        from: this.config.from,
        to: recipient,
        subject:
          status === 'blocked'
            ? '[ด่วน] อัตราแลกเปลี่ยนเก่าเกินเพดาน — ใบเสนอราคาสกุลต่างประเทศถูกระงับ'
            : '[แจ้งเตือน] อัตราแลกเปลี่ยนในระบบเริ่มเก่า',
        body: bodyTh(status, ageHours, health.consecutiveFailures, health.newest?.fetchedAt),
        /*
         * Stable per day and per status, so a mail server that receives the same warning on
         * three consecutive days threads them rather than showing three unrelated alarms —
         * and so a retry within the same day cannot double-send. `toISOString().slice(0, 10)`
         * is the date in UTC, which is the clock the cron runs on.
         */
        messageId: `fx-staleness-${status}-${now.toISOString().slice(0, 10)}`,
        headers: { 'X-Wewin-Purpose': 'fx-staleness' },
      });
    } catch (error) {
      this.logger.error(`could not send the exchange-rate staleness warning: ${String(error)}`);
      return false;
    }

    this.logger.warn(
      `exchange rates are ${status} (${describeAge(ageHours)}, ` +
        `${String(health.consecutiveFailures)} failed syncs since the last success); warned ${recipient}`,
    );

    return true;
  }
}

function describeAge(ageHours: number | null): string {
  return ageHours === null ? 'no observation at all' : `${String(Math.floor(ageHours))}h old`;
}

/**
 * The Thai body — in the `staff(...)` register the notification templates use: no greeting,
 * no sign-off, the fact first and the action last.
 *
 * It names both thresholds and the actual age rather than only saying "old", because the
 * reader's next question is always *"how bad, and how long have I got"* — and at `warn` the
 * answer is genuinely reassuring, which is the difference between an alert people act on and
 * an alert people filter.
 */
function bodyTh(
  status: 'warn' | 'blocked',
  ageHours: number | null,
  consecutiveFailures: number,
  fetchedAt: Date | undefined,
): string {
  const age =
    ageHours === null
      ? 'ยังไม่เคยดึงอัตราแลกเปลี่ยนเข้าระบบเลย'
      : `อัตราแลกเปลี่ยนล่าสุดในระบบเก่า ${String(Math.floor(ageHours))} ชั่วโมง`;

  const head =
    status === 'blocked'
      ? `${age} ซึ่งเกินเพดาน ${String(FX_RATE_REFUSE_AFTER_HOURS)} ชั่วโมง\n` +
        'ขณะนี้ระบบ "ไม่ออก" ใบเสนอราคาที่เป็นสกุลเงินต่างประเทศแล้ว — พนักงานขายจะถูกปฏิเสธเมื่อกดส่ง'
      : `${age} ซึ่งเกินเกณฑ์เตือน ${String(FX_RATE_WARN_AFTER_HOURS)} ชั่วโมง\n` +
        `ยังออกใบเสนอราคาได้ตามปกติ แต่ถ้าเก่าเกิน ${String(FX_RATE_REFUSE_AFTER_HOURS)} ชั่วโมง ระบบจะระงับใบเสนอราคาสกุลเงินต่างประเทศ`;

  const sync =
    consecutiveFailures === 0
      ? 'ยังไม่พบการดึงอัตราที่ล้มเหลวหลังรอบที่สำเร็จล่าสุด — เป็นไปได้ว่าตัวดึงอัตราไม่ได้ทำงานเลย'
      : `การดึงอัตราล้มเหลวติดต่อกัน ${String(consecutiveFailures)} ครั้งนับจากรอบที่สำเร็จล่าสุด`;

  const fetched =
    fetchedAt === undefined ? '' : `\nระบบดึงอัตราสำเร็จครั้งล่าสุดเมื่อ ${fetchedAt.toISOString()}`;

  return (
    `${head}\n\n${sync}${fetched}\n\n` +
    'วิธีแก้ทันที: ให้ผู้ดูแลระบบเปิดหน้า "ข้อมูลบริษัท" → ประเทศปลายทาง แล้วกรอก "อัตราแลกเปลี่ยนกำหนดเอง" ' +
    'ของประเทศที่ต้องเสนอราคา อัตราที่กรอกเองจะใช้ได้ทันทีและไม่ติดเงื่อนไขความเก่า\n' +
    'วิธีแก้ระยะยาว: ตรวจสอบว่าตัวดึงอัตราแลกเปลี่ยนยังทำงานอยู่ และคีย์ OPENEXCHANGERATES_APP_ID ยังใช้ได้'
  );
}
