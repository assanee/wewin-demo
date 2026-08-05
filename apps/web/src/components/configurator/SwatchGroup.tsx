import { Check, Ban } from 'lucide-react';
import { OptionGroupBase, OptionLabel, type OptionGroupProps } from './OptionGroupBase';

export function SwatchGroup({ product, group, selected, states, onSelect }: OptionGroupProps) {
  return (
    <OptionGroupBase
      product={product}
      group={group}
      selected={selected}
      states={states}
      onSelect={onSelect}
      layoutClass="grid grid-cols-2 gap-2 md:grid-cols-[repeat(auto-fit,minmax(140px,1fr))]"
      renderOption={({ value, selected: isSelected, state }) => (
        <span
          className={`flex min-h-11 min-w-0 items-center gap-2 rounded-xs border px-2 py-1 transition-colors duration-180 ease-out ${
            state.blocked
              ? 'cursor-not-allowed border-line bg-panel-2/40 text-chalk-3'
              : isSelected
                ? 'border-sel-line bg-sel-bg text-chalk'
                : 'border-line bg-panel-2 text-chalk-2 hover:border-line-2'
          }`}
        >
          <span
            aria-hidden
            className={`h-5 w-5 shrink-0 rounded-xs border border-line ${state.blocked ? 'opacity-40' : ''}`}
            style={{ backgroundColor: value.swatchHex }}
          />
          <OptionLabel
            product={product}
            group={group}
            value={value}
            className={`min-w-0 flex-1 truncate text-small ${state.blocked ? 'line-through' : ''}`}
          />
          {state.blocked ? (
            <Ban size={13} aria-hidden className="shrink-0 text-danger" />
          ) : isSelected ? (
            <Check size={14} aria-hidden className="shrink-0" />
          ) : null}
        </span>
      )}
    />
  );
}
