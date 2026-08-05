import type { CatalogTextRef, Message, MessageKey, MessageParam } from '@wewin/core';
import type { Currency } from '@wewin/core/money';
import type { LengthUnit } from '@wewin/core/units';
import {
  CATALOGS,
  type LocaleCatalog,
  MESSAGE_PARAMS,
  PLACEHOLDER,
  type Template,
} from './catalog.js';
import { UNAVAILABLE_TEXT } from './catalogs/th.js';
import {
  type DateOptions,
  type MoneyPrecision,
  formatArea,
  formatCount,
  formatDate,
  formatDateTime,
  formatDimensions,
  formatLength,
  formatMeasure,
  formatMoney,
  formatRange,
} from './format.js';
import { type Locale, SOURCE_LOCALE } from './locales.js';

/**
 * Turning a `Message` into a sentence, and being honest about what was missing.
 *
 * ── The rule this file implements ─────────────────────────────────────────────
 *
 *   A missing translation is **loud in development and visible in production**. It is
 *   never an empty string, never a raw dotted key on a customer's screen, and never
 *   silence.
 *
 * Concretely, in the order they are tried:
 *
 *   1. this locale's template          →  the sentence, `fallback: false`
 *   2. no template for this locale     →  the **Thai** sentence, `fallback: true`,
 *                                         `locale: 'th'`, and one `RenderIssue`
 *   3. this locale's template is broken →  same as 2, plus a different issue. A template
 *                                         that lost a `{hole}` is not rendered with the
 *                                         hole missing; it is rejected, because a fluent
 *                                         sentence with the numbers gone is worse than a
 *                                         foreign one with them in.
 *   4. Thai is missing or broken too   →  `UNAVAILABLE_TEXT`, a Thai sentence, and a
 *                                         loud issue. Unreachable by construction — the
 *                                         source catalogue's type is total — and here
 *                                         for the state a type cannot see.
 *
 * `Rendered.locale` is the locale of the **text**, not of the request, and that is what
 * a caller puts in `lang=`. It is load-bearing beyond correctness: plan 8.3 picks fonts
 * per script, and a German page showing an untranslated message contains Thai glyphs. A
 * `lang="de"` wrapper around Thai text picks a font with no Thai in it and renders
 * boxes — the customer's evidence that a translation is missing must not be that the
 * page looks broken.
 */

/** Where a product's own words come from in a language other than Thai. */
export interface CatalogTextResolver {
  /**
   * The translated catalogue string for `ref`, or `undefined` if there is not one.
   *
   * **Nothing implements this yet, and that is the honest state of the system.** Plan 13
   * sizes the job at 81 products × 8 languages and calls it a human bottleneck; the
   * mechanism belongs in phase 6a, the content does not. Until a translated catalogue
   * exists, every group label, option label and rule sentence falls back to the Thai the
   * message already carries, and `Rendered.fallback` says so on every one of them.
   */
  (ref: CatalogTextRef, locale: Locale): string | undefined;
}

export type RenderIssueKind =
  | 'missingTemplate'
  | 'brokenTemplate'
  | 'missingSourceTemplate'
  | 'missingCatalogText';

export interface RenderIssue {
  readonly kind: RenderIssueKind;
  /** The locale that was asked for — not the one that answered. */
  readonly locale: Locale;
  readonly key: MessageKey;
  readonly detail: string;
}

export interface Rendered {
  readonly text: string;
  /** The locale the **text** is in. What belongs in `lang=`. */
  readonly locale: Locale;
  /** True when any part of the sentence came from the source language instead. */
  readonly fallback: boolean;
  readonly issues: readonly RenderIssue[];
}

const isProduction = (): boolean =>
  typeof process !== 'undefined' && process.env.NODE_ENV === 'production';

/**
 * The default sink: a warning everywhere except production.
 *
 * Warn rather than throw. A throw would be louder, and it would also mean that the first
 * untranslated string in a locale takes down the page for a customer who could have read
 * the Thai — the failure this whole fallback chain exists to prevent. Louder still is
 * available and costs one line: `createTranslator(locale, { onIssue: (i) => { throw … } })`
 * in a test, which is what `tests/fallback.test.ts` does.
 */
