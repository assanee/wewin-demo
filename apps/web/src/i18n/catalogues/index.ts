import type { PartialUiCatalogue, UiCatalogue } from '../keys';
import type { Locale } from '../locales';
import { de } from './de';
import { en } from './en';
import { hi } from './hi';
import { la } from './la';
import { my } from './my';
import { th } from './th';
import { vi } from './vi';
import { zh } from './zh';

/**
 * The eight catalogues.
 *
 * Thai is typed as the complete one and every other as partial, which is the whole
 * asymmetry the fallback chain rests on: `Record<Locale, …>` forces all eight to exist,
 * and `UiCatalogue` on Thai alone forces exactly one of them to be finished.
 *
 * Six of the eight are empty today. That is not a placeholder to be filled in before
 * shipping — it is the state plan 13 describes, made honest and made visible.
 */
export const UI_CATALOGUES: Record<Locale, PartialUiCatalogue> & { th: UiCatalogue } = {
  de,
  en,
  hi,
  la,
  my,
  th,
  vi,
  zh,
};
