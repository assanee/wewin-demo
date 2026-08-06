import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, test } from 'vitest';
import type { CustomGroup, Product } from '@wewin/core';
import { formatLength } from '@wewin/core/format';
import { getProductBySlug } from '@wewin/core/fixtures';
import { calcPrice } from '@wewin/core/pricing';
import { LENGTH_UNITS, parseMeasure, snapUpUm, toMicrons, type LengthUnit } from '@wewin/core/units';
import { gridFor } from '@wewin/core/validation';

import { shouldCommitOnBlur } from '@/components/configurator/measureCommit';
import { defaultStateFor } from '@/state/useConfigurator';

/**
 * # The four things the move was not allowed to change
 *
 * The brief for this port names them and this file pins them, in the same spirit as
 * `pricing-parity`'s `correctedUp === 87`: a number that moves has to be *said out loud*
 * by somebody, not discovered by a customer.
 *
 *   1. `awn-4t` at 320.5 × 160 cm costs **฿7,692**.
 *   2. The unit picker tours all five units without moving a micrometre.
 *   3. Typing `100.3"` snaps **up** to `100 3/8"`.
 *   4. The dirty flag still means a unit switch does not commit.
 *
 * None of these is about Next.js, which is the point — a framework move that changes any
 * of them has gone wrong somewhere it will not be looked for.
 *
 * `tests/configurator-render.test.ts` is the other half: it proves the same components
 * render on a server with no `window`, which is what makes the 648 pages prerenderable.
 */

const product = (slug: string): Product => {
  const found = getProductBySlug(slug);
  // Not `?? throw` in the caller: a missing fixture must fail here, naming the slug,
  // rather than as `undefined` three assertions later.
  if (!found) throw new Error(`fixture missing: ${slug}`);
  return found;
};

const groupOf = (from: Product, code: string): CustomGroup => {
  const found = from.groups.find((g): g is CustomGroup => g.kind === 'custom' && g.code === code);
  if (!found) throw new Error(`no custom group ${code} on ${from.slug}`);
  return found;
};

/** The state the island starts a product at, exactly as `defaultStateFor` builds it. */
const startingState = (from: Product) => defaultStateFor(from);

describe('1 · the price did not move', () => {
  it('awn-4t at 320.5 × 160 cm is ฿7,692', () => {
    const awn = product('awn-4t');
    const { selections, measures } = startingState(awn);

    const configured = {
      ...measures,
      width: toMicrons(320.5, 'cm'),
      height: toMicrons(160, 'cm'),
    };

    // The exact micrometres first. If these are wrong the price below is wrong for a
    // reason that has nothing to do with pricing, and the failure should say so.
    expect(configured['width']).toBe(3_205_000n);
    expect(configured['height']).toBe(1_600_000n);

    const price = calcPrice(awn, selections, configured, 1);

    // Minor units — satang. `formatBaht` takes minor units for the reason plan 4.6
    // gives, and asserting on baht here would hide a division.
    expect(price.totalMinor).toBe(769_200n);
    expect(price.totalMinor / 100n).toBe(7_692n);
  });

  it('is the same price whichever unit the customer was reading', () => {
    const awn = product('awn-4t');
    const { selections, measures } = startingState(awn);
    const configured = { ...measures, width: 3_205_000n, height: 1_600_000n };

    // `calcPrice` takes no unit at all, and that is the guarantee rather than an
    // omission — the display unit cannot reach the arithmetic because there is no
    // parameter for it to arrive through. Pinned so that adding one is a red test.
    expect(calcPrice.length).toBe(4);
    expect(calcPrice(awn, selections, configured, 1).totalMinor).toBe(769_200n);
  });
});

