import { useId, type ReactElement } from 'react';
import { Languages } from 'lucide-react';
import { LOCALE_ENDONYMS, LOCALES, SOURCE_LOCALE, type Locale } from '../../i18n/locales';
import { coverageCountsOf, coverageOf } from '../../i18n/translate';
import { useLocale } from '../../state/localeContext';

/**
 * The language control, beside the quote link in the header.
 *
 * ## Why a select and not the segmented control `UnitPicker` uses
 *
 * Same question, same rules — a preference that changes how something is *read* and
 * never what it *is*, held outside the configurator's undo history, persisted on
 * click and only on click. What differs is the arity: five units fit across a 360px
 * header as 44px segments, and eight languages in scripts as wide as `Tiếng Việt` do
 * not. A `<select>` is the platform control for "one of eight", it collapses to a
 * single 44px target, and on a phone it opens the OS picker — which is the one piece
 * of UI on this page a visitor who cannot read Thai already knows how to use.
 *
 * ## Why the header and not beside the size fields
 *
 * `UnitPicker` sits inside the measurement section because it retitles the fields
 * immediately below it, and the customer reaches for it holding a tape measure. The
 * language governs the whole document — the footer, the catalogue, the 404 page — so
 * scoping it to one section of one route would leave seven screens with no way to
 * change it.
 *
 * ## The honest bit, and why it is not a sentence
 *
 * Six of the eight catalogues are empty (plan 13: translation is a bottleneck that is
 * not code). Choosing one of them gives that language's *numbers* and Thai *words*.
 * Saying so under the control is the difference between a known limitation and a site
 * that appears broken — and `coverageCountsOf` reads the catalogue rather than a
 * hand-kept list, so the notice disappears by itself as entries land.
 *
 * The notice used to be `t('locale.partial')` and nothing else, which was guaranteed
 * useless: the key exists only in the two complete catalogues, so the only locales that
 * can *show* the notice are the ones that render it in Thai — to a reader who by
 * definition does not read Thai. Translating it is not available either; that is the
 * bottleneck itself, and a machine translation of "some text is missing" is exactly the
 * kind of unreviewable sentence plan 13 refuses.
 *
 * So the notice leads with something no language is needed for: the two endonyms and
 * two counts. `Deutsch 0/158 · ไทย 158/158` is legible to anybody who can see their own
 * language's name. The Thai sentence follows, marked `lang="th"` so a screen reader
 * announces it in Thai rather than reading it as broken German.
 *
 * Not lime: spec section 2 spends the accent on the price and the primary action, and
 * a control that only changes how the page is written has no claim on it.
 */
export function LanguagePicker(): ReactElement {
  const { locale, setLocale, t } = useLocale();
  const selectId = useId();
  const noticeId = useId();

  const partial = coverageOf(locale) < 1;

  return (
    <div className="flex min-w-0 items-center gap-2">
      {/* The label is a word where there is room for it and an icon where there is
          not; the select keeps its accessible name from `aria-labelledby` at every
          width, so nothing is lost at 360px. */}
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
          // The option list is built from LOCALES, so this only rejects a value that
          // an extension or a restored form state put there.
          const match = LOCALES.find((candidate) => candidate === next);
          if (match) setLocale(match);
        }}
        className="min-h-11 min-w-0 shrink rounded-xs border border-line bg-panel-2 px-2 text-small text-chalk hover:border-line-2"
      >
        {LOCALES.map((candidate) => (
          // Endonyms, never names in the current language: the whole point of this
          // control is to be findable by someone who cannot read the page it is on. A
          // German speaker stranded on a Thai page is looking for "Deutsch".
          //
          // `lang` on each option so the browser draws Devanagari and Burmese with a
          // font that has those glyphs, rather than the Thai body face.
          <option key={candidate} value={candidate} lang={candidate}>
            {LOCALE_ENDONYMS[candidate]}
          </option>
        ))}
      </select>

      {partial ? (
        <span id={noticeId} className="sr-only">
          <CoverageSummary locale={locale} />{' '}
          <span lang={SOURCE_LOCALE}>{t('locale.partial')}</span>
        </span>
      ) : null}
    </div>
  );
}

/**
 * The same notice, visible rather than only announced.
 *
 * Kept apart from the control because the header has no room for a sentence at 360px
 * and because this belongs where the untranslated text actually is. `AppFooter`
 * renders it: the one strip of every page, below the content it is describing.
 */
export function IncompleteLocaleNotice(): ReactElement | null {
  const { locale, t } = useLocale();
  if (coverageOf(locale) === 1) return null;

  return (
    <p className="text-caption text-chalk-3">
      <CoverageSummary locale={locale} />{' '}
      {/* Marked, not translated. This is the sentence the bottleneck is about. */}
      <span lang={SOURCE_LOCALE}>{t('locale.partial')}</span>
    </p>
  );
}

/**
 * `Deutsch 0/158 · ไทย 158/158` — the state of the catalogue, in no language at all.
 *
 * Endonyms and digits. The digits go through the *active* locale's formatter, so a
 * Burmese reader gets Burmese numerals here as everywhere else; the endonyms never go
 * through anything, because a language's own name for itself is a fact rather than a
 * translation.
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
