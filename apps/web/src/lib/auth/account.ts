import { normalisePhone } from '@wewin/core/phone';

import { reviewsApiBaseUrl } from '../reviews/api';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ AN ACCOUNT, ON THE STOREFRONT.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The API has had `POST /auth/register` and `POST /auth/password` for two phases and the
 * storefront had no way to reach either — so a customer could be *told* they had an account
 * and never find the door. This is the door.
 *
 * ── ⚠️ Why an account is now required to request a quotation ─────────────────
 *
 * It is a reversal, and the codebase argues the other way at length: plan 6 and 10.2 call the
 * anonymous visitor the main funnel, and this storefront's whole pitch is that you can price a
 * window without signing in.
 *
 * What changed is the question "whose order is this?". A guest order belongs to a **cookie**:
 * clear it, change device, or open the emailed link on a phone, and the customer has no way
 * back to their own quotation. An account answers it durably, and registration is now one
 * telephone number and a password.
 *
 * ⚠️ **Pricing and filling a cart stay anonymous.** Only the submit asks, which keeps the
 * funnel argument intact for everything before the moment of conversion.
 *
 * ── The shape of a session here ──────────────────────────────────────────────
 *
 * An access token in memory, and a `__Host-` refresh cookie this app can neither read nor
 * forge — it belongs to the API's origin. So "am I signed in?" is not a question this bundle
 * can answer from storage; it has to *ask*, which is what `currentSession` does and why every
 * screen starts in a `checking` state rather than assuming signed out.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export interface Session {
  readonly accessToken: string;
  readonly expiresAt: string;
}

export type AuthProblem =
  | 'name-or-number-missing'
  /** The number could not be canonicalised. Registration only — sign-in stays silent. */
  | 'bad-phone'
  | 'password-too-short'
  /** The API refused; `detail` is its own sentence, already in the reader's language. */
  | 'refused'
  | 'unreachable'
  | 'unconfigured';

export type AuthResult =
  | { readonly ok: true; readonly session: Session }
  | { readonly ok: false; readonly problem: AuthProblem; readonly detail?: string | undefined };

/**
 * ⚠️ Mirrored from `apps/api/src/auth/password/password.contract.ts`.
 *
 * The API refuses a shorter one and says so, so this is a courtesy rather than the rule — but
 * a courtesy worth having: it is the difference between a message beside the field and a round
 * trip that spends an argon2 hash to say the same thing.
 */
const PASSWORD_MIN_LENGTH = 12;

const passwordLength = (password: string): number => [...password].length;

async function post(path: string, body: unknown): Promise<Response | null> {
  const base = reviewsApiBaseUrl();
  if (base === null) return null;

  try {
    return await fetch(`${base}${path}`, {
      method: 'POST',
      /* The refresh cookie is the durable half; without this it is never set or sent. */
      credentials: 'include',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      cache: 'no-store',
      body: JSON.stringify(body),
    });
  } catch {
    return null;
  }
}

async function sessionFrom(response: Response): Promise<AuthResult> {
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const detail =
      isRecord(body) && isRecord(body['error']) && typeof body['error']['message'] === 'string'
        ? body['error']['message']
        : undefined;

    return { ok: false, problem: 'refused', detail };
  }

  const body: unknown = await response.json().catch(() => null);
  if (!isRecord(body) || typeof body['accessToken'] !== 'string') {
    return { ok: false, problem: 'refused' };
  }

  return {
    ok: true,
    session: {
      accessToken: body['accessToken'],
      expiresAt: typeof body['accessTokenExpiresAt'] === 'string' ? body['accessTokenExpiresAt'] : '',
    },
  };
}

/**
 * ⭐ Register, and be signed in.
 *
 * ⚠️ A telephone number only, which is the API's rule and not this form's: email verification
 * is not implemented, so an account registered with an address could never sign in. The
 * number is canonicalised here with the same function `user_phones` obeys, because a
 * non-canonical one is refused by a CHECK and comes back as something nobody can act on.
 */
export async function register(input: {
  readonly phone: string;
  readonly password: string;
}): Promise<AuthResult> {
  const number = normalisePhone(input.phone);
  if (number === null) return { ok: false, problem: 'bad-phone' };
  if (passwordLength(input.password) < PASSWORD_MIN_LENGTH) {
    return { ok: false, problem: 'password-too-short' };
  }

  const response = await post('/auth/register', { username: number, password: input.password });
  if (response === null) return { ok: false, problem: 'unreachable' };

  return sessionFrom(response);
}

