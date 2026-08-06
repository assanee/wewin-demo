'use client';

import type { ReactElement } from 'react';

import { useDisplayUnit } from '../../state/displayUnitContext';
import type { UnitVariants } from './unitVariants';

/**
 * The whole client half of plan 8.2's third trap: **five strings in, one string out.**
 *
 * Everything numeric here was written by Node during the prerender, from `bigint`
 * micrometres, through `@wewin/i18n`. This component does not format, does not divide and
 * does not see a length — it indexes. That is what keeps the cached page free of any
 * visitor's preference (it always renders the `cm` default) while still letting a visitor
 * who has chosen inches read inches, and it is also what makes the component immune to the
 * `my` numeral split the scaffold's README found: a string that was produced once, on one
 * runtime, cannot disagree with itself across a hydration boundary.
 *
 * `useDisplayUnit` returns `cm` until `DisplayUnitProvider`'s mount effect has read
 * `aluform.displayUnit.v1`, so the server HTML and the first client render are the same
 * string by construction, and the upgrade is a second commit — exactly the sequence the
 * Vite app already had, and the reason its provider reads storage from an effect.
 */
export function UnitText({ variants }: { readonly variants: UnitVariants }): ReactElement {
  const { unit } = useDisplayUnit();
  return <>{variants[unit]}</>;
}
