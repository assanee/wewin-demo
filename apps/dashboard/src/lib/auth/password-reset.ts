import 'client-only';

import { apiFetch } from '@/lib/api/client';
import { apiErrorFromResponse } from '@/lib/api/errors';

/**
 * The two calls a person makes when they cannot sign in.
 *
 * Both `anonymous`, and not as an oversight: somebody who has forgotten their password has
 * no session by definition, and `apiFetch` without the flag would attach a stale access
 * token and, behind the 401 these endpoints can return, silently retry the whole request a
 * second time.
 */

/**
 * ⚠️ **Restated from `apps/api/src/auth/password/password.contract.ts`, and it can drift.**
 *
 * `turbo boundaries` stops the dashboard importing from apps/api, and rightly — but the
 * consequence is a number written twice. The drift is bounded on purpose: this copy is used
 * only to *describe* the rule and to disable the button early, while the rule that actually
 * decides is the API's, and its refusal is rendered verbatim. So if the two disagree, the
 * person sees the true requirement rather than this file's opinion of it — they just see it
 * one round trip later than they should have.
 *
 * Counted in code points, matching the API: `[...'👍'].length` is 1 and `'👍'.length` is 2,
 * and a Thai passphrase is three bytes a character. A byte rule would demand four times as
 * much of a Thai user as of an English one.
 */
export const PASSWORD_MIN_LENGTH = 12;

export const passwordLength = (password: string): number => [...password].length;

/**
 * Ask for a link.
 *
 * Answers 202 for a real address, an unknown one, an unverified one, a suspended account and
 * a mail server that is refusing connections — identically, on purpose. A form that
 * distinguished any of those would be an account enumerator, which is the thing the sign-in
 * path was carefully built not to be. So this returns nothing: there is nothing to report.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  const response = await apiFetch('/auth/password/reset-request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
    anonymous: true,
  });

  /*
   * A 429 *is* reported, and it is the one exception to the paragraph above. It says nothing
   * about whether the address exists — the API counts the attempt before it looks — and
   * hiding it would leave somebody pressing a button that has silently stopped working.
   */
  if (!response.ok) throw await apiErrorFromResponse(response);
}

/** Spend a link. 204, and deliberately no session — see the controller. */
export async function completePasswordReset(token: string, password: string): Promise<void> {
  const response = await apiFetch('/auth/password/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, password }),
    anonymous: true,
  });

  if (!response.ok) throw await apiErrorFromResponse(response);
}
