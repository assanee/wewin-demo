import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { products } from '@wewin/core/fixtures';
import { LOCALES, INTL_TAG, SOURCE_LOCALE, type Locale } from '@wewin/i18n/locales';

import { decodeNumber } from '@/i18n/testing/decode';
import { localeBundle } from '@/i18n/server';
import { unitVariants } from '@/components/catalog/unitVariants';
import {
  aboutHref,
  catalogCategoryHref,
  catalogHref,
  languageAlternates,
} from '@/lib/routing';

/**
 * The three routes this round ports — home, catalogue and about — and the three properties
 * that make them worth having ported.
 *
 * The pages themselves are `.tsx` server components that `await params` and call
 * `notFound()`; rendering one outside Next proves nothing about how Next renders it. So
 * what is checked here is what a scan and a pure call *can* prove, and it is deliberately
 * the set of things whose failure is **silent**:
 *
 *   1. a route quietly stopped being prerenderable (plan 8.2 trap 2, through either door);
 *   2. a per-user preference reached a server render path (plan 8.2 trap 3);
 *   3. a locale's page stopped saying which locale it is (plan 8.7(1) and 8.7(2)).
 *
 * None of the three breaks a build, and none of them looks wrong on the screen of whoever
 * introduced it — which is the whole argument for asserting them at all.
 */

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

const sourceFiles = (directory: string): readonly string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });

/** Comments stripped, for the same reason `cache-policy.test.ts` strips them. */
const code = (source: string): string =>
  source.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/(^|[^:])\/\/.*$/gm, '$1');

const files = sourceFiles(appRoot).map((path) => ({
  name: relative(appRoot, path),
  source: readFileSync(path, 'utf8'),
}));

const isClient = (source: string): boolean => /^\s*['"]use client['"]/.test(code(source));

const sourceOf = (name: string): string =>
  files.find((candidate) => candidate.name === name)?.source ?? '';

/**
 * Where a `from '…'` in this app's own source actually points, or `null` for a package.
 *
 * `@/` is the tsconfig alias for `src/`; everything else that starts with a dot is
 * relative. Package specifiers are the stopping condition — a scan that followed
 * `@wewin/core` would walk into compiled `dist` and learn nothing about this app.
 */
const resolveLocal = (fromFile: string, specifier: string): string | null => {
  const base = specifier.startsWith('@/')
    ? join(appRoot, specifier.slice(2))
    : specifier.startsWith('.')
      ? resolve(dirname(join(appRoot, fromFile)), specifier)
      : null;
  if (base === null) return null;

  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ]) {
    if (existsSync(candidate)) return relative(appRoot, candidate);
  }
  return null;
};

const importsOf = (name: string): readonly string[] =>
  [...code(sourceOf(name)).matchAll(/from\s+['"]([^'"]+)['"]/g)]
    .map((match) => resolveLocal(name, match[1] ?? ''))
    .filter((path): path is string => path !== null);

/**
 * Every module React executes **on the server** when a route renders.
 *
 * A breadth-first walk from every non-client file under `src/app`, stopping at each
 * `'use client'` — which is exactly what the directive means. That boundary is the whole
 * point of doing it this way rather than scanning every file in the tree: a module that
 * uses a hook without the directive is perfectly legal as long as only client modules
 * import it, so "does this file call a hook" is the wrong question. "Can a server render
 * reach this file" is the right one, and it is the one plan 8.2's third trap is about.
 */
const serverReachable = (): ReadonlySet<string> => {
  const seen = new Set<string>();
  const queue = files
    .filter(({ name }) => name.startsWith(`app${'/'}`) || name.startsWith(join('app', '')))
    .filter(({ source }) => !isClient(source))
    .map(({ name }) => name);

  while (queue.length > 0) {
    const name = queue.shift();
    if (name === undefined || seen.has(name)) continue;
    seen.add(name);
    for (const next of importsOf(name)) {
      if (seen.has(next)) continue;
      if (isClient(sourceOf(next))) continue;
      queue.push(next);
    }
  }

  return seen;
};

