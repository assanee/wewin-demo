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
    include: ['tests/**/*.test.ts'],
  },
});
