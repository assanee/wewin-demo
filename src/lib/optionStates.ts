import type { Product, SkuGroup } from '../types/catalog';
import { validate } from './validation';

export interface OptionState {
  blocked: boolean;
  /** Why it cannot be chosen — shown as a tooltip on the struck-through option. */
  reasonTh?: string;
  /** Non-blocking caveat attached to choosing it. */
  warnTh?: string;
}

/** groupCode -> valueCode -> state */
export type OptionStates = Record<string, Record<string, OptionState>>;

const OUT_OF_STOCK_TH = 'ตอนนี้สีนี้ยังไม่พร้อมผลิต';

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
  measures: Record<string, number>,
): OptionStates {
  const states: OptionStates = {};

  for (const group of skuGroups(product)) {
    const groupStates: Record<string, OptionState> = {};

    for (const value of group.values) {
      if (!value.available) {
        groupStates[value.code] = { blocked: true, reasonTh: OUT_OF_STOCK_TH };
        continue;
      }

      const candidate = { ...selections, [group.code]: value.code };
      const issues = validate(product, candidate, measures);
      const relevant = issues.filter((issue) => issue.affects.includes(group.code));

      const error = relevant.find((issue) => issue.severity === 'error');
      const warning = relevant.find((issue) => issue.severity === 'warning');

      const state: OptionState = { blocked: error !== undefined };
      if (error) state.reasonTh = error.messageTh;
      if (warning) state.warnTh = warning.messageTh;

      groupStates[value.code] = state;
    }

    states[group.code] = groupStates;
  }

  return states;
}
