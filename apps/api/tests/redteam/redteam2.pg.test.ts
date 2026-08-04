import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, createPool, type Database, type Pool } from '@wewin/db/client';
import { eq, inArray } from '@wewin/db/sql';
import {
  groupPermissions,
  groups,
  productVersions,
  products,
  userGroups,
  users,
} from '@wewin/db/schema';
import { encodeMinorPerSqm } from '@wewin/contract/money';
import { encodeSqUm, encodeUm } from '@wewin/contract/measure';

import { AccessTokenService } from '../../src/auth/session/access-token';
import { parseEnv } from '../../src/config/env';
import { bootApp, type BootedApp } from '../support/app';

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

const P = 'redteam2-probe';
const WRITER_GROUP = 'redteam2_writer_only';

interface Actor {
  readonly userId: string;
  readonly token: string;
}
interface Json {
  readonly status: number;
  readonly body: unknown;
}

describeWithPg('RED TEAM 2: what catalog.write alone can change for customers', () => {
  let pool: Pool;
  let db: Database;
  let app: BootedApp;
  let writer: Actor;
  let publisher: Actor;

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

  beforeAll(async () => {
    pool = createPool(url ?? '');
    db = createDatabase(pool);
    await cleanUp(db);
    app = await bootApp(parseEnv({ NODE_ENV: 'test', DATABASE_URL: url ?? '' }));
    writer = await makeActor(db, app, WRITER_GROUP, ['catalog.read', 'catalog.write']);
    publisher = await makeActor(db, app, `${WRITER_GROUP}_pub`, [
      'catalog.read',
      'catalog.write',
      'catalog.publish',
    ]);
  });

  afterAll(async () => {
    await app?.close();
    await cleanUp(db);
    await pool.end();
  });

  it('R9: an actor with catalog.write but NOT catalog.publish moves a published product\'s public URL', async () => {
    // Set the stage with somebody who *is* allowed to publish.
    const created = await call('POST', '/admin/catalog/products', {
      token: publisher.token,
      body: createRequest(),
    });
    expect(created.status).toBe(201);
    const published = await call('POST', `/admin/catalog/products/${P}/draft/publish`, {
      token: publisher.token,
      body: {
        productVersionId: field<string>(created.body, 'productVersionId'),
        expectedDocumentHash: field<string>(created.body, 'documentHash'),
      },
    });
    expect(published.status).toBe(201);

    const before = await call('GET', `/catalog/products/${P}`);
    expect(before.status).toBe(200);

    /* --- now the writer, who cannot publish --- */
    const refused = await call('POST', `/admin/catalog/products/${P}/draft/publish`, {
      token: writer.token,
      body: { productVersionId: '00000000-0000-4000-8000-000000000000', expectedDocumentHash: 'a'.repeat(64) },
    });
    expect(refused.status).toBe(403); // they genuinely cannot publish

    const opened = await call('POST', `/admin/catalog/products/${P}/draft`, { token: writer.token });
    expect(opened.status).toBe(201);

    const renamed = await call('PATCH', `/admin/catalog/products/${P}/draft`, {
      token: writer.token,
      body: { expectedDocumentHash: field<string>(opened.body, 'documentHash'), slug: `${P}-moved` },
    });
    // eslint-disable-next-line no-console
    console.log('R9 slug patch by a writer who cannot publish:', renamed.status);
    expect(renamed.status).toBe(200);

    /* --- what the *public* catalogue does now, with no publish anywhere --- */
    const oldUrl = await call('GET', `/catalog/products/${P}`);
    const newUrl = await call('GET', `/catalog/products/${P}-moved`);
    // eslint-disable-next-line no-console
    console.log('R9 public GET old slug:', oldUrl.status, '| new slug:', newUrl.status);

    const listed = await call('GET', '/catalog/products');
    const inList = JSON.stringify(listed.body).includes(`"${P}-moved"`);
    // eslint-disable-next-line no-console
    console.log('R9 the served document still calls itself:', JSON.stringify(productField(newUrl.body, 'slug')));
    // eslint-disable-next-line no-console
    console.log('R9 list mentions the new slug at all:', inList);

    expect(oldUrl.status).toBe(404); // every existing link to this product is now dead
    expect(newUrl.status).toBe(200); // and it answers on a URL nobody published
  });

  it('R10: the option catalogue has no optimistic-concurrency handle at all', async () => {
    // Two editors, no hash, no version: the second silently wins.
    const first = await call('PATCH', '/admin/catalog/option-groups/profile_color', {
      token: writer.token,
      body: { labelTh: 'สีจากบรรณาธิการ ก' },
    });
    const second = await call('PATCH', '/admin/catalog/option-groups/profile_color', {
      token: publisher.token,
      body: { labelTh: 'สีจากบรรณาธิการ ข' },
    });
    // eslint-disable-next-line no-console
    console.log('R10 two blind writes:', first.status, second.status);
    expect(first.status).toBe(204);
    expect(second.status).toBe(204);
  });

  it('R11: PATCH on a group code that does not exist answers 204 as though it worked', async () => {
    const ghost = await call('PATCH', '/admin/catalog/option-groups/no_such_group_at_all', {
      token: writer.token,
      body: { labelTh: 'ไม่มีอยู่จริง' },
    });
    // eslint-disable-next-line no-console
    console.log('R11 PATCH a non-existent option group:', ghost.status, JSON.stringify(ghost.body));
  });

  it('R12: an empty PATCH body on an option group answers 204 having done nothing', async () => {
    const empty = await call('PATCH', '/admin/catalog/option-groups/profile_color', {
      token: writer.token,
      body: {},
    });
    // eslint-disable-next-line no-console
    console.log('R12 empty option-group patch:', empty.status);
  });
});

