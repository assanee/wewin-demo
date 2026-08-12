import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { Database } from '@wewin/db/client';
import { fxRates } from '@wewin/db/schema';
import type { FxManualSyncBudgetWire, FxManualSyncResultWire } from '@wewin/contract/organisation';

import { AppError } from '../common/errors/app-error';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { DRIZZLE } from '../database/database.tokens';
import { count as countParam, message } from '../i18n';
import { FxHttp, FxHttpError } from './fx-http';
import {
  FxRatesRepository,
  type FxSnapshotRow,
  type FxSyncStage,
  type FxSyncTriggerKind,
} from './fx-rates.repository';
import { parseLatestRates } from './latest-rates';
import {
  FX_MANUAL_SYNC_DAILY_LIMIT,
  FX_MANUAL_SYNC_WINDOW_HOURS,
  manualSyncBudget,
  manualSyncRetryAfterSeconds,
} from './manual-sync';

/**
 * Ingests Open Exchange Rates' `latest.json` into `fx_rates` — and does nothing else.
 *
 * **Ingestion only.** Nothing here converts money. THB→SGD, or any other pair, needs
 * business decisions nobody has made yet (which pair, which rounding, which moment counts
 * as "the" rate for a quotation) — see the header on `fx_rates`
 * (`packages/db/src/schema/fx.ts`) for why the whole response is stored rather than a
 * computed figure. This service's entire job is bringing the provider's numbers in
 * honestly, with both timestamps attached, and leaving them for whoever makes that
 * decision to read back.
 *
 * ── Daily, and why that number and not a smaller one ──────────────────────────────
 *
 * The free Open Exchange Rates plan allows 1,000 requests a month. Daily is ~30 of those —
 * roughly 970 spare every month, which is the point: a failed fetch (see "Failure
 * handling" below) can be retried on the next tick, or by hand, without quota anxiety.
 * Hourly used to be ~730 a month, which fit too, but left no such room.
 *
 * The stronger reason is on the consuming side, not the provider's. Nothing reads
 * `fx_rates` yet, but what will read it is a quotation the staff confirm — see the header
 * on `fx_rates` (`packages/db/src/schema/fx.ts`) — and a confirmed quotation is a document
 * whose life is measured in days, not minutes. Hourly freshness bought nothing for a rate
 * that gets pinned once and then sits for days; it only spent quota re-observing a number
 * that, per the free plan's own hourly update cadence, usually had not even changed.
 *
 * `CronExpression.EVERY_DAY_AT_1AM` — 01:00 server time — is a choice, not a discovery:
 * Open Exchange Rates' free plan updates hourly and USD trades in a market that is
 * effectively continuous, so no moment in the day is "the" correct one to read it at. This
 * repo sets `TZ` nowhere (`docker-compose.yml`, every `.env*`) and containers default to
 * UTC, so 01:00 here is 08:00 in Bangkok — `overview/business-month.ts`'s
 * `BUSINESS_TIME_ZONE`, and where the staff who confirm quotations actually work — which
 * puts the fetch just ahead of the working day rather than in the middle of it, so the
 * rate on hand when staff arrive is at most a few hours old rather than one fetched
 * mid-afternoon the day before. Do not tighten the schedule below without re-reading the
 * quota and staleness reasoning above; they are why the number is what it is, not a
 * preference that happened to land here.
 *
 * ── Startup fetch ─────────────────────────────────────────────────────────────────
 *
 * `onModuleInit` fetches once, but only when `fx_rates` is still empty, so a fresh
 * environment is not blank for the first day rather than because startup fetching is
 * generally safe to repeat — it is not what runs on every restart.
 *
 * ── ⭐ THE MANUAL SYNC, and why it does not contradict the paragraph above ────────
 *
 * `syncNow` fetches on demand, from a button on the organisation screen. That is exactly the
 * "tightening" the schedule paragraph refuses — moved out of a cron expression and into a
 * person's hands, where it has no upper bound at all — so it is allowed only with the bound
 * supplied separately, and `manual-sync.ts` is that bound: ten per rolling twenty-four hours,
 * and no two closer together than a minute. The arithmetic against the provider's 1,000-a-month
 * plan, and the argument for why the count lives in the database rather than in this process's
 * memory, are both in that file's header.
 *
 * ⚠️ **The schedule itself is untouched.** `@Cron(EVERY_DAY_AT_1AM)` still says what it said, and
 * nothing above this line changed: the button does not shorten the interval, it adds a *bounded*
 * number of extra reads on top of it. That distinction is the whole reason this is acceptable
 * where tightening the cron would not be — a tightened cron spends its extra quota every day
 * forever, and this spends it only on the days somebody had a reason to.
 *
 * ⚠️ **It is frequently a no-op that still costs, and the caller is told so.** The free plan
 * updates hourly, so a manual sync minutes after the last one fetches the *same observation*,
 * appends a row, and moves nothing. `fetchAndStore` reports that back as `'unchanged'` rather
 * than as a success, because a green tick over a number that did not move is how staff learn the
 * button works when it did not. The row is still written and the request was still spent — see
 * `FxSyncOutcome`.
 *
 * ── Failure handling ──────────────────────────────────────────────────────────────
 *
 * A failed fetch is **recorded and** left for the next tick — no retry loop, no crash.
 * `FxHttp` never hands this class a URL or a response body to log (see that file), so what
 * gets logged here is a status code at most — never anything that could carry `app_id`.
 *
 * ⚠️ **"Recorded" is new, and the sentence that used to be here was the bug.** It read:
 * *"Nothing downstream reads `fx_rates` yet, so a failed fetch is not an outage."* That
 * stopped being true the moment `QuotationRateService` started pricing quotations from this
 * table — a failed fetch is now a quotation converted at an older rate, pinned by
 * `order_documents_freeze`, and correctable never. The trade itself is still right: a
 * provider outage should cost freshness rather than availability, which is the owner's cache
 * rule. What was missing was any way to tell a *little* freshness from a *lot* of it, because
 * a warning line is not a record and the only trace of a failed sync was the row that did not
 * appear. `record` below writes that trace to `fx_sync_failures`; `staleness.ts` decides when
 * the accumulated freshness cost has stopped being acceptable.
 *
 * **The database calls get the identical trade, on purpose.** `onModuleInit`'s "is the
 * table empty" read and `fetchAndStore`'s insert are both wrapped rather than left to
 * throw — the same reasoning `DatabaseService.probe` (`database/database.service.ts`)
 * already states for the connection itself: "an unreachable database is usually a
 * database that is still starting, and a service that exits on it turns a ten-second
 * outage into a crash loop." `OnModuleInit` is awaited by Nest, so an uncaught rejection
 * here would propagate out of `NestFactory.create()` and take the whole app down at boot
 * — over a table nothing reads. Wrapping the insert also matters for the daily tick:
 * unguarded, `@nestjs/schedule`'s own explorer would still catch it, but through a
 * generic `'Scheduler'` logger carrying the raw driver error, not through the deliberately
 * narrow logging the rest of this class uses. Both paths report through `this.logger`.
 *
 * ── The missing-key case ──────────────────────────────────────────────────────────
 *
 * `OPENEXCHANGERATES_APP_ID` is optional (`config/env.ts`): a developer without an OXR
 * account still has to be able to boot this app and run its suite. Its absence is logged
 * once, in the constructor, and never again — every scheduled tick and the startup check
 * both return immediately and silently, so a fleet running without the key produces one
 * boot-time line rather than a daily warning for the life of the process.
 */