describe('2 · the unit picker tours five units without moving a micrometre', () => {
  /**
   * The tour phase 2 verified in a browser: cm → mm → m → in → ft → cm.
   *
   * What the component does at each stop is exactly two things — clear the dirty flag
   * because a unit switch is not an edit, and re-render the same canonical value in the
   * new unit. Both are modelled here, and the assertion is that the third thing never
   * happens: nothing is ever committed, so the canonical value is bit-identical at the
   * end of the tour.
   */
  const TOUR: readonly LengthUnit[] = ['cm', 'mm', 'm', 'in', 'ft', 'cm'];

  it('320.5 cm survives the whole tour unchanged', () => {
    const awn = product('awn-4t');
    const width = groupOf(awn, 'width');
    const canonical = 3_205_000n;

    let value = canonical;
    const seen: string[] = [];

    for (const unit of TOUR) {
      // Arriving in a new unit: the field re-renders the *same* canonical value, and
      // `dirtyRef` is cleared because nobody typed.
      const rendered = formatLength(value, unit);
      seen.push(`${rendered} ${unit}`);

      // Blur — a click into the field and back out, in the new unit. This is the exact
      // hazard: `parseMeasure(rendered, 'in')` is a *different* number from `value`,
      // because 320.5 cm is not on the eighth-inch grid. The flag is what stops it.
      expect(shouldCommitOnBlur(false, rendered, rendered)).toBe(false);

      // Nothing committed, so nothing moved.
      expect(value).toBe(canonical);
    }

    expect(value).toBe(3_205_000n);
    expect(seen).toHaveLength(6);
    // Every one of the five units is visited, so this cannot pass by skipping the
    // imperial stops, which are the only ones that can lose micrometres.
    expect(new Set(TOUR).size).toBe(LENGTH_UNITS.length);

    // And the reason it had to be guarded: read back through the inch grid, the same
    // window really is a different number. The tour is safe because nothing reads it
    // back, not because the round trip is lossless.
    const throughInches = parseMeasure(formatLength(canonical, 'in'), 'in', width);
    expect(throughInches).not.toBe(canonical);
  });

  it('the price is identical at every stop', () => {
    const awn = product('awn-4t');
    const { selections, measures } = startingState(awn);
    const configured = { ...measures, width: 3_205_000n, height: 1_600_000n };

    const prices = TOUR.map(() => calcPrice(awn, selections, configured, 1).totalMinor);
    expect(new Set(prices.map(String)).size).toBe(1);
    expect(prices[0]).toBe(769_200n);
  });
});

describe('3 · typing 100.3" snaps up to 100 3/8"', () => {
  const awn = product('awn-4t');
  const width = groupOf(awn, 'width');

  it('parses to 2,549,525 µm and renders as 100 3/8"', () => {
    const parsed = parseMeasure('100.3', 'in', width);

    expect(parsed).toBe(2_549_525n);
    expect(parsed === null ? '' : formatLength(parsed, 'in')).toBe('100 3/8"');
  });

  it('snaps up, never down — the window a customer gets is never smaller than asked', () => {
    const typed = 2_547_620n; // 100.3 in, exactly, in micrometres
    const parsed = parseMeasure('100.3', 'in', width);

    expect(parsed).not.toBeNull();
    if (parsed === null) return;
    expect(parsed).toBeGreaterThan(typed);

    // And it lands on the eighth-inch grid the inch display uses, not somewhere near it.
    const grid = gridFor(width, 'in');
    expect(parsed % grid).toBe(0n);
    expect(snapUpUm(typed, grid)).toBe(parsed);
  });

  it('reads back in centimetres without being tidied to a round number', () => {
    const parsed = parseMeasure('100.3', 'in', width);
    if (parsed === null) throw new Error('unreachable — asserted above');

    // 254.9525 cm and not 255. That is the size that gets cut, and plan 4.7 is explicit
    // that rounding it for looks is how a configurator lies about a window.
    expect(formatLength(parsed, 'cm')).toBe('254.9525');
  });
});

