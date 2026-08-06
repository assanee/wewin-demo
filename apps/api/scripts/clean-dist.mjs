#!/usr/bin/env node
/**
 * Delete `dist/` before `tsc` writes it.
 *
 * 🔴 **This is not tidiness. Without it the assembled application does not boot, and 1,131
 * tests are green anyway.**
 *
 * `tsc` writes output; it never removes output it did not write this time. When
 * `src/quotes/authority.ts` became `src/quotes/authority/` in phase 5c, `tsc` emitted the
 * new directory and left the old `dist/quotes/authority.js` sitting beside it. Node's CJS
 * resolution prefers the *file* over the *directory*, so `require('./quotes/authority')`
 * returned a module from before the split — one with no `AuthorityModule` in it — and
 * `AppModule.forRoot(...).imports[14]` was `undefined`:
 *
 * ```
 *   $ node dist/main.js
 *   UndefinedForwardRefException … Scope [AppModule]
 * ```
 *
 * The suite cannot see it. `vitest` runs against `src`, where the directory resolves
 * correctly, so 97 files and 1,131 assertions pass while the built process is dead. A
 * fresh clone does not have the bug; only a machine whose `dist/` predates the split does,
 * which is every machine that had been working on the project.
 *
 * That is phase 5c's own finding — *"two complete modules, 1,100 tests, every route a 404
 * against the assembled application"* — repeated one layer down, in the build output. The
 * fix is for the build to have no memory.
 */
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
rmSync(dist, { recursive: true, force: true });
