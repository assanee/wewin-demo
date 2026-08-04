import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '@wewin/db';
import { guests } from '@wewin/db/schema';
// Through @wewin/db and not 'drizzle-orm' directly — see the note in packages/db/src/sql.ts.
import { and, eq, sql } from '@wewin/db/sql';

import { DRIZZLE } from '../database/database.tokens';
import { guestSecretHash, guestSecretMatches, type GuestCookie } from './guest-cookie';

/**
 * Is this cookie still an anonymous capability?
 *
 * Three conditions, and each one is a security fix rather than tidiness.
 *
 *   **The row exists.** The guard used to believe any well-formed uuid in the cookie, so a
 *   request could be scoped to a `guests.id` that was nobody's — a stale cookie from a wiped
 *   database, or a hand-written one. Scoping to a referent that does not exist is how
 *   `where guest_id = $1` starts returning rows nobody owns the day two carts collide.
 *
 *   **The row is unclaimed.** Signing in sets `claimed_by_user_id`, and from that moment the
 *   cart belongs to an account. Continuing to honour the cookie would mean the id remains a
 *   password to somebody's cart forever — which is exactly the payoff of planting a guest
 *   cookie in a victim's browser before they sign in. After the claim, whoever holds the id
 *   gets `public`.
 *
 *   **The secret matches.** The newest of the three, and the one that makes the other two
 *   worth having. The cookie carries `id.secret`; this compares SHA-256 of what was
 *   presented against `guests.secret_hash`. Without it, *knowing* a guest id — from a log
 *   line, an old cookie, a shared browser — was the same thing as *holding* the cart, and
 *   since claiming a guest now attributes its orders to the claiming account, that was the
 *   same thing as taking somebody's contract. A row whose `secret_hash` is null predates the
 *   column and is refused: there is no secret it could match, and inventing one would be
 *   inventing a credential.
 *
 * One primary-key lookup on the anonymous path. It is on the funnel, so it is worth saying
 * that the alternative is not "no query" — it is a handler reading a cart by an id nothing
 * checked.
 */
@Injectable()
export class GuestRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async isOpenGuest(cookie: GuestCookie): Promise<boolean> {
    const rows = await this.db
      .select({ secretHash: guests.secretHash })
      .from(guests)
      .where(and(eq(guests.id, cookie.guestId), sql`${guests.claimedByUserId} is null`))
      .limit(1);

    const stored = rows[0]?.secretHash;
    if (stored === undefined || stored === null) return false;

    return guestSecretMatches(guestSecretHash(cookie.secret), stored);
  }
}
