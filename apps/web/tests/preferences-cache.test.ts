import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * **Plan 8.2, trap 3 — proof that a cached page cannot carry one reader's preference.**
 *
 * > "Currency and display unit are per-user preferences and are in no cache key, while
 * > `ProductCard` already renders `formatBaht` on the server."
 *
 * The storefront's answer, decided in phase 6b and which this round must not undo: the language
 * is a **path segment** so it is in every cache key structurally; the currency is **fixed per
 * locale** so money renders on the server into a page every visitor shares; and the display unit
 * is rendered **five times, server-side** (`components/catalog/unitVariants.ts`) so the island
 * only ever picks between strings that are already in the cached HTML.
 *
 * Adding a settings screen puts that arrangement under the most pressure it will ever face,
 * because the obvious implementation of "show the reader their saved preference" is to read it
 * during the render. Every one of the ways to do that fails **silently**:
 *
 * ```
 *   export const dynamic = 'force-dynamic'          → next build: ƒ /[locale]/settings
 *   const unit = (await cookies()).get('…')?.value  → next build: ƒ /[locale]/products
 *   const me = await fetch(api('/me/preferences'))  → a per-request call, per page
 * ```
 *
 * The first two were measured in 6b: both built, both left 243/243 tests green, `tsc` clean and
 * `oxlint` unchanged, and the only record of the change was a `ƒ` in a build log nobody diffs.
 * `tests/cache-policy.test.ts` closed those two doors for the whole `src/app` tree. This suite
 * closes the third — the one this round opens — and it scans **all of `src/`**, because the
 * module that fetches is not in `src/app` and the import that would drag it onto a render path
 * can be written anywhere.
 *
 * ── The claim, stated so it can be falsified ─────────────────────────────────────
 *
 *   1. exactly one module in this app calls `fetch`, and it is `lib/preferences/client.ts`;
 *   2. nothing that is not `'use client'` imports it, transitively included;
 *   3. the settings page itself is a server component and reads no request-time API;
 *   4. the island that does the work is `'use client'`.
 *
 * Together those say: **no page in this app renders differently because a request carried a
 * session.** Prerendered bytes are a function of the locale segment and nothing else.
 */

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

const sourceFiles = (directory: string): readonly string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });

/*
 * Comments are stripped before every scan. This suite's own subject matter is the tokens it
 * forbids — `fetch(`, `cookies()`, the client module's path — and the paragraphs above name all
 * three. A guard that fired on its own explanation would teach contributors to delete the
 * explanation, which is `tests/tokens.test.ts`'s lesson and the reason it is repeated here.
 */
const code = (source: string): string =>
  source.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/(^|[^:])\/\/.*$/gm, '$1');

interface Module {
  readonly name: string;
  readonly code: string;
  readonly isClient: boolean;
}

