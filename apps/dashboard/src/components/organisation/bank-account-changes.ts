import type { BankAccountChangeWire } from '@wewin/contract/organisation';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ The fraud control, made readable.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `bank_account_changes` exists — its own header says so — because changing the receiving
 * account number and changing it back around a single transfer is the textbook version of
 * this fraud, and `updated_by_user_id` on the account alone answers "who touched this last"
 * and nothing about what it looked like before. A person auditing a changed account number
 * needs the two numbers side by side, and *who*, and *when* — not a `<pre>` of the JSON the
 * API happens to send.
 *
 * `organisation.service.ts`'s `RECORDED` names the five fields the history actually snapshots
 * — `bankCode`, `accountNumber`, `accountName`, `promptpayId`, `isActive` — every one of them,
 * on every write, whether that field moved or not. `changedFields` below is the read-time half
 * of that: a create shows every recorded field as its starting value, and an edit shows only
 * the ones that actually moved, in one fixed order rather than the arrival order of
 * `Object.keys`, which would make the same field jump around the screen from row to row.
 */

const FIELD_ORDER = ['bankCode', 'accountNumber', 'accountName', 'promptpayId', 'isActive'] as const;

const FIELD_LABELS: Readonly<Record<(typeof FIELD_ORDER)[number], string>> = {
  bankCode: 'ธนาคาร',
  accountNumber: 'เลขบัญชี',
  accountName: 'ชื่อบัญชี',
  promptpayId: 'พร้อมเพย์',
  isActive: 'สถานะ',
};

function displayValue(key: (typeof FIELD_ORDER)[number], value: unknown): string {
  if (key === 'isActive') return value === true ? 'ใช้งาน' : 'ปิดใช้งาน';
  if (value === null || value === undefined) return key === 'promptpayId' ? 'ไม่ระบุ' : '—';
  return typeof value === 'string' ? value : String(value);
}

/** Same value, treating an absent key and an explicit `null` as the one thing they both mean. */
const sameValue = (a: unknown, b: unknown): boolean => (a ?? null) === (b ?? null);

export interface ChangedFieldView {
  readonly key: string;
  readonly labelTh: string;
  readonly beforeText: string;
  readonly afterText: string;
}

/** Whether this row records the account coming into existence, rather than an edit to it. */
export const isCreation = (change: BankAccountChangeWire): boolean => change.before === null;

/**
 * The fields worth showing for one history row.
 *
 * A creation (`before === null`) lists every recorded field at its initial value — there is
 * nothing to diff against. An edit lists only the fields whose value actually moved, because
 * `snapshot()` on the server writes all five on every write, and an unfiltered view would
 * repeat four unchanged fields beside the one a person actually came here to see.
 */
export function changedFields(change: BankAccountChangeWire): readonly ChangedFieldView[] {
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
