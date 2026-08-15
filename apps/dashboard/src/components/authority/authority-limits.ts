import { baht, bahtInput, readBaht } from '@/components/quotes/amounts';

import type {
  AuthorityDimension,
  AuthorityLimitChangeView,
  AuthorityLimitView,
} from './authority-limits-api';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ How much a role may give away without asking anybody — as a form, and as a history.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Everything here is pure, for the reason every `*-fields.ts` in `components/organisation`
 * gives: `apps/dashboard`'s vitest runs `environment: 'node'` with no DOM, so the rules that
 * decide what a number means and whether a form may be sent are provable without rendering,
 * and the component is left with nothing to get wrong but layout.
 *
 * ── ⚠️ THE DISTINCTION THIS WHOLE FILE EXISTS TO KEEP VISIBLE ────────────────────
 *
 *     no row at all      this role may not concede anything, and cannot approve anything
 *     a ceiling of ฿0    this role may record a concession and approve none of its own
 *     a withdrawn row    the first, again — with a name and a date attached to how it got there
 *
 * The schema comment on `authority_limits` says the difference between the first two "lives in
 * the error message, and it does". On a screen it lives in three different sentences, so an
 * empty box must never quietly become `0`: `readCeilingMinor('')` is `null`, not `0n`, and
 * `limitFormReady` refuses to send. A form that defaulted an empty ceiling to zero would grant
 * an authority nobody typed.
 */

/* ------------------------------------------------------------------ *
 * Labels
 * ------------------------------------------------------------------ */

/**
 * Identical wording to `components/quotes/authority-panel.tsx`, deliberately.
 *
 * The salesperson reads "ส่วนลด (เงินที่ลูกค้าจ่ายน้อยลง)" on the quote when their ceiling
 * refuses them; the administrator setting that ceiling has to be looking at the same words, or
 * the two screens are describing different features to two people who will talk to each other.
 */
export const DIMENSION_LABEL_TH: Readonly<Record<AuthorityDimension, string>> = {
  margin: 'ส่วนลด (เงินที่ลูกค้าจ่ายน้อยลง)',
  cashflow: 'กระแสเงินสด (เงินที่บริษัทได้รับน้อยลง)',
};

export const DIMENSION_HINT_TH: Readonly<Record<AuthorityDimension, string>> = {
  margin: 'นับรวมยอดบรรทัดที่ถูกลด ส่วนลดทั้งใบ ยอดรวมที่ถูกลด และบรรทัดค่าใช้จ่ายที่ติดลบ',
  /*
   * ⚠️ ตัดยอดค้างทิ้ง added by 0051's round. It draws on this same ceiling — `approvals`
   * pins `dimension: 'cashflow'` for a write-off with a CHECK — and it is the one thing
   * on this list that happens AFTER delivery rather than before production, which is why
   * the label above no longer says ก่อนเปิดผลิต.
   */
  cashflow: 'นับรวมการลดยอดมัดจำ การเลื่อนงวดที่ถือประตูเข้าสายการผลิต และการตัดยอดค้างทิ้ง',
};

export const dimensionOptions = (): readonly { value: AuthorityDimension; labelTh: string }[] => [
  { value: 'margin', labelTh: DIMENSION_LABEL_TH.margin },
  { value: 'cashflow', labelTh: DIMENSION_LABEL_TH.cashflow },
];

/** What a ceiling *means*, in one sentence, so the ฿0 row is not read as a mistake. */
export function ceilingMeaningTh(limit: AuthorityLimitView): string {
  if (limit.revokedAt !== null) {
    return 'ถูกยกเลิกแล้ว — บทบาทนี้ลดราคาเองไม่ได้ และอนุมัติให้ใครไม่ได้';
  }
  if (limit.maxConcessionThbMinor === 0n) {
    return 'บันทึกส่วนลดได้ แต่ต้องให้คนอื่นอนุมัติทุกครั้ง';
  }
  /*
   * ⚠️ Two sentences, because one ceiling now governs two different acts. On `margin` the
   * unit is a quotation. On `cashflow` it is also the largest ตัดยอดค้างทิ้ง this role may
   * approve, and a reader told only about ใบเสนอราคา would look at ฿50,000 here and have
   * no idea it is what let somebody forgive a debt.
   */
  if (limit.dimension === 'cashflow') {
    return `ลดได้เองถึง ${baht(limit.maxConcessionThbMinor)} ต่อหนึ่งใบเสนอราคา และอนุมัติตัดยอดค้างทิ้งได้ถึงยอดเดียวกัน`;
  }
  return `ลดได้เองถึง ${baht(limit.maxConcessionThbMinor)} ต่อหนึ่งใบเสนอราคา`;
}

