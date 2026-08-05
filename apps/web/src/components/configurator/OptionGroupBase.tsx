import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import type { OptionValue, Product, SkuGroup } from '@wewin/core';
import type { OptionState } from '@wewin/core/option-states';
import { CatalogText } from '../common/CatalogText';
import { useCatalogText } from '../../i18n/useCatalogText';
import { useLocale } from '../../state/localeContext';

export interface OptionRenderArgs {
  value: OptionValue;
  selected: boolean;
  state: OptionState;
}

/**
 * What the three skins — swatches, chips, toggles — all take.
 *
 * Named and shared because `product` is new this round and had to be threaded through
 * every one of them: a catalogue string is addressed per product version, since two
 * products both have a `width` group and may word it differently. Declaring the shape
 * once means a fourth skin cannot quietly omit it.
 */
export interface OptionGroupProps {
  product: Product;
  group: SkuGroup;
  selected: string;
  states: Record<string, OptionState>;
  onSelect: (code: string) => void;
}

interface OptionGroupBaseProps extends OptionGroupProps {
  renderOption: (args: OptionRenderArgs) => ReactNode;
  /** Tailwind classes for the option container. */
  layoutClass: string;
}

/**
 * An option's own name, marked `lang="th"` while its translation is missing.
 *
 * One component rather than three copies of the ref literal: the ref is what a
 * translated catalogue is looked up by, and three hand-written copies of it would be
 * three chances to drop `productId` and silently return another product's word.
 */
export function OptionLabel({
  product,
  group,
  value,
  className,
}: {
  product: Product;
  group: SkuGroup;
  value: OptionValue;
  className?: string;
}) {
  return (
    <CatalogText
      at={{
        on: 'optionLabel',
        productId: product.id,
        groupCode: group.code,
        valueCode: value.code,
      }}
      th={value.labelTh}
      {...(className === undefined ? {} : { className })}
    />
  );
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
  product,
  group,
  selected,
  states,
  onSelect,
  renderOption,
  layoutClass,
}: OptionGroupBaseProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { message } = useLocale();
  const catalogText = useCatalogText();

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
      // An accessible name is an attribute value, so it cannot carry a `lang` marker
      // the way visible text can — this is the one place a Thai fallback goes into a
      // German page unannounced. Named here rather than left to be discovered.
      aria-label={catalogText(
        { on: 'groupLabel', productId: product.id, groupCode: group.code },
        group.labelTh,
      )}
      onKeyDown={onKeyDown}
      className={layoutClass}
    >
      {group.values.map((value) => {
        const state = states[value.code] ?? { blocked: false };
        const isSelected = value.code === selected;

        // `reasonTh`/`warnTh` were sentences `optionStates.ts` built. They are
        // `Message` values now, and the *same* values the issue panel receives — which
        // is what stops the tooltip and the panel drifting into two translations of
        // one rule.
        const tooltip = state.blocked ? state.reason : state.warn;

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
            {...(tooltip ? { title: message(tooltip).text } : {})}
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
