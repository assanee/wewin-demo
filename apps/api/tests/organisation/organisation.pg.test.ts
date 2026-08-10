import { randomInt, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, createPool, type Database, type Pool } from '@wewin/db/client';
import { eq, sql as sqlTag } from '@wewin/db/sql';
import { bankAccountChanges, groupPermissions, groups, userGroups, users } from '@wewin/db/schema';

import { AccessTokenService } from '../../src/auth/session/access-token';
import { parseEnv } from '../../src/config/env';
import type { PermissionCode } from '../../src/rbac';
import { encodeAccountPublic } from '../../src/organisation/encode';
import { OrganisationRepository } from '../../src/organisation/organisation.repository';
import { OrganisationService } from '../../src/organisation/organisation.service';
import { bootApp, type BootedApp } from '../support/app';
import { createPgHarness } from '../support/pg-harness';
import { waitForBlockedBackend } from '../orders/scope/support/fixtures';

/**
 * The organisation module against a real Postgres, over real HTTP.
 *
 * The property this file exists to prove lives *between* the account write and the history
 * write: `OrganisationService` says both happen in one transaction, and the only way to
 * catch a version that quietly split them is to write a real row and count what landed —
 * a mock has no trigger to fail and no second statement to lose.
 *
 * `bank_accounts` and `bank_account_changes` are both permanent — `bank_accounts_block_delete`
 * and `bank_account_changes_append_only` (migration 0027) refuse to let either be deleted or
 * edited — so, like `packages/db/tests/organisation.test.ts`, this file never attempts
 * cleanup. Every probe account gets a fresh random account number so repeated runs against
 * the same database never collide with `bank_accounts_number_key`.
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
  readonly body: Record<string, unknown> | null;
}

/** Ten to fifteen digits, freshly random, so `bank_accounts_number_key` never collides. */
function freshAccountNumber(): string {
  return Array.from({ length: 12 }, () => String(randomInt(10))).join('');
}

