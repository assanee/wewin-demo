import type { OptionValue, Product, SkuGroup } from './types/catalog.js';

/**
 * What a sku group is actually set to — one resolution, used by everything.
 *
 * ── The defect this exists to make unrepresentable ───────────────────────────────
 *
 * There used to be two answers to "what did the customer pick", and they disagreed:
 *
 *   `pricing.ts` matched the selection against the group's values **exactly** and, on no
 *   match, contributed nothing at all — no surcharge, no error, on the stated reasoning
 *   that a missing surcharge beats a crash in a configurator.
 *
 *   `skuCode.ts` took whatever string it was handed and upper-cased it, so the same
 *   selection produced the SKU of the option that had just been dropped from the price.
 *
 * Send `control=mot` instead of `control=MOT` on a louvre and the order was priced as
 * manual and stamped `LVR1-SG-B150-MOT` — byte-identical to the motorised contract, 12,840
 * baht cheaper, and reachable by an anonymous guest. The factory builds what the SKU says.
 * The comment about preferring a missing surcharge to a crash was a decision about a
 * *configurator*; phase 5a promoted its output into a contract, and it stopped being true
 * there without anybody revisiting it.
 *
 * So there is now exactly one function that turns a selection into an `OptionValue`, and
 * every reader — price, SKU, validation, option states — goes through it. Two selections
 * that resolve to the same value cannot price differently, because there is nothing left
 * that resolves them separately.
 *
 * ── The three rules, in order ────────────────────────────────────────────────────
 *
 *   1. **An exact match wins.** Ordinary case, and it is checked first so nothing below
 *      can change the meaning of a well-formed selection.
 *
 *   2. **A unique case-insensitive match is accepted, and normalises to the catalogue's
 *      spelling.** Codes are `SCREAMING_CASE` identifiers; `mot` is a typo for `MOT` and
 *      not a request for a different product. Accepting it and *pricing it as MOT* is
 *      strictly safer than the alternatives: rejecting it would break links and stored
 *      carts, and — as above — dropping it is what cost 12,840 baht. "Unique" is
 *      load-bearing: if a group ever offers two codes that differ only in case, neither is
 *      resolvable this way and the selection is reported unrecognised rather than guessed.
 *
 *   3. **Anything else falls back to the group's default**, which is what the configurator
 *      renders and therefore what the customer is looking at. `recognised: false` comes
 *      back with it, and `validate()` turns that into a blocking error — so an unknown code
 *      is *reported*, not silently absorbed, and it can no longer produce a document at
 *      all.
 *
 * The fallback matters as much as the error: price and SKU now agree in every case,
 * including the broken one. A reader that skipped the group and a reader that kept the raw
 * string was how the two ever came to describe different windows.
 */

export interface ResolvedSelection {
  readonly group: SkuGroup;
  readonly value: OptionValue;
  /**
   * False when the code named nothing this group offers.
   *
   * The caller still gets a `value` — the group default — because every reader needs *an*
   * answer and the default is the one on screen. What must not happen is a reader deciding
   * for itself what an unrecognised code means.
   */
  readonly recognised: boolean;
}

/** The code a group is set to, before it is resolved. Missing means the default. */
export function selectedCodeOf(group: SkuGroup, selections: Record<string, string>): string {
  return selections[group.code] ?? group.defaultValue;
}

/**
 * Resolve one group. Never returns undefined — see rule 3.
 *
 * Throws only when the *catalogue* is broken: a group whose `defaultValue` names none of
 * its own values has no sane answer, and `productSchema` rejects that at parse time, so
 * reaching the throw means something built a `Product` by hand.
 */
export function resolveSelection(
  group: SkuGroup,
  selections: Record<string, string>,
): ResolvedSelection {
  const code = selectedCodeOf(group, selections);

  const exact = group.values.find((candidate) => candidate.code === code);
  if (exact) return { group, value: exact, recognised: true };

  const folded = code.toUpperCase();
  const insensitive = group.values.filter((candidate) => candidate.code.toUpperCase() === folded);
  if (insensitive.length === 1 && insensitive[0]) {
    return { group, value: insensitive[0], recognised: true };
  }

  const fallback = group.values.find((candidate) => candidate.code === group.defaultValue);
  if (!fallback) {
    throw new TypeError(
      `catalogue: group "${group.code}" defaults to "${group.defaultValue}", which it does not offer`,
    );
  }

  return { group, value: fallback, recognised: false };
}

export const skuGroupsOf = (product: Product): SkuGroup[] =>
  product.groups.filter((group): group is SkuGroup => group.kind === 'sku');

/** Every sku group of a product, resolved. The order is `groups[]` order, which the SKU depends on. */
export function resolveSelections(
  product: Product,
  selections: Record<string, string>,
): ResolvedSelection[] {
  return skuGroupsOf(product).map((group) => resolveSelection(group, selections));
}
