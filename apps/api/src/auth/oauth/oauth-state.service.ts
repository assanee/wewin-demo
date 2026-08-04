import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '@wewin/db';
import { guests, oauthStates } from '@wewin/db/schema';
// From @wewin/db and not 'drizzle-orm' directly — see the note in packages/db/src/sql.ts.
import { and, eq, sql } from '@wewin/db/sql';

import { DRIZZLE } from '../../database/database.tokens';
import { guestSecretHash, guestSecretMatches, type GuestCookie } from '../../rbac';
import { randomSecret, sha256Hex } from './crypto';
import { createPkce } from './pkce';
import type { ProviderName } from './providers/provider.types';

/**
 * ⓑ One authorisation attempt, minted and then consumed exactly once — plan 6(b).
 *
 * The two halves of the proof are minted together here and never live in the same place
 * again: the `state` goes into the authorisation URL, the binding secret and the PKCE
 * verifier go into an httpOnly cookie, and this table stores only digests of the first two
 * and the *public* challenge of the third. A dump of `oauth_states` therefore lets nobody
 * complete anybody's flow — the URL half is hashed and the cookie half never reached the
 * server's disk.
 *
 * `consume` is the security-critical statement and is deliberately one UPDATE:
 *
 *     UPDATE oauth_states SET consumed_at = now()
 *      WHERE state_hash = $1 AND binding_hash = $2 AND provider = $3
 *        AND consumed_at IS NULL AND expires_at > now()
 *
 * Four separate rejections — replayed callback, wrong browser, expired flow, provider
 * mismatch — collapse into "zero rows", which is both the fastest answer and the least
 * informative one to whoever is probing. A `SELECT` followed by an `UPDATE` would leave a
 * window for two callbacks to both pass the read; the `consumed_at IS NULL` in the WHERE
 * clause *is* the mutual exclusion, and `auth_consume_once` in 0003_auth_guards.sql refuses
 * to rewrite the column even if some later caller tries.
 */

export interface MintInput {
  readonly provider: ProviderName;
  readonly returnTo: string;
  readonly guestCookie: GuestCookie | undefined;
  readonly ttlSeconds: number;
}

export interface MintedState {
  /** Goes to the provider in the authorisation URL. */
  readonly state: string;
  /** Goes to the browser in the cookie, and nowhere else. */
  readonly binding: string;
  /** Goes to the browser in the same cookie; only ever sent onward to the token endpoint. */
  readonly verifier: string;
  /** Public: `SHA256(verifier)`, sent to the provider and stored. */
  readonly challenge: string;
  /** Names the cookie for this flow — see `stateCookieName`. */
  readonly stateHash: string;
}

export interface ConsumeInput {
  readonly provider: ProviderName;
  readonly state: string;
  readonly binding: string;
}

export interface ConsumedState {
  readonly id: string;
  readonly pkceChallenge: string;
  readonly returnTo: string;
  readonly guestId: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class OAuthStateService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async mint(input: MintInput): Promise<MintedState> {
    const state = randomSecret();
    const binding = randomSecret();
    const pkce = createPkce();

    await this.db.insert(oauthStates).values({
      provider: input.provider,
      stateHash: sha256Hex(state),
      bindingHash: sha256Hex(binding),
      pkceChallenge: pkce.challenge,
      returnTo: input.returnTo,
      guestId: await this.knownGuest(input.guestCookie),
      /*
       * The database's clock, not this process's. The expiry is compared against `now()` in
       * `consume`, and a row written from an app clock that drifted is a flow that expires
       * early or late for reasons no log explains.
       */
      expiresAt: sql`now() + make_interval(secs => ${input.ttlSeconds})`,
    });

    return {
      state,
      binding,
      verifier: pkce.verifier,
      challenge: pkce.challenge,
      stateHash: sha256Hex(state),
    };
  }

  /**
   * The one statement. Returns the row it claimed, or nothing.
   *
   * Nothing about *why* it returned nothing is reported, and that is the design: the caller
   * has no branch to take on the difference, and a distinguishable "expired" versus "wrong
   * browser" is an oracle for an attacker checking whether a `state` they hold is still
   * live.
   */
  async consume(input: ConsumeInput): Promise<ConsumedState | undefined> {
    const [claimed] = await this.db
      .update(oauthStates)
      .set({ consumedAt: sql`now()` })
      .where(
        and(
          eq(oauthStates.stateHash, sha256Hex(input.state)),
          /* ⓑ The browser half. Without this line the row alone is the whole check, which is the vulnerability. */
          eq(oauthStates.bindingHash, sha256Hex(input.binding)),
          /* A `state` minted for LINE must not complete a Google callback: the row carries the provider whose id_token will be trusted. */
          eq(oauthStates.provider, input.provider),
          sql`${oauthStates.consumedAt} is null`,
          sql`${oauthStates.expiresAt} > now()`,
        ),
      )
      .returning({
        id: oauthStates.id,
        pkceChallenge: oauthStates.pkceChallenge,
        returnTo: oauthStates.returnTo,
        guestId: oauthStates.guestId,
      });

    return claimed;
  }

  /**
   * A guest id from a cookie is attacker-supplied, so it is checked against the table
   * rather than trusted into a foreign key.
   *
   * The alternative — insert and let the FK fail — turns a stale cookie from a wiped
   * database into a 500 on the login page. `null` here means the flow simply carries no
   * cart, which is the correct outcome for a guest row that no longer exists.
   *
   * `claimed_by_user_id IS NULL` is the same rule `GuestRepository.isOpenGuest` applies on
   * every request, restated here because this is the one place the id is written somewhere
   * durable. A claimed guest belongs to an account; carrying it through a sign-in would be
   * carrying somebody's cart into a second person's login, and the two readers of that
   * cookie disagreeing about which rows count is exactly the class of bug this round spent
   * its time on.
   */
  private async knownGuest(cookie: GuestCookie | undefined): Promise<string | null> {
    if (cookie === undefined || !UUID.test(cookie.guestId)) return null;

    const [found] = await this.db
      .select({ id: guests.id, secretHash: guests.secretHash })
      .from(guests)
      .where(and(eq(guests.id, cookie.guestId), sql`${guests.claimedByUserId} is null`))
      .limit(1);

    if (!found || found.secretHash === null) return null;

    /*
     * The secret is checked *here* and not only in the guard, and this is the call site that
     * matters most in the whole application.
     *
     * `RbacGuard` verifies the cookie on every request and would already refuse a bare id —
     * but this endpoint is `AllowAnonymous`, so the guard never builds a guest scope for it,
     * and the id travels from the cookie into `oauth_states.guest_id` and from there into
     * `claimGuest`, which now attributes the guest's orders to the account signing in. An
     * unverified id on this path is precisely the attack the secret exists to stop: put
     * somebody else's guest id in your own cookie jar, sign in, keep their order.
     */
    return guestSecretMatches(guestSecretHash(cookie.secret), found.secretHash) ? found.id : null;
  }
}
