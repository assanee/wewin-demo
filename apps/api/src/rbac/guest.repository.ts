import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '@wewin/db';
import { guests } from '@wewin/db/schema';
// Through @wewin/db and not 'drizzle-orm' directly — see the note in packages/db/src/sql.ts.
import { and, eq, sql } from '@wewin/db/sql';

import { DRIZZLE } from '../database/database.tokens';

/**
 * Is this guest id still an anonymous capability?
 *
 * Two conditions, and the second is a security fix rather than tidiness.
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
 * One primary-key lookup on the anonymous path. It is on the funnel, so it is worth saying
 * that the alternative is not "no query" — it is a handler reading a cart by an id nothing
 * checked.
 */
@Injectable()
export class GuestRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async isOpenGuest(guestId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: guests.id })
      .from(guests)
      .where(and(eq(guests.id, guestId), sql`${guests.claimedByUserId} is null`))
      .limit(1);

    return rows.length > 0;
  }
}
