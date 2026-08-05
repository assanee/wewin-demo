import { describe, expect, test } from 'vitest';
import type { MessageKey, MessageParamsByKey } from '@wewin/core';
import { MESSAGE_KEYS } from '@wewin/core/message';
import { products } from '@wewin/core/fixtures';
import {
  CATALOGS,
  type LocaleCatalog,
  MESSAGE_PARAMS,
  SOURCE_CATALOG,
  placeholdersIn,
  validateAllCatalogs,
  validateCatalog,
} from '../src/catalog.js';
import { countCatalogText, messageCoverage } from '../src/coverage.js';
import { LOCALES } from '../src/locales.js';
import { produced } from './support/messages.js';

/* ------------------------------------------------------------------ *
 * The table this package keeps against core's type
 * ------------------------------------------------------------------ */

/**
 * Compile-time proof that `MESSAGE_PARAMS` names *every* param of every key.
 *
 * The declared type of `MESSAGE_PARAMS` already rejects a name core does not have — a
 * typo is a compile error in `catalog.ts`. It cannot reject a name that is simply
 * absent, because a shorter array is still assignable, and an absent name is the worse
 * failure: the renderer would never fill that hole, `fillTemplate` would refuse the
 * template, and every locale would fall back for a reason nobody could see.
 *
 * If a param goes missing, `Missing` resolves to its name instead of `never` and the
 * annotation below fails to compile — before any assertion in this file runs.
 */
type Missing = {
  [K in MessageKey]: Exclude<
    keyof MessageParamsByKey[K] & string,
    (typeof MESSAGE_PARAMS)[K][number]
  >;
}[MessageKey];

const NO_MISSING_PARAMS: Missing extends never ? true : Missing = true;

describe('MESSAGE_PARAMS mirrors core', () => {
  test('covers every key and every param, checked by the compiler', () => {
    expect(NO_MISSING_PARAMS).toBe(true);
    expect(Object.keys(MESSAGE_PARAMS).sort()).toEqual([...MESSAGE_KEYS].sort());
  });

  test('and matches what core actually emits at run time', () => {
    // The compile-time check is against core's *types*. This one is against nine real
    // messages produced by `validate`, `optionStatesFor` and `calcPrice` — so a param
    // that exists in the type and never in the payload is caught too.
    for (const key of MESSAGE_KEYS) {
      expect(Object.keys(produced[key].params).sort()).toEqual([...MESSAGE_PARAMS[key]].sort());
    }
  });
});

/* ------------------------------------------------------------------ *
 * The catalogues as shipped
 * ------------------------------------------------------------------ */

describe('the shipped catalogues', () => {
  test('Thai is complete, and its completeness is a type rather than this test', () => {
    // `SourceCatalog.messages` is `Record<MessageKey, Template>` — total. Adding a key to
    // core makes `catalogs/th.ts` stop compiling. This assertion only witnesses it.
    for (const key of MESSAGE_KEYS) {
      expect(SOURCE_CATALOG.messages[key]).toBeTruthy();
    }
  });

  test('no shipped template is malformed', () => {
    expect(validateAllCatalogs()).toEqual([]);
  });

  test('every Thai template uses exactly the holes its key carries', () => {
    for (const key of MESSAGE_KEYS) {
      expect([...placeholdersIn(SOURCE_CATALOG.messages[key])].sort()).toEqual(
        [...MESSAGE_PARAMS[key]].sort(),
      );
    }
  });

  test('the other seven are honestly empty, not half-guessed', () => {
    // The claim this package makes about itself, kept true by a test rather than by a
    // paragraph: nothing was machine-translated, so nothing is there.
    for (const locale of LOCALES) {
      if (locale === 'th') continue;
      expect(CATALOGS[locale].status).toBe('untranslated');
      expect(Object.keys(CATALOGS[locale].messages)).toEqual([]);
    }
  });
});

describe('coverage counts what is missing rather than claiming it', () => {
  test('one complete catalogue and seven empty ones', () => {
    const coverage = messageCoverage();
    const thai = coverage.find((entry) => entry.locale === 'th');

    expect(thai?.translated).toBe(MESSAGE_KEYS.length);
    expect(thai?.missing).toEqual([]);

    for (const entry of coverage.filter((item) => item.locale !== 'th')) {
      expect(entry.translated).toBe(0);
      expect([...entry.missing].sort()).toEqual([...MESSAGE_KEYS].sort());
    }
  });

  test('the size of the content bottleneck, measured instead of estimated', () => {
    // Plan 13 sizes this as "81 products × 8 languages" and leaves it there. The unit is
    // not the product: 1,625 places a translation attaches, but only 42 distinct strings
    // to write, because the same option vocabulary is authored on product after product.
    // Those two numbers imply very different quotes and very different schedules.
    const count = countCatalogText(products);

    expect(count.products).toBe(81);
    expect(count.total).toBe(1_625);
    expect(count.distinct).toBe(42);

    // And the part this package's seam does *not* reach, counted apart so the 42 above is
    // never mistaken for the whole job: product names, summaries and field helpers.
    expect(count.outsideScheme).toBe(243);
    expect(count.outsideSchemeDistinct).toBe(91);
  });
});

/* ------------------------------------------------------------------ *
 * What a translator can get wrong
 * ------------------------------------------------------------------ */

const catalogWith = (key: MessageKey, template: string): LocaleCatalog => ({
  locale: 'de',
  status: 'translated',
  messages: { [key]: template },
});

describe('validateCatalog', () => {
  test('accepts a template that reorders the holes — that is the whole point', () => {
    // German puts the range first. Nothing about the mechanism resists it.
    expect(
      validateCatalog(catalogWith('issue.range.outOfRange', 'Zwischen {range} für {group}')),
    ).toEqual([]);
  });

  test('accepts a hole used twice', () => {
    expect(
      validateCatalog(catalogWith('issue.range.outOfRange', '{group}: {range} ({group})')),
    ).toEqual([]);
  });

  test('rejects a hole the key does not have', () => {
    const problems = validateCatalog(
      catalogWith('issue.range.outOfRange', '{group} — {ranges}'),
    );
    expect(problems.map((problem) => problem.kind).sort()).toEqual([
      'missingPlaceholder',
      'unknownPlaceholder',
    ]);
  });

  test('rejects a template that dropped a hole, which is the failure that looks fine', () => {
    // `'{group} muss im zulässigen Bereich liegen'` is a fluent German sentence that has
    // silently stopped telling the customer the numbers. Nothing about the rendered
    // string would give it away — there is no leftover brace to grep for.
    const problems = validateCatalog(
      catalogWith('issue.range.outOfRange', '{group} liegt außerhalb'),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]?.kind).toBe('missingPlaceholder');
    expect(problems[0]?.detail).toContain('{range}');
  });

  test('rejects a blank template, which coverage would otherwise count as done', () => {
    const problems = validateCatalog(catalogWith('issue.rule', '   '));
    expect(problems[0]?.kind).toBe('empty');
  });

  test('rejects a stray brace left by a half-finished edit', () => {
    const problems = validateCatalog(
      catalogWith('issue.range.outOfRange', '{group} {range} {'),
    );
    expect(problems.map((problem) => problem.kind)).toEqual(['strayBrace']);
  });

  test('reports every problem in a file, not the first one', () => {
    const problems = validateCatalog({
      locale: 'de',
      status: 'translated',
      messages: {
        'issue.rule': '',
        'issue.range.outOfRange': '{group} {nope}',
      },
    });
    expect(problems.length).toBeGreaterThan(2);
    expect(new Set(problems.map((problem) => problem.key)).size).toBe(2);
  });
});
