import { describe, expect, it } from 'vitest';

import { MFA_ACTIONS, needsPassword, type MfaAction } from '../../../src/auth/mfa/reproof';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ TURNING PROTECTION DOWN COSTS A PASSWORD. TURNING IT UP DOES NOT.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Every one of these actions is taken by somebody already signed in, so "are you who you say
 * you are" has been answered once. The question this table answers is narrower: **is this an
 * action somebody who found an unlocked laptop would want to take?**
 *
 * Plan 6.4 already makes the same call for passwords — *"เปลี่ยนรหัสผ่านตัวเอง ต้องกรอกรหัสเดิม
 * … ถ้าไม่มี ใครเจอเครื่องที่ไม่ได้ล็อกก็เปลี่ยนรหัสแล้วยึดบัญชีไปเลย"* — and the second factor
 * inherits it rather than inventing a different rule.
 *
 * ⚠️ **Regenerating recovery codes is on the costly side, and it looks like it should not
 * be.** It adds nothing and removes nothing; the account still has MFA and still has ten
 * codes. But the *old* codes stop working and the new ones are shown on screen to whoever
 * asked — so it is a way to walk away from a borrowed machine holding ten permanent entries
 * into somebody's account, with the real owner's set silently dead. That is a takeover with
 * the paperwork done.
 *
 * Enrolling is free, and should be. Anything that makes people hesitate before turning on a
 * second factor is worth more than it costs, and the worst an attacker achieves by enrolling
 * on somebody else's behalf is locking *themselves* into an account they do not control —
 * while the owner, who still has the password, calls an administrator.
 */

describe('the table covers every action', () => {
  it('names all four', () => {
    expect(MFA_ACTIONS).toStrictEqual(['enrol', 'confirm', 'disable', 'regenerate-codes']);
  });

  it('has an answer for each', () => {
    for (const action of MFA_ACTIONS) {
      expect(typeof needsPassword(action), `${action} has no answer`).toBe('boolean');
    }
  });
});

describe('⭐ what costs a password', () => {
  it('⚠️ disabling does', () => {
    /*
     * The one that matters most. Without it, an unlocked machine is a way to strip a second
     * factor off an account and leave with the password — which is the entire protection,
     * removed by somebody who never proved they knew anything.
     */
    expect(needsPassword('disable')).toBe(true);
  });

  it('⭐ regenerating the recovery codes does', () => {
    /*
     * The one that looks like it should not. See the block comment: the account is no less
     * protected afterwards, and the person walking away from the borrowed laptop is holding
     * ten live entries while the owner's set is quietly dead.
     */
    expect(needsPassword('regenerate-codes')).toBe(true);
  });
});

describe('what does not', () => {
  it('enrolling does not, because nothing is weakened by starting', () => {
    /*
     * The secret is written and unconfirmed — `confirmed_at IS NULL` — so the gate is not up
     * and nothing about the account has changed. Charging for this only discourages people
     * from turning it on.
     */
    expect(needsPassword('enrol')).toBe(false);
  });

  it('⚠️ confirming does not, because the code is itself the proof', () => {
    /*
     * Confirmation carries a TOTP code from the secret just issued. Demanding a password
     * beside it asks for two proofs to *raise* a gate while one suffices to pass it every
     * day afterwards — friction with no attacker on the other side of it.
     */
    expect(needsPassword('confirm')).toBe(false);
  });
});

describe('⚠️ the shape of the rule, not just its answers', () => {
  it('is exhaustive rather than defaulting', () => {
    /*
     * An action this build has never heard of must be **refused**, not waved through.
     * `needsPassword` returning `false` for an unknown string would make the next action
     * somebody adds free by default — and the default should cost, because the costly side
     * is the safe side.
     */
    expect(needsPassword('erase-everything' as MfaAction)).toBe(true);
  });
});
