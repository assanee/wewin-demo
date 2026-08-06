import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Plan 8.2's two silent traps, and the house rule that made this move cheap — all three
 * enforced by reading the source rather than by reviewing it.
 *
 * A scan is a blunt instrument and it is the right one here, because all three failures
 * share a shape: **nothing goes wrong at the point the mistake is made.** A `revalidate =
 * 3600` builds, deploys and serves; it is only wrong an hour later, on somebody else's
 * screen. A `searchParams` in `generateMetadata` turns 648 prerendered pages into 648
 * per-request renders with no warning at all. A `localStorage` read in a server component
 * throws — but only on the path that reaches it, which may be the one nobody clicked.
 *
 * These run over `src/app` because that is the tree three porting agents are about to
 * fill. The guards have to be here before the code is, or they are archaeology.
 */

const appDirectory = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'app');

const sourceFiles = (directory: string): readonly string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });

const files = sourceFiles(appDirectory).map((path) => ({
  path,
  name: relative(appDirectory, path),
  source: readFileSync(path, 'utf8'),
}));

/*
 * Comments are stripped before every scan below. Without this the guards would fire on the
 * paragraphs that explain them — and the fix a contributor would reach for is deleting the
 * explanation, which is the worst possible outcome for a rule whose reasoning is the only
 * thing keeping it alive.
 */
const code = (source: string): string =>
  source.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/(^|[^:])\/\/.*$/gm, '$1');

describe('the app tree is scannable', () => {
  it('found files to scan', () => {
    // A scan over an empty directory passes silently and proves nothing — the same failure
    // mode as the dead globalSetup in phase 5b, where a suite reported green with 116 tests
    // skipped.
    expect(files.length).toBeGreaterThanOrEqual(3);
  });
});

describe('plan 8.2 trap 1 — ISR staleness', () => {
  it('no route sets a time-based revalidate', () => {
    const offenders = files
      .filter(({ source }) => /export\s+const\s+revalidate\s*=\s*\d/.test(code(source)))
      .map(({ name }) => name);

    // `revalidate = 3600` serves an hour-old price while the API prices from live Postgres.
    // That is risk 1 — "the screen disagrees with the invoice" — reintroduced by a caching
    // decision. A shorter interval is a smaller window in which the same bug is true.
    // Pages are cached until something says they changed: `revalidateTag('product:' + id)`.
    expect(offenders).toEqual([]);
  });

  it('the locale layout states the policy rather than leaving it to the default', () => {
    const layout = files.find(({ name }) => name.endsWith(join('[locale]', 'layout.tsx')));
    expect(layout).toBeDefined();
    expect(code(layout?.source ?? '')).toMatch(/export\s+const\s+revalidate\s*=\s*false/);
  });
});

describe('plan 8.2 trap 2 — searchParams makes a route dynamic', () => {
  it('no generateMetadata reads searchParams', () => {
    const offenders = files
      .filter(({ source }) => {
        const stripped = code(source);
        const start = stripped.indexOf('generateMetadata');
        return start !== -1 && stripped.slice(start).includes('searchParams');
      })
      .map(({ name }) => name);

    // Reading searchParams in generateMetadata opts the route out of static rendering
    // silently: no prerender, no ISR, a function invocation per request, and no error to
    // say so. The configurator reads the query string in the browser, where it already
    // lives (plan 8.1).
    expect(offenders).toEqual([]);
  });
});

