import { describe, expect, it } from 'vitest';
import type { TaxDocumentSettingsWire } from '@wewin/contract/forfeit';

import {
  TAX_ROW_ORDER,
  editableTaxRows,
  mutedTaxRows,
  taxSettingsRefused,
  type TaxRowKey,
} from './tax-document-rows';

/**
 * ⭐ The one thing this file exists to prove: a company that has just installed the system can
 * actually turn tax documents on.
 *
 * That sounds too obvious to test, and it shipped broken. The API refuses “on with no moment
 * chosen”; the screen greyed the moments out until it was on. Each rule read as careful on its
 * own, and together they were a door locked from both sides. It took opening the screen in a
 * browser to find, because vitest here is `environment: 'node'` and never renders a `.tsx`.
 */

const allOff = (): TaxDocumentSettingsWire => ({
  enabled: false,
  onInstalment: false,
  onDelivery: false,
  combinedReceipt: false,
  invoiceOnDemand: false,
  abbreviatedAllowed: false,
});

/** One click on one row, the way the screen sends it: the whole object, one field flipped. */
const toggle = (
  settings: TaxDocumentSettingsWire,
  row: TaxRowKey,
): TaxDocumentSettingsWire => ({ ...settings, [row]: !settings[row] });

describe('turning tax documents on at all', () => {
  it('⭐ the shipped default is off, and the API accepts it', () => {
    /* Off is a legitimate resting state — most of these companies will never turn it on. */
    expect(taxSettingsRefused(allOff())).toBe(false);
  });

  it('⛔ the API refuses เปิดใช้งาน with no moment chosen — the rule that closed the door', () => {
    expect(taxSettingsRefused({ ...allOff(), enabled: true })).toBe(true);
    expect(taxSettingsRefused({ ...allOff(), enabled: true, onInstalment: true })).toBe(false);
    expect(taxSettingsRefused({ ...allOff(), enabled: true, onDelivery: true })).toBe(false);
  });

  it('⭐ from all-off there is a path to on, using only rows a person may click', () => {
    /*
     * The regression guard. Walk the exact sequence somebody performs — choose a moment, then
     * flip the master — and demand at every step that the row was clickable and the result was
     * something the API accepts. Lock the moments behind `enabled` and this fails at step one.
     */
    let settings = allOff();

    for (const row of ['onInstalment', 'enabled'] as const) {
      expect(editableTaxRows(settings), `${row} must be clickable`).toContain(row);
      settings = toggle(settings, row);
      expect(taxSettingsRefused(settings), `${row} produced a refused shape`).toBe(false);
    }

    expect(settings.enabled).toBe(true);
  });

  it('⛔ no ordering of clicks can strand somebody in a state with nothing left to click', () => {
    /*
     * Stronger than the happy path: from every reachable combination there must be at least one
     * editable row. A screen where every row is locked is a screen somebody has to escape by
     * telephoning us.
     */
    const seen = new Set<string>();
    const queue: TaxDocumentSettingsWire[] = [allOff()];

    while (queue.length > 0) {
      const settings = queue.pop() as TaxDocumentSettingsWire;
      const key = TAX_ROW_ORDER.map((row) => (settings[row] ? '1' : '0')).join('');
      if (seen.has(key)) continue;
      seen.add(key);

      const clickable = editableTaxRows(settings);
      expect(clickable.length, `nothing left to click at ${key}`).toBeGreaterThan(0);

      for (const row of clickable) {
        const next = toggle(settings, row);
        /* Only shapes the API accepts are reachable; a refused one is never saved. */
        if (!taxSettingsRefused(next)) queue.push(next);
      }
    }

    /*
     * Six switches make 64 combinations; the API refuses the eight where เปิดใช้งาน stands alone
     * with no moment. Every one of the remaining 56 is reachable by clicking.
     */
    expect(seen.size).toBe(56);
  });
});

describe('what muted says', () => {
  it('⭐ while the master is off, the rest read as not-yet-in-force', () => {
    expect(mutedTaxRows(allOff())).toStrictEqual([
      'onInstalment',
      'onDelivery',
      'combinedReceipt',
      'invoiceOnDemand',
      'abbreviatedAllowed',
    ]);
  });

  it('⚠️ muted is never the master itself — it is the row that lifts the muting', () => {
    expect(mutedTaxRows(allOff())).not.toContain('enabled');
  });

  it('⭐ once it is on, nothing is muted', () => {
    expect(mutedTaxRows({ ...allOff(), enabled: true, onInstalment: true })).toStrictEqual([]);
  });

  it('⚠️ muted and unclickable are different words — everything stays clickable', () => {
    /* The defect in one line: if this ever becomes a subset relationship, the door locks again. */
    for (const settings of [allOff(), { ...allOff(), enabled: true, onDelivery: true }]) {
      for (const row of mutedTaxRows(settings)) {
        expect(editableTaxRows(settings)).toContain(row);
      }
    }
  });
});
