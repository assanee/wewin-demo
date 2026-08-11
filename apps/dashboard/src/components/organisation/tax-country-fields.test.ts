import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TaxCountryWire } from '@wewin/contract/tax';

import {
  basisLabelTh,
  fieldsFromTaxCountry,
  fxCurrencyOptions,
  fxSummaryTh,
  isTaxCountryCreation,
  manualRateField,
  rateEditable,
  rateField,
  readManualRate,
  readRateBp,
  readSpreadBp,
  taxCountryChangedFields,
  taxCountryCreateFormErrors,
  taxCountryCreateFormReady,
  taxCountryCreateRequest,
  taxCountryFormErrors,
  taxCountryFormReady,
  taxCountryPatchRequest,
  treatmentOptions,
} from './tax-country-fields';

import type { TaxCountryChangeRow } from './organisation-api';
import TaxCountriesSection, { type TaxCountriesState } from './tax-countries';

/**
 * The pure half of the tax-country table, tested directly — no DOM, no testing library, per
 * `apps/dashboard/vitest.config.ts`'s own stance that a component test here would be a test of
 * this file's functions, spelled expensively. `TaxCountriesSection`'s own permission gate is
 * checked below too, via `renderToStaticMarkup`, which needs no DOM and runs fine under this
 * suite's `environment: 'node'`.
 */

/**
 * The FX half of the edit form, at its "no conversion" default — spread into every fixture
 * below that predates it, so those tests keep asserting exactly what they asserted before.
 */
const NO_FX = { fxCurrency: '', fxSpreadPercent: '0', fxManualRate: '' } as const;

/** The same three, as one row of `tax_countries` reads back. */
const NO_FX_WIRE = { fxCurrency: null, fxSpreadBp: 0, fxManualRate: null } as const;

describe('the rate edits as a percentage and stores basis points', () => {
  it('round-trips whole and fractional rates', () => {
    expect(rateField(700)).toBe('7');
    expect(rateField(750)).toBe('7.5');
    expect(rateField(0)).toBe('0');
    expect(readRateBp('7')).toBe(700);
    expect(readRateBp('7.5')).toBe(750);
  });

  it('round-trips a rate with two decimal places, the smallest step a basis point can express', () => {
    expect(rateField(725)).toBe('7.25');
    expect(readRateBp('7.25')).toBe(725);
  });

  it('refuses what the API would refuse, before a request is sent', () => {
    /* The CHECK is 0..10 000 bp. A form that posts 200% and shows the server's error is worse
       than one that never sends it. */
    expect(readRateBp('200')).toBeNull();
    expect(readRateBp('-1')).toBeNull();
    expect(readRateBp('')).toBeNull();
    expect(readRateBp('abc')).toBeNull();
  });

  it('accepts the boundary the CHECK itself accepts', () => {
    expect(readRateBp('0')).toBe(0);
    expect(readRateBp('100')).toBe(10_000);
    expect(readRateBp('100.01')).toBeNull();
  });

  it('names the basis rather than printing a boolean', () => {
    expect(basisLabelTh(true)).toBe('รวมภาษีแล้ว');
    expect(basisLabelTh(false)).toBe('ยังไม่รวมภาษี');
  });
});

describe('treatmentOptions — labelled through vatLabelTh, not a second mapping', () => {
  it('shows the current rate only on the standard option', () => {
    const options = treatmentOptions(700);
    expect(options.find((option) => option.value === 'standard')?.labelTh).toBe('VAT 7%');
    expect(options.find((option) => option.value === 'exempt')?.labelTh).toBe('ยกเว้นภาษีมูลค่าเพิ่ม');
    expect(options.find((option) => option.value === 'zero_rated')?.labelTh).toBe('VAT 0% (อัตราศูนย์)');
  });

  it('lists all four treatments the CHECK allows, no more and no fewer', () => {
    expect(treatmentOptions(0).map((option) => option.value).sort()).toEqual(
      ['standard', 'zero_rated', 'exempt', 'out_of_scope'].sort(),
    );
  });
});

