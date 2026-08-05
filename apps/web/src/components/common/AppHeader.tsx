import { NavLink, Link } from 'react-router-dom';
import { ClipboardList } from 'lucide-react';
import { useQuote } from '../../state/useQuote';
import { useLocale } from '../../state/localeContext';
import { company } from '../../data/company';
import { LanguagePicker } from './LanguagePicker';

const navLinkClass = ({ isActive }: { isActive: boolean }): string =>
  `inline-flex min-h-11 items-center px-3 text-body transition-colors duration-180 ease-out ${
    isActive ? 'text-chalk' : 'text-chalk-2 hover:text-chalk'
  }`;

/**
 * Spec section 8: no hamburger on mobile. There are two nav links; hiding two items
 * behind a menu adds a tap to reach either one and saves nothing worth saving.
 * On mobile the nav simply drops and the two entry points live on the page itself.
 *
 * The language picker lives here because the language governs the whole document —
 * every route, the footer, the 404 page — where the unit picker governs three fields
 * and therefore sits with them. At 360px it is an icon and a 44px select beside the
 * cart; the wordmark shrinks before either of them does.
 */
export function AppHeader() {
  // Pieces rather than rows: three windows on one line reads as 3, which is what
  // the customer counts.
  const { itemCount: quoteCount } = useQuote();
  const { t, f } = useLocale();

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-ink/95 backdrop-blur-sm">
      <div className="container-page flex h-16 items-center justify-between gap-3">
        <Link
          to="/"
          className="flex min-h-11 min-w-0 shrink items-baseline gap-2 self-center"
          aria-label={t('nav.homeLabel', { wordmark: company.wordmark })}
        >
          <span className="font-display text-lead tracking-[0.18em] text-chalk">
            {company.wordmark}
          </span>
        </Link>

        <nav className="hidden lg:flex lg:items-center lg:gap-1" aria-label={t('nav.mainLabel')}>
          <NavLink to="/products" className={navLinkClass}>
            {t('nav.products')}
          </NavLink>
          <NavLink to="/about" className={navLinkClass}>
            {t('nav.about')}
          </NavLink>
        </nav>

        <div className="flex min-w-0 items-center gap-2">
          <LanguagePicker />

          <Link
            to="/quote"
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