const warnUnlessProduction = (issue: RenderIssue): void => {
  if (isProduction()) return;
  console.warn(`[@wewin/i18n] ${issue.kind} ${issue.locale} ${issue.key}: ${issue.detail}`);
};

export interface TranslatorOptions {
  /** For tests and for a catalogue loaded at run time. Defaults to the shipped eight. */
  readonly catalogs?: Readonly<Record<Locale, LocaleCatalog>>;
  readonly catalogText?: CatalogTextResolver;
  /** Defaults to a `console.warn` outside production. */
  readonly onIssue?: (issue: RenderIssue) => void;
  /** Overrides `BUSINESS_TIME_ZONE` for every date this translator formats. */
  readonly timeZone?: string;
}

export interface Translator {
  readonly locale: Locale;

  /** The sentence. The common case, when the caller only wants a string. */
  message(message: Message): string;
  /** The sentence, plus which language it is actually in and what was missing. */
  render(message: Message): Rendered;
  /** Whether this locale has its own template for a key. */
  has(key: MessageKey): boolean;

  money(minor: bigint, currency: Currency, precision?: MoneyPrecision): string;
  length(um: bigint, unit: LengthUnit): string;
  measure(um: bigint, unit: LengthUnit): string;
  range(minUm: bigint, maxUm: bigint, unit: LengthUnit): string;
  dimensions(widthUm: bigint, heightUm: bigint, unit: LengthUnit): string;
  area(sqUm: bigint): string;
  count(value: number | bigint): string;
  date(value: Date, options?: DateOptions): string;
  dateTime(value: Date, options?: DateOptions): string;
}

/**
 * A stable identity for a message, independent of language.
 *
 * `apps/web` used the rendered label as a React `key`. That worked while a label was a
 * Thai string and stops working the moment the same list is rendered in two languages —
 * the keys change on a language switch and React rebuilds every row. This is the same
 * message's identity in every locale: the key, and the catalogue refs that distinguish
 * one row from its neighbour.
 */
export function messageId(message: Message): string {
  const params: Readonly<Record<string, MessageParam>> = message.params;
  const parts: string[] = [message.key];

  for (const name of MESSAGE_PARAMS[message.key]) {
    const param: MessageParam | undefined = params[name];
    if (param === undefined) continue;

    switch (param.kind) {
      case 'catalogText':
        parts.push(`${name}=${refId(param.ref)}`);
        break;
      case 'length':
        parts.push(`${name}=${param.um.toString()}${param.unit}`);
        break;
      case 'lengthRange':
        parts.push(`${name}=${param.minUm.toString()}-${param.maxUm.toString()}${param.unit}`);
        break;
      case 'area':
        parts.push(`${name}=${param.sqUm.toString()}`);
        break;
    }
  }

  return parts.join('|');
}

const refId = (ref: CatalogTextRef): string => {
  switch (ref.on) {
    case 'groupLabel':
      return `${ref.productId}.${ref.groupCode}`;
    case 'optionLabel':
      return `${ref.productId}.${ref.groupCode}.${ref.valueCode}`;
    case 'ruleMessage':
      return `${ref.productId}!${ref.ruleId}`;
  }
};

/**
 * Fill a template's holes, or refuse the template.
 *
 * `null` on any hole whose name is not a param of this key — the substitution would
 * leave `{ranges}` on screen — and `null` on any param the template never mentions,
 * which is the failure that does *not* look like one. Both send the caller to the next
 * step of the fallback chain.
 */
function fillTemplate(
  template: Template,
  values: Readonly<Record<string, string>>,
): string | null {
  const used = new Set<string>();
  let refused = false;

  const text = template.replace(PLACEHOLDER, (whole, name: string) => {
    const value = values[name];
    if (value === undefined) {
      refused = true;
      return whole;
    }
    used.add(name);
    return value;
  });

  if (refused) return null;
  if (used.size !== Object.keys(values).length) return null;
  return text;
}

