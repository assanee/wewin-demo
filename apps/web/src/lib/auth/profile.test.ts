import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { decodeProfile, phoneProof } from './profile';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ The one thing this tab can get wrong that a customer would believe.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A profile tab that shows the wrong *name* is embarrassing. A profile tab that says a telephone
 * number is **confirmed** when nobody confirmed it is a lie about a credential — and on this
 * storefront the telephone number *is* the credential, since it is what every account signs in
 * with. So the assertions that matter here are all about the verification state, and specifically
 * about the two ways it can be read wrongly:
 *
 *   ⓵ from `isPrimary`, which is the trap this replaced. `user_phones_primary_is_verified` makes
 *      `isPrimary` imply verified, so it reads correctly for the primary number and calls every
 *      *verified non-primary* number unproven.
 *   ⓶ by crediting a member of staff for a proof they did not give — the distinction
 *      `user_phones.verified_by_user_id` exists to carry, and which its own schema comment asks a
 *      reader to be able to make.
 *
 * ⚠️ Rendering is not available here: `apps/web`'s vitest is `environment: 'node'` with no jsdom,
 * on purpose, and a `.test.tsx` would be silently *not collected*. Which is why `phoneProof` and
 * `decodeProfile` are plain functions in `lib/` rather than logic inside `MyProfile.tsx` — the
 * same reason `accountTabs.ts` exists. The browser pass confirms the component asks them; the
 * file scan at the bottom is what stops that wiring being quietly cut.
 */

describe('how a telephone number came to be trusted', () => {
  it('⭐ calls an unproven claim unverified', () => {
    // The state almost every account on this storefront is in: registration writes the number
    // with `verified_at` null and nothing ever proves it unless somebody telephones.
    expect(phoneProof({ verifiedAt: null, verifiedByStaff: false })).toBe('unverified');
  });

  it('⭐ names staff when a person vouched', () => {
    expect(phoneProof({ verifiedAt: '2026-08-12T04:00:00.000Z', verifiedByStaff: true })).toBe(
      'verified-by-staff',
    );
  });

  it('⭐ does not credit staff for a proof of possession', () => {
    /*
     * Unreachable today — there is no OTP in this system — and asserted anyway, because the day
     * one lands this is the branch that stops the screen telling a customer a member of staff
     * confirmed a number the customer confirmed themselves.
     */
    expect(phoneProof({ verifiedAt: '2026-08-12T04:00:00.000Z', verifiedByStaff: false })).toBe(
      'verified',
    );
  });

  it('⚠️ never reports a voucher on a number nobody proved', () => {
    /*
     * `user_phones_voucher_needs_a_verification` refuses that row in the database, so this is a
     * shape the API cannot send. Asserted because the *ordering* of the two tests inside
     * `phoneProof` is what makes it true: read `verifiedByStaff` first and this combination
     * would answer `verified-by-staff` for a number with no verification at all.
     */
    expect(phoneProof({ verifiedAt: null, verifiedByStaff: true })).toBe('unverified');
  });
});

