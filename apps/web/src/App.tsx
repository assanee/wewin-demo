import { Route, Routes } from 'react-router-dom';
import { QuoteProvider } from './state/QuoteContext';
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
    <QuoteProvider>
      <ToastProvider>
        {/* Subtract the sticky bar's reservation from the full-height shell. A plain
            min-h-dvh is measured against the viewport and ignores the body padding,
            so on a short page the footer gets pushed to the viewport bottom and lands
            underneath the bar even though the space below it was reserved. */}
        <div className="flex min-h-[calc(100dvh-var(--sticky-bar-height,0px))] flex-col">
          <a
            href="#main"
            className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:border focus:border-sel-line focus:bg-panel focus:px-4 focus:py-2 focus:text-body"
          >
            ข้ามไปเนื้อหาหลัก
          </a>

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
  );
}
