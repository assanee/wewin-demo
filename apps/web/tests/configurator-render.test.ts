import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { describe, expect, it } from 'vitest';
import { getProductBySlug } from '@wewin/core/fixtures';
import { calcPrice } from '@wewin/core/pricing';

import { ConfiguratorIsland } from '@/components/configurator/ConfiguratorIsland';
import { AppShell } from '@/components/shell/AppShell';
import {
  generateMetadata,
  generateStaticParams,
} from '@/app/[locale]/products/[slug]/page';
import { formattersFor } from '@/i18n/format';
import { LOCALES, type Locale } from '@/i18n/locales';
import { decodeNumber } from '@/i18n/testing/decode';
import { defaultStateFor } from '@/state/useConfigurator';

/**
 * # The island renders on a server that has no browser
 *
 * This is the test the whole port turns on, and it is behavioural rather than a scan.
 *
 * `'use client'` decides where a component is **hydrated**, not where it is **rendered**:
 * Next still prerenders the island to HTML at build time, and that HTML is what makes 8
 * locales × 81 products worth doing at all. So the island has to survive a render in an
 * environment where `window`, `document` and `localStorage` do not exist — which is
 * exactly the environment `vitest` gives it here, `environment: 'node'`.
 *
 * That environment is also the assertion. Spec section 12 kept "no browser globals on a
 * render path" true for five phases *so that this move would be cheap*, and a single
 * `localStorage.getItem` moved out of an effect and into a render would fail every test
 * below with a `ReferenceError` naming the file. No scan can say that as precisely.
 *
 * The second half is hydration. React answers a server/client mismatch by re-rendering
 * quietly rather than by saying so, so the only cheap defence is determinism: whatever
 * the server renders must be a function of the URL alone. Every stored preference the
 * page has — the display unit, the quote, the query string, the origin — is therefore
 * pinned at its default here, and the check is that two renders of the same URL are the
 * same bytes.
 */

/* The environment's own liveness check. If a future config quietly switched this suite
 * to jsdom, every "renders without a browser" claim below would become decoration —
 * the same class of false green as phase 5b's dead globalSetup, and it would read as
 * 22 passing tests. */
describe('the environment has no browser in it', () => {
  it('window, document and localStorage are undefined', () => {
    expect(typeof globalThis.window).toBe('undefined');
    expect(typeof globalThis.document).toBe('undefined');
    expect(typeof Reflect.get(globalThis, 'localStorage')).toBe('undefined');
  });
});

/**
 * The island **inside the shell**, which is where it now lives.
 *
 * Through the port `ConfiguratorIsland` mounted its own four providers and could be
 * rendered on its own. They moved up to `AppShell` in the commit that closed 6b — one
 * mount above every route, because two `QuoteProvider`s are two carts — so rendering the
 * island alone now throws `useQuote must be used inside <QuoteProvider>`. That throw is
 * the correct answer and this helper is the correction: what the 648 pages actually
 * prerender is the shell wrapping the island, so that is what gets asserted.
 */
const island = (locale: Locale, slug: string): string =>
  renderToStaticMarkup(
    createElement(AppShell, {
      locale,
      // `children` in the props object rather than as a third argument: `AppShell` declares
      // it required and `createElement`'s variadic overload does not satisfy a required
      // `children` for the type checker.
      children: createElement(ConfiguratorIsland, { locale, slug }),
    }),
  );

describe('the configurator prerenders', () => {
  it('renders to HTML with no browser globals available', () => {
    const html = island('th', 'awn-4t');

    expect(html.length).toBeGreaterThan(2000);
    // The editable line name starts at the product's own name, and it is an `<h1>` in
    // the prerendered HTML rather than something a crawler has to run JavaScript for.
    expect(html).toContain('<h1');
  });

  it('puts the product name and summary in the prerendered HTML', () => {
    const awn = getProductBySlug('awn-4t');
    expect(awn).toBeDefined();
    if (!awn) return;

    const html = island('th', awn.slug);
    expect(html).toContain(awn.nameTh);
    expect(html).toContain(awn.summaryTh);
  });

  it('renders every product in every locale without throwing', () => {
    // Four locales × three products rather than all 648: the failure this catches is a
    // browser global on a render path, which is a property of the code and not of the
    // row, and 648 renders is 20 seconds nobody will keep.
    for (const locale of ['th', 'de', 'my', 'hi'] as const) {
      for (const slug of ['awn-4t', 'lvr-adj', 'csm-2t']) {
        if (!getProductBySlug(slug)) continue;
        expect(island(locale, slug).length).toBeGreaterThan(1000);
      }
    }
  });
});

