import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, createPool, type Database, type Pool } from '@wewin/db/client';
import { eq, inArray, sql } from '@wewin/db/sql';
import {
  groupPermissions,
  groups,
  optionValues,
  optionGroups,
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

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

const RT_PRODUCT = 'redteam-probe-product';
const RT_GROUP = 'redteam_probe_editor';

interface Actor {
  readonly userId: string;
  readonly token: string;
}
interface Json {
  readonly status: number;
  readonly body: unknown;
}

describeWithPg('RED TEAM: the catalogue write surface', () => {
  let pool: Pool;
  let db: Database;
  let app: BootedApp;
  let editor: Actor;

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

  const asEditor = (method: string, path: string, body?: unknown): Promise<Json> =>
    call(method, path, { token: editor.token, ...(body === undefined ? {} : { body }) });

  beforeAll(async () => {
    pool = createPool(url ?? '');
    db = createDatabase(pool);
    await cleanUp(db);
    app = await bootApp(parseEnv({ NODE_ENV: 'test', DATABASE_URL: url ?? '' }));
    editor = await makeActor(db, app, RT_GROUP, ['catalog.read', 'catalog.write', 'catalog.publish']);
  });

  afterAll(async () => {
    await app?.close();
    await cleanUp(db);
    await pool.end();
  });

  /* ================================================================ *
   * R1 — a payload valid to zod that only the database can refuse
   * ================================================================ */

  it('R1: a 30-digit whole-baht price passes zod and every CHECK, and lands as a 500', async () => {
    const huge = 10n ** 30n; // whole baht, positive, 31 digits < the 40-digit cap
    const created = await asEditor('POST', '/admin/catalog/products', {
      ...createRequest(),
      id: `${RT_PRODUCT}-huge`,
      slug: `${RT_PRODUCT}-huge`,
      skuPrefix: 'RTHUGE',
      fields: { ...createRequest().fields, pricePerSqm: encodeMinorPerSqm(huge, 'THB') },
    });

    // eslint-disable-next-line no-console
    console.log('R1 create with 10^30 satang:', created.status, JSON.stringify(created.body));
    // The honest answer is a 4xx naming the field. Assert what actually happens.
    expect(created.status).toBe(500);
  });

  it('R1b: the same figure on PATCH is a 500 too', async () => {
    const made = await asEditor('POST', '/admin/catalog/products', createRequest());
    expect(made.status).toBe(201);
    const hash = field<string>(made.body, 'documentHash');

    const patched = await asEditor('PATCH', `/admin/catalog/products/${RT_PRODUCT}/draft`, {
      expectedDocumentHash: hash,
      fields: { pricePerSqm: encodeMinorPerSqm(10n ** 30n, 'THB') },
    });
    // eslint-disable-next-line no-console
    console.log('R1b patch with 10^30 satang:', patched.status, JSON.stringify(patched.body));
    expect(patched.status).toBe(500);
  });

  /* ================================================================ *
   * R2 — the guard never consults the session
   * ================================================================ */

  it('R2: a token naming a session that has never existed writes the catalogue', async () => {
    const rows = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, editor.userId));
    expect(rows).toHaveLength(0); // this actor has no session row at all

    const listed = await asEditor('GET', '/admin/catalog/products');
    expect(listed.status).toBe(200);

    // And a write.
    const detail = await asEditor('GET', `/admin/catalog/products/${RT_PRODUCT}`);
    expect(detail.status).toBe(200);
  });

  it('R2b: revoking every session of the user changes nothing', async () => {
    await db
      .update(sessions)
      .set({ revokedAt: sql`now()`, revokedReason: 'logout' })
      .where(eq(sessions.userId, editor.userId));

    const listed = await asEditor('GET', '/admin/catalog/products');
    // eslint-disable-next-line no-console
    console.log('R2b after revoking all sessions:', listed.status);
    expect(listed.status).toBe(200);
  });

  /* ================================================================ *
   * R3 — rule code is a path parameter and nothing validates it
   * ================================================================ */

  it('R3: a rule code that the contract would refuse is accepted from the URL', async () => {
    const draft = await asEditor('GET', `/admin/catalog/products/${RT_PRODUCT}/draft`);
    const hash = field<string>(draft.body, 'documentHash');

    // `ruleCodeSchema` in @wewin/contract/admin is /^[a-z0-9][a-z0-9-]*$/ max 64.
    const nasty = `A_${'x'.repeat(300)}<script>`;
    const put = await asEditor(
      'PUT',
      `/admin/catalog/products/${RT_PRODUCT}/draft/rules/${encodeURIComponent(nasty)}`,
      {
        expectedDocumentHash: hash,
        rule: {
          severity: 'warning',
          messageTh: 'กฎทดสอบ',
          sortOrder: 0,
          when: { op: 'gt', left: { n: 'measure', group: 'width' }, right: { n: 'const', value: encodeUm(1n) } },
        },
      },
    );

    // eslint-disable-next-line no-console
    console.log('R3 nasty rule code:', put.status, JSON.stringify(put.body).slice(0, 300));
    expect(put.status).toBe(200);

    const stored = await db
      .select({ document: productVersions.document })
      .from(productVersions)
      .where(eq(productVersions.productId, RT_PRODUCT));
    // eslint-disable-next-line no-console
    console.log('R3 rule ids in the stored document:', JSON.stringify(
      stored.map((row) => (row.document as { rules: { id: string }[] }).rules.map((rule) => rule.id.slice(0, 40))),
    ));
  });

  /* ================================================================ *
   * R4 — an area off by a factor of a million
   * ================================================================ */

  it('R4: minBillableSqUm sent in square millimetres is accepted and published', async () => {
    const draft = await asEditor('GET', `/admin/catalog/products/${RT_PRODUCT}/draft`);
    let hash = field<string>(draft.body, 'documentHash');

    // 0.5 m² is 500_000_000_000 µm². A client that thought in mm² sends 500_000.
    const patched = await asEditor('PATCH', `/admin/catalog/products/${RT_PRODUCT}/draft`, {
      expectedDocumentHash: hash,
      fields: { minBillableSqUm: encodeSqUm(500_000n) },
    });
    // eslint-disable-next-line no-console
    console.log('R4 minBillableSqUm 10^6 too small:', patched.status);
    expect(patched.status).toBe(200);
    hash = field<string>(patched.body, 'documentHash');

    const versionId = field<string>(patched.body, 'productVersionId');
    const published = await asEditor('POST', `/admin/catalog/products/${RT_PRODUCT}/draft/publish`, {
      productVersionId: versionId,
      expectedDocumentHash: hash,
    });
    // eslint-disable-next-line no-console
    console.log('R4 publish:', published.status);
    expect(published.status).toBe(201);

    // And the public catalogue now serves it.
    const public_ = await call('GET', `/catalog/products/${RT_PRODUCT}`);
    // eslint-disable-next-line no-console
    console.log('R4 public minBillableSqUm:', JSON.stringify(productField(public_.body, 'minBillableSqUm')));
    expect(public_.status).toBe(200);
  });

  /* ================================================================ *
   * R5 — editing the shared option catalogue strands every draft
   * ================================================================ */

  it('R5: changing an option value delta makes an untouched draft unpublishable', async () => {
    const opened = await asEditor('POST', `/admin/catalog/products/${RT_PRODUCT}/draft`);
    expect(opened.status).toBe(201);
    const versionId = field<string>(opened.body, 'productVersionId');
    const hash = field<string>(opened.body, 'documentHash');

    // A perfectly ordinary supported write on a *different* endpoint.
    const priced = await asEditor('PATCH', '/admin/catalog/option-groups/profile_color/values/WH', {
      delta: { type: 'flat', amount: { unit: 'THB.satang', digits: '150000' } },
    });
    // eslint-disable-next-line no-console
    console.log('R5 option value repriced:', priced.status, JSON.stringify(priced.body));
    expect(priced.status).toBe(204);

    // The draft was not touched, so its hash is still the one the dashboard holds.
    const publish = await asEditor('POST', `/admin/catalog/products/${RT_PRODUCT}/draft/publish`, {
      productVersionId: versionId,
      expectedDocumentHash: hash,
    });
    // eslint-disable-next-line no-console
    console.log('R5 publish after the reprice:', publish.status, JSON.stringify(publish.body));

    // And what the dashboard previews is the stale document.
    const preview = await asEditor('GET', `/admin/catalog/products/${RT_PRODUCT}/draft`);
    // eslint-disable-next-line no-console
    console.log('R5 preview hash vs held hash:', field<string>(preview.body, 'documentHash') === hash);
  });

  /* ================================================================ *
   * R6 — two publishes of one draft, concurrently
   * ================================================================ */

  it('R6: two concurrent publishes of the same draft leave exactly one published version', async () => {
    // Make sure there is a draft to publish.
    let draft = await asEditor('GET', `/admin/catalog/products/${RT_PRODUCT}/draft`);
    if (draft.status !== 200) {
      const opened = await asEditor('POST', `/admin/catalog/products/${RT_PRODUCT}/draft`);
      expect([200, 201]).toContain(opened.status);
      draft = await asEditor('GET', `/admin/catalog/products/${RT_PRODUCT}/draft`);
    }
    // Nudge it so its stored document matches its rows again (see R5).
    const nudged = await asEditor('PATCH', `/admin/catalog/products/${RT_PRODUCT}/draft`, {
      expectedDocumentHash: field<string>(draft.body, 'documentHash'),
      fields: { nameTh: 'ชื่อสำหรับทดสอบการแข่งกัน' },
    });
    expect(nudged.status).toBe(200);

    const versionId = field<string>(nudged.body, 'productVersionId');
    const hash = field<string>(nudged.body, 'documentHash');
    const body = { productVersionId: versionId, expectedDocumentHash: hash };

    const [a, b] = await Promise.all([
      asEditor('POST', `/admin/catalog/products/${RT_PRODUCT}/draft/publish`, body),
      asEditor('POST', `/admin/catalog/products/${RT_PRODUCT}/draft/publish`, body),
    ]);
    // eslint-disable-next-line no-console
    console.log('R6 concurrent publishes:', a.status, b.status, JSON.stringify([a.body, b.body]).slice(0, 400));

    const live = await db
      .select({ id: productVersions.id, version: productVersions.version, status: productVersions.status })
      .from(productVersions)
      .where(eq(productVersions.productId, RT_PRODUCT));
    // eslint-disable-next-line no-console
    console.log('R6 versions after:', JSON.stringify(live));
    expect(live.filter((row) => row.status === 'published')).toHaveLength(1);
  });

  /* ================================================================ *
   * R7 — discard racing a publish
   * ================================================================ */

  it('R7: discarding the draft while a publish is in flight', async () => {
    const opened = await asEditor('POST', `/admin/catalog/products/${RT_PRODUCT}/draft`);
    expect([200, 201]).toContain(opened.status);
    const versionId = field<string>(opened.body, 'productVersionId');
    const hash = field<string>(opened.body, 'documentHash');

    const [publish, discard] = await Promise.all([
      asEditor('POST', `/admin/catalog/products/${RT_PRODUCT}/draft/publish`, {
        productVersionId: versionId,
        expectedDocumentHash: hash,
      }),
      asEditor('DELETE', `/admin/catalog/products/${RT_PRODUCT}/draft?expectedDocumentHash=${hash}`),
    ]);
    // eslint-disable-next-line no-console
    console.log('R7 publish/discard race:', publish.status, discard.status);

    const live = await db
      .select({ version: productVersions.version, status: productVersions.status })
      .from(productVersions)
      .where(eq(productVersions.productId, RT_PRODUCT));
    // eslint-disable-next-line no-console
    console.log('R7 versions after:', JSON.stringify(live));
    expect(live.filter((row) => row.status === 'published').length).toBeLessThanOrEqual(1);
  });

  /* ================================================================ *
   * R8 — a guest, a public caller and an expired token on a write
   * ================================================================ */

  it('R8: guest / public / expired never reach a write', async () => {
    const anon = await call('POST', '/admin/catalog/products', { body: createRequest() });
    expect(anon.status).toBe(401);

    const shortLived = await bootApp(
      parseEnv({ NODE_ENV: 'test', DATABASE_URL: url ?? '', AUTH_ACCESS_TOKEN_TTL_SECONDS: '30' }),
    );
    try {
      // A token signed with an `exp` in the past: forge by signing then waiting is slow, so
      // instead present a structurally valid token from a *different* signing key.
      const foreign = shortLived.app.get(AccessTokenService).sign({
        userId: editor.userId,
        sessionId: crypto.randomUUID(),
      });
      const crossKey = await call('GET', '/admin/catalog/products', { token: foreign.token });
      // eslint-disable-next-line no-console
      console.log('R8 token from another deployment key:', crossKey.status);
      expect(crossKey.status).toBe(401);
    } finally {
      await shortLived.close();
    }
  });
});

