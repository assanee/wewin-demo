import { randomInt, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, createPool, type Database, type Pool } from '@wewin/db/client';
import { eq } from '@wewin/db/sql';
import { bankAccountChanges, groupPermissions, groups, userGroups, users } from '@wewin/db/schema';

import { AccessTokenService } from '../../src/auth/session/access-token';
import { parseEnv } from '../../src/config/env';
import type { PermissionCode } from '../../src/rbac';
import { encodeAccountPublic } from '../../src/organisation/encode';
import { OrganisationRepository } from '../../src/organisation/organisation.repository';
import { bootApp, type BootedApp } from '../support/app';

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

    it('refuses a caller without organisation.write, and an anonymous caller entirely', async () => {
      const anonymous = await call('POST', '/admin/organisation/bank-accounts', {
        body: createRequest(),
      });
      expect(anonymous.status).toBe(401);

      const refused = await asReader('POST', '/admin/organisation/bank-accounts', createRequest());
      expect(refused.status).toBe(403);
      const message = (refused.body?.['error'] as { message?: string } | undefined)?.message;
      expect(message).toContain('organisation.write');
    });
  });
});
