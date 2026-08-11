import { rateField } from './tax-country-fields';
import type { ChangedFieldView } from './bank-account-changes';
import type { ProfileChangeRow } from './organisation-api';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The company-profile diff — the third reader of the shape `bank-account-changes.ts` set.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `organisation.service.ts`'s `PROFILE_RECORDED` names the eight fields the history actually
 * snapshots — `legalNameTh`, `legalNameEn`, `addressTh`, `addressEn`, `taxId`, `phone`,
 * `email`, `depositBp` — on every `PUT`, whether a field moved or not. `profileChangedFields`
 * below is the read-time half of that, in the same fixed order rather than `Object.keys`
 * arrival order, and (an edit only) filtered to the fields that actually moved — the same two
 * rules `changedFields` and `taxCountryChangedFields` already follow for their own logs.
 *
 * ⚠️ **`depositBp` is stored in basis points; every other surface in this app shows it as a
 * percentage.** `profile-form.ts`'s `fieldsFromProfile` and `tax-country-fields.ts`'s own
 * `rateField` already carry that codec — `rateField(10_000)` is `'100'`,
 * `rateField(3_000)` is `'30'` — and `profile-form.ts` imports `rateField` from
 * `tax-country-fields.ts` for exactly that reason: one basis-point-to-percentage codec, not a
 * second written for the deposit form and a third for this history. Reusing it here rather than
 * printing the raw integer is the one thing this module exists to get right: a row that read
 * "10000 → 3000" would be a history nobody could reconcile with what the form itself shows.
 *
 * ⚠️ **A "creation" row is structurally possible but not, today, reachable.** `before === null`
 * mirrors `isCreation`/`isTaxCountryCreation`'s own check, kept here for the same reason those
 * two keep it — `SettingChangeWire.before` is typed nullable, and a reader that assumed
 * non-null would be trusting a fact the wire type does not promise. In practice `organisation_
 * profile` is a singleton seeded once, directly, by migration `0029_tax_countries.sql`, never
 * through `OrganisationService.putProfile` — so every row `profileChanges()` can ever return has
 * a real `before` snapshot, and `isProfileCreation` is expected to answer `false` for all of
 * them. See `profile-history.tsx`'s own note on what that means for the empty-history state.
 */

const FIELD_ORDER = [
  'legalNameTh',
  'legalNameEn',
  'addressTh',
  'addressEn',
  'taxId',
  'phone',
  'email',
  'depositBp',
] as const;

const FIELD_LABELS: Readonly<Record<(typeof FIELD_ORDER)[number], string>> = {
  legalNameTh: 'ชื่อบริษัท (ไทย)',
  legalNameEn: 'ชื่อบริษัท (อังกฤษ)',
  addressTh: 'ที่อยู่ (ไทย)',
  addressEn: 'ที่อยู่ (อังกฤษ)',
  taxId: 'เลขผู้เสียภาษี',
  phone: 'เบอร์โทร',
  email: 'อีเมล',
  depositBp: 'เงินมัดจำ (%)',
};

function displayValue(key: (typeof FIELD_ORDER)[number], value: unknown): string {
  if (key === 'depositBp') return `${rateField(typeof value === 'number' ? value : 0)}%`;
  if (value === null || value === undefined) return '—';
  return typeof value === 'string' ? value : String(value);
}

/** Same value, treating an absent key and an explicit `null` as the one thing they both mean. */
const sameValue = (a: unknown, b: unknown): boolean => (a ?? null) === (b ?? null);

/** Whether this row records the profile coming into existence, rather than an edit to it. */
export const isProfileCreation = (change: ProfileChangeRow): boolean => change.before === null;

/**
 * The fields worth showing for one history row.
 *
 * A creation (`before === null`) lists every recorded field at its initial value — there is
 * nothing to diff against. An edit lists only the fields whose value actually moved, because
 * `snapshot()`'s server-side equivalent for this row (`snapshotProfile`) writes all eight on
 * every write, and an unfiltered view would repeat seven unchanged fields beside the one a
 * person actually came here to see.
 */
export function profileChangedFields(change: ProfileChangeRow): readonly ChangedFieldView[] {
  const { before, after } = change;

  const keys =
    before === null ? FIELD_ORDER : FIELD_ORDER.filter((key) => !sameValue(before[key], after[key]));

  return keys.map((key) => ({
    key,
    labelTh: FIELD_LABELS[key],
    beforeText: before === null ? '—' : displayValue(key, before[key]),
    afterText: displayValue(key, after[key]),
  }));
}