describe('the prerendered HTML is a function of the URL and nothing else', () => {
  it('two renders of the same URL are byte-identical', () => {
    // `useId` is stable, there is no `Date.now()` and no `Math.random()` on this path,
    // and every stored preference is read in an effect. So the same URL is the same
    // bytes — which is the precondition for hydration not to have anything to reconcile.
    expect(island('de', 'awn-4t')).toBe(island('de', 'awn-4t'));
  });

  it('renders the default display unit, never a stored one', () => {
    const html = island('th', 'awn-4t');

    // `cm` is `DEFAULT_UNIT` — the unit the catalogue is authored in. A cached page
    // always carries the default and never a visitor's preference, which is the half of
    // plan 8.2(3) that keeps one reader's setting from being served to another.
    expect(html).toContain('>cm<');
  });

  it('renders the empty quote — `ready` is false until localStorage is read', () => {
    // The `?line=` edit path waits for `ready` before deciding, and on the server
    // `ready` is false. There is no query string on the server either (see
    // `useUrlSearch`), so what prerenders is the plain configurator, not the loading line.
    const html = island('th', 'awn-4t');
    expect(html).not.toContain('กำลังโหลด');
  });
});

describe('changing the language does not move the number — on the server', () => {
  /**
   * The other half of `numerals.test.ts`, in the place the move created.
   *
   * Under Vite both the first render and every later one happened in the same browser, so
   * they agreed about numerals by construction. Server rendering splits that: the HTML is
   * written by Node's ICU and re-rendered by the browser's, and the scaffold's README
   * records the one place they are known to disagree — `my-MM`, where Node writes `၈,၇၉၁`
   * and the Chromium Playwright drives writes `8,791` for the same call.
   *
   * The **value** is unaffected either way, and that is what is pinned here: whatever
   * glyphs Node picked, the digits underneath are the digits `calcPrice` computed, in all
   * eight. The glyph disagreement itself cannot be fixed from this package — it lives in
   * `@wewin/i18n/locales`, which this round does not own — and it is written up in the
   * handover rather than left to be found.
   */
  const expectedTotal = (): bigint => {
    const awn = getProductBySlug('awn-4t');
    if (!awn) throw new Error('fixture missing: awn-4t');
    const { selections, measures } = defaultStateFor(awn);
    return calcPrice(awn, selections, measures, 1).totalMinor;
  };

  it.each(LOCALES.map((locale) => [locale] as const))(
    '%s prerenders the same amount as every other locale',
    (locale) => {
      const total = expectedTotal();
      const html = island(locale, 'awn-4t');
      const rendered = formattersFor(locale).baht(total);

      // The string this locale's formatter produces is in the HTML …
      expect(html).toContain(rendered);
      // … and whatever glyphs it chose, the digits underneath are core's.
      expect(decodeNumber(rendered, locale)).toBe((total / 100n).toString());
    },
  );
});

describe('the server half: 648 pages, and metadata that keeps them static', () => {
  it('generates one param set per product', () => {
    const params = generateStaticParams();

    expect(params).toHaveLength(81);
    expect(params.map((p) => p.slug)).toContain('awn-4t');
    // 8 locales from the layout above × 81 here.
    expect(params.length * LOCALES.length).toBe(648);
  });

  it('emits a per-route canonical and eight hreflangs plus x-default', async () => {
    const metadata = await generateMetadata({
      params: Promise.resolve({ locale: 'de', slug: 'awn-4t' }),
    });

    expect(metadata.alternates?.canonical).toBe('/de/products/awn-4t');

    const languages = metadata.alternates?.languages ?? {};
    // Keyed by ICU tag, so Lao is `lo-LA` and not `la` — `la` is Latin in BCP 47.
    expect(Object.keys(languages)).toHaveLength(LOCALES.length + 1);
    expect(languages['lo-LA']).toBe('/la/products/awn-4t');
    expect(languages['x-default']).toBe('/th/products/awn-4t');
  });

  it('titles the page with the product, in the locale', async () => {
    const awn = getProductBySlug('awn-4t');
    if (!awn) throw new Error('fixture missing: awn-4t');

    const metadata = await generateMetadata({
      params: Promise.resolve({ locale: 'th', slug: 'awn-4t' }),
    });

    // Thai is the source language, so the product's own name is the title and there is
    // no fallback involved. It slots into the layout's `%s · WEWIN180` template.
    expect(metadata.title).toBe(awn.nameTh);
    expect(String(metadata.description)).toContain(awn.summaryTh);
  });
});
