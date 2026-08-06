import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * `environment: 'node'`, the same as every other package here. Nothing in this scaffold
 * renders — what is under test is the wiring that three porting agents are about to build
 * on top of, and the two cache traps in plan 8.2 that are cheap to enforce with a scan and
 * expensive to notice by review.
 *
 * Two roots, and the second is not cosmetic: apps/dashboard's config records the round
 * where 66 tests landed under `src/**` and `pnpm test` reported 38 because only `tests/**`
 * was collected. Tests live beside the module or under `tests/`; both are collected.
 *
 * The `@/` alias is restated rather than read from tsconfig, because vitest resolves
 * modules and `tsconfig.paths` is a compiler concern.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
  },
});
