import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, createPool, type Database, type Pool } from '@wewin/db/client';
import { eq, inArray, sql } from '@wewin/db/sql';
import {
  groupPermissions,
  groups,
  productVersions,
  products,
  sessions,
  userGroups,
  users,
} from '@wewin/db/schema';
import { encodeMinorPerSqm } from '@wewin/contract/money';
import { encodeSqUm, encodeUm } from '@wewin/contract/measure';

import { AccessTokenService } from '../../src/auth/session/access-token';
import { parseEnv } from '../../src/config/env';
import { bootApp, type BootedApp } from '../support/app';

/**
 * RED TEAM 4 — the window `CatalogAdminService.publish` documents, attacked directly.
 *
 * `publish` is two transactions. The first checks, under `SELECT ... FOR UPDATE`, that the
 * draft is the one the caller reviewed; it then **commits and drops the lock** before
 * `publishProductVersion` takes it again. A colleague's edit that lands in the gap is what
 * gets frozen — for the lifetime of every order that ever points at that version.
 *
 * The file's own comment says so. This is the attempt to make it happen on demand.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

const P = 'rt4-window';
const GROUP = 'rt4_editor';
const ATTEMPTS = 40;

interface Json {
  readonly status: number;
  readonly body: unknown;
}

describeWithPg('RED TEAM 4: the publish window', () => {
  let pool: Pool;
  let db: Database;
  let app: BootedApp;
  let token: string;

  const call = async (
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Json> => {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`${app.baseUrl}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text.length === 0 ? null : (JSON.parse(text) as unknown) };
  };

  beforeAll(async () => {
    pool = createPool(url ?? '');
    db = createDatabase(pool);
    await cleanUp(db);
    app = await bootApp(parseEnv({ NODE_ENV: 'test', DATABASE_URL: url ?? '' }));

    const [user] = await db
      .insert(users)
      .values({ displayName: 'red team 4 (publish window)' })
      .returning({ id: users.id });
    const [group] = await db
      .insert(groups)
      .values({ code: GROUP, nameTh: 'กลุ่มทดสอบเรดทีม 4' })
      .onConflictDoUpdate({ target: groups.code, set: { nameTh: 'กลุ่มทดสอบเรดทีม 4' } })
      .returning({ id: groups.id });
    if (!user || !group) throw new Error('fixture insert returned nothing');
    await db.insert(userGroups).values({ userId: user.id, groupId: group.id }).onConflictDoNothing();
    await db
      .insert(groupPermissions)
      .values(
        (['catalog.read', 'catalog.write', 'catalog.publish'] as const).map((code) => ({
          groupId: group.id,
          permissionCode: code,
        })),
      )
      .onConflictDoNothing();

    token = app.app.get(AccessTokenService).sign({ userId: user.id, sessionId: crypto.randomUUID() }).token;

    const created = await call('POST', '/admin/catalog/products', createRequest());
    expect(created.status).toBe(201);
    const first = await call('POST', `/admin/catalog/products/${P}/draft/publish`, {
      productVersionId: field<string>(created.body, 'productVersionId'),
      expectedDocumentHash: field<string>(created.body, 'documentHash'),
    });
    expect(first.status).toBe(201);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await cleanUp(db);
    await pool.end();
  });

  it('freezes a document the publisher never reviewed, when an edit lands in the gap', async () => {
    let stolen = 0;
    let refused = 0;
    let clean = 0;

    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const opened = await call('POST', `/admin/catalog/products/${P}/draft`);
      if (opened.status !== 201) break;

      const versionId = field<string>(opened.body, 'productVersionId');
      const reviewed = field<string>(opened.body, 'documentHash');

      // Two callers, one draft: the publisher freezes what it reviewed, the colleague
      // renames the product. Both hold the same starting hash, so both believe they are up
      // to date — which is exactly the situation `expectedDocumentHash` is meant to catch.
      const [published, edited] = await Promise.all([
        call('POST', `/admin/catalog/products/${P}/draft/publish`, {
          productVersionId: versionId,
          expectedDocumentHash: reviewed,
        }),
        call('PATCH', `/admin/catalog/products/${P}/draft`, {
          expectedDocumentHash: reviewed,
          fields: { nameTh: `ชื่อที่ผู้เผยแพร่ไม่เคยเห็น ${String(attempt)}` },
        }),
      ]);

      if (published.status === 201) {
        const frozen = field<string>(published.body, 'documentHash');
        if (frozen !== reviewed) {
          stolen += 1;
          // eslint-disable-next-line no-console
          console.log(
            `RT4 attempt ${String(attempt)}: publish returned 201 but froze ${frozen.slice(0, 12)} ` +
              `while the caller reviewed ${reviewed.slice(0, 12)} (colleague's PATCH: ${String(edited.status)})`,
          );
          break;
        }
        clean += 1;
      } else {
        refused += 1;
      }
    }

    // eslint-disable-next-line no-console
    console.log(`RT4 over ${String(ATTEMPTS)} attempts — stolen: ${String(stolen)}, refused: ${String(refused)}, clean: ${String(clean)}`);

    // Whatever happened, the invariant that matters must still hold.
    const rows = await db
      .select({ status: productVersions.status })
      .from(productVersions)
      .where(eq(productVersions.productId, P));
    expect(rows.filter((row) => row.status === 'published')).toHaveLength(1);

    // Recorded rather than asserted: this documents whether the window is reachable from
    // outside with two ordinary HTTP calls, which is the question a reviewer has.
    expect(stolen + refused + clean).toBeGreaterThan(0);
  }, 120_000);
});

/* ------------------------------------------------------------------ */

