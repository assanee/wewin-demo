import type { MessageKey } from '@wewin/core';
import { MESSAGE_KEYS } from '@wewin/core/message';
import {
  CATALOGS,
  type CatalogProblem,
  type CatalogStatus,
  type LocaleCatalog,
  MESSAGE_PARAMS,
  SOURCE_CATALOG,
  validateAllCatalogs,
} from './catalog.js';
import { LOCALES, type Locale, LOCALE_ENDONYM, SOURCE_LOCALE } from './locales.js';

/**
 * What is missing, counted rather than claimed.
 *
 * Two things this package must not do are the reason it exists as code rather than as a
 * paragraph somewhere:
 *
 *   1. A hand-written list of what still needs translating is out of date the first time
 *      a key is added, and its wrongness is invisible — the missing key simply is not on
 *      the list, so nobody translates it and a customer finds it.
 *   2. "We support eight languages" is a claim this package can *measure*. Seven of the
 *      eight are at 0 of 9 today. That number belongs in a report a human reads, not in
 *      a README nobody updates.
 *
 * `coverage-cli.ts` prints this. It doubles as the translator's worksheet: every missing
 * key comes out with its Thai source and the exact holes the template must contain.
 */

export interface LocaleCoverage {
  readonly locale: Locale;
  readonly endonym: string;
  readonly status: CatalogStatus;
  readonly translated: number;
  readonly total: number;
  readonly missing: readonly MessageKey[];
}

export function messageCoverage(
  catalogs: Readonly<Record<Locale, LocaleCatalog>> = CATALOGS,
): readonly LocaleCoverage[] {
  return LOCALES.map((locale) => {
    const catalog = catalogs[locale];
    const missing = MESSAGE_KEYS.filter((key) => catalog.messages[key] === undefined);

    return {
      locale,
      endonym: LOCALE_ENDONYM[locale],
      status: catalog.status,
      translated: MESSAGE_KEYS.length - missing.length,
      total: MESSAGE_KEYS.length,
      missing,
    };
  });
}

/* ------------------------------------------------------------------ *
 * The other bottleneck — product content, which this package cannot fix
 * ------------------------------------------------------------------ */

/**
 * The shape `countCatalogText` needs from a product. Structural on purpose: naming
 * `Product` here would drag the 81-product fixture into anything that imports coverage.
 */
export interface CatalogTextSource {
  readonly id: string;
  readonly nameTh: string;
  readonly summaryTh: string;
  readonly groups: readonly {
    readonly code: string;
    readonly labelTh: string;
    readonly helperTh?: string;
    readonly values?: readonly { readonly code: string; readonly labelTh: string }[];
  }[];
  readonly rules: readonly { readonly id: string; readonly messageTh: string }[];
}

export interface CatalogTextCount {
  readonly products: number;
  readonly groupLabels: number;
  readonly optionLabels: number;
  readonly ruleMessages: number;
  /** Every string a `CatalogTextRef` can address. What this package's seam covers. */
  readonly total: number;
  /** Distinct Thai strings — the same label is authored on many products. */
  readonly distinct: number;
  /**
   * Product names, summaries and field helpers.
   *
   * **Not** reachable through a `Message`: the storefront renders them straight from the
   * catalogue document. They are the same translator's job and none of this package's
   * mechanism touches them, so they are counted apart rather than folded in — a total
   * that mixed the two would make the job look either smaller or larger than it is.
   */
  readonly outsideScheme: number;
  readonly outsideSchemeDistinct: number;
}

/**
 * How large the content half of the job really is.
 *
 * Plan 13 says "8 languages × 81 products" and leaves it there. A `CatalogTextRef` is
 * addressable per product, so the real unit is not the product but the string, and the
 * two numbers this returns are far apart: many products share a label like `ความกว้าง`,
 * so `distinct` is what a translator can be paid for once and `total` is how many places
 * the answer has to be attached to. Deciding which of those numbers a quote is based on
 * is a business call — this function's job is to stop either being guessed.
 */
