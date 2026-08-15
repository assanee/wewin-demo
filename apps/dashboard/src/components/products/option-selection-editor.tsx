'use client';

import type { AdminOptionGroupWire } from '@wewin/contract';

import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { FieldGroup } from '@/components/ui/field';
import { SelectField, TextField } from './form-field';

import { REQUIRED_CUSTOM_CODES, displayRank, type GroupChoice } from './option-selection';

/**
 * ⭐ ชุดตัวเลือกของสินค้า — which groups this product offers, and on what terms.
 *
 * `option-selection.ts` holds every rule and the argument for each; this is the arrangement
 * of controls around them.
 *
 * ⚠️ **Every group here is picked, never typed.** The codes must already exist in the shared
 * `option_groups` table — an unknown one is answered 404 in the middle of the POST, which
 * reads as a broken endpoint rather than a typo. A group that is missing from this list is
 * created on the ชุดตัวเลือก screen first; there is a link to it below.
 *
 * ⚠️ `width` and `height` are marked จำเป็น and cannot be unticked. They are not a
 * convention: pricing reads those two group codes directly, and a product without them is
 * refused by `productSchema` when the draft compiles — after the product row has been
 * written and rolled back. Fixing that here costs one disabled checkbox.
 */
export function OptionSelectionEditor({
  groups,
  choices,
  disabled,
  onChange,
}: {
  readonly groups: readonly AdminOptionGroupWire[];
  readonly choices: readonly GroupChoice[];
  readonly disabled: boolean;
  readonly onChange: (code: string, next: Partial<GroupChoice>) => void;
}) {
  const choiceOf = (code: string): GroupChoice | undefined =>
    choices.find((choice) => choice.code === code);

  /* Measurements first: they are the two nobody may skip, so they are the two shown first. */
  const ordered = [...groups].sort((left, right) => displayRank(left) - displayRank(right));

  return (
    <div className="flex flex-col gap-3">
      {ordered.map((group) => {
        const choice = choiceOf(group.code);
        if (choice === undefined) return null;
        const required = isRequired(group.code);

        return (
          <div
            key={group.code}
            className={`flex flex-col gap-3 rounded border p-3 ${
              choice.offered ? '' : 'bg-muted/20'
            }`}
          >
            <label className="flex items-start gap-3">
              <Checkbox
                checked={choice.offered}
                /* Required groups are shown ticked and locked — see the header. */
                disabled={disabled || required}
                onCheckedChange={(next) => onChange(group.code, { offered: next === true })}
                className="mt-1"
              />
              <span className="flex min-w-0 flex-col gap-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="type-body font-medium">{group.labelTh}</span>
                  <Badge variant="outline" className="font-mono">
                    {group.code}
                  </Badge>
                  {group.kind === 'custom' ? (
                    <Badge variant="outline">ขนาดที่วัดได้</Badge>
                  ) : (
                    <Badge variant="outline">{group.values.length} ตัวเลือก</Badge>
                  )}
                  {required && <Badge>จำเป็น</Badge>}
                </span>
                {group.helperTh !== undefined && (
                  <span className="text-muted-foreground type-caption">{group.helperTh}</span>
                )}
              </span>
            </label>

            {choice.offered && group.kind === 'custom' && (
              <MeasurementFields
                group={group}
                choice={choice}
                disabled={disabled}
                onChange={onChange}
              />
            )}

            {choice.offered && group.kind === 'sku' && (
              <ValueChoices group={group} choice={choice} disabled={disabled} onChange={onChange} />
            )}
          </div>
        );
      })}

      <p className="text-muted-foreground type-caption">
        กลุ่มที่ต้องการยังไม่มีในรายการ? สร้างที่หน้า{' '}
        <a className="underline" href="/option-groups">
          ชุดตัวเลือก
        </a>{' '}
        ก่อน — ป้ายกำกับ รูปแบบการเลือก และรายการค่าทั้งหมดใช้ร่วมกันทุกสินค้า
      </p>
    </div>
  );
}

