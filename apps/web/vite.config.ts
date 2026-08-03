import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The test block moved out with the code it covered: every one of the 219 tests
// exercises pure domain logic, which now lives in @wewin/core and is tested there.
// This app owns no tests yet — pretending otherwise with an empty glob would only
// make a green run mean less.
export default defineConfig({
  plugins: [react(), tailwindcss()],
});
