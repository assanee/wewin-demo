import { useEffect, useId, useRef, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import type { CustomGroup, LengthUnit } from '@wewin/core';
import { gridFor } from '@wewin/core/validation';
import { parseMeasure, snapUpUm } from '@wewin/core/units';
import { formatLength, formatMeasure, formatRange } from '@wewin/core/format';

interface MeasureInputProps {
  group: CustomGroup;
  /** Canonical micrometres, like every other length in the app. */
  value: bigint;
  onChange: (next: bigint) => void;
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
 */
export function MeasureInput({ group, value, onChange, invalid = false }: MeasureInputProps) {
  const inputId = useId();
  const helperId = useId();

  // The unit this field is read and written in. The catalogue's own for now, and the
  // single line that has to change when the display-unit picker arrives, because
  // every format and every parse below already asks it rather than assuming cm.
  const unit: LengthUnit = group.unit;
  const grid = gridFor(group, unit);
  const rendered = formatLength(value, unit);

  const [text, setText] = useState(rendered);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editingRef = useRef(false);

  // Adopt a value that changed elsewhere — the stepper, the snap on blur, undo,
  // loading a saved line — by comparing what the field *would show* against what it
  // shows. The old `Number.parseFloat(text) !== value` compares a number with a
  // bigint and is therefore true on every render, which would rewrite the field from
  // under the caret forever.
  //
  // Skipped while the field has focus. Typing commits a snapped value, so mid-entry
  // the canonical length legitimately renders as something other than the half-typed
  // text; blur is what reconciles the two, and it does so itself.
  useEffect(() => {
    if (!editingRef.current) setText(rendered);
  }, [rendered]);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const clearPending = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  };

  const commitDebounced = (next: bigint) => {
    clearPending();
    timerRef.current = setTimeout(() => onChange(next), DEBOUNCE_MS);
  };

  const commitNow = (next: bigint) => {
    clearPending();
    onChange(next);
  };

  // The marks the ± buttons move to. `value + 1n` rather than `value + grid`: from a
  // value already on the grid the next mark up is one step away, but from one that is
  // not — a shared link, a line saved before a step changed — it is the snap itself,
  // and adding a whole step would jump over the mark in between.
  const nextUp = snapUpUm(value + 1n, grid);
  // Snapping up from one step below lands on the greatest mark strictly under
  // `value`, whichever side of the grid `value` sits on. That is not a snap *down*
  // sneaking back in: pressing − is the customer asking for a smaller window, not a
  // value being quietly corrected to one.
  const nextDown = snapUpUm(value - grid, grid);

  const atMin = nextDown < group.minUm;
  const atMax = nextUp > group.maxUm;

  const step = (next: bigint) => {
    setText(formatLength(next, unit));
    commitNow(next);
  };

  const onBlur = () => {
    editingRef.current = false;
    // Whatever the debounce was still holding is about to be superseded, and it was
    // parsed from older text.
    clearPending();

    // A blur that follows no edit must not move the value — clicking into a field
    // and back out is not permission to resize a window. Rendered strings decide it,
    // because re-reading the field's own text is exactly the round trip that is
    // allowed to be lossy: 320 cm shown as 126 3/16" and typed straight back is a
    // different window.
    if (text === rendered) return;

    // Spec section 6: snap up to the nearest valid step on blur. An unreadable or
    // empty field falls back to the default rather than throwing out of an event
    // handler, which is why `parseMeasure` reports failure as null.
    const next = parseMeasure(text, unit, group) ?? group.defaultUm;
    setText(formatLength(next, unit));
    commitNow(next);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={inputId} className="flex items-baseline justify-between gap-2 text-body text-chalk">
        <span className="min-w-0 truncate">{group.labelTh}</span>
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
          aria-label={`ลด${group.labelTh} ${formatMeasure(grid, unit)}`}
          className="flex h-11 w-11 shrink-0 items-center justify-center border-e border-line bg-panel-2 text-chalk-2 transition-colors duration-180 ease-out hover:text-chalk disabled:opacity-30"
        >
          <Minus size={16} aria-hidden />
        </button>

        <input
          id={inputId}
          type="number"
          // Brings up the numeric keypad with a decimal key on mobile.
          inputMode="decimal"
          value={text}
          // The bounds a browser enforces are in whatever unit the field displays, so
          // they are formatted, not converted — the same single exit as the value.
          min={formatLength(group.minUm, unit)}
          max={formatLength(group.maxUm, unit)}
          step={formatLength(grid, unit)}
          aria-describedby={helperId}
          aria-invalid={invalid || undefined}
          onFocus={() => {
            editingRef.current = true;
          }}
          onChange={(event) => {
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
          aria-label={`เพิ่ม${group.labelTh} ${formatMeasure(grid, unit)}`}
          className="flex h-11 w-11 shrink-0 items-center justify-center border-s border-line bg-panel-2 text-chalk-2 transition-colors duration-180 ease-out hover:text-chalk disabled:opacity-30"
        >
          <Plus size={16} aria-hidden />
        </button>
      </div>

      <p id={helperId} className="numeric text-caption text-chalk-3">
        {formatRange(group.minUm, group.maxUm, unit)} · ทีละ {formatLength(grid, unit)}
        {group.helperTh ? <span className="font-body"> · {group.helperTh}</span> : null}
      </p>
    </div>
  );
}
