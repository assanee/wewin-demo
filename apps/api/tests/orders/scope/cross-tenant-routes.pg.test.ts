import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, createPool, type Database, type Pool } from '@wewin/db/client';

import { AccessTokenService } from '../../../src/auth/session/access-token';
import { parseEnv } from '../../../src/config/env';
import { guestCookieName } from '../../../src/rbac/guest-cookie';
import { RouteRegistryService, type RouteRecord } from '../../../src/rbac/route-registry.service';
import { bootApp, type BootedApp } from '../../support/app';
import { PROBE_PREFIX, cleanUpProbes, createDraft, createGuest, createUser } from './support/fixtures';

/**
 * Customer B, against every route this application has that names an order.
 *
 * ── Why the route list is discovered and not written down ───────────────────────
 *
 * A hand-written list of routes is a list that is correct on the day it is written. The
 * routes this file has to cover are being added by another module — the order state
 * machine — and the failure this suite exists to catch is precisely *the route somebody
 * added without thinking about scoping*. A list would omit exactly that route.
 *
 * So the list comes from `RouteRegistryService`, which is the same map the guard answers
 * from and the same map the boot audit built. Every handler Nest routes is in it (the
 * discovery mirrors Nest's own router explorer), so a new order endpoint is swept the
 * moment it exists, with no edit here.
 *
 * ── What is swept, and what deliberately is not ─────────────────────────────────
 *
 *   **Routes with a path parameter** are the ones that can be pointed at somebody else's
 *   row, so each is called with customer A's order id in every parameter, as customer B, as
 *   an unrelated guest, and as nobody at all. The bar is: never 2xx, and never a byte of A's
 *   order in the body.
 *
 *   **Parameterless GETs** are swept too, with a weaker but still load-bearing bar: they may
 *   legitimately answer 200 (a list of *your* orders is a real route), so what is checked is
 *   that A's order is not in the answer.
 *
 *   **Parameterless writes are skipped.** `POST /orders` creating B a cart of their own is
 *   correct behaviour, and asserting "never 2xx" on it would be asserting the funnel does not
 *   work.
 *
 * ── If this file finds nothing ──────────────────────────────────────────────────
 *
 * It fails. A sweep over zero routes is a suite that reports success and has proven nothing,
 * which is the failure mode this repository has met more than once (see
 * apps/api/vitest.config.ts on the 93 silently skipped tests). The message says so.
 *
 * Skipped, not failed, without a database.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

/** Per-run, so a marker found in a response body cannot have come from an older row. */
const tag = randomUUID().slice(0, 8);
const MARKER_NAME = `${PROBE_PREFIX} sweep target ${tag}`;
const MARKER_EMAIL = `sweep-${tag}@probe.invalid`;

interface Caller {
  readonly name: string;
  readonly headers: Readonly<Record<string, string>>;
}

interface Attempt {
  readonly status: number;
  readonly body: string;
}

