import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/*
 * SWC, not the default esbuild transform.
 *
 * esbuild understands `experimentalDecorators` but drops `emitDecoratorMetadata` — it
 * cannot emit `design:paramtypes` because it does not do type resolution. Nest reads
 * exactly that metadata to resolve constructor parameters, so under esbuild every
 * provider injected by class type fails with "Nest can't resolve dependencies", and the
 * workaround (an explicit `@Inject()` on every constructor parameter) makes the test
 * runner dictate production code style. SWC emits the metadata, so what the tests wire up
 * is what `tsc` wires up.
 *
 * `.mts` because this package is CommonJS and the config must load as ESM.
 */
export default defineConfig({
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        target: 'es2023',
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
  },
});
