import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * `environment: 'node'`, same as every other package here, because nothing under test
 * touches the DOM. What *is* under test is the logic that would otherwise only be described
 * in a comment: the refresh client's refusal to serialise, the return-to check, and the
 * derivation of a menu from a permission list. Components are not — a test that renders a
 * sidebar and asserts it contains three links is a test of `visibleNavigation`, spelled
 * expensively.
 *
 * The `@/` alias is restated rather than read from tsconfig, because vitest resolves
 * modules and `tsconfig.paths` is a compiler concern. Two places, one value, and a wrong
 * one fails immediately rather than subtly.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    /*
     * Two roots, and the second one is not cosmetic. Phase 5c landed 66 tests beside the modules
     * they cover in `src/components/quotes/**`, and with `tests/**` alone `pnpm test` reported
     * 38 — the new ones were never run by anything, in a repository whose house rule is that a
     * suite which cannot fail is not evidence. Tests live beside the module or under `tests/`;
     * both are collected.
     */
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
  },
});