describe('the treatment/rate pairing — cleared for the person, not merely refused', () => {
  it('rate is editable only for standard', () => {
    expect(rateEditable('standard')).toBe(true);
    expect(rateEditable('zero_rated')).toBe(false);
    expect(rateEditable('exempt')).toBe(false);
    expect(rateEditable('out_of_scope')).toBe(false);
  });

  it('re-derives rateBp from treatment rather than trusting stale text in ratePercent', () => {
    /*
     * ⭐ The assertion this exists for. `tax_countries_rate_matches_treatment` refuses a
     * non-standard treatment with a nonzero rate; this proves the request builder can never
     * produce that pair even if the box holding `ratePercent` was never disabled.
     */
    const request = taxCountryPatchRequest({
      ...NO_FX,
      nameTh: 'สิงคโปร์',
      ratePercent: '7',
      treatment: 'zero_rated',
      pricesIncludeTax: false,
    });
    expect(request.rateBp).toBe(0);
    expect(request.treatment).toBe('zero_rated');
  });

  it('keeps the typed rate when the treatment is standard', () => {
    const request = taxCountryPatchRequest({
      ...NO_FX,
      nameTh: 'ไทย',
      ratePercent: '8',
      treatment: 'standard',
      pricesIncludeTax: false,
    });
    expect(request.rateBp).toBe(800);
  });
});

describe('taxCountryFormErrors and taxCountryFormReady', () => {
  const VALID = { ...NO_FX, nameTh: 'ไทย', ratePercent: '7', treatment: 'standard', pricesIncludeTax: false };

  it('accepts a well-shaped form', () => {
    expect(taxCountryFormErrors(VALID)).toEqual({});
    expect(taxCountryFormReady(VALID)).toBe(true);
  });

  it('never reports a merely-empty rate as an error — that is taxCountryFormReady’s job', () => {
    expect(taxCountryFormErrors({ ...VALID, ratePercent: '' })).toEqual({});
    expect(taxCountryFormReady({ ...VALID, ratePercent: '' })).toBe(false);
  });

  it('refuses a rate outside the CHECK’s range', () => {
    expect(taxCountryFormErrors({ ...VALID, ratePercent: '200' }).ratePercent).toBeDefined();
    expect(taxCountryFormReady({ ...VALID, ratePercent: '200' })).toBe(false);
  });

  it('is not ready while the name is blank', () => {
    expect(taxCountryFormReady({ ...VALID, nameTh: '   ' })).toBe(false);
  });
});

describe('taxCountryCreateFormErrors and taxCountryCreateFormReady — code added on top', () => {
  const VALID = {
    ...NO_FX,
    code: 'sg',
    nameTh: 'สิงคโปร์',
    ratePercent: '9',
    treatment: 'standard',
    pricesIncludeTax: true,
  };

  it('accepts a well-shaped create form, lower-case code and all', () => {
    expect(taxCountryCreateFormErrors(VALID)).toEqual({});
    expect(taxCountryCreateFormReady(VALID)).toBe(true);
  });

  it('never reports a merely-empty code as an error — required lives in Ready, same as name/rate', () => {
    expect(taxCountryCreateFormErrors({ ...VALID, code: '' })).toEqual({});
    expect(taxCountryCreateFormReady({ ...VALID, code: '' })).toBe(false);
  });

  it.each([
    ['three letters', 'sgp'],
    ['a digit', 's1'],
    ['one letter', 's'],
  ])('refuses a code shaped wrong: %s', (_why, code) => {
    expect(taxCountryCreateFormErrors({ ...VALID, code }).code).toBeDefined();
    expect(taxCountryCreateFormReady({ ...VALID, code })).toBe(false);
  });

  it('still inherits the shared rate-range check', () => {
    expect(taxCountryCreateFormErrors({ ...VALID, ratePercent: '200' }).ratePercent).toBeDefined();
    expect(taxCountryCreateFormReady({ ...VALID, ratePercent: '200' })).toBe(false);
  });
});

describe('taxCountryCreateRequest', () => {
  it('upper-cases the code and trims the name', () => {
    const request = taxCountryCreateRequest({
      ...NO_FX,
      code: 'sg',
      nameTh: '  สิงคโปร์  ',
      ratePercent: '9',
      treatment: 'standard',
      pricesIncludeTax: true,
    });
    expect(request.code).toBe('SG');
    expect(request.nameTh).toBe('สิงคโปร์');
    expect(request.rateBp).toBe(900);
    expect(request.pricesIncludeTax).toBe(true);
  });

  it('applies the same treatment/rate guard a create as an edit — the likeliest place to hit the 409', () => {
    /*
     * ⭐ A fresh row with `zero_rated` picked and a rate still sitting in the box from before
     * it was disabled is exactly the shape `tax_countries_rate_matches_treatment` exists to
     * refuse — more likely on a create, where the box starts blank and a person may type the
     * rate before touching the treatment picker at all.
     */
    const request = taxCountryCreateRequest({
      ...NO_FX,
      code: 'vn',
      nameTh: 'เวียดนาม',
      ratePercent: '10',
      treatment: 'zero_rated',
      pricesIncludeTax: false,
    });
    expect(request.rateBp).toBe(0);
    expect(request.treatment).toBe('zero_rated');
  });
});