export function createTranslator(locale: Locale, options: TranslatorOptions = {}): Translator {
  const catalogs = options.catalogs ?? CATALOGS;
  const onIssue = options.onIssue ?? warnUnlessProduction;
  const dateDefaults: DateOptions =
    options.timeZone === undefined ? {} : { timeZone: options.timeZone };

  const catalogTextFor = (
    ref: CatalogTextRef,
    thai: string,
  ): { readonly text: string; readonly fallback: boolean } => {
    if (locale === SOURCE_LOCALE) return { text: thai, fallback: false };

    const translated = options.catalogText?.(ref, locale);
    if (translated !== undefined && translated.trim() !== '') {
      return { text: translated, fallback: false };
    }
    // The Thai the message carries — the source content itself, and the reason
    // `CatalogTextParam.th` is required and non-empty in core.
    return { text: thai, fallback: true };
  };

  const render = (message: Message): Rendered => {
    const issues: RenderIssue[] = [];
    const report = (kind: RenderIssueKind, detail: string): void => {
      const issue: RenderIssue = { kind, locale, key: message.key, detail };
      issues.push(issue);
      onIssue(issue);
    };

    // 1. The params, formatted in this locale whatever language the sentence ends up in.
    //    Numbers follow the *reader*, not the template: a Burmese reader handed the Thai
    //    fallback still gets Burmese digits, because the digits are not the translation.
    const params: Readonly<Record<string, MessageParam>> = message.params;
    const values: Record<string, string> = {};
    let contentFallback = false;

    for (const name of MESSAGE_PARAMS[message.key]) {
      const param: MessageParam | undefined = params[name];
      if (param === undefined) {
        report('missingCatalogText', `param {${name}} is absent from the message`);
        continue;
      }

      switch (param.kind) {
        case 'catalogText': {
          const resolved = catalogTextFor(param.ref, param.th);
          values[name] = resolved.text;
          contentFallback = contentFallback || resolved.fallback;
          break;
        }
        case 'length':
          values[name] = formatMeasure(locale, param.um, param.unit);
          break;
        case 'lengthRange':
          values[name] = formatRange(locale, param.minUm, param.maxUm, param.unit);
          break;
        case 'area':
          values[name] = formatArea(locale, param.sqUm);
          break;
      }
    }

    // 2. This locale's template.
    const own = catalogs[locale].messages[message.key];
    if (own !== undefined) {
      const text = fillTemplate(own, values);
      if (text !== null) {
        return { text, locale, fallback: contentFallback, issues };
      }
      report('brokenTemplate', 'template does not use exactly the params of this key');
    } else if (locale !== SOURCE_LOCALE) {
      report('missingTemplate', 'no template in this locale; falling back to the source');
    }

    // 3. The source language, visibly.
    //
    //    Read out of the *injected* catalogues rather than out of `SOURCE_CATALOG`
    //    directly. In production they are the same object and the same total type, so
    //    this cannot be undefined; injecting one that lacks the key is the only way to
    //    reach step 4 in a test, and a floor no test can stand on is a floor nobody
    //    knows holds.
    const source = catalogs[SOURCE_LOCALE].messages[message.key];
    const sourceText = source === undefined ? null : fillTemplate(source, values);
    if (sourceText !== null) {
      return { text: sourceText, locale: SOURCE_LOCALE, fallback: true, issues };
    }

    // 4. The floor. A sentence, never the key — the key goes to `onIssue`.
    report('missingSourceTemplate', 'the source template is missing or malformed');
    return { text: UNAVAILABLE_TEXT, locale: SOURCE_LOCALE, fallback: true, issues };
  };

  return {
    locale,
    render,
    message: (message) => render(message).text,
    has: (key) => catalogs[locale].messages[key] !== undefined,

    money: (minor, currency, precision) => formatMoney(locale, minor, currency, precision),
    length: (um, unit) => formatLength(locale, um, unit),
    measure: (um, unit) => formatMeasure(locale, um, unit),
    range: (minUm, maxUm, unit) => formatRange(locale, minUm, maxUm, unit),
    dimensions: (widthUm, heightUm, unit) => formatDimensions(locale, widthUm, heightUm, unit),
    area: (sqUm) => formatArea(locale, sqUm),
    count: (value) => formatCount(locale, value),
    date: (value, dateOptions) => formatDate(locale, value, { ...dateDefaults, ...dateOptions }),
    dateTime: (value, dateOptions) =>
      formatDateTime(locale, value, { ...dateDefaults, ...dateOptions }),
  };
}
