import { products } from '@wewin/core/fixtures';
import { countCatalogText, formatCoverageReport } from './coverage.js';

/**
 * `pnpm --filter @wewin/i18n coverage:i18n`
 *
 * The only file in this package with a side effect, which is why `package.json` names it
 * in `sideEffects` rather than claiming the package has none. It is not in the export
 * map: it is a tool, not an API, and it is the only place `@wewin/core/fixtures` is
 * imported — the 81-product table must not reach an app bundle through this package.
 *
 * No top-level await anywhere on this path. `apps/api` is CommonJS and reaches this
 * package through Node's `require(ESM)`, which throws on one, and a test over there pins
 * that. Printing is synchronous for the same reason it always was.
 */
const count = countCatalogText(products);

const lines = [
  formatCoverageReport(),
  '',
  '── product content (plan 13 — not a code task) ──',
  `  ${String(count.products)} products`,
  `  ${String(count.groupLabels)} group labels + ${String(count.optionLabels)} option labels + ${String(count.ruleMessages)} rule sentences`,
  `  = ${String(count.total)} strings a CatalogTextRef can address — but only ${String(count.distinct)} distinct`,
  `    × 7 languages = ${String(count.distinct * 7)} sentences to write, attached in ${String(count.total * 7)} places`,
  '',
  `  Outside the message scheme: ${String(count.outsideScheme)} product names, summaries and field`,
  `  helpers (${String(count.outsideSchemeDistinct)} distinct), rendered straight from the catalogue by the storefront.`,
  '  This package has no seam for those — they are the same translator and a different mechanism.',
  '',
  '  Nothing in this package translates any of them, and nothing in it should.',
  '',
];

console.log(lines.join('\n'));
