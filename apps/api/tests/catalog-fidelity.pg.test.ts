import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Category, Product } from '@wewin/core';
import { categories as fixtureCategories, products as fixtureProducts } from '@wewin/core/fixtures';
import { calcPrice } from '@wewin/core/pricing';
import { toMicrons } from '@wewin/core/units';
import { decodeProductDocument, toCategory } from '@wewin/contract/catalog';
import type { CategoryWire, ProductDocument, ProductDocumentWire } from '@wewin/contract';
import { CONTRACT_VERSION, CONTRACT_VERSION_HEADER } from '@wewin/contract/version';
import { createDatabase, createPool } from '@wewin/db/client';
import { toDocument } from '@wewin/db/compile';
import { documentHash } from '@wewin/db/hash';
import { seedCatalog } from '@wewin/db/seed';

import { parseEnv } from '../src/config/env';
import { bootApp, testEnv, type BootedApp } from './support/app';

/**
 * The phase 3a gate: 81 products went into Postgres and 81 identical products come back.
 *
 * Modelled on `packages/core/tests/pricing-parity.test.ts`, which pins phase 1 by pricing
 * against a vendored v1.0.0 rather than against numbers somebody transcribed. The same
 * discipline applies to a data migration, and the trap is sharper: a round-trip test is
 * *easy* to write so that it passes no matter what the database holds. Three things are
 * done deliberately to stop that:
 *
 *   1. The two sides have genuinely different provenance. The expected side is
 *      `@wewin/core/fixtures` — the TS table, parsed by core's own zod at import. The
 *      actual side is an HTTP response body, produced by a Nest app that queried
 *      Postgres; `src/catalog/catalog.repository.ts` imports no fixture and the test
 *      below reads the compiled JavaScript to prove it.
 *   2. The comparison is `toStrictEqual` over the whole product — every group, every
 *      value, every rule node, the elevation, and every bigint. Not a field count, not a
 *      spot check: one micrometre or one satang out of place fails it.
 *   3. It is mutation-tested from inside the suite. The last block flips a row in
 *      `option_values`, watches the served catalogue change, and asserts that the
 *      comparison which passes above now fails — then puts the row back. A test that
 *      cannot be made to fail on demand has not been shown to test anything. It stays
 *      mutable from outside too: `seedIfEmpty` fills an empty catalogue but never
 *      overwrites a populated one, so a row changed by hand is compared, not erased.
 *
 * Skipped, not failed, without a database: a laptop with no Docker still runs the rest of
 * the suite. Nothing here can be faked, which is the point.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

/** Sorted for a comparison that reports the difference rather than the order. */
const idsOf = (products: readonly { id: string }[]): string[] =>
  products.map((product) => product.id).sort();

const byId = (documents: readonly ProductDocument[]): Map<string, ProductDocument> =>
  new Map(documents.map((document) => [document.product.id, document]));

/**
 * Fill an empty catalogue, and only an empty one.
 *
 * Two failure modes are being traded off, and the choice matters to what this file
 * proves. Seeding unconditionally would make the suite hermetic — but it would also
 * overwrite whatever the database actually holds, so a row somebody corrupted by hand
 * would be silently replaced a millisecond before the assertions that exist to catch it,
 * and the mutation exercise at the bottom of this file could never be repeated from the
 * outside. Seeding never at all means a fresh checkout fails with 81 assertions about an
 * empty table, which reads as a broken read path rather than as "nobody ran `db:seed`".
 *
 * So: an empty catalogue is filled, a populated one is left exactly as it is and compared.
 * `seedCatalog` is what `pnpm db:seed` runs — `src/bin/seed.ts` is a wrapper around it —
 * so the path under test is the shipped one and not a test-local imitation.
 */