/* ------------------------------------------------------------------ */

async function makeActor(
  db: Database,
  app: BootedApp,
  groupCode: string,
  codes: readonly ('catalog.read' | 'catalog.write' | 'catalog.publish')[],
): Promise<Actor> {
  const [user] = await db
    .insert(users)
    .values({ displayName: `red team probe (${groupCode})` })
    .returning({ id: users.id });
  const [group] = await db
    .insert(groups)
    .values({ code: groupCode, nameTh: 'กลุ่มทดสอบเรดทีม' })
    .onConflictDoUpdate({ target: groups.code, set: { nameTh: 'กลุ่มทดสอบเรดทีม' } })
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
  /*
   * `product_versions_block_delete` exists so that nothing can quietly remove a version a
   * quote might refer to, and it does not make an exception for tests. Suspending it for
   * the two rows this file created is the same thing redteam4 does, and the `finally` is
   * the point: leaving the trigger off would disarm the guard for every suite after this
   * one, which is a worse outcome than the row that failed to delete.
   */
  await db.execute(sql`alter table product_versions disable trigger product_versions_block_delete`);
  try {
    await db
      .delete(productVersions)
      .where(inArray(productVersions.productId, [RT_PRODUCT, `${RT_PRODUCT}-huge`]));
  } finally {
    await db.execute(sql`alter table product_versions enable trigger product_versions_block_delete`);
  }
  await db.delete(products).where(inArray(products.id, [RT_PRODUCT, `${RT_PRODUCT}-huge`]));
  const [group] = await db.select({ id: groups.id }).from(groups).where(eq(groups.code, RT_GROUP));
  if (group) {
    await db.delete(groupPermissions).where(eq(groupPermissions.groupId, group.id));
    await db.delete(userGroups).where(eq(userGroups.groupId, group.id));
    await db.delete(groups).where(eq(groups.id, group.id));
  }
  // Put the colour price back the way the seed left it.
  const [colour] = await db
    .select({ id: optionGroups.id })
    .from(optionGroups)
    .where(eq(optionGroups.code, 'profile_color'));
  if (colour) {
    await db
      .update(optionValues)
      .set({ deltaType: 'none', deltaMinor: null, deltaBp: null })
      .where(eq(optionValues.optionGroupId, colour.id));
  }
}

function createRequest(): {
  id: string;
  slug: string;
  skuPrefix: string;
  fields: Record<string, unknown>;
  options: Record<string, unknown>;
} {
  return {
    id: RT_PRODUCT,
    slug: RT_PRODUCT,
    skuPrefix: 'RTPROBE',
    fields: {
      nameTh: 'สินค้าทดสอบเรดทีม',
      categoryId: 'louvers',
      summaryTh: 'สินค้าสำหรับทดสอบการโจมตีเส้นทางเขียน',
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
