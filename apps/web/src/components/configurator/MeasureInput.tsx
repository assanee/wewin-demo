import { useEffect, useId, useRef, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import type { CustomGroup, LengthUnit, Product } from '@wewin/core';
import { gridFor } from '@wewin/core/validation';
import { parseMeasure, snapUpUm } from '@wewin/core/units';
import { formatLength } from '@wewin/core/format';
import { useDisplayUnit } from '../../state/displayUnitContext';
import { useLocale } from '../../state/localeContext';
import { CatalogText } from '../common/CatalogText';
import { useCatalogText } from '../../i18n/useCatalogText';
import { shouldCommitOnBlur } from './measureCommit';

interface MeasureInputProps {
  /** For the group's ref: a catalogue label is addressed per product version. */
  product: Product;
  group: CustomGroup;
  /** Canonical micrometres, like every other length in the app. */
  value: bigint;
  /**
   * The unit travels with the value because only this component knows it: by the time
   * the quote holds the line, the picker may say something else entirely.
   */
  onChange: (next: bigint, enteredUnit: LengthUnit) => void;
  invalid?: boolean;
}

const DEBOUNCE_MS = 120;

/**
 * A measurement field with its own - / + buttons.
 *
 * Spec section 8: typing a decimal on a phone keyboard is awkward, so stepping is
 * the primary interaction on mobile and the buttons are full 44px targets on both
 * sides of the field.
 *
 * Typing is debounced by 120ms (spec section 7) while stepping commits immediately —
 * a button press is already a deliberate, discrete act, and delaying its feedback
 * would make the price look broken.
 *
 * This is the only place a person types a length, which makes it the whole of the
 * input side of the unit boundary: all three ways to change the value — typing,
 * blurring, stepping — go through `parseMeasure`/`snapUpUm`, so they cannot land on
 * different answers the way they used to (typing 250.3 kept 250.3, blurring made it
 * 250.5, and the stepper snapped to nothing at all).
 *
 * And the rule the whole micrometre phase exists for: reading a size in another unit
 * is not editing it. A snap only ever happens on a value a person committed, on the
 * grid of the unit they were looking at when they committed it.
 */
export function MeasureInput({
  product,
  group,
  value,
  onChange,
  invalid = false,
}: MeasureInputProps) {
  const inputId = useId();
  const helperId = useId();
  const { t } = useLocale();
  const catalogText = useCatalogText();
  const groupRef = { on: 'groupLabel', productId: product.id, groupCode: group.code } as const;

  // The unit on screen, not the one the catalogue was authored in. Every format and
  // every parse below already asked for a unit rather than assuming cm, so this is
  // the single line that had to change — but nothing here writes it back.
  const { unit } = useDisplayUnit();
  const imperial = unit === 'in' || unit === 'ft';
  const grid = gridFor(group, unit);
  // **Core's rendering, not the locale's — the one number on the site that stays
  // canonical.** Everything else on screen goes through `Formatters`, which writes
  // digits, separators and grouping the way CLDR says the locale does. This string
  // does not, because it is not only displayed: `parseMeasure` reads it straight back
  // on blur and on every ± press. Handing the field `၃၂၀` or `320,5` would mean
  // `parseMeasure` returning `null`, the blur falling through to `group.defaultUm`,
  // and a window silently resizing itself because somebody changed language.
  //
  // The input is therefore ASCII with a `.` point in all eight locales, and the
  // helper line underneath — which nobody types into — is localised normally. That
  // asymmetry is deliberate and it is the same boundary phase 2 drew: a value a
  // person types round-trips through one parser, and only the readings around it are
  // free to be written differently.
  const rendered = formatLength(value, unit);

  const [text, setText] = useState(rendered);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editingRef = useRef(false);
  // Set by a keystroke and by nothing else. It is what separates "the customer said a
  // new size" from "the same size is being shown differently", and it has to be
  // tracked rather than inferred: parsing the text and comparing it to the canonical
  // value says "changed" forever across a unit switch, because 320 cm read back from
  // `126 3/16"` genuinely is a different number — which would let a blur rebuild an
  // untouched window at 3,200,400 µm, the exact hazard the phase was written for.
  const dirtyRef = useRef(false);
  const shownUnitRef = useRef(unit);

  useEffect(() => {
    const unitChanged = shownUnitRef.current !== unit;
    shownUnitRef.current = unit;

    // Switching the display unit re-renders one size in another unit: not an edit, so
    // no snap, no commit, and no entered unit recorded. Half-typed text does not
    // survive it either — `82 1/2` means something else in centimetres — so the field
    // goes back to the canonical value rather than reinterpreting what is in it.
    if (unitChanged) dirtyRef.current = false;

    // Otherwise adopt a value that changed elsewhere — the stepper, the snap on blur,
    // undo, loading a saved line — by comparing what the field *would show* against
    // what it shows. The old `Number.parseFloat(text) !== value` compares a number
    // with a bigint and is therefore true on every render, which would rewrite the
    // field from under the caret forever.
    //
    // Skipped while the field has focus. Typing commits a snapped value, so mid-entry
    // the canonical length legitimately renders as something other than the half-typed
    // text; blur is what reconciles the two, and it does so itself.
    if (unitChanged || !editingRef.current) setText(rendered);
  }, [rendered, unit]);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const clearPending = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  };

  // `unit` is the one that was on screen when this was typed, and the closure keeps it
  // that way: if the picker moves before the timer fires, the line still remembers the
  // unit the customer actually spoke in.
  const commitDebounced = (next: bigint) => {
    clearPending();
    timerRef.current = setTimeout(() => onChange(next, unit), DEBOUNCE_MS);
  };

  const commitNow = (next: bigint) => {
    clearPending();
    dirtyRef.current = false;
    onChange(next, unit);
  };

  // The marks the ± buttons move to. `value + 1n` rather than `value + grid`: from a
  // value already on the grid the next mark up is one step away, but from one that is
  // not — a shared link, a line saved before a step changed, a metric size being read
  // in inches — it is the snap itself, and adding a whole step would jump over the
  // mark in between.
  const nextUp = snapUpUm(value + 1n, grid);
  // Snapping up from one step below lands on the greatest mark strictly under
  // `value`, whichever side of the grid `value` sits on. That is not a snap *down*
  // sneaking back in: pressing − is the customer asking for a smaller window, not a
  // value being quietly corrected to one.
  const nextDown = snapUpUm(value - grid, grid);

  const atMin = nextDown < group.minUm;
  const atMax = nextUp > group.maxUm;

  // A ± press is a deliberate size in the unit on screen, so it ends where the keyboard
  // does instead of committing a number of its own. The mark is already on `grid`, so
  // rendering it and reading it straight back is exact — the round trip costs nothing
  // and buys one snap, one grid and one recorded unit for all three entry paths.
  const step = (mark: bigint) => {
    const marked = formatLength(mark, unit);
    setText(marked);
    commitNow(parseMeasure(marked, unit, group) ?? mark);
  };

  const onBlur = () => {
    editingRef.current = false;
    // Whatever the debounce was still holding is about to be superseded, and it was
    // parsed from older text.
    clearPending();

    // A blur that follows no edit must not move the value — clicking into a field and
    // back out, or switching the picker to inches, is not permission to resize a
    // window. The string compare is the cheaper of the two guards but the flag is the
    // one that matters: only a keystroke sets it, so a field that merely got looked at
    // in another unit cannot reach the snap below.
    if (!shouldCommitOnBlur(dirtyRef.current, text, rendered)) {
      dirtyRef.current = false;
      return;
    }

    // Spec section 6: snap up to the nearest valid step on blur, on the grid of the
    // unit it was typed in. An unreadable or empty field falls back to the default
    // rather than throwing out of an event handler, which is why `parseMeasure`
    // reports failure as null.
    const next = parseMeasure(text, unit, group) ?? group.defaultUm;
    setText(formatLength(next, unit));
    commitNow(next);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={inputId} className="flex items-baseline justify-between gap-2 text-body text-chalk">
        <CatalogText at={groupRef} th={group.labelTh} className="min-w-0 truncate" />
        <span className="numeric shrink-0 text-caption text-chalk-3">{unit}</span>
      </label>

      <div
        className={`flex items-stretch overflow-hidden rounded-xs border transition-colors duration-180 ease-out ${
          invalid ? 'border-danger' : 'border-line focus-within:border-line-2'
        }`}
      >
        <button
          type="button"
          onClick={() => step(nextDown)}
          disabled={atMin}
          aria-label={t('measure.decrease', {
            group: catalogText(groupRef, group.labelTh),
            stepUm: grid,
            unit,
          })}
          className="flex h-11 w-11 shrink-0 items-center justify-center border-e border-line bg-panel-2 text-chalk-2 transition-colors duration-180 ease-out hover:text-chalk disabled:opacity-30"
        >
          <Minus size={16} aria-hidden />
        </button>

        <input
          id={inputId}
          // Text, not `number`. An inch reads `82 1/2"` and a foot `4' 3 1/2"`; a
          // number field shows an empty box for both and drops what it cannot parse,
          // which here would mean losing the size rather than displaying it. The same
          // goes for `min`/`max`/`step`, so the bounds are stated in the helper line
          // under the field, where they are also readable.
          type="text"
          // The decimal keypad has no space and no `/`, so imperial entry needs the
          // full keyboard to be typeable at all.
          inputMode={imperial ? 'text' : 'decimal'}
          autoComplete="off"
          value={text}
          aria-describedby={helperId}
          aria-invalid={invalid || undefined}
          onFocus={() => {
            editingRef.current = true;
            // A new session owes the value nothing until a key is actually pressed.
            dirtyRef.current = false;
          }}
          onChange={(event) => {
            dirtyRef.current = true;
            setText(event.target.value);
            const parsed = parseMeasure(event.target.value, unit, group);
            // Half-typed text — `250.`, an emptied field — parses to null and simply
            // does not commit, leaving the price on the last thing the customer
            // actually expressed.
            if (parsed !== null) commitDebounced(parsed);
          }}
          onBlur={onBlur}
          className="numeric min-w-0 flex-1 bg-panel-2 px-3 text-center text-lead text-chalk outline-none"
        />

        <button
          type="button"
          onClick={() => step(nextUp)}
          disabled={atMax}
          aria-label={t('measure.increase', {
            group: catalogText(groupRef, group.labelTh),
            stepUm: grid,
            unit,
          })}
          className="flex h-11 w-11 shrink-0 items-center justify-center border-s border-line bg-panel-2 text-chalk-2 transition-colors duration-180 ease-out hover:text-chalk disabled:opacity-30"
        >
          <Plus size={16} aria-hidden />
        </button>
      </div>

      <p id={helperId} className="numeric text-caption text-chalk-3">
        {t('measure.helper', { minUm: group.minUm, maxUm: group.maxUm, gridUm: grid, unit })}
        {group.helperTh ? (
          <span className="font-body">
            {' · '}
            <CatalogText
              at={{ on: 'groupHelper', productId: product.id, groupCode: group.code }}
              th={group.helperTh}
            />
          </span>
        ) : null}
      </p>
    </div>
  );
}
