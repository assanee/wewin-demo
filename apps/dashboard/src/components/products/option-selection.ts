import type { AdminOptionGroupWire, DraftOptionWire } from '@wewin/contract';
import { encodeLengthUm } from '@wewin/contract/admin';

/**
 * ⭐ Choosing a product's option groups from the shared vocabulary — the piece that makes a
 * product creatable without copying one.
 *
 * ── Why the groups are picked and never typed ────────────────────────────────────
 *
 * `options` on a create request is keyed by option-group code, and those codes must already
 * exist in the shared `option_groups` table. A code that does not is answered **404 in the
 * middle of a POST** — which reads as "the endpoint is wrong", not as "that group does not
 * exist". Value codes are the same: unknown ones come back 422 with the list buried in
 * `details.missing`. So this module only ever emits codes it was handed by
 * `listOptionGroups`, and the UI above it is a picker with no free-text field.
 *
 * ── Why every rule is re-checked here ────────────────────────────────────────────
 *
 * ⛔ The measurement grid is enforced by a single Postgres CHECK
 * (`product_version_options_grid`), and it fires **before** the eight specific messages in
 * `packages/core/src/data/schema.ts` are ever reached. So every one of the eight distinct
 * mistakes — step off the 25 µm lattice, min off its own grid, max not a whole number of
 * steps above min, default off the grid, and so on — comes back as the *same* sentence:
 * "ช่วงขนาดไม่ลงตัวกับสเต็ป…". The server cannot tell the person which box is wrong,
 * because by then it no longer knows.
 *
 * Re-implementing the rules here is therefore not belt-and-braces; it is the only way the
 * form can say *which field* to fix. The server stays the authority — if these two ever
 * disagree the request is refused and nothing is written — but the sentence lives here.
 *
 * `defaultValueCode ∈ valueCodes` has the same shape of problem: it is checked in exactly
 * one place (core's `productSchema`), arrives as a generic 422, and the useful text is
 * buried in `details.issues[]`.
 */

/** Micrometres per centimetre and per millimetre — a group authors its bounds in one or the other. */
const UM_PER_CM = 10_000n;
const UM_PER_MM = 1_000n;

/**
 * The lattice every step must sit on, from `packages/core/src/units.ts`.
 *
 * ⚠️ Restated rather than imported: `@wewin/core` is not a dependency of the dashboard's
 * component layer, and the value is a hard constant of the wire format rather than a tuning
 * knob. The test below pins it, so a change upstream that this file missed fails loudly.
 */
const LATTICE_UM = 25n;

/** ⛔ Required by `productSchema`: pricing reads these two groups by name. */
export const REQUIRED_CUSTOM_CODES = ['width', 'height'] as const;

/** What the editor holds for one catalogue group while somebody is filling it in. */
export interface GroupChoice {
  readonly code: string;
  readonly offered: boolean;
  /** sku groups: which of the catalogue's values this product offers. */
  readonly valueCodes: readonly string[];
  /** sku groups: which one the configurator opens on. */
  readonly defaultValueCode: string;
  /** custom groups: the range, as typed, in the group's own authored unit. */
  readonly minText: string;
  readonly maxText: string;
  readonly stepText: string;
  readonly defaultText: string;
}

/**
 * The order groups are shown in, and — because `sortOrder` is taken from it — the order the
 * configurator will show them in too.
 *
 * ⛔ One function for both, and that is the point. The editor sorted กว้าง before สูง while
 * `buildOptions` numbered them in catalogue order, so the person filled in width-then-height
 * and the product stored height-then-width. Nothing failed; the saved product simply
 * disagreed with the screen that made it. Caught by reading the draft back after creating
 * one, not by any test — both orders were internally consistent.
 */
export function displayRank(group: { readonly code: string; readonly kind: 'sku' | 'custom' }): number {
  const required = (REQUIRED_CUSTOM_CODES as readonly string[]).indexOf(group.code);
  if (required >= 0) return required;
  return group.kind === 'custom' ? 10 : 20;
}

export type OptionsResult =
  | { readonly ok: true; readonly options: Readonly<Record<string, DraftOptionWire>> }
  | {
      readonly ok: false;
      /** The summary, for the alert. Every entry is also in `errors` unless it names no field. */
      readonly problems: readonly string[];
      /** ⭐ The same refusals, addressed to the control that can fix each one. */
      readonly errors: OptionErrors;
    };

/** A fresh, empty choice for one catalogue group. */
export const blankChoice = (group: AdminOptionGroupWire): GroupChoice => ({
  code: group.code,
  offered: false,
  valueCodes: [],
  defaultValueCode: '',
  minText: '',
  maxText: '',
  stepText: '',
  defaultText: '',
});

/**
 * A number as typed, in the group's authored unit → micrometres.
 *
 * `bigint` throughout, so a step of 0.5 cm is exactly 5 000 µm and never 4 999.999…. Four
 * decimals is µm precision at cm scale; three at mm scale. Anything longer is refused rather
 * than rounded, because silently dropping a digit changes the size somebody typed.
 */
