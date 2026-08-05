import type { MessageKey, MessageParamsByKey } from '@wewin/core';
import { MESSAGE_KEYS } from '@wewin/core/message';
import { de } from './catalogs/de.js';
import { en } from './catalogs/en.js';
import { hi } from './catalogs/hi.js';
import { la } from './catalogs/la.js';
import { my } from './catalogs/my.js';
import { th } from './catalogs/th.js';
import { vi } from './catalogs/vi.js';
import { zh } from './catalogs/zh.js';
import { LOCALES, type Locale, SOURCE_LOCALE } from './locales.js';

/**
 * What a locale catalogue is, and what a template is allowed to say.
 *
 * A catalogue entry is **a string, not a function**. That is the constraint the whole
 * shape is built around: the person who fills in `catalogs/my.ts` is a translator, and
 * what a translator can be handed is prose with holes in it —
 *
 *     'issue.range.outOfRange': '{group}ต้องอยู่ระหว่าง {range}',
 *
 * — where every hole is a *value* the renderer formats in that locale's own numerals,
 * and never a substring somebody else already rendered. Plan 5 is that rule; this file
 * is where it becomes checkable.
 *
 * Word order comes for free from the template: a language that puts the range first
 * writes it first, and one that needs the group label twice writes it twice. What a
 * template may *not* do is drop a hole — see `validateCatalog`.
 */

/** A template: prose with `{name}` holes, one per param the key carries. */
export type Template = string;

/**
 * Where a catalogue came from. Provenance, which coverage cannot tell you.
 *
 * `translated` is a claim that a person who reads the language wrote it. Nothing in this
 * package is entitled to make that claim on their behalf, which is why seven of the
 * eight catalogues ship as `untranslated` rather than as a machine-translated guess —
 * plan 13 names this as a human bottleneck, and a wrong Burmese sentence that nobody on
 * the team can read is worse than a visible Thai fallback.
 */
export type CatalogStatus = 'source' | 'translated' | 'untranslated';

export interface LocaleCatalog {
  readonly locale: Locale;
  readonly status: CatalogStatus;
  /** Partial on purpose. A missing key is a fallback, not a crash — see `translate.ts`. */
  readonly messages: Partial<Readonly<Record<MessageKey, Template>>>;
}

/**
 * The source catalogue, and the one place completeness is a *type* rather than a test.
 *
 * `Record<MessageKey, Template>` is total: add a key to core's `MessageParamsByKey` and
 * `catalogs/th.ts` stops compiling until somebody writes the Thai for it. That is the
 * guarantee behind "never a raw dotted key shown to a customer" — the fallback cannot be
 * missing, because a missing fallback is a build failure.
 */
export interface SourceCatalog extends LocaleCatalog {
  readonly locale: typeof SOURCE_LOCALE;
  readonly status: 'source';
  readonly messages: Readonly<Record<MessageKey, Template>>;
}

export const CATALOGS: Readonly<Record<Locale, LocaleCatalog>> = { de, en, hi, la, my, th, vi, zh };

export const SOURCE_CATALOG: SourceCatalog = th;

/* ------------------------------------------------------------------ *
 * The params each key carries, as data
 * ------------------------------------------------------------------ */

/**
 * Which holes each template must have — the mirror of core's `MessageParamsByKey`.
 *
 * Written out here rather than derived because core's map is a *type*: the param names
 * exist at compile time and this package needs them at run time, to check a translator's
 * template against and to fill the holes from.
 *
 * It cannot drift silently in either direction:
 *   · a param renamed in core makes a literal below unassignable — a compile error here;
 *   · a key added to core leaves this record missing a property — a compile error here;
 *   · a *name dropped* from one of the arrays is caught by `tests/catalog.test.ts`,
 *     which re-derives the same union from core's type and from real produced messages.
 */
