/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ The user screen's one primary statement: who can still get in.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `/users` opened with a `text-2xl` title, an unclassed description (16px — larger than every
 * piece of body copy below it) and then went straight into a tab strip. Nothing on it answered
 * the question the screen exists for, which is not *who works here* — the table already lists
 * them — but **what the state of access is**: how many accounts can sign in, and how many have
 * had that taken away. A suspension is the only fact on this screen that somebody might need to
 * act on, and it was a badge in the third column of row nineteen.
 *
 * No React here, for the reason the rest of this codebase gives: `apps/dashboard`'s vitest is
 * `environment: 'node'`, so a `.test.tsx` is **silently never collected** and a sentence built
 * inside a component is a sentence with no test.
 *
 * ── ⚠️ Why "active" is compared against the status and not against a flag ────
 *
 * `users.status` has four values and only one of them can sign in. `closed` and `erased` are not
 * milder forms of `suspended`, they are terminal and nothing in this dashboard can undo either
 * (see `user-admin.tsx` on why there is no delete button) — so they are counted as blocked but
 * **named separately** in the detail line. Folding all three into "ถูกระงับ" would tell an
 * administrator to go and reinstate an account that no button here can reinstate.
 */

/** The four states an account can be in. Mirrors `UserSummary['status']` on the wire. */
export type AccessStatus = 'active' | 'suspended' | 'closed' | 'erased';

/**
 * One vocabulary for the four statuses, used by the badge in the table and by the sentence at
 * the top — so the two cannot drift into two names for the same state.
 */
export const STATUS_LABEL_TH: Readonly<Record<AccessStatus, string>> = {
  active: 'ใช้งานอยู่',
  suspended: 'ถูกระงับ',
  closed: 'ปิดบัญชีแล้ว',
  erased: 'ลบข้อมูลแล้ว',
};

/**
 * ⚠️ The order the detail line names them in, and it is severity of *recourse* rather than of
 * consequence: a suspension is reversible from this very screen, a closure is not, and an
 * erasure is a right somebody exercised. Listing them by count would reorder the sentence every
 * time somebody was suspended, which makes a line people are supposed to skim unreadable.
 */
const BLOCKED_ORDER: readonly AccessStatus[] = ['suspended', 'closed', 'erased'];

/** Just enough of a user to count. `UserSummary` structurally satisfies this. */
export interface CountedUser {
  readonly status: AccessStatus;
}

export interface AccessFocus {
  readonly total: number;
  /** Accounts that can sign in right now. */
  readonly active: number;
  /** Everything else — suspended, closed or erased. */
  readonly blocked: number;
  /** The `type-focal` line. */
  readonly headlineTh: string;
  /** The caption under it. `null` when the headline is already the whole answer. */
  readonly detailTh: string | null;
}

export function accessFocus(users: readonly CountedUser[]): AccessFocus {
  const total = users.length;
  const active = users.filter((user) => user.status === 'active').length;
  const blocked = total - active;

  if (total === 0) {
    /* A real state on a fresh install, and one the tab strip's "ผู้ใช้ (0)" states far too quietly. */
    return { total, active, blocked, headlineTh: 'ยังไม่มีบัญชีผู้ใช้ในระบบ', detailTh: null };
  }

  if (blocked === 0) {
    return {
      total,
      active,
      blocked,
      headlineTh: `${total} บัญชี เข้าระบบได้ทั้งหมด`,
      /* Nothing is withheld, so there is no breakdown to give — the headline is the answer. */
      detailTh: null,
    };
  }

  return {
    total,
    active,
    blocked,
    headlineTh: `${active} บัญชีเข้าระบบได้ จาก ${total}`,
    /*
     * Named rather than left as a subtraction. "3 of 15 cannot sign in" still leaves the reader
     * scanning fifteen rows to learn which kind of cannot — and the kind is what decides whether
     * there is anything to do about it.
     */
    detailTh: BLOCKED_ORDER.map((status) => ({
      status,
      count: users.filter((user) => user.status === status).length,
    }))
      .filter((entry) => entry.count > 0)
      .map((entry) => `${STATUS_LABEL_TH[entry.status]} ${entry.count}`)
      .join(' · '),
  };
}
