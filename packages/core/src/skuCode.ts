import type { Product } from './types/catalog.js';

/**
 * Compose the sku_code from the sku-kind selections (spec section 3).
 *
 *   {skuPrefix}-{code of every SkuGroup with includeInSkuCode, in groups[] order}
 *   e.g. AWN4T-DW-GRN-T5-NS0
 *
 * Custom groups never contribute: a different width is the same SKU at a different
 * size, not a different stocked variant.
 */
export function buildSkuCode(product: Product, selections: Record<string, string>): string {
  const parts = product.groups
    .filter((group) => group.kind === 'sku' && group.includeInSkuCode)
    .map((group) => {
      const selected = selections[group.code];
      // A missing selection means the configurator has not touched this group yet;
      // the default is what the UI is showing, so the code must agree with it.
      const code = selected ?? (group.kind === 'sku' ? group.defaultValue : '');
      return code.toUpperCase();
    });

  return [product.skuPrefix.toUpperCase(), ...parts].join('-');
}
