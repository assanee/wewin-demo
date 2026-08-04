import { createHmac } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, createPool, type Database, type Pool } from '@wewin/db/client';
import { and, eq, inArray, sql } from '@wewin/db/sql';
import {
  groupPermissions,
  groups,
  guests,
  productVersions,
  products,
  sessions,
  userGroups,
  users,
} from '@wewin/db/schema';
import { encodeMinorPerSqm } from '@wewin/contract/money';
import { encodeSqUm, encodeUm } from '@wewin/contract/measure';

import { SessionService } from '../../src/auth/session/session.service';
import { SESSION_CONFIG } from '../../src/auth/session/session.tokens';
import type { SessionConfig } from '../../src/auth/session/session.config';
import { parseEnv } from '../../src/config/env';
import { bootApp, type BootedApp } from '../support/app';

/**
 * RED TEAM 3 — reproductions written against the admin write API as it stands.
 *
 * Every `it` here is an attack, and each one asserts *what actually happens* rather than
 * what should. Where the defence holds the assertion is the defence; where it does not the
 * assertion pins the hole so the owner can see it fail to be fixed.
 *
 * Nothing in this file fixes anything. It is evidence.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

const P = 'rt3-probe';
const WRITER = 'rt3_writer';
const PUBLISHER = 'rt3_publisher';
const NOBODY = 'rt3_nobody';

interface Actor {
  readonly userId: string;
  readonly sessionId: string;
  readonly token: string;
}
interface Json {
  readonly status: number;
  readonly body: unknown;
}

describeWithPg('RED TEAM 3: authorisation, sessions and the freeze', () => {
  let pool: Pool;
  let db: Database;
  let app: BootedApp;
  let writer: Actor;
  let publisher: Actor;
  let nobody: Actor;
  let config: SessionConfig;

  const call = async (
    method: string,
    path: string,
    options: { readonly token?: string; readonly body?: unknown; readonly cookie?: string } = {},
  ): Promise<Json> => {
    const headers: Record<string, string> = {};
    if (options.token !== undefined) headers['authorization'] = `Bearer ${options.token}`;
    if (options.cookie !== undefined) headers['cookie'] = options.cookie;
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
    config = app.app.get<SessionConfig>(SESSION_CONFIG);

    writer = await makeActor(db, app, WRITER, ['catalog.read', 'catalog.write']);
    publisher = await makeActor(db, app, PUBLISHER, ['catalog.read', 'catalog.write', 'catalog.publish']);
    nobody = await makeActor(db, app, NOBODY, []);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await cleanUp(db);
    await pool.end();
  });

  /* ================================================================ *
   * A. The session the token names is never consulted
   * ================================================================ */

  it('A1: an access token whose session was revoked (logout) still writes the catalogue', async () => {
    // A real session row, not a synthetic sid: this is what a signed-in operator holds.
    const live = await call('GET', '/admin/catalog/products', { token: publisher.token });
    expect(live.status).toBe(200);

    const revoked = await app.app
      .get(SessionService)
      .signOut(publisher.sessionId, publisher.userId);
    expect(revoked).toBe(true);

    const [row] = await db
      .select({ revokedAt: sessions.revokedAt, reason: sessions.revokedReason })
      .from(sessions)
      .where(eq(sessions.id, publisher.sessionId));
    expect(row?.revokedAt).not.toBeNull();

    // Same bearer token, after sign-out. A read...
    const afterRead = await call('GET', '/admin/catalog/products', { token: publisher.token });
    // ...and a write that creates a product and its first draft.
    const afterWrite = await call('POST', '/admin/catalog/products', {
      token: publisher.token,
      body: createRequest(`${P}-revoked`, 'RT3REV'),
    });

    // eslint-disable-next-line no-console
    console.log(
      'A1 after signOut — read:',
      afterRead.status,
      'write:',
      afterWrite.status,
      JSON.stringify(afterWrite.body).slice(0, 160),
    );
    expect(afterRead.status).toBe(200);
    expect(afterWrite.status).toBe(201); // the revoked session still edits the catalogue
  });

  it('A2: the same token stops working the moment the *account* is suspended', async () => {
    await db
      .update(users)
      .set({ status: 'suspended', suspendedAt: new Date() })
      .where(eq(users.id, nobody.userId));
    const suspended = await call('GET', '/admin/catalog/products', { token: nobody.token });
    // eslint-disable-next-line no-console
    console.log('A2 suspended account:', suspended.status);
    expect(suspended.status).toBe(401);
    await db
      .update(users)
      .set({ status: 'active', suspendedAt: null })
      .where(eq(users.id, nobody.userId));
  });

  it('A3: a signed-but-expired token, an alg:none token and a tampered token are all refused', async () => {
    const now = Math.floor(Date.now() / 1000);
    const key = config.accessTokenKey;

    const expired = signToken(key, {
      iss: config.issuer,
      sub: publisher.userId,
      sid: publisher.sessionId,
      jti: crypto.randomUUID(),
      iat: now - 3600,
      exp: now - 60,
    });
    const none = unsignedToken({
      iss: config.issuer,
      sub: publisher.userId,
      sid: publisher.sessionId,
      jti: crypto.randomUUID(),
      iat: now,
      exp: now + 600,
    });
    // A valid token with the payload swapped for another user's, signature untouched.
    const parts = publisher.token.split('.');
    const tamperedPayload = Buffer.from(
      JSON.stringify({
        iss: config.issuer,
        sub: nobody.userId,
        sid: publisher.sessionId,
        jti: crypto.randomUUID(),
        iat: now,
        exp: now + 600,
      }),
      'utf8',
    ).toString('base64url');
    const tampered = `${parts[0] ?? ''}.${tamperedPayload}.${parts[2] ?? ''}`;

    const wrongIssuer = signToken(key, {
      iss: 'https://not-this-deployment.example',
      sub: publisher.userId,
      sid: publisher.sessionId,
      jti: crypto.randomUUID(),
      iat: now,
      exp: now + 600,
    });

    for (const [name, token] of [
      ['expired', expired],
      ['alg:none', none],
      ['tampered', tampered],
      ['wrong issuer', wrongIssuer],
    ] as const) {
      const answer = await call('POST', '/admin/catalog/products', {
        token,
        body: createRequest(`${P}-forged`, 'RT3FRG'),
      });
      // eslint-disable-next-line no-console
      console.log(`A3 ${name}:`, answer.status);
      expect(answer.status).toBe(401);
    }
  });

  it('A4: a guest — real row, real cookie — cannot reach a write', async () => {
    const [guest] = await db.insert(guests).values({}).returning({ id: guests.id });
    if (!guest) throw new Error('no guest row');

    // COOKIE_SECURE is off under test, so the cookie carries the bare name.
    const asGuest = await call('POST', '/admin/catalog/products', {
      cookie: `wewin_guest=${guest.id}`,
      body: createRequest(`${P}-guest`, 'RT3GST'),
    });
    const guestRead = await call('GET', '/admin/catalog/products', {
      cookie: `wewin_guest=${guest.id}`,
    });
    // eslint-disable-next-line no-console
    console.log('A4 guest write:', asGuest.status, 'guest read:', guestRead.status);
    expect(asGuest.status).toBe(401);
    expect(guestRead.status).toBe(401);

    await db.delete(guests).where(eq(guests.id, guest.id));
  });

  it('A5: a signed-in user with no catalogue permission is refused every write', async () => {
    const paths: readonly (readonly [string, string])[] = [
      ['POST', '/admin/catalog/products'],
      ['POST', `/admin/catalog/products/${P}/draft`],
      ['PATCH', `/admin/catalog/products/${P}/draft`],
      ['PUT', `/admin/catalog/products/${P}/draft/options/profile_color`],
      ['PUT', `/admin/catalog/products/${P}/draft/rules/x`],
      ['POST', `/admin/catalog/products/${P}/draft/publish`],
      ['PATCH', '/admin/catalog/option-groups/profile_color'],
      ['POST', '/admin/catalog/option-groups/profile_color/values'],
      ['PATCH', '/admin/catalog/option-groups/profile_color/values/WH'],
      ['PUT', '/admin/catalog/option-groups/profile_color/values/WH/availability'],
    ];
    for (const [method, path] of paths) {
      const answer = await call(method, path, { token: nobody.token, body: {} });
      expect([401, 403]).toContain(answer.status);
      expect(answer.status).toBe(403);
    }
  });

  /* ================================================================ *
   * B. catalog.write without catalog.publish
   * ================================================================ */

  it('B1: a writer who cannot publish moves the public URL of a published product', async () => {
    const created = await call('POST', '/admin/catalog/products', {
      token: publisher.token,
      body: createRequest(P, 'RT3ONE'),
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
    expect((await call('GET', `/catalog/products/${P}`)).status).toBe(200);

    // The writer cannot publish. Proven, not assumed.
    const refused = await call('POST', `/admin/catalog/products/${P}/draft/publish`, {
      token: writer.token,
      body: {
        productVersionId: '00000000-0000-4000-8000-000000000000',
        expectedDocumentHash: 'a'.repeat(64),
      },
    });
    expect(refused.status).toBe(403);

    const opened = await call('POST', `/admin/catalog/products/${P}/draft`, { token: writer.token });
    expect(opened.status).toBe(201);
    const renamed = await call('PATCH', `/admin/catalog/products/${P}/draft`, {
      token: writer.token,
      body: { expectedDocumentHash: field<string>(opened.body, 'documentHash'), slug: `${P}-moved` },
    });
    expect(renamed.status).toBe(200);

    const oldUrl = await call('GET', `/catalog/products/${P}`);
    const newUrl = await call('GET', `/catalog/products/${P}-moved`);
    const list = await call('GET', '/catalog/products');
    const listedSlug = JSON.stringify(list.body).includes(`"${P}"`);

    // eslint-disable-next-line no-console
    console.log(
      'B1 no publish happened — old URL:',
      oldUrl.status,
      '| new URL:',
      newUrl.status,
      '| the list still advertises the old slug:',
      listedSlug,
      '| the document served on the new URL calls itself:',
      JSON.stringify(productField(newUrl.body, 'slug')),
    );
    expect(oldUrl.status).toBe(404);
    expect(newUrl.status).toBe(200);
    expect(listedSlug).toBe(true);
  });

  it('B2: a writer who cannot publish takes an option value off the shelf for every customer', async () => {
    const before = await call('GET', `/catalog/products/${P}-moved`);
    const availableBefore = availabilityOfColour(before.body);

    const off = await call('PUT', '/admin/catalog/option-groups/profile_color/values/WH/availability', {
      token: writer.token,
      body: { available: false },
    });
    expect(off.status).toBe(204);

    const after = await call('GET', `/catalog/products/${P}-moved`);
    // eslint-disable-next-line no-console
    console.log('B2 WH available before:', availableBefore, 'after:', availabilityOfColour(after.body));
    expect(availableBefore).toBe(true);
    expect(availabilityOfColour(after.body)).toBe(false);

    await call('PUT', '/admin/catalog/option-groups/profile_color/values/WH/availability', {
      token: writer.token,
      body: { available: true },
    });
  });

  /* ================================================================ *
   * C. The freeze, and "two published versions or none"
   * ================================================================ */

  it('C1: the published document cannot be edited, even with SQL', async () => {
    const [live] = await db
      .select({ id: productVersions.id })
      .from(productVersions)
      .where(and(eq(productVersions.productId, P), eq(productVersions.status, 'published')));

    const target = live?.id;
    if (target === undefined) throw new Error('no version to attack');

    await expect(
      db
        .update(productVersions)
        .set({ document: sql`jsonb_set(document, '{nameTh}', '"แก้เอกสารที่แช่แข็ง"')` })
        .where(eq(productVersions.id, target)),
    ).rejects.toThrow();

    await expect(db.delete(productVersions).where(eq(productVersions.id, target))).rejects.toThrow();
  });

  it('C2: two concurrent publishes of one draft leave exactly one published version', async () => {
    const draft = await call('GET', `/admin/catalog/products/${P}/draft`, { token: publisher.token });
    expect(draft.status).toBe(200);
    // The stored document must agree with the rows before publish will accept it.
    const nudged = await call('PATCH', `/admin/catalog/products/${P}/draft`, {
      token: publisher.token,
      body: {
        expectedDocumentHash: field<string>(draft.body, 'documentHash'),
        fields: { nameTh: 'ชื่อสำหรับทดสอบการแข่งกัน' },
      },
    });
    expect(nudged.status).toBe(200);

    const body = {
      productVersionId: field<string>(nudged.body, 'productVersionId'),
      expectedDocumentHash: field<string>(nudged.body, 'documentHash'),
    };
    const [a, b] = await Promise.all([
      call('POST', `/admin/catalog/products/${P}/draft/publish`, { token: publisher.token, body }),
      call('POST', `/admin/catalog/products/${P}/draft/publish`, { token: publisher.token, body }),
    ]);
    // eslint-disable-next-line no-console
    console.log('C2 concurrent publishes:', a.status, b.status);

    const rows = await db
      .select({ version: productVersions.version, status: productVersions.status })
      .from(productVersions)
      .where(eq(productVersions.productId, P));
    // eslint-disable-next-line no-console
    console.log('C2 versions:', JSON.stringify(rows));
    expect(rows.filter((row) => row.status === 'published')).toHaveLength(1);
  });

  it('C3: a publish racing a discard never leaves the product with zero published versions', async () => {
    const opened = await call('POST', `/admin/catalog/products/${P}/draft`, { token: publisher.token });
    expect(opened.status).toBe(201);
    const versionId = field<string>(opened.body, 'productVersionId');
    const hash = field<string>(opened.body, 'documentHash');

    const [pub, discard] = await Promise.all([
      call('POST', `/admin/catalog/products/${P}/draft/publish`, {
        token: publisher.token,
        body: { productVersionId: versionId, expectedDocumentHash: hash },
      }),
      call('DELETE', `/admin/catalog/products/${P}/draft?expectedDocumentHash=${hash}`, {
        token: publisher.token,
      }),
    ]);
    // eslint-disable-next-line no-console
    console.log('C3 publish/discard race:', pub.status, discard.status);

    const rows = await db
      .select({ version: productVersions.version, status: productVersions.status })
      .from(productVersions)
      .where(eq(productVersions.productId, P));
    // eslint-disable-next-line no-console
    console.log('C3 versions:', JSON.stringify(rows));
    expect(rows.filter((row) => row.status === 'published')).toHaveLength(1);
  });

  /* ================================================================ *
   * D. Payloads zod accepts and the database (or nobody) refuses
   * ================================================================ */

  it('D1: a price of 10^30 satang passes zod and every CHECK and becomes a 500', async () => {
    const request = createRequest(`${P}-huge`, 'RT3HGE');
    const created = await call('POST', '/admin/catalog/products', {
      token: publisher.token,
      body: { ...request, fields: { ...request.fields, pricePerSqm: encodeMinorPerSqm(10n ** 30n, 'THB') } },
    });
    /*
     * Still a 500, and correctly so — unlike D2/D2b/D2c this is not a constraint the
     * database has an opinion about. 10^30 satang overflows what the column can hold, so
     * the driver rejects it before any CHECK is consulted, and there is no Thai
     * explanation to reach for. Worth keeping visible rather than mapping to a tidier
     * status: a price that large is a caller bug, not a business rule.
     */
    expect(created.status).toBe(500);
  });

  /**
   * D2/D2b/D2c are one finding seen three ways: `pg-errors.ts` never runs.
   *
   * Red team found these three arriving as bare 500s: `withTranslatedErrors` read
   * `error.code`, and drizzle 0.45 throws `DrizzleQueryError`, which carries the driver
   * error — and its SQLSTATE — on `.cause`. Every CHECK, UNIQUE, FK and freeze-trigger
   * violation in the catalogue reached the client with a request id and nothing else,
   * and the whole Thai explanation table in pg-errors.ts was unreachable.
   *
   * `postgresErrorOf` now walks the cause chain, so these assert the mapped answers. They
   * were written the other way round, pinning the defect; flipped, they are what stops it
   * coming back the next time something wraps an error.
   */
  it('D2: a lead time the CHECK refuses comes back as the mapped 422', async () => {
    const request = createRequest(`${P}-lead`, 'RT3LED');
    const created = await call('POST', '/admin/catalog/products', {
      token: publisher.token,
      body: { ...request, fields: { ...request.fields, leadTimeDays: [30, 7] } },
    });
    expect(created.status).toBe(422); // products_lead_time_ordered
  });

  it('D2b: a slug another product already holds comes back as the mapped 409', async () => {
    const request = createRequest(`${P}-slug`, 'RT3SLG');
    const created = await call('POST', '/admin/catalog/products', {
      token: publisher.token,
      // `lvr-adj` is seeded. There is no pre-check for slug — only for the id.
      body: { ...request, slug: 'lvr-adj' },
    });
    expect(created.status).toBe(409); // products_slug_unique
  });

  it('D2c: a size range off the 25 µm lattice comes back as the mapped 422', async () => {
    const request = createRequest(`${P}-grid`, 'RT3GRD');
    const created = await call('POST', '/admin/catalog/products', {
      token: publisher.token,
      body: {
        ...request,
        options: {
          ...request.options,
          width: {
            kind: 'custom',
            sortOrder: 1,
            minUm: encodeUm(600_001n),
            maxUm: encodeUm(3_000_001n),
            stepUm: encodeUm(50_001n),
            defaultUm: encodeUm(1_200_001n),
          },
        },
      },
    });
    expect(created.status).toBe(422); // product_version_options lattice CHECK // product_version_options_grid has a Thai message nobody sees
  });

  it('D3: a length in centimetres and money sent as a total are both refused at the boundary', async () => {
    const request = createRequest(`${P}-units`, 'RT3UNT');

    const cm = await call('POST', '/admin/catalog/products', {
      token: publisher.token,
      body: {
        ...request,
        options: {
          ...request.options,
          width: {
            kind: 'custom',
            sortOrder: 1,
            minUm: { unit: 'cm', digits: '60' },
            maxUm: encodeUm(3_000_000n),
            stepUm: encodeUm(50_000n),
            defaultUm: encodeUm(1_200_000n),
          },
        },
      },
    });

    const total = await call('POST', '/admin/catalog/products', {
      token: publisher.token,
      body: {
        ...request,
        // A plain amount where a per-m² rate is meant: same digits, different unit tag.
        fields: { ...request.fields, pricePerSqm: { unit: 'THB.satang', digits: '220000' } },
      },
    });

    // eslint-disable-next-line no-console
    console.log('D3 cm-for-µm:', cm.status, '| total-for-rate:', total.status);
    expect(cm.status).toBe(400);
    expect(total.status).toBe(400);
  });

  it('D4: a magnitude error inside the right unit is invisible — 1 µm wide is published', async () => {
    const request = createRequest(`${P}-tiny`, 'RT3TNY');
    const created = await call('POST', '/admin/catalog/products', {
      token: publisher.token,
      body: {
        ...request,
        fields: { ...request.fields, minBillableSqUm: encodeSqUm(500_000n) },
        options: {
          ...request.options,
          // A dashboard that thought in millimetres: 600 mm typed as 600 µm.
          width: {
            kind: 'custom',
            sortOrder: 1,
            minUm: encodeUm(50_000n),
            maxUm: encodeUm(100_000n),
            stepUm: encodeUm(25_000n),
            defaultUm: encodeUm(50_000n),
          },
        },
      },
    });
    // eslint-disable-next-line no-console
    console.log('D4 a 5 cm-wide product with a 0.5 mm² minimum:', created.status);
    expect(created.status).toBe(201);

    const publishedTiny = await call('POST', `/admin/catalog/products/${P}-tiny/draft/publish`, {
      token: publisher.token,
      body: {
        productVersionId: field<string>(created.body, 'productVersionId'),
        expectedDocumentHash: field<string>(created.body, 'documentHash'),
      },
    });
    // eslint-disable-next-line no-console
    console.log('D4 publish:', publishedTiny.status);
    expect(publishedTiny.status).toBe(201);
  });

  it('D5: the rule code in the URL is never validated, and lands in a frozen document', async () => {
    const nasty = `A_${'x'.repeat(200)}<script>alert(1)</script>`;
    const draft = await call('GET', `/admin/catalog/products/${P}/draft`, { token: publisher.token });
    const hasDraft = draft.status === 200;
    const opened = hasDraft
      ? draft
      : await call('POST', `/admin/catalog/products/${P}/draft`, { token: publisher.token });
    const hash = field<string>(opened.body, 'documentHash');

    const put = await call(
      'PUT',
      `/admin/catalog/products/${P}/draft/rules/${encodeURIComponent(nasty)}`,
      {
        token: publisher.token,
        body: {
          expectedDocumentHash: hash,
          rule: {
            severity: 'warning',
            messageTh: 'กฎทดสอบ',
            sortOrder: 0,
            when: {
              op: 'gt',
              left: { n: 'measure', group: 'width' },
              right: { n: 'const', value: encodeUm(1n) },
            },
          },
        },
      },
    );
    // eslint-disable-next-line no-console
    console.log('D5 unvalidated rule code accepted:', put.status);
    expect(put.status).toBe(200);

    const [row] = await db
      .select({ document: productVersions.document })
      .from(productVersions)
      .where(eq(productVersions.productId, P))
      .orderBy(sql`version desc`)
      .limit(1);
    const ids = (row?.document as { rules?: { id: string }[] } | undefined)?.rules?.map((r) => r.id) ?? [];
    // eslint-disable-next-line no-console
    console.log('D5 rule ids now in the draft document:', JSON.stringify(ids));
    expect(ids.some((id) => id.includes('<script>'))).toBe(true);
  });

  it('D6: heroImage takes any string, including a javascript: URL, and it is published', async () => {
    const request = createRequest(`${P}-hero`, 'RT3HRO');
    const created = await call('POST', '/admin/catalog/products', {
      token: publisher.token,
      body: {
        ...request,
        fields: { ...request.fields, heroImage: 'javascript:alert(document.domain)' },
      },
    });
    // eslint-disable-next-line no-console
    console.log('D6 heroImage javascript: URL:', created.status);
    expect(created.status).toBe(201);

    const publishedHero = await call('POST', `/admin/catalog/products/${P}-hero/draft/publish`, {
      token: publisher.token,
      body: {
        productVersionId: field<string>(created.body, 'productVersionId'),
        expectedDocumentHash: field<string>(created.body, 'documentHash'),
      },
    });
    expect(publishedHero.status).toBe(201);

    const served = await call('GET', `/catalog/products/${P}-hero`);
    // eslint-disable-next-line no-console
    console.log('D6 the public catalogue serves:', JSON.stringify(productField(served.body, 'heroImage')));
    expect(productField(served.body, 'heroImage')).toBe('javascript:alert(document.domain)');
  });

  /* ================================================================ *
   * E. One editor's supported write breaks another's draft
   * ================================================================ */

  it('E1: repricing an option value makes an untouched draft unpublishable', async () => {
    const opened = await call('POST', `/admin/catalog/products/${P}-hero/draft`, {
      token: publisher.token,
    });
    expect(opened.status).toBe(201);
    const versionId = field<string>(opened.body, 'productVersionId');
    const hash = field<string>(opened.body, 'documentHash');

    // An ordinary, permitted write by somebody else, on a different endpoint. The seeded
    // value carries no surcharge, so this is a real change to what the draft compiles to.
    const repriced = await call('PATCH', '/admin/catalog/option-groups/profile_color/values/WH', {
      token: writer.token,
      body: { delta: { type: 'flat', amount: { unit: 'THB.satang', digits: '150000' } } },
    });
    expect(repriced.status).toBe(204);

    // The draft was not touched. Its hash is still the one the dashboard is holding.
    const preview = await call('GET', `/admin/catalog/products/${P}-hero/draft`, {
      token: publisher.token,
    });
    const previewHash = field<string>(preview.body, 'documentHash');

    const publishAttempt = await call('POST', `/admin/catalog/products/${P}-hero/draft/publish`, {
      token: publisher.token,
      body: { productVersionId: versionId, expectedDocumentHash: hash },
    });
    // eslint-disable-next-line no-console
    console.log(
      'E1 preview hash unchanged:',
      previewHash === hash,
      '| publish:',
      publishAttempt.status,
      JSON.stringify(publishAttempt.body).slice(0, 240),
    );
    expect(publishAttempt.status).toBe(409);

    // Put the price back so the seeded catalogue is what the other suites expect.
    await call('PATCH', '/admin/catalog/option-groups/profile_color/values/WH', {
      token: writer.token,
      body: { delta: { type: 'none' } },
    });
  });

  it('E2: PATCH on an option group that does not exist, and an empty patch', async () => {
    const ghost = await call('PATCH', '/admin/catalog/option-groups/no_such_group_at_all', {
      token: writer.token,
      body: { labelTh: 'ไม่มีอยู่จริง' },
    });
    const empty = await call('PATCH', '/admin/catalog/option-groups/profile_color', {
      token: writer.token,
      body: {},
    });
    // eslint-disable-next-line no-console
    console.log('E2 ghost group:', ghost.status, JSON.stringify(ghost.body).slice(0, 160));
    // eslint-disable-next-line no-console
    console.log('E2 empty patch:', empty.status, JSON.stringify(empty.body).slice(0, 160));
    expect([204, 404, 400, 422, 500]).toContain(ghost.status);
    expect([204, 400, 422, 500]).toContain(empty.status);
  });

  it('E3: any writer can throw away a colleague\'s draft, and nothing records who did', async () => {
    // The publisher opens a draft on a product they published...
    const opened = await call('POST', `/admin/catalog/products/${P}-tiny/draft`, {
      token: publisher.token,
    });
    expect(opened.status).toBe(201);
    const hash = field<string>(opened.body, 'documentHash');

    // ...and an unrelated actor with catalog.write throws it away. The hash is not a secret:
    // it is in every GET of the draft, so it gates a blind overwrite and not an actor.
    const discarded = await call(
      `DELETE`,
      `/admin/catalog/products/${P}-tiny/draft?expectedDocumentHash=${hash}`,
      { token: writer.token },
    );
    // eslint-disable-next-line no-console
    console.log('E3 a different actor discarded the draft:', discarded.status);
    expect(discarded.status).toBe(204);

    // And there is nowhere the actor could have been recorded.
    const columns = await db.execute(
      sql`select column_name from information_schema.columns where table_name = 'product_versions'`,
    );
    const names = (columns as unknown as { rows?: { column_name: string }[] }).rows ??
      (columns as unknown as { column_name: string }[]);
    const list = Array.isArray(names) ? names.map((r) => r.column_name) : [];
    // eslint-disable-next-line no-console
    console.log('E3 product_versions columns:', JSON.stringify(list));
    expect(list.some((name) => /by$|actor|user/.test(name))).toBe(false);
  });
});

