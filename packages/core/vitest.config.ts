import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    /**
     * ⚠️ Raised from vitest's 5s default because two tests here are **exhaustive sweeps**,
     * not examples, and that is deliberate: `pricing-parity` compares 160,740 configurations
     * against v1.0.0's own `calcPrice`, and `displayUnits` tours every configurable size
     * through all five display units from every starting unit.
     *
     * On an idle machine the display-unit tour takes 788 ms. Under `turbo run test`, with
     * seven packages compiling and running at once, it was measured at 5,602 ms — seven
     * times slower for CPU it is not getting, and a *timeout* rather than a failed
     * assertion. Nothing was wrong with the code; the suite was simply red on a busy laptop
     * and green on a quiet one.
     *
     * `packages/db/vitest.config.ts` reached 30 s by the same road and states the principle
     * this follows: a suite whose colour depends on machine load says less than one that
     * does not. The number is generous on purpose — a sweep that genuinely hangs still
     * fails, half a minute later, and half a minute is cheap next to a red build nobody can
     * reproduce.
     */
    testTimeout: 30_000,
  },
});
