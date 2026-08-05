import { describe, expect, test } from 'vitest';
import { MESSAGE_KEYS, type Message, type MessageKey } from '@wewin/core/message';
import { calcPrice } from '@wewin/core/pricing';
import { optionStatesFor } from '@wewin/core/option-states';
import { validate } from '@wewin/core/validation';
import { getProductById } from '@wewin/core/fixtures';
import { toMicrons } from '@wewin/core/units';
import type { CustomGroup, Product, SkuGroup } from '@wewin/core';
import { LOCALES } from './locales';
import { messageIdentity, messagesEn, messagesTh, renderMessage } from './messages';
import type { ContentCatalogues } from './content';
import { decodeNumerals } from './testing/decode';

/*
 * The storefront half of the debt plan section 5 named.
 *
 * `packages/core/tests/messages.test.ts` proves that core stopped *building* Thai and
 * that a renderer given only keys and params can reproduce the old sentences. This
 * file proves the other half: that the renderer which actually ships does reproduce
 * them, that a second language can disagree about word order without losing a value,
 * and that a locale still cannot move a number once it is inside a sentence.
 */

const product = (id: string): Product => {
  const found = getProductById(id);
  if (!found) throw new Error(`fixture missing: ${id}`);
  return found;
};

const cm = (value: number): bigint => toMicrons(value, 'cm');

const AWN_OK = {
  profile_color: 'DW',
  glass_color: 'GRN',
  glass_thickness: 'T5',
  insect_screen: 'NS0',
} as const;

/** awn-4t with one option marked out of stock, the only route to `option.unavailable`. */
const withUnavailable = (groupCode: string, valueCode: string): Product => {
  const base = product('awn-4t');
  return {
    ...base,
    groups: base.groups.map((group) =>
      group.kind === 'sku' && group.code === groupCode
        ? ({
            ...group,
            values: group.values.map((value) =>
              value.code === valueCode ? { ...value, available: false } : value,
            ),
          } satisfies SkuGroup)
        : group,
    ),
  };
};

/**
 * awn-4t whose width range sits strictly between two eighth-inch marks.
 *
 * 3,175 × 315 = 1,000,125 µm and 3,175 × 316 = 1,003,300 µm, so a range of
 * 1,000,200–1,003,000 contains no mark at all. The only way to reach
 * `issue.step.noMarkInRange`, and lifted from core's own suite so the two agree about
 * what that message means.
 */
const betweenMarks = (): Product => {
  const base = product('awn-4t');
  const width = base.groups.find(
    (group): group is CustomGroup => group.kind === 'custom' && group.code === 'width',
  );
  if (!width) throw new Error('fixture missing: awn-4t.width');

  return {
    ...base,
    groups: base.groups.map((group) =>
      group === width ? { ...width, minUm: 1_000_200n, maxUm: 1_003_000n } : group,
    ),
  };
};

function mustFind(issues: { ruleId: string; message: Message }[], ruleId: string): Message {
  const found = issues.find((issue) => issue.ruleId === ruleId);
  if (!found) throw new Error(`no issue ${ruleId} in [${issues.map((i) => i.ruleId).join(', ')}]`);
  return found.message;
}

function mustState(item: Product, groupCode: string, valueCode: string): Message {
  const reason = optionStatesFor(item, AWN_OK, { width: cm(320), height: cm(160) })[groupCode]?.[
    valueCode
  ]?.reason;
  if (!reason) throw new Error(`no reason on ${groupCode}.${valueCode}`);
  return reason;
}

function mustLine(price: { lines: { label: Message }[] }, index: number): Message {
  const line = price.lines[index];
  if (!line) throw new Error(`no breakdown row ${String(index)}`);
  return line.label;
}

/** Every key, produced by a real configuration rather than written out by hand. */
const produced: Record<MessageKey, Message> = {
  'issue.selection.unknown': mustFind(
    validate(
      product('awn-4t'),
      { ...AWN_OK, glass_color: 'PLAID' },
      { width: cm(320), height: cm(160) },
    ),
    'selection:glass_color',
  ),
  'issue.range.outOfRange': mustFind(
    validate(product('awn-4t'), AWN_OK, { width: cm(40), height: cm(160) }),
    'range:width',
  ),
  'issue.step.willSnapUp': mustFind(
    validate(product('awn-4t'), AWN_OK, { width: cm(320), height: cm(160.3) }),
    'step:height',
  ),
  'issue.step.aboveLargestMark': mustFind(
    validate(product('awn-4t'), AWN_OK, { width: cm(320), height: 2_499_000n }, { height: 'in' }),
    'step:height',
  ),
  'issue.step.noMarkInRange': mustFind(
    validate(betweenMarks(), AWN_OK, { width: 1_000_300n, height: cm(160) }, { width: 'in' }),
    'step:width',
  ),
  'issue.rule': mustFind(
    validate(
      product('awn-4t'),
      { ...AWN_OK, glass_thickness: 'LAM' },
      { width: cm(260), height: cm(160) },
    ),
    'awn4t-lam-width',
  ),
  'option.unavailable': mustState(withUnavailable('insect_screen', 'NS1'), 'insect_screen', 'NS1'),
  'price.line.base': mustLine(
    calcPrice(product('awn-4t'), AWN_OK, { width: cm(320), height: cm(160) }, 1),
    0,
  ),
  'price.line.option': mustLine(
    calcPrice(product('awn-4t'), AWN_OK, { width: cm(320), height: cm(160) }, 1),
    1,
  ),
};