describeWithPg('the organisation module against Postgres', () => {
  let pool: Pool;
  let db: Database;
  let app: BootedApp;
  let reader: Actor;
  let writer: Actor;

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
    return { status: response.status, body: text.length === 0 ? null : (JSON.parse(text) as Record<string, unknown>) };
  };

  const asReader = (method: string, path: string, body?: unknown): Promise<Json> =>
    call(method, path, { token: reader.token, ...(body === undefined ? {} : { body }) });
  const asWriter = (method: string, path: string, body?: unknown): Promise<Json> =>
    call(method, path, { token: writer.token, ...(body === undefined ? {} : { body }) });

  /** A user in a group holding exactly these permissions, and a token signed by the app itself. */
  const makeActor = async (label: string, codes: readonly PermissionCode[]): Promise<Actor> => {
    const [user] = await db
      .insert(users)
      .values({ displayName: `organisation probe (${label})` })
      .returning({ id: users.id });
    const groupCode = `organisation_probe_${label}_${randomUUID().slice(0, 8)}`;
    const [group] = await db
      .insert(groups)
      .values({ code: groupCode, nameTh: 'กลุ่มทดสอบข้อมูลบริษัท' })
      .returning({ id: groups.id });
    if (!user || !group) throw new Error('fixture insert returned nothing');

    await db.insert(userGroups).values({ userId: user.id, groupId: group.id }).onConflictDoNothing();
    await db
      .insert(groupPermissions)
      .values(codes.map((code) => ({ groupId: group.id, permissionCode: code })))
      .onConflictDoNothing();

    const issued = app.app.get(AccessTokenService).sign({ userId: user.id, sessionId: randomUUID() });
    return { userId: user.id, token: issued.token };
  };

  const createRequest = (overrides: Record<string, unknown> = {}) => ({
    bankCode: 'KBANK',
    accountNumber: freshAccountNumber(),
    accountName: 'บริษัท ทดสอบ (probe) จำกัด',
    promptpayId: null,
    ...overrides,
  });

  const historyRows = (bankAccountId: string) =>
    db
      .select()
      .from(bankAccountChanges)
      .where(eq(bankAccountChanges.bankAccountId, bankAccountId))
      .orderBy(bankAccountChanges.changedAt);

  beforeAll(async () => {
    pool = createPool(url ?? '');
    db = createDatabase(pool);
    app = await bootApp(parseEnv({ NODE_ENV: 'test', DATABASE_URL: url ?? '' }));

    reader = await makeActor('reader', ['organisation.read']);
    writer = await makeActor('writer', ['organisation.read', 'organisation.write']);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  /* ---------------------------------------------------------------- *
   * The company's own profile — a fixed, permanently-seeded row
   * ---------------------------------------------------------------- */

  describe('the profile', () => {
    it('is readable by organisation.read and editable by organisation.write', async () => {
      const seen = await asReader('GET', '/admin/organisation');
      expect(seen.status).toBe(200);
      expect(typeof seen.body?.['legalNameTh']).toBe('string');
      expect(String(seen.body?.['legalNameTh']).length).toBeGreaterThan(0);

      const phone = `+66${randomInt(100_000_000, 999_999_999)}`;
      const updated = await asWriter('PUT', '/admin/organisation', {
        legalNameTh: String(seen.body?.['legalNameTh']),
        addressTh: String(seen.body?.['addressTh']),
        phone,
      });
      expect(updated.status).toBe(200);
      expect(updated.body?.['phone']).toBe(phone);

      const reread = await asReader('GET', '/admin/organisation');
      expect(reread.body?.['phone']).toBe(phone);
    });

    it('refuses a reader who tries to edit it, and an anonymous caller entirely', async () => {
      const asAnonymous = await call('GET', '/admin/organisation');
      expect(asAnonymous.status).toBe(401);

      const refused = await asReader('PUT', '/admin/organisation', {
        legalNameTh: 'x',
        addressTh: 'x',
        phone: '0000000000',
      });
      expect(refused.status).toBe(403);
      const message = (refused.body?.['error'] as { message?: string } | undefined)?.message;
      expect(message).toContain('organisation.write');
    });
  });

  /* ---------------------------------------------------------------- *
   * Bank accounts, and the history that must accompany every write
   * ---------------------------------------------------------------- */

  describe('bank accounts and their history', () => {
    it('a create writes exactly one history row, before null', async () => {
      const created = await asWriter('POST', '/admin/organisation/bank-accounts', createRequest());
      expect(created.status).toBe(201);
      const id = String(created.body?.['id']);
      expect(created.body?.['isActive']).toBe(true);

      const rows = await historyRows(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.before).toBeNull();
      expect(rows[0]?.after).toMatchObject({
        bankCode: 'KBANK',
        accountName: 'บริษัท ทดสอบ (probe) จำกัด',
        isActive: true,
      });

      // The read route sees the same one row, encoded rather than raw.
      const seen = await asReader('GET', `/admin/organisation/bank-accounts/${id}/changes`);
      expect(seen.status).toBe(200);
      const changes = seen.body?.['changes'] as readonly Record<string, unknown>[];
      expect(changes).toHaveLength(1);
      expect(changes[0]?.['before']).toBeNull();
    });

    /**
     * `lockAccount`'s `FOR UPDATE`, proved rather than assumed — the same test
     * `scoped-order.pg.test.ts`'s `describe('lock', …)` runs for `ScopedOrderRepository.lock`,
     * copied onto this repository's own lock method.
     *
     * ⚠️ A first attempt at this test fired two concurrent `PATCH`es over HTTP and asserted
     * the resulting history chain stayed contiguous. Mutation-tested against the pre-fix code
     * (`patchAccount` reading through the unlocked `account()` instead of `lockAccount()`), it
     * passed in 5 of 5 runs anyway — two fast local requests never reliably overlapped at the
     * database layer, so the test proved nothing about the lock and would have shipped as a
     * green check on a real gap. Replaced with this: two transactions are opened without
     * awaiting either to completion, so both are genuinely in flight, and the assertion waits
     * on Postgres *reporting* a blocked backend (`pg_blocking_pids`) rather than on a timer —
     * `waitForBlockedBackend`'s own comment names the same trap the first attempt fell into.
     * This version was mutation-tested the same way and reliably failed without the fix.
     */
    it('lockAccount holds the row against a second transaction until the first commits', async () => {
      const created = await asWriter('POST', '/admin/organisation/bank-accounts', createRequest());
      const id = String(created.body?.['id']);
      const repository = app.app.get(OrganisationRepository);

      let secondSettled = false;
      let releaseFirst: () => void = () => undefined;
      const firstMayCommit = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });

      const first = repository.transaction(async (tx) => {
        const [locked] = await repository.lockAccount(id, tx);
        expect(locked?.id).toBe(id);
        await firstMayCommit;
      });

      const second = repository.transaction(async (tx) => {
        await repository.lockAccount(id, tx);
        secondSettled = true;
      });

      const blocked = await waitForBlockedBackend(pool);
      expect(blocked, 'no backend was ever reported as blocked — the row was not locked').toBe(true);
      expect(secondSettled, 'the second transaction acquired the row while the first still held it').toBe(
        false,
      );

      releaseFirst();
      await Promise.all([first, second]);
      expect(secondSettled).toBe(true);
    });

    it('a patch writes a history row carrying both before and after', async () => {
      const created = await asWriter('POST', '/admin/organisation/bank-accounts', createRequest());
      const id = String(created.body?.['id']);

      const patched = await asWriter('PATCH', `/admin/organisation/bank-accounts/${id}`, {
        accountName: 'บริษัท ทดสอบ (probe) จำกัด — แก้ไขแล้ว',
      });
      expect(patched.status).toBe(200);
      expect(patched.body?.['accountName']).toBe('บริษัท ทดสอบ (probe) จำกัด — แก้ไขแล้ว');

      const rows = await historyRows(id);
      expect(rows).toHaveLength(2);
      const last = rows[1];
      expect(last?.before).toMatchObject({ accountName: 'บริษัท ทดสอบ (probe) จำกัด' });
      expect(last?.after).toMatchObject({ accountName: 'บริษัท ทดสอบ (probe) จำกัด — แก้ไขแล้ว' });
    });

    it('refuses isActive from a client on the patch route, strict-object and all', async () => {
      const created = await asWriter('POST', '/admin/organisation/bank-accounts', createRequest());
      const id = String(created.body?.['id']);

      const refused = await asWriter('PATCH', `/admin/organisation/bank-accounts/${id}`, {
        isActive: false,
      });
      expect(refused.status).toBe(400);

      // Refused before it ever reached the service — no history row was written for it.
      const rows = await historyRows(id);
      expect(rows).toHaveLength(1);
    });

    it('a deactivation writes a history row too, through the same path as any other change', async () => {
      const created = await asWriter('POST', '/admin/organisation/bank-accounts', createRequest());
      const id = String(created.body?.['id']);

      const deactivated = await asWriter('PUT', `/admin/organisation/bank-accounts/${id}/availability`, {
        isActive: false,
      });
      expect(deactivated.status).toBe(200);
      expect(deactivated.body?.['isActive']).toBe(false);

      const rows = await historyRows(id);
      expect(rows).toHaveLength(2);
      const last = rows[1];
      expect(last?.before).toMatchObject({ isActive: true });
      expect(last?.after).toMatchObject({ isActive: false });
      // Nothing else moved on the way through.
      expect(last?.after).toMatchObject({ bankCode: 'KBANK' });
    });

    it('GET bank-accounts returns an inactive account; the customer-facing read and shape would not', async () => {
      const created = await asWriter('POST', '/admin/organisation/bank-accounts', createRequest());
      const id = String(created.body?.['id']);
      await asWriter('PUT', `/admin/organisation/bank-accounts/${id}/availability`, { isActive: false });

      const listed = await asReader('GET', '/admin/organisation/bank-accounts');
      expect(listed.status).toBe(200);
      const accounts = listed.body?.['accounts'] as readonly Record<string, unknown>[];
      const admin = accounts.find((row) => row['id'] === id);
      expect(admin?.['isActive']).toBe(false);

      // The read Task 10's customer-facing route will use excludes it outright.
      const repository = app.app.get(OrganisationRepository);
      const active = await repository.activeAccounts();
      expect(active.some((row) => row.id === id)).toBe(false);

      // And the shape a customer would be handed carries no `isActive`, `sortOrder` or
      // `updatedAt` at all — there is nothing on the wire to omit by convention.
      const publicShape = encodeAccountPublic(admin as never);
      expect(Object.keys(publicShape).sort()).toStrictEqual(
        ['accountName', 'accountNumber', 'bankCode', 'id', 'promptpayId'].sort(),
      );
    });

    it('refuses a caller without organisation.write on every one of the four writes, and an anonymous caller entirely', async () => {
      const created = await asWriter('POST', '/admin/organisation/bank-accounts', createRequest());
      const id = String(created.body?.['id']);

      const writes: readonly [method: string, path: string, body: unknown][] = [
        ['POST', '/admin/organisation/bank-accounts', createRequest()],
        ['PATCH', `/admin/organisation/bank-accounts/${id}`, { accountName: 'ไม่ควรเปลี่ยน' }],
        ['PUT', `/admin/organisation/bank-accounts/${id}/availability`, { isActive: false }],
      ];

      for (const [method, path, body] of writes) {
        const anonymous = await call(method, path, { body });
        expect(anonymous.status, `${method} ${path} as nobody`).toBe(401);

        const refused = await asReader(method, path, body);
        expect(refused.status, `${method} ${path} as a reader`).toBe(403);
        const message = (refused.body?.['error'] as { message?: string } | undefined)?.message;
        expect(message, `${method} ${path} as a reader`).toContain('organisation.write');
      }

      // None of the three refused writes touched the account — the point of asserting them
      // together rather than one at a time.
      const rows = await historyRows(id);
      expect(rows).toHaveLength(1);
    });
  });
});

