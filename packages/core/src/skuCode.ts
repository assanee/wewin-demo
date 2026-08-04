import { resolveSelection } from './selection.js';
import type { Product, SkuGroup } from './types/catalog.js';

/**
 * Compose the sku_code from the sku-kind selections (spec section 3).
 *
 *   {skuPrefix}-{code of every SkuGroup with includeInSkuCode, in groups[] order}
 *   e.g. AWN4T-DW-GRN-T5-NS0
 *
 * Custom groups never contribute: a different width is the same SKU at a different
 * size, not a different stocked variant.
 *
 * ⚠️ **Every segment is a code the catalogue actually offers.** This used to upper-case
 * whatever string it was handed, which meant a selection `pricing.ts` had refused to
 * recognise still appeared in the SKU — so an order could be priced manual and stamped
 * motorised, and the production sheet renders from the stamp. The two readers now share one
 * resolution (`selection.ts`), which is what makes "the price and the SKU describe the same
 * window" a property of the code rather than a thing to remember.
 */
export function buildSkuCode(product: Product, selections: Record<string, string>): string {
  const parts = product.groups
    .filter((group): group is SkuGroup => group.kind === 'sku' && group.includeInSkuCode)
    /*
     * `resolveSelection` decides all three cases: a missing selection falls back to the
     * default the configurator is showing, `mot` normalises to the catalogue's `MOT`, and an
     * unrecognised code falls back to the default too — the same value `calcPrice` charged
     * for. `validate()` reports that last case as a blocking error, so it never reaches a
     * pinned document; if it somehow did, the SKU would at least name what was charged.
     */
    .map((group) => resolveSelection(group, selections).value.code.toUpperCase());

  return [product.skuPrefix.toUpperCase(), ...parts].join('-');
}
