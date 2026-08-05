import type { LocaleCatalog } from '../catalog.js';

/**
 * 中文 (Chinese) — **untranslated, on purpose.**
 *
 * Nothing here was machine-translated. Plan 13 names the translation of this product's
 * content as a human bottleneck rather than a code task, and a sentence in a language
 * nobody on the team reads is not reviewable: it would look finished, ship, and be
 * discovered by the customer it was wrong for.
 *
 * So the mechanism is complete and the content is honestly missing. Today a Chinese
 * visitor gets Chinese numbers, Chinese dates, Chinese currency placement — and the message
 * text in Thai, marked as a fallback so the interface can say so and set `lang="th"` on
 * it. That is a visible gap. An invented sentence is an invisible one.
 *
 * ── To fill this in ───────────────────────────────────────────────────────────
 *
 *   pnpm --filter @wewin/i18n build && pnpm --filter @wewin/i18n coverage:i18n
 *
 * prints every missing key with its Thai source and the exact `{holes}` the template
 * must contain. Add the entries below, then `pnpm --filter @wewin/i18n test`:
 * `validateCatalog` fails a template that drops a hole, which is the mistake that would
 * otherwise ship as a fluent sentence with the numbers missing from it.
 *
 * Set `status: 'translated'` only once a person who reads Chinese has reviewed it. The
 * status is a claim about provenance and no generator may make it.
 */
export const zh: LocaleCatalog = {
  locale: 'zh',
  status: 'untranslated',
  messages: {},
};
