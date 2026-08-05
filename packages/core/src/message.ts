import type { CustomGroup, OptionValue, Product, Rule, SkuGroup } from './types/catalog.js';
import { isLengthUnit, type LengthUnit } from './units.js';

/**
 * Structured messages — the mechanism that lets eight locales exist.
 *
 * Plan section 5 ("`Issue` ต้องเลิกเป็นข้อความ") names the debt this pays. Until now
 * `validation.ts` *built* Thai sentences:
 *
 *     `${group.labelTh}ต้องอยู่ระหว่าง ${formatRange(min, max, unit)}`
 *
 * Three separate things were welded together in that template literal: a catalogue
 * string somebody authored, two lengths, and Thai word order. A German or Burmese
 * catalogue needs all three to come apart, and a Hindi one needs its own digits — so
 * a translator may never be handed `≈157 1/2"` or `฿8,791` as a substring.
 *
 * The rule this module enforces is therefore:
 *
 *   **A param is a value. The layer that knows the locale renders it.**
 *
 * Nothing here imports `format.ts`, and after this change neither does `validation.ts`,
 * `pricing.ts` or `optionStates.ts`. Lengths stay `bigint` micrometres and areas stay
 * `bigint` square micrometres all the way out of core; a locale cannot move either by
 * one micrometre because a locale is not an input to any of them.
 *
 * ## Why catalogue text is a param and not a key
 *
 * `group.labelTh`, `value.labelTh` and `rule.messageTh` are *content*: 81 products
 * across 8 languages, named in plan section 13 as a human bottleneck rather than a code
 * task. They can never become code keys. So a `catalogText` param carries two things —
 * a `ref` that says which catalogue string this is, so a translated catalogue can be
 * looked up by it, and `th`, the Thai source. `th` is not a rendering: it is the source
 * content, and it is what makes an incomplete catalogue degrade *visibly to Thai*
 * rather than to an empty string or a raw key.
 *
 * `th` is required and must be non-empty for exactly that reason. A `catalogText` with
 * no Thai is a message that renders blank in seven locales and nobody finds out.
 */

/* ------------------------------------------------------------------ *
 * Params — values, never rendered text
 * ------------------------------------------------------------------ */

/**
 * Which catalogue string a `catalogText` param stands for.
 *
 * `productId` is part of every ref because labels are per product version, not global:
 * two products both have a `width` group and they may well word it differently. A ref
 * without it would look up the wrong translation and read as a plausible one.
 */
export type CatalogTextRef =
  | { readonly on: 'groupLabel'; readonly productId: string; readonly groupCode: string }
  | {
      readonly on: 'optionLabel';
      readonly productId: string;
      readonly groupCode: string;
      readonly valueCode: string;
    }
  | { readonly on: 'ruleMessage'; readonly productId: string; readonly ruleId: string };

/**
 * A length, in canonical micrometres, plus the grid it is being spoken on.
 *
 * `unit` is meaning, not formatting: a step warning phrased on the eighth-inch grid is
 * a different statement from the same value phrased on the 5 mm grid, and which one the
 * customer gets depends on what they typed in. See `validate`'s `enteredUnits`.
 */
export interface LengthParam {
  readonly kind: 'length';
  readonly um: bigint;
  readonly unit: LengthUnit;
}

/**
 * A closed range of lengths. **One param, not two.**
 *
 * `formatRange` decides the `≈` marker for the pair — if either bound is inexact in the
 * unit asked for, the range as a whole is approximate. Handing a locale two independent
 * lengths would let it render `≈60–≈400`, or worse `60–≈400`, and lose the rule.
 */
export interface LengthRangeParam {
  readonly kind: 'lengthRange';
  readonly minUm: bigint;
  readonly maxUm: bigint;
  readonly unit: LengthUnit;
}

/**
 * An area, as an exact count of square micrometres.
 *
 * No unit field, unlike a length: every area in this system is spoken in m² and the
 * catalogue is not authored in square feet. When that stops being true this grows a
 * `unit` the same way `LengthParam` has one — the shape is what makes that possible
 * without touching a single call site's arithmetic.
 */
