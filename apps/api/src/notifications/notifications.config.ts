import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NOTIFICATION_MAX_ATTEMPTS_DEFAULT } from '@wewin/db/schema';
import { z } from 'zod';

/**
 * How the outbox is delivered, parsed in this module rather than in `src/config/env.ts`.
 *
 * Same precedent and same reason as `parseMediaConfig` and `parseOAuthConfig`: `Env` is
 * frozen, logged in parts and handed whole to every module in the graph, and an SMTP
 * password belongs in none of those places. Keeping the parse here also means the outbox
 * is one directory — delete it and nothing else in the app has a dangling variable.
 *
 * ── ⚠️ THE NUMBERS BELOW ARE PLAN 13 DEFAULTS, NOT DECISIONS ─────────────────
 *
 * Plan section 13 lists the notification row as unanswered: *does the company use LINE OA
 * (it costs per push), what is the coalescing window, how many retries before `dead`*. Its
 * default column says **email only · coalesce 10 minutes · retry 5 times with exponential
 * backoff**. Two of those three live in the database (`notification_rules.coalesce_seconds`
 * and the seeded rules, both in `packages/db`), because they are policy a person edits with
 * an UPDATE. The third — how many attempts, and how far apart — lives here, because it is
 * about this process's patience rather than about the business.
 *
 * `NOTIFICATIONS_MAX_ATTEMPTS` defaults to `NOTIFICATION_MAX_ATTEMPTS_DEFAULT`, imported
 * rather than restated, so plan 13's number exists once in the repository. The backoff
 * shape is *not* in plan 13 at all — only the word "exponential" — so 60 s doubling to a
 * one-hour ceiling is this module's own default and is marked as such below and in
 * backoff.ts.
 *
 * ── The variables ────────────────────────────────────────────────────────────
 *
 *   NOTIFICATIONS_WORKER_ENABLED        default: on, except under NODE_ENV=test
 *   NOTIFICATIONS_POLL_INTERVAL_MS      5000
 *   NOTIFICATIONS_BATCH_SIZE            20
 *   NOTIFICATIONS_MAX_ATTEMPTS          5        ⚠️ plan 13 default
 *   NOTIFICATIONS_RETRY_BASE_MS         60000    ⚠️ this module's default
 *   NOTIFICATIONS_RETRY_MAX_MS          3600000  ⚠️ this module's default
 *   NOTIFICATIONS_CLAIM_LEASE_MS        120000
 *   NOTIFICATIONS_EMAIL_TRANSPORT       file | smtp | resend
 *   NOTIFICATIONS_EMAIL_FROM            wewin <no-reply@wewin.local>
 *   NOTIFICATIONS_EMAIL_DIR             <tmp>/wewin-mail        (file transport only)
 *   NOTIFICATIONS_SMTP_HOST/_PORT/_SECURE/_USER/_PASSWORD       (smtp transport only)
 *   RESEND_API_KEY                      required when NOTIFICATIONS_EMAIL_TRANSPORT=resend,
 *                                        otherwise read by nothing. Not namespaced under
 *                                        NOTIFICATIONS_ because it is the account's one key,
 *                                        not a setting of this outbox — same reasoning as
 *                                        OPENEXCHANGERATES_APP_ID in src/fx.
 *   NOTIFICATIONS_WEB_BASE_URL          storefront origin, for the quotation link in a message
 *   NOTIFICATIONS_SALES_QUEUE_EMAIL     where `group:sales_queue` is delivered
 *   NOTIFICATIONS_APPROVER_QUEUE_EMAIL  where `group:approver_queue` is delivered
 *   NOTIFICATIONS_LINE_CHANNEL_ACCESS_TOKEN   absent ⇒ no LINE adapter is constructed
 */

const positiveInt = (fallback: number) =>
  z
    .string()
    .regex(/^\d+$/, 'must be a whole number')
    .transform(Number)
    .refine((value) => value > 0, { message: 'must be greater than zero' })
    .default(fallback);

const flag = z.enum(['true', 'false']).transform((value) => value === 'true');