/**
 * ⭐ What one sync did — and `'unchanged'` is the arm this type exists for.
 *
 * `fetchAndStore` used to return `void`, which was right while nobody was watching: the daily
 * tick logs and shrugs, and there was no caller with a screen to answer. A person pressing a
 * button is a caller with a screen, and "it worked" is not what they need to know. They need to
 * know whether the *number moved*, and on the free plan — hourly updates, a button somebody may
 * press twice in five minutes — the honest answer is usually that it did not.
 *
 * ⚠️ `'unchanged'` is a success at every level except the one that matters. The request was made,
 * the quota was charged, a row was appended, `fetchedAt` moved and `consecutiveFailures` reset.
 * The only thing that did not change is the observation, which is the only thing anybody pressed
 * the button for. Collapsing it into `'stored'` would be the exact mis-signal this round is
 * about, one layer down from the one the health card already fixed.
 */
export type FxSyncOutcome =
  | { readonly kind: 'stored'; readonly observedAt: Date }
  | { readonly kind: 'unchanged'; readonly observedAt: Date }
  | { readonly kind: 'failed'; readonly stage: FxSyncStage }
  | { readonly kind: 'disabled' };

@Injectable()
export class FxRatesService implements OnModuleInit {
  private readonly logger = new Logger(FxRatesService.name);
  private readonly appId: string | undefined;