describe('fieldsFromTaxCountry — the dual of taxCountryPatchRequest', () => {
  it('reads a loaded row into editable fields', () => {
    const country: TaxCountryWire = {
      ...NO_FX_WIRE,
      code: 'TH',
      nameTh: 'ไทย',
      rateBp: 700,
      treatment: 'standard',
      pricesIncludeTax: false,
      isActive: true,
      sortOrder: 0,
      updatedAt: '2026-08-09T10:00:00.000Z',
    };
    const fields = fieldsFromTaxCountry(country);
    expect(fields.ratePercent).toBe('7');
    expect(fields.nameTh).toBe('ไทย');
    expect(fields.pricesIncludeTax).toBe(false);
  });
});

describe('the change history — one row for the paired rate and treatment', () => {
  const CREATE: TaxCountryChangeRow = {
    id: '00000000-0000-4000-8000-0000000000c1',
    changedAt: '2026-08-09T10:00:00.000Z',
    changedByUserId: '00000000-0000-4000-8000-0000000000aa',
    before: null,
    after: {
      code: 'TH',
      nameTh: 'ไทย',
      rateBp: 700,
      treatment: 'standard',
      pricesIncludeTax: false,
      ...NO_FX_WIRE,
      isActive: true,
      sortOrder: 0,
    },
  };

  it('lists every recorded field for a creation, since there is nothing to diff against', () => {
    expect(isTaxCountryCreation(CREATE)).toBe(true);
    const fields = taxCountryChangedFields(CREATE);
    expect(fields.map((field) => field.key)).toEqual([
      'code',
      'nameTh',
      'tax',
      'pricesIncludeTax',
      'fxCurrency',
      'fxSpreadBp',
      'fxManualRate',
      'isActive',
      'sortOrder',
    ]);
    expect(fields.find((field) => field.key === 'tax')?.afterText).toBe('VAT 7%');
  });

  it('shows the rate and treatment as one moved row when either changes', () => {
    const zeroRated = {
      ...CREATE,
      before: CREATE.after,
      after: { ...CREATE.after, rateBp: 0, treatment: 'zero_rated' },
    };
    expect(isTaxCountryCreation(zeroRated)).toBe(false);

    const fields = taxCountryChangedFields(zeroRated);
    expect(fields).toHaveLength(1);
    expect(fields[0]?.key).toBe('tax');
    expect(fields[0]?.beforeText).toBe('VAT 7%');
    expect(fields[0]?.afterText).toBe('VAT 0% (อัตราศูนย์)');
  });

  it('reports no moved fields for an edit that changed nothing this reader tracks', () => {
    const unchanged = { ...CREATE, before: CREATE.after, after: CREATE.after };
    expect(taxCountryChangedFields(unchanged)).toEqual([]);
  });

  /**
   * ⭐ A spread change is the quietest edit on this table: it moves what a customer pays
   * without moving any figure a VAT return would print. If the history could not show it, the
   * setting would be one nobody could audit — which is the whole reason the three FX columns
   * are in `RECORDED`.
   */
  it('shows a spread change on its own line, before and after', () => {
    const widened = {
      ...CREATE,
      before: { ...CREATE.after, fxCurrency: 'USD', fxSpreadBp: 200 },
      after: { ...CREATE.after, fxCurrency: 'USD', fxSpreadBp: 350 },
    };

    const fields = taxCountryChangedFields(widened);
    expect(fields).toHaveLength(1);
    expect(fields[0]?.key).toBe('fxSpreadBp');
    expect(fields[0]?.beforeText).toBe('2%');
    expect(fields[0]?.afterText).toBe('3.5%');
  });

  /**
   * ⭐ THE RULE, as a reviewer meets it. Typing an override does not touch `fx_spread_bp`, so
   * a log that only diffed columns would say nothing about the spread — while in fact that
   * write is the moment the spread stopped applying. The line appears, and says so.
   */
  it('says the spread stopped applying when an override arrives, though its column did not move', () => {
    const overridden = {
      ...CREATE,
      before: { ...CREATE.after, fxCurrency: 'USD', fxSpreadBp: 200 },
      after: { ...CREATE.after, fxCurrency: 'USD', fxSpreadBp: 200, fxManualRate: '35.9000000000' },
    };

    const fields = taxCountryChangedFields(overridden);
    expect(fields.map((field) => field.key)).toEqual(['fxSpreadBp', 'fxManualRate']);

    const spread = fields.find((field) => field.key === 'fxSpreadBp');
    expect(spread?.beforeText).toBe('2%');
    expect(spread?.afterText).toBe('2% (ไม่ใช้ เพราะมีอัตรากำหนดเอง)');

    const manual = fields.find((field) => field.key === 'fxManualRate');
    expect(manual?.beforeText).toBe('ใช้อัตรากลางตลาด');
    // A rate is meaningless without the currency it is a rate of, so the log prints both.
    expect(manual?.afterText).toBe('35.9 บาท/USD');
  });

  it('shows a destination switching to a foreign currency', () => {
    const switched = {
      ...CREATE,
      before: CREATE.after,
      after: { ...CREATE.after, fxCurrency: 'SGD' },
    };

    const fields = taxCountryChangedFields(switched);
    expect(fields.map((field) => field.key)).toEqual(['fxCurrency']);
    expect(fields[0]?.beforeText).toBe('ไม่แปลงสกุลเงิน');
    expect(fields[0]?.afterText).toBe('SGD');
  });
});

