import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { reseedCatalogue } from '../support/reseed';
import { createDatabase, createPool, type Database, type Pool } from '@wewin/db/client';
import { and, eq, inArray, sql } from '@wewin/db/sql';
import {
  groupPermissions,
  groups,
  optionGroups,
  optionValues,
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

/**
 * The write side, against a real Postgres, over real HTTP.
 *
 * Nothing here is stubbed and nothing is asserted through a service call, because every
 * property this round is about lives *between* the layers:
 *
 *   - the freeze triggers are in the database, not in TypeScript, so a test that never
 *     issues a statement never meets them;
 *   - the partial unique index that makes two published versions impossible is evaluated
 *     per statement by Postgres, and the ordering bug it punishes is invisible to a mock;
 *   - the guard is bound globally and reads permissions out of a table, so "a reader
 *     cannot publish" is only true if there is a table.
 *
 * The two assertions worth reading first are `reproduces the seeded document byte for
 * byte` — which is the whole two-layer design of plan 5 held to account, because the
 * document a dashboard compiles out of rows has to equal the one the seed compiled out of
 * the TS table or the first republish of an untouched product silently reprices it — and
 * `never leaves the product with two published versions or none`.
 *
 * Skipped, not failed, without a database.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

/** Prefixed so nothing here can collide with a real row, and so cleanup can find them. */
const PROBE_PRODUCT = 'probe-admin-product';
const EDITOR_GROUP = 'catalog_admin_probe_editor';
const READER_GROUP = 'catalog_admin_probe_reader';
/** An option group this file creates and deletes. Never offered by any version. */
const PROBE_GROUP = 'probe_admin_group';
/**
 * A colour this file adds to `profile_color` and removes again.
 *
 * Deliberately a *new* value rather than one of the seeded ones. `option_values` rows are
 * shared, vitest runs test files in parallel, and `tests/catalog-fidelity.pg.test.ts`
 * compares all 81 served products to the fixture table — so flipping a colour the seeded
 * catalogue offers would turn that file red on a race that has nothing to do with either.
 */
const PROBE_VALUE = 'PRB';

/** A seeded product, republished from its own rows. Chosen for having both group kinds. */
const SEEDED = 'lvr-adj';

interface Actor {
  readonly userId: string;
  readonly token: string;
}

interface Json {
  readonly status: number;
  readonly body: unknown;
}

describeWithPg('the catalogue write surface against Postgres', () => {
  let pool: Pool;
  let db: Database;
  let app: BootedApp;
  let editor: Actor;
  let reader: Actor;

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
    /*
     * Reseed rather than assume. This suite republishes a seeded product on purpose, and
     * so do others; whichever ran last decides what "seeded" means by the time this one
     * starts. Making each Postgres suite establish its own starting point is what stops
     * the result depending on file order — a green run that came from the order the
     * files happened to load is not evidence about the code.
     *
     * **Before the pool is opened**, because since phase 5a re-seeding under a contract means
     * recreating the database (`tests/support/reseed.ts` explains why both rules are right),
     * and a connection held across that would be terminated under it.
     */
    await reseedCatalogue(url ?? '', 'api-admin-test');

    pool = createPool(url ?? '');
    db = createDatabase(pool);

    await cleanUp(db);

    // Booting first: `PermissionSyncService` upserts the permission rows at boot, and the
    // grants below reference them. Doing it the other way round would fail the FK on a
    // fresh database, which is exactly the machine CI runs on.
    app = await bootApp(parseEnv({ NODE_ENV: 'test', DATABASE_URL: url ?? '' }));

    editor = await makeActor(db, app, EDITOR_GROUP, ['catalog.read', 'catalog.write', 'catalog.publish']);
    reader = await makeActor(db, app, READER_GROUP, ['catalog.read']);
  });

  afterAll(async () => {
    await app?.close();
    await cleanUp(db);
    await pool.end();
  });

  /* ---------------------------------------------------------------- *
   * Authorisation
   * ---------------------------------------------------------------- */

  describe('authorisation', () => {
    it('refuses an anonymous caller before it refuses anything else', async () => {
      const listed = await call('GET', '/admin/catalog/products');
      expect(listed.status).toBe(401);

      // Including on a path that does not exist as a product — the guard runs before the
      // handler, so a 404 here would mean the endpoint had already told an anonymous
      // caller which products exist.
      const missing = await call('GET', '/admin/catalog/products/no-such-product');
      expect(missing.status).toBe(401);
    });

    it('lets a reader read and refuses every write, naming what is missing', async () => {
      const listed = await call('GET', '/admin/catalog/products', { token: reader.token });
      expect(listed.status).toBe(200);

      const created = await call('POST', '/admin/catalog/products', {
        token: reader.token,
        body: createRequest(),
      });
      expect(created.status).toBe(403);
      expect(messageOf(created)).toContain('catalog.write');
    });

    it('separates publishing from editing', async () => {
      /*
       * The reader holds `catalog.read` and the editor holds all three, so this asserts the
       * split exists rather than that a particular person has it: a token with write but
       * not publish is refused by the publish route alone. Hiding the button is not
       * authorisation (plan section 6); this is.
       */
      const writerOnly = await makeActor(db, app, `${EDITOR_GROUP}_w`, ['catalog.read', 'catalog.write']);

      const opened = await call('POST', `/admin/catalog/products/${SEEDED}/draft`, {
        token: writerOnly.token,
      });
      expect([200, 201, 409]).toContain(opened.status);

      const published = await call('POST', `/admin/catalog/products/${SEEDED}/draft/publish`, {
        token: writerOnly.token,
        body: { productVersionId: '00000000-0000-4000-8000-000000000000', expectedDocumentHash: 'a'.repeat(64) },
      });
      expect(published.status).toBe(403);
      expect(messageOf(published)).toContain('catalog.publish');

      // Leave no draft behind for the publish block below to trip over.
      const draft = await asEditor('GET', `/admin/catalog/products/${SEEDED}/draft`);
      if (draft.status === 200) {
        const hash = field(draft.body, 'documentHash');
        await asEditor('DELETE', `/admin/catalog/products/${SEEDED}/draft?expectedDocumentHash=${hash}`);
      }
    });
  });

  /* ---------------------------------------------------------------- *
   * A new product
   * ---------------------------------------------------------------- */

  describe('a new product lives entirely in its draft', () => {
    let hash: string;

    it('creates the product and its first draft in one call', async () => {
      const created = await asEditor('POST', '/admin/catalog/products', createRequest());

      expect(created.status).toBe(201);
      expect(field(created.body, 'version')).toBe(1);
      hash = field(created.body, 'documentHash');
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('does not serve it to the public catalogue', async () => {
      /*
       * The point of the whole arrangement, in one assertion. The rows exist, the document
       * exists and hashes, the dashboard can preview it — and the storefront, which reads
       * only published versions, has never heard of it.
       */
      const public_ = await call('GET', `/catalog/products/${PROBE_PRODUCT}`);
      expect(public_.status).toBe(404);
    });

    it('reports it as drafted and unpublished', async () => {
      const detail = await asEditor('GET', `/admin/catalog/products/${PROBE_PRODUCT}`);

      expect(detail.status).toBe(200);
      expect(field(detail.body, 'published')).toBeNull();
      expect(field(detail.body, 'draft')).not.toBeNull();
      // Nothing has been published, so there is nothing for the product row to have drifted
      // from — the list is empty rather than "every field".
      expect(field(detail.body, 'unpublishedFields')).toStrictEqual([]);
    });

    it('refuses an edit that would leave the draft unpublishable, and does not half-apply it', async () => {
      const removed = await asEditor(
        'DELETE',
        `/admin/catalog/products/${PROBE_PRODUCT}/draft/options/width?expectedDocumentHash=${hash}`,
      );

      // Core prices from `width` and `height` directly; a product without them prices as
      // zero, which is why `productSchema` refuses it and why this is 422 and not 200.
      expect(removed.status).toBe(422);

      const draft = await asEditor('GET', `/admin/catalog/products/${PROBE_PRODUCT}/draft`);
      expect(field(draft.body, 'documentHash')).toBe(hash);
      const groups_ = groupCodesOf(draft.body);
      // The delete ran inside the transaction the 422 rolled back. If it had not, the draft
      // would now be missing `width` *and* still be reported as saved.
      expect(groups_).toContain('width');
    });

    it('answers 409 to a mutation carrying a stale hash', async () => {
      const stale = await asEditor('PATCH', `/admin/catalog/products/${PROBE_PRODUCT}/draft`, {
        expectedDocumentHash: 'b'.repeat(64),
        fields: { nameTh: 'ชื่อใหม่' },
      });

      expect(stale.status).toBe(409);
      expect(detailsOf(stale)['current']).toBe(hash);
    });

    it('applies an edit and moves the hash with it', async () => {
      const patched = await asEditor('PATCH', `/admin/catalog/products/${PROBE_PRODUCT}/draft`, {
        expectedDocumentHash: hash,
        fields: { nameTh: 'บานเกล็ดทดสอบ (แก้ไขแล้ว)' },
      });

      expect(patched.status).toBe(200);
      const next = field<string>(patched.body, 'documentHash');
      expect(next).not.toBe(hash);
      hash = next;

      // Round-tripped through the compiled document, not echoed from the request.
      expect(productField(patched.body, 'nameTh')).toBe('บานเกล็ดทดสอบ (แก้ไขแล้ว)');
    });

    it('writes every product-level field it says it writes', async () => {
      /*
       * One assertion per column, in one request, because the update is built by copying
       * keys into an object drizzle maps at runtime — which is the one shape in this module
       * where a mis-spelled field is silently dropped instead of failing to compile. Each
       * value below is read back out of the *compiled document*, so a field that did not
       * reach Postgres shows up as an unchanged preview rather than as a green test.
       */
      const patched = await asEditor('PATCH', `/admin/catalog/products/${PROBE_PRODUCT}/draft`, {
        expectedDocumentHash: hash,
        slug: `${PROBE_PRODUCT}-2`,
        skuPrefix: 'PROBE2',
        fields: {
          categoryId: 'screens',
          summaryTh: 'คำอธิบายใหม่',
          heroImage: '/images/probe-2.svg',
          leadTimeDays: [10, 21],
          pricePerSqm: encodeMinorPerSqm(310_000n, 'THB'),
          minBillableSqUm: encodeSqUm(600_000_000_000n),
          elevation: { panels: 3, operation: 'slide', infill: 'glass', movingPanels: [1] },
        },
      });

      expect(patched.status).toBe(200);
      hash = field(patched.body, 'documentHash');

      expect(productField(patched.body, 'slug')).toBe(`${PROBE_PRODUCT}-2`);
      expect(productField(patched.body, 'skuPrefix')).toBe('PROBE2');
      expect(productField(patched.body, 'categoryId')).toBe('screens');
      expect(productField(patched.body, 'summaryTh')).toBe('คำอธิบายใหม่');
      expect(productField(patched.body, 'heroImage')).toBe('/images/probe-2.svg');
      expect(productField(patched.body, 'leadTimeDays')).toStrictEqual([10, 21]);
      // Satang per m², with its unit still attached — the wire never carries baht.
      expect(productField(patched.body, 'pricePerSqm')).toStrictEqual({
        unit: 'THB.satang/m2',
        digits: '310000',
      });
      expect(productField(patched.body, 'minBillableSqUm')).toStrictEqual({
        unit: 'um2',
        digits: '600000000000',
      });
      expect(productField(patched.body, 'elevation')).toStrictEqual({
        panels: 3,
        operation: 'slide',
        infill: 'glass',
        movingPanels: [1],
      });
    });

    it('⭐ 0052 — writes a gallery and a video link, in order, and reads them back compiled', async () => {
      /*
       * `images` is rows in `product_images`, not a column, so it is the one field on this
       * request that cannot be checked by reading the `products` row back. Every assertion
       * below reads the **compiled document**, which is the only proof the rows were written
       * AND that `loadRows` put them into the compile in the right order.
       */
      const patched = await asEditor('PATCH', `/admin/catalog/products/${PROBE_PRODUCT}/draft`, {
        expectedDocumentHash: hash,
        fields: {
          images: ['/media/11111111-1111-4111-8111-111111111111', '/products/probe-b.svg'],
          videoUrl: 'https://www.youtube.com/watch?v=probe',
        },
      });

      expect(patched.status, JSON.stringify(patched.body)).toBe(200);
      hash = field(patched.body, 'documentHash');

      expect(productField(patched.body, 'images')).toStrictEqual([
        '/media/11111111-1111-4111-8111-111111111111',
        '/products/probe-b.svg',
      ]);
      expect(productField(patched.body, 'videoUrl')).toBe('https://www.youtube.com/watch?v=probe');
    });

    it('⭐ reordering the gallery is a change, and the hash says so', async () => {
      /*
       * Order is content: the first picture is the one a customer sees first. A reorder that
       * left the hash alone would be a change to the product that nothing downstream noticed.
       */
      const before = hash;
      const reordered = await asEditor('PATCH', `/admin/catalog/products/${PROBE_PRODUCT}/draft`, {
        expectedDocumentHash: hash,
        fields: {
          images: ['/products/probe-b.svg', '/media/11111111-1111-4111-8111-111111111111'],
        },
      });

      expect(reordered.status).toBe(200);
      hash = field(reordered.body, 'documentHash');
      expect(hash).not.toBe(before);
      expect(productField(reordered.body, 'images')).toStrictEqual([
        '/products/probe-b.svg',
        '/media/11111111-1111-4111-8111-111111111111',
      ]);
    });

    it('⚠️ an empty list removes every picture, and null removes the video', async () => {
      /*
       * The two ways of saying "there is none", and both have to be distinguishable from
       * silence — which is why `images` is replace-the-list and `videoUrl` is nullable rather
       * than merely optional.
       */
      const cleared = await asEditor('PATCH', `/admin/catalog/products/${PROBE_PRODUCT}/draft`, {
        expectedDocumentHash: hash,
        fields: { images: [], videoUrl: null },
      });

      expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
      hash = field(cleared.body, 'documentHash');

      /* Absent, not empty — the document is byte-identical to one written before 0052. */
      expect(productField(cleared.body, 'images')).toBeUndefined();
      expect(productField(cleared.body, 'videoUrl')).toBeUndefined();
    });

    it('⚠️ refuses a video link that is not a URL and a path that does not start with /', async () => {
      const badVideo = await asEditor('PATCH', `/admin/catalog/products/${PROBE_PRODUCT}/draft`, {
        expectedDocumentHash: hash,
        fields: { videoUrl: 'youtube.com/watch?v=x' },
      });
      expect(badVideo.status).toBe(400);

      const badPath = await asEditor('PATCH', `/admin/catalog/products/${PROBE_PRODUCT}/draft`, {
        expectedDocumentHash: hash,
        fields: { images: ['products/a.svg'] },
      });
      expect(badPath.status).toBe(400);
    });

    it('refuses to throw away the only draft of a product that has never published', async () => {
      const discarded = await asEditor(
        'DELETE',
        `/admin/catalog/products/${PROBE_PRODUCT}/draft?expectedDocumentHash=${hash}`,
      );

      /*
       * The "or none" half of the invariant. Allowing this would leave a `products` row
       * with no version at all, and no endpoint could repair it — `POST .../draft` copies
       * the published version, and there would not be one.
       */
      expect(discarded.status).toBe(409);
    });
  });

  /* ---------------------------------------------------------------- *
   * Publishing
   * ---------------------------------------------------------------- */

  describe('publishing a seeded product from its own normalised rows', () => {
    let versionId: string;
    let draftVersion: number;
    let draftHash: string;
    let publishedBefore: { id: string; hash: string };

    it('reproduces the seeded document byte for byte', async () => {
      const before = await asEditor('GET', `/admin/catalog/products/${SEEDED}`);
      expect(before.status).toBe(200);
      const published = field<Record<string, unknown>>(before.body, 'published');
      publishedBefore = {
        id: String(published['productVersionId']),
        hash: String(published['documentHash']),
      };

      const opened = await asEditor('POST', `/admin/catalog/products/${SEEDED}/draft`);
      expect(opened.status).toBe(201);
      versionId = field(opened.body, 'productVersionId');
      draftVersion = field(opened.body, 'version');
      draftHash = field(opened.body, 'documentHash');

      /*
       * The load-bearing assertion of this file.
       *
       * The published document was compiled by `@wewin/db`'s `toDocument` from the TS
       * catalogue table. This draft's document was compiled by `apps/api`'s draft compiler
       * out of the normalised rows the seed wrote. Two functions, two representations, one
       * digest — which is the only way "the dashboard becomes the source of truth" can
       * happen without a silent repricing on the first republish of an untouched product.
       *
       * If this ever fails, do not publish: the failure is a diff between the two
       * compilers, and freezing the second one's answer makes it permanent.
       */
      expect(draftHash).toBe(publishedBefore.hash);
    });

    it('archives the old version and publishes the new one', async () => {
      const published = await asEditor('POST', `/admin/catalog/products/${SEEDED}/draft/publish`, {
        productVersionId: versionId,
        expectedDocumentHash: draftHash,
      });

      expect(published.status).toBe(201);
      expect(field(published.body, 'productVersionId')).toBe(versionId);
      expect(field(published.body, 'archivedVersionId')).toBe(publishedBefore.id);
      expect(field(published.body, 'documentHash')).toBe(publishedBefore.hash);

      /*
       * Every field describes the *same* version — the one this call froze.
       *
       * The hash and the version number are read back from the row rather than echoed, so
       * that an edit that landed on the draft between the freshness check and the publish
       * is visible in the answer. Reading them back by status instead of by id would make
       * that read return a different row once a later publish superseded this one, and the
       * response would carry one version's id beside another version's number.
       */
      expect(field(published.body, 'version')).toBe(draftVersion);
    });

    it('never leaves the product with two published versions or none', async () => {
      const rows = await db
        .select({ status: productVersions.status, id: productVersions.id })
        .from(productVersions)
        .where(eq(productVersions.productId, SEEDED));

      // The partial unique index makes two impossible to commit; `publishProductVersion`
      // archives before it publishes so that it is also impossible to *attempt*. This is
      // the state afterwards, read straight out of the table.
      expect(rows.filter((row) => row.status === 'published')).toHaveLength(1);
      expect(rows.filter((row) => row.status === 'draft')).toHaveLength(0);
      expect(rows.filter((row) => row.status === 'archived').map((row) => row.id)).toContain(
        publishedBefore.id,
      );
    });

    it('serves the same document to the storefront as before the republish', async () => {
      const public_ = await call('GET', `/catalog/products/${SEEDED}`);

      expect(public_.status).toBe(200);
      expect(field(public_.body, 'productVersionId')).toBe(versionId);
      expect(field(public_.body, 'documentHash')).toBe(publishedBefore.hash);
    });

    it('refuses to publish the same version twice', async () => {
      const again = await asEditor('POST', `/admin/catalog/products/${SEEDED}/draft/publish`, {
        productVersionId: versionId,
        expectedDocumentHash: draftHash,
      });

      // There is no draft any more, so this is 409 rather than 404: the product exists and
      // opening a new draft is the thing the caller should do next, which is what the
      // message says.
      expect(again.status).toBe(409);
    });

    it('refuses a second draft while one is open', async () => {
      const first = await asEditor('POST', `/admin/catalog/products/${SEEDED}/draft`);
      expect(first.status).toBe(201);

      const second = await asEditor('POST', `/admin/catalog/products/${SEEDED}/draft`);
      expect(second.status).toBe(409);

      // And this one can be discarded, because there *is* a published version to fall back
      // to — the mirror of the refusal on the probe product above.
      const hash = field<string>(first.body, 'documentHash');
      const discarded = await asEditor(
        'DELETE',
        `/admin/catalog/products/${SEEDED}/draft?expectedDocumentHash=${hash}`,
      );
      expect(discarded.status).toBe(204);
    });
  });

  /* ---------------------------------------------------------------- *
   * Stock — the one write that skips the publish
   * ---------------------------------------------------------------- */

  describe('stock moves without a publish', () => {
    /*
     * On a colour no published version offers — see the note on `PROBE_VALUE`.
     *
     * The claim under test is unchanged by that and is arguably sharper: flipping stock
     * must not move the document's digest, and must move what a reader sees. That the
     * *storefront* in particular reads it live is already pinned by the fidelity suite's
     * own mutation block, which is the file that owns that row.
     */
    it('is not part of the document, and is read live', async () => {
      const added = await asEditor('POST', '/admin/catalog/option-groups/profile_color/values', {
        code: PROBE_VALUE,
        labelTh: 'สีทดสอบ',
        // `profile_color` renders as swatches, and core's `skuGroupSchema` refuses a swatch
        // value with no colour to draw. Without this the `PUT` below is a 422 rather than a
        // 200 — which is the draft compiler running core's own rules on every edit, and is
        // asserted directly in `tests/admin/draft-document.test.ts`.
        swatchHex: '#123456',
        delta: { type: 'none' },
        sortOrder: 99,
      });
      expect(added.status).toBe(204);

      const opened = await asEditor('POST', `/admin/catalog/products/${SEEDED}/draft`);
      expect(opened.status).toBe(201);
      const publishedHash = field<Record<string, unknown>>(
        (await asEditor('GET', `/admin/catalog/products/${SEEDED}`)).body,
        'published',
      )['documentHash'];

      const offered = await asEditor(
        'PUT',
        `/admin/catalog/products/${SEEDED}/draft/options/profile_color`,
        {
          expectedDocumentHash: field<string>(opened.body, 'documentHash'),
          option: {
            kind: 'sku',
            sortOrder: 0,
            valueCodes: ['DW', 'LW', 'SG', PROBE_VALUE],
            defaultValueCode: 'SG',
          },
        },
      );
      expect(offered.status).toBe(200);
      const draftHash = field<string>(offered.body, 'documentHash');
      expect(availabilityIn(offered.body, 'profile_color', PROBE_VALUE)).toBe(true);

      try {
        const soldOut = await asEditor(
          'PUT',
          `/admin/catalog/option-groups/profile_color/values/${PROBE_VALUE}/availability`,
          { available: false },
        );
        expect(soldOut.status).toBe(204);

        const reread = await asEditor('GET', `/admin/catalog/products/${SEEDED}/draft`);

        /*
         * Plan 5 point 2, both halves in two lines. The digest does not move, which is what
         * makes stock changeable at all — a value inside the frozen document could not be
         * touched without republishing the 60 products that offer it. And the reader does
         * see it, which is what makes it worth having outside the document.
         */
        expect(field(reread.body, 'documentHash')).toBe(draftHash);
        expect(availabilityIn(reread.body, 'profile_color', PROBE_VALUE)).toBe(false);

        // And nothing about what is published moved either.
        const detail = await asEditor('GET', `/admin/catalog/products/${SEEDED}`);
        expect(field<Record<string, unknown>>(detail.body, 'published')['documentHash']).toBe(publishedHash);
      } finally {
        const draft = await asEditor('GET', `/admin/catalog/products/${SEEDED}/draft`);
        if (draft.status === 200) {
          const hash = field<string>(draft.body, 'documentHash');
          await asEditor('DELETE', `/admin/catalog/products/${SEEDED}/draft?expectedDocumentHash=${hash}`);
        }
      }
    });
  });

  /* ---------------------------------------------------------------- *
   * The option catalogue
   * ---------------------------------------------------------------- */

  describe('the shared option catalogue', () => {
    it('lists every group with its values and surcharges', async () => {
      const listed = await asEditor('GET', '/admin/catalog/option-groups');

      expect(listed.status).toBe(200);
      const codes = (field<{ code: string }[]>(listed.body, 'groups')).map((group) => group.code);
      expect(codes).toContain('profile_color');
      expect(codes).toContain('width');
    });

    it('creates a group and edits every field it says it edits', async () => {
      const created = await asEditor('POST', '/admin/catalog/option-groups', {
        code: PROBE_GROUP,
        kind: 'sku',
        labelTh: 'กลุ่มทดสอบ',
        input: 'chip',
        includeInSkuCode: false,
      });
      expect(created.status).toBe(204);

      const patched = await asEditor(`PATCH`, `/admin/catalog/option-groups/${PROBE_GROUP}`, {
        labelTh: 'กลุ่มทดสอบ (แก้ไข)',
        helperTh: 'คำอธิบายช่วยเหลือ',
      });
      expect(patched.status).toBe(204);

      const group = groupIn((await asEditor('GET', '/admin/catalog/option-groups')).body, PROBE_GROUP);
      expect(group['labelTh']).toBe('กลุ่มทดสอบ (แก้ไข)');
      expect(group['helperTh']).toBe('คำอธิบายช่วยเหลือ');
    });

    it('edits every field of a value it says it edits', async () => {
      /*
       * The same reason the product patch above lists every field: this update is built by
       * copying keys into an object drizzle maps at runtime, so a mis-spelled column is
       * dropped rather than rejected. `delta` is the one that matters — all three of its
       * columns are written together, because writing only the one the new type uses would
       * leave the old one populated and `option_values_delta_shape` counts both.
       */
      const patched = await asEditor('PATCH', `/admin/catalog/option-groups/profile_color/values/${PROBE_VALUE}`, {
        labelTh: 'สีทดสอบ (แก้ไข)',
        swatchHex: '#ABCDEF',
        delta: { type: 'percent', amount: { unit: 'bp', digits: '800' } },
        sortOrder: 98,
      });
      expect(patched.status).toBe(204);

      const value = valueIn(
        (await asEditor('GET', '/admin/catalog/option-groups')).body,
        'profile_color',
        PROBE_VALUE,
      );

      expect(value['labelTh']).toBe('สีทดสอบ (แก้ไข)');
      expect(value['swatchHex']).toBe('#ABCDEF');
      expect(value['sortOrder']).toBe(98);
      // Basis points on the way out, as they went in: a percent is the one figure in the
      // system that is the same number in every currency, so it never becomes money.
      expect(value['delta']).toStrictEqual({ type: 'percent', amount: { unit: 'bp', digits: '800' } });
    });

    it('reports a value that is not in the group it was addressed under', async () => {
      const missing = await asEditor('PATCH', '/admin/catalog/option-groups/profile_color/values/NOPE', {
        labelTh: 'ไม่มีอยู่',
      });
      expect(missing.status).toBe(404);
    });

    it('refuses a value on a measurement group', async () => {
      // `option_values_sku_groups_only` would refuse the row; this answers with the group
      // code instead of the constraint name.
      const created = await asEditor('POST', '/admin/catalog/option-groups/width/values', {
        code: 'X1',
        labelTh: 'ทดสอบ',
        delta: { type: 'none' },
        sortOrder: 0,
      });

      expect(created.status).toBe(422);
    });

    it('refuses a surcharge that is not a whole baht, before it reaches the column', async () => {
      const created = await asEditor('POST', '/admin/catalog/option-groups/profile_color/values', {
        code: 'PROBE1',
        labelTh: 'ทดสอบเศษสตางค์',
        delta: { type: 'flat', amount: { unit: 'THB.satang', digits: '150' } },
        sortOrder: 99,
      });

      // 400 and not 422: this one never gets as far as being a catalogue question, because
      // `@wewin/contract` refuses the shape.
      expect(created.status).toBe(400);
    });

    it('refuses a length sent in centimetres where micrometres are meant', async () => {
      const opened = await asEditor('POST', `/admin/catalog/products/${PROBE_PRODUCT}/draft`);
      // The probe product's draft is still open from the block above, so this is a 409 and
      // the draft to edit is the one already there.
      expect([201, 409]).toContain(opened.status);

      const draft = await asEditor('GET', `/admin/catalog/products/${PROBE_PRODUCT}/draft`);
      const hash = field<string>(draft.body, 'documentHash');

      const put = await asEditor(
        'PUT',
        `/admin/catalog/products/${PROBE_PRODUCT}/draft/options/width`,
        {
          expectedDocumentHash: hash,
          option: {
            kind: 'custom',
            sortOrder: 0,
            minUm: { unit: 'cm', digits: '60' },
            maxUm: { unit: 'cm', digits: '300' },
            stepUm: { unit: 'cm', digits: '5' },
            defaultUm: { unit: 'cm', digits: '120' },
          },
        },
      );

      /*
       * 60 cm and 60 µm are both "60" on the wire if the unit is not part of the payload.
       * This is the whole reason `Exact` exists, checked where it matters most: a width
       * bound stored a hundred thousand times too small is a product nobody can configure,
       * and it would have been frozen into a document.
       */
      expect(put.status).toBe(400);
    });
  });
});

/* ------------------------------------------------------------------ *
 * Fixtures and helpers
 * ------------------------------------------------------------------ */

/** A complete create request: product fields plus enough groups to compile. */
function createRequest(): unknown {
  return {
    id: PROBE_PRODUCT,
    slug: PROBE_PRODUCT,
    skuPrefix: 'PROBE1',
    fields: {
      nameTh: 'บานเกล็ดทดสอบ',
      categoryId: 'louvers',
      summaryTh: 'สินค้าสำหรับทดสอบเส้นทางการแก้ไขและเผยแพร่',
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

/**
 * A user in a group holding exactly these permissions, and a token for them.
 *
 * The token is signed by the running application's own `AccessTokenService`, so it is
 * verified by the same key and the same verifier that a real request would meet — the
 * alternative, minting a JWT in the test, would prove the test can sign rather than that
 * the app can authenticate.
 */
async function makeActor(
  db: Database,
  app: BootedApp,
  groupCode: string,
  codes: readonly ('catalog.read' | 'catalog.write' | 'catalog.publish')[],
): Promise<Actor> {
  const [user] = await db
    .insert(users)
    .values({ displayName: `catalog admin probe (${groupCode})` })
    .returning({ id: users.id });
  const [group] = await db
    .insert(groups)
    .values({ code: groupCode, nameTh: 'กลุ่มทดสอบแคตตาล็อก' })
    .onConflictDoUpdate({ target: groups.code, set: { nameTh: 'กลุ่มทดสอบแคตตาล็อก' } })
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

/**
 * Remove everything this file created, and nothing else.
 *
 * The probe product is deletable because it is never published: `product_versions_block_delete`
 * refuses a non-draft version, and a published one would make this row permanent — which is
 * the correct behaviour and the reason the publish block above uses a seeded product it
 * republishes rather than a throwaway it would strand.
 */
async function cleanUp(db: Database): Promise<void> {
  await db.delete(products).where(eq(products.id, PROBE_PRODUCT));

  const probeGroups = await db
    .select({ id: groups.id })
    .from(groups)
    .where(inArray(groups.code, [EDITOR_GROUP, READER_GROUP, `${EDITOR_GROUP}_w`]));

  if (probeGroups.length > 0) {
    const ids = probeGroups.map((row) => row.id);
    await db.delete(groupPermissions).where(inArray(groupPermissions.groupId, ids));
    await db.delete(userGroups).where(inArray(userGroups.groupId, ids));
    await db.delete(groups).where(inArray(groups.id, ids));
  }

  await db.delete(users).where(sql`${users.displayName} like 'catalog admin probe%'`);

  // A value added by a failed probe would otherwise sit in every future compile of every
  // draft that offers `profile_color`.
  const [colour] = await db
    .select({ id: optionGroups.id })
    .from(optionGroups)
    .where(eq(optionGroups.code, 'profile_color'));
  if (colour) {
    await db
      .delete(optionValues)
      .where(and(eq(optionValues.optionGroupId, colour.id), inArray(optionValues.code, ['PROBE1', PROBE_VALUE])));
  }

  // Deletable only because no version ever offered it: `pvov_option_value_fk` is ON DELETE
  // RESTRICT, which is what keeps an archived version's value list readable forever.
  await db.delete(optionGroups).where(eq(optionGroups.code, PROBE_GROUP));
}

/* ------------------------------------------------------------------ *
 * Reading a response without `any`
 * ------------------------------------------------------------------ */

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

function messageOf(response: Json): string {
  const error = asRecord(field(response.body, 'error'), 'an error envelope');
  return String(error['message']);
}

function detailsOf(response: Json): Record<string, unknown> {
  const error = asRecord(field(response.body, 'error'), 'an error envelope');
  return asRecord(error['details'], 'error details');
}

function groupCodesOf(body: unknown): string[] {
  const product = asRecord(field(body, 'product'), 'a product');
  const groups_ = product['groups'];
  if (!Array.isArray(groups_)) throw new Error('a product with no groups array');
  return groups_.map((group: unknown) => String(asRecord(group, 'a group')['code']));
}

function productField(body: unknown, key: string): unknown {
  return asRecord(field(body, 'product'), 'a product')[key];
}

function groupIn(body: unknown, groupCode: string): Record<string, unknown> {
  for (const raw of field<unknown[]>(body, 'groups')) {
    const group = asRecord(raw, 'an option group');
    if (group['code'] === groupCode) return group;
  }
  throw new Error(`no option group "${groupCode}" in the listing`);
}

function valueIn(body: unknown, groupCode: string, valueCode: string): Record<string, unknown> {
  const values = groupIn(body, groupCode)['values'];
  if (!Array.isArray(values)) throw new Error(`option group "${groupCode}" has no values array`);
  for (const raw of values) {
    const value = asRecord(raw, 'an option value');
    if (value['code'] === valueCode) return value;
  }
  throw new Error(`no value "${valueCode}" in option group "${groupCode}"`);
}

function availabilityIn(body: unknown, groupCode: string, valueCode: string): boolean {
  const product = asRecord(field(body, 'product'), 'a product');
  const groups_ = product['groups'];
  if (!Array.isArray(groups_)) throw new Error('a product with no groups array');

  for (const rawGroup of groups_) {
    const group = asRecord(rawGroup, 'a group');
    if (group['code'] !== groupCode) continue;
    const values = group['values'];
    if (!Array.isArray(values)) continue;
    for (const rawValue of values) {
      const value = asRecord(rawValue, 'a value');
      if (value['code'] === valueCode) return value['available'] === true;
    }
  }

  throw new Error(`no value ${groupCode}/${valueCode} in the served product`);
}
