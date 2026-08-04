'use client';

import { useId } from 'react';

import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

/**
 * The three field shapes these screens use, wired to `@/components/ui/field`.
 *
 * shadcn dropped its react-hook-form wrapper — `@shadcn/form` is an empty registry item now
 * — and replaced it with `Field`, which is form-library-agnostic and takes its error as an
 * array of `{ message }`. That leaves the binding to the caller, and doing it inline at
 * thirty call sites is thirty chances to forget the `htmlFor`, which is the difference
 * between a label and a label a screen reader announces. So it is done once, here.
 *
 * `error` is a plain string rather than a validation-library object on purpose: every
 * message these screens show comes from `quantities.ts`, which returns Thai prose saying
 * what unit was expected, or from the API's own envelope. Neither is a `FieldError` from
 * anything.
 */

interface CommonProps {
  readonly label: string;
  readonly description?: string | undefined;
  readonly error?: string | undefined;
  readonly disabled?: boolean;
}

export interface TextFieldProps extends CommonProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string | undefined;
  readonly multiline?: boolean;
  readonly mono?: boolean;
  /** A unit or currency shown inside the box — `฿`, `cm`, `ตร.ม.`. */
  readonly suffix?: string | undefined;
  readonly prefix?: string | undefined;
}

export function TextField({
  label,
  description,
  error,
  disabled,
  value,
  onChange,
  placeholder,
  multiline = false,
  mono = false,
  suffix,
  prefix,
}: TextFieldProps) {
  const id = useId();
  const invalid = error !== undefined;
  const describedBy = description === undefined ? undefined : `${id}-description`;

  const shared = {
    id,
    value,
    disabled,
    placeholder,
    'aria-invalid': invalid,
    'aria-describedby': describedBy,
    onChange: (event: { readonly target: { readonly value: string } }) => {
      onChange(event.target.value);
    },
  } as const;

  return (
    <Field data-invalid={invalid || undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {multiline ? (
        <Textarea {...shared} className={mono ? 'font-mono' : undefined} rows={3} />
      ) : prefix === undefined && suffix === undefined ? (
        <Input {...shared} className={mono ? 'font-mono' : undefined} />
      ) : (
        <InputGroup>
          {prefix === undefined ? null : <InputGroupAddon>{prefix}</InputGroupAddon>}
          <InputGroupInput {...shared} className={mono ? 'font-mono' : undefined} />
          {suffix === undefined ? null : (
            <InputGroupAddon align="inline-end">{suffix}</InputGroupAddon>
          )}
        </InputGroup>
      )}
      {description === undefined ? null : (
        <FieldDescription id={describedBy}>{description}</FieldDescription>
      )}
      {error === undefined ? null : <FieldError errors={[{ message: error }]} />}
    </Field>
  );
}

export interface SelectFieldOption {
  readonly value: string;
  readonly labelTh: string;
}

export interface SelectFieldProps extends CommonProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly options: readonly SelectFieldOption[];
  readonly placeholder?: string | undefined;
}

export function SelectField({
  label,
  description,
  error,
  disabled,
  value,
  onChange,
  options,
  placeholder,
}: SelectFieldProps) {
  const id = useId();
  const describedBy = description === undefined ? undefined : `${id}-description`;

  return (
    <Field data-invalid={error !== undefined || undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select value={value} onValueChange={onChange} disabled={disabled ?? false}>
        <SelectTrigger id={id} aria-describedby={describedBy} aria-invalid={error !== undefined}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.labelTh}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {description === undefined ? null : (
        <FieldDescription id={describedBy}>{description}</FieldDescription>
      )}
      {error === undefined ? null : <FieldError errors={[{ message: error }]} />}
    </Field>
  );
}

/**
 * A value that is not editable here, shown in the same rhythm as the ones that are.
 *
 * Used for the published document, which is frozen, and for the canonical micrometre figure
 * beside a measurement. Rendering those as disabled inputs would be a lie of a different
 * kind: a disabled box says "not right now", and a frozen document says "not ever, by
 * design — open a draft".
 */
export function ReadOnlyField({
  label,
  value,
  description,
}: {
  readonly label: string;
  readonly value: string;
  readonly description?: string | undefined;
}) {
  return (
    <Field>
      <FieldLabel className="text-muted-foreground">{label}</FieldLabel>
      <p className="text-sm break-words">{value}</p>
      {description === undefined ? null : <FieldDescription>{description}</FieldDescription>}
    </Field>
  );
}
