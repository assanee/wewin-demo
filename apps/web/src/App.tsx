import { Route, Routes } from 'react-router-dom';
import { QuoteProvider } from './state/QuoteContext';
import { DisplayUnitProvider } from './state/useDisplayUnit';
import { LocaleProvider } from './state/useLocale';
import { useLocale } from './state/localeContext';
import { ToastProvider } from './components/common/Toast';
import { AppHeader } from './components/common/AppHeader';
import { AppFooter } from './components/common/AppFooter';
import { Home } from './pages/Home';
import { Catalog } from './pages/Catalog';
import { Configure } from './pages/Configure';
import { Quote } from './pages/Quote';
import { About } from './pages/About';
import { NotFound } from './pages/NotFound';

export function App() {
  return (
    // Two providers, one argument. The display unit follows the customer from the
    // catalogue to the configurator to the quote, and so does the language; choosing
    // either is a way of *reading* — a size in inches, a heading in German — and never
    // an edit. Both therefore sit above the routes and outside the configurator's undo
    // history rather than in its state, so Ctrl+Z can never take one back.
    //
    // Locale is outermost because everything below it, the unit picker's own labels
    // included, reads its words from there.
    <LocaleProvider>
      <DisplayUnitProvider>
        <QuoteProvider>
          <ToastProvider>
            {/* Subtract the sticky bar's reservation from the full-height shell. A plain
                min-h-dvh is measured against the viewport and ignores the body padding,
                so on a short page the footer gets pushed to the viewport bottom and
                lands underneath the bar even though the space below it was reserved. */}
            <div className="flex min-h-[calc(100dvh-var(--sticky-bar-height,0px))] flex-col">
              <SkipLink />

              <AppHeader />

              <div id="main" className="flex-1">
                <Routes>
                  <Route path="/" element={<Home />} />
                  <Route path="/products" element={<Catalog />} />
                  <Route path="/products/:slug" element={<Configure />} />
                  <Route path="/quote" element={<Quote />} />
                  <Route path="/about" element={<About />} />
                  <Route path="*" element={<NotFound />} />
                </Routes>
              </div>

              <AppFooter />
            </div>
          </ToastProvider>
        </QuoteProvider>
      </DisplayUnitProvider>
    </LocaleProvider>
  );
}

/**
 * Its own component only because it needs the locale, and the locale comes from a
 * provider `App` itself renders — a hook call in `App` would be reading the context
 * from outside it.
 */
function SkipLink() {
  const { t } = useLocale();

  return (
    <a
      href="#main"
      className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:border focus:border-sel-line focus:bg-panel focus:px-4 focus:py-2 focus:text-body"
    >
      {t('a11y.skipToContent')}
    </a>
  );
}