/**
 * Deliberately loose, and it is worth saying why rather than reaching for a stricter one.
 *
 * Postgres already enforces the real shape on `orders.contact_email`
 * (`orders_contact_email_shape`), which is where a customer's address comes from. This
 * validates the two operational addresses an operator types into a deployment — a
 * mistyped one should stop the boot, and a regex that argues about RFC 5321 corner cases
 * would stop it for the wrong reason.
 */
const address = z
  .string()
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'must be an email address')
  .transform((value) => value.toLowerCase());

/** Local stand-ins, unmistakable for real mailboxes. Refused in production — see below. */
const LOCAL_SALES_QUEUE = 'sales-queue@wewin.local';
const LOCAL_APPROVER_QUEUE = 'approver-queue@wewin.local';

const schema = z.object({
  NODE_ENV: z.string().default('development'),

  NOTIFICATIONS_WORKER_ENABLED: flag.optional(),
  /*
   * Five seconds. The outbox is not a real-time bus: everything in it has already been
   * committed, and the coalescing window in front of it is ten minutes wide, so a poll
   * that is a few seconds late costs nothing a customer can perceive. Shorter would spend
   * a connection on an empty query all day.
   */
  NOTIFICATIONS_POLL_INTERVAL_MS: positiveInt(5_000),
  NOTIFICATIONS_BATCH_SIZE: positiveInt(20),
  NOTIFICATIONS_MAX_ATTEMPTS: positiveInt(NOTIFICATION_MAX_ATTEMPTS_DEFAULT),
  NOTIFICATIONS_RETRY_BASE_MS: positiveInt(60_000),
  NOTIFICATIONS_RETRY_MAX_MS: positiveInt(3_600_000),
  /*
   * How long a claimed row may sit in `sending` before another worker may take it back.
   *
   * This is the answer to the one failure the outbox would otherwise still have: the
   * process is killed between claiming a row and recording the attempt, and the row stays
   * `sending` forever — invisible, never retried, and *not* in the dead queue, which is
   * precisely plan 10.5(3)'s "the company believes the customer was told". Two minutes is
   * comfortably longer than any single SMTP conversation and short enough that a restart
   * recovers within one deploy.
   */
  NOTIFICATIONS_CLAIM_LEASE_MS: positiveInt(120_000),

  /**
   * ⭐ Where the storefront is, so a customer message can link to the document it is about.
   *
   * ⚠️ **Optional, and unset means no link rather than no message.** A deployment that forgot
   * this still tells customers their order was received; it just cannot show them the
   * quotation. Failing the boot instead would trade a degraded email for no email at all,
   * which is the wrong way round for a notification system — and `templates.ts` renders the
   * absence as *nothing*, never as a sentence with a hole in it.
   *
   * Not shared with `OAUTH_WEB_BASE_URL`. That one is where a *browser mid-sign-in* gets
   * redirected and defaults to a dev port that is not this app; this one goes in an email a
   * customer keeps for months. Two different lifetimes and two different consequences for
   * getting it wrong, so two variables.
   */
  NOTIFICATIONS_WEB_BASE_URL: z
    .string()
    .url()
    .optional()
    /* One trailing slash stripped: every URL here is `base + '/something'`. */
    .transform((value) => value?.replace(/\/+$/u, '')),

  /*
   * `resend` added alongside `file` and `smtp`. `file` stays the default so a developer
   * with no Resend account still boots and runs the suite — see the check below, which
   * refuses `resend` outright when RESEND_API_KEY is absent rather than constructing a
   * transport that would fail on its first send.
   */
  NOTIFICATIONS_EMAIL_TRANSPORT: z.enum(['file', 'smtp', 'resend']).default('file'),
  /**
   * ⚠️ The `resend` decision: this one variable is `from` for every transport, and stays
   * that way. Resend gets no `RESEND_FROM` of its own.
   *
   * Resend requires the domain in `from` to be verified in its dashboard, and enforces that
   * at *send* time — there is no API to ask "is this domain verified" at boot, so
   * `parseNotificationsConfig` cannot refuse an unverified one the way it refuses a
   * malformed queue address. An unverified `from` is therefore a `403` on the first real
   * send (see resend.transport.ts for the exact body, read by observation against the real
   * API), which `ResendEmailTransport` classifies as permanent — it will not become verified
   * by the outbox retrying five times in an hour. What happens next is the *caller's*
   * decision, already made for each of the two today: `EmailChannelAdapter` sends it to the
   * dead queue, visibly; `PasswordResetService` logs it and still answers the customer
   * `{ accepted: true }`, matching every other reset outcome. Neither is new: this is the
   * exact path a wrong SMTP password already takes.
   */
  NOTIFICATIONS_EMAIL_FROM: z.string().min(1).default('wewin <no-reply@wewin.local>'),
  /*
   * The temp directory and not the repository. A mail drop inside the checkout is a
   * directory that ends up in a commit, and .gitignore is not this module's file to edit.
   * The absolute path is logged when the transport is constructed, so it is discoverable
   * without reading this comment.
   */
  NOTIFICATIONS_EMAIL_DIR: z.string().min(1).default(join(tmpdir(), 'wewin-mail')),

  NOTIFICATIONS_SMTP_HOST: z.string().min(1).default('127.0.0.1'),
  NOTIFICATIONS_SMTP_PORT: positiveInt(1025),
  /** Implicit TLS (port 465 style). STARTTLS is deliberately not implemented — see smtp.transport.ts. */
  NOTIFICATIONS_SMTP_SECURE: flag.default(false),
  NOTIFICATIONS_SMTP_USER: z.string().min(1).optional(),
  NOTIFICATIONS_SMTP_PASSWORD: z.string().min(1).optional(),

  /**
   * Resend's account key. Optional at the schema level — a deployment that never selects
   * `resend` must not be forced to have one — and required by the check below the moment
   * `NOTIFICATIONS_EMAIL_TRANSPORT=resend` is actually chosen.
   */
  RESEND_API_KEY: z.string().min(1).optional(),

  NOTIFICATIONS_SALES_QUEUE_EMAIL: address.optional(),
  NOTIFICATIONS_APPROVER_QUEUE_EMAIL: address.optional(),

  NOTIFICATIONS_LINE_CHANNEL_ACCESS_TOKEN: z.string().min(1).optional(),
  NOTIFICATIONS_LINE_API_BASE: z.string().url().default('https://api.line.me'),
});