export function countCatalogText(products: readonly CatalogTextSource[]): CatalogTextCount {
  const distinct = new Set<string>();
  const outside = new Set<string>();
  let groupLabels = 0;
  let optionLabels = 0;
  let ruleMessages = 0;
  let outsideScheme = 0;

  const addOutside = (text: string | undefined): void => {
    if (text === undefined || text === '') return;
    outsideScheme += 1;
    outside.add(text);
  };

  for (const product of products) {
    addOutside(product.nameTh);
    addOutside(product.summaryTh);

    for (const group of product.groups) {
      groupLabels += 1;
      distinct.add(group.labelTh);
      addOutside(group.helperTh);

      for (const value of group.values ?? []) {
        optionLabels += 1;
        distinct.add(value.labelTh);
      }
    }
    for (const rule of product.rules) {
      ruleMessages += 1;
      distinct.add(rule.messageTh);
    }
  }

  return {
    products: products.length,
    groupLabels,
    optionLabels,
    ruleMessages,
    total: groupLabels + optionLabels + ruleMessages,
    distinct: distinct.size,
    outsideScheme,
    outsideSchemeDistinct: outside.size,
  };
}

/* ------------------------------------------------------------------ *
 * The report
 * ------------------------------------------------------------------ */

const bar = (translated: number, total: number): string =>
  `${'█'.repeat(translated)}${'·'.repeat(total - translated)}`;

/**
 * Known gaps in the mechanism itself, as opposed to gaps in the content.
 *
 * Listed rather than left implicit because each one is a decision somebody could
 * reasonably reverse, and a gap nobody wrote down is a gap that gets rediscovered as a
 * bug report.
 */
export const KNOWN_GAPS: readonly string[] = [
  'Metric unit symbols (mm/cm/m) come from @wewin/core/format inside the value and cannot be translated. `ตร.ม.` can, because it lives in the template. Fixing it means a unit key per unit and a param that carries only the number.',
  'Product content — group labels, option labels, rule sentences — has no translated catalogue at all. The seam is `CatalogTextResolver`; nothing implements it, so every one of them renders in Thai in all eight locales.',
  'Notification templates (plan 10.6, ~12 events) live in apps/api and are not in this key scheme yet. They are the same translator bottleneck and should join it before anyone is asked to translate twice.',
  'A length is never grouped: 3205 mm stays 3205 in German rather than 3.205, because inserting a separator means re-parsing a number core deliberately never turns back into one.',
  'A partly translated sentence is one flat string, so `Rendered.locale` describes the template and not every span in it. Once a German template carries an untranslated Thai product label, no single `lang` attribute is right for the result. Fixing it means returning parts rather than a string, and it only starts to matter the day a locale has templates but no product catalogue.',
];

export function formatCoverageReport(): string {
  const lines: string[] = [];
  const coverage = messageCoverage();
  const problems: readonly CatalogProblem[] = validateAllCatalogs();

  lines.push('@wewin/i18n — message catalogue coverage');
  lines.push('');
  lines.push(`  source locale: ${SOURCE_LOCALE}   keys in scheme: ${String(MESSAGE_KEYS.length)}`);
  lines.push('');

  for (const entry of coverage) {
    lines.push(
      `  ${entry.locale.padEnd(3)} ${entry.endonym.padEnd(12)} ${bar(entry.translated, entry.total)}  ${String(entry.translated)}/${String(entry.total)}  ${entry.status}`,
    );
  }

  lines.push('');
  if (problems.length === 0) {
    lines.push('  no malformed templates');
  } else {
    lines.push(`  ${String(problems.length)} MALFORMED TEMPLATES`);
    for (const problem of problems) {
      lines.push(`    ${problem.locale} ${problem.key} [${problem.kind}] ${problem.detail}`);
    }
  }

  for (const entry of coverage) {
    if (entry.missing.length === 0) continue;

    lines.push('');
    lines.push(
      `── ${entry.locale} (${entry.endonym}) — ${String(entry.missing.length)} to translate ──`,
    );
    for (const key of entry.missing) {
      lines.push(`  ${key}`);
      lines.push(`    holes:  ${MESSAGE_PARAMS[key].map((name) => `{${name}}`).join(' ')}`);
      lines.push(`    ${SOURCE_LOCALE}:     ${SOURCE_CATALOG.messages[key]}`);
    }
  }

  lines.push('');
  lines.push('── known gaps in the mechanism ──');
  for (const gap of KNOWN_GAPS) lines.push(`  · ${gap}`);

  return lines.join('\n');
}
