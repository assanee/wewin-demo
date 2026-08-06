import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * **A preference must not become a fourth way to change a stored number** — enforced by
 * reading the source rather than by reviewing it.
 *
 * ── Why a scan, when there is a behavioural test next door ───────────────────────
 *
 * `preferences.pg.test.ts` proves the invariant *for the values it happens to sweep*: an
 * order's money and a pinned document come back byte-identical under every locale, currency
 * and unit a person can choose. That is the property, and it is the right test.
 *
 * It cannot see the *next* thing this module grows. The failure being guarded against is not
 * "somebody wrote a bug"; it is "somebody added a helpful line" — a `fromMicrons` to show the
 * saved size back to the customer, a rate to preview what a price would look like in euros, a
 * `formatMoney` so the confirmation toast can quote something. Every one of those is a
 * reasonable-looking addition, none of them fails an existing assertion, and each one puts a
 * conversion inside the module that owns the preference. Phase 4.6 spent a whole phase
 * removing "one division on the way to the screen"; this is the scan that stops it coming back
 * through the settings form.
 *
 * The shape is `apps/web/tests/tokens.test.ts`'s, including its lesson: comments are stripped
 * before every scan, because this file's own subject matter is the names it forbids and a
 * guard that fires on the paragraph explaining it teaches contributors to delete the
 * explanation.
 */

/*
 * `process.cwd()`, not `__dirname` and not `import.meta.url`. This package compiles to
 * CommonJS, so `import.meta` is a compile error under `tsc`; Vitest transforms this file as
 * ESM, so `__dirname` does not exist at run time. Only the working directory is true in both
 * — the reasoning is `tests/build-output.test.ts`'s, and it is the resolution this suite has
 * used since phase 3.
 */
const srcDirectory = join(process.cwd(), 'src');
const profileDirectory = join(srcDirectory, 'profile');

const sourceFiles = (directory: string): readonly string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });

/** Comments removed. See the header — the forbidden names are this file's subject matter. */
const code = (source: string): string =>
  source.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/(^|[^:])\/\/.*$/gm, '$1');

const files = sourceFiles(profileDirectory).map((path) => ({
  name: relative(profileDirectory, path),
  code: code(readFileSync(path, 'utf8')),
}));

/**
 * Names that turn a canonical value into a displayed one, or one currency into another.
 *
 * Not an exhaustive list of arithmetic — that would be a second copy of `@wewin/core`. These
 * are the exported names a person reaches for when they decide the preferences endpoint should
 * *show* something, which is the one decision that puts a conversion in this directory.
 */
const FORBIDDEN: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  {
    pattern: /\b(?:fromMicrons|toMicrons|parseMeasure|gridUmFor|isOnGridUm)\b/g,
    why: 'plan 4.1 / phase 2 — only `toMicrons`, on something a person typed, may produce a canonical length; a preferences module has nothing anybody typed',
  },
  {
    pattern: /\b(?:formatLength|formatMeasure|formatRange|formatDimensions|formatArea)\b/g,
    why: 'rendering a measurement here would mean this module holds one, and it holds none',
  },
  {
    pattern: /\b(?:formatMoney|formatBaht|convert|applyRate|exchangeRate|pinnedRate)\b/g,
    why: 'plan 4.2 / plan 13 — one base currency and a pinned rate; a display preference must never meet either',
  },
  {
    pattern: /\bbigint\b/g,
    why: 'plan 4.1 — every quantity in this system is a bigint, so a bigint in this directory is a quantity that arrived where none belongs',
  },
];

describe('the scan can see', () => {
  it('found the module', () => {
    // A scan over an empty directory passes silently and proves nothing — the failure mode
    // phase 5b hit when a dead globalSetup left 116 tests reported as passes.
    expect(files.length).toBeGreaterThanOrEqual(5);
    expect(files.map((file) => file.name)).toContain('profile.service.ts');
  });

  it('would notice a conversion if one were there', () => {
    // The scanner mutation-tested in place. A guard nobody has watched fire is a guard nobody
    // has evidence for; without this, every assertion below is an `expect([]).toEqual([])`
    // that a broken regex would satisfy for free.
    const planted =
      'const shown = formatMeasure(fromMicrons(width, unit), unit); const b: bigint = applyRate(total);';
    const hits = FORBIDDEN.filter(({ pattern }) => new RegExp(pattern.source).test(planted));
    expect(hits).toHaveLength(FORBIDDEN.length);
  });

  it('does not fire on what the module legitimately holds', () => {
    // `LENGTH_UNITS`, `CURRENCIES` and the column names are *names of preferences*, not
    // conversions, and the module cannot be written without them. A guard that could not tell
    // the two apart would be uninstallable.
    const legitimate =
      "import { CURRENCIES, type Currency } from '@wewin/core/money'; import { LENGTH_UNITS, type LengthUnit } from '@wewin/core/units'; const x = { displayCurrency: null, displayLengthUnit: 'mm' };";
    for (const { pattern } of FORBIDDEN) {
      expect(new RegExp(pattern.source).test(legitimate), pattern.source).toBe(false);
    }
  });
});

describe('nothing under src/profile converts anything', () => {
  it.each(FORBIDDEN)('$why', ({ pattern }) => {
    const offenders = files.flatMap(({ name, code: source }) => {
      const found = [...source.matchAll(new RegExp(pattern.source, 'g'))].map((match) => match[0]);
      return found.length === 0 ? [] : [`${name}: ${[...new Set(found)].join(', ')}`];
    });

    expect(offenders).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * The other direction: nothing else in the process reads the table
 * ------------------------------------------------------------------ */

/**
 * `user_preferences` is referenced by one directory, and that is the schema's own claim.
 *
 * `packages/db/src/schema/profile.ts` argues that **nothing references this table**, so a row
 * in it cannot be a term of a contract — which is what `order_documents.pinned_locale` is for
 * and what plan 10.6 splits. That is a claim about foreign keys, and the schema can enforce
 * it. What the schema cannot see is a *read*: `order-document.ts` joining `user_preferences`
 * to "fix" a customer complaint about language would satisfy every constraint in the database
 * and would silently make every reprint a different document.
 *
 * So this walks the whole of `src/` and asserts the table is named in one place.
 */
describe('plan 10.6 — no other module reads the preferences table', () => {
  it('only src/profile names user_preferences or userPreferences', () => {
    const readers = sourceFiles(srcDirectory)
      .map((path) => ({
        name: relative(srcDirectory, path),
        code: code(readFileSync(path, 'utf8')),
      }))
      .filter(({ code: source }) => /\b(?:user_preferences|userPreferences)\b/.test(source))
      .map(({ name }) => name);

    expect(readers).toStrictEqual(['profile/profile.repository.ts']);
  });

  it('the sweep reached the tree it is asserting about', () => {
    // `toStrictEqual([...])` on a list built from a broken walk is the same green as a clean
    // one. This is the non-vacuity: the same walk finds the document renderer, which is the
    // single file the assertion above exists to keep off the list.
    const names = sourceFiles(srcDirectory).map((path) => relative(srcDirectory, path));
    expect(names).toContain(join('orders', 'order-document.ts'));
    expect(names.length).toBeGreaterThan(100);
  });
});