export interface SmtpSettings {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly user: string | undefined;
  readonly password: string | undefined;
}

export interface NotificationsConfig {
  readonly workerEnabled: boolean;
  readonly pollIntervalMs: number;
  readonly batchSize: number;
  readonly maxAttempts: number;
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
  readonly claimLeaseMs: number;

  /** Storefront origin, without a trailing slash. `undefined` means messages carry no link. */
  readonly webBaseUrl: string | undefined;

  readonly emailTransport: 'file' | 'smtp' | 'resend';
  readonly emailFrom: string;
  readonly emailDir: string;
  readonly smtp: SmtpSettings;
  /** `undefined` unless `RESEND_API_KEY` is set — required when `emailTransport` is `'resend'`. */
  readonly resendApiKey: string | undefined;

  /**
   * Where a `group:` recipient key is delivered.
   *
   * The fan-out writes `group:sales_queue` because at the moment the event commits nobody
   * knows which human is on shift — that is a deployment fact, not an order fact. Resolving
   * it here rather than in the database keeps "who is on the rota" out of a migration.
   */
  readonly queueAddresses: Readonly<Record<'sales_queue' | 'approver_queue', string | undefined>>;

  readonly line: { readonly accessToken: string | undefined; readonly apiBase: string };
}

export class NotificationsConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(['Invalid notification configuration:', ...problems.map((problem) => `  - ${problem}`)].join('\n'));
    this.name = 'NotificationsConfigError';
    this.problems = problems;
  }
}

