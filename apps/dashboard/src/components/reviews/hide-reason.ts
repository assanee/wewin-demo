/**
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A REVIEW WAS HIDDEN — plan 9.3: hiding costs a reason and a name.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The name is the caller's and never travels: it comes from the session, because *"a
 * moderator naming somebody else is the failure the whole recorded-person requirement exists
 * to stop."* So the only thing this screen supplies is the reason, plus the one rule that
 * hangs off it.
 *
 * ⚠️ **`other` is not a loophole.** `hideReviewRequestSchema` refines it and
 * `reviews_hidden_other_needs_a_note` refuses it again in Postgres. Enforcing it here too is
 * not belt-and-braces: it is the difference between a moderator being asked for an
 * explanation *while deciding* and being shown a 422 after they have already moved on.
 *
 * ⚠️ And the note is `null`, never `''`. `optionalProse` is null-shaped; an empty string is a
 * note that says nothing, stored against a hidden review and indistinguishable later from a
 * moderator who explained themselves and was ignored.
 */

export const HIDDEN_REASONS = ['abusive', 'personal_data', 'off_topic', 'spam', 'other'] as const;

export type HiddenReason = (typeof HIDDEN_REASONS)[number];

const REASON_TH: Record<HiddenReason, string> = {
  abusive: 'ใช้ถ้อยคำรุนแรง',
  personal_data: 'มีข้อมูลส่วนบุคคล',
  off_topic: 'ไม่เกี่ยวกับสินค้า',
  spam: 'สแปมหรือโฆษณา',
  other: 'อื่นๆ',
};

export function reasonLabel(reason: HiddenReason): string {
  return REASON_TH[reason] ?? reason;
}

/** ⭐ `other` demands a note. The other four do not, and may still carry one. */
export function hideIsReady(reason: HiddenReason, noteTh: string): boolean {
  return reason !== 'other' || noteTh.trim() !== '';
}

export function hideBody(
  reason: HiddenReason,
  noteTh: string,
): { readonly reason: HiddenReason; readonly noteTh: string | null } {
  const written = noteTh.trim();

  return { reason, noteTh: written === '' ? null : written };
}