/* ------------------------------------------------------------------ *
 * The form
 * ------------------------------------------------------------------ */

export interface LimitFields {
  readonly groupId: string;
  readonly dimension: AuthorityDimension;
  /** Baht, as typed. `''` is "not answered", never zero — see the header. */
  readonly ceilingBaht: string;
  readonly noteTh: string;
}

export interface LimitFormErrors {
  readonly groupId?: string;
  readonly ceilingBaht?: string;
  readonly noteTh?: string;
}

export const EMPTY_LIMIT_FIELDS: LimitFields = {
  groupId: '',
  dimension: 'margin',
  ceilingBaht: '',
  noteTh: '',
};

/** The form for an existing row — including a withdrawn one, which is how it is reinstated. */
export function fieldsFromLimit(limit: AuthorityLimitView): LimitFields {
  return {
    groupId: limit.groupId,
    dimension: limit.dimension,
    ceilingBaht: bahtInput(limit.maxConcessionThbMinor),
    noteTh: limit.noteTh ?? '',
  };
}

/**
 * Satang from the box, or `null` when it cannot be read.
 *
 * ⚠️ `''` is `null` and NOT `0n`. The two are different grants and the difference is the
 * header's whole point. `readBaht` already refuses a negative — `authority_limits_ceiling_nonnegative`
 * says the same thing at the database — and refuses `'1e3'`, `' '` and more than two decimals.
 */
export function readCeilingMinor(text: string): bigint | null {
  const parsed = readBaht(text);
  return parsed.ok ? parsed.value : null;
}

/**
 * What is wrong with the form **as it stands**, in Thai.
 *
 * A merely empty field is not an error — same rule as every other form in this dashboard: it
 * makes "required" a matter for `limitFormReady`, so a person is not shouted at for a box they
 * have not reached yet. What *is* an error is text that cannot be a ceiling.
 */
export function limitFormErrors(fields: LimitFields): LimitFormErrors {
  const errors: { groupId?: string; ceilingBaht?: string; noteTh?: string } = {};

  const typed = fields.ceilingBaht.trim();
  if (typed !== '') {
    const parsed = readBaht(typed);
    if (!parsed.ok) errors.ceilingBaht = parsed.reasonTh;
  }

  /* `setAuthorityLimitSchema` caps the note at 1000; refusing here saves a round trip. */
  if (fields.noteTh.trim().length > 1000) errors.noteTh = 'หมายเหตุยาวเกิน 1,000 ตัวอักษร';

  return errors;
}

/** Whether the form may be sent: every required answer present, and nothing malformed. */
export function limitFormReady(fields: LimitFields): boolean {
  if (fields.groupId.trim() === '') return false;
  if (fields.ceilingBaht.trim() === '') return false;
  if (Object.keys(limitFormErrors(fields)).length > 0) return false;
  return true;
}

/**
 * The request body. The **whole** editable shape, never a diff.
 *
 * ⚠️ `noteTh` is omitted rather than sent as `''`. `setAuthorityLimitSchema` is a
 * `z.strictObject` whose note is `.trim().min(1)`, so an empty string is a 422 and `undefined`
 * is "no note" — the API stores `null`. A form that sent `''` would refuse to save a ceiling
 * for the ordinary act of leaving the note blank.
 */
export function setLimitRequest(fields: LimitFields): {
  readonly groupId: string;
  readonly dimension: AuthorityDimension;
  readonly maxConcessionThbMinor: string;
  readonly noteTh?: string;
} {
  const minor = readCeilingMinor(fields.ceilingBaht);
  if (minor === null) throw new Error('setLimitRequest called on a form that is not ready');

  const note = fields.noteTh.trim();
  return {
    groupId: fields.groupId,
    dimension: fields.dimension,
    maxConcessionThbMinor: minor.toString(),
    ...(note === '' ? {} : { noteTh: note }),
  };
}

