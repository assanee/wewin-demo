import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // The integration tests share one server and one set of catalogue rows. Running
    // files in parallel would have one file's truncate land in the middle of another
    // file's assertions, which reads as a flake rather than as the collision it is.
    fileParallelism: false,
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