export function toUm(text: string, unit: 'cm' | 'mm'): bigint | null {
  const trimmed = text.trim();
  if (!/^\d+(\.\d{1,4})?$/u.test(trimmed)) return null;

  const [whole = '0', fraction = ''] = trimmed.split('.');
  const perUnit = unit === 'cm' ? UM_PER_CM : UM_PER_MM;
  const places = unit === 'cm' ? 4 : 3;
  if (fraction.length > places) return null;

  return BigInt(whole) * perUnit + BigInt(fraction.padEnd(places, '0'));
}

/** Micrometres → the authored unit, for showing a value back. */
export function fromUm(um: bigint, unit: 'cm' | 'mm'): string {
  const perUnit = unit === 'cm' ? UM_PER_CM : UM_PER_MM;
  const whole = um / perUnit;
  const fraction = um % perUnit;
  if (fraction === 0n) return whole.toString();

  const places = unit === 'cm' ? 4 : 3;
  return `${whole.toString()}.${fraction.toString().padStart(places, '0').replace(/0+$/u, '')}`;
}

/**
 * ⭐ Which box a refusal belongs to — the whole point of not returning bare strings.
 *
 * The names match `GroupChoice`'s own fields so a caller can hand the message straight to
 * the control that holds that value. A person filling in eight boxes across two groups had
 * to read a paragraph at the bottom of the page and work out which of the eight it meant;
 * now the box goes red and the sentence sits under it.
 */
export type MeasurementField = 'minText' | 'maxText' | 'stepText' | 'defaultText';

export interface MeasurementProblem {
  readonly field: MeasurementField;
  readonly messageTh: string;
}

/** Every message for one group, keyed by the field it belongs to. First one per field wins. */
export type GroupErrors = Partial<Record<MeasurementField | 'valueCodes' | 'defaultValueCode', string>>;

/** Keyed by option-group code. */
export type OptionErrors = Readonly<Record<string, GroupErrors>>;

/**
 * Every reason one measurement group's numbers would be refused, in the person's words.
 *
 * Exported for its test. The order matters: a bad step makes every other check meaningless,
 * so it is reported alone rather than alongside four consequences of itself.
 */
export function measurementProblems(
  unit: 'cm' | 'mm',
  min: bigint | null,
  max: bigint | null,
  step: bigint | null,
  fallback: bigint | null,
): readonly MeasurementProblem[] {
  const problems: MeasurementProblem[] = [];
  const say = (field: MeasurementField, messageTh: string): void => {
    problems.push({ field, messageTh });
  };

  if (min === null) say('minText', 'ค่าต่ำสุดต้องเป็นตัวเลข');
  if (max === null) say('maxText', 'ค่าสูงสุดต้องเป็นตัวเลข');
  if (step === null) say('stepText', 'สเต็ปต้องเป็นตัวเลข');
  if (fallback === null) say('defaultText', 'ค่าเริ่มต้นต้องเป็นตัวเลข');
  if (min === null || max === null || step === null || fallback === null) return problems;

  if (step <= 0n) {
    say('stepText', 'สเต็ปต้องมากกว่า 0');
    /* Everything below divides by the step. */
    return problems;
  }
  if (step % LATTICE_UM !== 0n) {
    say('stepText', `สเต็ปต้องเป็นจำนวนเท่าของ ${fromUm(LATTICE_UM, unit)} ${unit}`);
    return problems;
  }

  if (min <= 0n) say('minText', 'ค่าต่ำสุดต้องมากกว่า 0');
  /*
   * ⚠️ `>` and not `>=`. min === max is legal at every layer — the DB says `min_um <= max_um`
   * and core says `if (group.minUm > group.maxUm) fail(...)`. A product offered in exactly
   * one size is a real thing, and refusing it here would refuse something the server accepts.
   */
  if (min > max) say('minText', 'ค่าต่ำสุดต้องไม่เกินค่าสูงสุด');

  /*
   * ⛔ Two different anchors, and this is the trap the DB CHECK hides. `min` sits on a grid
   * anchored at **zero**; `max` and the default sit on a grid anchored at **min**. Checking
   * only one of them accepts numbers the server refuses.
   */
  if (min > 0n && min % step !== 0n) {
    say('minText', `ค่าต่ำสุดต้องลงตัวกับสเต็ป (${fromUm(step, unit)} ${unit})`);
  }
  if (min <= max && (max - min) % step !== 0n) {
    say('maxText', 'ค่าสูงสุดต้องห่างจากค่าต่ำสุดเป็นจำนวนเท่าของสเต็ป');
  }

  if (fallback < min || fallback > max) {
    say('defaultText', 'ค่าเริ่มต้นต้องอยู่ระหว่างค่าต่ำสุดกับค่าสูงสุด');
  } else if ((fallback - min) % step !== 0n) {
    say('defaultText', 'ค่าเริ่มต้นต้องห่างจากค่าต่ำสุดเป็นจำนวนเท่าของสเต็ป');
  }

  return problems;
}

