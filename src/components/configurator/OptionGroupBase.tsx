import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import type { OptionValue, SkuGroup } from '../../types/catalog';
import type { OptionState } from '../../lib/optionStates';

export interface OptionRenderArgs {
  value: OptionValue;
  selected: boolean;
  state: OptionState;
}

interface OptionGroupBaseProps {
  group: SkuGroup;
  selected: string;
  states: Record<string, OptionState>;
  onSelect: (code: string) => void;
  renderOption: (args: OptionRenderArgs) => ReactNode;
  /** Tailwind classes for the option container. */
  layoutClass: string;
}

const MOVE_KEYS = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'];

/**
 * The radiogroup behaviour shared by swatches, chips and toggles.
 *
 * One implementation rather than three: spec section 7 requires arrow-key navigation
 * on these groups, and three hand-rolled copies would drift.
 *
 * Blocked options stay focusable and keep `aria-disabled` rather than taking the
 * `disabled` attribute. A `disabled` control fires no events, so on a touch device
 * there is no way to surface why it cannot be chosen — and spec section 6 is explicit
 * that the customer must be able to find that out.
 */
export function OptionGroupBase({
  group,
  selected,
  states,
  onSelect,
  renderOption,
  layoutClass,
}: OptionGroupBaseProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  const focusAt = (index: number) => {
    const buttons = containerRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    if (!buttons) return;

    const wrapped = (index + buttons.length) % buttons.length;
    const target = buttons[wrapped];
    if (!target) return;

    target.focus();

    // Radiogroup convention: moving selects. A blocked option can be reached and
    // read, but arrowing onto it must not silently commit an invalid configuration.
    const code = target.dataset['code'];
    if (code && !states[code]?.blocked) onSelect(code);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!MOVE_KEYS.includes(event.key)) return;

    const buttons = [...(containerRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [])];
    const current = buttons.findIndex((button) => button === document.activeElement);
    if (current === -1) return;

    event.preventDefault();

    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        focusAt(current + 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        focusAt(current - 1);
        break;
      case 'Home':
        focusAt(0);
        break;
      case 'End':
        focusAt(buttons.length - 1);
        break;
    }
  };

  return (
    <div
      ref={containerRef}
      role="radiogroup"
      aria-label={group.labelTh}
      onKeyDown={onKeyDown}
      className={layoutClass}
    >
      {group.values.map((value) => {
        const state = states[value.code] ?? { blocked: false };
        const isSelected = value.code === selected;

        return (
          <button
            key={value.code}
            type="button"
            role="radio"
            data-code={value.code}
            aria-checked={isSelected}
            aria-disabled={state.blocked || undefined}
            // Roving tabindex: one stop per group, then arrows move within it.
            tabIndex={isSelected ? 0 : -1}
            title={state.blocked ? state.reasonTh : state.warnTh}
            onClick={() => {
              if (!state.blocked) onSelect(value.code);
            }}
            className="min-w-0 text-start"
          >
            {renderOption({ value, selected: isSelected, state })}
          </button>
        );
      })}
    </div>
  );
}
