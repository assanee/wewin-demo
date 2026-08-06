import Link from 'next/link';
import { SOURCE_LOCALE } from '@wewin/i18n/locales';

import { localeHome } from '@/lib/routing';

/**
 * The 404 *inside* a valid locale — `/de/does-not-exist`.
 *
 * It sits under the locale layout, so the response already carries the right
 * `<html lang>`; what it cannot yet carry is the right words, because the app's catalogue
 * is a porting agent's to move. Rather than pick one of the eight and be wrong in seven,
 * it says the least it can and offers the way back. `pages/NotFound.tsx` in the Vite app
 * is the thing that replaces this.
 *
 * Unmatched paths *outside* a locale never reach here: `src/middleware.ts` gives them a
 * prefix first, so `/does-not-exist` becomes `/th/does-not-exist` and lands on this page
 * with a language already chosen.
 */
export default function LocaleNotFound() {
  return (
    <main className="container-page py-16">
      <p className="numeric text-caption text-chalk-3">404</p>
      <h1 className="mt-3 text-title text-chalk">ไม่พบหน้านี้ · Page not found</h1>
      {/* Thai, because a not-found boundary is rendered outside the route that knows the
          locale — `params` does not reach here. Sending an unprefixed `/` instead would
          bounce through the proxy and land the reader wherever their browser prefers,
          which is a different page from the one they were on. */}
      <p className="mt-4 text-body text-chalk-2">
        <Link href={localeHome(SOURCE_LOCALE)}>WEWIN180</Link>
      </p>
    </main>
  );
}