describe('the exchange-rate settings — the spread box, the override box, and their pairing', () => {
  it('reads a spread as basis points, through the same codec the VAT rate uses', () => {
    expect(readSpreadBp('2')).toBe(200);
    expect(readSpreadBp('1.75')).toBe(175);
    expect(readSpreadBp('0')).toBe(0);
    expect(rateField(175)).toBe('1.75');
  });

  /*
   * ⭐ The spread's box is narrower than the VAT box despite reading the same unit:
   * `tax_countries_fx_spread_in_range` stops at 2 000 bp where `tax_countries_rate_in_range`
   * goes to 10 000. `25` is a valid VAT rate and an impossible FX spread.
   */
  it('refuses a spread the CHECK would refuse, where the VAT box would have taken it', () => {
    expect(readRateBp('25')).toBe(2_500);
    expect(readSpreadBp('25')).toBeNull();
    expect(readSpreadBp('20')).toBe(2_000);
    expect(readSpreadBp('20.01')).toBeNull();
  });

  it('reads an override as digits, strips separators, and refuses what the API would refuse', () => {
    expect(readManualRate('35.90')).toBe('35.90');
    expect(readManualRate(' 27.05 ')).toBe('27.05');
    expect(readManualRate('1,234.5')).toBe('1234.5');
    expect(readManualRate('0.0014321')).toBe('0.0014321');

    for (const bad of ['', '0', '0.00', '-1', 'abc', '.5', '12345678901']) {
      expect(readManualRate(bad), `readManualRate(${JSON.stringify(bad)})`).toBeNull();
    }
  });

  it('trims the padding numeric(20,10) reads back, so a saved rate round-trips unchanged', () => {
    expect(manualRateField('35.9000000000')).toBe('35.9');
    expect(manualRateField('36.0000000000')).toBe('36');
    expect(manualRateField(null)).toBe('');
    expect(readManualRate(manualRateField('27.0500000000'))).toBe('27.05');
  });

  it('offers every wire currency plus the real choice of not converting at all', () => {
    const options = fxCurrencyOptions();
    expect(options[0]?.value).toBe('');
    expect(options.map((option) => option.value)).toContain('SGD');
    expect(options.map((option) => option.value)).not.toContain('THB');
  });

  /**
   * ⭐ The pairing, re-derived rather than trusted — the same belt-and-braces
   * `taxCountryPatchRequest` applies to `rateBp` and `treatment`, for the same reason.
   * `tax_countries_fx_manual_rate_needs_currency` has no zod equivalent and cannot have one.
   */
  it('drops an override when no currency is chosen, whatever text is left in the box', () => {
    const request = taxCountryPatchRequest({
      nameTh: 'ไทย',
      ratePercent: '7',
      treatment: 'standard',
      pricesIncludeTax: false,
      fxCurrency: '',
      fxSpreadPercent: '2',
      fxManualRate: '35.90',
    });

    expect(request.fxCurrency).toBeNull();
    expect(request.fxManualRate).toBeNull();
    // The spread survives: inert without a currency, not wrong, and worth keeping for later.
    expect(request.fxSpreadBp).toBe(200);
  });

  it('sends both settings when a currency is chosen — the server decides which one wins', () => {
    const request = taxCountryPatchRequest({
      nameTh: 'สิงคโปร์',
      ratePercent: '0',
      treatment: 'zero_rated',
      pricesIncludeTax: false,
      fxCurrency: 'SGD',
      fxSpreadPercent: '2',
      fxManualRate: '27.05',
    });

    expect(request.fxCurrency).toBe('SGD');
    expect(request.fxSpreadBp).toBe(200);
    expect(request.fxManualRate).toBe('27.05');
  });

  it('treats a blank spread box as zero rather than as “leave it alone”', () => {
    const request = taxCountryPatchRequest({
      ...NO_FX,
      nameTh: 'ไทย',
      ratePercent: '7',
      treatment: 'standard',
      pricesIncludeTax: false,
      fxSpreadPercent: '',
    });
    expect(request.fxSpreadBp).toBe(0);
  });

  /**
   * ⚠️ A create spells "not set" by absence, not by null — `taxCountryCreateSchema` marks the
   * FX fields `.optional()` with no `.nullable()`, because there is no prior value to clear.
   */
  it('omits the FX keys from a create with no currency, rather than sending null', () => {
    const request = taxCountryCreateRequest({
      ...NO_FX,
      code: 'my',
      nameTh: 'มาเลเซีย',
      ratePercent: '0',
      treatment: 'zero_rated',
      pricesIncludeTax: false,
    });

    expect('fxCurrency' in request).toBe(false);
    expect('fxManualRate' in request).toBe(false);
    expect(request.fxSpreadBp).toBe(0);
  });

  it('carries the FX keys on a create that names a currency', () => {
    const request = taxCountryCreateRequest({
      code: 'sg',
      nameTh: 'สิงคโปร์',
      ratePercent: '0',
      treatment: 'zero_rated',
      pricesIncludeTax: false,
      fxCurrency: 'SGD',
      fxSpreadPercent: '2',
      fxManualRate: '27.05',
    });

    expect(request.fxCurrency).toBe('SGD');
    expect(request.fxSpreadBp).toBe(200);
    expect(request.fxManualRate).toBe('27.05');
  });

  it('reads a stored row back into the three boxes', () => {
    const fields = fieldsFromTaxCountry({
      code: 'SG',
      nameTh: 'สิงคโปร์',
      rateBp: 0,
      treatment: 'zero_rated',
      pricesIncludeTax: false,
      fxCurrency: 'SGD',
      fxSpreadBp: 175,
      fxManualRate: '27.0500000000',
      isActive: true,
      sortOrder: 1,
      updatedAt: '2026-08-09T10:00:00.000Z',
    });

    expect(fields.fxCurrency).toBe('SGD');
    expect(fields.fxSpreadPercent).toBe('1.75');
    expect(fields.fxManualRate).toBe('27.05');
  });

  it('reports a spread and an override the API would refuse, before a request is sent', () => {
    const errors = taxCountryFormErrors({
      nameTh: 'ไทย',
      ratePercent: '7',
      treatment: 'standard',
      pricesIncludeTax: false,
      fxCurrency: 'USD',
      fxSpreadPercent: '25',
      fxManualRate: '0',
    });

    expect(errors.fxSpreadPercent).toBeDefined();
    expect(errors.fxManualRate).toBeDefined();
    expect(
      taxCountryFormReady({
        nameTh: 'ไทย',
        ratePercent: '7',
        treatment: 'standard',
        pricesIncludeTax: false,
        fxCurrency: 'USD',
        fxSpreadPercent: '25',
        fxManualRate: '',
      }),
    ).toBe(false);
  });
});