describe('4 · the dirty flag still means a unit switch does not commit', () => {
  /**
   * The rule, exhaustively. `shouldCommitOnBlur` is the expression that was inside
   * `onBlur`, and both of its halves are load-bearing:
   *
   *   - the flag is set by a keystroke and by nothing else, and cleared on a unit change;
   *   - the string compare catches "typed a character and deleted it again".
   */
  const CASES: readonly [dirty: boolean, text: string, rendered: string, commit: boolean][] = [
    // Focused and blurred, nothing typed. The value must not move.
    [false, '320.5', '320.5', false],
    // The unit changed under the field: the flag was cleared and the text was reset.
    // This is the case that produced 3,200,400 µm from an untouched 3,200,000 µm window.
    [false, '126 3/16"', '126 3/16"', false],
    // Worse: the flag cleared but the text is *stale* from the previous unit. Still no
    // commit, because only a keystroke may move a size.
    [false, '320.5', '126 3/16"', false],
    // Typed, then put back exactly. Nothing to commit.
    [true, '320.5', '320.5', false],
    // Typed something new. This is the one case that commits.
    [true, '250.4', '320.5', true],
    // Emptied the field. Commits — and `parseMeasure` returning null is what makes the
    // caller fall back to the group default rather than throw out of a handler.
    [true, '', '320.5', true],
  ];

  test.each(CASES)('dirty=%s text=%j rendered=%j → commit %s', (dirty, text, rendered, commit) => {
    expect(shouldCommitOnBlur(dirty, text, rendered)).toBe(commit);
  });

  it('a flag inferred by comparing numbers would be wrong forever across a unit switch', () => {
    const awn = product('awn-4t');
    const width = groupOf(awn, 'width');
    const canonical = 3_200_000n; // 320 cm, exactly on the metric grid

    // The tempting alternative to the flag: "the text parses to something other than the
    // value, so the customer must have changed it". In inches that is true of a window
    // nobody has touched, and acting on it resizes it by 400 µm.
    const shownInInches = formatLength(canonical, 'in');
    const inferred = parseMeasure(shownInInches, 'in', width);

    expect(inferred).not.toBe(canonical);
    expect(inferred).toBe(3_200_400n);

    // The flag says no, and the flag is what the component asks.
    expect(shouldCommitOnBlur(false, shownInInches, shownInInches)).toBe(false);
  });
});

/* ── The island is one island, and the boundary carries no bigint ─────────────── */

const HERE = fileURLToPath(new URL('.', import.meta.url));
const CONFIGURATOR_DIR = join(HERE, '..', 'src', 'components', 'configurator');

const configuratorFiles = (): { name: string; source: string }[] =>
  readdirSync(CONFIGURATOR_DIR)
    .filter((name) => /\.tsx?$/.test(name))
    .map((name) => ({ name, source: readFileSync(join(CONFIGURATOR_DIR, name), 'utf8') }));

describe('plan 8.1 — the configurator is one client island', () => {
  it('found the configurator source to scan', () => {
    // The scan's own liveness check. A scanner pointed at an empty directory agrees with
    // everything, which is the same false green as phase 5b's dead globalSetup.
    expect(configuratorFiles().length).toBeGreaterThanOrEqual(11);
  });

  it("exactly one file carries a 'use client' directive, and it is the island root", () => {
    const boundaries = configuratorFiles()
      .filter(({ source }) => /^\s*['"]use client['"]/.test(source))
      .map(({ name }) => name);

    expect(boundaries).toEqual(['ConfiguratorIsland.tsx']);
  });

  it('imports nothing from next/*, so it can be rendered by anything', () => {
    // Not tidiness. `useRouter`, `useSearchParams` and `usePathname` all read the App
    // Router's context, and one of them anywhere in this subtree would make the island
    // unrenderable outside a mounted Next router — which is precisely what
    // `configurator-render.test.ts` does to prove the whole thing prerenders with no
    // browser globals in reach. The proof is worth more than the convenience.
    for (const { name, source } of configuratorFiles()) {
      expect({ name, next: /from\s+['"]next\//.test(source) }).toEqual({ name, next: false });
    }
  });

  it('the island takes only strings across the server/client boundary', () => {
    const island = configuratorFiles().find((f) => f.name === 'ConfiguratorIsland.tsx');
    expect(island).toBeDefined();
    if (!island) return;

    // A `Product` holds `bigint` micrometres and `bigint` satang. Handing one to a client
    // component means pushing bigints through the RSC payload; the island looks the
    // product up from the compiled-in fixtures instead, so the props are a locale and a
    // slug and nothing else can be got wrong on the way.
    expect(island.source).toMatch(/readonly locale: Locale;/);
    expect(island.source).toMatch(/readonly slug: string;/);
    expect(island.source).toMatch(/getProductBySlug\(slug\)/);
  });
});
