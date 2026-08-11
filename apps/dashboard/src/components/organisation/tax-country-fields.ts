import {
  FX_CURRENCIES_WIRE,
  TAX_TREATMENTS_WIRE,
  type TaxCountryCreateRequest,
  type TaxCountryPatchRequest,
  type TaxCountryWire,
} from '@wewin/contract/tax';

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
 * (`tax-country-dialog.tsx`'s `TaxCountryDialog`) — because the server's own sentence is telling the
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
 * A percentage text box, read back to basis points — or `null` for anything above `maxBp`.
 *
 * ⭐ Refuses before a request is sent rather than after: a box that let someone type `200`
 * and only found out from the API's 422 is worse than one that never sent it.
 */
function readBp(text: string, maxBp: number): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;

  const match = RATE.exec(trimmed);
  if (match === null) return null;

  const whole = Number(match[1]);
  const fraction = (match[2] ?? '').padEnd(2, '0');
  const bp = whole * 100 + Number(fraction);

  return bp > maxBp ? null : bp;
}

/** The VAT rate box. `tax_countries_rate_in_range` is 0..10 000 bp — 0 to 100 per cent. */
export const readRateBp = (text: string): number | null => readBp(text, 10_000);

/**
 * The exchange-rate spread box. `tax_countries_fx_spread_in_range` stops at 2 000 bp — 20 per
 * cent, five times the worst retail FX spread — so this is a *narrower* box than the VAT one
 * despite reading the same unit, and it refuses `25` where the VAT box would take it. Sharing
 * the codec rather than the ceiling is the point: one place decides what a percentage looks
 * like, and each field names its own limit.
 */
export const readSpreadBp = (text: string): number | null => readBp(text, 2_000);

/**
 * Baht per one whole unit of the destination currency, read out of a text box.
 *
 * ⚠️ Read as digits and handed on as digits, never through `Number`. The API takes this
 * field as a string for the reason `@wewin/core/money`'s `readSatang` gives about amounts and
 * `readRatio` repeats about rates — a decimal that survives a float round-trip is luck — and
 * turning it into a number here to "tidy it up" would undo all of that at the last step.
 * Thousands separators are stripped, exactly as `readSatang` strips them, because somebody
 * typing a VND-side rate will use them.
 *
 * Ten decimal places, matching `numeric(20, 10)` and the contract's own regex. `null` for
 * anything the API would refuse, including a rate that is all zeros.
 */
const MANUAL_RATE = /^(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,10}))?$/u;

export function readManualRate(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;

  const match = MANUAL_RATE.exec(trimmed);
  if (match === null) return null;

  const whole = (match[1] ?? '').replaceAll(',', '');
  if (whole.length > 10) return null;

  const fraction = match[2] ?? '';
  const canonical = fraction === '' ? whole : `${whole}.${fraction}`;

  // `tax_countries_fx_manual_rate_positive`, refused here rather than met as a 409.
  return /[1-9]/u.test(canonical) ? canonical : null;
}

/**
 * One destination's exchange-rate setting, in a table cell.
 *
 * ⭐ Names the rule that actually applies rather than listing both columns. A row carrying an
 * override *and* a 2% spread converts at the override, full stop — see THE RULE in
 * `packages/core/src/fx.ts` — so printing "2% · 35.90" beside it would say the opposite of
 * what happens. The spread is still on the row, and the edit dialog and the change history
 * both still show it; this cell answers "what will this destination convert at", which is the
 * question a table of destinations is being read for.
 */
export function fxSummaryTh(country: TaxCountryWire): string {
  if (country.fxCurrency === null) return 'ไม่แปลงสกุลเงิน';

  if (country.fxManualRate !== null) {
    return `${country.fxCurrency} · ${manualRateField(country.fxManualRate)} บาท (กำหนดเอง)`;
  }

  return country.fxSpreadBp === 0
    ? `${country.fxCurrency} · อัตรากลางตลาด`
    : `${country.fxCurrency} · อัตรากลางตลาด หัก ${rateField(country.fxSpreadBp)}%`;
}

/** The currency picker's options. `''` is the real choice "baht only, no conversion". */
export function fxCurrencyOptions(): readonly SelectFieldOption[] {
  return [
    { value: '', labelTh: 'ไม่แปลงสกุลเงิน (บาทเท่านั้น)' },
    ...FX_CURRENCIES_WIRE.map((currency) => ({ value: currency, labelTh: currency })),
  ];
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
  /** `''` means baht only — a real setting, not an empty one. */
  readonly fxCurrency: string;
  /** A percentage, blank meaning zero. */
  readonly fxSpreadPercent: string;
  /** Baht per one unit of `fxCurrency`, blank meaning "use the mid-market rate". */
  readonly fxManualRate: string;
}

