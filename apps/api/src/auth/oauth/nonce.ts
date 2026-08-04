import { sha256Base64Url } from './crypto';

/**
 * The OIDC `nonce`, derived rather than stored.
 *
 * A `nonce` is echoed back inside the id_token and exists so a token minted for one
 * authorisation request cannot be replayed into another — including an id_token the
 * attacker obtained legitimately for their own account and injected into somebody else's
 * flow. LINE, Google and Apple all support it.
 *
 * It is derived from the PKCE verifier instead of getting a column of its own, and the
 * reason is not that a column would be expensive. `oauth_states` deliberately stores no
 * secret that would let its holder complete a flow (see schema/auth.ts), and a stored
 * nonce is one: with a nonce in the table, a database dump plus a stolen id_token is a
 * usable pair again. Derived, the nonce exists only where the verifier exists, which is
 * the httpOnly cookie in the browser that started the flow — so the id_token check lands
 * on exactly the same browser-bound secret as fix ⓑ, and adds nothing to the blast radius
 * of a dump.
 *
 * The derivation is one-way: `nonce` is public the moment it is sent to the provider, and
 * SHA-256 preimage resistance is what keeps it from being a way back to the verifier. The
 * label prevents the two hashes of the same input from ever being the same value — the
 * PKCE challenge is `SHA256(verifier)` with no label, and a nonce that happened to equal
 * the challenge would mean sending the challenge twice under two names.
 */
export function deriveNonce(verifier: string): string {
  return sha256Base64Url(`oidc-nonce:${verifier}`);
}
