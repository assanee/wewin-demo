import { useEffect, useId, useRef, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import type { CustomGroup } from '../../types/catalog';
import { snapToStep } from '../../lib/validation';
import { formatCm } from '../../lib/format';

interface MeasureInputProps {
  group: CustomGroup;
  value: number;
  onChange: (next: number) => void;
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
 */
export function MeasureInput({ group, value, onChange, invalid = false }: MeasureInputProps) {
  const inputId = useId();
  const helperId = useId();
  const [text, setText] = useState(() => String(value));
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Adopt values that changed elsewhere (stepping, snapping, loading a saved line)
  // without fighting the user mid-keystroke.
  useEffect(() => {
    if (Number.parseFloat(text) !== value) setText(String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- text is intentionally not a trigger
  }, [value]);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const commitDebounced = (next: number) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => onChange(next), DEBOUNCE_MS);
  };

  const commitNow = (next: number) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    onChange(next);
  };

  const step = (direction: 1 | -1) => {
    const base = Number.isFinite(value) ? value : group.defaultValue;
    const next = Math.min(Math.max(base + direction * group.step, group.min), group.max);
    // Re-round to the step's precision so repeated 0.5 steps never drift.
    const decimals = (String(group.step).split('.')[1] ?? '').length;
    const rounded = Number(next.toFixed(decimals));
    setText(String(rounded));
    commitNow(rounded);
  };

  const onBlur = () => {
    const parsed = Number.parseFloat(text);
    // Spec section 6: snap up to the nearest valid step on blur.
    const snapped = Number.isFinite(parsed) ? snapToStep(group, parsed) : group.defaultValue;
    setText(String(snapped));
    commitNow(snapped);
  };

  const atMin = value <= group.min;
  const atMax = value >= group.max;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={inputId} className="flex items-baseline justify-between gap-2 text-body text-chalk">
        <span className="min-w-0 truncate">{group.labelTh}</span>
        <span className="numeric shrink-0 text-caption text-chalk-3">{group.unit}</span>
      </label>

      <div
        className={`flex items-stretch overflow-hidden rounded-xs border transition-colors duration-180 ease-out ${
          invalid ? 'border-danger' : 'border-line focus-within:border-line-2'
        }`}
      >
        <button
          type="button"
          onClick={() => step(-1)}
          disabled={atMin}
          aria-label={`ลด${group.labelTh} ${group.step} ${group.unit}`}
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
          min={group.min}
          max={group.max}
          step={group.step}
          aria-describedby={helperId}
          aria-invalid={invalid || undefined}
          onChange={(event) => {
            setText(event.target.value);
            const parsed = Number.parseFloat(event.target.value);
            if (Number.isFinite(parsed)) commitDebounced(parsed);
          }}
          onBlur={onBlur}
          className="numeric min-w-0 flex-1 bg-panel-2 px-3 text-center text-lead text-chalk outline-none"
        />

        <button
          type="button"
          onClick={() => step(1)}
          disabled={atMax}
          aria-label={`เพิ่ม${group.labelTh} ${group.step} ${group.unit}`}
          className="flex h-11 w-11 shrink-0 items-center justify-center border-s border-line bg-panel-2 text-chalk-2 transition-colors duration-180 ease-out hover:text-chalk disabled:opacity-30"
        >
          <Plus size={16} aria-hidden />
        </button>
      </div>

      <p id={helperId} className="numeric text-caption text-chalk-3">
        {formatCm(group.min)}–{formatCm(group.max)} {group.unit} · ทีละ {formatCm(group.step)}
        {group.helperTh ? <span className="font-body"> · {group.helperTh}</span> : null}
      </p>
    </div>
  );
}
