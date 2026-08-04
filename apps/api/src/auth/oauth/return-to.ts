/**
 * Where to send the customer after signing in.
 *
 * The login callback is the classic open-redirect surface: a link to *our* domain that
 * lands on somebody else's page is a phishing page wearing our name, and it arrives at the
 * moment the customer has just been asked for credentials and is primed to trust it.
 *
 * `oauth_states_return_to_is_local` in packages/db rejects the same three shapes, and this
 * is not redundant with it. The CHECK is the guarantee — it holds for callers that do not
 * exist yet. This is the *answer*: a request carrying `returnTo=https://evil.example`
 * should be a 400 naming the parameter, not a 23514 surfacing as a 500 after a row failed
 * to insert.
 *
 * The three rejected shapes, and why each is not covered by the previous one:
 *
 *   `https://evil.example`  absolute. Obvious, and the only one most code checks for.
 *   `//evil.example`        protocol-relative. Browsers read it as `https://evil.example`;
 *                           a check for "starts with /" passes it.
 *   `/\evil.example`        a backslash after the slash. Browsers normalise `\` to `/` in
 *                           the authority position, so this is the previous case again
 *                           past a check that only looked for two forward slashes.
 */

const MAX_LENGTH = 512;

/**
 * Rejected because this value is concatenated into a `Location` header: a CR or LF there is
 * response splitting, and a space — legal in a header value — has no business in a path a
 * client sent us unencoded. Everything up to and including U+0020 goes, plus U+007F (DEL),
 * which is a control character above that range.
 *
 * A loop and not a regular expression, because a character class containing control
 * characters trips `no-control-regex` however it is spelled — and silencing a lint rule
 * about control characters in the one place that is deliberately about control characters
 * is exactly backwards.
 */
const SPACE = 0x20;
const DEL = 0x7f;

function unsafeInAHeader(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= SPACE || code === DEL) return true;
  }
  return false;
}

export const DEFAULT_RETURN_TO = '/';

export function isLocalReturnTo(value: string): boolean {
  if (value.length === 0 || value.length > MAX_LENGTH) return false;
  if (unsafeInAHeader(value)) return false;
  if (!value.startsWith('/')) return false;
  if (value.startsWith('//')) return false;
  if (value.startsWith('/\\')) return false;
  return true;
}

/**
 * Absent means the default; present and unusable means an error, which the caller turns
 * into a 400.
 *
 * Deliberately not "fall back to `/` on junk". A silent fallback makes a client bug — a
 * path that was not encoded, a template that produced `undefined` — indistinguishable from
 * a customer who asked for the home page, and the place it shows up is a customer landing
 * somewhere they did not expect after signing in.
 */
export function parseReturnTo(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === '') return DEFAULT_RETURN_TO;
  return isLocalReturnTo(raw) ? raw : undefined;
}
