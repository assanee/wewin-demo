/**
 * The server's language layer — plan section 5 and plan 10.6, on the API side.
 *
 * Three things live here and nowhere else:
 *
 *   **the eight locales** (`locales.ts`) and the two different questions "which language?"
 *   can mean — a live preference for a notification or a response, a pinned one for a
 *   document;
 *
 *   **the key scheme** (`message.ts`) that replaced the Thai strings in five error
 *   translators, with values kept as values — `bigint` satang, integers, identifiers — and
 *   never as substrings;
 *
 *   **the one place formatting happens** (`format.ts` + `render.ts`), so that a translator
 *   is handed `{ minor: 552960n }` rather than `฿5,529.60` and a Burmese catalogue can use
 *   Burmese digits without a code change anywhere else.
 *
 * What deliberately does not live here: the notification templates (`notifications/
 * templates/`), which are a different catalogue on a different schedule, and the product
 * content, which is plan 13's human bottleneck and not code at all.
 */

export {
  FALLBACK_LOCALE,
  isSupportedLocale,
  normaliseLocale,
  parseAcceptLanguage,
  pinnedLocaleOf,
  preferredLocaleOf,
  resolveAgainst,
  SOURCE_LOCALE,
  SUPPORTED_LOCALES,
  type RecipientLocaleSources,
  type RenderLocale,
  type SupportedLocale,
} from './locales';

export {
  code,
  count,
  encodeCoreMessage,
  encodeServerMessage,
  isServerMessage,
  isServerMessageKey,
  message,
  paramShapeOf,
  SERVER_MESSAGE_KEYS,
  thb,
  type CodeParam,
  type CountParam,
  type MoneyParam,
  type ServerMessage,
  type ServerMessageKey,
  type NullaryMessageKey,
  type ServerParam,
  type ServerParamKind,
  type WireMessage,
} from './message';

export { formattersOf, type Formatters } from './format';

export {
  catalogueOf,
  coverage,
  coverageOf,
  covers,
  THAI_CATALOGUE,
  type Catalogue,
  type LocaleCoverage,
  type PartialCatalogue,
} from './catalog';

export { renderIn, renderInThai, renderServerMessage, type RenderedMessage } from './render';
