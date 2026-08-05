import { afterEach, describe, expect, test, vi } from 'vitest';
import type { CatalogTextRef, MessageKey } from '@wewin/core';
import { MESSAGE_KEYS } from '@wewin/core/message';
import { CATALOGS, type LocaleCatalog } from '../src/catalog.js';
import { UNAVAILABLE_TEXT } from '../src/catalogs/th.js';
import type { Locale } from '../src/locales.js';
import { type RenderIssue, createTranslator, messageId } from '../src/translate.js';
import { produced } from './support/messages.js';

/*
 * What happens when the translation is not there — which today is every locale but one,
 * and which will still be the common case a year from now.
 *
 * The brief's three prohibitions, tested one per case: never an empty string, never a
 * raw dotted key on a customer's screen, never silence.
 */

const OUT_OF_RANGE = produced['issue.range.outOfRange'];

const withCatalog = (locale: Locale, catalog: LocaleCatalog): Record<Locale, LocaleCatalog> => ({
  ...CATALOGS,
  [locale]: catalog,
});

const collect = (): { issues: RenderIssue[]; onIssue: (issue: RenderIssue) => void } => {
  const issues: RenderIssue[] = [];
  return { issues, onIssue: (issue) => issues.push(issue) };
};

describe('a locale with no catalogue', () => {
  test('renders the source language, marked, and reports it once per message', () => {
    const sink = collect();
    const german = createTranslator('de', { onIssue: sink.onIssue });

    const rendered = german.render(OUT_OF_RANGE);

    expect(rendered.text).toContain('ความกว้าง');
    expect(rendered.locale).toBe('th');
    expect(rendered.fallback).toBe(true);
    expect(sink.issues).toHaveLength(1);
    expect(sink.issues[0]).toMatchObject({
      kind: 'missingTemplate',
      locale: 'de',
      key: 'issue.range.outOfRange',
    });
  });

  test('the issues are on the result too, so a page can count them without a sink', () => {
    const german = createTranslator('de', { onIssue: () => undefined });
    expect(german.render(OUT_OF_RANGE).issues.map((issue) => issue.kind)).toEqual([
      'missingTemplate',
    ]);
  });

  test('`has` answers about this locale, not about the fallback', () => {
    expect(createTranslator('de').has('issue.rule')).toBe(false);
    expect(createTranslator('th').has('issue.rule')).toBe(true);
  });
});

describe('a locale with a catalogue', () => {
  /** A German catalogue, written here as a fixture — not shipped, and not invented content. */
  const german: LocaleCatalog = {
    locale: 'de',
    status: 'translated',
    messages: { 'issue.range.outOfRange': '{group} muss zwischen {range} liegen' },
  };

  test('uses its own word order, and says the text is German', () => {
    const translator = createTranslator('de', {
      catalogs: withCatalog('de', german),
      onIssue: () => undefined,
    });
    const rendered = translator.render(OUT_OF_RANGE);

    expect(rendered.text).toBe('ความกว้าง muss zwischen 60–400 cm liegen');
    expect(rendered.locale).toBe('de');
  });

  test('but still reports a fallback, because the product’s own words are still Thai', () => {
    // The mixed case, and it is the *normal* case until a product catalogue is
    // translated. `fallback: true` with `locale: 'de'` means: German sentence, Thai
    // words inside it. A caller that sets `lang="de"` on the whole string is wrong about
    // part of it — the gap is listed in `KNOWN_GAPS`, not papered over here.
    const translator = createTranslator('de', {
      catalogs: withCatalog('de', german),
      onIssue: () => undefined,
    });

    expect(translator.render(OUT_OF_RANGE).fallback).toBe(true);
  });

  test('a resolver for the product’s words closes the last gap', () => {
    const labels: Record<string, string> = { 'awn-4t.width': 'Breite' };
    const catalogText = (ref: CatalogTextRef): string | undefined =>
      ref.on === 'groupLabel' ? labels[`${ref.productId}.${ref.groupCode}`] : undefined;

    const translator = createTranslator('de', {
      catalogs: withCatalog('de', german),
      catalogText,
      onIssue: () => undefined,
    });
    const rendered = translator.render(OUT_OF_RANGE);

    expect(rendered.text).toBe('Breite muss zwischen 60–400 cm liegen');
    expect(rendered.fallback).toBe(false);
  });

  test('a resolver that answers with blank has not answered', () => {
    const translator = createTranslator('de', {
      catalogs: withCatalog('de', german),
      catalogText: () => '   ',
      onIssue: () => undefined,
    });

    // A blank translation is the empty string the brief forbids, arriving through the
    // one door that is not a catalogue file. It is refused there too.
    expect(translator.render(OUT_OF_RANGE).text).toBe('ความกว้าง muss zwischen 60–400 cm liegen');
  });
});