export const MESSAGE_PARAMS = {
  'issue.selection.unknown': ['group'],
  'issue.range.outOfRange': ['group', 'range'],
  'issue.step.willSnapUp': ['group', 'step', 'snapped'],
  'issue.step.aboveLargestMark': ['group', 'step', 'largest'],
  'issue.step.noMarkInRange': ['group', 'step', 'range'],
  'issue.rule': ['message'],
  'option.unavailable': ['group', 'option'],
  'price.line.base': ['billableArea'],
  'price.line.option': ['group', 'option'],
  /*
   * `as const satisfies`, and the two words are not interchangeable here.
   *
   * A plain `: {…}` annotation would erase the literals: `typeof MESSAGE_PARAMS[K][number]`
   * would widen back to `keyof MessageParamsByKey[K]`, and the exhaustiveness check in
   * `tests/catalog.test.ts` would compare that union against itself and pass however many
   * names were missing from the arrays below. It did, until a mutation went looking.
   *
   * `as const` keeps the tuples literal so the test can see what is actually written;
   * `satisfies` keeps the compiler rejecting a name core does not have.
   */
} as const satisfies {
  readonly [K in MessageKey]: readonly (keyof MessageParamsByKey[K] & string)[];
};

/* ------------------------------------------------------------------ *
 * Template checking
 * ------------------------------------------------------------------ */

/** A `{name}` hole. Names are identifiers so that a stray brace cannot look like one. */
export const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9]*)\}/g;

export const placeholdersIn = (template: Template): readonly string[] =>
  [...template.matchAll(PLACEHOLDER)].map((match) => match[1] ?? '');

export interface CatalogProblem {
  readonly locale: Locale;
  readonly key: MessageKey;
  readonly kind: 'empty' | 'unknownPlaceholder' | 'missingPlaceholder' | 'strayBrace';
  readonly detail: string;
}

/**
 * Everything wrong with a catalogue, as data rather than as a throw.
 *
 * Three of the four kinds are the ones a translator produces by accident, and the
 * second and third are the reason this exists at all:
 *
 *   `unknownPlaceholder` — `{ranges}` for `{range}`. The hole would never be filled.
 *   `missingPlaceholder` — a German `'{group} muss zwischen liegen'` that lost `{range}`
 *                          renders as a fluent sentence which does not say the numbers.
 *                          A test that only checked for leftover braces would pass it.
 *
 * Returned rather than thrown so the whole file can be reported at once: a translator
 * sending a corrected catalogue back wants every problem in it, not the first one.
 */
export function validateCatalog(catalog: LocaleCatalog): readonly CatalogProblem[] {
  const problems: CatalogProblem[] = [];

  for (const key of MESSAGE_KEYS) {
    const template = catalog.messages[key];
    if (template === undefined) continue;

    const problem = (kind: CatalogProblem['kind'], detail: string): void => {
      problems.push({ locale: catalog.locale, key, kind, detail });
    };

    if (template.trim() === '') {
      // An empty template is worse than an absent one: absent falls back to Thai and is
      // reported as a gap, empty renders as a blank line and is reported as coverage.
      problem('empty', 'template is blank; delete the key to fall back instead');
      continue;
    }

    const expected = new Set<string>(MESSAGE_PARAMS[key]);
    const found = new Set(placeholdersIn(template));

    for (const name of found) {
      if (!expected.has(name)) problem('unknownPlaceholder', `{${name}} is not a param of ${key}`);
    }
    for (const name of expected) {
      if (!found.has(name)) problem('missingPlaceholder', `{${name}} is never used`);
    }

    // Anything left once the holes are removed must not still look like one. `{{` and a
    // half-typed `{grou` both land here rather than reaching a customer.
    if (/[{}]/.test(template.replace(PLACEHOLDER, ''))) {
      problem('strayBrace', 'a { or } outside a placeholder');
    }
  }

  return problems;
}

/** Every catalogue's problems, for CI and for the coverage report. */
export const validateAllCatalogs = (): readonly CatalogProblem[] =>
  LOCALES.flatMap((locale) => validateCatalog(CATALOGS[locale]));
