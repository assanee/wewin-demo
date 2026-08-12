import { describe, expect, it } from 'vitest';

import type {
  EmailTransport,
  OutgoingEmail,
} from '../../src/notifications/channels/transports/email-transport';
import type { FxRatesRepository, FxSyncHealth } from '../../src/fx/fx-rates.repository';
import { FxStalenessService, type FxStalenessConfig } from '../../src/fx/fx-staleness.service';
import { FX_RATE_REFUSE_AFTER_HOURS, FX_RATE_WARN_AFTER_HOURS } from '../../src/fx/staleness';

/**
 * Layer 2: staff hear about a stale rate before the refusal tells them.
 *
 * No database and no Nest graph — this service's whole job is a decision (given these rows and
 * this instant, does anybody get told?) and a message, and both are testable at the seam
 * `check(now)` exists to provide. What the rows *are* is `FxRatesRepository`'s subject and is
 * proved against real Postgres in `fx-health.pg.test.ts`.
 *
 * The fakes are hand-written and pushed into an array, which is the idiom every other email
 * test in this repo uses (`tests/notifications/email.test.ts`, `tests/auth/password/
 * password-reset.test.ts`) — no spies, no mocking library.
 */

class RecordingTransport implements EmailTransport {
  readonly name = 'recording';
  readonly sent: OutgoingEmail[] = [];

  async send(email: OutgoingEmail): Promise<string | undefined> {
    this.sent.push(email);
    return 'recorded';
  }
}

class RefusingTransport implements EmailTransport {
  readonly name = 'refusing';

  async send(): Promise<string | undefined> {
    throw new Error('mailbox unavailable');
  }
}

const NOW = new Date('2026-08-12T02:00:00Z');
const hoursBefore = (hours: number): Date => new Date(NOW.getTime() - hours * 60 * 60 * 1000);

/** A `FxRatesRepository` that answers one canned health reading and touches no database. */
const repositoryOf = (health: FxSyncHealth): FxRatesRepository =>
  ({ health: async () => health }) as unknown as FxRatesRepository;

const healthAged = (hours: number, consecutiveFailures = 0): FxSyncHealth => ({
  newest: {
    id: '00000000-0000-4000-8000-000000000000',
    base: 'USD',
    rates: { THB: 36.5, SGD: 1.34 },
    rateTimestamp: hoursBefore(hours),
    fetchedAt: hoursBefore(hours),
  },
  consecutiveFailures,
  lastFailureAt: consecutiveFailures === 0 ? undefined : hoursBefore(1),
});

const CONFIG: FxStalenessConfig = {
  from: 'wewin <no-reply@wewin.test>',
  recipient: 'sales-queue@wewin.test',
};

const serviceWith = (
  health: FxSyncHealth,
  transport: EmailTransport,
  config: FxStalenessConfig = CONFIG,
): FxStalenessService => new FxStalenessService(repositoryOf(health), transport, config);

