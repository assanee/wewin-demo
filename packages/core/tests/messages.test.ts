import { describe, expect, test } from 'vitest';
import {
  MESSAGE_KEYS,
  type Message,
  type MessageKey,
  type MessageParam,
  isMessage,
  isMessageKey,
  reviveMessage,
} from '../src/message.js';
import { calcPrice, sqUmToSqm } from '../src/pricing.js';
import { optionStatesFor } from '../src/optionStates.js';
import { validate } from '../src/validation.js';
import { formatMeasure, formatRange, formatSqm } from '../src/format.js';
import { products, getProductById } from '../src/data/products.js';
import { toMicrons } from '../src/units.js';
import type { CustomGroup, Product, SkuGroup } from '../src/types/catalog.js';

/*
 * The phase 6a gate.
 *
 * `pricing-parity.test.ts` exists because "the tests still pass" was too weak a bar for
 * a change to the arithmetic. The same is true of a change to the messages: every
 * assertion in `validation.test.ts` could be rewritten to expect a key and still have
 * lost a sentence on the way. So this file holds four claims that the per-module tests
 * cannot make on their own.
 *
 *   1. The key scheme is closed and every key in it is reachable.
 *   2. A Thai renderer built only from keys and params reproduces the sentences the
 *      previous version produced, character for character.
 *   3. Core passes catalogue text through and never builds text. Every string that
 *      leaves core in a message is a string somebody authored in the catalogue.
 *   4. A locale is not an input to core, and every number in a message is the exact
 *      `bigint` the domain holds — including after a round-trip through storage.
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

const paramsOf = (message: Message): MessageParam[] => Object.values(message.params);

/* ------------------------------------------------------------------ *
 * 1. The scheme
 * ------------------------------------------------------------------ */

/**
 * Compile-time proof that the list below is the whole union.
 *
 * If a key is added to `MessageParamsByKey` and not to `EXPECTED_KEYS`, this alias
 * resolves to that key's name instead of `never` and the annotation below fails to
 * compile — before any assertion has a chance to run.
 */
type Unlisted = Exclude<MessageKey, (typeof EXPECTED_KEYS)[number]>;

const EXPECTED_KEYS = [
  'issue.selection.unknown',
  'issue.range.outOfRange',
  'issue.step.willSnapUp',
  'issue.step.aboveLargestMark',
  'issue.step.noMarkInRange',
  'issue.rule',
  'option.unavailable',
  'price.line.base',
  'price.line.option',
] as const satisfies readonly MessageKey[];

const NO_UNLISTED_KEYS: Unlisted extends never ? true : Unlisted = true;