const isRequired = (code: string): boolean =>
  (REQUIRED_CUSTOM_CODES as readonly string[]).includes(code);

function MeasurementFields({
  group,
  choice,
  disabled,
  onChange,
}: {
  readonly group: AdminOptionGroupWire;
  readonly choice: GroupChoice;
  readonly disabled: boolean;
  readonly onChange: (code: string, next: Partial<GroupChoice>) => void;
}) {
  const unit = group.authoredUnit ?? 'cm';

  return (
    <FieldGroup className="grid gap-3 md:grid-cols-4">
      <TextField
        label="ต่ำสุด"
        value={choice.minText}
        onChange={(next) => onChange(group.code, { minText: next })}
        disabled={disabled}
        suffix={unit}
        mono
      />
      <TextField
        label="สูงสุด"
        value={choice.maxText}
        onChange={(next) => onChange(group.code, { maxText: next })}
        disabled={disabled}
        suffix={unit}
        mono
      />
      <TextField
        label="สเต็ป"
        value={choice.stepText}
        onChange={(next) => onChange(group.code, { stepText: next })}
        disabled={disabled}
        suffix={unit}
        mono
        /*
         * The lattice is stated rather than left to be discovered: every rejection of a step
         * comes back from Postgres as one sentence covering eight different faults, so a
         * person who guesses 0.3 learns only that "something about the grid" is wrong.
         */
        description="ต้องเป็นจำนวนเท่าของ 0.0025 cm"
      />
      <TextField
        label="ค่าเริ่มต้น"
        value={choice.defaultText}
        onChange={(next) => onChange(group.code, { defaultText: next })}
        disabled={disabled}
        suffix={unit}
        mono
        description="ขนาดที่หน้าสินค้าเปิดมา"
      />
    </FieldGroup>
  );
}

function ValueChoices({
  group,
  choice,
  disabled,
  onChange,
}: {
  readonly group: AdminOptionGroupWire;
  readonly choice: GroupChoice;
  readonly disabled: boolean;
  readonly onChange: (code: string, next: Partial<GroupChoice>) => void;
}) {
  const toggle = (valueCode: string, on: boolean): void => {
    const next = on
      ? [...choice.valueCodes, valueCode]
      : choice.valueCodes.filter((code) => code !== valueCode);
    onChange(group.code, {
      valueCodes: next,
      /*
       * Unticking the value that was the default leaves the default naming something this
       * product does not offer — refused by core with a message that arrives buried in a
       * 422. Clearing it here turns that into an empty select the person can see.
       */
      ...(next.includes(choice.defaultValueCode) ? {} : { defaultValueCode: next[0] ?? '' }),
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        {group.values.map((value) => (
          <label key={value.code} className="flex items-center gap-2">
            <Checkbox
              checked={choice.valueCodes.includes(value.code)}
              disabled={disabled}
              onCheckedChange={(next) => toggle(value.code, next === true)}
            />
            <span className="type-body">{value.labelTh}</span>
            <span className="text-muted-foreground type-caption font-mono">{value.code}</span>
            {group.input === 'swatch' && !value.swatchHex && (
              <span className="text-destructive type-caption">ไม่มีรหัสสี</span>
            )}
          </label>
        ))}
      </div>

      <SelectField
        label="ค่าเริ่มต้น"
        value={choice.defaultValueCode}
        onChange={(next) => onChange(group.code, { defaultValueCode: next })}
        disabled={disabled || choice.valueCodes.length === 0}
        options={group.values
          .filter((value) => choice.valueCodes.includes(value.code))
          .map((value) => ({ value: value.code, labelTh: value.labelTh }))}
        description="ตัวเลือกที่หน้าสินค้าเปิดมา — ต้องเป็นหนึ่งในที่ติ๊กไว้"
      />
    </div>
  );
}
