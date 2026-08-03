import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/*
 * The one thing in this app that is genuinely hard: NestJS is CommonJS, @wewin/core is
 * ESM-only.
 *
 * Vitest cannot prove this works. It resolves everything through Vite as ESM, so a passing
 * import here would say nothing about what `node dist/main.js` does. So this test looks at
 * the compiled output and then runs it in a real CommonJS process — which is exactly the
 * environment production uses and the only one where require(ESM) can fail.
 *
 * `pnpm test` compiles first (see package.json) so dist is always current.
 */

const distFile = resolve(process.cwd(), 'dist/meta/catalog-source.js');

describe('CommonJS -> ESM bridge', () => {
  it('compiles the core imports to require() calls', () => {
    expect(existsSync(distFile), `${distFile} is missing — run \`pnpm build\``).toBe(true);

    const emitted = readFileSync(distFile, 'utf8');
    expect(emitted).toContain('require("@wewin/core/money")');
    // Two ESM-only packages, both required at module load in the boot graph.
    expect(emitted).toContain('require("@wewin/db/schema")');
    // If this ever becomes `import`, the package has silently turned into ESM and the
    // decorator metadata Nest depends on went with it.
    expect(emitted).not.toMatch(/^import /m);
    /*
     * /meta counts the database, not the fixture table. The import went away when the
     * endpoint stopped lying about where its numbers come from, and this assertion is
     * here so it cannot drift back in unnoticed: nothing in the request path may reach
     * for the fixtures, or `tests/catalog-fidelity.pg.test.ts` is comparing the TS table
     * to itself.
     */
    expect(emitted).not.toContain('@wewin/core/fixtures');
  });

  it('loads ESM-only @wewin/core and @wewin/db from a real CommonJS process', () => {
    const script = `
      const { CatalogSourceService } = require(${JSON.stringify(distFile)});
      const { CURRENCIES } = require('@wewin/core/money');
      const { products } = require('@wewin/core/fixtures');
      process.stdout.write(JSON.stringify({
        service: typeof CatalogSourceService,
        currencies: CURRENCIES.length,
        // The catalogue's zod parse runs on import; 81 is what it produces. No longer on
        // the API's boot path, but still the thing @wewin/db seeds from, and requiring it
        // from CJS is the same boundary crossing.
        productCount: products.length,
        moduleType: typeof module.exports,
      }));
    `;

    const output = execFileSync(process.execPath, ['--input-type=commonjs', '-e', script], {
      encoding: 'utf8',
      cwd: process.cwd(),
    });
    const parsed = JSON.parse(output) as {
      service: string;
      currencies: number;
      productCount: number;
      moduleType: string;
    };

    expect(parsed.service).toBe('function');
    expect(parsed.currencies).toBeGreaterThan(0);
    expect(parsed.productCount).toBe(81);
    // `module` only exists in CommonJS; its presence is what makes the assertions above
    // mean "required from CJS" rather than "imported from ESM".
    expect(parsed.moduleType).toBe('object');
  });

  it('keeps bigint a bigint across the module-system boundary', () => {
    const script = `
      const { minorPerUnit } = require('@wewin/core/money');
      const value = minorPerUnit('THB');
      process.stdout.write(JSON.stringify({ type: typeof value, value: value.toString() }));
    `;

    const output = execFileSync(process.execPath, ['--input-type=commonjs', '-e', script], {
      encoding: 'utf8',
      cwd: process.cwd(),
    });
    expect(JSON.parse(output)).toEqual({ type: 'bigint', value: '100' });
  });
});

/*
 * The same bridge, now carrying two more ESM-only packages.
 *
 * The catalogue read path requires `@wewin/db` (and through it drizzle-orm) and
 * `@wewin/contract` from CommonJS. Neither is covered by the tests above, and the failure
 * mode is the one the whole arrangement is exposed to: a top-level `await` anywhere in
 * that graph turns every `require()` into ERR_REQUIRE_ASYNC_MODULE at boot. Loading the
 * module in a real CommonJS process is the only way to find out, and it needs no database
 * — nothing here connects, it only resolves and evaluates.
 */
describe('the catalogue read path crosses the same boundary', () => {
  const repository = resolve(process.cwd(), 'dist/catalog/catalog.repository.js');
  const controller = resolve(process.cwd(), 'dist/catalog/catalog.controller.js');

  it('compiles @wewin/db and @wewin/contract to require() calls', () => {
    expect(existsSync(repository), `${repository} is missing — run \`pnpm build\``).toBe(true);

    const emitted = readFileSync(repository, 'utf8');
    expect(emitted).toContain('require("@wewin/db/compile")');
    expect(emitted).toContain('require("@wewin/db/schema")');
    // Operators come from @wewin/db, not from drizzle-orm directly: this app resolves
    // drizzle's *require* declarations and the schema was built against its *import* ones,
    // which TypeScript treats as two different types. See packages/db/src/sql.ts.
    expect(emitted).toContain('require("@wewin/db/sql")');
    expect(emitted).not.toContain('require("drizzle-orm")');

    expect(readFileSync(controller, 'utf8')).toContain('require("@wewin/contract/catalog")');
  });

  it('loads them in a real CommonJS process, which is where an async module would fail', () => {
    const script = `
      const { CatalogRepository } = require(${JSON.stringify(repository)});
      const { CatalogController } = require(${JSON.stringify(controller)});
      process.stdout.write(JSON.stringify({
        repository: typeof CatalogRepository,
        controller: typeof CatalogController,
        moduleType: typeof module.exports,
      }));
    `;

    const output = execFileSync(process.execPath, ['--input-type=commonjs', '-e', script], {
      encoding: 'utf8',
      cwd: process.cwd(),
    });
    expect(JSON.parse(output)).toEqual({
      repository: 'function',
      controller: 'function',
      moduleType: 'object',
    });
  });
});
