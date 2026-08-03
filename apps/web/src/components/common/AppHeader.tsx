import { NavLink, Link } from 'react-router-dom';
import { ClipboardList } from 'lucide-react';
import { useQuote } from '../../state/useQuote';
import { company } from '../../data/company';

const navLinkClass = ({ isActive }: { isActive: boolean }): string =>
  `inline-flex min-h-11 items-center px-3 text-body transition-colors duration-180 ease-out ${
    isActive ? 'text-chalk' : 'text-chalk-2 hover:text-chalk'
  }`;

/**
 * Spec section 8: no hamburger on mobile. There are two nav links; hiding two items
 * behind a menu adds a tap to reach either one and saves nothing worth saving.
 * On mobile the nav simply drops and the two entry points live on the page itself.
 */
export function AppHeader() {
  // Pieces rather than rows: three windows on one line reads as 3, which is what
  // the customer counts.
  const { itemCount: quoteCount } = useQuote();

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-ink/95 backdrop-blur-sm">
      <div className="container-page flex h-16 items-center justify-between gap-4">
        <Link
          to="/"
          className="flex min-h-11 min-w-0 shrink items-baseline gap-2 self-center"
          aria-label={`${company.wordmark} หน้าหลัก`}
        >
          <span className="font-display text-lead tracking-[0.18em] text-chalk">
            {company.wordmark}
          </span>
        </Link>

        <nav className="hidden lg:flex lg:items-center lg:gap-1" aria-label="เมนูหลัก">
          <NavLink to="/products" className={navLinkClass}>
            สินค้า
          </NavLink>
          <NavLink to="/about" className={navLinkClass}>
            เกี่ยวกับเรา
          </NavLink>
        </nav>

        <Link
          to="/quote"
          className="relative inline-flex min-h-11 items-center gap-2 rounded-xs border border-line px-3 text-body text-chalk transition-colors duration-180 ease-out hover:border-line-2"
        >
          <ClipboardList size={18} aria-hidden />
          <span className="hidden md:inline">ตะกร้า</span>
          {quoteCount > 0 ? (
            <span className="numeric inline-flex min-w-5.5 items-center justify-center rounded-full bg-sel-bg px-1.5 py-px text-caption text-chalk">
              {quoteCount}
            </span>
          ) : null}
          <span className="sr-only">
            {quoteCount > 0 ? `มี ${quoteCount} รายการในตะกร้า` : 'ตะกร้าว่าง'}
          </span>
        </Link>
      </div>
    </header>
  );
}
