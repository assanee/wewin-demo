import type { Product, SkuGroup } from './types/catalog.js';
import { groupLabel, type Message, optionLabel } from './message.js';
import { validate } from './validation.js';
import type { LengthUnit } from './units.js';

export interface OptionState {
  blocked: boolean;
  /**
   * Why it cannot be chosen — shown as a tooltip on the struck-through option.
   *
   * Renamed from `reasonTh`: a field whose name says Thai and whose value is a
   * locale-free message is a lie the next reader has to discover for themselves.
   */
  reason?: Message;
  /** Non-blocking caveat attached to choosing it. */
  warn?: Message;
}

/** groupCode -> valueCode -> state */
export type OptionStates = Record<string, Record<string, OptionState>>;

const skuGroups = (product: Product): SkuGroup[] =>
  product.groups.filter((group): group is SkuGroup => group.kind === 'sku');

/**
 * Work out, for every sku option, whether picking it would be a mistake.
 *
 * Spec section 6 wants blocked options struck through and explained rather than
 * hidden, so the customer learns the option exists and why it does not apply here.
 *
 * The subtle part is deciding what counts as "this option's fault". Simply asking
 * "does choosing this produce an error?" is wrong: if the opening is already over
 * the 8 sqm cap, every option produces that same error and the whole panel would
 * strike itself out, blaming the glass colour for a size problem. So an option is
 * blocked only when the resulting error names its own group in `affects` — which
 * the rule AST derives automatically (see affectedGroups in validation.ts).
 */
export function optionStatesFor(
  product: Product,
  selections: Record<string, string>,
  measures: Record<string, bigint>,
  enteredUnits: Record<string, LengthUnit> = {},
): OptionStates {
  const states: OptionStates = {};

  for (const group of skuGroups(product)) {
    const groupStates: Record<string, OptionState> = {};

    for (const value of group.values) {
      if (!value.available) {
        // The Thai constant this replaces read "ตอนนี้สีนี้ยังไม่พร้อมผลิต" — "this
        // *colour* is not available" — and was returned for every sku group, including
        // `insect_screen` and `lock_type`. Naming the group and the value as params
        // rather than baking one group's noun into the sentence fixes that on the way
        // past: the locale writes one sentence with two holes in it.
        groupStates[value.code] = {
          blocked: true,
          reason: {
            key: 'option.unavailable',
            params: {
              group: groupLabel(product, group),
              option: optionLabel(product, group, value),
            },
          },
        };
        continue;
      }

      const candidate = { ...selections, [group.code]: value.code };
      const issues = validate(product, candidate, measures, enteredUnits);
      const relevant = issues.filter((issue) => issue.affects.includes(group.code));

      const error = relevant.find((issue) => issue.severity === 'error');
      const warning = relevant.find((issue) => issue.severity === 'warning');

      const state: OptionState = { blocked: error !== undefined };
      if (error) state.reason = error.message;
      if (warning) state.warn = warning.message;

      groupStates[value.code] = state;
    }

    states[group.code] = groupStates;
  }

  return states;
}