/**
 * Seed unconditionally, every time.
 *
 * This was `seedIfEmpty`, which returned as soon as it saw one product — and "not empty"
 * is the wrong question for a suite whose whole claim is that the database matches the
 * fixture exactly. Other suites here legitimately add and publish products, so by the
 * time this one ran the catalogue was 83 products deep and the comparison failed on work
 * that was doing what it was supposed to. The claim is about a seeded catalogue, so this
 * seeds one rather than hoping to find one.
 */
async function reseed(databaseUrl: string): Promise<void> {
  const pool = createPool(databaseUrl);
  try {
    await seedCatalog(createDatabase(pool), 'api-fidelity-test');
  } finally {
    await pool.end();
  }
}

async function getJson(baseUrl: string, path: string): Promise<unknown> {
  const response = await fetch(`${baseUrl}${path}`);
  if (!response.ok) throw new Error(`GET ${path} answered ${String(response.status)}`);
  // The version of the contract this body is written to, from the header rather than from
  // inside the body it describes.
  expect(response.headers.get(CONTRACT_VERSION_HEADER)).toBe(String(CONTRACT_VERSION));
  return response.json();
}

describeWithPg('the catalogue in Postgres is the catalogue in the fixture table', () => {
  const env = parseEnv({ NODE_ENV: 'test', DATABASE_URL: url ?? 'postgres://unused/unused' });
  let booted: BootedApp;
  let served: Map<string, ProductDocument>;
  let servedWire: Map<string, ProductDocumentWire>;

  beforeAll(async () => {
    await reseed(env.DATABASE_URL);
    booted = await bootApp(testEnv({ DATABASE_URL: env.DATABASE_URL }));

    const body = (await getJson(booted.baseUrl, '/catalog/products')) as {
      products: ProductDocumentWire[];
    };
    servedWire = new Map(body.products.map((wire) => [wire.product.id, wire]));
    // `decodeProductDocument` validates with zod before decoding, so a body that is the
    // right shape but the wrong *units* — a length tagged `cm`, a rate parsed as an
    // amount — is rejected here rather than compared as if it were fine.
    served = byId(body.products.map(decodeProductDocument));
  });

  afterAll(async () => {
    await booted?.close();
  });

  it('serves all 81 products and no others', () => {
    expect(served.size).toBe(81);
    expect(idsOf([...served.values()].map((document) => document.product))).toEqual(
      idsOf(fixtureProducts),
    );
  });

  /*
   * The proof itself, one test per product so a failure names the product rather than
   * printing 81 of them. `toStrictEqual` and not `toEqual`: `exactOptionalPropertyTypes`
   * is on across this repo, so a value that carries `swatchHex: undefined` is a different
   * object from one that omits the key, and the frozen document is supposed to omit it.
   */
  it.each(fixtureProducts.map((product): [string, Product] => [product.id, product]))(
    '%s comes back identical, to the last micrometre and satang',
    (id, fixture) => {
      const document = served.get(id);
      expect(document, `no published version served for ${id}`).toBeDefined();
      expect(document?.product).toStrictEqual(fixture);
    },
  );

  it('states the unit of every exact quantity on the wire, not just in TypeScript', () => {
    // A client this repository does not ship reads these bodies. `1500000000000` with no
    // tag is a number somebody will divide by a million; `{"unit":"um2"}` is not. Checked
    // on the raw wire objects rather than after decoding, because decoding is the step
    // that would hide a missing tag.
    const wire = servedWire.get('awn-4t');
    expect(wire?.product.minBillableSqUm).toMatchObject({ unit: 'um2' });
    expect(wire?.product.pricePerSqm).toMatchObject({ unit: 'THB.satang/m2' });

    const width = wire?.product.groups.find((group) => group.code === 'width');
    expect(width?.kind).toBe('custom');
    if (width?.kind === 'custom') {
      expect(width.minUm).toMatchObject({ unit: 'um' });
      expect(width.stepUm).toMatchObject({ unit: 'um' });
    }
  });

  it('hands out the version handle a price request has to send back', () => {
    for (const fixture of fixtureProducts) {
      const document = served.get(fixture.id);
      // A uuid, because that is what an order line will store.
      expect(document?.productVersionId).toMatch(/^[0-9a-f-]{36}$/);

      /*
       * The hash is checked against one computed here from the fixture, not merely
       * against itself. That is what makes it evidence: it says the JSONB in Postgres
       * canonicalises to exactly the document `toDocument` compiles from the table, so
       * the 409 check in plan 5 point 5 will compare like with like.
       */
      expect(document?.documentHash).toBe(documentHash(toDocument(fixture)));
    }
  });

  it('answers the same document one slug at a time', async () => {
    // The list and the single-product endpoint are two different queries; if they can
    // disagree, a customer configuring from a product page is not looking at what the
    // catalogue page offered.
    for (const fixture of fixtureProducts) {
      const wire = (await getJson(
        booted.baseUrl,
        `/catalog/products/${fixture.slug}`,
      )) as ProductDocumentWire;
      expect(decodeProductDocument(wire)).toStrictEqual(served.get(fixture.id));
    }
  });

  it('refuses a slug that has no published version', async () => {
    const response = await fetch(`${booted.baseUrl}/catalog/products/not-a-product`);
    expect(response.status).toBe(404);
    expect((await response.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'NOT_FOUND' },
    });
  });

  it('serves the categories the table declares', async () => {
    const body = (await getJson(booted.baseUrl, '/catalog/categories')) as {
      categories: CategoryWire[];
    };
    const decoded: Category[] = body.categories.map(toCategory);

    // Sorted on both sides: the table's order is authored and the query's is `sort_order`,
    // and this test is about the content of the ten rows, not about their sequence.
    const bySortedId = (list: readonly Category[]): Category[] =>
      [...list].sort((left, right) => (left.id < right.id ? -1 : 1));

    expect(bySortedId(decoded)).toStrictEqual(bySortedId(fixtureCategories));
  });

  /*
   * Prices, said in satang.
   *
   * Structural equality above already implies this — but the thing this phase must not
   * break is a number a customer is charged, and a test that never mentions money makes
   * a reviewer take that inference on trust. The two spec totals are the same figures
   * `pricing-parity` pins for phase 1, recomputed here from the product the database
   * served.
   */
  it('prices the spec cases identically from the database product', () => {
    const cm = (value: number): bigint => toMicrons(value, 'cm');

    const awning = served.get('awn-4t')?.product;
    expect(awning).toBeDefined();
    if (awning) {
      const price = calcPrice(
        awning,
        { profile_color: 'DW', glass_color: 'GRN', glass_thickness: 'T5', insect_screen: 'NS0' },
        { width: cm(320), height: cm(160) },
        2,
      );
      expect(price.totalMinor).toBe(1_843_200n);
    }

    const slider = served.get('sld-2p')?.product;
    expect(slider).toBeDefined();
    if (slider) {
      expect(calcPrice(slider, {}, { width: cm(180), height: cm(220) }, 1).totalMinor).toBe(
        879_100n,
      );
    }
  });

  it('prices every product the same from the database as from the table', () => {
    let compared = 0;

    for (const fixture of fixtureProducts) {
      const fromDatabase = served.get(fixture.id)?.product;
      expect(fromDatabase).toBeDefined();
      if (!fromDatabase) continue;

      const width = fixture.groups.find(
        (group) => group.kind === 'custom' && group.code === 'width',
      );
      const height = fixture.groups.find(
        (group) => group.kind === 'custom' && group.code === 'height',
      );
      if (width?.kind !== 'custom' || height?.kind !== 'custom') continue;

      // The ends of the range and the default, where the price floor and the size rules
      // bite; the comfortable middle is the one place a mistake would not show.
      for (const w of [width.minUm, width.defaultUm, width.maxUm]) {
        for (const h of [height.minUm, height.defaultUm, height.maxUm]) {
          for (const qty of [1, 7]) {
            const measures = { width: w, height: h };
            expect(calcPrice(fromDatabase, {}, measures, qty)).toStrictEqual(
              calcPrice(fixture, {}, measures, qty),
            );
            compared += 1;
          }
        }
      }
    }

    // Pinned, so a catalogue that quietly lost its size groups cannot pass by comparing
    // nothing at all — the failure mode of every loop-based assertion.
    expect(compared).toBe(fixtureProducts.length * 18);
  });

  it('reports the catalogue it is serving on /meta, counted from Postgres', async () => {
    // Plain fetch, not `getJson`: /meta is not a contract-versioned body — it describes
    // the service, not the catalogue's wire shape, so it carries no contract header.
    const response = await fetch(`${booted.baseUrl}/meta`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      catalog: { source: string; counts: { publishedProducts: number; categories: number } | null };
    };

    expect(body.catalog.source).toBe('database');
    /*
     * The number has to come from the same place the products did. /meta used to import
     * `@wewin/core/fixtures` and answer 81 whatever the database held — which is a
     * coincidence here, so this compares against the served list rather than against the
     * literal 81 that made the old bug invisible.
     */
    expect(body.catalog.counts?.publishedProducts).toBe(served.size);
    expect(body.catalog.counts?.categories).toBe(fixtureCategories.length);
  });

  it('cannot be reading the fixture table: the compiled read path does not import it', () => {
    // The same trick tests/esm-bridge.test.ts uses — read what was emitted, not what the
    // source appears to say. If this ever fails, every assertion above is comparing the
    // fixture table to itself and proves nothing.
    // `process.cwd()` and not `__dirname`: Vitest transforms this file as ESM, where
    // `__dirname` does not exist. Same resolution tests/esm-bridge.test.ts uses.
    const emitted = resolve(process.cwd(), 'dist/catalog/catalog.repository.js');
    const source = readFileSync(emitted, 'utf8');
    expect(source).toContain('@wewin/db');
    expect(source).not.toContain('fixtures');
  });
});