export interface TaxCountryFormErrors {
  readonly ratePercent?: string;
  readonly fxSpreadPercent?: string;
  readonly fxManualRate?: string;
}

/** Same rule `profile-form.ts` follows: a merely empty field is never an error here. */
export function taxCountryFormErrors(fields: TaxCountryFields): TaxCountryFormErrors {
  const errors: Record<string, string> = {};

  if (fields.ratePercent.trim() !== '' && readRateBp(fields.ratePercent) === null) {
    errors['ratePercent'] = 'กรอกเป็นเปอร์เซ็นต์ 0 ถึง 100 ทศนิยมไม่เกิน 2 ตำแหน่ง เช่น 7 หรือ 7.5';
  }

  if (fields.fxSpreadPercent.trim() !== '' && readSpreadBp(fields.fxSpreadPercent) === null) {
    errors['fxSpreadPercent'] = 'กรอกเป็นเปอร์เซ็นต์ 0 ถึง 20 ทศนิยมไม่เกิน 2 ตำแหน่ง เช่น 2 หรือ 1.75';
  }

  if (fields.fxManualRate.trim() !== '' && readManualRate(fields.fxManualRate) === null) {
    errors['fxManualRate'] = 'กรอกเป็นตัวเลขมากกว่า 0 ทศนิยมไม่เกิน 10 ตำแหน่ง เช่น 35.90';
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
  const fxCurrency = readFxCurrency(fields.fxCurrency);

  return {
    nameTh: fields.nameTh.trim(),
    rateBp,
    treatment: fields.treatment as TaxCountryPatchRequest['treatment'],
    pricesIncludeTax: fields.pricesIncludeTax,
    fxCurrency,
    /*
     * A blank spread box is zero, not "leave it alone" — this request is always the whole
     * editable shape (see the note above), so an omitted spread would read as unchanged when
     * the person had just cleared it.
     */
    fxSpreadBp: readSpreadBp(fields.fxSpreadPercent) ?? 0,
    /*
     * ⚠️ Re-derived from `fxCurrency`, exactly as `rateBp` is re-derived from `treatment`
     * two lines up and for the identical reason. `tax_countries_fx_manual_rate_needs_currency`
     * is the second constraint on this table with no zod equivalent — a rate is baht per one
     * unit of *something* — and the dialog already clears the box when the currency goes, so
     * this is the belt to that pair of braces.
     */
    fxManualRate: fxCurrency === null ? null : readManualRate(fields.fxManualRate),
  };
}

/** `''` from the picker is the real answer "no conversion", not a missing one. */
function readFxCurrency(value: string): TaxCountryWire['fxCurrency'] {
  return value === '' ? null : (value as NonNullable<TaxCountryWire['fxCurrency']>);
}

/** The form, from the row the list last showed — the dual of `taxCountryPatchRequest`. */
export function fieldsFromTaxCountry(country: TaxCountryWire): TaxCountryFields {
  return {
    nameTh: country.nameTh,
    ratePercent: rateField(country.rateBp),
    treatment: country.treatment,
    pricesIncludeTax: country.pricesIncludeTax,
    fxCurrency: country.fxCurrency ?? '',
    fxSpreadPercent: rateField(country.fxSpreadBp),
    /*
     * `numeric(20, 10)` comes back padded — `'35.90'` reads as `'35.9000000000'` — and putting
     * ten zeroes in a text box invites somebody to "correct" them. Trimmed to what was
     * actually typed, which `readManualRate` then hands straight back unchanged, so opening
     * the dialog and saving without touching anything stores the identical value.
     */
    fxManualRate: manualRateField(country.fxManualRate),
  };
}

/** `'35.9000000000'` → `'35.9'`; `'36.0000000000'` → `'36'`; `null` → `''`. */
export function manualRateField(stored: string | null): string {
  if (stored === null) return '';
  if (!stored.includes('.')) return stored;

  const trimmed = stored.replace(/0+$/u, '').replace(/\.$/u, '');
  return trimmed === '' ? '0' : trimmed;
}

/* ------------------------------------------------------------------ *
 * Creating a destination — everything the edit form has, plus `code`.
 *
 * ⚠️ **A typo in `code` is permanent.** It is the primary key, an ISO 3166-1 alpha-2 pair,
 * and `tax_countries_block_delete` refuses a DELETE unconditionally — the only way to retire
 * a row, mistyped or not, is `isActive: false` (`setTaxCountryAvailability`), which leaves it
 * in this table, dimmed, for ever. `bank_accounts` carries the identical shape (no delete
 * route either, only the same availability flag) and `BankAccountDialog` still uses a plain
 * validated text input with no extra confirmation step for creating one — I follow that
 * precedent here rather than inventing a type-twice or an "are you sure" gate, because the
 * *mechanism* of the mistake and its remedy are identical to the bank-account case that
 * precedent already covers. What is different is who sees the consequence: a stray bank
 * account is invisible to a customer, while a stray tax-country code is a row `GET
 * /destinations` would show in the storefront's picker the moment somebody switches it on —
 * so `TaxCountryDialog`'s create mode adds an explicit sentence naming that consequence next
 * to the field, rather than a structurally different control for what is mechanically the
 * same risk.
 * ------------------------------------------------------------------ */

export interface TaxCountryCreateFields extends TaxCountryFields {
  readonly code: string;
}

export interface TaxCountryCreateFormErrors extends TaxCountryFormErrors {
  readonly code?: string;
}

/** ISO 3166-1 alpha-2 — mirrors `taxCountryCreateSchema`'s own `code` shape exactly. */
const COUNTRY_CODE = /^[A-Z]{2}$/u;

export function taxCountryCreateFormErrors(fields: TaxCountryCreateFields): TaxCountryCreateFormErrors {
  const errors: Record<string, string> = { ...taxCountryFormErrors(fields) };

  const code = fields.code.trim().toUpperCase();
  if (code !== '' && !COUNTRY_CODE.test(code)) {
    errors['code'] = 'รหัสประเทศเป็นตัวอักษร A-Z สองตัวตามมาตรฐาน ISO 3166-1 เช่น SG, VN';
  }

  return errors;
}

export function taxCountryCreateFormReady(fields: TaxCountryCreateFields): boolean {
  return COUNTRY_CODE.test(fields.code.trim().toUpperCase()) && taxCountryFormReady(fields);
}

/**
 * Called only once `taxCountryCreateFormErrors` has come back empty.
 *
 * ⚠️ The FX fields are **spread in conditionally rather than sent as `null`**, unlike the
 * patch above, and the difference is in the schemas rather than in this file's taste:
 * `taxCountryCreateSchema` marks them `.optional()` with no `.nullable()`, because on a create
 * "not set" is spelled by absence — there is no prior value to clear. `contract`'s build sets
 * `exactOptionalPropertyTypes`, so `{ fxCurrency: undefined }` is not the same thing as an
 * absent key and would not compile against it either.
 */
export function taxCountryCreateRequest(fields: TaxCountryCreateFields): TaxCountryCreateRequest {
  const rateBp = rateEditable(fields.treatment) ? readRateBp(fields.ratePercent) ?? 0 : 0;
  const spread = readSpreadBp(fields.fxSpreadPercent);

  const base: TaxCountryCreateRequest = {
    code: fields.code.trim().toUpperCase(),
    nameTh: fields.nameTh.trim(),
    rateBp,
    treatment: fields.treatment as TaxCountryCreateRequest['treatment'],
    pricesIncludeTax: fields.pricesIncludeTax,
    ...(spread === null ? {} : { fxSpreadBp: spread }),
  };

  const fxCurrency = readFxCurrency(fields.fxCurrency);
  if (fxCurrency === null) return base;

  const fxManualRate = readManualRate(fields.fxManualRate);
  return fxManualRate === null
    ? { ...base, fxCurrency }
    : { ...base, fxCurrency, fxManualRate };
}

/* ------------------------------------------------------------------ *
 * The change history — `RECORDED` in `tax-country.service.ts` is `code`, `nameTh`, `rateBp`,
 * `treatment`, `pricesIncludeTax`, `fxCurrency`, `fxSpreadBp`, `fxManualRate`, `isActive`,
 * `sortOrder`. `rateBp` and `treatment` are shown as one row here rather than two: the CHECK
 * above ties them together, so a change that zero-rates a destination moves both in the same
 * write, and two rows saying "rate: 7 → 0" and "treatment: standard → zero_rated" separately
 * is a worse read of one decision than the one row `vatLabelTh` already knows how to print —
 * "VAT 7% → ยกเว้นภาษีมูลค่าเพิ่ม".
 *
 * ⚠️ **The three FX fields are shown as three rows, not folded into one, and that is the
 * opposite decision to the `tax` pairing above.** The reason the rate and treatment fold is
 * that a CHECK makes them one decision. These three are not: the spread and the override
 * answer different questions and are moved for different reasons — widening a spread is a
 * standing policy change, typing an override is a one-off correction — and a review that
 * showed "อัตราแลกเปลี่ยน: changed" would hide precisely which of the two somebody moved.
 * A spread change is the quietest edit on this table (it moves what a customer pays without
 * moving any figure a VAT filing would print), so it gets its own line with its own before
 * and after.
 *
 * What *is* folded in is the interaction: the spread's line says out loud when an override on
 * the same snapshot has made it inert, so nobody reads "2%" off this log and assumes it ran.
 * ------------------------------------------------------------------ */

const RECORDED_ORDER = [
  'code',
  'nameTh',
  'tax',
  'pricesIncludeTax',
  'fxCurrency',
  'fxSpreadBp',
  'fxManualRate',
  'isActive',
  'sortOrder',
] as const;

const FIELD_LABELS: Readonly<Record<(typeof RECORDED_ORDER)[number], string>> = {
  code: 'รหัสประเทศ',
  nameTh: 'ชื่อประเทศ',
  tax: 'ภาษี',
  pricesIncludeTax: 'ฐานราคา',
  fxCurrency: 'สกุลเงินปลายทาง',
  fxSpreadBp: 'ส่วนต่างอัตราแลกเปลี่ยน',
  fxManualRate: 'อัตราแลกเปลี่ยนกำหนดเอง',
  isActive: 'สถานะ',
  sortOrder: 'ลำดับ',
};

const textOf = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * The spread as it was actually applied on that snapshot.
 *
 * ⭐ An override on the same row makes the spread inert — see THE RULE in
 * `packages/core/src/fx.ts`. The service records the column, which is right (the setting is
 * preserved so that removing the override restores it), but a reviewer reading "2%" off a
 * history row and concluding that 2% was charged would be reading it wrong. So the log says
 * so, on the line where the misreading would happen.
 */
function spreadDisplay(row: Readonly<Record<string, unknown>>): string {
  const bp = row['fxSpreadBp'];
  const shown = typeof bp === 'number' ? `${rateField(bp)}%` : '—';

  return textOf(row['fxManualRate']) === null ? shown : `${shown} (ไม่ใช้ เพราะมีอัตรากำหนดเอง)`;
}

/** `35.90 บาท/USD` — a rate is meaningless without the currency it is a rate of. */
function manualRateDisplay(row: Readonly<Record<string, unknown>>): string {
  const stored = textOf(row['fxManualRate']);
  if (stored === null) return 'ใช้อัตรากลางตลาด';

  const currency = textOf(row['fxCurrency']);
  const rate = manualRateField(stored);
  return currency === null ? `${rate} บาท` : `${rate} บาท/${currency}`;
}

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
    case 'fxCurrency':
      return textOf(row['fxCurrency']) ?? 'ไม่แปลงสกุลเงิน';
    case 'fxSpreadBp':
      return spreadDisplay(row);
    case 'fxManualRate':
      return manualRateDisplay(row);
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

/**
 * The spread's line also moves when an override appears or disappears, even though the column
 * itself did not — because that is the write that turns the spread on or off. Setting an
 * override is the one edit that changes what the spread *does* without changing what it *is*,
 * and a history that stayed silent about it would be silent about exactly the moment the
 * interaction rule started applying.
 */
const spreadMoved = (
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
): boolean =>
  !sameValue(before['fxSpreadBp'], after['fxSpreadBp']) ||
  (textOf(before['fxManualRate']) === null) !== (textOf(after['fxManualRate']) === null);

/** Whether this row records the country coming into existence, rather than an edit to it. */
export const isTaxCountryCreation = (change: TaxCountryChangeRow): boolean => change.before === null;

/**
 * The fields worth showing for one history row — every recorded field at its starting value
 * for a creation, or only the ones that actually moved for an edit. Same shape
 * `bank-account-changes.ts`'s `changedFields` uses for its own five fields.
 */
export function taxCountryChangedFields(change: TaxCountryChangeRow): readonly ChangedFieldView[] {
  const { before, after } = change;

  const moved = (key: (typeof RECORDED_ORDER)[number], was: Readonly<Record<string, unknown>>): boolean => {
    if (key === 'tax') return taxMoved(was, after);
    if (key === 'fxSpreadBp') return spreadMoved(was, after);
    return !sameValue(was[key], after[key]);
  };

  const keys =
    before === null ? RECORDED_ORDER : RECORDED_ORDER.filter((key) => moved(key, before));

  return keys.map((key) => ({
    key,
    labelTh: FIELD_LABELS[key],
    beforeText: before === null ? '—' : displayValue(key, before),
    afterText: displayValue(key, after),
  }));
}
