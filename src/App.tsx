import { Route, Routes } from 'react-router-dom';
import { AppHeader } from './components/common/AppHeader';
import { Home } from './pages/Home';
import { Catalog } from './pages/Catalog';
import { Configure } from './pages/Configure';
import { Quote } from './pages/Quote';
import { About } from './pages/About';
import { NotFound } from './pages/NotFound';

export function App() {
  return (
    <div className="flex min-h-dvh flex-col">
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

      <footer className="border-t border-line py-6">
        <div className="container-page flex flex-wrap items-center justify-between gap-2">
          <p className="text-caption text-chalk-3">© พ.ศ. 2569 ALUFORM</p>
          <p className="numeric text-caption text-chalk-3">ราคายังไม่รวม VAT 7%</p>
        </div>
      </footer>
    </div>
  );
}
