import { Logger } from '@nestjs/common';
import { createDatabase, createPool, type Database, type Pool } from '@wewin/db/client';
import { fxRates } from '@wewin/db/schema';
import { sql } from '@wewin/db/sql';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { FxHttp } from '../../src/fx/fx-http';
import { FxRatesService } from '../../src/fx/fx-rates.service';
import { testEnv } from '../support/app';

/**
 * `FxRatesService` against a real Postgres, stubbing only the one thing that has to be
 * stubbed: the provider. `apps/web/tests/reviews.test.ts:385-410` is this repo's own
 * idiom for it (`vi.stubGlobal('fetch', …)`), including its 502 and malformed-body cases.
 *
 * The CHECK on `base` and the append-only trigger are database properties, not service
 * properties, and are proved once in `packages/db/tests/fx.pg.test.ts` rather than here —
 * this file is what proves the *service* stores what it should, stores nothing when it
 * should not, and does not double-fetch at startup.
 *
 * ⚠️ `fx_rates` is append-only (see the migration and packages/db/src/schema/fx.ts) and
 * this file cannot delete its own rows any more than a caller could. Its tests therefore
 * run in the written order against a database that starts empty — `globalSetup.ts`
 * drops and rebuilds `wewin_api_test` before every run — the same trade
 * `packages/db/tests/tax.pg.test.ts` names for `tax_country_changes`.
 *
 * Skipped, not failed, without a database.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

/** 32 characters, matching what the real key looks like — never a real one. */
const APP_ID = 'x'.repeat(32);

interface LatestBody {
  readonly timestamp: number;
  readonly base: string;
  readonly rates: Record<string, number>;
}

const GOOD_BODY: LatestBody = {
  timestamp: 1_700_000_000, // 2023-11-14T22:13:20Z — long before any of these tests run
  base: 'USD',
  rates: { THB: 36.5, SGD: 1.34 },
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describeWithPg('FxRatesService, against a real Postgres', () => {
  let pool: Pool;
  let db: Database;
  let service: FxRatesService;

  beforeAll(() => {
    pool = createPool(url as string);
    db = createDatabase(pool);
    service = new FxRatesService(testEnv({ OPENEXCHANGERATES_APP_ID: APP_ID }), db, new FxHttp());
  });

  afterAll(async () => {
    await pool.end();
  });

  const rowCount = async (): Promise<number> => {
    const result = await db.execute<{ n: string }>(sql`select count(*)::text as n from fx_rates`);
    return Number(result.rows[0]?.n ?? '0');
  };

  it('starts empty, and the startup fetch stores a good response verbatim', async () => {
    expect(await rowCount()).toBe(0);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, GOOD_BODY)));
    await service.onModuleInit();
    vi.unstubAllGlobals();

    expect(await rowCount()).toBe(1);

    const [row] = await db.select().from(fxRates).limit(1);
    expect(row?.base).toBe('USD');
    expect(row?.rates).toStrictEqual({ THB: 36.5, SGD: 1.34 });
    expect(row?.source).toBe('openexchangerates');
    expect(row?.rateTimestamp.getTime()).toBe(GOOD_BODY.timestamp * 1000);
    // "when the provider last updated the rates" is not "when we asked" — the two columns
    // must not collapse into one value just because both are timestamps.
    expect(row?.fetchedAt.getTime()).not.toBe(row?.rateTimestamp.getTime());
  });

  it('does not fetch at startup once a row exists', async () => {
    const before = await rowCount();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await service.onModuleInit();
    vi.unstubAllGlobals();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await rowCount()).toBe(before);
  });

  it('a non-200 is logged and stores nothing', async () => {
    const before = await rowCount();
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 503 })));

    await service.fetchHourly();
    vi.unstubAllGlobals();

    expect(await rowCount()).toBe(before);
    expect(warn).toHaveBeenCalled();
    // The whole point of FxHttp's stricter contract: app_id lives in the URL, so neither
    // the URL nor the key may reach a log line.
    const logged = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).not.toContain(APP_ID);
    expect(logged).not.toContain('openexchangerates.org');

    warn.mockRestore();
  });

  it('a malformed body stores nothing', async () => {
    const before = await rowCount();
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    // Valid JSON, wrong shape: no `timestamp`, no `rates`.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { base: 'USD' })));

    await service.fetchHourly();
    vi.unstubAllGlobals();

    expect(await rowCount()).toBe(before);
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
  });

  it('an unparseable body stores nothing', async () => {
    const before = await rowCount();
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{not json', { status: 200 })));

    await service.fetchHourly();
    vi.unstubAllGlobals();

    expect(await rowCount()).toBe(before);
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
  });

  it('does nothing at all, at startup or on a tick, when the key is not configured', async () => {
    const before = await rowCount();
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    // The one warning happens here, at construction — logged once, per the class header.
    const disabled = new FxRatesService(testEnv(), db, new FxHttp());
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockClear();

    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    // Neither call should log or fetch again — the flag set at construction is silent
    // from here on, not a warning repeated on every tick.
    await disabled.onModuleInit();
    await disabled.fetchHourly();
    vi.unstubAllGlobals();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(await rowCount()).toBe(before);

    warn.mockRestore();
  });
});