/* ---------------------------------------------------------------- *
 * The profile's own history — organisation_profile_changes (Task 4)
 * ---------------------------------------------------------------- */

/**
 * `OrganisationService.putProfile` and its history, against a real Postgres.
 *
 * A sibling top-level `describeWithPg`, not a `describe` nested inside the block above:
 * `organisation_profile` is a singleton row (`id = 1`) that `organisation_profile_block_delete`
 * refuses to let anything remove, exactly like `tax_countries`' `TH` row in
 * `tax-country.pg.test.ts`, and every test below asserts an *absolute* count of its history (0,
 * 1, 2 rows) — meaningful only against a database nothing earlier in the run has touched. The
 * block above shares one `app`/`pool` across every test in it for the opposite reason: each of
 * *those* tests creates its own fresh bank account, so there is no singleton to collide over.
 *
 * Sibling rather than nested matters for a second reason: `createPgHarness`'s `harness()` drops
 * and recreates the whole test database (`provisionTestDatabase`, `DROP DATABASE … WITH
 * (FORCE)`), which terminates *any* connection still open on it — including the block above's
 * own `pool`, had its tests still been running. Vitest runs sibling `describe` blocks in
 * declaration order, each one's `afterAll` completing before the next one's `beforeAll` starts,
 * so by the time this block's first `harness()` call provisions, the block above has already
 * closed its `pool` in its own `afterAll` — there is never a second live connection for `WITH
 * (FORCE)` to terminate out from under a still-running test.
 */