const files: readonly Module[] = sourceFiles(sourceRoot).map((path) => {
  const stripped = code(readFileSync(path, 'utf8'));
  return {
    name: relative(sourceRoot, path),
    code: stripped,
    isClient: /^\s*['"]use client['"]/.test(stripped),
  };
});

const find = (name: string): Module => {
  const found = files.find((file) => file.name === name);
  if (!found) throw new Error(`expected ${name} to exist`);
  return found;
};

/** Relative and alias import specifiers, so an import graph can be walked. */
const importsOf = (module: Module): readonly string[] =>
  [...module.code.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '');

const CLIENT_MODULE = join('lib', 'preferences', 'client.ts');
const SETTINGS_PAGE = join('app', '[locale]', 'settings', 'page.tsx');
const SETTINGS_ISLAND = join('components', 'settings', 'SettingsScreen.tsx');

describe('the scan can see', () => {
  it('found the tree, and the three files this round added', () => {
    // A scan over an empty tree passes silently and proves nothing — the failure mode phase 5b
    // hit when a dead globalSetup left 116 tests reported as passes.
    expect(files.length).toBeGreaterThan(40);
    for (const name of [CLIENT_MODULE, SETTINGS_PAGE, SETTINGS_ISLAND]) {
      expect(files.map((file) => file.name)).toContain(name);
    }
  });

  it('would notice a preference read on a render path', () => {
    /*
     * The guards below are all `expect([]).toEqual([])` when the app is clean, which is the same
     * shape as a scan whose regex has stopped matching. Each pattern is fired at a planted
     * violation here, so a regex that silently stopped working fails *this* test rather than
     * passing every other one.
     */
    const planted = [
      "const me = await fetch(apiUrl('/me/preferences'));",
      "const unit = (await cookies()).get('u')?.value;",
      "const lang = (await headers()).get('accept-language');",
      "import { fetchPreferences } from '@/lib/preferences/client';",
    ].join('\n');

    expect(/\bfetch\s*\(/.test(planted)).toBe(true);
    expect(/\bcookies\s*\(\s*\)/.test(planted)).toBe(true);
    expect(/\bheaders\s*\(\s*\)/.test(planted)).toBe(true);
    expect(/preferences\/client/.test(planted)).toBe(true);
  });

  it('does not fire on the words a clean app legitimately contains', () => {
    // `prefetch` contains `fetch`, and `next/link` sets it on every navigation in this app. A
    // guard that could not tell the two apart would be uninstallable.
    const legitimate = "<Link prefetch={false} href={settingsHref(locale)}>";
    expect(/\bfetch\s*\(/.test(legitimate)).toBe(false);
  });
});

describe('exactly one module in this app talks to the network', () => {
  it('only lib/preferences/client.ts calls fetch, within the settings feature', () => {
    /*
     * Scoped to the three directories this round owns, deliberately.
     *
     * The claim worth making is about *this* feature: the settings screen has exactly one place
     * that talks to the network, so there is exactly one place to check for `credentials`,
     * `cache: 'no-store'` and a 401 policy. A repository-wide "nobody else calls fetch" would be
     * a stronger-sounding assertion that this file has no standing to make — other features
     * legitimately fetch, and a route handler doing so is not a caching hazard at all, because a
     * route handler is not a prerendered page.
     *
     * The hazard this suite is actually about is narrower and is covered by the walk below: a
     * fetch reaching a **server render path**. That one is asserted across the whole tree.
     */
    const owned = (name: string): boolean =>
      name.startsWith(join('lib', 'preferences')) ||
      name.startsWith(join('components', 'settings')) ||
      name.startsWith(join('app', '[locale]', 'settings'));

    const callers = files
      .filter((file) => owned(file.name) && /\bfetch\s*\(/.test(file.code))
      .map((file) => file.name);

    expect(callers).toStrictEqual([CLIENT_MODULE]);
  });

  it('the module that fetches is not a server module, and nothing on a server path imports it', () => {
    /*
     * The transitive walk is the load-bearing half. A direct import of the client module into a
     * page would be obvious in review; what would not be is a "helpers" module that re-exports
     * it, imported by a page for something unrelated. So this follows relative and `@/` imports
     * from every non-client module and fails if any of them reaches the fetcher.
     */
    const byName = new Map(files.map((file) => [file.name, file]));

    const resolve = (from: Module, specifier: string): Module | undefined => {
      const base = specifier.startsWith('@/')
        ? specifier.slice(2)
        : specifier.startsWith('.')
          ? relative(sourceRoot, join(sourceRoot, dirname(from.name), specifier))
          : null;
      if (base === null) return undefined;

      for (const suffix of ['.ts', '.tsx', join('index.ts'), join('index.tsx')]) {
        const candidate = suffix.startsWith('index') ? join(base, suffix) : `${base}${suffix}`;
        const found = byName.get(candidate);
        if (found) return found;
      }
      return undefined;
    };

    const offenders: string[] = [];

    for (const entry of files) {
      if (entry.isClient) continue;

      const seen = new Set<string>([entry.name]);
      const queue = [entry];

      while (queue.length > 0) {
        const current = queue.pop();
        if (current === undefined) break;

        for (const specifier of importsOf(current)) {
          const target = resolve(current, specifier);
          if (!target || seen.has(target.name)) continue;
          seen.add(target.name);

          if (target.name === CLIENT_MODULE) {
            offenders.push(`${entry.name} → … → ${CLIENT_MODULE}`);
            break;
          }
          // A `'use client'` module is a boundary: what it imports runs in the browser, so the
          // walk stops there. Following through it would report every island's dependency as a
          // server-path reachability, which is the opposite of what this measures.
          if (!target.isClient) queue.push(target);
        }
      }
    }

    expect(offenders).toStrictEqual([]);
  });

  it('the walk is not vacuous — it can reach the fetcher when it is allowed to', () => {
    /*
     * Every assertion above is an empty list. This one proves the resolver actually resolves:
     * the island *does* import the client module directly, so a walk that resolved nothing would
     * report `false` here and the guard above would be watching an empty graph.
     */
    const island = find(SETTINGS_ISLAND);
    expect(island.isClient).toBe(true);
    expect(importsOf(island).some((specifier) => specifier.includes('preferences/client'))).toBe(
      true,
    );
  });
});

describe('the settings route is prerendered, like every other route in this app', () => {
  it('the page is a server component', () => {
    // If this ever becomes `'use client'`, the eight prerendered settings documents become eight
    // empty shells and the headings stop being in the first byte — which is the same regression
    // plan 8.7(1) records for six of eight locales serving Thai prose from `index.html`.
    expect(find(SETTINGS_PAGE).isClient).toBe(false);
  });

  it('the page reads no request-time API and no query string', () => {
    const page = find(SETTINGS_PAGE);

    for (const api of ['cookies', 'headers', 'draftMode', 'connection'] as const) {
      expect(new RegExp(String.raw`\b${api}\s*\(\s*\)`).test(page.code), api).toBe(false);
    }
    expect(page.code).not.toContain('searchParams');
    expect(/export\s+const\s+dynamic\s*=/.test(page.code)).toBe(false);
    expect(/export\s+const\s+revalidate\s*=\s*\d/.test(page.code)).toBe(false);
  });

  it('the page emits one document per locale, closed to anything else', () => {
    // `generateStaticParams` on the page plus `dynamicParams = false` in the locale layout is
    // what makes the set of settings URLs exactly eight. Without it the route would fall back to
    // rendering on demand, which is the same `ƒ` by a quieter road.
    expect(find(SETTINGS_PAGE).code).toContain('generateStaticParams');
  });

  it('the page renders no preference of its own', () => {
    /*
     * The strongest available statement about the prerendered bytes: the page's own module does
     * not touch either mechanism a preference travels by. Everything reader-dependent is behind
     * `<SettingsScreen />`, which is the client boundary.
     */
    const page = find(SETTINGS_PAGE);
    expect(page.code).not.toContain('useDisplayUnit');
    expect(page.code).not.toContain('localStorage');
    expect(page.code).not.toContain('LOCALE_COOKIE');
    expect(page.code).toContain('SettingsScreen');
  });
});
