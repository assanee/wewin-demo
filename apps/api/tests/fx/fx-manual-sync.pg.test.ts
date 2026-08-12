import { randomUUID } from 'node:crypto';

import { Logger } from '@nestjs/common';

import { fxRates, fxSyncFailures, groups, groupPermissions, userGroups, users } from '@wewin/db/schema';
import { desc, eq } from '@wewin/db/sql';
import type { PermissionCode } from '../../src/rbac';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { AccessTokenService } from '../../src/auth/session/access-token';
import { FxRatesService } from '../../src/fx/fx-rates.service';
import { FX_MANUAL_SYNC_DAILY_LIMIT } from '../../src/fx/manual-sync';
import { createPgHarness } from '../support/pg-harness';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ THE MANUAL SYNC BUTTON — its guard, its most common outcome, and its silence.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Four properties are load-bearing here, and each of them is a thing that would ship broken and
 * look fine:
 *
 *   1. **The quota guard actually refuses.** A `disabled` attribute on a button protects nothing
 *      against a second tab or a curl, so the refusal has to be the server's, and it has to be a
 *      429 with a sentence rather than a 500 or a silent success.
 *   2. **⭐ A no-op is reported as a no-op.** The free plan updates hourly, so a manual sync
 *      minutes after the last one gets the *same observation* back, appends a row, and moves
 *      nothing. That is the ordinary case. Reporting it as success is how a team learns the
 *      button works when it did not — the same class of mis-signal the health card itself exists
 *      to remove, one layer down.
 *   3. **A failed manual fetch is recorded exactly as a failed scheduled one.** The tempting
 *      shortcut is to swallow it because a human is watching; that human closes the tab, and the
 *      outage is invisible again to the one table built to make it countable.
 *   4. **⭐⭐ The API key never appears anywhere.** `app_id` travels in the request URL, so a
 *      failure path that logged a URL, or an error carrying `.message` from a `fetch` rejection,
 *      would put the credential into a database row a support engineer will paste into a chat.
 *      `FxHttp` is built so its caller never holds either; this file proves it end to end.
 *
 * ── How the provider is stubbed, and why `fetch` is not stubbed wholesale ────────
 *
 * `fx-rates.pg.test.ts` uses `vi.stubGlobal('fetch', …)` outright, which it can because it never
 * makes an HTTP request of its own. This file drives the real route over real HTTP, so a blanket
 * stub would swallow the test's own calls. The stub below therefore **delegates** anything that
 * is not openexchangerates.org to the real `fetch`, which keeps both halves honest: the app's
 * provider call is canned, and the test's request to the app is not.
 *
 * Skipped, not failed, without a database.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

/**
 * ⚠️ 32 characters and a distinctive, unmistakably-searchable shape — never a real key.
 *
 * The shape matters: the leak assertions below search for this exact string in log lines, error
 * envelopes and database rows, and a value like `'test'` would produce false negatives against
 * prose that happens to contain it, or false positives against anything at all.
 */
const APP_ID = `app-id-must-never-leak-${'z'.repeat(9)}`;

const OBSERVED_AT = 1_760_000_000; // 2025-10-09T08:53:20Z — long before these tests run.

/**
 * ⚠️ **Booting the app performs a fetch of its own, and every count here has to know it.**
 *
 * `FxRatesService.onModuleInit` fetches once when `fx_rates` is empty — which a freshly
 * provisioned harness always is — so a provider request and an `fx_rates` row exist before any
 * test has pressed anything. Discovered by this file failing: the first manual sync came back
 * `'unchanged'` because the startup fetch had already stored the identical observation.
 *
 * That is correct behaviour and the tests bend around it rather than the other way. The startup
 * fetch answers with *this* timestamp; every test that wants a `'stored'` outcome moves the
 * provider on afterwards, so `'stored'` is earned against a real prior observation rather than
 * against an empty table. It is `trigger_kind: 'startup'`, so it never touches the manual quota.
 */
