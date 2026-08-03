/**
 * The root of `@wewin/core` carries types and nothing else.
 *
 * `package.json` deliberately gives this entry a `types` condition with no
 * runtime counterpart, so `import '@wewin/core'` fails at load rather than
 * quietly pulling a barrel in. Every value lives behind a subpath
 * (`@wewin/core/pricing`, `/validation`, …).
 *
 * The reason is concrete: most component files need only the shape of a
 * `Product`. A types-only root erases to nothing at build time, so those files
 * cost the bundle zero — and the 81-product fixture table can never arrive as a
 * side effect of asking what a `Product` is.
 */

export type {
  Category,
  CustomGroup,
  InputStyle,
  OptionGroup,
  OptionKind,
  OptionValue,
  PriceDelta,
  Product,
  Rule,
  SkuGroup,
  Unit,
} from './types/catalog.js';

export type { NumExpr, RuleExpr } from './types/rule.js';

export type { Elevation, PanelInfill, PanelOperation } from './elevation.js';
export type { PriceBreakdown } from './pricing.js';
export type { Issue } from './validation.js';
export type { QuoteAction, QuoteLine, QuoteState } from './quote.js';
