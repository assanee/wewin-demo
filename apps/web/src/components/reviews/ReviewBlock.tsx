import type { ReactElement } from 'react';

import { localeBundle } from '../../i18n/server';
import type { Locale } from '../../i18n/locales';
import { loadProductReviews } from '../../lib/reviews/api';
import type { ProductReviewsWire } from '../../lib/reviews/wire';
import { RatingSummary } from './RatingSummary';
import { ReviewCard } from './ReviewCard';

/**
 * The review block on a product page — **and the decision that it usually is not there.**
 *
 * ── Plan 9.5, the sentence this component exists to obey ─────────────────────────
 *
 * > The system will have no reviews for months (81 products, 0 orders today) → hide the
 * > whole block until there are real ones. Do not print "no reviews yet" on 81 pages.
 *
 * "No reviews yet" is not a neutral statement on a shop's product page. Eighty-one of them
 * is a site telling every visitor that nobody has ever bought anything — which is *true*
 * today and is exactly why it should not be the design. Silence says nothing; an empty
 * state says something, and what it says is bad and unnecessary.
 *
 * The database made this the natural implementation rather than a discipline:
 * `product_review_stats` is a `GROUP BY`, so a product with nothing to say produces **no
 * row at all** — not a row of zeroes. That travels the wire as `stats: null` (the decoder
 * refuses a zeroed stats object for the same reason) and arrives here as `return null`.
 *
 * Every other way this can fail lands in the same place: no API configured, API
 * unreachable, non-2xx, a body this bundle does not recognise. One outcome, one line, no
 * partial block, no skeleton that never fills, and no possibility of a page that says
 * "reviews unavailable" — which would be the empty state again, wearing a different hat.
 *
 * ── What is rendered when there *is* something ───────────────────────────────────
 *
 * The average never appears without its count (`RatingSummary`, and the single catalogue
 * key behind it). Hidden reviews are counted in the average and the block says so out loud
 * when there are any — plan 9.3 makes hiding cost a reason and a name and keeps the rating
 * counting, and a reader who cannot see that the count and the list disagree would
 * reasonably assume the missing ones were deleted.
 */

/**
 * How many review cards a product page carries.
 *
 * Not a page size and not paging: there is no "next page" and there is deliberately no
 * `?page=2` — `searchParams` on a page is plan 8.2's second trap and would opt all 648
 * routes out of the prerender. When there are more than this, the block says how many more
 * and stops. The day that is not enough, the fix is a route that is dynamic *by design*,
 * not a query parameter bolted to a static one.
 */
export const REVIEWS_SHOWN = 8;

/** The rendering, separated from the fetch so a test can hand it a body it wrote. */
export function ReviewBlockContent({
  data,
  locale,
}: {
  readonly data: ProductReviewsWire;
  readonly locale: Locale;
}): ReactElement | null {
  const { stats, reviews } = data;

  /*
   * No stats means no moderated review anywhere on this product — the block does not exist.
   *
   * The second half of the condition is the case that looks impossible and is not: every
   * review moderated so far is *hidden*. The ratings still count (plan 9.3), so there is an
   * average — but there is nothing to read, and a heading over a lone number with no words
   * under it is the empty state again. Hidden means hidden.
   */
  if (stats === null || stats.visibleCount === 0n) return null;

  const l = localeBundle(locale);
  const { t } = l;
  const hidden = stats.ratingCount - stats.visibleCount;
  const shown = reviews.slice(0, REVIEWS_SHOWN);
  const remaining = BigInt(reviews.length - shown.length);

  return (
    <section aria-labelledby="reviews-heading" className="mt-10 border-t border-line pt-8 md:mt-12">
      <h2 id="reviews-heading" className="text-title text-chalk">
        {t('review.heading')}
      </h2>

      <div className="mt-3">
        <RatingSummary tally={{ sum: stats.ratingSum, count: stats.ratingCount }} l={l} />
        {hidden > 0n ? (
          <p className="mt-1 text-caption text-chalk-3">{t('review.hiddenNote', { hidden })}</p>
        ) : null}
      </div>

      <ul className="mt-5 flex flex-col gap-3">
        {shown.map((review) => (
          <li key={review.id}>
            <ReviewCard review={review} l={l} />
          </li>
        ))}
      </ul>

      {remaining > 0n ? (
        <p className="mt-3 text-caption text-chalk-3">{t('review.more', { remaining })}</p>
      ) : null}
    </section>
  );
}

/**
 * The server half: one tag-cached fetch, and nothing rendered unless it came back with
 * something worth rendering.
 */
export async function ReviewBlock({
  productId,
  locale,
}: {
  readonly productId: string;
  readonly locale: Locale;
}): Promise<ReactElement | null> {
  const result = await loadProductReviews(productId);
  if (!result.ok) return null;

  return <ReviewBlockContent data={result.data} locale={locale} />;
}
