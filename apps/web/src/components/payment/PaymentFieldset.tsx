import type { ReactElement, ReactNode } from 'react';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * A grouped section that is still a `<fieldset>`.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * This screen was built to prove the slip API worked — its own header records that the API
 * "has been complete and tested since task 10; nothing in `apps/web` called it" — and it
 * showed: alone among the storefront's pages it drew a browser-default `<fieldset>`, border
 * and notched legend and all, next to `AccountScreen`'s `<section>` + `<h2>` panels. Two
 * groupings that mean the same thing, drawn two different ways, on one page.
 *
 * ── ⚠️ The element does not change, only its chrome ──────────────────────────
 *
 * `<fieldset>` + `<legend>` is the **correct** markup for the radio group in `AccountPicker`:
 * it is what tells a screen reader that six bank accounts are six options for one question,
 * and it is what makes the legend the group's accessible name. Swapping it for a `<div>` and
 * an `<h2>` would have made the notch go away by deleting the semantics — an accessibility
 * regression wearing a visual fix. So the element stays and the *painting* is replaced.
 *
 * ── How the notch is removed ─────────────────────────────────────────────────
 *
 * `float-left w-full` on the legend. A `<legend>` is normally taken out of flow and drawn
 * *into* the fieldset's top border by the UA, which is where the notch comes from; a floated
 * legend loses that special treatment and lays out as an ordinary block, so the border draws
 * unbroken behind it. `clear-both` on the body then puts the content back below the float.
 *
 * `min-w-0` is not decoration either: a `<fieldset>` has an intrinsic minimum width from its
 * contents that ignores `width`, which is what makes long account numbers push a flex or grid
 * parent wider than the viewport on a phone.
 *
 * The result is deliberately identical to `AccountScreen`'s `Section` — `border border-line
 * bg-panel p-4`, a `text-lead text-chalk` heading, `mt-3` before the body — because a
 * customer walking from `/account` to `/payment` should not be able to tell that two
 * different components drew the box.
 */
export function PaymentFieldset({
  legend,
  children,
}: {
  readonly legend: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <fieldset className="min-w-0 border border-line bg-panel p-4">
      <legend className="float-left w-full text-lead text-chalk">{legend}</legend>
      <div className="clear-both pt-3">{children}</div>
    </fieldset>
  );
}