describe('reading GET /me/account into the profile tab', () => {
  /** The response shape for a customer who registered with a number and nothing else. */
  const selfRegistered = {
    userId: '11111111-1111-1111-1111-111111111111',
    displayName: null,
    emails: [],
    phones: [{ number: '+66812349999', isPrimary: false, verifiedAt: null, verifiedByStaff: false }],
    hasPassword: true,
    providers: [],
    sessions: [],
    waysIn: 1,
  };

  it('reads the ordinary storefront account: a number, unproven, and no name', () => {
    expect(decodeProfile(selfRegistered)).toStrictEqual({
      name: null,
      phones: [{ number: '+66812349999', proof: 'unverified' }],
      emails: [],
    });
  });

  it('⭐ does not read verification off isPrimary', () => {
    /*
     * ─────────────────────────────────────────────────────────────────────────
     * The assertion that pins the reason the API wire was widened at all.
     * ─────────────────────────────────────────────────────────────────────────
     *
     * Two rows that `isPrimary` cannot tell apart from their verification state, in both
     * directions at once:
     *
     *   the first is **verified and not primary** — `isPrimary` says "no", the truth is "yes".
     *     Reading `isPrimary` would show a customer their confirmed number as unconfirmed.
     *   the second is **unverified and not primary**, which `isPrimary` gets right by accident.
     *
     * A decoder that used `isPrimary` gives both rows the same answer. This one does not.
     */
    const decoded = decodeProfile({
      ...selfRegistered,
      phones: [
        {
          number: '+66811111111',
          isPrimary: false,
          verifiedAt: '2026-08-12T04:00:00.000Z',
          verifiedByStaff: true,
        },
        { number: '+66822222222', isPrimary: false, verifiedAt: null, verifiedByStaff: false },
      ],
    });

    expect(decoded?.phones).toStrictEqual([
      { number: '+66811111111', proof: 'verified-by-staff' },
      { number: '+66822222222', proof: 'unverified' },
    ]);
  });

  it('⚠️ degrades a missing verification field towards unverified, never towards proved', () => {
    /*
     * An API older than the contract change that added these two fields, or a proxy that dropped
     * them. The screen must fall back to "we cannot claim this is proved"; the other direction
     * would have it assert a proof on the strength of a field that never arrived.
     */
    const decoded = decodeProfile({
      ...selfRegistered,
      phones: [{ number: '+66812349999', isPrimary: true }],
    });

    expect(decoded?.phones).toStrictEqual([{ number: '+66812349999', proof: 'unverified' }]);
  });

  it('keeps a display name when there is one', () => {
    expect(decodeProfile({ ...selfRegistered, displayName: 'สมชาย ใจดี' })?.name).toBe('สมชาย ใจดี');
  });

  it('treats an empty display name as no name rather than as a name', () => {
    // A blank `dd` reads as a rendering fault; "ยังไม่ได้ระบุชื่อ" reads as the fact it is.
    expect(decodeProfile({ ...selfRegistered, displayName: '' })?.name).toBeNull();
  });

  it('reads the verified addresses, which are the only ones this endpoint sends', () => {
    const decoded = decodeProfile({
      ...selfRegistered,
      emails: [{ address: 'somchai@example.invalid', isPrimary: true }],
    });
    expect(decoded?.emails).toStrictEqual(['somchai@example.invalid']);
  });

  it('drops a row it cannot read rather than rendering a blank line', () => {
    const decoded = decodeProfile({
      ...selfRegistered,
      phones: [{ isPrimary: true }, { number: '+66812349999', verifiedAt: null }, null, 'nonsense'],
      emails: [{ isPrimary: true }, { address: 'ok@example.invalid' }],
    });

    expect(decoded?.phones).toStrictEqual([{ number: '+66812349999', proof: 'unverified' }]);
    expect(decoded?.emails).toStrictEqual(['ok@example.invalid']);
  });

  it('answers null for a body that is not this response', () => {
    // Every one of these reaches the tab as "cannot connect", which is also what a closed or
    // erased account's refusal reaches it as. Nothing partial is ever drawn.
    for (const body of [null, undefined, 'nope', 42, [], {}, { phones: [] }, { emails: [] }]) {
      expect(decodeProfile(body), JSON.stringify(body) ?? 'undefined').toBeNull();
    }
  });
});

/**
 * ── The wiring, read from the source ─────────────────────────────────────────
 *
 * The tests above prove the functions. None of them can tell whether `MyProfile` still calls
 * them, and this app cannot render the component to find out.
 *
 * ⚠️ Comments are stripped first, and then the scans still avoid bare names — every one of them
 * survives in an import statement when the call is gone, which is the false green
 * `accountTabs.test.ts` documents catching only five of ten mutations for on its first pass.
 */
describe('MyProfile is wired to this module', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'components', 'account', 'MyProfile.tsx'),
    'utf8',
  );
  const code = source
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')
    .replaceAll(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replaceAll(/(^|[^:])\/\/.*$/gm, '$1');

  it('stripped the comments without stripping the component', () => {
    expect(code).toContain('export function MyProfile');
    expect(code.length).toBeGreaterThan(400);
  });

  it('⭐ asks this module for the details rather than reading the response itself', () => {
    // The call, not the import.
    expect(code).toContain('fetchProfile(session.accessToken)');
  });

  it('⭐ renders the verification state as a word, from the key table', () => {
    /*
     * `PROOF_KEYS[phone.proof]` is what stops the screen showing a number with no qualification,
     * and the `Record` over the union is what makes a fourth `PhoneProof` a compile error rather
     * than a silently missing label. Both halves are scanned: the table and the lookup.
     */
    expect(code).toContain('PROOF_KEYS: Readonly<Record<PhoneProof, PlainKey>>');
    expect(code).toContain('t(PROOF_KEYS[phone.proof])');
    // All three keys present, so a state cannot lose its sentence.
    for (const key of ['account.profile.verified', 'account.profile.verifiedByStaff', 'account.profile.unverified']) {
      expect(code, key).toContain(key);
    }
  });

  it('⚠️ never renders a field from a read that did not succeed', () => {
    // The two early returns. Without them a `failed` phase would fall through to the `<dl>` and
    // draw a name, a number and an address out of nothing.
    expect(code).toContain("phase.kind === 'loading'");
    expect(code).toContain("phase.kind === 'failed'");
    expect(code).toContain("t('account.problem.unreachable')");
  });

  it('says the tab cannot be edited, and does not offer a self-service verification', () => {
    expect(code).toContain("t('account.profile.readOnly')");
    expect(code).toContain("t('account.profile.unverifiedNote')");
    // No form, no save. The strings above would be a lie beside either.
    expect(code).not.toContain('<form');
    expect(code).not.toContain('<input');
    expect(code).not.toContain('<button');
  });

  it('points at the settings page for the language rather than duplicating the control', () => {
    expect(code).toContain("t('account.profile.languageElsewhere')");
    expect(code).toContain("localeHref(locale, '/settings')");
  });
});
