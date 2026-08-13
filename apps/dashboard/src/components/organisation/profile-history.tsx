'use client';

import { useCallback } from 'react';

import {
  SettingsHistoryDialog,
  type HistoryEntryView,
} from '@/components/history/settings-history-dialog';

import { listProfileChanges, type ProfileChangeRow } from './organisation-api';
import { isProfileCreation, profileChangedFields } from './profile-changes';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The change history for the company profile — `SettingsHistoryDialog`, and simpler by one thing
 * than the other three: the profile is a singleton, so there is no row to pick first. Opening this
 * dialog needs nothing but a place to put it.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `deposit_bp` is why this exists, not letterhead: it is the `cashflow` floor — the number that
 * decides what counts as a concession needing approval — and until this screen the only way to
 * answer "who lowered it, and when" was a psql prompt. `profileChangedFields` renders it as the
 * percentage every other surface in this app shows, never the raw basis points; see that module's
 * own header for the codec it reuses to do that. The reader is untouched.
 *
 * ⚠️ The `load` callback takes **no dependency**, because the subject cannot change: there is one
 * profile. Everywhere else in this family the dep list is what identifies the subject, and here the
 * empty array is that same statement rather than an omission.
 *
 * The actor is a bare user id, not a name, for the same reason `bank-account-history.tsx` prints
 * one: `OrganisationController.profileChanges` answers straight from the row, with no join to
 * `users`.
 */
export function ProfileHistoryDialog({ onClose }: { readonly onClose: () => void }) {
  const load = useCallback(() => listProfileChanges(), []);

  return (
    <SettingsHistoryDialog
      headingTh="ประวัติการแก้ไข — ข้อมูลบริษัท"
      subjectTh="ข้อมูลบริษัท"
      emptyTh="ยังไม่มีประวัติการแก้ไขข้อมูลบริษัท"
      load={load}
      toEntry={toEntry}
      onClose={onClose}
    />
  );
}

/**
 * ⚠️ `isProfileCreation` is expected to answer `false` for every row this endpoint can return —
 * `organisation_profile` is a singleton seeded directly by migration `0029_tax_countries.sql`, never
 * through `putProfile` — and the branch is kept anyway, for the reason `profile-changes.ts`'s header
 * gives: `SettingChangeWire.before` is typed nullable, and a reader that assumed non-null would be
 * trusting a fact the wire type does not promise. Consequence for the rail: the origin ring is a
 * shape this particular dialog is not expected to draw, and that is a fact about the data rather
 * than a reason to drop the shape.
 */
const toEntry = (change: ProfileChangeRow): HistoryEntryView => {
  const creation = isProfileCreation(change);

  return {
    id: change.id,
    changedAt: change.changedAt,
    changedByUserId: change.changedByUserId,
    headlineTh: creation ? 'สร้างข้อมูลบริษัท' : 'แก้ไขข้อมูลบริษัท',
    isOrigin: creation,
    fields: profileChangedFields(change),
    before: change.before,
    after: change.after,
  };
};