  constructor(
    @Inject(ENV) env: Env,
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly http: FxHttp,
    /* Was `failures`, when recording one was all this class asked of it. It now also reads the
     * newest observation (to tell a moved number from a repeated one) and the manual-sync usage
     * (to bound the button), so the name is the repository rather than one of its methods. */
    private readonly repository: FxRatesRepository,
  ) {
    this.appId = env.OPENEXCHANGERATES_APP_ID;
    if (this.appId === undefined) {
      this.logger.warn(
        'OPENEXCHANGERATES_APP_ID is not set; exchange-rate ingestion is disabled. ' +
          'The app boots and the test suite runs regardless — set the key to start daily fetching.',
      );
    }
  }

  async onModuleInit(): Promise<void> {
    if (this.appId === undefined) return;

    let existing: { id: string }[];
    try {
      existing = await this.db.select({ id: fxRates.id }).from(fxRates).limit(1);
    } catch (error) {
      // See the class header: refusing to boot over this would turn a database that is
      // still starting into a crash loop, over a table nothing reads. The regular daily
      // tick still runs and will fill an empty table once the database is reachable.
      this.logger.warn(
        `could not check whether fx_rates is empty (${dbFailureReason(error)}); skipping the startup fetch`,
      );
      return;
    }
    if (existing.length > 0) return;

    this.logger.log(
      'fx_rates is empty; fetching once at startup so a fresh environment is not blank for a day.',
    );
    await this.fetchAndStore(this.appId, 'startup', undefined);
  }

  @Cron(CronExpression.EVERY_DAY_AT_1AM)
  async fetchDaily(): Promise<void> {
    if (this.appId === undefined) return;
    await this.fetchAndStore(this.appId, 'scheduled', undefined);
  }

  /**
   * ⭐ A fetch a person asked for — the whole of the manual sync, guard included.
   *
   * ⚠️ **The guard is here and not in the controller, and that placement is the invariant.**
   * `FxRatesService` is the only thing in the app that can reach `FxHttp` (`fx.module.ts` keeps
   * it unexported for exactly that reason), so a guard on this method is a guard on *every*
   * on-demand provider request there can be. A controller-side check would be a guard on one
   * URL, and the next caller — a second route, a CLI, a test that meant well — would spend the
   * quota without passing it.
   *
   * ⚠️ **Refuses by throwing, and answers `'failed'` by returning.** Those are different things
   * and a caller must not have to squint at them. A throttled press did not happen: nothing was
   * fetched, nothing was spent, nothing was recorded, and 429 is the honest status. A failed
   * fetch *did* happen: a request was spent, a row went into `fx_sync_failures`, and the screen
   * has something to report. Collapsing the two would either charge somebody's quota for a press
   * that was refused, or report a provider outage as a rate limit.
   *
   * ⚠️ **A failed manual fetch is recorded exactly as a failed scheduled one is** — same
   * `fx_sync_failures` row, same stage vocabulary, same `consecutiveFailures` arithmetic — and
   * that is the point of routing it through the same `fetchAndStore`. The tempting shortcut is
   * to swallow it because a human is watching and will see the error on screen; that human then
   * closes the tab, and the outage is invisible again to the one table built to make it
   * countable. The only difference between the two paths is `trigger_kind`.
   */
  async syncNow(now: Date): Promise<FxManualSyncResultWire> {
    const budget = manualSyncBudget(await this.repository.manualSyncUsage(now), now);
    if (budget.nextAllowedAt !== null) throw throttled(budget, now);

    const before = await this.repository.latest();
    const outcome =
      this.appId === undefined
        ? ({ kind: 'disabled' } as const)
        : await this.fetchAndStore(this.appId, 'manual', before);

    return {
      outcome: outcome.kind,
      observedAt: observedAtOf(outcome, before),
      previousObservedAt: before?.rateTimestamp.toISOString() ?? null,
      failureStage: outcome.kind === 'failed' ? outcome.stage : null,
      /*
       * Re-read rather than adjusted by one. The attempt has just written a row into one of the
       * two tables this count is derived from, so reading it back is what makes the figure on the
       * screen the figure the *next* press will be judged against — an arithmetic guess would be
       * a second opinion about a number the database already holds, and the one case it would get
       * wrong is `'disabled'`, where nothing was written and nothing should be charged.
       */
      manualSync: manualSyncBudget(await this.repository.manualSyncUsage(now), now),
    };
  }

