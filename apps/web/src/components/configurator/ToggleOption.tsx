import { Ban } from 'lucide-react';
import type { SkuGroup } from '@wewin/core';
import type { OptionState } from '@wewin/core/option-states';
import { OptionGroupBase } from './OptionGroupBase';

interface ToggleOptionProps {
  group: SkuGroup;
  selected: string;
  states: Record<string, OptionState>;
  onSelect: (code: string) => void;
}

/**
 * A two-value sku group. Rendered as a segmented control rather than a switch:
 * both states are named options that appear in the sku_code, and a switch would
 * hide the name of the state you are not in.
 */
export function ToggleOption({ group, selected, states, onSelect }: ToggleOptionProps) {
  return (
    <OptionGroupBase
      group={group}
      selected={selected}
      states={states}
      onSelect={onSelect}
      layoutClass="grid grid-cols-2 gap-0 overflow-hidden rounded-xs border border-line"
      renderOption={({ value, selected: isSelected, state }) => (
        <span
          className={`flex min-h-11 min-w-0 items-center justify-center gap-2 px-3 text-center transition-colors duration-180 ease-out ${
            state.blocked
              ? 'cursor-not-allowed bg-panel-2/40 text-chalk-3'
              : isSelected
                ? 'bg-sel-bg text-chalk'
                : 'bg-panel-2 text-chalk-2 hover:text-chalk'
          }`}
        >
          <span className={`min-w-0 truncate text-small ${state.blocked ? 'line-through' : ''}`}>
            {value.labelTh}
          </span>
          {state.blocked ? <Ban size={13} aria-hidden className="shrink-0 text-danger" /> : null}
        </span>
      )}
    />
  );
}
