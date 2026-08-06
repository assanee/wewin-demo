/**
 * The average, computed exactly, and **never available without its count**.
 *
 * Plan 9.5: *"never show an average without its count — 5.0 ★ from one review reads as
 * advertising, not as information."* The database made that structural — `product_review_stats`
 * exposes `rating_sum` and `rating_count` and **has no average column**, so a caller
 * physically cannot select one without holding the denominator. This module is the same
 * decision on this side of the wire: there is no `average(review)`; every function here
 * takes the *pair*, and the one that renders it (`f.rating` in `i18n/format.ts`) takes the
 * pair too and returns an em dash when the count is zero.
 *
 * ── Why bigint, for a number between 1 and 5 ─────────────────────────────────────
 *
 * Because the sum arrives as one. `count(*)::bigint` and `sum(r.rating)::bigint` are what
 * the view returns, and this codebase has spent five phases keeping exact integers exact
 * (plan 4.6/4.7: micrometres and satang never become `number` on the way to a screen). A
 * rating average is not money, so the stakes are lower — but `4.05` rendering as `4.1` on
 * one page and `4.0` on another is the same class of bug as the 21.255 m² split phase 6a
 * measured, and it costs nothing to not have it.
 *
 * Rounding is **half-up**, the rule `divRoundHalfUp` fixes for money in `@wewin/core/money`
 * and the one plan 4.3(ก) settled for the whole system. Reusing the answer rather than
 * picking one.
 */

/** The two numbers `product_review_stats` returns, and the only honest unit of an average. */
export interface RatingTally {
  /** Sum of every *moderated* rating, hidden ones included — plan 9.3. */
  readonly sum: bigint;
  /** How many. Zero means there is no average, not that the average is zero. */
  readonly count: bigint;
}

/**
 * The average in tenths, rounded half-up. `null` when there is nothing to average.
 *
 * Tenths rather than a float: one decimal place is what a rating is shown to, and doing
 * the rounding here in integers means the string, the star fill and any future comparison
 * all read the same number rather than three roundings of a `double`.
 */
export function averageTenths({ sum, count }: RatingTally): bigint | null {
  if (count <= 0n) return null;
  // (sum * 10 + count/2) / count, in integers — half-up without a float in sight.
  return (sum * 10n * 2n + count) / (count * 2n);
}

/**
 * The average as ASCII digits with one decimal place — `'4.2'`, `'5.0'`.
 *
 * ASCII, because localising numerals is `@wewin/i18n`'s job and this function has no
 * locale. `'5.0'` and not `'5'`: a trailing `.0` is the difference between a rating and a
 * count, and dropping it makes a five-star product's average look like a tally.
 */
export function averageText(tally: RatingTally): string | null {
  const tenths = averageTenths(tally);
  if (tenths === null) return null;
  return `${tenths / 10n}.${tenths % 10n}`;
}

/** How a star is drawn. */
export type StarFill = 'full' | 'half' | 'empty';

/** Ratings run 1–5 (`REVIEW_RATING_MIN`/`MAX` in packages/db). Five stars, always five. */
export const STAR_COUNT = 5;

/**
 * Five stars for an average, rounded to the nearest **half** star.
 *
 * A separate rounding from `averageTenths` and deliberately so: 4.2 is written `4.2` and
 * drawn as four stars, and forcing the picture to agree with the text to the tenth would
 * mean either lying with the picture or refusing to draw one. What must never happen is
 * the two disagreeing about which side of a star boundary a value falls on, which is why
 * both are computed here from the same integers rather than one from the other's string.
 *
 * The row is decoration — `Stars` marks it `aria-hidden` and the sentence beside it carries
 * the number and the count. A screen reader gets `4.2 จาก 5 · 12 รีวิว`, not five icons.
 */
export function starFills(tally: RatingTally): readonly StarFill[] {
  const { sum, count } = tally;
  if (count <= 0n) return Array.from({ length: STAR_COUNT }, (): StarFill => 'empty');

  // Nearest half star, half-up, in integers: halves = round(sum * 2 / count).
  const halves = (sum * 2n * 2n + count) / (count * 2n);

  return Array.from({ length: STAR_COUNT }, (_unused, index): StarFill => {
    const position = BigInt(index) * 2n;
    if (halves >= position + 2n) return 'full';
    if (halves === position + 1n) return 'half';
    return 'empty';
  });
}