describe('the key scheme is closed', () => {
  test('lists exactly the keys a locale catalogue has to cover', () => {
    expect(NO_UNLISTED_KEYS).toBe(true);
    expect([...MESSAGE_KEYS].sort()).toEqual([...EXPECTED_KEYS].sort());
  });

  test('rejects a key from a future or a mistyped version of core', () => {
    expect(isMessageKey('issue.range.outOfRange')).toBe(true);
    expect(isMessageKey('issue.range.out_of_range')).toBe(false);
    expect(isMessageKey('')).toBe(false);
    expect(isMessageKey(7)).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Every key, produced by the code rather than written by hand
 *
 * A key nobody produces is a translation somebody paid for and nobody sees, and a key
 * nobody produces is also a key with no test behind it. Each entry below is the
 * shortest real path to that message.
 * ------------------------------------------------------------------ */

/** awn-4t with one option marked out of stock. */
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
 * 1,000,200–1,003,000 contains no mark at all and nothing typed in inches can land in
 * it. This is the only way `issue.step.noMarkInRange` is reachable.
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

const produced: Record<MessageKey, Message> = {
  // Not a case typo — `resolveSelection` folds those on purpose — a code the group
  // genuinely does not offer, which is the one `validate` reports.
  'issue.selection.unknown': mustFind(
    validate(product('awn-4t'), { ...AWN_OK, glass_color: 'PLAID' }, { width: cm(320), height: cm(160) }),
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
  'option.unavailable': mustState(
    withUnavailable('insect_screen', 'NS1'),
    'insect_screen',
    'NS1',
  ),
  'price.line.base': mustLine(
    calcPrice(product('awn-4t'), AWN_OK, { width: cm(320), height: cm(160) }, 1),
    0,
  ),
  'price.line.option': mustLine(
    calcPrice(product('awn-4t'), AWN_OK, { width: cm(320), height: cm(160) }, 1),
    1,
  ),
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

describe('every key in the scheme is reachable', () => {
  test('each one is produced by a real configuration, not by a fixture', () => {
    for (const key of MESSAGE_KEYS) expect(produced[key].key).toBe(key);
  });
});

/* ------------------------------------------------------------------ *
 * 2. Parity — the sentences did not get worse
 *
 * A renderer built the way the eight locale packages will be built: it reads a key and
 * its params and knows nothing else. That it can reproduce the previous version's Thai
 * exactly is the evidence that restructuring lost no information; if a param were
 * missing, a sentence here could not be completed.
 *
 * `format.ts` is imported *here*, in the rendering layer, and nowhere in core's message
 * path any more. That is the whole point of the change.
 * ------------------------------------------------------------------ */

const th = (message: Message): string => {
  switch (message.key) {
    case 'issue.selection.unknown':
      return `${message.params.group.th}ที่เลือกไว้ไม่มีอยู่ในรายการของสินค้านี้ — กรุณาเลือกใหม่`;
    case 'issue.range.outOfRange': {
      const { minUm, maxUm, unit } = message.params.range;
      return `${message.params.group.th}ต้องอยู่ระหว่าง ${formatRange(minUm, maxUm, unit)}`;
    }
    case 'issue.step.willSnapUp': {
      const { step, snapped, group } = message.params;
      return `${group.th}ปรับได้ทีละ ${formatMeasure(step.um, step.unit)} ระบบจะปัดเป็น ${formatMeasure(snapped.um, snapped.unit)}`;
    }
    case 'issue.step.aboveLargestMark': {
      const { step, largest, group } = message.params;
      return `${group.th}ปรับได้ทีละ ${formatMeasure(step.um, step.unit)} ค่าสูงสุดที่ปรับได้คือ ${formatMeasure(largest.um, largest.unit)}`;
    }
    case 'issue.step.noMarkInRange': {
      const { step, range, group } = message.params;
      return `${group.th}ปรับได้ทีละ ${formatMeasure(step.um, step.unit)} และไม่มีค่าที่ลงตัวในช่วง ${formatRange(range.minUm, range.maxUm, range.unit)}`;
    }
    case 'issue.rule':
      return message.params.message.th;
    case 'option.unavailable':
      return `ตอนนี้${message.params.group.th} "${message.params.option.th}" ยังไม่พร้อมผลิต`;
    case 'price.line.base':
      return `ราคาฐานตามพื้นที่ ${formatSqm(sqUmToSqm(message.params.billableArea.sqUm))} ตร.ม.`;
    case 'price.line.option':
      return `${message.params.group.th} · ${message.params.option.th}`;
  }
};

describe('a locale renderer reproduces what the sentences used to say', () => {
  test.each([
    ['issue.selection.unknown', 'สีกระจกที่เลือกไว้ไม่มีอยู่ในรายการของสินค้านี้ — กรุณาเลือกใหม่'],
    ['issue.range.outOfRange', 'ความกว้างต้องอยู่ระหว่าง 60–400 cm'],
    ['issue.step.willSnapUp', 'ความสูงปรับได้ทีละ 0.5 cm ระบบจะปัดเป็น 160.5 cm'],
    ['issue.step.aboveLargestMark', 'ความสูงปรับได้ทีละ 1/8" ค่าสูงสุดที่ปรับได้คือ 98 3/8"'],
    ['issue.rule', 'กระจกสองชั้นรองรับความกว้างไม่เกิน 200 cm'],
    ['price.line.option', 'สีโปรไฟล์อะลูมิเนียม · ลายไม้เข้ม'],
  ] as [MessageKey, string][])('%s', (key, expected) => {
    expect(th(produced[key])).toBe(expected);
  });

  test('the two sentences that deliberately changed, and what they gained', () => {
    // Was the constant "ตอนนี้สีนี้ยังไม่พร้อมผลิต" — "this *colour* is unavailable" —
    // returned for every sku group including this one, which is a mosquito screen.
    expect(th(produced['option.unavailable'])).toBe('ตอนนี้มุ้งลวด "มีมุ้งลวด" ยังไม่พร้อมผลิต');

    // Was the constant "ราคาฐานตามพื้นที่", which named no area at all — so a base
    // charge computed on the product's floor rather than on the size on screen had
    // nowhere to say so.
    expect(th(produced['price.line.base'])).toBe('ราคาฐานตามพื้นที่ 5.12 ตร.ม.');
  });

  test('the split of one glued sentence into two keys keeps both halves', () => {
    // `${stem} ${advice}` where advice was one of two clauses. Thai tolerates the join;
    // a language that puts the qualifier first does not, so each is its own sentence.
    expect(th(produced['issue.step.noMarkInRange'])).toBe(
      'ความกว้างปรับได้ทีละ 1/8" และไม่มีค่าที่ลงตัวในช่วง ≈39 3/8"–39 1/2"',
    );
  });
});

/* ------------------------------------------------------------------ *
 * 3. Core passes catalogue text through; it does not build text
 *
 * This is the debt plan section 5 named. `validation.ts:204` *constructed* a Thai
 * sentence, so no amount of translation could reach it. The property that replaces it
 * is checkable: every string a message carries is a string the catalogue authored.
 * ------------------------------------------------------------------ */

const authoredStrings = (item: Product): Set<string> => {
  const strings = new Set<string>();
  for (const group of item.groups) {
    strings.add(group.labelTh);
    if (group.kind === 'sku') for (const value of group.values) strings.add(value.labelTh);
  }
  for (const rule of item.rules) strings.add(rule.messageTh);
  return strings;
};

/** Every message a product can produce across a sweep of sizes and selections. */
function sweepMessages(item: Product): Message[] {
  const found: Message[] = [];
  const custom = item.groups.filter((g): g is CustomGroup => g.kind === 'custom');
  const sku = item.groups.filter((g): g is SkuGroup => g.kind === 'sku');

  const defaults: Record<string, string> = {};
  for (const group of sku) defaults[group.code] = group.defaultValue;

  const sizes: Record<string, bigint>[] = [];
  for (const group of custom) {
    // Below the minimum, above the maximum, and off the step: one of each kind of
    // derived issue, on every measurement every product has.
    sizes.push({ [group.code]: group.minUm - group.stepUm });
    sizes.push({ [group.code]: group.maxUm + group.stepUm });
    sizes.push({ [group.code]: group.defaultUm + 1n });
  }
  sizes.push({});

  for (const measures of sizes) {
    for (const issue of validate(item, defaults, measures)) found.push(issue.message);
    for (const group of Object.values(optionStatesFor(item, defaults, measures))) {
      for (const state of Object.values(group)) {
        if (state.reason) found.push(state.reason);
        if (state.warn) found.push(state.warn);
      }
    }
  }

  for (const group of sku) {
    for (const value of group.values) {
      const price = calcPrice(item, { ...defaults, [group.code]: value.code }, {}, 1);
      for (const line of price.lines) found.push(line.label);
    }
  }

  return found;
}

describe('no message carries a string core made up', () => {
  test('every catalogue string in every message is one the catalogue authored', () => {
    const strangers: string[] = [];
    let checked = 0;

    for (const item of products) {
      const authored = authoredStrings(item);

      for (const message of sweepMessages(item)) {
        for (const param of paramsOf(message)) {
          if (param.kind !== 'catalogText') continue;
          checked += 1;
          if (!authored.has(param.th)) strangers.push(`${item.id} ${message.key}: ${param.th}`);
          if (param.ref.productId !== item.id) {
            strangers.push(`${item.id} ${message.key}: ref names ${param.ref.productId}`);
          }
        }
      }
    }

    expect(strangers.slice(0, 5)).toEqual([]);
    // A sweep that stopped producing messages would satisfy the check above vacuously.
    // 81 products, so this is a floor of well over thirty catalogue strings each.
    expect(checked).toBeGreaterThan(2_500);
  });

  test('no param carries a rendered number, only values and the unit they are spoken in', () => {
    const rendered: string[] = [];
    let checked = 0;

    for (const item of products) {
      for (const message of sweepMessages(item)) {
        for (const param of paramsOf(message)) {
          checked += 1;
          switch (param.kind) {
            case 'length':
              if (typeof param.um !== 'bigint') rendered.push(`${message.key}.um`);
              break;
            case 'lengthRange':
              if (typeof param.minUm !== 'bigint' || typeof param.maxUm !== 'bigint') {
                rendered.push(`${message.key}.range`);
              }
              break;
            case 'area':
              if (typeof param.sqUm !== 'bigint') rendered.push(`${message.key}.sqUm`);
              break;
            case 'catalogText':
              // The one string that may appear, and only because it is the source
              // content itself. The markers a formatter adds must never be in it.
              if (/[฿≈]/.test(param.th)) rendered.push(`${message.key}: formatted ${param.th}`);
              break;
          }
        }
      }
    }

    expect(rendered.slice(0, 5)).toEqual([]);
    expect(checked).toBeGreaterThan(4_000);
  });

  test('the sweep really does reach the derived messages, not only the catalogue ones', () => {
    // Without this, both checks above could pass on a sweep that only ever produced
    // `issue.rule` — the one message that was already structured, because a rule's
    // sentence was always the catalogue's rather than something this file built.
    const seen = new Set<MessageKey>();
    for (const item of products) for (const m of sweepMessages(item)) seen.add(m.key);

    expect([...seen].sort()).toEqual(
      [
        'issue.range.outOfRange',
        'issue.rule',
        'issue.step.willSnapUp',
        'price.line.base',
        'price.line.option',
      ].sort(),
    );
  });
});

/* ------------------------------------------------------------------ *
 * 4. Numbers do not move
 *
 * Plan 4.1 and 4.5: switching what a value is *shown* in must never write it back.
 * A locale is the same kind of hazard as a display unit, and it gets the same kind of
 * test — with the stronger property available here, that core takes no locale at all.
 * ------------------------------------------------------------------ */

describe('a message carries the domain value, not a copy of it', () => {
  test('a range param holds the catalogue bigints themselves', () => {
    const item = product('awn-4t');
    const width = item.groups.find(
      (group): group is CustomGroup => group.kind === 'custom' && group.code === 'width',
    );
    if (!width) throw new Error('fixture missing');

    const message = produced['issue.range.outOfRange'];
    if (message.key !== 'issue.range.outOfRange') throw new Error('wrong key');

    expect(message.params.range.minUm).toBe(width.minUm);
    expect(message.params.range.maxUm).toBe(width.maxUm);
  });

  test('an area param holds the exact square micrometres the price was computed from', () => {
    const item = product('awn-4t');
    const measures = { width: cm(320.5), height: cm(160) };
    const line = calcPrice(item, AWN_OK, measures, 1).lines[0];
    if (line?.label.key !== 'price.line.base') throw new Error('wrong first row');

    // 3,205,000 × 1,600,000 µm² — the same integer `pricing-parity` pins for the area,
    // reaching the message with no division on the way. `sqUmToSqm` is the renderer's
    // step and it happens after this point, in the locale layer.
    expect(line.label.params.billableArea.sqUm).toBe(measures.width * measures.height);
  });

  test('rendering the same message twice cannot move it, because the message is the input', () => {
    // The property a locale switch needs: the value a formatter is handed is the value
    // core produced, every time. Two renderers over one message read one `bigint`.
    const message = produced['issue.step.aboveLargestMark'];
    if (message.key !== 'issue.step.aboveLargestMark') throw new Error('wrong key');

    const metric = formatMeasure(message.params.largest.um, 'cm');
    const imperial = formatMeasure(message.params.largest.um, message.params.largest.unit);

    expect(message.params.largest.um).toBe(2_498_725n);
    expect(metric).toBe('249.8725 cm');
    expect(imperial).toBe('98 3/8"');
  });
});

/* ------------------------------------------------------------------ *
 * Untrusted input — a message now has numbers in it to get wrong
 * ------------------------------------------------------------------ */

describe('reviveMessage and isMessage', () => {
  const stored = (message: Message): unknown =>
    JSON.parse(
      JSON.stringify(message, (_key, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    );

  test('restores the micrometres JSON left behind as digits', () => {
    const message = produced['issue.step.aboveLargestMark'];
    const raw = stored(message);

    // The shape storage actually holds, and the reason this reviver exists: before
    // this change a stored label was a sentence and had nothing in it to misread.
    expect(raw).toMatchObject({ params: { largest: { um: '2498725' } } });
    expect(isMessage(raw)).toBe(false);
    expect(reviveMessage(raw)).toEqual(message);
  });

  test('a length that came back as a JSON number is rejected, not rounded into place', () => {
    // 2498725 as a `number` is exactly representable, so nothing would look wrong — and
    // a later `um * 2n` would throw, or worse, a template would print it unformatted.
    const raw = stored(produced['issue.step.aboveLargestMark']);
    const broken = { ...(raw as Record<string, unknown>) };
    broken.params = { ...(raw as { params: Record<string, unknown> }).params, largest: { kind: 'length', um: 2_498_725, unit: 'in' } };

    expect(reviveMessage(broken)).toBeNull();
  });

  test('an empty Thai fallback is refused, because it renders blank in seven languages', () => {
    const raw = stored(produced['issue.rule']) as { params: { message: { th: string } } };
    raw.params.message.th = '';

    expect(reviveMessage(raw)).toBeNull();
  });

  test('a key this version of core does not know is refused whole', () => {
    expect(reviveMessage({ key: 'issue.range.outOfRange.v2', params: {} })).toBeNull();
    expect(reviveMessage({ key: 'issue.rule', params: {} })).toBeNull();
  });

  test('a param the key does not take is refused, rather than half-believed', () => {
    const raw = stored(produced['issue.rule']) as { params: Record<string, unknown> };
    raw.params.extra = { kind: 'area', sqUm: '1' };

    expect(reviveMessage(raw)).toBeNull();
  });

  test('a ref missing the product it belongs to is refused', () => {
    // Group codes repeat across products — every product has a `width`. A ref without
    // `productId` would look up some other product's translation and find one.
    expect(
      reviveMessage({
        key: 'issue.selection.unknown',
        params: {
          group: { kind: 'catalogText', ref: { on: 'groupLabel', groupCode: 'width' }, th: 'ก' },
        },
      }),
    ).toBeNull();
  });
});