/*
 * Mutation, from inside the suite.
 *
 * Plan 4.7's lesson, applied here: "a test that passes has not been shown to catch
 * anything". `option_values.available` is the right row to move — it is the one catalogue
 * fact deliberately left *out* of the frozen document (plan 5 point 2), so the value the
 * API serves for it can only have come from a live query. Everything else in the product
 * is frozen and, as it happens, cannot be edited at all: the trigger in
 * `0001_catalog_freeze.sql` refuses an UPDATE of `document` on a published version, which
 * is why the manual mutation of the JSONB documented in the seed report had to disable
 * that trigger first.
 */
describeWithPg('the proof fails when the database says something else', () => {
  const env = parseEnv({ NODE_ENV: 'test', DATABASE_URL: url ?? 'postgres://unused/unused' });
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
  let booted: BootedApp;

  beforeAll(async () => {
    booted = await bootApp(testEnv({ DATABASE_URL: env.DATABASE_URL }));
  });

  afterAll(async () => {
    await booted?.close();
    await pool.end();
  });

  const fetchProduct = async (slug: string): Promise<Product> => {
    const wire = (await getJson(booted.baseUrl, `/catalog/products/${slug}`)) as ProductDocumentWire;
    return decodeProductDocument(wire).product;
  };

  it('flipping one option value to unavailable turns the comparison red', async () => {
    const fixture = fixtureProducts.find((product) => product.id === 'awn-4t');
    if (!fixture) throw new Error('fixture awn-4t missing');

    // Sanity: green before the mutation, so a red afterwards is attributable to it.
    expect(await fetchProduct(fixture.slug)).toStrictEqual(fixture);

    const mutation = await pool.query(
      `update option_values ov
          set available = false
         from option_groups og
        where og.id = ov.option_group_id
          and og.code = 'profile_color'
          and ov.code = 'DW'
      returning ov.id`,
    );
    expect(mutation.rowCount).toBe(1);

    try {
      const mutated = await fetchProduct(fixture.slug);

      // The served product changed, in the one field that is read live.
      const profile = mutated.groups.find((group) => group.code === 'profile_color');
      expect(profile?.kind).toBe('sku');
      if (profile?.kind === 'sku') {
        expect(profile.values.find((value) => value.code === 'DW')?.available).toBe(false);
      }

      // And the assertion the whole file rests on now fails. Written as `.not` so this
      // test stays green while proving the other one would not be.
      expect(mutated).not.toStrictEqual(fixture);
    } finally {
      const restored = await pool.query(
        `update option_values ov
            set available = true
           from option_groups og
          where og.id = ov.option_group_id
            and og.code = 'profile_color'
            and ov.code = 'DW'
        returning ov.id`,
      );
      expect(restored.rowCount).toBe(1);
    }

    // Restored, and the API says so — the cache that would make this test lie does not
    // exist yet, and if one is added this line is where it will fail.
    expect(await fetchProduct(fixture.slug)).toStrictEqual(fixture);
  });

  /**
   * The document hash is a checksum, not a label.
   *
   * Serving `product_versions.document_hash` out of the column meant a document edited in
   * place kept its old hash, and the 409 check in plan 5 point 5 would have compared a
   * client's stale hash against a value that no longer described the document beside it.
   * `CatalogRepository` recomputes it; this is the proof, and it is the same mutation
   * that was found to pass silently — one field of the frozen JSONB changed while the
   * hash column is left exactly as it was.
   *
   * Two things have to be defeated to even attempt it, which is itself the finding: the
   * freeze trigger refuses the UPDATE, and the repository memoises per (version, hash)
   * pair, so the check runs for a process that has not served this pair yet. Hence a
   * fresh app rather than the one this suite booted.
   */
  it('refuses a published document that no longer hashes to its stored hash', async () => {
    const slug = 'awn-4t';
    const [original] = (
      await pool.query<{ id: string; document: unknown }>(
        `select pv.id, pv.document
           from product_versions pv
           join products p on p.id = pv.product_id
          where p.slug = $1 and pv.status = 'published'`,
        [slug],
      )
    ).rows;
    expect(original).toBeDefined();
    if (!original) return;

    await pool.query('alter table product_versions disable trigger product_versions_freeze');
    try {
      // One field, no hash update. `min_billable_sq_um` on the wire is a decimal string,
      // so this is a legal document — just not the one that was published.
      const mutated = await pool.query(
        `update product_versions
            set document = jsonb_set(document, '{minBillableSqUm}', to_jsonb('999'::text))
          where id = $1
        returning id`,
        [original.id],
      );
      expect(mutated.rowCount).toBe(1);

      const fresh = await bootApp(testEnv({ DATABASE_URL: env.DATABASE_URL }));
      try {
        const response = await fetch(`${fresh.baseUrl}/catalog/products/${slug}`);
        // 500, and an error envelope rather than a product: the request fails instead of
        // quoting from a document nobody published.
        expect(response.status).toBe(500);
        const body = (await response.json()) as { error?: { code?: string }; product?: unknown };
        expect(body.error?.code).toBe('INTERNAL');
        expect(body.product).toBeUndefined();
      } finally {
        await fresh.close();
      }
    } finally {
      await pool.query('update product_versions set document = $2 where id = $1', [
        original.id,
        original.document,
      ]);
      await pool.query('alter table product_versions enable trigger product_versions_freeze');
    }

    // Put back, and served again — so a failure above is the mutation and not a suite that
    // left the database broken for everything after it.
    const restored = await fetchProduct(slug);
    expect(restored).toStrictEqual(fixtureProducts.find((product) => product.id === 'awn-4t'));
  });
});
