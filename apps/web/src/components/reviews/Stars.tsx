import type { ReactElement } from 'react';

import type { StarFill } from '../../lib/reviews/average';

/**
 * The star row — **drawn, not typed, and sized by the SVG rather than by a class.**
 *
 * ── Why this is the awkward component in this app ────────────────────────────────
 *
 * `apps/web` wipes Tailwind's type scale (`--text-*: initial`), so `text-sm` produces no
 * CSS at all and the seven project sizes are the whole vocabulary. A star written as the
 * character `★` is *text*: its size is a font size, so drawing it at anything other than
 * one of the seven means reaching for a size utility that does not exist — and the failure
 * is silent, which is the exact trap `scripts/check-tokens.mjs` half three was built after
 * (`text-sm` in a real `className`: built, linted, shipped, styled nothing).
 *
 * So the star is a `<svg>` with `width`/`height` **attributes**. Sixteen pixels because
 * that is what sits beside 15px body text without the row growing, and it is an attribute
 * on a drawing rather than a class on a word. Nothing here names a font, a text size or a
 * breakpoint; the only utilities are layout and two palette colours.
 *
 * ── The palette choice, stated ───────────────────────────────────────────────────
 *
 * Chalk on chalk-3, not `--lime` and not `--warn`. Lime is capped at two appearances per
 * screen and reserved for the price and the single active action (spec section 2); a row of
 * five lime stars beside a lime price would spend the whole budget on decoration and stop
 * the price being the thing the eye lands on. `--warn` is amber and would read as the
 * conventional review star — and it would also read as a warning, because that is what it
 * means everywhere else in this app.
 *
 * ── Half stars without an id ─────────────────────────────────────────────────────
 *
 * The obvious implementation is a `<linearGradient>` with a 50% stop, which needs an `id`,
 * and an id in a component that appears many times on a page is a duplicate id in the
 * document. The overlap below has no id: a full star in the empty colour, with a filled
 * star clipped to half its width laid over it. Pure CSS, repeatable, and it cannot collide
 * with anything.
 *
 * The row is `aria-hidden`. A screen reader gets the sentence beside it — "4.2 จาก 5 · 12
 * รีวิว" — which carries the number *and* the count, which is what plan 9.5 requires and
 * what five icons could never say.
 */

/** One point of the row, in pixels. An attribute on a drawing, never a type size. */
const STAR_PX = 16;

/** A five-pointed star on a 20×20 canvas. */
const STAR_PATH =
  'M10 1.5l2.6 5.27 5.82.85-4.21 4.1.99 5.79L10 14.77l-5.2 2.74.99-5.79L1.58 7.62l5.82-.85z';

function StarGlyph({ className }: { readonly className: string }): ReactElement {
  return (
    <svg
      viewBox="0 0 20 20"
      width={STAR_PX}
      height={STAR_PX}
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path d={STAR_PATH} />
    </svg>
  );
}

function Star({ fill }: { readonly fill: StarFill }): ReactElement {
  if (fill === 'full') return <StarGlyph className="fill-chalk" />;
  if (fill === 'empty') return <StarGlyph className="fill-chalk-3" />;

  return (
    /* `h-4 w-4` is 16px on the 4px spacing scale — the same number as `STAR_PX`, which is
       an attribute on the drawing. The two are coupled and the test asserts the glyph
       still measures `STAR_PX`, so a change to one that forgets the other is caught. */
    <span className="relative inline-block h-4 w-4 align-middle">
      <StarGlyph className="absolute inset-0 fill-chalk-3" />
      {/* `left-0` rather than a logical `start-0`: plan 8.3 settles that all eight locales
          are LTR and that there is no bidi work in this project, and a utility that is
          certain to emit is worth more here than one that reads better — a class that
          produces no CSS fails silently, which is the whole reason `check-tokens.mjs`
          half three exists. */}
      <span className="absolute inset-y-0 left-0 w-2 overflow-hidden">
        <StarGlyph className="fill-chalk" />
      </span>
    </span>
  );
}

export function Stars({ fills }: { readonly fills: readonly StarFill[] }): ReactElement {
  return (
    <span className="inline-flex items-center gap-0.5" aria-hidden="true">
      {fills.map((fill, index) => (
        <Star key={index} fill={fill} />
      ))}
    </span>
  );
}