describe('the shipping Thai renderer says what the old sentences said', () => {
  // Character for character, and against the same expectations core's own suite holds.
  // Two renderers of one rule that disagree is the failure the `Message` type exists to
  // prevent between the tooltip and the issue panel; it would be no better between
  // core's test and the app.
  test.each([
    ['issue.selection.unknown', 'สีกระจกที่เลือกไว้ไม่มีอยู่ในรายการของสินค้านี้ — กรุณาเลือกใหม่'],
    ['issue.range.outOfRange', 'ความกว้างต้องอยู่ระหว่าง 60–400 cm'],
    ['issue.step.willSnapUp', 'ความสูงปรับได้ทีละ 0.5 cm ระบบจะปัดเป็น 160.5 cm'],
    ['issue.step.aboveLargestMark', 'ความสูงปรับได้ทีละ 1/8" ค่าสูงสุดที่ปรับได้คือ 98 3/8"'],
    [
      'issue.step.noMarkInRange',
      'ความกว้างปรับได้ทีละ 1/8" และไม่มีค่าที่ลงตัวในช่วง ≈39 3/8"–39 1/2"',
    ],
    ['issue.rule', 'กระจกสองชั้นรองรับความกว้างไม่เกิน 200 cm'],
    ['option.unavailable', 'ตอนนี้มุ้งลวด "มีมุ้งลวด" ยังไม่พร้อมผลิต'],
    ['price.line.base', 'ราคาฐานตามพื้นที่ 5.12 ตร.ม.'],
    ['price.line.option', 'สีโปรไฟล์อะลูมิเนียม · ลายไม้เข้ม'],
  ] as [MessageKey, string][])('%s', (key, expected) => {
    expect(renderMessage(produced[key], 'th').text).toBe(expected);
  });
});

describe('every key is covered, and by more than one language', () => {
  test('Thai renders all nine — a missing one is a blank line on screen', () => {
    for (const key of MESSAGE_KEYS) {
      expect(messagesTh[key]).toBeTypeOf('function');
      expect(renderMessage(produced[key], 'th').text.length).toBeGreaterThan(0);
    }
  });

  test('English renders all nine, and says something different', () => {
    for (const key of MESSAGE_KEYS) {
      const th = renderMessage(produced[key], 'th');
      const en = renderMessage(produced[key], 'en');

      expect(messagesEn[key]).toBeTypeOf('function');
      expect(en.text.length).toBeGreaterThan(0);

      // Two keys may legitimately match, and only two. `issue.rule`'s whole content is
      // one catalogue sentence a person wrote, and `price.line.option` is two
      // catalogue labels with a separator; with no translated catalogue loaded, both
      // languages pass the same Thai through and there is nothing to rearrange. Any
      // *other* key coming out identical means the English entry forgot to be English.
      if (key !== 'issue.rule' && key !== 'price.line.option') {
        expect(en.text).not.toBe(th.text);
      }
    }
  });

  test('and the two that may match do differ once the catalogue has words', () => {
    // The exemption above is about missing content, not about a key that cannot be
    // translated — without this, deleting the English `price.line.option` entry
    // entirely would go unnoticed.
    const catalogues: ContentCatalogues = {
      en: {
        'groupLabel:awn-4t:profile_color': 'Frame colour',
        'optionLabel:awn-4t:profile_color:DW': 'Dark woodgrain',
      },
    };

    expect(renderMessage(produced['price.line.option'], 'en', catalogues).text).toBe(
      'Frame colour · Dark woodgrain',
    );
  });

  test('the six untranslated locales fall back to Thai, and say that they did', () => {
    for (const locale of LOCALES) {
      const rendered = renderMessage(produced['issue.range.outOfRange'], locale);

      expect(rendered.text.length).toBeGreaterThan(0);
      // Never a key, never an empty string — the two ways this fails invisibly.
      expect(rendered.text).not.toContain('issue.range');

      // `fallback` reports **any** Thai in the sentence, not only a missing renderer.
      // With no content catalogue loaded, every locale but Thai interpolates the Thai
      // group label, so every locale but Thai is flagged — which is the point.
      expect(rendered.fallback).toBe(locale !== 'th');
    }
  });

  test('an English sentence with a Thai label inside it is still marked', () => {
    // The finding this pins. `fallback` used to mean only "this locale has no renderer
    // for the key", so `ความกว้าง must be between 60–600 cm` came out with
    // `fallback: false` — the sentence *was* English — and `IssuePanel` therefore
    // rendered it with no `lang` at all inside `<html lang="en">`. The one signal that
    // says "this bit is not translated yet" was structurally unable to fire on the only
    // bit that was not, and a screen reader read Thai in an English voice.
    const untranslated = renderMessage(produced['issue.range.outOfRange'], 'en');
    expect(untranslated.text).toContain('ความกว้าง');
    expect(untranslated.fallback).toBe(true);

    // And it stops being marked the moment the content really is translated — otherwise
    // the flag would just be "locale !== 'th'" wearing a longer name.
    const translated = renderMessage(produced['issue.range.outOfRange'], 'en', {
      en: { 'groupLabel:awn-4t:width': 'Width' },
    });
    expect(translated.text).toContain('Width');
    expect(translated.text).not.toContain('ความกว้าง');
    expect(translated.fallback).toBe(false);
  });
});