export function parseNotificationsConfig(source: Record<string, string | undefined>): NotificationsConfig {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    throw new NotificationsConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`),
    );
  }

  const data = parsed.data;
  const production = data.NODE_ENV === 'production';
  const problems: string[] = [];

  if (data.NOTIFICATIONS_RETRY_MAX_MS < data.NOTIFICATIONS_RETRY_BASE_MS) {
    problems.push('NOTIFICATIONS_RETRY_MAX_MS must not be smaller than NOTIFICATIONS_RETRY_BASE_MS');
  }

  /*
   * Not gated on `production`: a boot with no Resend account is exactly the case `file`'s
   * default exists to protect, and choosing `resend` without a key is a plausible-and-wrong
   * mistake in every environment, not only that one — the class this whole function exists
   * to catch before the first send rather than at it.
   */
  if (data.NOTIFICATIONS_EMAIL_TRANSPORT === 'resend' && data.RESEND_API_KEY === undefined) {
    problems.push('NOTIFICATIONS_EMAIL_TRANSPORT=resend requires RESEND_API_KEY');
  }

  /*
   * Production refuses the local stand-ins outright. A queue address that happens to be
   * right on somebody's laptop is how "รอตรวจสลิป" ends up delivered to a domain nobody
   * owns — and unlike a wrong customer address, nobody complains, because the person who
   * should have complained is the one who never got the message.
   */
  if (production) {
    if (data.NOTIFICATIONS_SALES_QUEUE_EMAIL === undefined) {
      problems.push('NOTIFICATIONS_SALES_QUEUE_EMAIL is required in production: plan 10.3 sends slip and cancellation notices to sales, and an unroutable queue is a queue nobody reads');
    }
    if (data.NOTIFICATIONS_EMAIL_TRANSPORT === 'file') {
      problems.push('NOTIFICATIONS_EMAIL_TRANSPORT=file writes messages to a directory instead of sending them; it exists for local development only');
    }
    if (!data.NOTIFICATIONS_SMTP_SECURE && data.NOTIFICATIONS_SMTP_USER !== undefined) {
      problems.push('NOTIFICATIONS_SMTP_USER is set with NOTIFICATIONS_SMTP_SECURE=false, which would send the password in the clear');
    }
  }

  if (problems.length > 0) throw new NotificationsConfigError(problems);

  return {
    /*
     * On everywhere except under the test runner, where a background poller would race
     * every suite that boots the graph. `bootApp()` builds the real module list, so the
     * default has to make that safe; an explicit `true` still wins, which is how the
     * worker's own suite turns it back on.
     */
    workerEnabled: data.NOTIFICATIONS_WORKER_ENABLED ?? data.NODE_ENV !== 'test',
    pollIntervalMs: data.NOTIFICATIONS_POLL_INTERVAL_MS,
    batchSize: data.NOTIFICATIONS_BATCH_SIZE,
    maxAttempts: data.NOTIFICATIONS_MAX_ATTEMPTS,
    retryBaseMs: data.NOTIFICATIONS_RETRY_BASE_MS,
    retryMaxMs: data.NOTIFICATIONS_RETRY_MAX_MS,
    claimLeaseMs: data.NOTIFICATIONS_CLAIM_LEASE_MS,

    webBaseUrl: data.NOTIFICATIONS_WEB_BASE_URL,
    emailTransport: data.NOTIFICATIONS_EMAIL_TRANSPORT,
    emailFrom: data.NOTIFICATIONS_EMAIL_FROM,
    emailDir: data.NOTIFICATIONS_EMAIL_DIR,
    resendApiKey: data.RESEND_API_KEY,
    smtp: {
      host: data.NOTIFICATIONS_SMTP_HOST,
      port: data.NOTIFICATIONS_SMTP_PORT,
      secure: data.NOTIFICATIONS_SMTP_SECURE,
      user: data.NOTIFICATIONS_SMTP_USER,
      password: data.NOTIFICATIONS_SMTP_PASSWORD,
    },

    queueAddresses: {
      sales_queue: data.NOTIFICATIONS_SALES_QUEUE_EMAIL ?? (production ? undefined : LOCAL_SALES_QUEUE),
      approver_queue:
        data.NOTIFICATIONS_APPROVER_QUEUE_EMAIL ?? (production ? undefined : LOCAL_APPROVER_QUEUE),
    },

    line: {
      accessToken: data.NOTIFICATIONS_LINE_CHANNEL_ACCESS_TOKEN,
      apiBase: data.NOTIFICATIONS_LINE_API_BASE.replace(/\/+$/, ''),
    },
  };
}
