/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Phase 0 moved the 219 domain tests out with the code they covered, and left this
// file with no test block at all — correctly, because an empty glob makes a green run
// mean less than no run.
//
// Phase 6a gives the app something of its own worth pinning: the locale layer. It is
// pure — a locale and a value in, a string out — so the suite needs no DOM and no
// jsdom, and the files sit under `src/` so `tsc -b` type-checks them with the same
// settings as the components they cover. Nothing in the suite imports React.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    include: ['src/**/*.test.ts'],
  },
});