/* ------------------------------------------------------------------ *
 * The history
 * ------------------------------------------------------------------ */

const FIELD_ORDER = ['maxConcessionThbMinor', 'noteTh', 'isRevoked'] as const;

const FIELD_LABELS: Readonly<Record<(typeof FIELD_ORDER)[number], string>> = {
  maxConcessionThbMinor: 'เพดาน',
  noteTh: 'หมายเหตุ',
  isRevoked: 'สถานะ',
};

/**
 * ⚠️ Shaped exactly like `bank-account-changes.ts`'s `ChangedFieldView`, not imported from it.
 *
 * The two are structurally identical and the temptation to share is real. They are kept apart
 * because that interface lives in a *bank account* module: a `users`-folder component importing
 * it would make the bank-account history the de-facto owner of a shape three features depend
 * on, and the first change one of them needed would be a change to all three. The precedent is
 * `tax-country-fields.ts`, which does import it — and whose own header records that it is
 * reusing a bank account's type, which is the sentence this file declines to write a second
 * time.
 */
export interface ChangedFieldView {
  readonly key: string;
  readonly labelTh: string;
  readonly beforeText: string;
  readonly afterText: string;
}

function displayValue(
  key: (typeof FIELD_ORDER)[number],
  snapshot: { maxConcessionThbMinor: bigint; noteTh: string | null; isRevoked: boolean },
): string {
  if (key === 'maxConcessionThbMinor') return baht(snapshot.maxConcessionThbMinor);
  if (key === 'isRevoked') return snapshot.isRevoked ? 'ยกเลิกแล้ว' : 'ใช้งาน';
  return snapshot.noteTh ?? 'ไม่ระบุ';
}

const moved = (
  key: (typeof FIELD_ORDER)[number],
  before: AuthorityLimitChangeView['after'],
  after: AuthorityLimitChangeView['after'],
): boolean => {
  if (key === 'maxConcessionThbMinor') {
    return before.maxConcessionThbMinor !== after.maxConcessionThbMinor;
  }
  if (key === 'isRevoked') return before.isRevoked !== after.isRevoked;
  return (before.noteTh ?? null) !== (after.noteTh ?? null);
};

/** Whether this entry records the ceiling being granted for the first time, rather than moved. */
export const isGrant = (change: AuthorityLimitChangeView): boolean => change.before === null;

/**
 * A one-line title for a history entry, because "แก้ไข" is the least useful of the four things
 * that can appear here and a reader scanning a column wants the verb, not the noun.
 */
export function changeHeadlineTh(change: AuthorityLimitChangeView): string {
  if (change.before === null) return 'ให้อำนาจครั้งแรก';
  if (!change.before.isRevoked && change.after.isRevoked) return 'ยกเลิกอำนาจ';
  if (change.before.isRevoked && !change.after.isRevoked) return 'คืนอำนาจ';
  if (change.after.maxConcessionThbMinor > change.before.maxConcessionThbMinor) return 'ขยายเพดาน';
  if (change.after.maxConcessionThbMinor < change.before.maxConcessionThbMinor) return 'ลดเพดาน';
  return 'แก้ไขหมายเหตุ';
}

/**
 * The fields worth showing for one history entry.
 *
 * A grant (`before === null`) lists every recorded field at its starting value — there is
 * nothing to diff against. Anything else lists only what actually moved, in one fixed order
 * rather than `Object.keys`' arrival order, which would make the same field jump around the
 * screen from entry to entry.
 */
export function changedFields(change: AuthorityLimitChangeView): readonly ChangedFieldView[] {
  const { before, after } = change;

  const keys = before === null ? FIELD_ORDER : FIELD_ORDER.filter((key) => moved(key, before, after));

  return keys.map((key) => ({
    key,
    labelTh: FIELD_LABELS[key],
    beforeText: before === null ? '—' : displayValue(key, before),
    afterText: displayValue(key, after),
  }));
}