describe('FxStalenessService', () => {
  /**
   * ⭐ The negative case, and the one that decides whether anybody reads the positive one.
   *
   * A healthy daily sync leaves the newest rate up to ~25 hours old just before the next tick.
   * If that emailed, staff would get a warning every single day about a system that is working
   * — and an alert that fires daily is an alert that is filtered, after which the real one is
   * invisible too. Silence here is a feature and it is the load-bearing one.
   */
  it('says nothing about a healthy daily sync at its oldest', async () => {
    const transport = new RecordingTransport();

    expect(await serviceWith(healthAged(25), transport).check(NOW)).toBe(false);
    expect(transport.sent).toHaveLength(0);
  });

  it('warns once the newest rate is past the warning threshold', async () => {
    const transport = new RecordingTransport();

    const sent = await serviceWith(healthAged(FX_RATE_WARN_AFTER_HOURS + 1, 2), transport).check(NOW);

    expect(sent).toBe(true);
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]?.to).toBe('sales-queue@wewin.test');
    /* Still quotable: the warning has to say the submits are *working*, or it reads as the
       refusal and staff stop trying. */
    expect(transport.sent[0]?.subject).toContain('แจ้งเตือน');
    expect(transport.sent[0]?.body).toContain('ยังออกใบเสนอราคาได้ตามปกติ');
    /* The consecutive-failure figure reaches the reader, which is the number that says whether
       this is a struggling provider or a scheduler that has stopped. */
    expect(transport.sent[0]?.body).toContain('2');
  });

  /**
   * ⭐ Past the refusal threshold the message changes, and it must.
   *
   * At this point `QuotationRateService` is already refusing submits. A mail that still said
   * "ยังออกใบเสนอราคาได้ตามปกติ" would be telling staff the opposite of what their screen is
   * about to tell them — and the person who trusts the email is the person who promises a
   * customer a quotation that cannot be issued.
   */
  it('escalates the wording once submits are actually being refused', async () => {
    const transport = new RecordingTransport();

    await serviceWith(healthAged(FX_RATE_REFUSE_AFTER_HOURS + 5), transport).check(NOW);

    expect(transport.sent[0]?.subject).toContain('ด่วน');
    expect(transport.sent[0]?.body).toContain('ไม่ออก');
    expect(transport.sent[0]?.body).not.toContain('ยังออกใบเสนอราคาได้ตามปกติ');
  });

  /**
   * Both messages name the manual override, because a warning that does not say what to do is
   * a warning that gets forwarded rather than acted on — and this one has a genuine answer
   * that works immediately and does not wait for the provider.
   */
  it('names the manual-rate escape hatch in every message it sends', async () => {
    for (const age of [FX_RATE_WARN_AFTER_HOURS + 1, FX_RATE_REFUSE_AFTER_HOURS + 1]) {
      const transport = new RecordingTransport();
      await serviceWith(healthAged(age), transport).check(NOW);

      expect(transport.sent[0]?.body).toContain('อัตราแลกเปลี่ยนกำหนดเอง');
    }
  });

  /**
   * ⭐ Never having synced at all is `blocked`, not silence.
   *
   * `newest: undefined` is a fresh environment, a scheduler that never ran, and an
   * `OPENEXCHANGERATES_APP_ID` nobody set — all of which already refuse every foreign-currency
   * submit. An age check written as `if (age > limit)` over a `null` age would evaluate to
   * `false` and say nothing, which is silence about the most broken state there is.
   */
  it('warns when there is no observation at all, rather than falling silent', async () => {
    const transport = new RecordingTransport();
    const health: FxSyncHealth = {
      newest: undefined,
      consecutiveFailures: 0,
      lastFailureAt: undefined,
    };

    expect(await serviceWith(health, transport).check(NOW)).toBe(true);
    expect(transport.sent[0]?.subject).toContain('ด่วน');
    expect(transport.sent[0]?.body).toContain('ยังไม่เคยดึงอัตราแลกเปลี่ยนเข้าระบบเลย');
  });

  /**
   * A `messageId` that is stable per day and per status, so three consecutive days of warnings
   * thread in a mail client rather than arriving as three unrelated alarms — and so a retry
   * inside the same day cannot double-send.
   */
  it('mints a message id that is stable within a day and moves between days', async () => {
    const transport = new RecordingTransport();
    const service = serviceWith(healthAged(FX_RATE_WARN_AFTER_HOURS + 1), transport);

    await service.check(NOW);
    await service.check(new Date('2026-08-12T23:30:00Z'));
    await service.check(new Date('2026-08-13T02:00:00Z'));

    expect(transport.sent[0]?.messageId).toBe(transport.sent[1]?.messageId);
    expect(transport.sent[2]?.messageId).not.toBe(transport.sent[0]?.messageId);
  });

  /**
   * ⚠️ A transport failure is reported as "did not warn" and does not throw.
   *
   * This runs from a `@Cron`, where an unhandled rejection is a scheduler-level error carrying
   * whatever the transport threw. More importantly the return value is the honest one: nobody
   * was told. A version that returned `true` here would be a warning system that reports
   * success for messages that never left.
   */
  it('reports failure rather than throwing when the transport refuses', async () => {
    const service = serviceWith(healthAged(FX_RATE_REFUSE_AFTER_HOURS + 1), new RefusingTransport());

    expect(await service.check(NOW)).toBe(false);
  });

  /**
   * ⭐ No configured mailbox is not a reason to send to a guess.
   *
   * `parseNotificationsConfig` refuses to boot production without a sales queue and defaults to
   * `sales-queue@wewin.local` outside it, so this is a deployment that opted out of both. The
   * only honest behaviour is to log loudly and report that nobody was warned — inventing a
   * recipient here is exactly the thing the recipient choice was careful not to do.
   */
  it('does not invent a recipient when no staff mailbox is configured', async () => {
    const transport = new RecordingTransport();
    const service = serviceWith(healthAged(FX_RATE_REFUSE_AFTER_HOURS + 1), transport, {
      from: CONFIG.from,
      recipient: undefined,
    });

    expect(await service.check(NOW)).toBe(false);
    expect(transport.sent).toHaveLength(0);
  });

  /**
   * A database that will not answer is not a stale rate. It is already every other subsystem's
   * alarm, and warning about the wrong thing trains people to ignore the right one.
   */
  it('stays quiet when the health read itself fails', async () => {
    const transport = new RecordingTransport();
    const broken = {
      health: async () => {
        throw new Error('connection terminated');
      },
    } as unknown as FxRatesRepository;

    expect(await new FxStalenessService(broken, transport, CONFIG).check(NOW)).toBe(false);
    expect(transport.sent).toHaveLength(0);
  });
});