  /**
   * @param previous the newest observation *before* this fetch, for telling a moved number from a
   * repeated one. `undefined` on the two scheduled paths, which have nobody to tell.
   */
  private async fetchAndStore(
    appId: string,
    triggerKind: FxSyncTriggerKind,
    previous: FxSnapshotRow | undefined,
  ): Promise<FxSyncOutcome> {
    let body: unknown;
    try {
      body = await this.http.getLatest(appId);
    } catch (error) {
      const status = error instanceof FxHttpError ? error.status : undefined;
      const detail = status === undefined ? 'unreachable' : `status ${String(status)}`;
      this.logger.warn(
        `exchange-rate fetch failed${status === undefined ? '' : ` (status ${String(status)})`}; will retry on the next tick`,
      );
      await this.record('fetch', detail, triggerKind);
      return { kind: 'failed', stage: 'fetch' };
    }

    const parsed = parseLatestRates(body);
    if (!parsed.ok) {
      this.logger.warn(`exchange-rate fetch returned a malformed body (${parsed.reason}); storing nothing`);
      await this.record('parse', parsed.reason, triggerKind);
      return { kind: 'failed', stage: 'parse' };
    }

    const observedAt = new Date(parsed.value.timestamp * 1000);

    try {
      await this.db.insert(fxRates).values({
        rateTimestamp: observedAt,
        base: parsed.value.base,
        rates: parsed.value.rates,
        source: 'openexchangerates',
        triggerKind,
      });
    } catch (error) {
      this.logger.warn(`could not store the fetched rates (${dbFailureReason(error)}); will retry on the next tick`);
      await this.record('store', dbFailureReason(error), triggerKind);
      return { kind: 'failed', stage: 'store' };
    }

    /*
     * ⭐ Did the number move? Compared on `rate_timestamp` — the provider's own "when I struck
     * this" — and never on `fetched_at`, which moves on every request by construction and would
     * therefore report every sync as new.
     *
     * ⚠️ The row is appended either way, and that is not laziness. It is the *same statement* the
     * scheduled path runs, so the two paths cannot store differently; `fx_rates` is append-only
     * so a repeated observation is honest history rather than a duplicate; and the fresh
     * `fetched_at` is what resets `consecutiveFailures`, which is a real thing that just became
     * true — the provider answered. Only the observation is unchanged, and only that is reported.
     */
    return {
      kind:
        previous !== undefined && previous.rateTimestamp.getTime() === observedAt.getTime()
          ? 'unchanged'
          : 'stored',
      observedAt,
    };
  }

  /**
   * ⭐ The failure, written down — which is the whole point of this round.
   *
   * Each of the three `return`s above used to be a `logger.warn` and nothing else, and that is
   * precisely how a three-week outage stayed invisible: the evidence of a failed sync was an
   * *absence* of an `fx_rates` row, and an absence is ambiguous. A row here makes the run
   * countable, and `FxRatesRepository.health` counts it against the newest success.
   *
   * ⚠️ **Swallows its own failure, and must.** This is called from three paths that are
   * already handling a failure, one of which is *"the database would not take the rates"* —
   * so the database is exactly the thing that may be unavailable when we try to record that it
   * was. Rethrowing would convert a logged, retryable sync failure into an unhandled rejection
   * inside a `@Cron` handler, and on the `onModuleInit` path into a boot crash: the same trade
   * this class's header already argues for the insert itself, and for the same reason —
   * *"a service that exits on it turns a ten-second outage into a crash loop"*.
   *
   * The consequence, said out loud: `consecutiveFailures` is a **lower bound**. A failure we
   * could not write down is a failure that does not appear in the count. That is the honest
   * direction for it to be wrong in — it under-reports an outage rather than inventing one —
   * and the age check in `staleness.ts` does not depend on this table at all, so the refusal
   * still fires on a rate's own timestamp even if every failure row went missing.
   */
  private async record(
    stage: FxSyncStage,
    detail: string,
    triggerKind: FxSyncTriggerKind,
  ): Promise<void> {
    try {
      await this.repository.recordFailure(stage, detail, triggerKind);
    } catch (error) {
      this.logger.warn(`could not record the failed sync (${dbFailureReason(error)})`);
    }
  }
}

