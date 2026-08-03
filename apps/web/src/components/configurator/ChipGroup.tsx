import { Ban } from 'lucide-react';
import type { SkuGroup } from '@wewin/core';
import type { OptionState } from '@wewin/core/option-states';
import { OptionGroupBase } from './OptionGroupBase';

interface ChipGroupProps {
  group: SkuGroup;
  selected: string;
  states: Record<string, OptionState>;
  onSelect: (code: string) => void;
}

export function ChipGroup({ group, selected, states, onSelect }: ChipGroupProps) {
  return (
    <OptionGroupBase
      group={group}
      selected={selected}
      states={states}
      onSelect={onSelect}
      layoutClass="grid grid-cols-2 gap-2 md:grid-cols-[repeat(auto-fit,minmax(140px,1fr))]"
      renderOption={({ value, selected: isSelected, state }) => (
        <span
          className={`flex min-h-11 min-w-0 items-center justify-between gap-2 rounded-xs border px-3 py-1 transition-colors duration-180 ease-out ${
            state.blocked
              ? 'cursor-not-allowed border-line bg-panel-2/40 text-chalk-3'
              : isSelected
                ? 'border-sel-line bg-sel-bg text-chalk'
                : 'border-line bg-panel-2 text-chalk-2 hover:border-line-2'
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