describe('a locale cannot move a number that is inside a sentence', () => {
  test('the bounds in an out-of-range message are the same bounds in all eight', () => {
    // The message carries `minUm`/`maxUm` as the catalogue's own bigints. If a locale
    // were an input to any arithmetic — or if a param had been handed over as
    // pre-formatted text and re-parsed — this is where it would show up, in the one
    // sentence whose whole job is telling a customer which sizes exist.
    const message = produced['issue.range.outOfRange'];

    const bounds = LOCALES.map((locale) => {
      // Read the glyphs back to ASCII *in place* — `decodeNumerals` keeps the `–`
      // between the two bounds, so the two numbers stay two numbers. Reading the whole
      // sentence as one quantity would concatenate them into `60400`, which is how the
      // first version of this test passed while proving nothing.
      const ascii = decodeNumerals(renderMessage(message, locale).text, locale);
      // Word order differs between Thai and English, so the *set* of numbers in the
      // sentence is the invariant, not where they sit in it.
      return new Set(ascii.match(/\d+(?:\.\d+)?/g) ?? []);
    });

    for (const set of bounds) expect(set).toEqual(new Set(['60', '400']));
  });

  test('the base row charges the same area in all eight', () => {
    // 320 × 160 cm is 5.12 m². The message carries square micrometres; the divide
    // happens once, in `Formatters`, and cannot depend on who is reading.
    for (const locale of LOCALES) {
      const ascii = decodeNumerals(renderMessage(produced['price.line.base'], locale).text, locale);
      expect(ascii.match(/\d+(?:\.\d+)?/g) ?? []).toContain('5.12');
    }
  });

  test('an imperial step keeps its fraction rather than becoming a decimal', () => {
    // `1/8"` is two numerals with a slash between them, and the slash is core's. A
    // locale layer that reformatted the pair as a number would produce `0.125"`, which
    // is not how a tape is read and not what `parseMeasure` accepts back.
    for (const locale of LOCALES) {
      expect(renderMessage(produced['issue.step.aboveLargestMark'], locale).text).toContain('/');
    }
  });
});

describe('catalogue content inside a message', () => {
  test('a translated catalogue is used when there is one', () => {
    // The path is empty in production (plan 13: translating 81 products is a person's
    // job) but it is not untested for that — a populated catalogue proves the lookup
    // resolves by ref and the rest of the sentence still comes from the renderer.
    const catalogues: ContentCatalogues = {
      en: { 'groupLabel:awn-4t:width': 'Width' },
    };

    const text = renderMessage(produced['issue.range.outOfRange'], 'en', catalogues).text;
    expect(text).toContain('Width');
    expect(text).not.toContain('ความกว้าง');
  });

  test('and the Thai source stands in when there is not', () => {
    expect(renderMessage(produced['issue.range.outOfRange'], 'en').text).toContain('ความกว้าง');
  });
});

describe('a breakdown row keeps its identity when the language changes', () => {
  test('the same row has the same key in every locale', () => {
    // `PriceBreakdownList` used the rendered label as its React key. Switching language
    // would then change every key at once and force React to rebuild the whole list —
    // and two rows whose translations collided would trip the duplicate-key warning in
    // one language and not another.
    const base = produced['price.line.base'];
    const option = produced['price.line.option'];

    expect(messageIdentity(base)).toBe(messageIdentity(base));
    expect(messageIdentity(base)).not.toBe(messageIdentity(option));
    // Built from the key and the refs, so it contains no words at all.
    expect(messageIdentity(option)).toContain('price.line.option');
    expect(messageIdentity(option)).not.toContain('สีโปรไฟล์');
  });

  test('every row of a real breakdown has a distinct key', () => {
    const price = calcPrice(product('awn-4t'), AWN_OK, { width: cm(320), height: cm(160) }, 1);
    const identities = price.lines.map((line) => messageIdentity(line.label));

    expect(new Set(identities).size).toBe(identities.length);
    expect(identities.length).toBeGreaterThan(1);
  });
});