/**
 * The observation the caller should be told about, after the attempt.
 *
 * On `'failed'` and `'disabled'` nothing landed, so the honest answer is the one that was already
 * there — not `null`, which would read as "there is no rate" on a card whose whole subject is
 * whether there is one. A failed manual sync leaves the system holding exactly what it held
 * before, and saying so is the difference between "that did not work" and "you have broken it".
 */
function observedAtOf(outcome: FxSyncOutcome, before: FxSnapshotRow | undefined): string | null {
  if (outcome.kind === 'stored' || outcome.kind === 'unchanged') {
    return outcome.observedAt.toISOString();
  }

  return before?.rateTimestamp.toISOString() ?? null;
}

/**
 * ⭐ The refusal — two sentences, because the two limits are two different facts.
 *
 * `remainingToday === 0` is *"the budget for the day is spent"*, which is about the provider's
 * monthly plan and about a decision somebody should make deliberately tomorrow. A non-zero
 * remainder with a future `nextAllowedAt` is *"that was a moment ago"*, which is about a
 * double-click and is over in under a minute. One sentence covering both would have to be vague
 * about which, and the reader's next action is completely different: wait, or stop.
 *
 * 429 and not 403: nothing about this caller is refused. `TOO_MANY_REQUESTS` exists in
 * `ERROR_CODES` for exactly this distinction — see the note there — and a client that read a rate
 * limit as a permission failure would stop retrying something that will work in forty seconds.
 *
 * `retryAfterSeconds` travels in `details`, the same shape `PasswordSignInService` uses, and not
 * as a `Retry-After` header: setting one needs `@Res` in the controller, which no handler in this
 * app takes. The screen reads the budget off `GET /admin/fx/health` anyway, where it is a
 * timestamp rather than a duration and does not go stale in a tab left open.
 */
function throttled(budget: FxManualSyncBudgetWire, now: Date): AppError {
  const retryAfterSeconds = manualSyncRetryAfterSeconds(budget, now) ?? 1;
  const details = {
    reason: 'fx_manual_sync_throttled',
    retryAfterSeconds,
    usedToday: budget.usedToday,
    dailyLimit: budget.dailyLimit,
    nextAllowedAt: budget.nextAllowedAt,
  };

  if (budget.remainingToday === 0) {
    return new AppError(
      'TOO_MANY_REQUESTS',
      429,
      message('error.fx.manual_sync_quota_spent', {
        limit: countParam(FX_MANUAL_SYNC_DAILY_LIMIT),
        hours: countParam(FX_MANUAL_SYNC_WINDOW_HOURS),
      }),
      details,
    );
  }

  return new AppError(
    'TOO_MANY_REQUESTS',
    429,
    message('error.fx.manual_sync_too_soon', { seconds: countParam(retryAfterSeconds) }),
    details,
  );
}

/**
 * A short, safe-to-log reason for a database failure — the SQLSTATE or driver errno if
 * one is available (drizzle wraps the driver's error one level down on `.cause`, the same
 * place `packages/db/tests/support/db.ts`'s `errorCode` walks for the identical reason),
 * the error's own name otherwise. Never the query text and never a value that was being
 * written — a DB failure here carries no `app_id` to begin with, but there is no reason to
 * start logging query parameters just because this path happens to be safe today.
 */
function dbFailureReason(error: unknown): string {
  let current: unknown = error;

  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth += 1) {
    if ('code' in current) {
      const { code } = current as { code: unknown };
      if (typeof code === 'string') return code;
    }
    current = 'cause' in current ? (current as { cause: unknown }).cause : undefined;
  }

  return error instanceof Error ? error.name : 'unknown error';
}