/**
 * ⭐ Sign in with a number **or** an address.
 *
 * ⚠️ Sent as typed, with no client-side judgement about which it is and no "that is not a
 * valid number". `password.contract.ts` refuses `z.string().email()` on this field because a
 * shape rule answers a question the sign-in path must stay silent about; a rule here would
 * reinstate that leak in the one place an attacker meets it first.
 */
export async function signIn(input: {
  readonly username: string;
  readonly password: string;
}): Promise<AuthResult> {
  const response = await post('/auth/password', {
    email: input.username,
    password: input.password,
  });
  if (response === null) return { ok: false, problem: 'unreachable' };

  return sessionFrom(response);
}

/**
 * Whether this browser already has a session, asked rather than assumed.
 *
 * The refresh cookie is `__Host-` prefixed and belongs to the API's origin, so this bundle
 * cannot read it. Spending it is the only way to find out, and `null` — no cookie, an expired
 * session, a refused preflight, no network — is the ordinary state of a visitor rather than an
 * error.
 */
export async function currentSession(): Promise<Session | null> {
  const response = await post('/auth/refresh', {});
  if (response === null || !response.ok) return null;

  const result = await sessionFrom(response);
  return result.ok ? result.session : null;
}

/** Ends the session on the server, which is what makes the refresh cookie useless. */
export async function signOut(): Promise<void> {
  await post('/auth/logout', {});
}

/* ------------------------------------------------------------------ *
 * Changing a password from inside
 * ------------------------------------------------------------------ */

export type ChangeProblem =
  | 'current-missing'
  | 'too-short'
  | 'same-as-current'
  | 'refused'
  | 'unreachable'
  | 'unconfigured';

export type ChangeResult =
  | { readonly ok: true; readonly otherSessionsEnded: number }
  | { readonly ok: false; readonly problem: ChangeProblem; readonly detail?: string | undefined };

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ CHANGE, NOT RESET — AND FOR THIS STOREFRONT THEY ARE NOT INTERCHANGEABLE.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A **reset** proves control of a mailbox and works for somebody locked out. It is email-only
 * by design — `phone-authority.test.ts` pins that, because a reset requestable *by number*
 * would let somebody holding an unverified claim on a victim's number take the account, which
 * turns the denial of service this design accepts into a takeover.
 *
 * ⚠️ **Every account registered through this storefront has a telephone number and no
 * address.** So a reset link has nowhere to go, and building "forgot my password" here would
 * be a screen nobody could use.
 *
 * A **change** needs no channel: the current password is the proof. That works for everyone,
 * which is why it is what this file offers.
 *
 * ⚠️ The gap that remains is real and is not this file's to close: a customer who *forgets*
 * their password has no self-service way back. Closing it needs either an SMS budget or a
 * member of staff able to vouch — the same fork `user_phones` records for verification.
 */
export async function changePassword(input: {
  readonly accessToken: string;
  readonly currentPassword: string;
  readonly newPassword: string;
}): Promise<ChangeResult> {
  if (input.currentPassword.trim() === '') return { ok: false, problem: 'current-missing' };
  if (passwordLength(input.newPassword) < PASSWORD_MIN_LENGTH) {
    return { ok: false, problem: 'too-short' };
  }
  /*
   * ⚠️ Refused here rather than sent. The API accepts it — a no-op change is not a security
   * problem — but a person who typed the same thing twice meant to change something, and a
   * cheerful "saved" is the wrong answer to that.
   */
  if (input.currentPassword === input.newPassword) return { ok: false, problem: 'same-as-current' };

  const base = reviewsApiBaseUrl();
  if (base === null) return { ok: false, problem: 'unconfigured' };

  let response: Response;
  try {
    response = await fetch(`${base}/me/account/password`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${input.accessToken}`,
      },
      cache: 'no-store',
      body: JSON.stringify({
        currentPassword: input.currentPassword,
        newPassword: input.newPassword,
      }),
    });
  } catch {
    return { ok: false, problem: 'unreachable' };
  }

  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const detail =
      isRecord(body) && isRecord(body['error']) && typeof body['error']['message'] === 'string'
        ? body['error']['message']
        : undefined;

    return { ok: false, problem: 'refused', detail };
  }

  const body: unknown = await response.json().catch(() => null);

  /*
   * ⭐ Reported, not swallowed. Changing a password ends every *other* session, which is the
   * point of doing it — and a customer who has just signed a family member's tablet out
   * deserves to be told so rather than to find out later.
   */
  return {
    ok: true,
    otherSessionsEnded:
      isRecord(body) && typeof body['otherSessionsEnded'] === 'number' ? body['otherSessionsEnded'] : 0,
  };
}