export interface AreaParam {
  readonly kind: 'area';
  readonly sqUm: bigint;
}

/** A string the catalogue owns, addressable so a translated catalogue can replace it. */
export interface CatalogTextParam {
  readonly kind: 'catalogText';
  readonly ref: CatalogTextRef;
  /** The Thai source. Required and non-empty: it is the visible fallback. */
  readonly th: string;
}

export type MessageParam = LengthParam | LengthRangeParam | AreaParam | CatalogTextParam;

/* ------------------------------------------------------------------ *
 * The key scheme
 * ------------------------------------------------------------------ */

/**
 * Every message core can produce, and exactly which params it carries.
 *
 * This map *is* the deliverable. It is the contract a locale catalogue is written
 * against, and because `Message` is derived from it as a discriminated union, a
 * renderer that switches on `key` gets the precise param names for that key — a
 * missing interpolation is a compile error rather than an `undefined` on screen.
 *
 * Naming: `<surface>.<subject>.<case>`. The surface prefix matters because the same
 * catalogue serves an issue panel, an option tooltip and a price breakdown, and a flat
 * namespace makes `unavailable` collide with itself the first time a second surface
 * needs the word.
 *
 * Note what is *not* here: nothing takes a pre-composed clause. The old
 * `step:` message glued one of two advice clauses onto a stem — Thai tolerates that,
 * German and Burmese do not, so each outcome is its own key and each key is one whole
 * sentence in the target language.
 */
export interface MessageParamsByKey {
  /** A stored selection names an option this product does not offer. */
  'issue.selection.unknown': { readonly group: CatalogTextParam };

  /** A measurement outside the catalogue's bounds for that field. */
  'issue.range.outOfRange': {
    readonly group: CatalogTextParam;
    readonly range: LengthRangeParam;
  };

  /** Off the entry grid, in range, and the app will round up for them. Warning. */
  'issue.step.willSnapUp': {
    readonly group: CatalogTextParam;
    readonly step: LengthParam;
    readonly snapped: LengthParam;
  };

  /**
   * Off grid, in range, and the next mark up is past the maximum — but a lower mark
   * fits. `largest` is that mark, not the maximum: the maximum only *renders* as the
   * mark above it on an imperial grid, so advising it advises a value that cannot be
   * typed back.
   */
  'issue.step.aboveLargestMark': {
    readonly group: CatalogTextParam;
    readonly step: LengthParam;
    readonly largest: LengthParam;
  };

  /** Off grid, and no mark on this grid lands inside the range at all. */
  'issue.step.noMarkInRange': {
    readonly group: CatalogTextParam;
    readonly step: LengthParam;
    readonly range: LengthRangeParam;
  };

  /**
   * A catalogue-authored rule fired.
   *
   * The whole sentence is the param. A rule's prose is product content written by a
   * person — it cannot become a code key, so this key exists to carry it through the
   * same pipe as everything else and give the renderer one code path.
   */
  'issue.rule': { readonly message: CatalogTextParam };

  /** This option is not currently stocked. Names its own group, not "colour". */
  'option.unavailable': {
    readonly group: CatalogTextParam;
    readonly option: CatalogTextParam;
  };

  /** The area charge every quote line starts from, and the area it was charged on. */
  'price.line.base': { readonly billableArea: AreaParam };

  /** One option's surcharge — two catalogue labels in one row. */
  'price.line.option': {
    readonly group: CatalogTextParam;
    readonly option: CatalogTextParam;
  };
}

export type MessageKey = keyof MessageParamsByKey;

/**
 * A message: a key into the locale catalogue and the values it interpolates.
 *
 * Written as a distributed union rather than `{ key: MessageKey; params: ... }` so that
 * narrowing on `key` narrows `params` with it.
 */
export type Message = {
  [K in MessageKey]: { readonly key: K; readonly params: MessageParamsByKey[K] };
}[MessageKey];

/* ------------------------------------------------------------------ *
 * Param constructors
 *
 * Call sites go through these rather than writing object literals, so that "which
 * catalogue string is this, exactly" is answered once per kind of string instead of
 * once per message.
 * ------------------------------------------------------------------ */

