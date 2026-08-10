import { randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';

import type { Database } from '@wewin/db/client';
import { groupPermissions, groups, userGroups, users } from '@wewin/db/schema';

import { AccessTokenService } from '../../src/auth/session/access-token';
import type { PermissionCode } from '../../src/rbac';
import { TaxCountryService } from '../../src/organisation/tax-country.service';
import type { BootedApp } from '../support/app';
import { createPgHarness } from '../support/pg-harness';

/**
 * The five admin tax-country routes and the public `GET /destinations` read, over real HTTP.
 *
 * `tax-country.pg.test.ts` already proves `TaxCountryService`'s own transactional shape
 * (locked pre-image, history in the same transaction, `pg-errors.ts`'s constraint
 * translation) by calling the service directly. This file exists to prove the *other* half:
 * that the five new handlers on `OrganisationController` and the new `DestinationsController`
 * carry the right permission, carry it over real HTTP rather than by construction, and — the
 * point the task brief calls out explicitly — that a translated `AppError` really does reach
 * the caller as the status it names (404, 409, 422) rather than as an unhandled 500 the
 * controller's lack of its own `try`/`catch` would produce if the service's translation were
 * ever bypassed or double-wrapped.
 *
 * `TH` is the one row migration 0029 seeds and `tax_countries_block_delete` refuses to let
 * anything remove it, so — like `tax-country.pg.test.ts` — every test provisions its own
 * fresh database via `createPgHarness` rather than sharing one across a `describe` block;
 * see that file's own header for why (an absolute assertion against a singleton's history is
 * only meaningful against a database nothing earlier in the run has touched).
 *
 * Skipped, not failed, without a database.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

interface Actor {
  readonly userId: string;
  readonly token: string;
}

interface Json {
  readonly status: number;
  readonly body: unknown;
}

interface ErrorBody {
  readonly error: { readonly code: string; readonly message: string; readonly details?: unknown };
}

describeWithPg('tax-country routes and the public destinations read, against Postgres', () => {
  const base = createPgHarness(url ?? '');
  afterAll(base.closeOpened);

  interface Harness {
    readonly app: BootedApp;
    readonly db: Database;
    readonly service: TaxCountryService;
    readonly actor: { readonly id: string };
    readonly call: (
      method: string,
      path: string,
      options?: { readonly token?: string; readonly body?: unknown },
    ) => Promise<Json>;
    readonly admin: Actor;
    readonly reader: Actor;
    readonly writerOnly: Actor;
    readonly asAdmin: (method: string, path: string, body?: unknown) => Promise<Json>;
    readonly asReader: (method: string, path: string, body?: unknown) => Promise<Json>;
    readonly asWriterOnly: (method: string, path: string, body?: unknown) => Promise<Json>;
  }

  /**
   * `{ service, actor, call, makeActor helpers }`, built on `createPgHarness`'s generic
   * `{ app, actor, db }` — the same widening `tax-country.pg.test.ts` and
   * `organisation.pg.test.ts` both use, rather than a fourth copy of the provisioning dance.
   *
   * There is no chainable `request.get(path).set(headers).expect(status)` builder here: no
   * package in this monorepo provides one (`supertest` is not a dependency of `@wewin/api`),
   * and every existing Postgres-backed HTTP suite (`organisation.pg.test.ts`,
   * `payments/support/payments-app.ts`'s `client`) reaches the app through a bare `fetch`
   * wrapped in a `call(method, path, { token, body })` closure. This file follows that same
   * idiom rather than introducing a second one.
   */
  const harness = async (): Promise<Harness> => {
    const { app, actor, db } = await base.harness();
    const service = app.app.get(TaxCountryService);

    const call = async (
      method: string,
      path: string,
      options: { readonly token?: string; readonly body?: unknown } = {},
    ): Promise<Json> => {
      const headers: Record<string, string> = {};
      if (options.token !== undefined) headers['authorization'] = `Bearer ${options.token}`;
      if (options.body !== undefined) headers['content-type'] = 'application/json';

      const response = await fetch(`${app.baseUrl}${path}`, {
        method,
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });

      const text = await response.text();
      return { status: response.status, body: text.length === 0 ? null : (JSON.parse(text) as unknown) };
    };

    /** A user in a group holding exactly these permissions, and a token the app itself signs. */
    const makeActor = async (label: string, codes: readonly PermissionCode[]): Promise<Actor> => {
      const [user] = await db
        .insert(users)
        .values({ displayName: `tax-country probe (${label})` })
        .returning({ id: users.id });
      if (!user) throw new Error('fixture insert returned nothing');

      if (codes.length > 0) {
        const groupCode = `tax_country_probe_${label.replace(/[^a-z0-9]+/giu, '_').toLowerCase()}_${randomUUID().slice(0, 8)}`;
        const [group] = await db
          .insert(groups)
          .values({ code: groupCode, nameTh: 'กลุ่มทดสอบภาษี' })
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

    const admin = await makeActor('admin', ['organisation.read', 'organisation.write']);
    const reader = await makeActor('reader', ['organisation.read']);
    const writerOnly = await makeActor('writer-only', ['organisation.write']);

    const bind = (who: Actor) => (method: string, path: string, body?: unknown) =>
      call(method, path, { token: who.token, ...(body === undefined ? {} : { body }) });

    return {
      app,
      db,
      service,
      actor,
      call,
      admin,
      reader,
      writerOnly,
      asAdmin: bind(admin),
      asReader: bind(reader),
      asWriterOnly: bind(writerOnly),
    };
  };

  /* ---------------------------------------------------------------- *
   * Permission enforcement, over real HTTP
   * ---------------------------------------------------------------- */

  describe('permission enforcement', () => {
    it('refuses a tax-country read without organisation.read, and an anonymous caller entirely', async () => {
      const { call, asWriterOnly } = await harness();

      const anonymous = await call('GET', '/admin/organisation/tax-countries');
      expect(anonymous.status).toBe(401);

      // Holds organisation.write, not organisation.read — the read route demands the other one.
      const refused = await asWriterOnly('GET', '/admin/organisation/tax-countries');
      expect(refused.status).toBe(403);
      const body = refused.body as ErrorBody;
      expect(body.error.message).toContain('organisation.read');
    });

    it('refuses every tax-country write without organisation.write, and an anonymous caller entirely', async () => {
      const { call, asReader } = await harness();

      const writes: readonly [method: string, path: string, body: unknown][] = [
        ['POST', '/admin/organisation/tax-countries', { code: 'SG', nameTh: 'สิงคโปร์', rateBp: 900, treatment: 'standard', pricesIncludeTax: true }],
        ['PATCH', '/admin/organisation/tax-countries/TH', { rateBp: 800 }],
        ['PUT', '/admin/organisation/tax-countries/TH/availability', { isActive: false }],
      ];

      for (const [method, path, body] of writes) {
        const anonymous = await call(method, path, { body });
        expect(anonymous.status, `${method} ${path} as nobody`).toBe(401);

        // Holds organisation.read, not organisation.write.
        const refused = await asReader(method, path, body);
        expect(refused.status, `${method} ${path} as a reader`).toBe(403);
        const errorBody = refused.body as ErrorBody;
        expect(errorBody.error.message, `${method} ${path} as a reader`).toContain('organisation.write');
      }
    });

    it('refuses a tax-country change-history read without organisation.read', async () => {
      const { call, asWriterOnly } = await harness();

      const anonymous = await call('GET', '/admin/organisation/tax-countries/TH/changes');
      expect(anonymous.status).toBe(401);

      const refused = await asWriterOnly('GET', '/admin/organisation/tax-countries/TH/changes');
      expect(refused.status).toBe(403);
    });
  });

  /* ---------------------------------------------------------------- *
   * The admin routes, doing what they say
   * ---------------------------------------------------------------- */

  describe('the admin routes', () => {
    it('lists every destination — active or withdrawn — as a bare array', async () => {
      const { asAdmin, service, actor } = await harness();

      await service.setAvailability('TH', false, actor.id);

      const listed = await asAdmin('GET', '/admin/organisation/tax-countries');
      expect(listed.status).toBe(200);
      expect(listed.body).toHaveLength(1);
      const [th] = listed.body as { readonly code: string; readonly isActive: boolean }[];
      expect(th?.code).toBe('TH');
      expect(th?.isActive).toBe(false);
    });

    it('creates a country and records the creation with a null `before`', async () => {
      const { asAdmin } = await harness();

      const created = await asAdmin('POST', '/admin/organisation/tax-countries', {
        code: 'SG',
        nameTh: 'สิงคโปร์',
        rateBp: 900,
        treatment: 'standard',
        pricesIncludeTax: true,
      });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ code: 'SG', rateBp: 900, isActive: true });

      const changes = await asAdmin('GET', '/admin/organisation/tax-countries/SG/changes');
      expect(changes.status).toBe(200);
      const entries = changes.body as { readonly before: unknown; readonly after: unknown }[];
      expect(entries).toHaveLength(1);
      expect(entries[0]?.before).toBeNull();
      expect(entries[0]?.after).toMatchObject({ code: 'SG', rateBp: 900 });
    });

    it('refuses a patch that changes nothing', async () => {
      const { asAdmin } = await harness();
      const refused = await asAdmin('PATCH', '/admin/organisation/tax-countries/TH', {});
      expect(refused.status).toBe(400);
    });

    it('patches a country and the history carries both before and after', async () => {
      const { asAdmin } = await harness();

      const patched = await asAdmin('PATCH', '/admin/organisation/tax-countries/TH', { rateBp: 800 });
      expect(patched.status).toBe(200);
      expect(patched.body).toMatchObject({ code: 'TH', rateBp: 800 });

      const changes = await asAdmin('GET', '/admin/organisation/tax-countries/TH/changes');
      const entries = changes.body as { readonly before: unknown; readonly after: unknown }[];
      expect(entries).toHaveLength(1);
      expect(entries[0]?.before).toMatchObject({ rateBp: 700 });
      expect(entries[0]?.after).toMatchObject({ rateBp: 800 });
    });

    it('withdraws a country by flag through the availability route, and the write is recorded as history', async () => {
      const { asAdmin } = await harness();

      const withdrawn = await asAdmin('PUT', '/admin/organisation/tax-countries/TH/availability', {
        isActive: false,
      });
      expect(withdrawn.status).toBe(200);
      expect(withdrawn.body).toMatchObject({ isActive: false });

      const changes = await asAdmin('GET', '/admin/organisation/tax-countries/TH/changes');
      const entries = changes.body as { readonly before: unknown; readonly after: unknown }[];
      expect(entries).toHaveLength(1);
      expect(entries[0]?.before).toMatchObject({ isActive: true });
      expect(entries[0]?.after).toMatchObject({ isActive: false });
    });

    it('reads change history oldest-first through the admin route', async () => {
      const { asAdmin } = await harness();

      await asAdmin('PATCH', '/admin/organisation/tax-countries/TH', { rateBp: 800 });
      await asAdmin('PATCH', '/admin/organisation/tax-countries/TH', { rateBp: 900 });

      const changes = await asAdmin('GET', '/admin/organisation/tax-countries/TH/changes');
      expect(changes.status).toBe(200);
      const entries = changes.body as { readonly before: { readonly rateBp: number } }[];
      expect(entries).toHaveLength(2);
      expect(entries[0]?.before.rateBp).toBe(700);
      expect(entries[1]?.before.rateBp).toBe(800);
    });
  });

  /* ---------------------------------------------------------------- *
   * Constraint translation, verified at the HTTP boundary — not assumed
   * ---------------------------------------------------------------- *
   *
   * `tax-country.pg.test.ts` already proves `pg-errors.ts` translates these three
   * constraints when the service is called directly. What that file cannot prove is that
   * the *controller* forwards the translated `AppError` unchanged rather than letting
   * something upstream (a second `catch`, a serialisation step) turn a 409 into a 500 on
   * the way out — which is exactly the defect class Task 3 fixed one layer down, and the
   * task-5 brief calls out by name as worth testing rather than assuming.
   */

  describe('constraint translation reaches the caller as the right status, not a 500', () => {
    it('creating a country with a code already in use is 409, naming the primary key', async () => {
      const { asAdmin } = await harness();

      const duplicate = await asAdmin('POST', '/admin/organisation/tax-countries', {
        code: 'TH',
        nameTh: 'ไทย (ซ้ำ)',
        rateBp: 0,
        treatment: 'standard',
        pricesIncludeTax: true,
      });

      expect(duplicate.status).toBe(409);
      const body = duplicate.body as ErrorBody;
      expect(body.error.code).toBe('CONFLICT');
      expect(body.error.details).toMatchObject({ constraint: 'tax_countries_pkey' });
    });

    it('zero-rating TH without clearing its rate is 409, naming the rate/treatment constraint', async () => {
      const { asAdmin } = await harness();

      // TH seeds at rate_bp 700 — zero-rating it without clearing the rate in the same
      // request trips `tax_countries_rate_matches_treatment`, exactly the mistake a real
      // admin will make.
      const conflicting = await asAdmin('PATCH', '/admin/organisation/tax-countries/TH', {
        treatment: 'zero_rated',
      });

      expect(conflicting.status).toBe(409);
      const body = conflicting.body as ErrorBody;
      expect(body.error.code).toBe('CONFLICT');
      expect(body.error.details).toMatchObject({ constraint: 'tax_countries_rate_matches_treatment' });
    });

    it('creating a country with a whitespace-only name is 422, naming the name constraint', async () => {
      const { asAdmin } = await harness();

      // zod's `nameTh: z.string().min(1)` counts the raw string — three spaces has length 3
      // and passes it — while the database's `length(btrim(name_th)) > 0` does not.
      const blank = await asAdmin('POST', '/admin/organisation/tax-countries', {
        code: 'ZZ',
        nameTh: '   ',
        rateBp: 0,
        treatment: 'standard',
        pricesIncludeTax: true,
      });

      expect(blank.status).toBe(422);
      const body = blank.body as ErrorBody;
      expect(body.error.code).toBe('VALIDATION_FAILED');
      expect(body.error.details).toMatchObject({ constraint: 'tax_countries_name_says_something' });
    });

    it('patching a code that does not exist is 404, not a 500', async () => {
      const { asAdmin } = await harness();

      const missing = await asAdmin('PATCH', '/admin/organisation/tax-countries/ZZ', { rateBp: 800 });

      expect(missing.status).toBe(404);
      const body = missing.body as ErrorBody;
      expect(body.error.code).toBe('NOT_FOUND');
    });
  });

  /* ---------------------------------------------------------------- *
   * The public destinations read
   * ---------------------------------------------------------------- */

  describe('the public destinations read', () => {
    it('publishes destinations to an anonymous caller — names only', async () => {
      const { call } = await harness();

      const response = await call('GET', '/destinations');
      expect(response.status).toBe(200);
      expect(response.body).toStrictEqual([{ code: 'TH', nameTh: 'ไทย' }]);

      /* Tax policy is not published. A caller with no order learns where we sell, nothing
         more. */
      expect(JSON.stringify(response.body)).not.toMatch(/rateBp|treatment|pricesIncludeTax/u);
    });

    it('omits withdrawn countries from the public list but not from the admin list', async () => {
      const { call, asAdmin, service, actor } = await harness();

      await service.setAvailability('TH', false, actor.id);

      const publicList = await call('GET', '/destinations');
      expect(publicList.status).toBe(200);
      expect(publicList.body).toStrictEqual([]);

      const adminList = await asAdmin('GET', '/admin/organisation/tax-countries');
      expect(adminList.status).toBe(200);
      expect(adminList.body).toHaveLength(1);
    });
  });
});