describe('fxSummaryTh — the cell says what the destination will convert at', () => {
  const row = (fx: Partial<TaxCountryWire>): TaxCountryWire => ({
    ...NO_FX_WIRE,
    code: 'SG',
    nameTh: 'สิงคโปร์',
    rateBp: 0,
    treatment: 'zero_rated',
    pricesIncludeTax: false,
    isActive: true,
    sortOrder: 1,
    updatedAt: '2026-08-09T10:00:00.000Z',
    ...fx,
  });

  it('names no conversion at all', () => {
    expect(fxSummaryTh(row({}))).toBe('ไม่แปลงสกุลเงิน');
  });

  it('names the mid-market rate, with and without a spread', () => {
    expect(fxSummaryTh(row({ fxCurrency: 'SGD' }))).toBe('SGD · อัตรากลางตลาด');
    expect(fxSummaryTh(row({ fxCurrency: 'SGD', fxSpreadBp: 200 }))).toBe(
      'SGD · อัตรากลางตลาด หัก 2%',
    );
  });

  /**
   * ⭐ THE RULE again, in the one place somebody scanning the table would otherwise get it
   * wrong: a row carrying both settings converts at the override, so printing the spread
   * beside it would say the opposite of what happens.
   */
  it('names only the override when one is set, never both', () => {
    const summary = fxSummaryTh(
      row({ fxCurrency: 'SGD', fxSpreadBp: 200, fxManualRate: '27.0500000000' }),
    );

    expect(summary).toBe('SGD · 27.05 บาท (กำหนดเอง)');
    expect(summary).not.toContain('2%');
  });
});

