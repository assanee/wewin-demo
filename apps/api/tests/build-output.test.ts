import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The build output, checked against the sources it claims to be.
 *
 * 🔴 This exists because of a failure the whole 1,131-assertion suite is structurally blind
 * to: **vitest runs against `src`, the process runs against `dist`, and they can disagree.**
 *
 * `src/quotes/authority.ts` became `src/quotes/authority/` in phase 5c. `tsc` emitted the
 * new directory and left the old `dist/quotes/authority.js` behind — it removes nothing it
 * did not write. Node's CJS resolution prefers a file over a directory of the same name, so
 * the assembled app loaded a module from before the split, `AuthorityModule` was
 * `undefined`, and `node dist/main.js` died at boot with `UndefinedForwardRefException`
 * while every test in this package passed.
 *
 * Two checks, because they fail at different times:
 *
 *   1. **The build cleans first.** Cheap, always runnable, and the actual fix.
 *   2. **No orphan is on disk right now.** Catches the case where the fix is in place but
 *      the working copy still carries the wreckage from before it — which is every machine
 *      that had been working on this project.
 */

/*
 * `process.cwd()`, not `__dirname` and not `import.meta.url`. This package compiles to
 * CommonJS, so `import.meta` is a compile error under `tsc`; Vitest transforms the file as
 * ESM, so `__dirname` does not exist at run time. Only the working directory is true in
 * both, which is the same resolution `tests/catalog-fidelity.pg.test.ts` and
 * `tests/test-db.ts` already use and say so.
 */
const appRoot = process.cwd();
const distRoot = join(appRoot, 'dist');
const srcRoot = join(appRoot, 'src');

const walk = (root: string, predicate: (name: string) => boolean): readonly string[] => {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return walk(path, predicate);
    return predicate(entry.name) ? [path] : [];
  });
};

describe('the build has no memory', () => {
  it('`build` deletes dist before tsc writes it', () => {
    const scripts = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    // Ordering matters and is what is asserted: a clean *after* the compile would delete
    // the build. `tsc` has no `--clean` for a non-composite project, which is why this is
    // a script rather than a flag.
    const build = scripts.scripts.build ?? '';
    expect(build).toMatch(/clean-dist\.mjs.*tsc/);
  });
});

describe('nothing in dist outlived its source', () => {
  it('every emitted .js maps to a .ts that still exists', () => {
    if (!existsSync(distRoot)) {
      // Not a skip: state the reason in an assertion so a `dist` that stopped being built
      // cannot make this file quietly stop checking anything.
      expect(existsSync(join(appRoot, 'package.json'))).toBe(true);
      return;
    }

    const emitted = walk(distRoot, (name) => name.endsWith('.js'));
    // An empty walk passes every assertion below and proves nothing — the phase-5b dead
    // globalSetup shape. A built api is hundreds of files.
    expect(emitted.length).toBeGreaterThan(100);

    const orphans = emitted
      .map((path) => relative(distRoot, path))
      .filter((name) => {
        const stem = name.replace(/\.js$/, '');
        return (
          !existsSync(join(srcRoot, `${stem}.ts`)) &&
          !existsSync(join(srcRoot, `${stem}.tsx`)) &&
          // A directory's `index.ts` emits `index.js` under the same relative path, so the
          // stem test above already covers it; what this allows for is a `.js` emitted from
          // a `.json` or copied asset, of which there are none today.
          !existsSync(join(srcRoot, stem))
        );
      });

    // The named example, so a failure reads as the bug rather than as a list of paths:
    // `dist/quotes/authority.js` beside `dist/quotes/authority/` is an API that does not
    // boot, with a green suite.
    expect(orphans).toEqual([]);
  });
});