/* ------------------------------------------------------------------ */

function signToken(key: Parameters<typeof createHmac>[1], claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' }), 'utf8').toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const body = `${header}.${payload}`;
  return `${body}.${createHmac('sha256', key).update(body, 'utf8').digest().toString('base64url')}`;
}

function unsignedToken(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' }), 'utf8').toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `${header}.${payload}.`;
}

async function makeActor(
  db: Database,
  app: BootedApp,
  groupCode: string,
  codes: readonly ('catalog.read' | 'catalog.write' | 'catalog.publish')[],
): Promise<Actor> {
  const [user] = await db
    .insert(users)
    .values({ displayName: `red team 3 (${groupCode})` })
    .returning({ id: users.id });
  const [group] = await db
    .insert(groups)
    .values({ code: groupCode, nameTh: 'กลุ่มทดสอบเรดทีม 3' })
    .onConflictDoUpdate({ target: groups.code, set: { nameTh: 'กลุ่มทดสอบเรดทีม 3' } })
    .returning({ id: groups.id });
  if (!user || !group) throw new Error('fixture insert returned nothing');

  await db.insert(userGroups).values({ userId: user.id, groupId: group.id }).onConflictDoNothing();
  if (codes.length > 0) {
    await db
      .insert(groupPermissions)
      .values(codes.map((code) => ({ groupId: group.id, permissionCode: code })))
      .onConflictDoNothing();
  }

  // A real session row, so revocation has something to revoke.
  const session = await app.app.get(SessionService).start({ userId: user.id });
  return { userId: user.id, sessionId: session.sessionId, token: session.accessToken };
}

