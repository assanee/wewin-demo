import { describe, expect, it } from 'vitest';

import type {
  EmailTransport,
  OutgoingEmail,
} from '../../src/notifications/channels/transports/email-transport';
import type { FxRatesRepository, FxSyncHealth } from '../../src/fx/fx-rates.repository';
import type { PermissionRepository } from '../../src/rbac/permission.repository';
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
  salesQueue: 'sales-queue@wewin.test',
};

/**
 * A `PermissionRepository` that answers a canned address list.
 *
 * The *query* — who holds a permission, and which statuses are excluded — is a statement about
 * rows and is proved against real Postgres in `permission-recipients.pg.test.ts`. What is
 * proved here is what this service does with the answer, which is a different thing and the
 * only thing a fake can honestly stand in for.
 */
const peopleOf = (addresses: readonly string[]): PermissionRepository =>
  ({ addressesHolding: async () => addresses }) as unknown as PermissionRepository;

const ADMIN = 'somchai@wewin.test';

const serviceWith = (
  health: FxSyncHealth,
  transport: EmailTransport,
  config: FxStalenessConfig = CONFIG,
  admins: readonly string[] = [ADMIN],
): FxStalenessService =>
  new FxStalenessService(repositoryOf(health), peopleOf(admins), transport, config);

const addressesOf = (transport: RecordingTransport): readonly string[] =>
  transport.sent.map((email) => email.to).sort();

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

    expect((await serviceWith(healthAged(25), transport).check(NOW)).sent).toBe(0);
    expect(transport.sent).toHaveLength(0);
  });

  it('warns once the newest rate is past the warning threshold', async () => {
    const transport = new RecordingTransport();

    const outcome = await serviceWith(healthAged(FX_RATE_WARN_AFTER_HOURS + 1, 2), transport).check(NOW);

    /* Both audiences: the administrator who can fix it and the queue it blocks. */
    expect(outcome).toStrictEqual({ status: 'warn', authorised: 1, sent: 2 });
    expect(addressesOf(transport)).toStrictEqual(['sales-queue@wewin.test', ADMIN]);
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

    expect((await serviceWith(health, transport).check(NOW)).sent).toBe(2);
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

    /* Two recipients per run, so runs are 2 apart. Same day → same ids; next day → different. */
    expect(transport.sent[0]?.messageId).toBe(transport.sent[2]?.messageId);
    expect(transport.sent[4]?.messageId).not.toBe(transport.sent[0]?.messageId);
    /* And two people in the same run never share one, or a server may drop the second. */
    expect(transport.sent[0]?.messageId).not.toBe(transport.sent[1]?.messageId);
    /* ⚠️ No address in the id — it travels in cleartext through every relay. */
    for (const email of transport.sent) expect(email.messageId).not.toContain('@wewin.test');
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

    const outcome = await service.check(NOW);
    /* It still *resolved* an administrator — the honest report is "one person should have been
       told and nobody was", not "there was nobody to tell". */
    expect(outcome).toStrictEqual({ status: 'blocked', authorised: 1, sent: 0 });
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
    const service = serviceWith(
      healthAged(FX_RATE_REFUSE_AFTER_HOURS + 1),
      transport,
      { from: CONFIG.from, salesQueue: undefined },
      [],
    );

    expect(await service.check(NOW)).toStrictEqual({ status: 'blocked', authorised: 0, sent: 0 });
    expect(transport.sent).toHaveLength(0);
  });

  /* ────────────────────────────────────────────────────────────────────────────
   * Recipients — routed by permission, not by a list
   * ──────────────────────────────────────────────────────────────────────────── */

  /**
   * ⭐ Everybody who holds `organisation.write` gets it, one address each.
   *
   * The set follows the permission model, so a super admin (who holds every code) is included
   * without being named and a newly delegated administrator starts receiving mail with nobody
   * editing a recipient list.
   */
  it('warns every holder of organisation.write, plus the sales queue', async () => {
    const transport = new RecordingTransport();
    const admins = ['aoy@wewin.test', 'nok@wewin.test', 'somchai@wewin.test'];

    const outcome = await serviceWith(
      healthAged(FX_RATE_REFUSE_AFTER_HOURS + 1),
      transport,
      CONFIG,
      admins,
    ).check(NOW);

    expect(outcome).toStrictEqual({ status: 'blocked', authorised: 3, sent: 4 });
    expect(addressesOf(transport)).toStrictEqual([...admins, 'sales-queue@wewin.test'].sort());
  });

  /**
   * ⚠️ One address per person, even when the same mailbox arrives twice.
   *
   * A person holding `organisation.write` through two groups is resolved once by the repository's
   * `selectDistinct`; a person who *is* the sales queue address would otherwise be mailed twice
   * by this service. The `Set` here is the second of those two guards and the only one a fake
   * repository can exercise.
   */
  it('never mails the same address twice, even when it is also the sales queue', async () => {
    const transport = new RecordingTransport();

    const outcome = await serviceWith(
      healthAged(FX_RATE_REFUSE_AFTER_HOURS + 1),
      transport,
      CONFIG,
      ['sales-queue@wewin.test', ADMIN],
    ).check(NOW);

    expect(outcome.sent).toBe(2);
    expect(addressesOf(transport)).toStrictEqual(['sales-queue@wewin.test', ADMIN]);
  });

  /**
   * ⭐ THE EMPTY SET — the condition this whole phase exists to stop being silent.
   *
   * Nobody active holds `organisation.write` with a primary address, so the people who could
   * enter a manual rate cannot be reached. The sales queue still gets its copy, because somebody
   * being told beats nobody — but `authorised: 0` records that no *administrator* was, and that
   * is the number `GET /admin/fx/health` reports so the organisation screen can say it in Thai.
   *
   * ⚠️ The assertion that matters is `authorised: 0` **beside** `sent: 1`. A version that let the
   * sales copy count as success would report this state as a warning delivered, which is the
   * silent failure wearing the costume of a working alarm.
   */
  it('records that nobody authorised was reached, while still telling the sales queue', async () => {
    const transport = new RecordingTransport();

    const outcome = await serviceWith(
      healthAged(FX_RATE_REFUSE_AFTER_HOURS + 1),
      transport,
      CONFIG,
      [],
    ).check(NOW);

    expect(outcome).toStrictEqual({ status: 'blocked', authorised: 0, sent: 1 });
    expect(addressesOf(transport)).toStrictEqual(['sales-queue@wewin.test']);
  });

  /**
   * ⚠️ And it never invents a recipient to fill the gap. No holders and no configured queue
   * means no send at all — a hardcoded fallback address would be a warning going somewhere
   * nobody agreed to, which is worse than a loud nothing.
   */
  it('sends nothing at all when there is no holder and no queue', async () => {
    const transport = new RecordingTransport();

    const outcome = await serviceWith(
      healthAged(FX_RATE_REFUSE_AFTER_HOURS + 1),
      transport,
      { from: CONFIG.from, salesQueue: undefined },
      [],
    ).check(NOW);

    expect(outcome).toStrictEqual({ status: 'blocked', authorised: 0, sent: 0 });
    expect(transport.sent).toHaveLength(0);
  });

  /**
   * A permission read that throws degrades to "nobody authorised" rather than taking the whole
   * run down — the sales queue is still told, and the `authorised: 0` alarm is raised. Silence
   * would be the one outcome that reports a stale rate to nobody at all.
   */
  it('still warns the sales queue when the permission read itself fails', async () => {
    const transport = new RecordingTransport();
    const broken = {
      addressesHolding: async () => {
        throw new Error('connection terminated');
      },
    } as unknown as PermissionRepository;

    const outcome = await new FxStalenessService(
      repositoryOf(healthAged(FX_RATE_REFUSE_AFTER_HOURS + 1)),
      broken,
      transport,
      CONFIG,
    ).check(NOW);

    expect(outcome).toStrictEqual({ status: 'blocked', authorised: 0, sent: 1 });
    expect(addressesOf(transport)).toStrictEqual(['sales-queue@wewin.test']);
  });

  /**
   * One dead mailbox must not silence the others. The send loop catches per recipient, so a
   * transport that refuses the first address still delivers the second — the alternative is that
   * one stale staff account suppresses the warning for everybody.
   */
  it('keeps going when one recipient refuses', async () => {
    class RefusesFirst implements EmailTransport {
      readonly name = 'refuses-first';
      readonly sent: OutgoingEmail[] = [];
      async send(email: OutgoingEmail): Promise<string | undefined> {
        if (email.to === 'aoy@wewin.test') throw new Error('mailbox unavailable');
        this.sent.push(email);
        return 'ok';
      }
    }
    const transport = new RefusesFirst();

    const outcome = await serviceWith(
      healthAged(FX_RATE_REFUSE_AFTER_HOURS + 1),
      transport,
      CONFIG,
      ['aoy@wewin.test', 'nok@wewin.test'],
    ).check(NOW);

    expect(outcome).toStrictEqual({ status: 'blocked', authorised: 2, sent: 2 });
    expect(transport.sent.map((e) => e.to)).toContain('nok@wewin.test');
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

    const outcome = await new FxStalenessService(broken, peopleOf([ADMIN]), transport, CONFIG).check(NOW);

    /* `'unknown'`, not `'ok'`: a health read that failed is neither healthy nor stale, and
       reporting it as the former is how a broken check looks like a working one. */
    expect(outcome).toStrictEqual({ status: 'unknown', authorised: 0, sent: 0 });
    expect(transport.sent).toHaveLength(0);
  });
});
