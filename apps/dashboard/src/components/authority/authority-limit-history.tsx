'use client';

import { useCallback } from 'react';

import {
  SettingsHistoryDialog,
  type HistoryEntryView,
} from '@/components/history/settings-history-dialog';

import {
  listAuthorityLimitChanges,
  type AuthorityLimitChangeView,
  type AuthorityLimitSnapshot,
  type AuthorityLimitView,
} from './authority-limits-api';
import { DIMENSION_LABEL_TH, changeHeadlineTh, changedFields, isGrant } from './authority-limits';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ Who moved this ceiling, from what, and when — the control, not a decoration.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The attack this answers is the one `bank_account_changes` answers in its own shape: widen an
 * authority for one deal and narrow it back afterwards. Nothing else in the system would show it.
 * `approvals.decided_ceiling_thb_minor` pins what the ceiling *was* at the moment somebody
 * approved, which is a different and narrower fact — it says the decision was within authority, and
 * says nothing about the authority having been granted an hour earlier for that decision.
 *
 * So `changedFields` renders a labelled before → after per entry rather than a `<pre>` of JSON, and
 * `changeHeadlineTh` names the verb (ให้อำนาจครั้งแรก / ขยายเพดาน / ลดเพดาน / ยกเลิกอำนาจ /
 * คืนอำนาจ / แก้ไขหมายเหตุ) because a column of "แก้ไข" is the least useful thing a reader scanning
 * for a widening could be shown. Both readers are untouched; only the shell around them moved into
 * `SettingsHistoryDialog`. It is also the reason the shared component takes a `headlineTh` **string**
 * rather than deriving one from `isOrigin`: three of the four logs have a two-way headline and this
 * one has six, so the verb is the caller's to name.
 *
 * ⚠️ **The actor is a bare user id, not a name.** `GET …/changes` answers with `changedByUserId`
 * straight off the row; there is no join to `users` on this endpoint. The reading truncates it and
 * the record layer prints it in full — resolving it to a name is a real feature with its own review,
 * not a side effect of this dialog. Identical position to `bank-account-history.tsx`.
 *
 * ⚠️ **`changedByUserId` is never null here**, unlike the three settings-history tables. Their actor
 * column is nullable and erasure scrubs it; `authority_limit_changes.changed_by_user_id` is NOT NULL
 * and declared `keep` — a history of who may concede money whose actor can be nulled is a weaker
 * record than the ceiling row it describes.
 *
 *   ⚠️ **What sharing cost here, stated rather than hidden:** `HistoryEntryView.changedByUserId` is
 *   `string | null`, so the shared component carries a `ระบบ` branch this dialog's data can never
 *   reach. That widening is accepted because the guarantee lives at the database and in
 *   `AuthorityLimitChangeView`'s own `string`, not in what a renderer branches on — a screen that
 *   could not print `ระบบ` was never what made the column NOT NULL. Nothing is lost from the record:
 *   the id is printed in full either way.
 */
export function AuthorityLimitHistoryDialog({
  limit,
  onClose,
}: {
  readonly limit: AuthorityLimitView;
  readonly onClose: () => void;
}) {
  const load = useCallback(
    () => listAuthorityLimitChanges(limit.groupId, limit.dimension),
    [limit.groupId, limit.dimension],
  );

  return (
    <SettingsHistoryDialog
      headingTh={`ประวัติเพดานอำนาจ — ${limit.groupNameTh}`}
      subjectTh={`${DIMENSION_LABEL_TH[limit.dimension]} · ${limit.groupCode}`}
      emptyTh="ยังไม่มีประวัติของเพดานนี้"
      load={load}
      toEntry={toEntry}
      onClose={onClose}
    />
  );
}

/**
 * ⚠️⚠️⭐ **THE ONE PLACE IN THIS FAMILY WHERE THE RECORD LAYER MEETS A `bigint`.**
 *
 * The other three logs hand the record layer `Record<string, unknown>` decoded straight off jsonb,
 * so every leaf is a JSON primitive. This one does not: `AuthorityLimitSnapshot` is a *typed*
 * snapshot and `maxConcessionThbMinor` is a **`bigint`** — widened by `minorOf` on purpose, because
 * a ceiling is compared against a concession and both can exceed 2^53 in satang.
 *
 * `JSON.stringify` **throws a `TypeError` on a `bigint`**, it does not fall back. So a record layer
 * that reached for it would blank this dialog and only this dialog — the one of the four whose
 * subject is who may give away money — while passing every test and every screenshot of the other
 * three. `recordValueText` branches on `bigint` first for exactly that reason; see its header.
 *
 * ⚠️ **Spread, never three hand-listed keys.** `{ ...snapshot }` carries whatever
 * `AuthorityService.snapshot` records, so a fourth field added server-side appears in the record
 * layer by itself. A hand-written `{ maxConcessionThbMinor, noteTh, isRevoked }` would silently drop
 * it — on an audit surface whose whole value is that it is complete, which is the same failure
 * `recordLines`' union-of-keys rule exists to prevent one level down.
 */
const asSnapshot = (snapshot: AuthorityLimitSnapshot): Readonly<Record<string, unknown>> => ({
  ...snapshot,
});

const toEntry = (change: AuthorityLimitChangeView): HistoryEntryView => ({
  id: change.id,
  changedAt: change.changedAt,
  changedByUserId: change.changedByUserId,
  headlineTh: changeHeadlineTh(change),
  isOrigin: isGrant(change),
  fields: changedFields(change),
  before: change.before === null ? null : asSnapshot(change.before),
  after: asSnapshot(change.after),
});