export const groupLabel = (
  product: Product,
  group: SkuGroup | CustomGroup,
): CatalogTextParam => ({
  kind: 'catalogText',
  ref: { on: 'groupLabel', productId: product.id, groupCode: group.code },
  th: group.labelTh,
});

export const optionLabel = (
  product: Product,
  group: SkuGroup,
  value: OptionValue,
): CatalogTextParam => ({
  kind: 'catalogText',
  ref: {
    on: 'optionLabel',
    productId: product.id,
    groupCode: group.code,
    valueCode: value.code,
  },
  th: value.labelTh,
});

export const ruleMessage = (product: Product, rule: Rule): CatalogTextParam => ({
  kind: 'catalogText',
  ref: { on: 'ruleMessage', productId: product.id, ruleId: rule.id },
  th: rule.messageTh,
});

export const lengthParam = (um: bigint, unit: LengthUnit): LengthParam => ({
  kind: 'length',
  um,
  unit,
});

export const lengthRangeParam = (
  minUm: bigint,
  maxUm: bigint,
  unit: LengthUnit,
): LengthRangeParam => ({ kind: 'lengthRange', minUm, maxUm, unit });

export const areaParam = (sqUm: bigint): AreaParam => ({ kind: 'area', sqUm });

/* ------------------------------------------------------------------ *
 * Validation and revival
 *
 * A `Message` crosses two boundaries that turn a `bigint` into a string of digits:
 * `JSON.stringify` on the way into localStorage, and the HTTP wire. Before this change
 * a stored breakdown row held `label: "ราคาฐานตามพื้นที่"` and there was nothing in it
 * to get wrong; it now holds a square-micrometre count, and a warning carried on a
 * quote line now holds micrometres. Both read back as plausible strings.
 * ------------------------------------------------------------------ */

/** Which param kind each key expects under each name. Doubles as the key registry. */
const PARAM_SHAPES: {
  readonly [K in MessageKey]: {
    readonly [P in keyof MessageParamsByKey[K]]: MessageParam['kind'];
  };
} = {
  'issue.selection.unknown': { group: 'catalogText' },
  'issue.range.outOfRange': { group: 'catalogText', range: 'lengthRange' },
  'issue.step.willSnapUp': { group: 'catalogText', step: 'length', snapped: 'length' },
  'issue.step.aboveLargestMark': { group: 'catalogText', step: 'length', largest: 'length' },
  'issue.step.noMarkInRange': { group: 'catalogText', step: 'length', range: 'lengthRange' },
  'issue.rule': { message: 'catalogText' },
  'option.unavailable': { group: 'catalogText', option: 'catalogText' },
  'price.line.base': { billableArea: 'area' },
  'price.line.option': { group: 'catalogText', option: 'catalogText' },
};

/** Whether an untrusted string names a message this version of core can produce. */
export const isMessageKey = (value: unknown): value is MessageKey =>
  typeof value === 'string' && Object.hasOwn(PARAM_SHAPES, value);

/**
 * Every key a locale catalogue has to cover.
 *
 * Derived from `PARAM_SHAPES` rather than written out a second time: a hand-kept list
 * is a list that drifts, and the failure of a drifted one is a key with no translation
 * in any language, discovered by a customer.
 */
export const MESSAGE_KEYS: readonly MessageKey[] = Object.keys(PARAM_SHAPES).filter(isMessageKey);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A canonical integer, from a `bigint` or from the digits `JSON.stringify` left behind.
 *
 * `coerce` is what separates "read this back out of storage" from "check this is
 * already sound". Without the second mode a value that survived as `"3200000"` would
 * pass validation and then be interpolated as a string.
 */
function readInteger(value: unknown, coerce: boolean): bigint | null {
  if (typeof value === 'bigint') return value;
  if (!coerce) return null;
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) return null;
  return BigInt(value);
}

