import type { TaxDocumentSettingsWire } from '@wewin/contract/forfeit';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * เอกสารภาษี — which switches a person may still touch, and which the API refuses.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠️ This module exists because of a defect that shipped and could not have been caught by any
 * test in this repository: the API refuses “เปิดใช้งาน by itself, with no moment chosen”, and the
 * screen greyed the moments out until เปิดใช้งาน was on. Both rules are individually correct and
 * together they are a locked door — the master switch could never be turned on at all.
 *
 * vitest runs `environment: 'node'` here, so no `.tsx` is ever rendered and a disabled attribute
 * is invisible to the suite. The rule therefore lives in a `.ts` file where it can be asserted,
 * and the component asks this module rather than deciding for itself.
 */

export type TaxRowKey = keyof TaxDocumentSettingsWire;

export const TAX_ROW_ORDER: readonly TaxRowKey[] = [
  'enabled',
  'onInstalment',
  'onDelivery',
  'combinedReceipt',
  'invoiceOnDemand',
  'abbreviatedAllowed',
];

/**
 * What the API refuses — restated here only to say it before the round trip.
 *
 * ⚠️ A mirror, never the authority: `tax-document-settings.service.ts` refuses the same shape,
 * and that refusal is what protects the data. This one protects the person's afternoon.
 */
export const taxSettingsRefused = (settings: TaxDocumentSettingsWire): boolean =>
  settings.enabled && !settings.onInstalment && !settings.onDelivery;

/**
 * Every switch is editable, always.
 *
 * ⚠️ The moments are settings, not actions: choosing “ออกทุกครั้งที่รับเงิน” while the master is
 * off issues nothing, it records an intention. Nothing is gained by locking them and — as the
 * defect above proves — a way out of the starting state is lost.
 */
export const editableTaxRows = (settings: TaxDocumentSettingsWire): readonly TaxRowKey[] => {
  /* Taken and deliberately unused: the answer is "all of them" whatever is currently set, and a
   * signature that says so is the one a future change would have to argue with. */
  void settings;
  return TAX_ROW_ORDER;
};

/**
 * Which rows read as not-yet-in-force: shown in the muted colour, still clickable.
 *
 * ⚠️ Muted is a sentence about consequence, not about permission. Conflating the two is the
 * whole bug.
 */
export const mutedTaxRows = (settings: TaxDocumentSettingsWire): readonly TaxRowKey[] =>
  settings.enabled ? [] : TAX_ROW_ORDER.filter((row) => row !== 'enabled');
