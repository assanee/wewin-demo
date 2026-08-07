/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ TURNING PROTECTION DOWN COSTS A PASSWORD. TURNING IT UP DOES NOT.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Every action here is taken by somebody already signed in, so "are you who you say you are"
 * has been answered once. The narrower question this table answers is: **is this something
 * somebody who found an unlocked laptop would want to do?**
 *
 * Plan 6.4 makes the same call for passwords — *"เปลี่ยนรหัสผ่านตัวเอง ต้องกรอกรหัสเดิม …
 * ถ้าไม่มี ใครเจอเครื่องที่ไม่ได้ล็อกก็เปลี่ยนรหัสแล้วยึดบัญชีไปเลย"* — and the second factor
 * inherits it rather than inventing something different.
 *
 * ⚠️ **Regenerating recovery codes is on the costly side, and it looks like it should not
 * be.** Nothing is added and nothing removed: the account still has MFA and still has ten
 * codes. But the *old* set stops working and the new one is on screen for whoever asked — so
 * it is a way to leave a borrowed machine holding ten permanent entries into somebody's
 * account while the owner's set is silently dead. A takeover with the paperwork done.
 *
 * Enrolling stays free, and should. Friction in front of turning a second factor *on* costs
 * more than it buys, and the worst an attacker achieves by enrolling for somebody else is
 * locking themselves into an account they do not control — while the owner, who has the
 * password, telephones an administrator.
 */

export const MFA_ACTIONS = ['enrol', 'confirm', 'disable', 'regenerate-codes'] as const;

export type MfaAction = (typeof MFA_ACTIONS)[number];

/**
 * ⚠️ Written as the *free* list rather than the costly one, so the default is to charge.
 *
 * An action this build has never heard of returns `true`. That direction is deliberate: the
 * next action somebody adds is protected until they decide otherwise, rather than free until
 * somebody notices.
 */
const FREE: ReadonlySet<string> = new Set<MfaAction>([
  /* The secret is unconfirmed, so the gate is not up and nothing has changed yet. */
  'enrol',
  /*
   * The code *is* the proof. Asking for a password beside it demands two proofs to raise a
   * gate that one proof passes every day afterwards.
   */
  'confirm',
]);

export function needsPassword(action: MfaAction): boolean {
  return !FREE.has(action);
}
