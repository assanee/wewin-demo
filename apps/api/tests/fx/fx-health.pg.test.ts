import { fxRates, fxSyncFailures } from '@wewin/db/schema';
import { afterAll, describe, expect, it } from 'vitest';

import { FxRatesRepository } from '../../src/fx/fx-rates.repository';
import { FX_RATE_REFUSE_AFTER_HOURS, FX_RATE_WARN_AFTER_HOURS } from '../../src/fx/staleness';
import { createPgHarness } from '../support/pg-harness';

/**
 * Layer 1: the two facts staff could not previously see, read back out of real rows.
 *
 * `consecutiveFailures` is the whole subject here, because it is the only figure in this round
 * that is *derived from a join between two tables* rather than computed from one number. It is
 * bounded by the newest `fx_rates.fetched_at` rather than by a rolling window, which is what
 * makes it answer the question staff actually ask — *"has it been failing since the last one
 * landed?"* — identically however long ago that was. A `WHERE attempted_at > now() - 7 days`
 * version would report a comfortable zero during exactly the outage that matters most, the one
 * that started eight days ago, and no unit test on a fake repository would ever notice.
 *
 * Skipped, not failed, without a database.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

const hoursAgo = (hours: number): Date => new Date(Date.now() - hours * 60 * 60 * 1000);

describeWithPg('FxRatesRepository.health against Postgres', () => {
  const base = createPgHarness(url ?? '');

  const harness = async () => {
    const { app, db } = await base.harness();
    return {
      db,
      rates: app.app.get(FxRatesRepository),
      rate: (fetchedAt: Date, rateTimestamp: Date) =>
        db.insert(fxRates).values({
          fetchedAt,
          rateTimestamp,
          base: 'USD',
          rates: { THB: 36.5, SGD: 1.34 },
          source: 'openexchangerates',
        }),
      failure: (attemptedAt: Date, stage: 'fetch' | 'parse' | 'store' = 'fetch') =>
        db.insert(fxSyncFailures).values({ attemptedAt, stage, detail: 'status 502' }),
    };
  };

  afterAll(base.closeOpened);

  /**
   * A fresh environment. `newest` is `undefined` rather than a zero-aged placeholder, because
   * "we have never observed a rate" and "we observed one at the epoch" are different facts and
   * only one of them is true.
   */
  it('reports no observation and no failures for a database that has never synced', async () => {
    const { rates } = await harness();

    expect(await rates.health()).toStrictEqual({
      newest: undefined,
      consecutiveFailures: 0,
      lastFailureAt: undefined,
    });
  });

  /**
   * ⭐ THE COUNT IS BOUNDED BY THE NEWEST SUCCESS, not by a window of days.
   *
   * Four failures, then a success, then two more. The answer is **2** — a retry that landed
   * resets the run by arithmetic rather than by anybody remembering to clear a counter, and the
   * four before it are still on the record without being counted as current.
   */
  it('counts only the failures recorded since the newest stored rate', async () => {
    const { rates, rate, failure } = await harness();

    for (const hours of [40, 38, 36, 34]) await failure(hoursAgo(hours));
    await rate(hoursAgo(30), hoursAgo(31));
    for (const hours of [20, 10]) await failure(hoursAgo(hours));

    const health = await rates.health();

    expect(health.consecutiveFailures).toBe(2);
    expect(health.lastFailureAt?.getTime()).toBeCloseTo(hoursAgo(10).getTime(), -4);
  });

  /**
   * ⭐ The failure that is invisible to a rolling window: an outage older than any window you
   * would pick, still in progress.
   *
   * The last success was three weeks ago and every attempt since has failed. A count over "the
   * last seven days" answers a reassuring small number here while the newest rate is 21 days
   * old; this answers with the whole run, because it is measured against the success rather
   * than against the calendar.
   */
  it('keeps counting a run that started longer ago than any rolling window would cover', async () => {
    const { rates, rate, failure } = await harness();

    await rate(hoursAgo(24 * 21), hoursAgo(24 * 21));
    for (const days of [20, 18, 15, 12, 9, 6, 3, 1]) await failure(hoursAgo(24 * days));

    expect((await rates.health()).consecutiveFailures).toBe(8);
  });

  /**
   * ⚠️ Zero failures beside a very old rate is its own diagnosis, and the opposite of reassuring.
   *
   * It means nothing is even *trying* — a scheduler that never started, or an
   * `OPENEXCHANGERATES_APP_ID` that was never set, both of which return from `fetchDaily`
   * before any attempt is made and so record nothing. A reader who takes `0` as "no problems"
   * has it exactly backwards, which is why the health payload carries the age beside it rather
   * than the count alone.
   */
  it('reports zero failures for a feed that is old because nothing is trying', async () => {
    const { rates, rate } = await harness();
    await rate(hoursAgo(24 * 30), hoursAgo(24 * 30));

    const health = await rates.health();

    expect(health.consecutiveFailures).toBe(0);
    expect(health.newest).toBeDefined();
  });

  /**
   * ⭐ `latest` now selects `fetchedAt`, which it deliberately did not before.
   *
   * The pair is the diagnosis: a `fetchedAt` of minutes ago beside a `rateTimestamp` of three
   * weeks ago is a provider whose feed has frozen while its endpoint stays healthy — the exact
   * failure `staleness.ts` measures on the second clock — and it is only legible when both
   * reach the screen. This asserts the two survive the read *separately*, since a version that
   * aliased one to the other would make the frozen-feed case unreportable.
   */
  it('reads back both clocks, distinctly', async () => {
    const { rates, rate } = await harness();
    await rate(hoursAgo(1), hoursAgo(24 * 21));

    const { newest } = await rates.health();

    expect(newest?.fetchedAt.getTime()).toBeCloseTo(hoursAgo(1).getTime(), -4);
    expect(newest?.rateTimestamp.getTime()).toBeCloseTo(hoursAgo(24 * 21).getTime(), -4);
  });

  /**
   * The house rule, applied to the new table: a failure is what happened at a moment, and a run
   * of them cannot be tidied into a shorter one. `fx_sync_failures_append_only` (0040) is what
   * makes that true rather than merely intended.
   */
  it('refuses to let a recorded failure be deleted or edited', async () => {
    const { db, failure } = await harness();
    await failure(hoursAgo(2));

    await expect(db.delete(fxSyncFailures)).rejects.toMatchObject({
      /* `DrizzleQueryError.message` is the hardcoded `Failed query: …`; the trigger's own
         sentence and its SQLSTATE are one level down on `.cause`. */
      cause: { code: '23001' },
    });
    await expect(db.update(fxSyncFailures).set({ stage: 'parse' })).rejects.toMatchObject({
      cause: { code: '23001' },
    });
  });

  /**
   * `recordFailure` is the only writer, and it bounds `detail` rather than trusting it: a
   * provider that answers a fetch with a megabyte of HTML must not turn the logging path into a
   * row nobody can read. `FxRatesService` already narrows what it passes to a status code or a
   * SQLSTATE — this is the second wall.
   */
  it('bounds the detail it stores rather than trusting the caller', async () => {
    const { rates, db } = await harness();

    await rates.recordFailure('fetch', 'x'.repeat(5_000));

    const [row] = await db.select({ detail: fxSyncFailures.detail }).from(fxSyncFailures);
    expect(row?.detail.length).toBe(500);
  });
});

/**
 * The thresholds are exported and are what the endpoint reports down to the dashboard, so a
 * screen never holds a second copy. Asserted here rather than in the pure test because it is a
 * statement about the *wire contract* — the panel renders these numbers verbatim.
 */
describe('the thresholds the health endpoint reports', () => {
  it('are whole hours, so a screen can print them without formatting a fraction', () => {
    expect(Number.isInteger(FX_RATE_WARN_AFTER_HOURS)).toBe(true);
    expect(Number.isInteger(FX_RATE_REFUSE_AFTER_HOURS)).toBe(true);
  });
});