const BOOT_OBSERVED_AT = OBSERVED_AT - 7_200;

const body = (timestamp: number): unknown => ({
  timestamp,
  base: 'USD',
  rates: { THB: 36.5, SGD: 1.35 },
});

describeWithPg('the manual exchange-rate sync, against Postgres', () => {
  const base = createPgHarness(url ?? '', { OPENEXCHANGERATES_APP_ID: APP_ID });

  afterAll(base.closeOpened);
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  interface Provider {
    /** What the provider answers with next. Replaced per test. */
    respond: () => Response;
    /** Every URL the app asked for — the leak assertions read this. */
    readonly asked: string[];
  }

  /**
   * Cans the provider and leaves every other request alone. See the file header.
   */
  const stubProvider = (respond: () => Response): Provider => {
    const real = globalThis.fetch.bind(globalThis);
    const provider: Provider = { respond, asked: [] };

    vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const target = input instanceof Request ? input.url : String(input);
      if (!target.includes('openexchangerates.org')) return real(input, init);

      provider.asked.push(target);
      return provider.respond();
    });

    return provider;
  };

  const json = (status: number, payload: unknown): Response =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  interface Actor {
    readonly userId: string;
    readonly token: string;
  }

  const harness = async () => {
    const { app, db } = await base.harness();

    const call = async (
      method: string,
      path: string,
      token?: string,
    ): Promise<{ readonly status: number; readonly body: unknown }> => {
      const headers: Record<string, string> = {};
      if (token !== undefined) headers['authorization'] = `Bearer ${token}`;

      const response = await fetch(`${app.baseUrl}${path}`, { method, headers });
      const text = await response.text();
      return { status: response.status, body: text.length === 0 ? null : (JSON.parse(text) as unknown) };
    };

    /** A user in a group holding exactly these codes, and a token the app itself signs. */
    const makeActor = async (label: string, codes: readonly PermissionCode[]): Promise<Actor> => {
      const [user] = await db
        .insert(users)
        .values({ displayName: `fx sync probe (${label})` })
        .returning({ id: users.id });
      if (!user) throw new Error('fixture insert returned nothing');

      if (codes.length > 0) {
        const [group] = await db
          .insert(groups)
          .values({ code: `fx_sync_${label}_${randomUUID().slice(0, 8)}`, nameTh: 'กลุ่มทดสอบ fx' })
          .returning({ id: groups.id });
        if (!group) throw new Error('fixture insert returned nothing');

        await db.insert(userGroups).values({ userId: user.id, groupId: group.id }).onConflictDoNothing();
        await db
          .insert(groupPermissions)
          .values(codes.map((code) => ({ groupId: group.id, permissionCode: code })))
          .onConflictDoNothing();
      }

      const issued = app.app.get(AccessTokenService).sign({ userId: user.id, sessionId: randomUUID() });
      return { userId: user.id, token: issued.token };
    };

    return {
      app,
      db,
      call,
      makeActor,
      service: app.app.get(FxRatesService),
      newestRate: async () =>
        (
          await db
            .select({
              rateTimestamp: fxRates.rateTimestamp,
              triggerKind: fxRates.triggerKind,
              fetchedAt: fxRates.fetchedAt,
            })
            .from(fxRates)
            .orderBy(desc(fxRates.fetchedAt))
            .limit(1)
        )[0],
      manualRateRows: async () =>
        db.select().from(fxRates).where(eq(fxRates.triggerKind, 'manual')),
      manualFailureRows: async () =>
        db.select().from(fxSyncFailures).where(eq(fxSyncFailures.triggerKind, 'manual')),
    };
  };

  /* ------------------------------------------------------------------ *
   * The route, and who may press it
   * ------------------------------------------------------------------ */

  /**
   * ⭐ `organisation.write`, not the `organisation.read` that opens the screen.
   *
   * A press spends a shared, finite resource, which is the line every other action on this page is
   * drawn on. This asserts both directions: a reader is refused *by name*, and a writer is not.
   */
  it('needs organisation.write — a reader is refused by name and an anonymous caller entirely', async () => {
    stubProvider(() => json(200, body(BOOT_OBSERVED_AT)));
    const { call, makeActor } = await harness();

    const anonymous = await call('POST', '/admin/fx/sync');
    expect(anonymous.status).toBe(401);

    const reader = await makeActor('reader', ['organisation.read']);
    const refused = await call('POST', '/admin/fx/sync', reader.token);
    expect(refused.status).toBe(403);
    expect(JSON.stringify(refused.body)).toContain('organisation.write');

    const writer = await makeActor('writer', ['organisation.write']);
    const allowed = await call('POST', '/admin/fx/sync', writer.token);
    expect(allowed.status).toBe(200);
  });

  /**
   * ⭐ The row a manual sync writes is marked as one — which is what the whole quota guard is
   * counted from, and what makes an afternoon of clicking distinguishable from a month of cron.
   */
  it('stores the fetched rates and marks the row as a manual trigger', async () => {
    const provider = stubProvider(() => json(200, body(BOOT_OBSERVED_AT)));
    const { call, makeActor, newestRate, manualRateRows } = await harness();
    /* Past the startup fetch's observation, so `'stored'` means the number really moved. */
    provider.respond = () => json(200, body(OBSERVED_AT));
    const writer = await makeActor('writer', ['organisation.write']);

    const response = await call('POST', '/admin/fx/sync', writer.token);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ outcome: 'stored', failureStage: null });
    expect((await newestRate())?.triggerKind).toBe('manual');
    expect(await manualRateRows()).toHaveLength(1);
  });

  /**
   * ⭐⭐ THE GUARD, over real HTTP. A second press one moment after the first is refused with a
   * 429 — and, critically, **nothing further is spent**: the manual row count does not move.
   *
   * A guard that answered 429 *after* making the request would look identical from the outside
   * and would protect nothing at all, which is why the row count is asserted rather than the
   * status alone.
   */
  it('refuses a rapid second press with 429, and spends nothing on it', async () => {
    const provider = stubProvider(() => json(200, body(BOOT_OBSERVED_AT)));
    const { call, makeActor, manualRateRows, manualFailureRows } = await harness();
    const writer = await makeActor('writer', ['organisation.write']);

    const first = await call('POST', '/admin/fx/sync', writer.token);
    expect(first.status).toBe(200);
    const askedAfterFirst = provider.asked.length;

    const second = await call('POST', '/admin/fx/sync', writer.token);

    expect(second.status).toBe(429);
    expect(second.body).toMatchObject({
      error: { code: 'TOO_MANY_REQUESTS', details: { reason: 'fx_manual_sync_throttled' } },
    });
    /* ⭐ The provider was not asked again, and neither table grew. */
    expect(provider.asked).toHaveLength(askedAfterFirst);
    expect(await manualRateRows()).toHaveLength(1);
    expect(await manualFailureRows()).toHaveLength(0);
  });

  /**
   * ⭐ The daily cap, distinct from the interval — refused even though the last press was hours
   * ago, and the refusal says which limit is holding.
   *
   * The window is seeded with recorded *failures* rather than successes on purpose: it is the
   * same assertion as "failures count against the quota", stated where it bites.
   */
  it('refuses once the daily allowance is spent, hours after the last press', async () => {
    stubProvider(() => json(200, body(BOOT_OBSERVED_AT)));
    const { call, db, makeActor } = await harness();
    const writer = await makeActor('writer', ['organisation.write']);

    const hoursAgo = (hours: number): Date => new Date(Date.now() - hours * 60 * 60 * 1000);
    for (let spent = 0; spent < FX_MANUAL_SYNC_DAILY_LIMIT; spent += 1) {
      await db.insert(fxSyncFailures).values({
        attemptedAt: hoursAgo(3 + spent),
        stage: 'fetch',
        detail: 'status 502',
        triggerKind: 'manual',
      });
    }

    const refused = await call('POST', '/admin/fx/sync', writer.token);

    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({
      error: {
        code: 'TOO_MANY_REQUESTS',
        details: { usedToday: FX_MANUAL_SYNC_DAILY_LIMIT, dailyLimit: FX_MANUAL_SYNC_DAILY_LIMIT },
      },
    });
    /* The sentence names the quota, not the sixty-second gap — the reader's next move differs. */
    expect(JSON.stringify(refused.body)).toContain('โควตา');
  });

  /* ------------------------------------------------------------------ *
   * ⭐ What the sync actually did
   * ------------------------------------------------------------------ */

  /**
   * ⭐⭐ THE ASSERTION THIS ROUND IS ABOUT.
   *
   * Two syncs, a simulated two minutes apart so the interval guard is satisfied, with the provider
   * answering **the identical `timestamp` both times** — which is exactly what the free plan does
   * between its hourly updates. The second must come back `'unchanged'`, not `'stored'`.
   *
   * ⚠️ And it must still have written a row and still have spent a request: `'unchanged'` is a
   * no-op against the *number* and is not a no-op against the *quota*. A test that only checked
   * the word would pass on an implementation that skipped the fetch entirely, which would be a
   * different and also-wrong feature.
   *
   * Driven through the service rather than the route because the interval is sixty seconds of real
   * time and `syncNow` takes `now` as an argument for exactly this reason.
   */
  it('reports unchanged when the provider re-serves the observation we already had', async () => {
    const provider = stubProvider(() => json(200, body(BOOT_OBSERVED_AT)));
    const { service, manualRateRows } = await harness();
    provider.respond = () => json(200, body(OBSERVED_AT));
    const askedAtBoot = provider.asked.length;

    const now = new Date();
    const first = await service.syncNow(now);
    expect(first.outcome).toBe('stored');

    const later = new Date(now.getTime() + 2 * 60_000);
    const second = await service.syncNow(later);

    expect(second.outcome).toBe('unchanged');
    /* Both clocks agree that nothing moved, and both are reported so a screen can show it. */
    expect(second.observedAt).toBe(second.previousObservedAt);
    /* ⭐ It cost a request and a row regardless. */
    expect(provider.asked).toHaveLength(askedAtBoot + 2);
    expect(await manualRateRows()).toHaveLength(2);
    expect(second.manualSync.usedToday).toBe(2);
  });

  /** The other side of the same comparison: a moved `timestamp` is `'stored'`, not `'unchanged'`. */
  it('reports stored when the observation actually moved', async () => {
    let timestamp = BOOT_OBSERVED_AT;
    stubProvider(() => json(200, body(timestamp)));
    const { service } = await harness();
    timestamp = OBSERVED_AT;

    const now = new Date();
    const first = await service.syncNow(now);
    expect(first.outcome).toBe('stored');

    timestamp = OBSERVED_AT + 3_600;
    const second = await service.syncNow(new Date(now.getTime() + 2 * 60_000));

    expect(second.outcome).toBe('stored');
    expect(second.observedAt).not.toBe(second.previousObservedAt);
  });

  /**
   * ⭐ A failed manual fetch is recorded **exactly as a failed scheduled one is** — same table,
   * same stage vocabulary — and differs only by `trigger_kind`. Swallowing it because a person was
   * watching is how a failure stops being countable the moment they close the tab.
   */
  it('records a failed manual fetch in fx_sync_failures, marked manual', async () => {
    stubProvider(() => json(502, { error: true }));
    const { service, manualFailureRows } = await harness();

    const result = await service.syncNow(new Date());

    expect(result.outcome).toBe('failed');
    expect(result.failureStage).toBe('fetch');

    const rows = await manualFailureRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.stage).toBe('fetch');
    expect(rows[0]?.detail).toBe('status 502');
  });

  /**
   * A malformed body is a different stage with a different owner — a provider contract rather than
   * a network — and the screen says which so a reader knows what to chase.
   */
  it('records a malformed provider body at the parse stage', async () => {
    stubProvider(() => json(200, { nothing: 'useful' }));
    const { service, manualFailureRows } = await harness();

    const result = await service.syncNow(new Date());

    expect(result.outcome).toBe('failed');
    expect(result.failureStage).toBe('parse');
    expect((await manualFailureRows())[0]?.stage).toBe('parse');
  });

  /**
   * ⚠️ A failed sync leaves the system holding exactly what it held before, and the payload says
   * so rather than answering `null`. On a card whose whole subject is whether there *is* a rate,
   * `null` would read as "you have broken it" instead of "that did not work".
   */
  it('reports the rate still held after a failed manual sync, rather than null', async () => {
    let ok = true;
    let timestamp = BOOT_OBSERVED_AT;
    stubProvider(() => (ok ? json(200, body(timestamp)) : json(502, { error: true })));
    const { service } = await harness();
    timestamp = OBSERVED_AT;

    const now = new Date();
    const stored = await service.syncNow(now);
    expect(stored.outcome).toBe('stored');

    ok = false;
    const failed = await service.syncNow(new Date(now.getTime() + 2 * 60_000));

    expect(failed.outcome).toBe('failed');
    expect(failed.observedAt).toBe(stored.observedAt);
    expect(failed.previousObservedAt).toBe(stored.observedAt);
  });

  /* ------------------------------------------------------------------ *
   * ⭐⭐ The credential
   * ------------------------------------------------------------------ */

  /**
   * ⭐⭐ THE API KEY NEVER LEAVES `FxHttp` — proved on the path most likely to leak it.
   *
   * `app_id` travels in the provider URL's query string, so the URL itself is the credential. Two
   * specific mistakes would put it somewhere durable, and both look like helpfulness:
   *
   *   1. carrying the request URL on an error "for debugging" — which is why `FxHttp` builds the
   *      URL internally and exposes no method that accepts one;
   *   2. using a caught `fetch` rejection's `.message`, which has been observed to contain the
   *      request URL — which is why only `.name` is ever read.
   *
   * A failed fetch is the moment both temptations arrive at once, and the `fx_sync_failures.detail`
   * it writes is a row a support engineer will paste into a chat window. So this asserts the key
   * is absent from **every** surface the attempt produced: the logger, the returned payload, and
   * the database row — and it first asserts the key really was *sent*, so the whole test cannot
   * pass by the provider never having been called.
   */
  it('never puts the app id in a log line, a payload, or a recorded failure', async () => {
    const provider = stubProvider(() => json(500, { error: 'boom' }));
    const { service, manualFailureRows } = await harness();
    /* The boot fetch already failed against this stub; count from there. */
    const askedAtBoot = provider.asked.length;

    const logged: string[] = [];
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((arg) => String(arg)).join(' '));
      });
    }

    const result = await service.syncNow(new Date());

    /* ⚠️ The control. Without this the assertions below would pass against a provider that was
       never asked, which is the shape of green this whole repo keeps warning about. */
    expect(provider.asked).toHaveLength(askedAtBoot + 1);
    expect(provider.asked.at(-1)).toContain(APP_ID);

    expect(result.outcome).toBe('failed');

    const rows = await manualFailureRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toBe('status 500');

    for (const surface of [JSON.stringify(result), JSON.stringify(rows), logged.join('\n')]) {
      expect(surface).not.toContain(APP_ID);
      /* The URL is the credential's carrier; neither may appear even in part. */
      expect(surface).not.toContain('openexchangerates.org');
      expect(surface).not.toContain('app_id');
    }
    /* The log did run — an empty transcript would make the three assertions above vacuous. */
    expect(logged.join('\n')).toContain('exchange-rate fetch failed');
  });
});
