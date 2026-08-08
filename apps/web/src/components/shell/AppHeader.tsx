import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ClipboardList } from 'lucide-react';
import { company } from '../../data/company';
import { aboutHref, catalogHref, localeHome, quoteHref } from '../../lib/routing';
import { useLocale } from '../../state/localeContext';
import { useQuote } from '../../state/useQuote';
import { AccountLink } from './AccountLink';
import { LanguagePicker } from './LanguagePicker';

const NAV_LINK_CLASS =
  'inline-flex min-h-11 items-center px-3 text-body transition-colors duration-180 ease-out';
const NAV_LINK_ACTIVE_CLASS = 'text-chalk';
const NAV_LINK_IDLE_CLASS = 'text-chalk-2 hover:text-chalk';

/**
 * Spec section 8: no hamburger on mobile. There are two nav links; hiding two items behind
 * a menu adds a tap to reach either one and saves nothing worth saving. On mobile the nav
 * simply drops and the two entry points live on the page itself.
 *
 * The language picker lives here because the language governs the whole document — every
 * route, the footer, the 404 page — where the unit picker governs three fields and
 * therefore sits with them. At 360px it is an icon and a 44px select beside the cart; the
 * wordmark shrinks before either of them does.
 *
 * ── What the port changed ────────────────────────────────────────────────────────
 *
 * `NavLink` and its `isActive` render prop came from react-router and have no equivalent
 * here, so the active state is `usePathname()` compared against the locale's own catalogue
 * and about URLs. Comparing whole hrefs rather than testing a suffix is what keeps
 * `/de/products/awn-4t` from lighting up the catalogue link — a product page is not the
 * catalogue, and `startsWith` would say it was.
 *
 * Every href goes through `lib/routing`, so `typedRoutes` checks it: a link to a page that
 * does not exist is a compile error rather than a 404 discovered by a customer.
 */
export function AppHeader() {
  // Pieces rather than rows: three windows on one line reads as 3, which is what the
  // customer counts.
  const { itemCount: quoteCount } = useQuote();
  const { t, f, locale } = useLocale();
  const pathname = usePathname();

  const navClass = (href: string): string =>
    `${NAV_LINK_CLASS} ${pathname === href ? NAV_LINK_ACTIVE_CLASS : NAV_LINK_IDLE_CLASS}`;

  const catalog = catalogHref(locale);
  const about = aboutHref(locale);

  return (
    <header
      /*
       * ⚠️ `data-chrome` exists so the print rule can name *this* header and not every header.
       *
       * A bare `header { display: none }` in `@media print` also hides `article > header` —
       * the block carrying a quotation's number, its date and the customer's name. It was
       * measured doing exactly that: the site chrome went, and the top of the document with it.
       */
      data-chrome
      className="sticky top-0 z-40 border-b border-line bg-ink/95 backdrop-blur-sm"
    >
      <div className="container-page flex h-16 items-center justify-between gap-3">
        <Link
          href={localeHome(locale)}
          className="flex min-h-11 min-w-0 shrink items-baseline gap-2 self-center"
          aria-label={t('nav.homeLabel', { wordmark: company.wordmark })}
        >
          <span className="font-display text-lead tracking-[0.18em] text-chalk">
            {company.wordmark}
          </span>
        </Link>

        <nav className="hidden lg:flex lg:items-center lg:gap-1" aria-label={t('nav.mainLabel')}>
          <Link href={catalog} className={navClass(catalog)}>
            {t('nav.products')}
          </Link>
          <Link href={about} className={navClass(about)}>
            {t('nav.about')}
          </Link>
        </nav>

        <div className="flex min-w-0 items-center gap-2">
          <LanguagePicker />

          {/*
            ⭐ The door to an account, in the one place a customer will look.

            ⚠️ Its label changes with the session, and both halves matter. Signed out it says
            "เข้าสู่ระบบ", because a customer who submitted from another device has no other way
            back. Signed in it says "ใบเสนอราคาของฉัน", because by then the question is not how
            to get in but where the quotations are — and the answer used to be "inside the cart",
            which is empty for exactly the people who need it.

            ⚠️ It renders nothing while the session is `checking`. Showing "sign in" and swapping
            it a moment later flashes the wrong label at somebody who is already signed in, and
            on a prerendered page it is a hydration mismatch — the server does not know either.
          */}
          <AccountLink />

          <Link
            href={quoteHref(locale)}
            className="relative inline-flex min-h-11 shrink-0 items-center gap-2 rounded-xs border border-line px-3 text-body text-chalk transition-colors duration-180 ease-out hover:border-line-2"
          >
            <ClipboardList size={18} aria-hidden />
            <span className="hidden md:inline">{t('nav.quote')}</span>
            {quoteCount > 0 ? (
              <span className="numeric inline-flex min-w-5.5 items-center justify-center rounded-full bg-sel-bg px-1.5 py-px text-caption text-chalk">
                {/* Through the formatter like every other number on the site: a badge
                    reading `၃` in Burmese and `3` in German is the same three. */}
                {f.integer(quoteCount)}
              </span>
            ) : null}
            <span className="sr-only">
              {quoteCount > 0
                ? t('quote.badge.filled', { count: quoteCount })
                : t('quote.badge.empty')}
            </span>
          </Link>
        </div>
      </div>
    </header>
  );
}
