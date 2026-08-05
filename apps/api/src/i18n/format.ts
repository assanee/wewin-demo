import { formatCount, formatMoney } from '@wewin/i18n/format';
import type { SupportedLocale } from './locales';
import type { CodeParam, CountParam, MoneyParam } from './message';

/**
 * The one place a value becomes text.
 *
 * ── The shape lives here; the numbers live in `@wewin/i18n` ──────────────────────
 *
 * The brief for this round put it as a requirement: *"decide where formatting happens and
 * make it one place"*. This file was the API's answer to that and it was only ever a third
 * of the answer — see the note on `formattersFor` below for the three-way disagreement it
 * left standing. What survives is the *injection*: a `Formatters` per locale, selected once
 * per render, handed to the catalogue entry rather than reached for. A translator writing
 * the Burmese catalogue cannot accidentally produce Western digits, because there is no
 * function in scope that would give them any.
 *
 * ── Digits are not decoration, and they are no longer this file's guess ──────────
 *
 * Hindi (`देवनागरी`) and Burmese (`မြန်မာ`) have their own digit shapes. This file used to
 * force every locale to `latn` on the grounds that no non-Thai catalogue existed yet — true
 * at the time, and it meant a Burmese sentence would have arrived with Western digits in it
 * on the day one was written. The numbering system now comes from CLDR via
 * `@wewin/i18n`'s `INTL_TAG`, which is the same table the storefront draws prices with.
 */

export interface Formatters {
  /** Minor units → the locale's own rendering, exact to the minor unit. */
  money(param: MoneyParam): string;
  /** An integer → the locale's own digits. */
  count(param: CountParam): string;
  /**
   * A machine identifier → itself.
   *
   * A method rather than a bare property read, because a locale may want to isolate a
   * Latin-script id inside a non-Latin sentence, and doing that at the catalogue's edge is
   * the difference between one implementation and eighty call sites.
   */
  code(param: CodeParam): string;
}

/**
 * ⚠️ **There is no locale table in this file any more.**
 *
 * There were two — `NUMBERING` and `GROUPING` — and both were honest about what they did
 * and wrong about how many copies of it existed. `apps/web` had a third set and
 * `@wewin/i18n` a fourth, and phase 6a's review put them side by side on ฿1,234,567.89:
 *
 *     locale | apps/web      | apps/api        | @wewin/i18n
 *     de     | 1.234.568 ฿   | ฿1.234.567,89   | 1.234.567,89 ฿
 *     hi     | ฿12,34,568    | ฿1,234,567.89   | ฿12,34,567.89
 *     vi     | 1.234.568 ฿   | ฿1,234,567.89   | 1.234.567,89 ฿
 *
 * For `vi` the two surfaces swapped the roles of `.` and `,`, so each string was a valid
 * reading of the other's number. Seven of the eight resolved to `en-US` grouping here,
 * which was defensible when this was the only file that formatted money and indefensible
 * the moment a storefront rendered the same amount beside it.
 *
 * So the tags, the numbering systems, the decimal separator and the exact-satang split all
 * moved to `@wewin/i18n/format`, and this file is the *shape* the catalogue is written
 * against: a per-locale object of three methods, injected, so a catalogue entry cannot
 * reach for a formatter and cannot emit Western digits by accident.
 *
 * The one preserved behaviour worth naming: `money` is **exact to the satang**, not
 * `formatBaht`'s whole baht. Every message in this catalogue exists to tell a reviewer
 * looking at a photograph of ฿5,530.00 that they typed ฿5,529.60, and *which forty satang*
 * is the entire content of the sentence.
 */
const formattersFor = (locale: SupportedLocale): Formatters => ({
  money: (param) => formatMoney(locale, param.minor, param.currency, 'exact'),
  count: (param) => formatCount(locale, param.value),
  code: (param) => param.value,
});

/** Built once per locale; a `Formatters` holds no state and building one per message is waste. */
const CACHE = new Map<SupportedLocale, Formatters>();

export function formattersOf(locale: SupportedLocale): Formatters {
  const cached = CACHE.get(locale);
  if (cached !== undefined) return cached;

  const built = formattersFor(locale);
  CACHE.set(locale, built);
  return built;
}