describe('a broken template is refused rather than rendered', () => {
  test('one that lost a hole falls back, because a fluent sentence missing the numbers is worse', () => {
    const sink = collect();
    const translator = createTranslator('de', {
      catalogs: withCatalog('de', {
        locale: 'de',
        status: 'translated',
        messages: { 'issue.range.outOfRange': '{group} liegt außerhalb des Bereichs' },
      }),
      onIssue: sink.onIssue,
    });
    const rendered = translator.render(OUT_OF_RANGE);

    expect(rendered.text).toBe('ความกว้างต้องอยู่ระหว่าง 60–400 cm');
    expect(rendered.locale).toBe('th');
    expect(sink.issues.map((issue) => issue.kind)).toEqual(['brokenTemplate']);
  });

  test('one with a hole that is not a param never leaves the brace on screen', () => {
    const translator = createTranslator('de', {
      catalogs: withCatalog('de', {
        locale: 'de',
        status: 'translated',
        messages: { 'issue.range.outOfRange': '{group} {ranges}' },
      }),
      onIssue: () => undefined,
    });

    expect(translator.render(OUT_OF_RANGE).text).not.toContain('{');
  });

  test('…including one that uses every real param and invents an extra', () => {
    // The case that separates the two halves of `fillTemplate`. The template above is
    // caught by the *used-every-param* check as a side effect, so removing the
    // unknown-hole check on its own changes nothing and a mutation testing it survives.
    // This one uses `{group}` and `{range}` correctly, so only the unknown-hole check
    // stands between `{bogus}` and a customer.
    const sink = collect();
    const translator = createTranslator('de', {
      catalogs: withCatalog('de', {
        locale: 'de',
        status: 'translated',
        messages: { 'issue.range.outOfRange': '{group} {range} {bogus}' },
      }),
      onIssue: sink.onIssue,
    });
    const rendered = translator.render(OUT_OF_RANGE);

    expect(rendered.text).toBe('ความกว้างต้องอยู่ระหว่าง 60–400 cm');
    expect(rendered.text).not.toContain('bogus');
    expect(sink.issues.map((issue) => issue.kind)).toEqual(['brokenTemplate']);
  });
});

describe('the floor under everything', () => {
  /** A source catalogue that has lost the key — the state the type system cannot see. */
  const hobbled = withCatalog('th', {
    locale: 'th',
    status: 'source',
    messages: {},
  });

  test('shows a sentence, never the key', () => {
    const sink = collect();
    const translator = createTranslator('th', { catalogs: hobbled, onIssue: sink.onIssue });
    const rendered = translator.render(OUT_OF_RANGE);

    expect(rendered.text).toBe(UNAVAILABLE_TEXT);
    expect(rendered.text).not.toContain('issue.range');
    expect(rendered.text.trim()).not.toBe('');
    expect(rendered.fallback).toBe(true);

    // Silence is the third prohibition. The key an engineer needs goes here, where a
    // customer will not see it.
    expect(sink.issues.map((issue) => issue.kind)).toEqual(['missingSourceTemplate']);
    expect(sink.issues[0]?.key).toBe('issue.range.outOfRange');
  });

  test('and it holds for every key in the scheme', () => {
    const translator = createTranslator('my', { catalogs: hobbled, onIssue: () => undefined });
    for (const key of MESSAGE_KEYS) {
      expect(translator.render(produced[key]).text).toBe(UNAVAILABLE_TEXT);
    }
  });
});

describe('loud in development, quiet but visible in production', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  test('the default sink warns when NODE_ENV is not production', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    createTranslator('de').render(OUT_OF_RANGE);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('issue.range.outOfRange');
  });

  test('in production it says nothing, and the fallback is still marked on the result', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const rendered = createTranslator('de').render(OUT_OF_RANGE);

    expect(warn).not.toHaveBeenCalled();
    // Quiet is not the same as invisible: a customer sees Thai, and the page can see why.
    expect(rendered.fallback).toBe(true);
    expect(rendered.issues.map((issue) => issue.kind)).toEqual(['missingTemplate']);
  });
});

describe('messageId', () => {
  test('is the same in every locale, so a React list does not rebuild on a language switch', () => {
    const first = messageId(produced['price.line.option']);
    expect(messageId(produced['price.line.option'])).toBe(first);
    expect(first).toContain('price.line.option');
    expect(first).toContain('awn-4t');
  });

  test('distinguishes two rows that differ only in which option they name', () => {
    const ids = new Set(MESSAGE_KEYS.map((key: MessageKey) => messageId(produced[key])));
    expect(ids.size).toBe(MESSAGE_KEYS.length);
  });

  test('carries no rendered text, so it cannot change when a translation lands', () => {
    // The failure it exists to prevent: the label was the key, the label was Thai, and
    // the first German catalogue would have re-keyed every row in the breakdown.
    expect(messageId(produced['price.line.option'])).not.toContain('สี');
  });
});
