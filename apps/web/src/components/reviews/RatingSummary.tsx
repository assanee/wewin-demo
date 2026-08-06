import type { ReactElement } from 'react';

import type { LocaleBundle } from '../../i18n/server';
import { starFills, type RatingTally } from '../../lib/reviews/average';
import { Stars } from './Stars';

/**
 * The average **and its count**, which in this app is one thing and not two.
 *
 * Plan 9.5's rule is enforced three times over, deliberately, because it is the kind of
 * rule that survives review and dies in a refactor:
 *
 *   in the database — `product_review_stats` exposes `rating_sum` and `rating_count` and
 *   **has no average column**, so no query can select a mean on its own;
 *
 *   in the catalogue — `review.summary` is a single key taking `{ sum, count }`, so there
 *   is no second key a component could render alone and no entry a translator could write
 *   without both;
 *
 *   here — this component takes a `RatingTally`, never a number, and it is the only place
 *   in `apps/web` that renders one.
 *
 * A future contributor who wants "just the stars, in the header" has to add a key, add an
 * entry in two catalogues and edit this file. That is three visible acts, which is the
 * point: "5.0 ★" from a single review is an advertisement, and it should cost something to
 * put one on a page.
 */
export function RatingSummary({
  tally,
  l,
}: {
  readonly tally: RatingTally;
  readonly l: LocaleBundle;
}): ReactElement {
  return (
    <p className="flex flex-wrap items-center gap-2 text-body text-chalk">
      <Stars fills={starFills(tally)} />
      {/* No `numeric` here. That utility is for a measurement, a price or a code — this is
          a sentence with numbers in it, and setting Thai prose in the mono face to get
          tabular digits would be the tail wagging the dog. */}
      <span>{l.t('review.summary', { ratingSum: tally.sum, ratingCount: tally.count })}</span>
    </p>
  );
}
