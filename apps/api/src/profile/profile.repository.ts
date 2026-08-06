import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '@wewin/db';
// Through @wewin/db and not 'drizzle-orm' directly — see the note in packages/db/src/sql.ts.
import { eq } from '@wewin/db/sql';
import { userPreferences } from '@wewin/db/schema';
import type { Currency } from '@wewin/core/money';
import type { LengthUnit } from '@wewin/core/units';

import { DRIZZLE } from '../database/database.tokens';

/**
 * The one table this round writes, and the only query path to it.
 *
 * ── What is stored is not narrowed on the way out ────────────────────────────────
 *
 * `preferred_locale` comes back as the `text` it is. It is **not** narrowed here, and that
 * is deliberate: `packages/db`'s CHECK is a *shape* check (`^[a-z]{2}(-…)?$`), so the column
 * can legally hold `'ja'` — a well-formed tag for a language this build has no catalogue
 * for. Narrowing in the repository would make a row written by a future build, a migration
 * or a support script indistinguishable from an empty column, and "there is no preference"
 * and "the preference is one we cannot honour" are the two facts plan 10.6 spends
 * `RenderLocale.degraded` keeping apart.
 *
 * The service is where the split happens: the *form value* is narrowed to the eight, and the
 * verbatim string travels on as `messageLocale.requested`.
 *
 * `display_currency` and `display_length_unit` need no such care — both columns are declared
 * with `{ enum }` against `@wewin/core`'s own lists and carry a CHECK built from the same
 * import, so Postgres and TypeScript are quoting one authority.
 *
 * ── No `select` builder for a "does the row exist" question ──────────────────────
 *
 * A missing row means "no preference" and is a first-class answer, not a 404 — see the
 * header of `packages/db/src/schema/profile.ts` for why no row is created at signup. Every
 * method here therefore returns the row or `null` and never throws on absence.
 */

/** Exactly the four columns, as Postgres holds them. */
export interface StoredPreferences {
  /** Verbatim. May be a tag this build has no catalogue for; the service decides what to do. */
  readonly preferredLocale: string | null;
  readonly displayCurrency: Currency | null;
  readonly displayLengthUnit: LengthUnit | null;
  readonly updatedAt: Date;
}

/** What a write asks for. All three `null` is not representable here — that is a delete. */
export interface PreferencesPatch {
  readonly preferredLocale: string | null;
  readonly displayCurrency: Currency | null;
  readonly displayLengthUnit: LengthUnit | null;
}

const COLUMNS = {
  preferredLocale: userPreferences.preferredLocale,
  displayCurrency: userPreferences.displayCurrency,
  displayLengthUnit: userPreferences.displayLengthUnit,
  updatedAt: userPreferences.updatedAt,
} as const;

@Injectable()
export class ProfileRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async read(userId: string): Promise<StoredPreferences | null> {
    const [row] = await this.db
      .select(COLUMNS)
      .from(userPreferences)
      .where(eq(userPreferences.userId, userId))
      .limit(1);

    return row ?? null;
  }

  /**
   * Insert or replace, in one statement.
   *
   * `onConflictDoUpdate` and not "read then decide": two requests from the same person —
   * two tabs, or a form saved twice on a slow connection — would otherwise race between the
   * read and the write, and the loser's insert fails on the primary key with a 23505 that
   * has nothing to do with anything the customer did.
   *
   * `updatedAt` is set explicitly on the conflict branch. The column's `defaultNow()` only
   * fires on insert, so an update without this line would leave a preference changed today
   * carrying the timestamp of the day it was first set — which is exactly the field a
   * support conversation about "when did my language change" would reach for.
   *
   * Every write is `WHERE user_id = <the caller's own id>` by construction: the id is the
   * primary key and it comes from `scope.userId`, which came from a verified access token.
   * There is no request shape that names somebody else's row.
   */
  async replace(userId: string, patch: PreferencesPatch): Promise<StoredPreferences> {
    const [row] = await this.db
      .insert(userPreferences)
      .values({ userId, ...patch })
      .onConflictDoUpdate({
        target: userPreferences.userId,
        set: { ...patch, updatedAt: new Date() },
      })
      .returning(COLUMNS);

    if (!row) {
      // `RETURNING` on an upsert that conflicted and updated always yields a row. Reaching
      // here means the statement did neither, which is not a state to paper over with a
      // second read.
      throw new Error('user_preferences upsert returned no row');
    }
    return row;
  }

  /**
   * Forget this person's preferences.
   *
   * A DELETE and not an UPDATE to all-null, because `user_preferences_says_something` refuses
   * a row that prefers nothing — and that CHECK is what keeps "chose nothing" and "chose the
   * defaults" distinguishable. The schema's header spends a paragraph on it.
   *
   * Answers whether a row went, so the controller can be honest about a no-op without
   * turning "you had no preferences" into an error.
   */
  async clear(userId: string): Promise<boolean> {
    const removed = await this.db
      .delete(userPreferences)
      .where(eq(userPreferences.userId, userId))
      .returning({ userId: userPreferences.userId });

    return removed.length > 0;
  }
}
