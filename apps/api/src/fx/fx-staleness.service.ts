import { createHash } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { EMAIL_TRANSPORT } from '../notifications/notifications.tokens';
import type { EmailTransport } from '../notifications/channels/transports/email-transport';
import { PermissionRepository } from '../rbac/permission.repository';
import { FxRatesRepository } from './fx-rates.repository';
import {
  FX_RATE_REFUSE_AFTER_HOURS,
  FX_RATE_WARN_AFTER_HOURS,
  fxRateAgeHours,
  fxRateHealthStatus,
  type FxRateHealthStatus,
} from './staleness';

/** Injected rather than read from `process.env` inline, so a test can hand it both halves. */
export interface FxStalenessConfig {
  readonly from: string;
  /**
   * The shared sales mailbox, or `undefined` when none is configured.
   *
   * ⚠️ Named `salesQueue` and not `recipient`, because it is no longer *the* recipient. The
   * people who can fix a stale rate are resolved from `organisation.write` at send time; this is
   * an additional audience — the staff the refusal blocks — and it is never a fallback for an
   * empty authorised set. See `FxStalenessService.check`.
   */
  readonly salesQueue: string | undefined;
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
    /**
     * ⭐ Who can end the outage, resolved from the permission model at send time.
     *
     * Not a constant, not a group code, and not an env var: `organisation.write` is the
     * permission that can actually type `fxManualRate`, so routing on it means a super admin
     * (who holds every code) is included automatically, and delegating just that permission to
     * one new person starts mailing them with nobody editing a recipient list. See
     * `PermissionRepository.addressesHolding` for who is excluded and why.
     */
    private readonly people: PermissionRepository,
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
   * permissions, instant) — see the test, which drives it entirely through this seam.
   *
   * ── ⭐ WHY IT RETURNS A COUNT AND NOT A BOOLEAN ──────────────────────────────────
   *
   * It used to answer `true`/`false`. That collapses the case this round is about: "warned four
   * administrators" and "warned nobody who can fix it, but the sales queue got a copy" are both
   * *"an email went out"*, and only one of them means somebody with `organisation.write` knows.
   * `authorised` is reported separately from `sent` so a caller — and the test — can tell them
   * apart, which is the same reason `EffectivePermissions` carries a status rather than a
   * boolean.
   */
  async check(now: Date): Promise<FxStalenessOutcome> {
    let health;
    try {
      health = await this.rates.health();
    } catch (error) {
      /* The database being unreachable is not a stale rate, and it is already every other
       * subsystem's alarm. Warning about the wrong thing is worse than not warning. */
      this.logger.warn(`could not read exchange-rate health: ${String(error)}`);
      return { status: 'unknown', authorised: 0, sent: 0 };
    }

    const ageHours =
      health.newest === undefined ? null : fxRateAgeHours(health.newest.rateTimestamp, now);
    const status = fxRateHealthStatus(ageHours);

    if (status === 'ok') return { status, authorised: 0, sent: 0 };

    /*
     * Resolved here, on every run, rather than read once at boot. A permission granted this
     * morning has to be reflected tonight, and a person who left has to stop receiving mail
     * without anybody remembering to remove them — that is the whole point of routing by
     * permission instead of by a list.
     */
    let authorised: readonly string[];
    try {
      authorised = await this.people.addressesHolding('organisation.write');
    } catch (error) {
      this.logger.warn(`could not resolve who holds organisation.write: ${String(error)}`);
      authorised = [];
    }

    if (authorised.length === 0) {
      /*
       * ⭐ THE EMPTY SET, AND WHY IT IS NOT A SILENT NO-OP.
       *
       * Nobody active holds `organisation.write` with a primary address, so the warning has no
       * destination that can act on it. That is a worse condition than the stale rate it is
       * trying to report, and it is exactly the failure class this phase exists to remove — so
       * it is **not** swallowed and it does **not** fall back to a hardcoded address.
       *
       * Three things happen instead. It logs at `error`, one level above the ordinary warning.
       * The sales queue below still gets its copy if one is configured, because somebody being
       * told is better than nobody — but that copy is *not* counted as having warned an
       * administrator, which is what `authorised: 0` in the outcome preserves. And the count is
       * reported by `GET /admin/fx/health`, so the organisation screen says it in Thai on the
       * same card as the staleness itself: a condition on a screen, not a line in a stream.
       */
      this.logger.error(
        `exchange rates are ${status} (${describeAge(ageHours)}) and NOBODY holds ` +
          'organisation.write with an active account and a primary email — the people who could ' +
          'enter a manual rate cannot be told. Grant organisation.write, or reactivate an account.',
      );
    }

    /*
     * ⭐ Sales as well, and it is a second audience rather than a fallback.
     *
     * `organisation.write` holders can *fix* it; the sales queue is *blocked* by it, and they
     * are usually not the same people. A salesperson who is not told will keep composing
     * foreign-currency quotations and discover the refusal at the moment they promise a price
     * to a customer — and the sales-screen banner only appears if they happen to open that
     * particular quote. Keeping this recipient is the difference between "we told the person
     * who can fix it" and "we told everybody it affects".
     *
     * ⚠️ It is deliberately *additive*. It is never used to stand in for an empty authorised
     * set — see above — because a copy in a shared inbox is not the same as reaching somebody
     * who holds the permission, and letting it count as one would hide the condition.
     */
    const recipients = [...new Set([...authorised, ...(this.config.salesQueue === undefined ? [] : [this.config.salesQueue])])];

    if (recipients.length === 0) {
      this.logger.error(
        `exchange rates are ${status} (${describeAge(ageHours)}) and there is no address to say ` +
          'so at all: nobody holds organisation.write and NOTIFICATIONS_SALES_QUEUE_EMAIL is unset.',
      );
      return { status, authorised: 0, sent: 0 };
    }

    const subject =
      status === 'blocked'
        ? '[ด่วน] อัตราแลกเปลี่ยนเก่าเกินเพดาน — ใบเสนอราคาสกุลต่างประเทศถูกระงับ'
        : '[แจ้งเตือน] อัตราแลกเปลี่ยนในระบบเริ่มเก่า';
    const body = bodyTh(status, ageHours, health.consecutiveFailures, health.newest?.fetchedAt);
    const day = now.toISOString().slice(0, 10);

    let sent = 0;
    for (const to of recipients) {
      try {
        await this.mail.send({
          from: this.config.from,
          to,
          subject,
          body,
          /*
           * Stable per day, per status **and per recipient**, so a mail server receiving the
           * same warning on three consecutive days threads them rather than showing three
           * unrelated alarms, and a retry inside the same day cannot double-send. The recipient
           * is part of it because two people must not be handed the same `Message-ID` — a
           * server that saw one would be entitled to treat the second as a duplicate and drop
           * it, which would silently reduce a four-person warning to a one-person warning.
           */
          messageId: `fx-staleness-${status}-${day}-${recipientTag(to)}`,
          headers: { 'X-Wewin-Purpose': 'fx-staleness' },
        });
        sent += 1;
      } catch (error) {
        /* Per-recipient, so one dead mailbox does not silence the other three. */
        this.logger.error(`could not warn ${to} about the exchange rate: ${String(error)}`);
      }
    }

    this.logger.warn(
      `exchange rates are ${status} (${describeAge(ageHours)}, ` +
        `${String(health.consecutiveFailures)} failed syncs since the last success); ` +
        `warned ${String(sent)} of ${String(recipients.length)} recipients, ` +
        `${String(authorised.length)} of whom hold organisation.write`,
    );

    return { status, authorised: authorised.length, sent };
  }
}

/**
 * What one run decided and achieved.
 *
 * `authorised` is separate from `sent` on purpose — see `check`. `'unknown'` is the status when
 * the health read itself failed, which is neither healthy nor stale and must not be reported as
 * either.
 */
export interface FxStalenessOutcome {
  readonly status: FxRateHealthStatus | 'unknown';
  /** How many holders of `organisation.write` were resolvable. `0` is an alarm in itself. */
  readonly authorised: number;
  readonly sent: number;
}

/**
 * A short, stable, non-reversible tag for a `Message-ID`.
 *
 * ⚠️ Hashed rather than embedded. A `Message-ID` travels in cleartext through every relay and
 * lands in logs the mail team can read; putting a staff address in it would spread the address
 * further than the envelope already does, for no benefit. Sixteen hex characters of SHA-256 is
 * stable across runs (so the threading it exists for still works) and says nothing about who.
 */
function recipientTag(address: string): string {
  return createHash('sha256').update(address).digest('hex').slice(0, 16);
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