async function cleanUp(db: Database): Promise<void> {
  const ids = [
    P,
    `${P}-moved`,
    `${P}-huge`,
    `${P}-lead`,
    `${P}-units`,
    `${P}-tiny`,
    `${P}-hero`,
    `${P}-revoked`,
    `${P}-forged`,
    `${P}-guest`,
    `${P}-slug`,
    `${P}-grid`,
  ];
  /*
   * The freeze triggers refuse to delete a published or archived version, which is correct
   * and makes a red-team probe permanent. Disabling them for the length of the cleanup is
   * the only way to leave the database as this file found it.
   */
  await db.execute(sql`alter table product_versions disable trigger product_versions_block_delete`);
  await db.execute(sql`alter table product_versions disable trigger product_versions_freeze`);
  try {
    await db.delete(productVersions).where(inArray(productVersions.productId, ids));
    await db.delete(products).where(inArray(products.id, ids));
  } finally {
    await db.execute(sql`alter table product_versions enable trigger product_versions_block_delete`);
    await db.execute(sql`alter table product_versions enable trigger product_versions_freeze`);
  }
  // Anything a probe left on the shared option catalogue goes back to the seeded state.
  await db.execute(
    sql`update option_values set delta_type = 'none', delta_minor = null, delta_bp = null, available = true
        where option_group_id = (select id from option_groups where code = 'profile_color')`,
  );
  for (const code of [WRITER, PUBLISHER, NOBODY]) {
    const [group] = await db.select({ id: groups.id }).from(groups).where(eq(groups.code, code));
    if (!group) continue;
    const members = await db
      .select({ userId: userGroups.userId })
      .from(userGroups)
      .where(eq(userGroups.groupId, group.id));
    await db.delete(groupPermissions).where(eq(groupPermissions.groupId, group.id));
    await db.delete(userGroups).where(eq(userGroups.groupId, group.id));
    await db.delete(groups).where(eq(groups.id, group.id));
    for (const member of members) {
      await db.delete(sessions).where(eq(sessions.userId, member.userId)).catch(() => undefined);
      await db.delete(users).where(eq(users.id, member.userId)).catch(() => undefined);
    }
  }
}

function createRequest(id: string, skuPrefix: string): {
  id: string;
  slug: string;
  skuPrefix: string;
  fields: Record<string, unknown>;
  options: Record<string, unknown>;
} {
  return {
    id,
    slug: id,
    skuPrefix,
    fields: {
      nameTh: 'สินค้าทดสอบเรดทีมสาม',
      categoryId: 'louvers',
      summaryTh: 'สินค้าสำหรับทดสอบเส้นทางเขียนของแดชบอร์ด',
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
function availabilityOfColour(body: unknown): boolean | undefined {
  const product = asRecord(field(body, 'product'), 'a product');
  const groups = product['groups'];
  if (!Array.isArray(groups)) return undefined;
  for (const group of groups) {
    const record = group as Record<string, unknown>;
    if (record['code'] !== 'profile_color') continue;
    const values = record['values'];
    if (!Array.isArray(values)) return undefined;
    for (const value of values) {
      const entry = value as Record<string, unknown>;
      if (entry['code'] === 'WH') return entry['available'] as boolean;
    }
  }
  return undefined;
}
