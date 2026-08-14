import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * ⚠️ This test reads its subject as text, which is not how anything else here is tested.
 *
 * The usual shape — import the module, call it, assert on what comes back — cannot reach
 * this. Vitest runs `environment: 'node'` in this app on purpose, so there is no DOM to
 * render `<SidebarInset>` into and no computed style to read back. A `.test.tsx` would not
 * even be collected. What is being protected is a single class name inside a string, and
 * reading the string is the only instrument left.
 *
 * ### What it is protecting, and from what
 *
 * `sidebar.tsx` is vendored from shadcn. Every other line in it is generated, and
 * `npx shadcn add sidebar` overwrites the file wholesale. One class in it is ours:
 * `min-w-0` on the `<main>` element. Without it, `<main>` is a flex sibling of the sidebar
 * whose default `min-width: auto` forbids it from shrinking below its own min-content — so
 * one wide table anywhere inside pushes the entire document sideways instead of scrolling
 * within its own container.
 *
 * That was measured, not guessed: before the class, five routes overflowed — `/quotes/:id`
 * by 256px at every width tested, `/authority` by 159px at 1280 and 256 at 1024, `/users`
 * by 64, `/organisation` by 43, `/products` by 4 — and the same 108 route/width/theme
 * combinations all measured 0 afterwards.
 *
 * A regeneration would drop the class and reintroduce all five silently. No unit test in
 * this app can see a layout, so nothing else would fail. This one would.
 *
 * ### What it does NOT prove
 *
 * That the layout is correct. It proves one string is still present. The real evidence is a
 * browser measuring `documentElement.scrollWidth` against `clientWidth`, and that has to be
 * re-run by hand when this file changes.
 */
const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'sidebar.tsx'),
  'utf8',
);

describe('SidebarInset', () => {
  /**
   * Anchored on `relative flex w-full`, the opening of the `<main>` class list, rather than
   * on a bare search for `min-w-0` — that class legitimately appears five other times in
   * this file, on the sidebar's own inner containers, so a bare search would keep passing
   * after a regeneration removed the only one that matters.
   */
  const mainClasses = /"relative flex w-full([^"]*)"/.exec(source)?.[1];

  it('declares the main element the fix targets', () => {
    expect(
      mainClasses,
      'the <main> class list in SidebarInset no longer starts with "relative flex w-full" — ' +
        'the file was probably regenerated; re-check the class list by hand',
    ).toBeDefined();
  });

  it('keeps min-w-0 on main, without which five routes scroll the page sideways', () => {
    expect(
      mainClasses,
      'min-w-0 is missing from SidebarInset. A flex item defaults to min-width:auto, which ' +
        'means "no narrower than my own min-content" — not zero. Restore it, then re-measure ' +
        '/quotes/:id with a price override at 1440px: documentElement.scrollWidth must equal ' +
        'clientWidth.',
    ).toContain('min-w-0');
  });
});
