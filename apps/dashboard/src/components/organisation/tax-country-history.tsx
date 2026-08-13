'use client';

import { useCallback } from 'react';
import type { TaxCountryWire } from '@wewin/contract/tax';

import {
  SettingsHistoryDialog,
  type HistoryEntryView,
} from '@/components/history/settings-history-dialog';

import { listTaxCountryChanges, type TaxCountryChangeRow } from './organisation-api';
import { isTaxCountryCreation, taxCountryChangedFields } from './tax-country-fields';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The change history for one destination — `SettingsHistoryDialog`, adapted.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The reading is unchanged: a labelled before → after per changed field, in Thai, oldest-first in
 * **the API's own ordering** (nothing here sorts — see the ordering note in
 * `settings-history-dialog.tsx`), actor by bare user id because nothing joins `users`, and
 * everything shown for a creation. What this file no longer holds is the twenty lines of dialog,
 * loading, failure, empty and rail that were identical to three other files.
 *
 * `taxCountryChangedFields` is where the one shape difference from the other three readers lives:
 * `rateBp` and `treatment` print as a single `ภาษี` row, not two, because the CHECK that ties them
 * together means an edit that moves one very often moves both. That reader is untouched.
 *
 * ⚠️ This is the deepest history in the dev database — 12 entries on `SG`, against 6, 5 and 3 for
 * the other three subjects — and it is the one that settled the question of whether to fold. See
 * "The fold" in `settings-history-dialog.tsx`: it is not folded, and the reason is that both ends of
 * a settings chain are load-bearing. `SG`'s entries are also what the elapsed-time label was
 * checked against here: `1 วัน 8 ชม.` between the first two, then three clusters of edits minutes
 * apart, which is precisely the pair of facts the label exists to separate.
 */
export function TaxCountryHistoryDialog({
  country,
  onClose,
}: {
  readonly country: TaxCountryWire;
  readonly onClose: () => void;
}) {
  const load = useCallback(() => listTaxCountryChanges(country.code), [country.code]);

  return (
    <SettingsHistoryDialog
      headingTh={`ประวัติการแก้ไข — ${country.nameTh}`}
      subjectTh={`รหัสประเทศ ${country.code}`}
      emptyTh="ยังไม่มีประวัติการแก้ไขของประเทศนี้"
      load={load}
      toEntry={toEntry}
      onClose={onClose}
    />
  );
}

const toEntry = (change: TaxCountryChangeRow): HistoryEntryView => {
  const creation = isTaxCountryCreation(change);

  return {
    id: change.id,
    changedAt: change.changedAt,
    changedByUserId: change.changedByUserId,
    headlineTh: creation ? 'เพิ่มประเทศ' : 'แก้ไขข้อมูลภาษี',
    isOrigin: creation,
    fields: taxCountryChangedFields(change),
    before: change.before,
    after: change.after,
  };
};