function readRef(value: unknown): CatalogTextRef | null {
  if (!isRecord(value)) return null;
  const { on, productId } = value;
  if (typeof productId !== 'string' || productId === '') return null;

  if (on === 'groupLabel') {
    const { groupCode } = value;
    return typeof groupCode === 'string' && groupCode !== ''
      ? { on, productId, groupCode }
      : null;
  }

  if (on === 'optionLabel') {
    const { groupCode, valueCode } = value;
    return typeof groupCode === 'string' &&
      groupCode !== '' &&
      typeof valueCode === 'string' &&
      valueCode !== ''
      ? { on, productId, groupCode, valueCode }
      : null;
  }

  if (on === 'ruleMessage') {
    const { ruleId } = value;
    return typeof ruleId === 'string' && ruleId !== '' ? { on, productId, ruleId } : null;
  }

  return null;
}

function readParam(
  expected: MessageParam['kind'],
  value: unknown,
  coerce: boolean,
): MessageParam | null {
  if (!isRecord(value) || value.kind !== expected) return null;

  switch (expected) {
    case 'length': {
      const um = readInteger(value.um, coerce);
      return um !== null && isLengthUnit(value.unit)
        ? { kind: 'length', um, unit: value.unit }
        : null;
    }
    case 'lengthRange': {
      const minUm = readInteger(value.minUm, coerce);
      const maxUm = readInteger(value.maxUm, coerce);
      return minUm !== null && maxUm !== null && isLengthUnit(value.unit)
        ? { kind: 'lengthRange', minUm, maxUm, unit: value.unit }
        : null;
    }
    case 'area': {
      const sqUm = readInteger(value.sqUm, coerce);
      return sqUm !== null ? { kind: 'area', sqUm } : null;
    }
    case 'catalogText': {
      const ref = readRef(value.ref);
      // An empty `th` is rejected rather than passed on. It is the fallback every
      // incomplete locale lands on, so an empty one is a message that renders blank
      // in seven languages while looking well formed in the payload.
      return ref !== null && typeof value.th === 'string' && value.th !== ''
        ? { kind: 'catalogText', ref, th: value.th }
        : null;
    }
  }
}

/**
 * Every param this key takes, parsed, or `null` if any is missing or the wrong kind.
 *
 * Extra params are rejected as well as missing ones: a payload carrying a param this
 * key does not take was written by a different version of core, and guessing which half
 * of it to believe is how a message renders with someone else's numbers in it.
 */
function readParams(
  key: MessageKey,
  params: Record<string, unknown>,
  coerce: boolean,
): Record<string, MessageParam> | null {
  const shape: Readonly<Record<string, MessageParam['kind']>> = PARAM_SHAPES[key];
  const names = Object.keys(shape);
  if (Object.keys(params).length !== names.length) return null;

  const parsed: Record<string, MessageParam> = {};
  for (const name of names) {
    const expected = shape[name];
    if (expected === undefined) return null;

    const param = readParam(expected, params[name], coerce);
    if (param === null) return null;
    parsed[name] = param;
  }

  return parsed;
}

/**
 * True when `value` is already a sound `Message` — micrometres as `bigint`, every param
 * present, no param the key does not take, and no empty Thai fallback.
 */
export function isMessage(value: unknown): value is Message {
  if (!isRecord(value)) return false;
  const { key, params } = value;

  return isMessageKey(key) && isRecord(params) && readParams(key, params, false) !== null;
}

/**
 * Read a `Message` back out of JSON, restoring the integers that digits were left for.
 *
 * Rebuilds rather than patching in place, so any extra field a stored payload carried is
 * dropped and a message that came back from storage has the same shape as one core just
 * built — which is what makes `toEqual` on a round-trip mean what it looks like it means.
 */
export function reviveMessage(value: unknown): Message | null {
  if (!isRecord(value)) return null;
  const { key, params } = value;
  if (!isMessageKey(key) || !isRecord(params)) return null;

  const parsed = readParams(key, params, true);
  if (parsed === null) return null;

  // Handed back through the guard rather than asserted: `readParams` has checked every
  // name and kind against the same table `MessageParamsByKey` is declared from, and
  // `isMessage` is where that check is spelled as a type.
  const rebuilt: unknown = { key, params: parsed };
  return isMessage(rebuilt) ? rebuilt : null;
}
