import { SUPPORTED_LOCALES, type SupportedLocale } from '../locales';
import { SERVER_MESSAGE_KEYS, type ServerMessageKey } from '../message';
import { EN } from './en';
import { TH } from './th';
import type { Catalogue, PartialCatalogue } from './types';

/**
 * The eight catalogues, seven of which are allowed to be unfinished.
 *
 * ── Incompleteness is a state, not a bug ─────────────────────────────────────────
 *
 * Plan 13 puts translation on the "things the system cannot guess" list and plan 10.6 sizes
 * the notification half alone at ~96 messages. This file is built so that shipping without
 * them is a *described* condition rather than a silent one:
 *
 *   - a key a locale does not have renders in Thai, and the render reports `degraded: true`
 *   - `coverageOf` counts what is missing, and `/meta/locales` answers with the count
 *   - the type system will not let Thai be incomplete, because Thai is what everything else
 *     falls back to
 *
 * The failure this prevents is the one that is hard to see: a key with no translation
 * rendering as an empty string, or as `error.slip.foot_mismatch`, in front of a customer.
 * Neither is possible here — the worst case is Thai, which somebody in the building reads.
 *
 * ── Why `en` is partial on purpose and the other six are empty ───────────────────
 *
 * If every non-Thai catalogue were empty, the partial-catalogue path would exist only in a
 * test, and a path only a test walks is a path nobody has evidence for. `en` therefore ships
 * the handful of sentences that are *not* the human bottleneck — infrastructure and generic
 * refusals, which are code-owned prose rather than product content — and nothing else. Six
 * catalogues stay empty, which is the other real state.
 *
 * That split is also the honest line: 81 products in 8 languages is a translator's job, and
 * a plausible-looking Burmese sentence nobody in this building can check is worse than the
 * Thai it replaced.
 */
const CATALOGUES: Readonly<Record<SupportedLocale, PartialCatalogue>> = {
  de: {},
  en: EN,
  hi: {},
  la: {},
  my: {},
  th: TH,
  vi: {},
  zh: {},
};

/** Thai, complete, typed as complete. Everything else falls back to this. */
export const THAI_CATALOGUE: Catalogue = TH;

export function catalogueOf(locale: SupportedLocale): PartialCatalogue {
  return CATALOGUES[locale];
}

/**
 * Whether this locale has *this particular* message.
 *
 * Per key, not per locale, and that is the whole reason `resolveAgainst` takes a predicate.
 * A locale that is 60% translated should render its 60% in the reader's language; asking
 * "is `de` ready?" as one question forces the answer to be no until the last string lands,
 * which means every finished translation waits for the slowest one.
 */
export function covers(locale: SupportedLocale, key: ServerMessageKey): boolean {
  return CATALOGUES[locale][key] !== undefined;
}

export interface LocaleCoverage {
  readonly locale: SupportedLocale;
  readonly translated: number;
  readonly total: number;
  /** Keys with no entry, sorted — the actual work list, not a percentage. */
  readonly missing: readonly ServerMessageKey[];
}

/**
 * What is done and what is not, per locale.
 *
 * `missing` is the list and not a count because the number is only useful for a progress
 * bar, whereas the list is what somebody hands a translator. It is also what makes "we
 * shipped eight languages" checkable rather than a claim.
 */
export function coverageOf(locale: SupportedLocale): LocaleCoverage {
  const missing = SERVER_MESSAGE_KEYS.filter((key) => !covers(locale, key));

  return {
    locale,
    translated: SERVER_MESSAGE_KEYS.length - missing.length,
    total: SERVER_MESSAGE_KEYS.length,
    missing,
  };
}

export function coverage(): readonly LocaleCoverage[] {
  return SUPPORTED_LOCALES.map(coverageOf);
}

export type { Catalogue, PartialCatalogue } from './types';
