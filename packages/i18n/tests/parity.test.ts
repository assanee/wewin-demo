import { describe, expect, test } from 'vitest';
import type { Message, MessageKey } from '@wewin/core';
import { MESSAGE_KEYS } from '@wewin/core/message';
import { calcPrice } from '@wewin/core/pricing';
import { optionStatesFor } from '@wewin/core/option-states';
import { validate } from '@wewin/core/validation';
import { products } from '@wewin/core/fixtures';
import type { CustomGroup, Product, SkuGroup } from '@wewin/core';
import { createTranslator } from '../src/translate.js';
import { INTL_TAG, LOCALES } from '../src/locales.js';
import { produced } from './support/messages.js';
import { deLocalise } from './support/decode.js';

/*
 * The gate.
 *
 * `@wewin/core` restructured nine Thai sentences into keys and params, and proved the
 * restructuring lost nothing by rendering them with a throwaway Thai renderer written
 * inside its own test file. This package is the real renderer. If it does not reproduce
 * the same nine strings, then the sentences a customer reads *did* change — and the
 * change would be invisible, because both halves would still pass their own tests.
 *
 * So the strings below are copied from `packages/core/tests/messages.test.ts` on purpose.
 * Two packages pinning the same literals is the point: an edit to `catalogs/th.ts`
 * that improves the Thai has to be made in both places, deliberately, by someone who
 * has seen both.
 */

const thai = createTranslator('th', { onIssue: (issue) => { throw new Error(issue.kind); } });