describe('TaxCountriesSection — the permission gate', () => {
  const THAILAND: TaxCountryWire = {
    ...NO_FX_WIRE,
    code: 'TH',
    nameTh: 'ไทย',
    rateBp: 700,
    treatment: 'standard',
    pricesIncludeTax: false,
    isActive: true,
    sortOrder: 0,
    updatedAt: '2026-08-09T10:00:00.000Z',
  };
  const state: TaxCountriesState = { status: 'ready', taxCountries: [THAILAND] };
  const noop = async (): Promise<void> => {};

  /*
   * ⚠️ Adapted from the brief's own illustrative sample, which renders `TaxCountriesSection`
   * inside a `SessionProvider` given `{ permissions: [...] }`. The real `SessionProvider`
   * (`lib/auth/session.tsx`) takes no such prop — it bootstraps from the refresh cookie via
   * `useEffect`, which `renderToStaticMarkup` never runs, so it would render `loading` forever
   * and never reach `signed-in` no matter what was passed. `organisation-screen.tsx` resolves
   * `can('organisation.write')` exactly once, at the top of the page, and passes the boolean
   * down to every section (`:60-61`, `ProfileCard`/`AccountsCard`'s own `editable` prop) —
   * `TaxCountriesSection` follows that established shape rather than reading its own session,
   * which is also what makes it renderable here with no network layer at all. The brief's own
   * "if it cannot accept its rows as a prop, give it one" holds: `state` carries the rows.
   *
   * The word checked is `แก้ไข` (the Pencil edit button) rather than the sample's `บันทึก`
   * (Save) — this section's Save button lives inside a dialog that only mounts once a click
   * opens it (`TaxCountryDialog`, in `./tax-country-dialog`), so `บันทึก` would be absent from
   * a closed dialog for a reader *and* a writer alike and would not actually exercise the
   * gate. `เพิ่มประเทศ` (the add button) is checked directly instead, since it renders inline
   * in the card header rather than inside a dialog.
   */
  it('shows a reader the row but no edit, withdraw or add control', () => {
    const markup = renderToStaticMarkup(
      createElement(TaxCountriesSection, { state, editable: false, onChanged: noop }),
    );
    expect(markup).toContain('ไทย');
    expect(markup).not.toContain('แก้ไข');
    expect(markup).not.toContain('ปิดใช้งาน');
    expect(markup).not.toContain('เพิ่มประเทศ');
  });

  it('shows a write-permitted staff member the add, edit and withdraw controls', () => {
    const markup = renderToStaticMarkup(
      createElement(TaxCountriesSection, { state, editable: true, onChanged: noop }),
    );
    expect(markup).toContain('ไทย');
    expect(markup).toContain('แก้ไข');
    expect(markup).toContain('ปิดใช้งาน');
    expect(markup).toContain('เพิ่มประเทศ');
  });

  it('shows the history control to a reader too — GET .../changes only needs organisation.read', () => {
    const markup = renderToStaticMarkup(
      createElement(TaxCountriesSection, { state, editable: false, onChanged: noop }),
    );
    expect(markup).toContain('ประวัติ');
  });
});