async function makeActor(
  db: Database,
  app: BootedApp,
  groupCode: string,
  codes: readonly ('catalog.read' | 'catalog.write' | 'catalog.publish')[],
): Promise<Actor> {
  const [user] = await db
    .insert(users)
    .values({ displayName: `red team 2 (${groupCode})` })
    .returning({ id: users.id });
  const [group] = await db
    .insert(groups)
    .values({ code: groupCode, nameTh: 'กลุ่มทดสอบเรดทีม 2' })
    .onConflictDoUpdate({ target: groups.code, set: { nameTh: 'กลุ่มทดสอบเรดทีม 2' } })
    .returning({ id: groups.id });
  if (!user || !group) throw new Error('fixture insert returned nothing');
  await db.insert(userGroups).values({ userId: user.id, groupId: group.id }).onConflictDoNothing();
  await db
    .insert(groupPermissions)
    .values(codes.map((code) => ({ groupId: group.id, permissionCode: code })))
    .onConflictDoNothing();
  const issued = app.app.get(AccessTokenService).sign({ userId: user.id, sessionId: crypto.randomUUID() });
  return { userId: user.id, token: issued.token };
}

async function cleanUp(db: Database): Promise<void> {
  // Drafts first; archived and published rows are frozen against DELETE, so drop the
  // whole product and let the cascade take its versions with it.
  await db.delete(productVersions).where(
    inArray(productVersions.productId, [P]),
  ).catch(() => undefined);
  await db.delete(products).where(inArray(products.id, [P])).catch(() => undefined);
  for (const code of [WRITER_GROUP, `${WRITER_GROUP}_pub`]) {
    const [group] = await db.select({ id: groups.id }).from(groups).where(eq(groups.code, code));
    if (!group) continue;
    await db.delete(groupPermissions).where(eq(groupPermissions.groupId, group.id));
    await db.delete(userGroups).where(eq(userGroups.groupId, group.id));
    await db.delete(groups).where(eq(groups.id, group.id));
  }
}

function createRequest(): Record<string, unknown> {
  return {
    id: P,
    slug: P,
    skuPrefix: 'RTTWO',
    fields: {
      nameTh: 'สินค้าทดสอบเรดทีมสอง',
      categoryId: 'louvers',
      summaryTh: 'สินค้าสำหรับทดสอบสิทธิ์การเขียน',
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

function asRecord(body: unknown, what: string): Record<string, unknown> {
  if (typeof body !== 'object' || body === null) {
    throw new Error(`expected ${what} to be an object, got ${JSON.stringify(body)}`);
  }
  return body as Record<string, unknown>;
}
function field<T>(body: unknown, key: string): T {
  const record = asRecord(body, `a response with "${key}"`);
  if (!(key in record)) throw new Error(`response has no "${key}": ${JSON.stringify(body)}`);
  return record[key] as T;
}
function productField(body: unknown, key: string): unknown {
  return asRecord(field(body, 'product'), 'a product')[key];
}
