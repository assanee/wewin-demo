import {
  describeOwedFigures as coreDescribeOwedFigures,
  type Emphasis,
  type OwedFigure as CoreOwedFigure,
  type OwedLabelKey as CoreOwedLabelKey,
} from '@wewin/core/owed-figures';

import type { UiKey } from '../../i18n/keys';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ ONE FIGURE OR TWO, AND WHICH ONE LEADS — this app's door onto the shared rule.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The rule itself is `@wewin/core/owed-figures`, and the reasoning for every line of it is
 * there. It moved down out of this file when the **reminder email** became the third surface
 * to state these two figures: `apps/api` cannot import `apps/web`, and a rule restated in a
 * second file is a rule that has already begun to drift — which is the exact defect this
 * module was extracted to close in the first place.
 *
 * ── ⚠️ WHAT IS STILL DECIDED HERE, AND WHY IT IS NOT CEREMONY ────────────────
 *
 * `@wewin/core` has no catalogue, so it names the two labels as a literal union and cannot
 * check that they are real. This file can: `OwedLabelKey` intersects that union with `UiKey`,
 * and `describeOwedFigures` returns `readonly OwedFigure[]`, so if `payment.dueNow` were ever
 * renamed or dropped from `keys.ts` the intersection would narrow, core's return type would
 * stop being assignable, and **this file would fail to compile**. That is the only place in
 * the repository where the two halves are checked against each other.
 *
 * Both screens keep importing from here, and neither knows the difference.
 */

export type { Emphasis };

/** The two catalogue keys, proven against `UiKey` — see above. */
export type OwedLabelKey = Extract<UiKey, CoreOwedLabelKey>;

export interface OwedFigure extends Omit<CoreOwedFigure, 'labelKey'> {
  readonly labelKey: OwedLabelKey;
}

/** `@wewin/core/owed-figures`'s answer, re-typed against this app's catalogue. */
export function describeOwedFigures(
  outstandingMinor: bigint,
  nextDueMinor: bigint,
): readonly OwedFigure[] {
  return coreDescribeOwedFigures(outstandingMinor, nextDueMinor);
}