const ROUTES = [
  join('app', '[locale]', 'page.tsx'),
  join('app', '[locale]', 'products', 'page.tsx'),
  join('app', '[locale]', 'about', 'page.tsx'),
] as const;

describe('the three routes exist and are prerendered per locale', () => {
  it.each(ROUTES)('%s enumerates the eight locales', (route) => {
    const file = files.find((candidate) => candidate.name === route);
    expect(file, `${route} is missing`).toBeDefined();
    // Without `generateStaticParams` a route under a `dynamicParams = false` layout has an
    // empty param set and is not built at all — every locale 404s, and the build says
    // nothing, because "no params" is a legal answer.
    expect(code(file?.source ?? '')).toMatch(/export\s+const\s+generateStaticParams\s*=/);
  });

  it.each(ROUTES)('%s is a server component', (route) => {
    const file = files.find((candidate) => candidate.name === route);
    // A `'use client'` at the top of any of these turns 648 prerendered documents into 648
    // empty shells that fetch their own content — the exact thing the move was made to
    // stop, and a one-line change that nothing else would complain about.
    expect(isClient(file?.source ?? '')).toBe(false);
  });

  it.each(ROUTES)('%s reads params and never searchParams', (route) => {
    const file = files.find((candidate) => candidate.name === route);
    const stripped = code(file?.source ?? '');

    /*
     * `cache-policy.test.ts` guards `generateMetadata`, which is where plan 8.2 writes the
     * trap down. This is the same trap through the other door: `searchParams` on the *page*
     * signature opts the route out of static rendering just as silently, and on the
     * catalogue it is the more tempting of the two — filtering on the server is the obvious
     * way to write that page.
     *
     * The facet still works. `CatalogBrowser` reads it in the browser after mount, which is
     * where a facet selection has lived since phase 2.
     */
    expect(stripped).not.toContain('searchParams');
    expect(stripped).toContain('params');
  });
});

