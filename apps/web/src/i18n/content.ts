import type { CatalogTextParam, CatalogTextRef } from '@wewin/core/message';
import { SOURCE_LOCALE, type Locale } from './locales';

/**
 * Catalogue *content* — as opposed to the app's own prose.
 *
 * Product names, category labels, group labels, option labels and rule messages are
 * written by a person about a physical product. Plan section 13 counts them: 81
 * products × 8 languages, and it puts them in the column headed "a bottleneck that is
 * not code". They can never become code keys, and this round does not machine
 * translate a single one of them — a wrong Burmese description of an awning that
 * nobody in the company can read back is worse than a visible fallback.
 *
 * So the mechanism ships and the content does not:
 *
 *   - every piece of catalogue content is *addressable*, by the same kind of ref
 *     `@wewin/core/message` uses for the three it already covers;
 *   - a lookup that misses returns the Thai source **and says that it did**, so the
 *     call site can mark it `lang="th"` — a screen reader then switches voice, and
 *     the page stops claiming to be German prose while reading Thai aloud;
 *   - a lookup never returns an empty string or a raw key. Those are the two ways an
 *     i18n layer fails invisibly, and the reason `CatalogTextParam.th` is required
 *     and non-empty over in core.
 */

/**
 * Everything in the catalogue a locale might one day replace.
 *
 * A superset of core's `CatalogTextRef`: core only mints refs for the three strings
 * that end up inside a `Message`, but the storefront also renders product names,
 * summaries and category text, and those need addresses of the same shape or they
 * become the one class of content with no way to translate it.
 */
export type ContentRef =
  | CatalogTextRef
  | { readonly on: 'productName'; readonly productId: string }
  | { readonly on: 'productSummary'; readonly productId: string }
  | { readonly on: 'categoryLabel'; readonly categoryId: string }
  | { readonly on: 'categorySummary'; readonly categoryId: string }
  | { readonly on: 'groupHelper'; readonly productId: string; readonly groupCode: string };

/**
 * A ref flattened to a single string, so a translated catalogue can be a plain map.
 *
 * Every variant starts with `on` and lists its identifiers in a fixed order, so two
 * different refs cannot collide — which matters more than it looks: every product has
 * a `width` group, and a key that dropped `productId` would return *some* product's
 * translation and read as a perfectly plausible one.
 */
export function refKey(ref: ContentRef): string {
  switch (ref.on) {
    case 'groupLabel':
      return `groupLabel:${ref.productId}:${ref.groupCode}`;
    case 'optionLabel':
      return `optionLabel:${ref.productId}:${ref.groupCode}:${ref.valueCode}`;
    case 'ruleMessage':
      return `ruleMessage:${ref.productId}:${ref.ruleId}`;
    case 'productName':
      return `productName:${ref.productId}`;
    case 'productSummary':
      return `productSummary:${ref.productId}`;
    case 'categoryLabel':
      return `categoryLabel:${ref.categoryId}`;
    case 'categorySummary':
      return `categorySummary:${ref.categoryId}`;
    case 'groupHelper':
      return `groupHelper:${ref.productId}:${ref.groupCode}`;
  }
}

/** One locale's translated catalogue, keyed by `refKey`. */
export type ContentCatalogue = Readonly<Record<string, string>>;

/** Every locale's, with Thai absent by construction — Thai is the source. */
export type ContentCatalogues = Partial<Record<Exclude<Locale, 'th'>, ContentCatalogue>>;

/**
 * A piece of catalogue content resolved for display.
 *
 * `fallback` is not a diagnostic. It is what the renderer needs in order to put
 * `lang="th"` on the element, which is the difference between degrading visibly and
 * degrading silently.
 */
export interface ResolvedContent {
  readonly text: string;
  readonly fallback: boolean;
}

/**
 * The translated catalogues the app ships with.
 *
 * **Empty, and that is the deliverable.** Catalogue translation is a person's job
 * (plan 13), and the compiled catalogue documents live in Postgres behind the API —
 * this map is where they land when phase 6b brings them down with the product. Until
 * then every product name on the site renders Thai, marked as Thai, in all eight
 * languages, and that is the honest state rather than a hidden one.
 *
 * The resolution path is not untested for being unused: `content.test.ts` supplies a
 * populated catalogue and pins that a hit wins, a miss falls back, and an empty
 * translation is treated as a miss.
 */
export const CONTENT_CATALOGUES: ContentCatalogues = {};

/**
 * Resolve one piece of catalogue content.
 *
 * An empty translation counts as a miss on purpose. An empty string is exactly what a
 * half-finished export produces, and it renders as a product with no name — the
 * failure this whole file is arranged to prevent.
 */
export function resolveContent(
  ref: ContentRef,
  th: string,
  locale: Locale,
  catalogues: ContentCatalogues = CONTENT_CATALOGUES,
): ResolvedContent {
  if (locale === SOURCE_LOCALE) return { text: th, fallback: false };

  const translated = catalogues[locale]?.[refKey(ref)];
  return translated !== undefined && translated !== ''
    ? { text: translated, fallback: false }
    : { text: th, fallback: true };
}

/** The same, for a `CatalogTextParam` that core already built the ref for. */
export const resolveCatalogText = (
  param: CatalogTextParam,
  locale: Locale,
  catalogues: ContentCatalogues = CONTENT_CATALOGUES,
): ResolvedContent => resolveContent(param.ref, param.th, locale, catalogues);
