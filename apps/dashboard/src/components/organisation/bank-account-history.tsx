'use client';

import { useCallback } from 'react';
import type { BankAccountChangeWire, BankAccountWire } from '@wewin/contract/organisation';

import {
  SettingsHistoryDialog,
  type HistoryEntryView,
} from '@/components/history/settings-history-dialog';

import { changedFields, isCreation } from './bank-account-changes';
import { listBankAccountChanges } from './organisation-api';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ The change history — the fraud control, not a decoration on this screen.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `bank_account_changes`' own header names the attack this exists to catch: change the receiving
 * account number, wait for one transfer, change it back. A person auditing that has to be able to
 * see the two numbers side by side, who moved them, and when — so `changedFields` renders a labelled
 * before → after per row rather than the `<pre>` of raw JSON `users/audit-trail.tsx` accepts for its
 * own, much lower-stakes payload. That reader is untouched; only the shell around it moved into
 * `SettingsHistoryDialog`.
 *
 * ⚠️⭐ **This is the log that decided the fold question against folding.** Detecting "changed it and
 * changed it back" is a comparison between the *current* value and the *original* one, and the
 * original is entry one — the head of the chain. `hiddenCount` on the order spine folds exactly
 * there. A fold that hid the head of this log would remove the comparison the table exists to
 * support, so it is not offered; the full argument, with the measured depths, is in
 * `settings-history-dialog.tsx`.
 *
 * ⚠️ **The actor is a bare user id, not a name.** `OrganisationController.changes` answers with
 * `BankAccountChangeWire.changedByUserId` straight from the row — there is no join to `users` on
 * this endpoint, unlike `audit-trail.tsx`'s `actorName`. The reading truncates it and the record
 * layer prints it in full; neither pretends to resolve it, which is the honest rendering of what
 * this endpoint actually knows. Resolving it to a name is a real feature with its own review, not a
 * side effect of this screen.
 */
export function BankAccountHistoryDialog({
  account,
  onClose,
}: {
  readonly account: BankAccountWire;
  readonly onClose: () => void;
}) {
  const load = useCallback(() => listBankAccountChanges(account.id), [account.id]);

  return (
    <SettingsHistoryDialog
      headingTh={`ประวัติการแก้ไข — ${account.accountName}`}
      subjectTh={`${account.bankCode} · ${account.accountNumber}`}
      emptyTh="ยังไม่มีประวัติการแก้ไขของบัญชีนี้"
      load={load}
      toEntry={toEntry}
      onClose={onClose}
    />
  );
}

const toEntry = (change: BankAccountChangeWire): HistoryEntryView => {
  const creation = isCreation(change);

  return {
    id: change.id,
    changedAt: change.changedAt,
    changedByUserId: change.changedByUserId,
    headlineTh: creation ? 'สร้างบัญชี' : 'แก้ไขบัญชี',
    isOrigin: creation,
    fields: changedFields(change),
    before: change.before,
    after: change.after,
  };
};