describe('spec section 12 — no browser globals on a render path', () => {
  it('only client components touch window, document or localStorage', () => {
    const offenders = files
      .filter(({ source }) => {
        const stripped = code(source);
        const isClient = /^\s*['"]use client['"]/.test(stripped);
        return !isClient && /\b(window|document|localStorage)\s*[.[]/.test(stripped);
      })
      .map(({ name }) => name);

    // Kept true on purpose for five phases so that this move would be cheap. A server
    // component that reads localStorage does not fail at build; it fails on the request
    // that reaches that branch.
    expect(offenders).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * The doors this guard was not watching — 🔴 found by mutation, not by reading
 * ------------------------------------------------------------------ */

/**
 * The scan above looks for the word `searchParams` because that is the word plan 8.2 used.
 * Two mutations proved the guard is narrower than the rule it is enforcing. Both were
 * applied to `[locale]/products/page.tsx`, both built, and **both left 243/243 tests
 * passing, `tsc` clean and `oxlint` unchanged**:
 *
 * ```
 *   export const dynamic = 'force-dynamic'         → next build: ƒ /[locale]/products
 *   const unit = (await cookies()).get('…')?.value → next build: ƒ /[locale]/products
 * ```
 *
 * The `ƒ` is the whole return on this phase disappearing: eight prerendered catalogue
 * pages become eight function invocations per request, and the only place it is written
 * down is a build log nobody diffs.
 *
 * The second is not hypothetical. Reading a preference cookie in a server component is
 * *precisely* what somebody reaches for when "fixing" plan 8.2's third trap — the display
 * unit and the currency are per-user and are in no cache key — and it converts trap 3 into
 * trap 2 without a single test going red. The answer this app actually took is
 * `unitVariants.ts`: render all five units on the server, let the island index into them.
 *
 * So the guard is now the *set* of request-time reads, named. Anything that makes a route
 * dynamic has to appear here to be allowed.
 */
describe('plan 8.2 trap 2, widened — every door that silently makes a route dynamic', () => {
  /**
   * The Next.js request-time APIs. Reading any of them in a server component opts the
   * route out of the prerender, at build time, silently.
   *
   * `connection()` and `draftMode()` are included although nothing in this app has ever
   * used them: the point of a named set is that it is a list somebody has to add to
   * deliberately, and a list that only contains what has already gone wrong is a changelog.
   */
  const REQUEST_TIME_APIS = ['cookies', 'headers', 'draftMode', 'connection'] as const;

  it('no server component reads cookies(), headers(), draftMode() or connection()', () => {
    const offenders = files.flatMap(({ name, source }) => {
      const stripped = code(source);
      if (/^\s*['"]use client['"]/.test(stripped)) return [];
      return REQUEST_TIME_APIS.filter((api) =>
        new RegExp(String.raw`\b${api}\s*\(\s*\)`).test(stripped),
      ).map((api) => `${name}: ${api}()`);
    });

    expect(offenders).toEqual([]);
  });

  it('no route exports a `dynamic` segment config other than the static one', () => {
    // `force-static` and `error` both keep the prerender; `force-dynamic` and `auto`
    // (the default, and therefore never worth writing) do not guarantee it. Rather than
    // enumerate the safe values, this refuses the export outright: the app has no route
    // that needs one, and the day one does it should be a decision with a comment beside
    // it, not a line that slid in.
    const offenders = files
      .filter(({ source }) => /export\s+const\s+dynamic\s*=/.test(code(source)))
      .map(({ name }) => name);

    expect(offenders).toEqual([]);
  });

  it('no page reads searchParams at all, in any function', () => {
    // Wider than the `generateMetadata` scan above and for the same reason: `searchParams`
    // on a *page* signature opts out of static rendering just as silently, and the
    // catalogue — where filtering on the server is the obvious implementation — is exactly
    // where somebody would write it.
    const offenders = files
      .filter(({ name, source }) => name.endsWith('page.tsx') && code(source).includes('searchParams'))
      .map(({ name }) => name);

    expect(offenders).toEqual([]);
  });

  it('the guard is not vacuous — the tokens it hunts for are findable', () => {
    // Each scan above is an `expect([]).toEqual([])` when the app is clean, which is the
    // same shape as a scan whose regex has stopped matching anything. This asserts the
    // machinery can still see: `generateStaticParams` is a token every route file has, and
    // the same `code()`/regex path finds it.
    const withStaticParams = files.filter(({ source }) =>
      /export\s+const\s+generateStaticParams|export\s+(async\s+)?function\s+generateStaticParams/.test(
        code(source),
      ),
    );

    expect(withStaticParams.length).toBeGreaterThanOrEqual(3);
  });
});

/* ------------------------------------------------------------------ *
 * The shared-cache lifetime — the header, not the segment config
 * ------------------------------------------------------------------ */

describe('plan 8.2 trap 1, the other half — what the response actually says', () => {
  it('next.config.ts bounds the shared-cache lifetime', async () => {
    // `revalidate = false` makes Next emit `s-maxage=31536000`: one year, on every
    // price-bearing page, from the option the layout defends as the safe one. Measured on
    // a running server during 6b's adversarial pass. The segment config is not where this
    // is fixable — the header is.
    const config = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'next.config.ts'),
      'utf8',
    );

    const value = /['"]Cache-Control['"],\s*\n?\s*value:\s*['"]([^'"]+)['"]/.exec(config)?.[1];
    expect(value).toBeDefined();

    const sMaxAge = Number(/s-maxage=(\d+)/.exec(value ?? '')?.[1] ?? Number.NaN);
    expect(Number.isFinite(sMaxAge)).toBe(true);

    // An hour is the interval plan 8.2 names as unacceptable for a price. Whatever this
    // app sends a shared cache has to be shorter than the thing the plan already rejected.
    expect(sMaxAge).toBeLessThan(3600);
  });
});
