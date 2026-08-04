/**
 * One `Cookie:` header parser for the whole process.
 *
 * There were two, and they disagreed. `rbac/identity.ts` returned the *first* occurrence of
 * a name and stopped at the first malformed one; `auth/oauth/state-cookie.ts` kept going and
 * returned the *last*. Both were handed the same header on the same request, and both read
 * `wewin_guest` — the guard to decide which cart a request may touch, the OAuth start
 * endpoint to decide which cart a sign-in claims. A browser sends two cookies of one name as
 * soon as a second is set at a different `Path` or `Domain`, so an attacker with a foothold
 * on a sibling subdomain could make the two readers answer differently: the visitor shops in
 * cart A while their sign-in permanently claims cart B.
 *
 * So the rule is one rule, and it is the conservative one:
 *
 *   **a name that appears more than once is treated as absent.**
 *
 * RFC 6265 does not define which duplicate wins, browsers order them by path length and then
 * by creation time, and every choice here is a guess about somebody else's implementation.
 * Refusing to guess costs a visitor one anonymous cart in a situation that only arises when
 * something has already gone wrong; picking a winner costs the ability to say what happened.
 *
 * Hand-parsed rather than pulling in `cookie-parser`: this reads values out of a header
 * whose grammar is `name=value` pairs separated by `;`, and a dependency that exists to save
 * fifteen lines is a dependency that has to be audited forever.
 */

/**
 * The value of one cookie, or `undefined` for absent, malformed, or duplicated.
 *
 * The value is returned exactly as it arrived — not percent-decoded. Decoding belongs to
 * whoever knows what the value is supposed to be: `readGuestId` decodes because a uuid can
 * legitimately have been encoded by a client library, and the OAuth binding secret must not,
 * because it is base64url and anything that needed decoding was not minted here.
 */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;

  let found: string | undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    // Second sighting: neither answer is defensible, so there is no answer.
    if (found !== undefined) return undefined;
    found = part.slice(separator + 1).trim();
  }
  return found;
}
