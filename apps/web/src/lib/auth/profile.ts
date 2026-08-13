import { reviewsApiBaseUrl } from '../reviews/api';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ WHAT WE HOLD ABOUT A CUSTOMER, SHOWN BACK TO THAT CUSTOMER.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The read behind the account page's `ข้อมูลผู้ใช้งาน` tab: the name on the account, the
 * telephone numbers it has claimed and whether anybody proved them, and the email addresses it
 * has proved.
 *
 * ── ⚠️ There is no new endpoint here, and the brief for this work said there was ──
 *
 * The task was written on the premise that "no endpoint serves a customer their own profile",
 * naming `GET /me` — which is true of `GET /me`, since that one answers *what may you do* and
 * carries no identity at all. It is not true of the API:
 *
 *   **`GET /me/account` has served exactly this since the account-settings round.** It is
 *   `@RequireAuthenticated`, its user id comes from the verified access token, and no path
 *   segment or body field on it names a user. It already returns `displayName`, `emails` and
 *   `phones` for the caller and nobody else.
 *
 * And this app already calls it: `lib/quote/prefillContact.ts` reads the same response to
 * pre-fill the quotation form's contact fields. So a `/me/profile` written for this tab would
 * have been a second query path to `users`, `user_emails` and `user_phones`, a second entry in
 * the route audit, and a second thing to keep in step — to answer a question that was already
 * answered. The tab reuses the endpoint; **only the phone rows were widened**, because the wire
 * genuinely could not say whether a number was verified. See `PhoneWire` in
 * `apps/api/src/account/account.contract.ts` for that half.
 *
 * ── The three things this module deliberately does not do ────────────────────
 *
 * ⓵ **It does not accept a user id, and there is nowhere to put one.** `fetchProfile` takes an
 *    access token and nothing else, and the URL is a constant. An id-taking profile read is an
 *    enumeration hole, and the defence here is that the request has no room for the id rather
 *    than a check somebody could delete.
 *
 * ⓶ **It does not read the language preference.** `/[locale]/settings` owns that — `SettingsScreen`
 *    reads and writes `GET/PUT /me/preferences` and applies the choice through the same cookie
 *    the header's picker writes. A second control here would be a second writer to one stored
 *    value, and the two would disagree the moment either was used. The tab links to the settings
 *    page instead. (`GET /me/account` does not carry a preference anyway, which is the API making
 *    the same separation: `profile.controller.ts`'s header argues at length that identity and
 *    preference are two different kinds of answer.)
 *
 * ⓷ **It does not write.** See `MyProfile.tsx` for what an editable tab would need and why it is
 *    not this commit.
 *
 * ── An erased or closed account never reaches this code ─────────────────────
 *
 * Not because of anything here. `accountUsability` refuses every non-`active` status ahead of
 * permissions on every non-anonymous route, so `GET /me/account` answers a tombstone with a
 * refusal rather than a body — and `apps/api/tests/rbac/closed-account-routes.pg.test.ts` sweeps
 * *every* guarded route discovered from `RouteRegistryService` to prove it, so this route is
 * covered today and a route added next year is covered the day it exists. A `null` from here is
 * rendered as "cannot connect", which is the correct thing to show somebody whose account is
 * gone: no name, no number, no profile.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * How a telephone number came to be trusted, or that it has not been.
 *
 * ⭐ Three states and not a boolean, because "verified" alone would let the screen imply the
 * wrong actor. `user_phones.verified_by_user_id` exists precisely to keep a **staff assertion**
 * — somebody at the company vouching over the telephone — apart from **possession proved
 * directly** by an OTP, and the schema comment on that column asks that a reader be able to tell
 * the two apart.
 *
 * ⚠️ `'verified'` is unreachable today: this system has no OTP, so every verified number was
 * vouched for by a person. It is modelled anyway so that the day an OTP lands, the screen stops
 * crediting staff for it without anybody having to remember to come back here.
 */
export type PhoneProof = 'verified' | 'verified-by-staff' | 'unverified';

export interface ProfilePhone {
  readonly number: string;
  readonly proof: PhoneProof;
}