/**
 * The chosen groups as the wire wants them, or every reason they cannot be sent.
 *
 * All the problems rather than the first: a screen that reveals one at a time is a screen
 * somebody submits four times.
 */
export function buildOptions(
  choices: readonly GroupChoice[],
  groups: readonly AdminOptionGroupWire[],
): OptionsResult {
  const byCode = new Map(groups.map((group) => [group.code, group]));
  const errors: Record<string, GroupErrors> = {};
  const mark = (code: string, field: keyof GroupErrors, messageTh: string): void => {
    /* First message per box. A field with three faults gets the first, not a paragraph. */
    const forGroup = errors[code] ?? {};
    if (forGroup[field] === undefined) errors[code] = { ...forGroup, [field]: messageTh };
  };
  /*
   * Sorted by the same rule the editor renders with, so `sortOrder` — which the configurator
   * lays the groups out by — matches the order the person just filled in.
   */
  const offered = choices
    .filter((choice) => choice.offered)
    .sort((left, right) => {
      const of = (choice: GroupChoice): number => {
        const group = byCode.get(choice.code);
        return group === undefined ? 99 : displayRank(group);
      };
      return of(left) - of(right);
    });
  const problems: string[] = [];
  const options: Record<string, DraftOptionWire> = {};

  for (const required of REQUIRED_CUSTOM_CODES) {
    const chosen = offered.find((choice) => choice.code === required);
    if (chosen === undefined) {
      problems.push(
        `ต้องเลือกกลุ่มขนาด "${required}" — ระบบคิดราคาจากกว้างและสูงโดยตรง ถ้าขาดไปจะบันทึกไม่ได้`,
      );
    }
  }

  offered.forEach((choice, index) => {
    const group = byCode.get(choice.code);
    if (group === undefined) {
      /* Not reachable through the picker; a guard against a stale list rather than a case. */
      problems.push(`ไม่พบกลุ่มตัวเลือกรหัส "${choice.code}" ในคลัง`);
      return;
    }

    if (group.kind === 'custom') {
      const unit = group.authoredUnit ?? 'cm';
      const min = toUm(choice.minText, unit);
      const max = toUm(choice.maxText, unit);
      const step = toUm(choice.stepText, unit);
      const fallback = toUm(choice.defaultText, unit);

      const found = measurementProblems(unit, min, max, step, fallback);
      if (found.length > 0) {
        for (const problem of found) {
          mark(choice.code, problem.field, problem.messageTh);
          /* The group is named in the summary because the boxes are not, up there. */
          problems.push(`${group.labelTh}: ${problem.messageTh}`);
        }
        return;
      }
      if (min === null || max === null || step === null || fallback === null) return;

      options[choice.code] = {
        kind: 'custom',
        sortOrder: index,
        minUm: encodeLengthUm(min),
        maxUm: encodeLengthUm(max),
        stepUm: encodeLengthUm(step),
        defaultUm: encodeLengthUm(fallback),
      };
      return;
    }

    const catalogueCodes = new Set(group.values.map((value) => value.code));
    const chosenValues = choice.valueCodes.filter((code) => catalogueCodes.has(code));

    if (chosenValues.length === 0) {
      mark(choice.code, 'valueCodes', 'เลือกอย่างน้อยหนึ่งตัวเลือก');
      problems.push(`${group.labelTh}: เลือกอย่างน้อยหนึ่งตัวเลือก`);
      return;
    }
    if (!chosenValues.includes(choice.defaultValueCode)) {
      mark(choice.code, 'defaultValueCode', 'ค่าเริ่มต้นต้องเป็นหนึ่งในตัวเลือกที่เสนอ');
      problems.push(`${group.labelTh}: ค่าเริ่มต้นต้องเป็นหนึ่งในตัวเลือกที่เสนอ`);
      return;
    }

    /*
     * ⛔ A swatch group needs a colour on every value it offers, and `swatchHex` lives on the
     * shared `option_values` row — so this is a problem the product form cannot fix. Saying
     * where to fix it is the whole value of catching it here; the server's version of this
     * message names the value and not the screen.
     */
    if (group.input === 'swatch') {
      const missing = group.values
        .filter((value) => chosenValues.includes(value.code) && !value.swatchHex)
        .map((value) => value.code);
      if (missing.length > 0) {
        const messageTh = `ตัวเลือก ${missing.join(', ')} ยังไม่มีรหัสสี — แก้ได้ที่หน้าชุดตัวเลือก`;
        mark(choice.code, 'valueCodes', messageTh);
        problems.push(`${group.labelTh}: ${messageTh}`);
        return;
      }
    }

    options[choice.code] = {
      kind: 'sku',
      sortOrder: index,
      /* Catalogue order, not click order: the configurator shows them in this sequence. */
      valueCodes: group.values
        .filter((value) => chosenValues.includes(value.code))
        .map((value) => value.code),
      defaultValueCode: choice.defaultValueCode,
    };
  });

  if (problems.length > 0) return { ok: false, problems, errors };
  return { ok: true, options };
}
