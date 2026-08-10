import { TAX_TREATMENTS_WIRE, type TaxCountryPatchRequest, type TaxCountryWire } from '@wewin/contract/tax';

import type { SelectFieldOption } from '@/components/products/form-field';
import { vatLabelTh } from '@/components/quotes/quote-alerts';

import type { ChangedFieldView } from './bank-account-changes';
import type { TaxCountryChangeRow } from './organisation-api';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The pure half of the tax-country table — no React, so it is provable without rendering.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `packages/core/src/money.ts`'s `satangField`/`readSatang` are the precedent for "store minor
 * units, edit as a decimal string", but that pair is baht-and-satang specifically (always two
 * decimal places, ฿ semantics) and is not imported here — basis points are a different unit
 * with a different display rule: `rateField(700)` is `'7'`, not `'7.00'`, because a percentage
 * box that always shows two decimals reads as more precise than a person actually typed.
 * `rateField`/`readRateBp` mirror the *shape* of the money pair (a codec plus a text-box
 * reader that refuses what the API would refuse) without copying its two-decimal formatting.
 *
 * ── The treatment/rate pairing, decided rather than left to the server's 409 ──────
 *
 * `tax_countries_rate_matches_treatment` refuses a non-`standard` treatment with a nonzero
 * rate, and the API's own message says to clear the rate *in the same request*
 * (`error.tax_country.rate_treatment_conflict`). Two ways to honour that: refuse locally until
 * the person clears the box themselves, or clear it for them. This picks the second — the
 * form clears and disables the rate box the moment a non-`standard` treatment is chosen
 * (`tax-countries.tsx`'s `TaxCountryDialog`) — because the server's own sentence is telling the
 * client what to do, not asking it to double-check with the person first; a box that greys out
 * and reads "0%" the instant "ยกเว้นภาษี" is picked is a clearer signal than a red error under a
 * field the person never touched. `taxCountryPatchRequest` below re-derives `rateBp` from
 * `treatment` rather than trusting whatever text is still sitting in `ratePercent`, so the
 * invariant holds even if a future caller forgets to disable the box — belt and suspenders
 * around the one constraint here with no zod equivalent at all.
 */

/** Basis points → a percentage string for a text box: `700` ↔ `'7'`, `750` ↔ `'7.5'`. */
export function rateField(rateBp: number): string {
  const negative = rateBp < 0;
  const magnitude = Math.trunc(Math.abs(rateBp));
  const whole = Math.trunc(magnitude / 100);
  const fraction = magnitude % 100;
  const sign = negative ? '-' : '';

  if (fraction === 0) return `${sign}${whole}`;

  const fractionText = fraction % 10 === 0 ? String(fraction / 10) : String(fraction).padStart(2, '0');
  return `${sign}${whole}.${fractionText}`;
}

/** At most three digits of whole percent, then at most two decimal places — 0.01% is one bp. */
const RATE = /^(\d{1,3})(?:\.(\d{1,2}))?$/u;

/**
 * The percentage text box, read back to basis points — or `null` for anything
 * `tax_countries_rate_in_range` (0..10 000 bp, i.e. 0–100%) would refuse.
 *
 * ⭐ Refuses before a request is sent rather than after: a box that let someone type `200`
 * and only found out from the API's 422 is worse than one that never sent it.
 */
export function readRateBp(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;

  const match = RATE.exec(trimmed);
  if (match === null) return null;

  const whole = Number(match[1]);
  const fraction = (match[2] ?? '').padEnd(2, '0');
  const bp = whole * 100 + Number(fraction);

  return bp > 10_000 ? null : bp;
}

/** Basis, named rather than printed as a boolean a reader has to translate. */
export function basisLabelTh(pricesIncludeTax: boolean): string {
  return pricesIncludeTax ? 'รวมภาษีแล้ว' : 'ยังไม่รวมภาษี';
}

/** Whether the rate box may hold anything but zero — `false` for every treatment but `standard`. */
export function rateEditable(treatment: string): boolean {
  return treatment === 'standard';
}

/**
 * The treatment picker's own option labels, through `vatLabelTh` — the same function the table
 * cell renders through — rather than a second Thai mapping of the four values. `rateBp` is the
 * *current* row's rate, used only for the `standard` option (the other three never mention a
 * rate in `vatLabelTh`'s output, and their real rate is always 0 by the CHECK above), so
 * picking `standard` back after a detour through `exempt` reads as "back to what it was"
 * rather than a blank 0%.
 */
export function treatmentOptions(rateBp: number): readonly SelectFieldOption[] {
  return TAX_TREATMENTS_WIRE.map((treatment) => ({
    value: treatment,
    labelTh: vatLabelTh(treatment === 'standard' ? rateBp : 0, treatment),
  }));
}

/* ------------------------------------------------------------------ *
 * The edit form — nameTh, rate, treatment, basis. `code` is not here: it is the primary key,
 * fixed once a row exists, and `taxCountryPatchSchema` does not accept it.
 * ------------------------------------------------------------------ */

export interface TaxCountryFields {
  readonly nameTh: string;
  readonly ratePercent: string;
  readonly treatment: string;
  readonly pricesIncludeTax: boolean;
}

export interface TaxCountryFormErrors {
  readonly ratePercent?: string;
}

/** Same rule `profile-form.ts` follows: a merely empty field is never an error here. */
export function taxCountryFormErrors(fields: TaxCountryFields): TaxCountryFormErrors {
  const errors: Record<string, string> = {};

  if (fields.ratePercent.trim() !== '' && readRateBp(fields.ratePercent) === null) {
    errors['ratePercent'] = 'กรอกเป็นเปอร์เซ็นต์ 0 ถึง 100 ทศนิยมไม่เกิน 2 ตำแหน่ง เช่น 7 หรือ 7.5';
  }

  return errors;
}

export function taxCountryFormReady(fields: TaxCountryFields): boolean {
  return (
    fields.nameTh.trim() !== '' &&
    fields.ratePercent.trim() !== '' &&
    Object.keys(taxCountryFormErrors(fields)).length === 0
  );
}

/**
 * Called only once `taxCountryFormErrors` has come back empty. Always the whole editable
 * shape, never a diff — the same rule `bankAccountPatchRequest` follows, and for the same
 * reason: `TaxCountryService.patch` snapshots whatever keys the body carries, so a caller that
 * omitted an unchanged field would still be sending the *right* thing, but sending only what
 * was touched is one more way for a client and a server to disagree about what "unchanged"
 * means. `rateBp` is re-derived from `treatment` — see the header note — rather than read
 * verbatim off `ratePercent`.
 */
export function taxCountryPatchRequest(fields: TaxCountryFields): TaxCountryPatchRequest {
  const rateBp = rateEditable(fields.treatment) ? readRateBp(fields.ratePercent) ?? 0 : 0;

  return {
    nameTh: fields.nameTh.trim(),
    rateBp,
    treatment: fields.treatment as TaxCountryPatchRequest['treatment'],
    pricesIncludeTax: fields.pricesIncludeTax,
  };
}

/** The form, from the row the list last showed — the dual of `taxCountryPatchRequest`. */
export function fieldsFromTaxCountry(country: TaxCountryWire): TaxCountryFields {
  return {
    nameTh: country.nameTh,
    ratePercent: rateField(country.rateBp),
    treatment: country.treatment,
    pricesIncludeTax: country.pricesIncludeTax,
  };
}

/* ------------------------------------------------------------------ *
 * The change history — `RECORDED` in `tax-country.service.ts` is `code`, `nameTh`, `rateBp`,
 * `treatment`, `pricesIncludeTax`, `isActive`, `sortOrder`. `rateBp` and `treatment` are shown
 * as one row here rather than two: the CHECK above ties them together, so a change that
 * zero-rates a destination moves both in the same write, and two rows saying "rate: 7 → 0" and
 * "treatment: standard → zero_rated" separately is a worse read of one decision than the one
 * row `vatLabelTh` already knows how to print — "VAT 7% → ยกเว้นภาษีมูลค่าเพิ่ม".
 * ------------------------------------------------------------------ */

const RECORDED_ORDER = ['code', 'nameTh', 'tax', 'pricesIncludeTax', 'isActive', 'sortOrder'] as const;

const FIELD_LABELS: Readonly<Record<(typeof RECORDED_ORDER)[number], string>> = {
  code: 'รหัสประเทศ',
  nameTh: 'ชื่อประเทศ',
  tax: 'ภาษี',
  pricesIncludeTax: 'ฐานราคา',
  isActive: 'สถานะ',
  sortOrder: 'ลำดับ',
};

function rateBpOf(row: Readonly<Record<string, unknown>>): number {
  const value = row['rateBp'];
  return typeof value === 'number' ? value : 0;
}

function treatmentOf(row: Readonly<Record<string, unknown>>): string {
  const value = row['treatment'];
  return typeof value === 'string' ? value : 'standard';
}

function displayValue(key: (typeof RECORDED_ORDER)[number], row: Readonly<Record<string, unknown>>): string {
  switch (key) {
    case 'tax':
      return vatLabelTh(rateBpOf(row), treatmentOf(row));
    case 'pricesIncludeTax':
      return basisLabelTh(row['pricesIncludeTax'] === true);
    case 'isActive':
      return row['isActive'] === true ? 'ใช้งาน' : 'ปิดใช้งาน';
    default: {
      const value = row[key];
      if (value === null || value === undefined) return '—';
      return typeof value === 'string' ? value : String(value);
    }
  }
}

/** Same value, treating an absent key and an explicit `null` as the one thing they both mean. */
const sameValue = (a: unknown, b: unknown): boolean => (a ?? null) === (b ?? null);

const taxMoved = (before: Readonly<Record<string, unknown>>, after: Readonly<Record<string, unknown>>): boolean =>
  !sameValue(before['rateBp'], after['rateBp']) || !sameValue(before['treatment'], after['treatment']);

/** Whether this row records the country coming into existence, rather than an edit to it. */
export const isTaxCountryCreation = (change: TaxCountryChangeRow): boolean => change.before === null;

/**
 * The fields worth showing for one history row — every recorded field at its starting value
 * for a creation, or only the ones that actually moved for an edit. Same shape
 * `bank-account-changes.ts`'s `changedFields` uses for its own five fields.
 */
export function taxCountryChangedFields(change: TaxCountryChangeRow): readonly ChangedFieldView[] {
  const { before, after } = change;

  const keys =
    before === null
      ? RECORDED_ORDER
      : RECORDED_ORDER.filter((key) =>
          key === 'tax' ? taxMoved(before, after) : !sameValue(before[key], after[key]),
        );

  return keys.map((key) => ({
    key,
    labelTh: FIELD_LABELS[key],
    beforeText: before === null ? '—' : displayValue(key, before),
    afterText: displayValue(key, after),
  }));
}
