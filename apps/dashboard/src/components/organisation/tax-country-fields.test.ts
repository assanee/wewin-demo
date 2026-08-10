import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TaxCountryWire } from '@wewin/contract/tax';

import {
  basisLabelTh,
  fieldsFromTaxCountry,
  isTaxCountryCreation,
  rateEditable,
  rateField,
  readRateBp,
  taxCountryChangedFields,
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
      nameTh: 'ไทย',
      ratePercent: '8',
      treatment: 'standard',
      pricesIncludeTax: false,
    });
    expect(request.rateBp).toBe(800);
  });
});

describe('taxCountryFormErrors and taxCountryFormReady', () => {
  const VALID = { nameTh: 'ไทย', ratePercent: '7', treatment: 'standard', pricesIncludeTax: false };

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

describe('fieldsFromTaxCountry — the dual of taxCountryPatchRequest', () => {
  it('reads a loaded row into editable fields', () => {
    const country: TaxCountryWire = {
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
    after: { code: 'TH', nameTh: 'ไทย', rateBp: 700, treatment: 'standard', pricesIncludeTax: false, isActive: true, sortOrder: 0 },
  };

  it('lists every recorded field for a creation, since there is nothing to diff against', () => {
    expect(isTaxCountryCreation(CREATE)).toBe(true);
    const fields = taxCountryChangedFields(CREATE);
    expect(fields.map((field) => field.key)).toEqual([
      'code',
      'nameTh',
      'tax',
      'pricesIncludeTax',
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
});

describe('TaxCountriesSection — the permission gate', () => {
  const THAILAND: TaxCountryWire = {
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
   * (Save) — this section has no create flow (see `tax-countries.tsx`'s header) and its Save
   * button lives inside a dialog that only mounts once a click opens it, so `บันทึก` would be
   * absent from a closed dialog either way and would not actually exercise the gate.
   */
  it('shows a reader the row but no edit control', () => {
    const markup = renderToStaticMarkup(
      createElement(TaxCountriesSection, { state, editable: false, onChanged: noop }),
    );
    expect(markup).toContain('ไทย');
    expect(markup).not.toContain('แก้ไข');
    expect(markup).not.toContain('ปิดใช้งาน');
  });

  it('shows a write-permitted staff member the edit and withdraw controls', () => {
    const markup = renderToStaticMarkup(
      createElement(TaxCountriesSection, { state, editable: true, onChanged: noop }),
    );
    expect(markup).toContain('ไทย');
    expect(markup).toContain('แก้ไข');
    expect(markup).toContain('ปิดใช้งาน');
  });

  it('shows the history control to a reader too — GET .../changes only needs organisation.read', () => {
    const markup = renderToStaticMarkup(
      createElement(TaxCountriesSection, { state, editable: false, onChanged: noop }),
    );
    expect(markup).toContain('ประวัติ');
  });
});
