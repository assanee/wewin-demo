/**
 * One rule, in its own module — the split this codebase makes everywhere
 * (`Toast.tsx`/`useToast.ts`, `QuoteContext.tsx`/`useQuote.ts`,
 * `useDisplayUnit.tsx`/`displayUnitContext.ts`) and for the reason those files all
 * state: React Fast Refresh only remounts cleanly when a module exports components
 * **or** plain values, never both, so a helper exported beside `MeasureInput` would
 * silently turn every edit to that file into a full reload.
 */

/**
 * The blur guard, as a value a test can ask questions of.
 *
 * **Pulled out of `onBlur` and otherwise unchanged.** It is the rule the whole micrometre
 * phase exists for — plan 4.7's *"the danger is the re-snap, not the unit conversion"* —
 * and until now it lived three lines deep inside an event handler, where the only way to
 * check it was to drive a browser. That is the reason for the extraction and the only
 * change: the expression is `dirty && text !== rendered`, exactly as it was.
 *
 * Both halves are load-bearing and they fail differently:
 *
 *   - `dirty` is set by a **keystroke and by nothing else**, and is cleared when the
 *     display unit changes. It is what separates "the customer said a new size" from "the
 *     same size is being shown differently". It cannot be inferred by parsing the text and
 *     comparing: 320 cm read back from `126 3/16"` genuinely *is* a different number, so
 *     an inferred flag says "changed" forever across a unit switch and a blur would rebuild
 *     an untouched window at 3,200,400 µm.
 *   - `text !== rendered` is the cheaper guard and catches the case the flag cannot:
 *     typing a character and deleting it again leaves `dirty` true and the value alone.
 *
 * Returning `false` means the value does not move. That is the safe answer, and it is the
 * answer for a field that was merely focused, merely looked at in another unit, or typed
 * into and put back.
 */
export const shouldCommitOnBlur = (dirty: boolean, text: string, rendered: string): boolean =>
  dirty && text !== rendered;