describeWithPg('the profile, and its history', () => {
  const base = createPgHarness(url ?? '');
  afterAll(base.closeOpened);

  /**
   * ⚠️ **Put `deposit_bp` back, because it is no longer an inert column.**
   *
   * Every test below writes it and none of them used to have to undo that: nothing read the
   * value, so leaving the singleton at 3 000 or 5 000 bp changed nothing for the suites that run
   * afterwards. It is read now — `OrdersService.submit` plans the payment schedule from it and
   * `AuthorityService` measures the `cashflow` floor against it — so the last write in this file
   * silently reshaped every order submitted for the rest of the run. Measured, not guessed:
   * `tests/orders/lifecycle.pg.test.ts:223` failed with `expected 739584n to be 1479168n` (a 50%
   * deposit pinned where the assertion wants the whole total) and `refunds.pg.test.ts` failed 37
   * times on `instalment … is due 739584 but 1479168 is allocated to it`, purely because this
   * block happened to run first.
   *
   * `vitest.config.ts` runs one fork, one file at a time precisely so that "a suite that restores
   * what it changed can actually be relied on to have finished doing it". This is that.
   *
   * Its own pool, rather than a hook ordered against `closeOpened`: `afterAll` ordering inside one
   * suite is a Vitest configuration detail (`sequence.hooks`), and a restore that silently stops
   * running because the default changed would put the leak straight back.
   */
  afterAll(async () => {
    const restorePool = createPool(url ?? '');
    try {
      await createDatabase(restorePool).execute(
        sqlTag`update organisation_profile set deposit_bp = 10000 where id = 1`,
      );
    } finally {
      await restorePool.end();
    }
  });

  const harness = async () => {
    const { app, actor, db } = await base.harness();
    return {
      service: app.app.get(OrganisationService),
      repository: app.app.get(OrganisationRepository),
      actor,
      db,
    };
  };

  /**
   * `organisationProfilePutSchema` requires `legalNameTh`, `addressTh` and `phone` on every
   * PUT — unlike `legalNameEn`/`addressEn`/`taxId`/`email`/`depositBp`, none of the three is
   * `.optional()`. Calling `putProfile` directly (as every test below does, bypassing the HTTP
   * body pipe on purpose) still has to satisfy that same TypeScript type, so a depositBp-only
   * edit reads the three off the row currently on disk rather than guessing or hardcoding the
   * seed.
   */
  const currentCore = async (repository: OrganisationRepository) => {
    const [row] = await repository.profile();
    if (!row) throw new Error('fixture missing: organisation_profile has no row');
    return { legalNameTh: row.legalNameTh, addressTh: row.addressTh, phone: row.phone };
  };

  it('records a profile change, before and after', async () => {
    const { service, repository, actor } = await harness();
    const core = await currentCore(repository);

    await service.putProfile(actor.id, { ...core, depositBp: 3000 });
    const [entry] = await service.profileChanges();

    expect((entry?.before as { depositBp: number } | null)?.depositBp).toBe(10_000);
    expect((entry?.after as { depositBp: number })?.depositBp).toBe(3_000);
  });

  it('refuses a deposit of zero at the database, not at submit', async () => {
    const { service, repository, actor } = await harness();
    const core = await currentCore(repository);

    // Bypasses `organisationProfilePutSchema`'s own `z.int().min(1)` on purpose — the point is
    // that `organisation_profile_deposit_in_range` (migration 0029) refuses it too, so a value
    // that somehow got past validation is still refused rather than silently written.
    await expect(service.putProfile(actor.id, { ...core, depositBp: 0 })).rejects.toThrow();
    expect(await service.profileChanges()).toHaveLength(0);
  });

  /**
   * `lockProfile`'s `FOR UPDATE`, proved rather than assumed. Mutation-tested against the
   * pre-fix shape — `lockProfile` reading through a plain, unlocked `.select()` instead of
   * `.for('update')` — and confirmed red: see `task-4-report.md` for the exact run.
   */
  it('keeps profile history contiguous under concurrent updates', async () => {
    const { service, repository, actor } = await harness();
    const core = await currentCore(repository);

    await Promise.all([
      service.putProfile(actor.id, { ...core, depositBp: 3000 }),
      service.putProfile(actor.id, { ...core, depositBp: 5000 }),
    ]);

    /* Ascending, like `changes()` — see Task 3. Do not reverse: entry 1's `before` must equal
       entry 0's `after`, and on a reversed array that comparison is backwards and passes for
       the wrong reason. */
    const entries = await service.profileChanges();
    expect(entries).toHaveLength(2);
    expect((entries[1]?.before as { depositBp: number }).depositBp).toBe(
      (entries[0]?.after as { depositBp: number }).depositBp,
    );
  });
});