/**
 * The customer's own details, as the tab needs them.
 *
 * `name` is `null` far more often than not: registration on this storefront is a telephone
 * number and a password, and nothing in that flow sets `display_name`. `prefillContact.ts`
 * records the same fact from the other side ("`displayName` is never set by phone
 * registration, and this module does not invent one").
 *
 * ⚠️ `emails` is a list of plain addresses with no verification field, and that is not an
 * omission. `GET /me/account` filters that list to **verified rows only** — deliberately, and
 * load-bearingly: `AccountService.overview` derives `waysIn` from `emails.length`, so widening
 * that filter would make an unverified claim count as a way to sign in, which is the exact bug
 * `account.pg.test.ts` has a starred test against. Every address that arrives here is proved,
 * so a per-row flag would be a constant. The cost is that a customer holding an *unverified*
 * address sees none, which is why the empty-state string says "ที่ยืนยันแล้ว" rather than
 * claiming they have no address at all.
 */
export interface ProfileDetails {
  readonly name: string | null;
  readonly phones: readonly ProfilePhone[];
  readonly emails: readonly string[];
}

/**
 * ⭐ One phone row's verification state, from the two fields that carry it.
 *
 * ⚠️ **Not derived from `isPrimary`, which was the trap this replaced.**
 * `user_phones_primary_is_verified` makes `isPrimary` imply verified, so reading it as the
 * verification signal is sound in one direction only — a verified number that is not the primary
 * one would read as an unproven claim, and the screen would tell a customer their confirmed
 * number was unconfirmed. `verifiedAt` is the fact; `isPrimary` is about which number we match
 * on, and this module ignores it.
 *
 * The order of the two tests matters: a voucher cannot exist without a verification
 * (`user_phones_voucher_needs_a_verification` refuses one), so `verifiedByStaff` is only ever
 * consulted for a row that is verified.
 */
export function phoneProof(row: {
  readonly verifiedAt: string | null;
  readonly verifiedByStaff: boolean;
}): PhoneProof {
  if (row.verifiedAt === null) return 'unverified';
  return row.verifiedByStaff ? 'verified-by-staff' : 'verified';
}

/**
 * `AccountWire`, restated — the fields this tab reads and no others.
 *
 * Restated rather than imported because `apps/api` is not a dependency of this app and
 * `@wewin/contract` does not carry `AccountWire` (`account.contract.ts` records that as debt).
 * `prefillContact.ts` restates the same response for the same reason; this is the house pattern,
 * not a shortcut.
 *
 * Every field is checked rather than trusted, and a row that does not parse is **dropped** rather
 * than rendered as a blank line — the same `flatMap` discipline `MyQuotations` uses.
 *
 * ⚠️ A missing `verifiedAt`/`verifiedByStaff` decodes as **unverified**, not as verified. An API
 * older than this commit's contract change, or a proxy that dropped a field, must degrade towards
 * "we cannot claim this is proved"; the other direction would have this screen assert a proof on
 * the strength of a field that never arrived.
 */
export function decodeProfile(body: unknown): ProfileDetails | null {
  if (!isRecord(body) || !Array.isArray(body['phones']) || !Array.isArray(body['emails'])) {
    return null;
  }

  const phones = body['phones'].flatMap((raw): ProfilePhone[] => {
    if (!isRecord(raw) || typeof raw['number'] !== 'string') return [];
    return [
      {
        number: raw['number'],
        proof: phoneProof({
          verifiedAt: typeof raw['verifiedAt'] === 'string' ? raw['verifiedAt'] : null,
          verifiedByStaff: raw['verifiedByStaff'] === true,
        }),
      },
    ];
  });

  const emails = body['emails'].flatMap((raw): string[] =>
    isRecord(raw) && typeof raw['address'] === 'string' ? [raw['address']] : [],
  );

  return {
    name: typeof body['displayName'] === 'string' && body['displayName'] !== '' ? body['displayName'] : null,
    phones,
    emails,
  };
}

/**
 * The signed-in customer's own details, or `null` for every failure.
 *
 * ⚠️ **No user id, by construction.** The URL is a constant and the only input is a bearer token,
 * so there is no argument a caller could pass to ask about somebody else — and the API scopes the
 * query to the token's own user regardless. Two independent reasons this cannot read another
 * person's row, neither of which is a check in this file that could be deleted.
 *
 * `null` covers an unconfigured API, a network failure, a refusal (including the refusal a closed
 * or erased account gets) and a body that does not parse. The tab renders one sentence for all of
 * them: a screen that cannot read the account must not guess at its contents.
 */
export async function fetchProfile(accessToken: string): Promise<ProfileDetails | null> {
  const base = reviewsApiBaseUrl();
  if (base === null) return null;

  try {
    const response = await fetch(`${base}/me/account`, {
      credentials: 'include',
      headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` },
      /* Somebody's own name and telephone number have no business in a shared cache. */
      cache: 'no-store',
    });
    if (!response.ok) return null;
    return decodeProfile(await response.json());
  } catch {
    return null;
  }
}
