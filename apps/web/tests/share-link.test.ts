import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SHARE_SCHEMA_VERSION,
  buildShareUrl,
  readSharedConfig,
} from '@wewin/core/share-link';
import { getProductBySlug } from '@wewin/core/fixtures';
import type { Product } from '@wewin/core';
import { LOCALES } from '@wewin/i18n/locales';

import { firstSegment, localeFromSegment } from '../src/lib/routing';

/**
 * The share link, across the move.
 *
 * `packages/core/tests/shareLink.test.ts` already pins what a link means — the version
 * tag, the whole-link refusal, the absence of clamping — and none of that moved, because
 * `@wewin/core/share-link` did not move. What this file pins is what *this app* does with
 * it, and there are exactly two things, both new and both invisible:
 *
 *   1. **A share link carries no locale segment.** Every URL in this app is
 *      `/[locale]/…`, so the obvious implementation copies the sender's prefix, and it
 *      would be wrong: the link goes to somebody else, who reads it in their own language.
 *   2. **A link that carries no version is still refused whole, not clamped.** The move
 *      introduced two new places to be helpful about it — the middleware and the hook that
 *      reads `window.location.search` — and neither may be.
 */

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** Every `.ts`/`.tsx` under a directory, with its source. */
const sourceFiles = (directory: string): readonly { name: string; source: string }[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!/\.tsx?$/.test(entry.name)) return [];
    return [{ name: relative(sourceRoot, path), source: readFileSync(path, 'utf8') }];
  });

const product = (slug: string): Product => {
  const found = getProductBySlug(slug);
  if (!found) throw new Error(`fixture missing: ${slug}`);
  return found;
};

const AWN = {
  profile_color: 'BK',
  glass_color: 'GRN',
  glass_thickness: 'T5',
  insect_screen: 'NS1',
};

const shareUrl = (origin: string): string =>
  buildShareUrl(origin, product('awn-4t'), AWN, { width: 2_500_000n, height: 1_800_000n }, {}, 1);

describe('a share link is not locale-prefixed', () => {
  it('the path is /products/<slug> and nothing before it', () => {
    const url = new URL(shareUrl('https://wewin.example'));
    expect(url.pathname).toBe('/products/awn-4t');
  });

  it('so its first segment is not one of the eight', () => {
    const url = new URL(shareUrl('https://wewin.example'));
    // The assertion that actually matters. A link built as `/de/products/awn-4t` would
    // hand the recipient the sender's language — the failure `useLocale.tsx` names: a
    // German customer sends a drawing to a Thai installer and the installer gets German.
    expect(localeFromSegment(firstSegment(url.pathname))).toBeNull();
  });

  it('and no locale segment can be mistaken for a product slug', () => {
    // The other direction of the same fact: if a locale code were ever a product slug,
    // an unprefixed link would be ambiguous and the proxy would have to guess.
    for (const locale of LOCALES) {
      expect(getProductBySlug(locale)).toBeUndefined();
    }
  });

  it('the middleware is what gives it one, and it must keep the query string', () => {
    const proxy = readFileSync(join(sourceRoot, 'proxy.ts'), 'utf8');

    // `nextUrl.clone()` carries the search params through the 307; building a fresh URL
    // from the pathname alone would drop them, and the query string *is* the shared
    // configuration. A link would then open on the product's defaults — a perfectly
    // ordinary window that is not the one that was sent, which is the exact outcome
    // core refuses to produce by clamping and would be reproducing here by redirect.
    expect(proxy).toMatch(/request\.nextUrl\.clone\(\)/);
    expect(proxy).toMatch(/url\.pathname = localeHref\(/);
  });
});

describe('a link without a version is refused whole', () => {
  const awn = product('awn-4t');

  it('reads a complete v3 link', () => {
    const search = new URLSearchParams(`v=${SHARE_SCHEMA_VERSION}&width=2500000&height=1800000`);
    expect(readSharedConfig(awn, search)?.measures).toEqual({
      width: 2_500_000n,
      height: 1_800_000n,
    });
  });

  it('refuses the same link with the version removed', () => {
    const search = new URLSearchParams('width=2500000&height=1800000');
    expect(readSharedConfig(awn, search)).toBeNull();
  });

  it('refuses a pre-micrometre link rather than clamping it into range', () => {
    // `?width=250` meant 250 cm in a v2 link. Clamped, it becomes 60 cm — the minimum —
    // and opens a configurator showing a perfectly ordinary window that is not the one
    // that was shared. A link that fails to parse is a link the recipient asks about;
    // a link that parses into the wrong window is one they quote from.
    const legacy = new URLSearchParams('width=250&height=180');
    expect(readSharedConfig(awn, legacy)).toBeNull();

    // And it is refused for the missing version, not merely for being out of range:
    // stamping v3 on the same numbers is still refused, and still not clamped up.
    const stamped = new URLSearchParams(`v=${SHARE_SCHEMA_VERSION}&width=250&height=180`);
    expect(readSharedConfig(awn, stamped)).toBeNull();
  });

  it('nothing in this app reads the version tag for itself', () => {
    // The refusal is one function in `packages/core`, and it is only trustworthy while it
    // is the only reader. A second `get('v')` anywhere in the app is somebody deciding
    // what to do about a missing version at a second site — and the helpful decision, the
    // one that gets made when the rule is not in front of you, is to carry on without it.
    //
    // ⚠️ The rule is about **this app's own URL**; the pattern cannot tell that from any
    // other URL's query, and `v` is also how YouTube names a video id. So a file may be
    // exempt — and the exempt list lives *here*, in the guard, rather than as a comment in
    // the file being excused. Adding one is an edit to this test, which is a line in a
    // diff somebody reviews; a marker in the offending file is a line nobody sees again.
    const ALLOWED = [
      // Parses a *YouTube* watch link into a player URL. Never reads `location`, never
      // reads this app's search params — see the note at the top of the file.
      'lib/catalog/gallery.ts',
    ];

    const readers = sourceFiles(sourceRoot)
      .filter(({ source }) => /\.get\(\s*['"]v['"]\s*\)/.test(source))
      .map(({ name }) => name);

    expect(readers.filter((name) => !ALLOWED.includes(name))).toEqual([]);
    // The exemptions have to still exist: a stale entry here is a hole held open for a
    // file that no longer needs it.
    expect(readers).toEqual(ALLOWED);
  });

  it('and the scan can see the app, so the assertion above is not vacuous', () => {
    const readers = sourceFiles(sourceRoot)
      .filter(({ source }) => source.includes('readSharedConfig'))
      .map(({ name }) => name);

    // At least the configurator island, which is where a link is opened.
    expect(readers.length).toBeGreaterThan(0);
  });
});