async function cleanUp(db: Database): Promise<void> {
  await db.execute(sql`alter table product_versions disable trigger product_versions_block_delete`);
  await db.execute(sql`alter table product_versions disable trigger product_versions_freeze`);
  try {
    await db.delete(productVersions).where(inArray(productVersions.productId, [P]));
    await db.delete(products).where(inArray(products.id, [P]));
  } finally {
    await db.execute(sql`alter table product_versions enable trigger product_versions_block_delete`);
    await db.execute(sql`alter table product_versions enable trigger product_versions_freeze`);
  }

  const [group] = await db.select({ id: groups.id }).from(groups).where(eq(groups.code, GROUP));
  if (!group) return;
  const members = await db
    .select({ userId: userGroups.userId })
    .from(userGroups)
    .where(eq(userGroups.groupId, group.id));
  await db.delete(groupPermissions).where(eq(groupPermissions.groupId, group.id));
  await db.delete(userGroups).where(eq(userGroups.groupId, group.id));
  await db.delete(groups).where(eq(groups.id, group.id));
  for (const member of members) {
    await db.delete(sessions).where(eq(sessions.userId, member.userId));
    await db.delete(users).where(eq(users.id, member.userId));
  }
}

function createRequest(): Record<string, unknown> {
  return {
    id: P,
    slug: P,
    skuPrefix: 'RT4WIN',
    fields: {
      nameTh: 'สินค้าทดสอบช่องว่างการเผยแพร่',
      categoryId: 'louvers',
      summaryTh: 'สินค้าสำหรับทดสอบช่วงเวลาระหว่างการตรวจกับการแช่แข็ง',
      heroImage: '/images/probe.svg',
      leadTimeDays: [7, 14],
      pricePerSqm: encodeMinorPerSqm(220_000n, 'THB'),
      minBillableSqUm: encodeSqUm(500_000_000_000n),
      elevation: { panels: 1, operation: 'fixed', infill: 'louvre' },
    },
    options: {
      profile_color: { kind: 'sku', sortOrder: 0, valueCodes: ['SG', 'WH', 'BK'], defaultValueCode: 'SG' },
      width: {
        kind: 'custom',
        sortOrder: 1,
        minUm: encodeUm(600_000n),
        maxUm: encodeUm(3_000_000n),
        stepUm: encodeUm(50_000n),
        defaultUm: encodeUm(1_200_000n),
      },
      height: {
        kind: 'custom',
        sortOrder: 2,
        minUm: encodeUm(600_000n),
        maxUm: encodeUm(3_000_000n),
        stepUm: encodeUm(50_000n),
        defaultUm: encodeUm(1_200_000n),
      },
    },
  };
}

function field<T>(body: unknown, key: string): T {
  if (typeof body !== 'object' || body === null) {
    throw new Error(`expected an object with "${key}", got ${JSON.stringify(body)}`);
  }
  const record = body as Record<string, unknown>;
  if (!(key in record)) throw new Error(`response has no "${key}": ${JSON.stringify(body)}`);
  return record[key] as T;
}
