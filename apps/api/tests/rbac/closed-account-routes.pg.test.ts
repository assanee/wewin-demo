import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPool, type Pool } from '@wewin/db/client';

import { AccessTokenService } from '../../src/auth/session/access-token';
import { parseEnv } from '../../src/config/env';
import { RouteRegistryService, type RouteRecord } from '../../src/rbac/route-registry.service';
import { bootApp, type BootedApp } from '../support/app';

/**
 * A closed account, and an erased one, against every route this application has.
 *
 * ── Why a sweep and not three assertions ────────────────────────────────────────
 *
 * The brief asked that "every query that loads a user must now exclude the deleted ones"
 * fail loudly rather than quietly. The chosen mechanism is deliberately *not* a
 * `WHERE status <> 'erased'` in each repository — see the argument at the top of
 * `src/rbac/account-status.ts` — it is one total predicate plus an exhaustive match that a
 * fifth status cannot get past without a compile error.
 *
 * That covers the three status reads that exist. It does not cover the fourth, written next
 * year, by somebody who has not read either file. This sweep does: it discovers routes from
 * `RouteRegistryService` — the same map the guard answers from and the boot audit built — so
 * an endpoint added next month is covered the day it exists, with no edit here. It is the
 * same shape as `tests/orders/scope/cross-tenant-routes.pg.test.ts`, and for the same stated
 * reason: a hand-written list omits exactly the route somebody added without thinking.
 *
 * ── What is swept ───────────────────────────────────────────────────────────────
 *
 * Every route whose declared access is not `anonymous`. The anonymous ones are excluded on
 * purpose and not by oversight: `GET /catalog/products` answering 200 to a closed customer
 * is correct — it is the public funnel, it reads no user, and asserting otherwise would be
 * asserting the storefront does not work.
 *
 * ── Mutation ────────────────────────────────────────────────────────────────────
 *
 * Change `accountUsability`'s `closed` or `erased` branch to `USABLE`, or replace the
 * exhaustive match with `status !== 'suspended'`, and this file goes red. Run and reported
 * in plan 7.15.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

const tag = randomUUID().slice(0, 8);

interface Attempt {
  readonly status: number;
  readonly body: string;
}

describeWithPg('a closed or erased account, on every guarded route', () => {
  let pool: Pool;
  let app: BootedApp;
  let routes: readonly RouteRecord[];

  const created: string[] = [];

  const makePrincipal = async (): Promise<{ userId: string; token: string }> => {
    const { rows } = await pool.query<{ id: string }>(
      `insert into users (display_name) values ($1) returning id`,
      [`erasure sweep ${tag}`],
    );
    const userId = rows[0]?.id;
    if (userId === undefined) throw new Error('inserting a user returned no row');
    created.push(userId);

    const tokens = app.app.get(AccessTokenService);
    return { userId, token: tokens.sign({ userId, sessionId: randomUUID() }).token };
  };

  beforeAll(async () => {
    pool = createPool(url ?? '');
    app = await bootApp(parseEnv({ NODE_ENV: 'test', DATABASE_URL: url ?? '' }));
    routes = app.app
      .get(RouteRegistryService)
      .records()
      .filter((record) => record.access.kind !== 'anonymous');
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    if (created.length > 0) {
      /*
       * Everything except the tombstones, and that exception is the design working rather
       * than a leak: `user_erasure_requests` is append-only and references `users` ON DELETE
       * RESTRICT, so an erased row and its proof cannot be removed by anything — including
       * the test that made them. Attempting it here failed with `user_erasure_requests is
       * append-only`, which is the correct answer. The suite's database is dropped and
       * recreated on every run (tests/globalSetup.ts), so nothing accumulates.
       */
      await pool.query(
        `delete from users u
          where u.id = any($1::uuid[])
            and not exists (select 1 from user_erasure_requests r where r.user_id = u.id)`,
        [created],
      );
    }
    await pool.end();
  });

  const call = async (token: string, method: string, path: string): Promise<Attempt> => {
    const writes = method === 'POST' || method === 'PUT' || method === 'PATCH';
    const response = await fetch(`${app.baseUrl}${path.replaceAll(/:[A-Za-z0-9_]+/g, randomUUID())}`, {
      method,
      headers: writes
        ? { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
        : { authorization: `Bearer ${token}` },
      ...(writes ? { body: '{}' } : {}),
    });
    return { status: response.status, body: await response.text() };
  };

  it('finds guarded routes to sweep at all', () => {
    /*
     * The guard against a vacuous pass. A sweep over zero routes reports success and proves
     * nothing, which is the failure this repository has met before (93 silently skipped
     * tests, apps/api/vitest.config.ts). If this is the only failure in the file, the sweep
     * did not run — it did not pass.
     */
    expect(routes.length, 'no non-anonymous route was discovered; this file proved nothing').toBeGreaterThan(0);
  });

  it('still works for the same principal while the account is active', async () => {
    /*
     * The control, and it is load-bearing. Without it the two sweeps below would pass just as
     * well against a token that was never valid, a port that answers 404 to everything, or an
     * app that failed to boot — and "nothing returned 2xx" would be a statement about the
     * fixture rather than about the status. What is asserted is only that the *refusal* is
     * different: an active principal is refused for want of a permission (403) or for a row
     * that does not exist (404), never for want of an account (401).
     */
    const { token } = await makePrincipal();
    const record = routes.find((candidate) => candidate.keys.some((key) => key.startsWith('GET ')));
    const key = record?.keys.find((candidate) => candidate.startsWith('GET '));
    expect(key, 'no guarded GET route to use as a control').toBeDefined();

    const [method, path] = [key?.slice(0, key.indexOf(' ')) ?? '', key?.slice((key?.indexOf(' ') ?? 0) + 1) ?? ''];
    const attempt = await call(token, method, path);
    expect(attempt.status, `${method} ${path} refused an ACTIVE principal with 401`).not.toBe(401);
  });

  for (const state of ['closed', 'erased'] as const) {
    it(`refuses every guarded route once the account is ${state}`, async () => {
      const { userId, token } = await makePrincipal();

      await pool.query(`select close_user($1::uuid)`, [userId]);
      if (state === 'erased') {
        await pool.query(
          `select erase_user($1::uuid, null::uuid, 'self_service', 'PDPA s.33 right to erasure')`,
          [userId],
        );
      }

      const failures: string[] = [];

      for (const record of routes) {
        for (const key of record.keys) {
          if (key.includes('*')) continue;
          const space = key.indexOf(' ');
          const method = key.slice(0, space);
          const path = key.slice(space + 1);

          const attempt = await call(token, method, path);

          if (attempt.status >= 200 && attempt.status < 300) {
            failures.push(`${method} ${path} answered ${String(attempt.status)} to a ${state} account`);
          }
          /*
           * 401 and not 403, on every one of them. The distinction is what the client is
           * being told: 403 says "ask for a permission", which sends a closed customer to
           * an administrator who cannot help; 401 says the session is no longer a session
           * and the client must stop retrying with it. A route that answered 403 here would
           * have decided on permissions *before* the account state, which is the order this
           * guard deliberately does not use.
           */
          if (attempt.status !== 401) {
            failures.push(
              `${method} ${path} answered ${String(attempt.status)} to a ${state} account; expected 401`,
            );
          }
        }
      }

      expect(failures, failures.join('\n')).toStrictEqual([]);
    });
  }

  it('states which routes it covered, so a shrinking list is visible in a diff', () => {
    const covered = routes.flatMap((record) => record.keys).sort();
    process.stderr.write(
      `\n[account-status sweep] ${String(covered.length)} guarded routes covered:\n  ${covered.join('\n  ')}\n\n`,
    );
    expect(covered.length).toBe(new Set(covered).size);
  });
});
