/**
 * `@wewin/i18n` — the eight locales, their catalogues, and the one place formatting
 * happens.
 *
 * **Types only.** Importing this at run time throws `ERR_PACKAGE_PATH_NOT_EXPORTED`, the
 * same way `@wewin/core` does and for the same reason (plan section 1): a component that
 * needs the `Locale` union must not drag eight catalogues and an `Intl` cache into its
 * bundle. Every runtime value comes from a subpath:
 *
 *   `@wewin/i18n/locales`    the eight, their ICU tags, and how a request narrows to one
 *   `@wewin/i18n/format`     money · lengths · areas · counts · dates
 *   `@wewin/i18n/catalog`    the catalogues themselves, and the template checker
 *   `@wewin/i18n/translate`  `createTranslator` — a `Message` becomes a sentence here
 *   `@wewin/i18n/coverage`   what is missing, counted
 *
 * The division of labour with `@wewin/core`, which is the thing to keep straight:
 *
 *   core   produces `Message` — a key and **values**: `bigint` micrometres, `bigint`
 *          square micrometres, and catalogue text with a `ref` and its Thai source. It
 *          takes no locale, imports no formatter, and renders nothing.
 *   here   turns those values into glyphs. Every rounding decision was already made in
 *          core before this package was reached, so switching language cannot move a
 *          price by one satang or a window by one micrometre.
 */

export type { Locale, RenderLocale, RecipientLocaleSources } from './locales.js';

export type {
  CatalogProblem,
  CatalogStatus,
  LocaleCatalog,
  SourceCatalog,
  Template,
} from './catalog.js';

export type { DateOptions, MoneyPrecision } from './format.js';

export type {
  CatalogTextResolver,
  RenderIssue,
  RenderIssueKind,
  Rendered,
  Translator,
  TranslatorOptions,
} from './translate.js';

export type {
  CatalogTextCount,
  CatalogTextSource,
  LocaleCoverage,
} from './coverage.js';
