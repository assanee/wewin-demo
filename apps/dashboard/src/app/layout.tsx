import type { Metadata } from 'next';
import { IBM_Plex_Sans_Thai } from 'next/font/google';

import { Providers } from './providers';
import './globals.css';

/**
 * IBM Plex Sans Thai, the body face apps/web already uses (its index.css sets `--font-body`
 * to it), so the two applications read as one product to the people who use both. Loaded
 * through `next/font`, which self-hosts the files at build time — apps/web reaches Google
 * Fonts from the browser on every first paint, and the dashboard has no reason to inherit
 * that.
 *
 * Plan 8.3's font-per-script problem is a phase 6 concern and does not apply here: this is
 * an internal tool with Thai and Latin copy and no Devanagari or CJK to fall over on. The
 * `line-height` that section chose for Thai vowels is set in globals.css.
 *
 * It fills `--font-sans`, which is the variable shadcn's `@theme inline` block already maps
 * `font-sans` to — so every generated component picks this up without being told.
 */
const bodyFont = IBM_Plex_Sans_Thai({
  subsets: ['thai', 'latin'],
  weight: ['400', '500', '600'],
  variable: '--font-sans',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'WEWIN — ระบบจัดการภายใน',
  description: 'จัดการสินค้า ตัวเลือก และรูปภาพของแคตตาล็อก WEWIN',
  /*
   * An internal tool has nothing for a crawler, and its sign-in page is not a search
   * result. Said here rather than left to a robots.txt somebody has to remember to write.
   */
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { readonly children: React.ReactNode }) {
  /*
   * `suppressHydrationWarning` is required by next-themes and only by it: the theme script
   * writes `class="dark"` onto <html> before React hydrates, so the server's markup and the
   * client's genuinely differ there. It applies to that one element's own attributes and
   * suppresses nothing below it.
   */
  return (
    <html lang="th" className={bodyFont.variable} suppressHydrationWarning>
      <body className="font-sans antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