describeWithPg('every order route, called by the wrong customer', () => {
  let pool: Pool;
  let db: Database;
  let app: BootedApp;

  let orderOfA: string;
  let callers: readonly Caller[];
  let routes: readonly RouteRecord[];

  beforeAll(async () => {
    pool = createPool(url ?? '');
    db = createDatabase(pool);

    await cleanUpProbes(db);

    const env = parseEnv({ NODE_ENV: 'test', DATABASE_URL: url ?? '' });
    app = await bootApp(env);

    const customerA = await createUser(db, `${PROBE_PREFIX} sweep A`);
    const customerB = await createUser(db, `${PROBE_PREFIX} sweep B`);
    const guestB = await createGuest(db);

    orderOfA = await createDraft(db, {
      customerUserId: customerA,
      label: MARKER_NAME,
      contactEmail: MARKER_EMAIL,
    });

    const tokens = app.app.get(AccessTokenService);
    const tokenB = tokens.sign({ userId: customerB, sessionId: randomUUID() }).token;

    callers = [
      /*
       * Three principals, because they fail differently. A signed-in stranger is the classic
       * trap-2 attacker; a guest is the funnel and the variant most likely to have been
       * forgotten; nobody at all is what a scraper is, and is the one case where a route
       * declared `AllowAnonymous` by copy-paste would show up.
       */
      { name: 'customer B', headers: { authorization: `Bearer ${tokenB}` } },
      { name: 'an unrelated guest', headers: { cookie: `${guestCookieName(env.COOKIE_SECURE)}=${guestB}` } },
      { name: 'nobody at all', headers: {} },
    ];

    routes = app.app.get(RouteRegistryService).records().filter(isOrderRoute);
  });

  afterAll(async () => {
    await app?.close();
    await cleanUpProbes(db);
    await pool.end();
  });

  const call = async (caller: Caller, method: string, path: string): Promise<Attempt> => {
    const response = await fetch(`${app.baseUrl}${path}`, {
      method,
      headers: writes(method) ? { ...caller.headers, 'content-type': 'application/json' } : caller.headers,
      // An empty object rather than no body: a write route that rejects on a missing body
      // would never reach the loader, and this sweep is about what the loader answers.
      ...(writes(method) ? { body: '{}' } : {}),
    });
    return { status: response.status, body: await response.text() };
  };

  it('finds order routes to sweep at all', () => {
    /*
     * The guard on a vacuous pass. Until the order state machine's controller is registered
     * in `AppModule` there is nothing here to sweep, and a green tick would be a lie about
     * coverage rather than a statement about code.
     *
     * If this is the only failure in the file, the sweep has not run — it has not passed.
     */
    expect(
      routes.length,
      'no route with an order path parameter was discovered: either the orders controller is not ' +
        'registered in AppModule, or `isOrderRoute` no longer recognises its paths. Either way this ' +
        'file proved nothing.',
    ).toBeGreaterThan(0);
  });

  it('returns nothing of customer A’s order on any of them', async () => {
    const failures: string[] = [];

    for (const record of routes) {
      for (const key of record.keys) {
        const { method, path } = split(key);
        if (path.includes('*')) continue; // a splat is not a route somebody points at an order

        const target = path.replaceAll(/:[A-Za-z0-9_]+/g, orderOfA);
        if (target === path) continue; // parameterless; covered by the list sweep below

        for (const caller of callers) {
          const attempt = await call(caller, method, target);

          if (attempt.status >= 200 && attempt.status < 300) {
            failures.push(`${caller.name} got ${attempt.status} from ${method} ${target}`);
          }
          for (const marker of [MARKER_NAME, MARKER_EMAIL]) {
            if (attempt.body.includes(marker)) {
              failures.push(`${caller.name} read "${marker}" out of ${method} ${target}`);
            }
          }
        }
      }
    }

    expect(failures, failures.join('\n')).toStrictEqual([]);
  });

  it('does not put customer A’s order into anybody else’s list', async () => {
    /*
     * The other half, and the one a per-id sweep cannot see: a list route is *supposed* to
     * answer 200, so the only evidence is what is in it. `GET /orders` returning every order
     * to every signed-in caller is a leak that no status-code assertion anywhere would catch.
     */
    const failures: string[] = [];

    for (const record of routes) {
      for (const key of record.keys) {
        const { method, path } = split(key);
        if (method !== 'GET' || path.includes(':') || path.includes('*')) continue;

        for (const caller of callers) {
          const attempt = await call(caller, method, path);
          for (const marker of [MARKER_NAME, MARKER_EMAIL, orderOfA]) {
            if (attempt.body.includes(marker)) {
              failures.push(`${caller.name} found "${marker}" in ${method} ${path}`);
            }
          }
        }
      }
    }

    expect(failures, failures.join('\n')).toStrictEqual([]);
  });

  it('states which routes it covered, so a shrinking list is visible in a diff', () => {
    /*
     * Not an allowlist — nothing here decides what is swept, the discovery does. It is a
     * receipt: the assertion above passes trivially over an empty set, and this is what makes
     * the size of that set a thing a reviewer reads rather than a thing they assume.
     */
    const covered = routes.flatMap((record) => record.keys).sort();
    expect(covered.length).toBe(new Set(covered).size);
    process.stderr.write(`\n[scope sweep] ${covered.length} order routes covered:\n  ${covered.join('\n  ')}\n\n`);
  });
});

/**
 * Any route whose path mentions an order — including `/quotes/:id/order` and whatever 5b and
 * 5c mount.
 *
 * Deliberately matched on the path rather than on a module name or a controller class: a
 * route is reachable by its path, and a controller renamed or moved must not fall out of
 * this sweep silently.
 */
function isOrderRoute(record: RouteRecord): boolean {
  return record.keys.some((key) => /\border/i.test(key));
}

function split(key: string): { readonly method: string; readonly path: string } {
  const space = key.indexOf(' ');
  return { method: key.slice(0, space), path: key.slice(space + 1) };
}

function writes(method: string): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH';
}