describe('Thai says exactly what it said before the restructuring', () => {
  test.each([
    ['issue.selection.unknown', 'สีกระจกที่เลือกไว้ไม่มีอยู่ในรายการของสินค้านี้ — กรุณาเลือกใหม่'],
    ['issue.range.outOfRange', 'ความกว้างต้องอยู่ระหว่าง 60–400 cm'],
    ['issue.step.willSnapUp', 'ความสูงปรับได้ทีละ 0.5 cm ระบบจะปัดเป็น 160.5 cm'],
    ['issue.step.aboveLargestMark', 'ความสูงปรับได้ทีละ 1/8" ค่าสูงสุดที่ปรับได้คือ 98 3/8"'],
    ['issue.step.noMarkInRange', 'ความกว้างปรับได้ทีละ 1/8" และไม่มีค่าที่ลงตัวในช่วง ≈39 3/8"–39 1/2"'],
    ['issue.rule', 'กระจกสองชั้นรองรับความกว้างไม่เกิน 200 cm'],
    ['option.unavailable', 'ตอนนี้มุ้งลวด "มีมุ้งลวด" ยังไม่พร้อมผลิต'],
    ['price.line.base', 'ราคาฐานตามพื้นที่ 5.12 ตร.ม.'],
    ['price.line.option', 'สีโปรไฟล์อะลูมิเนียม · ลายไม้เข้ม'],
  ] as [MessageKey, string][])('%s', (key, expected) => {
    expect(thai.message(produced[key])).toBe(expected);
  });

  test('and that is every key in the scheme, not a selection of them', () => {
    // Without this, a key could be added to core, left out of the table above, and
    // ship untranslated with every test in this file green.
    expect(MESSAGE_KEYS.length).toBe(9);
    expect([...MESSAGE_KEYS].sort()).toEqual(Object.keys(produced).sort());
  });

  test('the Thai renderer never falls back, because Thai is the source', () => {
    for (const key of MESSAGE_KEYS) {
      const rendered = thai.render(produced[key]);
      expect(rendered.locale).toBe('th');
      expect(rendered.fallback).toBe(false);
      expect(rendered.issues).toEqual([]);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Every product, every locale — nothing blank, nothing raw
 * ------------------------------------------------------------------ */

/** Every message a product can produce across a sweep of sizes and selections. */
function sweepMessages(item: Product): Message[] {
  const found: Message[] = [];
  const custom = item.groups.filter((g): g is CustomGroup => g.kind === 'custom');
  const sku = item.groups.filter((g): g is SkuGroup => g.kind === 'sku');

  const defaults: Record<string, string> = {};
  for (const group of sku) defaults[group.code] = group.defaultValue;

  const sizes: Record<string, bigint>[] = [{}];
  for (const group of custom) {
    sizes.push({ [group.code]: group.minUm - group.stepUm });
    sizes.push({ [group.code]: group.maxUm + group.stepUm });
    sizes.push({ [group.code]: group.defaultUm + 1n });
  }

  for (const measures of sizes) {
    for (const issue of validate(item, defaults, measures)) found.push(issue.message);
    for (const group of Object.values(optionStatesFor(item, defaults, measures))) {
      for (const state of Object.values(group)) {
        if (state.reason) found.push(state.reason);
        if (state.warn) found.push(state.warn);
      }
    }
  }

  for (const line of calcPrice(item, defaults, {}, 1).lines) found.push(line.label);

  return found;
}

describe('81 products × 8 locales', () => {
  const all = products.flatMap(sweepMessages);

  test('the sweep really produces messages, so the checks below are not vacuous', () => {
    expect(all.length).toBeGreaterThan(800);
    expect(new Set(all.map((message) => message.key)).size).toBeGreaterThanOrEqual(4);
  });

  test.each(LOCALES)('%s renders every one of them, and never renders a key', (locale) => {
    const translator = createTranslator(locale, { onIssue: () => undefined });
    const bad: string[] = [];

    for (const message of all) {
      const { text } = translator.render(message);

      // The three failures the brief forbids by name.
      if (text.trim() === '') bad.push(`empty: ${message.key}`);
      if (text.includes(message.key)) bad.push(`raw key: ${message.key}`);
      if (/[{}]/.test(text)) bad.push(`unfilled hole: ${message.key} → ${text}`);
    }

    expect(bad.slice(0, 5)).toEqual([]);
  });

  test('an untranslated locale degrades to Thai, and says which language the text is in', () => {
    // Not "renders something". The text must be attributable, because a `lang` attribute
    // that claims German over Thai glyphs picks a font with no Thai in it (plan 8.3).
    const german = createTranslator('de', { onIssue: () => undefined });

    for (const key of MESSAGE_KEYS) {
      const rendered = german.render(produced[key]);
      expect(rendered.locale).toBe('th');
      expect(rendered.fallback).toBe(true);
      // The words are the Thai ones. The *numbers* are not — see below.
      expect(deLocalise(INTL_TAG.de, rendered.text)).toBe(thai.message(produced[key]));
    }
  });

  test('the numbers in a fallback sentence follow the reader, not the sentence', () => {
    // A deliberate split, and the one place this package renders a mixed artefact.
    //
    // German writes `160,5` and uses `.` for thousands. A German reader shown the Thai
    // fallback `160.5 cm` reads one hundred and sixty thousand five hundred — the number
    // is the part of the sentence they *can* read, so rendering it in the source locale
    // is not neutral, it is wrong. Numerals therefore follow the reader even when the
    // words could not.
    const german = createTranslator('de', { onIssue: () => undefined });
    const burmese = createTranslator('my', { onIssue: () => undefined });

    expect(german.message(produced['issue.step.willSnapUp'])).toBe(
      'ความสูงปรับได้ทีละ 0,5 cm ระบบจะปัดเป็น 160,5 cm',
    );
    expect(burmese.message(produced['price.line.base'])).toBe('ราคาฐานตามพื้นที่ ၅.၁၂ ตร.ม.');
  });

  test('and the substitution reaches only digits, not every dot in the sentence', () => {
    // `ตร.ม.` is an abbreviation, not a number. A numeral pass that matched `[\d.]+`
    // would render it `ตร,ม,` in German and `ตร.ม.` would never be seen again — and it
    // would survive a decode-and-compare check, because decoding maps `,` back to `.`.
    const german = createTranslator('de', { onIssue: () => undefined });

    expect(german.message(produced['price.line.base'])).toBe('ราคาฐานตามพื้นที่ 5,12 ตร.ม.');
    expect(german.message(produced['price.line.base'])).toContain('ตร.ม.');
  });
});
