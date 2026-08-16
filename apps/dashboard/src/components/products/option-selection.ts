import type { AdminOptionGroupWire, DraftOptionWire, OptionGroupWire } from '@wewin/contract';
import { decodeUm } from '@wewin/contract/measure';
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

/* ------------------------------------------------------------------ *
 * Editing the options of a draft that already has some
 * ------------------------------------------------------------------ */

/**
 * ⭐ A draft's current option groups, as the editor holds them.
 *
 * The create screen starts from `blankChoice`; the draft editor starts from what the product
 * already offers, so the same component can edit both. Every value is turned back into the
 * text a person typed — micrometres to the group's authored unit — because that is what the
 * boxes contain and because a round trip through them must not change the numbers.
 *
 * ⚠️ Driven by the **catalogue**, not by the product: a group the product offers that no
 * longer exists in `option_groups` would otherwise vanish silently from the editor and be
 * deleted by the very next save. Such a group is impossible today (the vocabulary is
 * append-only in practice) and the cost of being wrong is losing a product's options, so it
 * is carried through as offered rather than dropped.
 */
export function choicesFromProduct(
  offered: readonly OptionGroupWire[],
  catalogue: readonly AdminOptionGroupWire[],
): readonly GroupChoice[] {
  const byCode = new Map(offered.map((group) => [group.code, group]));

  const fromCatalogue = catalogue.map((group): GroupChoice => {
    const current = byCode.get(group.code);
    if (current === undefined) return blankChoice(group);

    if (current.kind === 'custom') {
      const unit = current.unit;
      return {
        ...blankChoice(group),
        offered: true,
        minText: fromUm(decodeUm(current.minUm), unit),
        maxText: fromUm(decodeUm(current.maxUm), unit),
        stepText: fromUm(decodeUm(current.stepUm), unit),
        defaultText: fromUm(decodeUm(current.defaultUm), unit),
      };
    }

    return {
      ...blankChoice(group),
      offered: true,
      valueCodes: current.values.map((value) => value.code),
      defaultValueCode: current.defaultValue,
    };
  });

  /* A group the product offers that the catalogue no longer lists — see the note above. */
  const orphans = offered
    .filter((group) => !catalogue.some((entry) => entry.code === group.code))
    .map((group): GroupChoice => ({
      code: group.code,
      offered: true,
      valueCodes: group.kind === 'sku' ? group.values.map((value) => value.code) : [],
      defaultValueCode: group.kind === 'sku' ? group.defaultValue : '',
      minText: group.kind === 'custom' ? fromUm(decodeUm(group.minUm), group.unit) : '',
      maxText: group.kind === 'custom' ? fromUm(decodeUm(group.maxUm), group.unit) : '',
      stepText: group.kind === 'custom' ? fromUm(decodeUm(group.stepUm), group.unit) : '',
      defaultText: group.kind === 'custom' ? fromUm(decodeUm(group.defaultUm), group.unit) : '',
    }));

  return [...fromCatalogue, ...orphans];
}

export type OptionWrite =
  | { readonly kind: 'put'; readonly code: string; readonly option: DraftOptionWire }
  | { readonly kind: 'delete'; readonly code: string };

/**
 * ⭐ The writes that turn the draft's current options into the wanted ones.
 *
 * There is no batch endpoint: the API takes one `PUT …/options/:code` or
 * `DELETE …/options/:code` at a time, each carrying the hash it expects. So a save is a
 * sequence, and this is the part worth testing on its own — the ordering and the "nothing
 * changed" case are both easy to get subtly wrong in a component.
 *
 * ⛔ **Puts before deletes.** Renaming a group is a put of the new one and a delete of the
 * old; doing the delete first would, for the width or height group, leave the draft
 * momentarily unpublishable — which the server refuses outright (`productSchema` runs on
 * every mutation, not only at publish). Adding first is never refused for that reason.
 *
 * ⚠️ Groups that have not changed produce no write at all. Re-putting every group on every
 * save would work, but each one is a round trip that moves `documentHash`, so an unchanged
 * save would still count as an edit against a colleague's concurrent one.
 */
export function optionWrites(
  current: readonly OptionGroupWire[],
  wanted: Readonly<Record<string, DraftOptionWire>>,
): readonly OptionWrite[] {
  const puts: OptionWrite[] = [];
  const deletes: OptionWrite[] = [];

  const currentByCode = new Map(current.map((group, index) => [group.code, { group, index }]));

  for (const [code, option] of Object.entries(wanted)) {
    const existing = currentByCode.get(code);
    if (existing === undefined || !sameOption(existing.group, existing.index, option)) {
      puts.push({ kind: 'put', code, option });
    }
  }

  for (const group of current) {
    if (!(group.code in wanted)) deletes.push({ kind: 'delete', code: group.code });
  }

  return [...puts, ...deletes];
}

/**
 * Whether the draft already says what the editor wants it to say.
 *
 * Compared through the values, never by object identity: the editor rebuilds every option on
 * every keystroke, so identity is always different and would make every save rewrite
 * everything.
 *
 * ⚠️ The **position** is part of it, and it has to be read from the array rather than from
 * the group: `OptionGroupWire` carries no `sortOrder` because the order *is* the order of
 * `product.groups`. That order is what the configurator lays the groups out by, so moving one
 * is a change even when nothing else about it moved — and comparing only the values would
 * silently drop a reorder on the floor.
 */
function sameOption(group: OptionGroupWire, index: number, option: DraftOptionWire): boolean {
  if (index !== option.sortOrder) return false;

  if (group.kind === 'custom') {
    if (option.kind !== 'custom') return false;
    return (
      decodeUm(group.minUm) === decodeUm(option.minUm) &&
      decodeUm(group.maxUm) === decodeUm(option.maxUm) &&
      decodeUm(group.stepUm) === decodeUm(option.stepUm) &&
      decodeUm(group.defaultUm) === decodeUm(option.defaultUm)
    );
  }

  if (option.kind !== 'sku') return false;
  const offered = group.values.map((value) => value.code);
  return (
    group.defaultValue === option.defaultValueCode &&
    offered.length === option.valueCodes.length &&
    offered.every((code, index) => code === option.valueCodes[index])
  );
}
