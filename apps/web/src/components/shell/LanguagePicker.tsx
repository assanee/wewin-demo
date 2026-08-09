import { useId, type ReactElement } from 'react';
import { Languages } from 'lucide-react';
import { LOCALE_ENDONYMS, LOCALES, SOURCE_LOCALE, type Locale } from '../../i18n/locales';
import { coverageCountsOf, coverageOf } from '../../i18n/translate';
import { useLocale } from '../../state/localeContext';

/**
 * The language control, beside the quote link in the header.
 *
 * ## What the App Router changed, and what it did not
 *
 * Everything about the *design* is the Vite component's and is unchanged: a `<select>`
 * rather than a segmented control, because eight endonyms as wide as `Tiếng Việt` do not
 * fit across a 360px header where five unit segments do; endonyms rather than names in the
 * current language, because the whole point of this control is to be findable by somebody
 * who cannot read the page it is on; `lang` on every `<option>` so the browser draws
 * Devanagari and Burmese with a face that has those glyphs; not lime, because spec section
 * 2 spends the accent on the price and the primary action and a control that only changes
 * how the page is *written* has no claim on it.
 *
 * What changed is underneath: `setLocale` is a **navigation** now, not a `setState`. The
 * language is the first path segment, so changing it changes the document — `<html lang>`,
 * the canonical link, all nine `hreflang`s and the per-script leading all come from the
 * response, and a `setState` would leave every one of them describing a page that is no
 * longer on screen. `LocaleProvider` is where that lives; this component still just calls
 * `setLocale`.
 *
 * ## The honest bit, kept around for the day it is needed again
 *
 * All eight catalogues are complete now (plan 13's bottleneck, closed): every key,
 * including this one's own notice, is translated in every language, so `partial` is
 * `false` for all eight and the notice below renders nothing today.
 *
 * It stays wired up rather than deleted because `coverageOf` reads the catalogue live
 * rather than trusting a hand-kept list — the day someone adds a key to `keys.ts` and
 * ships seven catalogues a translation behind, this reappears by itself, with no code
 * change needed to bring it back. `IncompleteLocaleNotice` below is the visible half;
 * `CoverageSummary` is what would print `Deutsch <translated>/<total> · ไทย <total>/<total>`
 * for the language actually left behind, rather than a number this comment would have to
 * be kept in sync with.
 */
export function LanguagePicker(): ReactElement {
  const { locale, setLocale, t } = useLocale();
  const selectId = useId();
  const noticeId = useId();

  const partial = coverageOf(locale) < 1;

  return (
    <div className="flex min-w-0 items-center gap-2">
      {/* The label is a word where there is room for it and an icon where there is not;
          the select keeps its accessible name from `aria-labelledby` at every width, so
          nothing is lost at 360px. */}
      <Languages size={15} aria-hidden className="shrink-0 text-chalk-3 md:hidden" />
      <span id={selectId} className="hidden shrink-0 text-caption text-chalk-2 md:inline">
        {t('locale.pickerLabel')}
      </span>

      <select
        value={locale}
        aria-labelledby={selectId}
        aria-label={t('locale.groupLabel')}
        {...(partial ? { 'aria-describedby': noticeId } : {})}
        onChange={(event) => {
          const next = event.target.value;
          // The option list is built from LOCALES, so this only rejects a value that an
          // extension or a restored form state put there.
          const match = LOCALES.find((candidate) => candidate === next);
          if (match) setLocale(match);
        }}
        className="min-h-11 min-w-0 shrink rounded-xs border border-line bg-panel-2 px-2 text-small text-chalk hover:border-line-2"
      >
        {LOCALES.map((candidate) => (
          <option key={candidate} value={candidate} lang={candidate}>
            {LOCALE_ENDONYMS[candidate]}
          </option>
        ))}
      </select>

      {partial ? (
        <span id={noticeId} className="sr-only">
          <CoverageSummary locale={locale} />{' '}
          {t('locale.partial')}
        </span>
      ) : null}
    </div>
  );
}

/**
 * The same notice, visible rather than only announced.
 *
 * Kept apart from the control because the header has no room for a sentence at 360px and
 * because this belongs where the untranslated text actually is. `AppFooter` renders it,
 * on the routes `AppFooter` itself appears on, below the content it is describing.
 */
export function IncompleteLocaleNotice(): ReactElement | null {
  const { locale, t } = useLocale();
  if (coverageOf(locale) === 1) return null;

  return (
    <p className="text-caption text-chalk-3">
      <CoverageSummary locale={locale} />{' '}
      {t('locale.partial')}
    </p>
  );
}

/**
 * `Deutsch <translated>/<total> · ไทย <total>/<total>` — the state of the catalogue, in no
 * language at all. All eight are equal today, so both halves currently print the same pair;
 * the format is what survives a key landing in `keys.ts` a translation behind.
 *
 * Endonyms and digits. The digits go through the *active* locale's formatter, so a Burmese
 * reader gets Burmese numerals here as everywhere else; the endonyms never go through
 * anything, because a language's own name for itself is a fact rather than a translation.
 */
function CoverageSummary({ locale }: { locale: Locale }): ReactElement {
  const { f } = useLocale();
  const counts = coverageCountsOf(locale);
  const source = coverageCountsOf(SOURCE_LOCALE);

  return (
    <span className="numeric">
      <span lang={locale}>{LOCALE_ENDONYMS[locale]}</span>{' '}
      {f.plain(counts.translated)}/{f.plain(counts.total)} ·{' '}
      <span lang={SOURCE_LOCALE}>{LOCALE_ENDONYMS[SOURCE_LOCALE]}</span>{' '}
      {f.plain(source.translated)}/{f.plain(source.total)}
    </span>
  );
}