describe('plan 8.2 trap 3 — a visitor’s preference must not reach a cached page', () => {
  it('the display unit is read only inside client modules', () => {
    /*
     * The failure is not a crash, it is a *correct-looking* page: whichever unit the first
     * reader through the CDN had is baked into the HTML everyone behind them receives. The
     * numbers are all right; they answer a question the second reader never asked.
     *
     * So the rule is mechanical — the context that holds the preference may only be read
     * from a module that runs in the browser. A server component that imported it would
     * either throw (no provider) or, worse, resolve to the default and look fine.
     */
    const reachable = serverReachable();
    const offenders = [...reachable]
      // `state/displayUnitContext.ts` *declares* the hook. Declaring it is not reading it,
      // and a scan that could not tell the two apart would have exactly one way to go
      // green: delete the exclusion, or delete the module the whole mechanism lives in.
      .filter((name) => !name.endsWith(join('state', 'displayUnitContext.ts')))
      .filter((name) => /useDisplayUnit\s*\(/.test(code(sourceOf(name))))
      .sort();

    expect(offenders).toEqual([]);
  });

  it('the reachability walk reaches the server tree and stops at the islands', () => {
    /*
     * The scan above is only as good as this walk, so the walk is asserted rather than
     * trusted. It has to arrive at the card (a server component two hops from the route)
     * and it has to *stop* at the island — a walk that crossed `'use client'` would flag
     * every legitimate hook in the app and be deleted within the day.
     */
    const reachable = serverReachable();

    expect(reachable.has(join('app', '[locale]', 'products', 'page.tsx'))).toBe(true);
    expect(reachable.has(join('components', 'catalog', 'ProductCard.tsx'))).toBe(true);
    expect(reachable.has(join('i18n', 'server.ts'))).toBe(true);

    expect(reachable.has(join('components', 'catalog', 'CatalogBrowser.tsx'))).toBe(false);
    expect(reachable.has(join('components', 'catalog', 'UnitText.tsx'))).toBe(false);
    expect(reachable.has(join('components', 'catalog', 'ProductSchematic.tsx'))).toBe(false);
  });

  it('every measurement on a card is rendered on the server, in all five units', () => {
    // The other half of the same property, as a value rather than a scan. One `bigint`
    // pair in, five strings out, all produced by this runtime — so the cached HTML carries
    // every answer and the island only ever indexes into it. Nothing formats in the
    // browser, which is also why the `my` numeral split cannot become a hydration mismatch
    // here.
    const l = localeBundle('en');
    const variants = unitVariants((unit) => l.f.dimensions(3_200_000n, 1_600_000n, unit));

    expect(Object.keys(variants).sort()).toEqual(['cm', 'ft', 'in', 'm', 'mm']);
    expect(variants.cm).toContain('320');
    expect(variants.mm).toContain('3200');
    // Five renderings of one size, and no two units agree — which is what makes picking
    // the wrong one visible rather than plausible.
    expect(new Set(Object.values(variants)).size).toBe(5);
  });

  it('the unit a cached page carries is the catalogue’s own, not a visitor’s', () => {
    /*
     * `DisplayUnitProvider` starts at `cm` and only reads `aluform.displayUnit.v1` from a
     * mount effect, so the prerender, the hydration and every reader's first paint are the
     * same string. `cm` is also the unit the catalogue rows are authored in, which is why
     * this one is exact where the others carry `≈`.
     */
    const l = localeBundle('en');
    const variants = unitVariants((unit) => l.f.dimensions(3_200_000n, 1_600_000n, unit));

    expect(variants.cm).not.toContain('≈');
    expect(variants.in).toContain('≈');
  });
});

describe('plan 8.2 trap 3 — currency is one per locale, and it renders on the server', () => {
  it('the same amount is the same amount in all eight', () => {
    /*
     * The chosen answer to "currency is in no cache key" is that it is not a preference:
     * one currency per locale, fixed, so money renders on the server and a crawler and a
     * customer see the same price. Today all eight resolve to THB — `f.baht` is the only
     * presentation currency the storefront has — and risk 7 is why a free picker would be
     * wrong even if there were more: currency has to follow the shipping destination.
     *
     * What this pins is the property that makes that safe: the language re-spells the
     * number and cannot move it. The inverse decoder in `i18n/testing/decode.ts` is the
     * thorough version of this and it lives with the catalogue tests; this is the same
     * claim asserted where the *cache* decision was taken.
     */
    const cheapest = Math.min(...products.map((product) => product.pricePerSqm));
    const minor = BigInt(Math.round(cheapest * 100));

    // `decodeNumber` is the app's own inverse of the locale layer — it reads Myanmar,
    // Devanagari and Latin digits back to ASCII and throws away the symbol, the group
    // separators and Hindi's lakh grouping. Eight spellings in, one integer out; if any
    // locale ever moves the amount rather than re-spelling it, this is where it shows.
    const decoded = LOCALES.map((locale) =>
      decodeNumber(localeBundle(locale).f.baht(minor), locale),
    );

    expect(new Set(decoded).size).toBe(1);
    expect(decoded[0]).toBe(String(Math.round(cheapest)));
  });

  it('would notice a locale that moved the number', () => {
    // The decoder, mutation-tested where it is used: eight identical readings prove nothing
    // if the decoder collapses everything to the same string.
    expect(decodeNumber(localeBundle('my').f.baht(879_100n), 'my')).toBe('8791');
    expect(decodeNumber(localeBundle('de').f.baht(879_200n), 'de')).toBe('8792');
  });
});

describe('plan 8.7 — every route says which locale it is, and where its siblings are', () => {
  it.each(ROUTES)('%s emits a canonical and the eight hreflang links', (route) => {
    const file = files.find((candidate) => candidate.name === route);
    const stripped = code(file?.source ?? '');

    // Metadata is inherited from a layout, so a `canonical` set there would give all 81
    // product pages the home page's URL. Each route therefore owns both, and a route that
    // owns neither is one a crawler cannot tell apart from its seven translations.
    expect(stripped).toMatch(/canonical:/);
    expect(stripped).toMatch(/languages:\s*languageAlternates\(/);
  });

  it.each(['/', '/products', '/about'] as const)(
    'languageAlternates("%s") is eight ICU tags plus x-default',
    (path) => {
      const alternates = languageAlternates(path);

      expect(Object.keys(alternates)).toHaveLength(LOCALES.length + 1);
      for (const locale of LOCALES) {
        // Keyed by ICU tag and not by path segment: `hreflang="la"` would tell every
        // crawler in the world that the Lao pages are written in Latin.
        expect(alternates[INTL_TAG[locale]]).toBe(
          path === '/' ? `/${locale}` : `/${locale}${path}`,
        );
      }
      expect(alternates['x-default']).toBe(
        path === '/' ? `/${SOURCE_LOCALE}` : `/${SOURCE_LOCALE}${path}`,
      );
    },
  );

  it('every route helper carries the locale prefix', () => {
    // A helper that dropped the prefix is the failure that sends a German reader to a Thai
    // page — and it would still be a valid URL, still render, and still be wrong.
    for (const locale of LOCALES) {
      expect(catalogHref(locale)).toBe(`/${locale}/products`);
      expect(aboutHref(locale)).toBe(`/${locale}/about`);
      expect(catalogCategoryHref(locale, 'awning').pathname).toBe(`/${locale}/products`);
    }
  });

  it('the category deep link keeps the facet in the query, not in the path', () => {
    // In the query because the *page* is the same document in every facet: one canonical,
    // one prerendered file, one entry in the crawl. Making it a path segment would multiply
    // 8 catalogue pages by the number of categories and split the crawl across pages whose
    // markup is a subset of one that already exists.
    const link = catalogCategoryHref('de', 'awning');
    expect(link.query).toEqual({ category: 'awning' });
  });
});

describe('the catalogue page is the whole return on the move', () => {
  it('every product in the fixture has a card in the prerendered grid', () => {
    /*
     * The claim the phase was costed against — "8 locales × 81 products is 648 pages that
     * should be crawlable" — starts here: the catalogue lists all of them, in the first
     * response, before any filter has run. `CatalogBrowser` hides cards; it never builds
     * one, so a product missing from the HTML would have to be missing from the fixture.
     *
     * Pinned as a count so that a change to the catalogue is something somebody says out
     * loud, the way `pricing-parity` pins `correctedUp === 87`.
     */
    expect(products.length).toBe(81);
    expect(new Set(products.map((product) => product.id)).size).toBe(products.length);
  });

  it('the card grid is built on the server and only chosen from on the client', () => {
    const browser = files.find(({ name }) =>
      name.endsWith(join('components', 'catalog', 'CatalogBrowser.tsx')),
    );
    const card = files.find(({ name }) =>
      name.endsWith(join('components', 'catalog', 'ProductCard.tsx')),
    );

    expect(browser).toBeDefined();
    expect(card).toBeDefined();
    // The island is a client component; the card is not. Flip either and the 81 names
    // leave the HTML — the build still succeeds and the page still looks identical in a
    // browser, which is precisely why this is a test and not a review note.
    expect(isClient(browser?.source ?? '')).toBe(true);
    expect(isClient(card?.source ?? '')).toBe(false);
    // And the island must not be able to construct one: it receives rendered nodes.
    expect(code(browser?.source ?? '')).not.toContain('ProductCard');
  });
});

describe('the scans would notice', () => {
  it('found the files they claim to be scanning', () => {
    // A scan over an empty tree passes silently and proves nothing — phase 5b's dead
    // globalSetup, where 116 tests became skips under a green total.
    expect(files.length).toBeGreaterThanOrEqual(20);
    expect(files.filter(({ source }) => isClient(source)).length).toBeGreaterThanOrEqual(2);
    expect(files.filter(({ source }) => !isClient(source)).length).toBeGreaterThanOrEqual(10);
  });

  it('still tells a client module from a server one', () => {
    // The predicate every assertion above rests on, mutation-tested in place. If it ever
    // answered `true` for everything, the trap-3 scan would pass over a server component
    // that read the display unit and report green.
    expect(isClient("'use client';\nexport const x = 1;\n")).toBe(true);
    expect(isClient('export const x = 1;\n')).toBe(false);
    // A file that merely *mentions* the directive in prose is not a client module, and the
    // comment strip is what keeps that true.
    expect(isClient("/** talks about 'use client' */\nexport const x = 1;\n")).toBe(false);
  });

  it('still finds a display-unit read where one exists', () => {
    // The trap-3 scan's own pattern, fired at a planted offender. A regex that silently
    // stopped matching would turn that assertion into decoration.
    expect(/useDisplayUnit\s*\(/.test('const { unit } = useDisplayUnit();')).toBe(true);
    expect(/useDisplayUnit\s*\(/.test("import type { X } from './useDisplayUnit'")).toBe(false);
  });
});

describe('the token lockdown survived losing the specimen page', () => {
  it('the built-CSS check still has candidates to find', () => {
    /*
     * 🔎 **A finding, and it corrects a comment rather than confirming it.**
     *
     * This round replaced `app/[locale]/page.tsx` — the scaffold's specimen page — with the
     * ported home page. `scripts/check-tokens.mjs` warns in as many words that its
     * built-CSS half depends on that page: Tailwind emits only classes it finds in source,
     * so `.text-sm` is absent from the bundle both when the namespace is wiped and when
     * nobody has written it, and the specimen page's prose was what kept the check
     * sensitive. *"Delete the prose and that sensitivity goes with it, silently."*
     *
     * Checked by experiment rather than reasoned about, in four builds:
     *
     *   1. wipe removed, specimen page gone → six stock classes reported. Still sensitive.
     *   2. wipe removed, and a canary file added holding the spellings → same six.
     *   3. wipe removed, canary deleted again, `.next` cleared, clean build → **still the
     *      same six**. So the canary was doing nothing.
     *   4. `grep -rl text-2xl` over the app, excluding `node_modules` and `.next` → one
     *      file: `scripts/check-tokens.mjs`.
     *
     * The checker is its own canary. Tailwind's source detection scans the whole package,
     * `.mjs` included, so the list of spellings the script hunts for in the stylesheet is
     * itself the source text that makes them appear there when a namespace comes back. The
     * warning is real about the *mechanism* and wrong about *this* project — and the
     * canary file that was written to answer it has been deleted rather than kept as
     * insurance nobody can see working.
     *
     * What is left to protect is the accident that makes it true, which is what this pins:
     * if the spellings ever stop being literals in a scanned file — computed, imported from
     * JSON, moved outside the package — the built half goes quiet with no other signal.
     */
    const script = readFileSync(join(appRoot, '..', 'scripts', 'check-tokens.mjs'), 'utf8');

    for (const spelling of ['text-sm', 'text-2xl', 'bg-slate-800', 'border-zinc-700']) {
      expect(script, `check-tokens.mjs no longer names \`${spelling}\` as a literal`).toContain(
        `'${spelling}'`,
      );
    }
  });
});

describe('the locale bundle is the context, minus the thing a URL cannot be', () => {
  it('gives every locale a complete set of renderers', () => {
    for (const locale of LOCALES) {
      const l: ReturnType<typeof localeBundle> = localeBundle(locale as Locale);
      expect(l.locale).toBe(locale);
      // Never an empty string, never `undefined`, never the raw key — the three ways an
      // i18n layer fails invisibly, and the reason `translate.ts` falls through to Thai.
      expect(l.t('catalog.heading').trim().length).toBeGreaterThan(0);
      expect(l.t('meta.title').trim().length).toBeGreaterThan(0);
      expect(l.t('meta.description').trim().length).toBeGreaterThan(0);
    }
  });

  it('is memoised per locale rather than rebuilt per render', () => {
    expect(localeBundle('de')).toBe(localeBundle('de'));
    expect(localeBundle('de')).not.toBe(localeBundle('en'));
  });

  it('carries no setter, because on the server the locale is the URL', () => {
    // `LocaleContextValue` has `setLocale`; this deliberately does not. A setter here would
    // be a function that cannot do anything, offered to code that would reasonably call it —
    // changing language is a navigation, and `LocaleProvider` is where that lives.
    expect(Object.keys(localeBundle('th')).sort()).toEqual([
      'content',
      'f',
      'locale',
      'message',
      't',
      'td',
    ]);
  });
});
