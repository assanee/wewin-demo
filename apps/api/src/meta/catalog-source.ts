import { Inject, Injectable } from '@nestjs/common';
import { CURRENCIES, type Currency } from '@wewin/core/money';
import type { Database } from '@wewin/db';
// Through @wewin/db and not 'drizzle-orm' directly — see the note in packages/db/src/sql.ts.
import { count } from '@wewin/db/sql';
import { isPublished } from '@wewin/db/publish';
import { categories, productVersions } from '@wewin/db/schema';

import { DRIZZLE } from '../database/database.tokens';

/**
 * What this build serves, counted from the thing it actually serves.
 *
 * This reported `source: 'fixtures'` and counted `@wewin/core/fixtures` until
 * `src/catalog/` started reading Postgres — at which point it became the most misleading
 * field in the API, because /meta would have gone on answering "81 products" from the TS
 * table with an empty database underneath it. A status endpoint describing something
 * other than what the service does is worse than no status endpoint, so the counts are
 * now queries. The fixture table is the *seed* (see `@wewin/db/seed`); nothing in the
 * request path imports it, and that is what makes the fidelity suite a real comparison.
 *
 * It is still the CommonJS-requires-ESM bridge in production code rather than in a test,
 * and more of one than before: `@wewin/core` and `@wewin/db` are both ESM-only and both
 * are required here at module load. If that arrangement breaks, this app stops booting,
 * loudly, instead of failing later in some rarely-hit branch.
 */
export interface CatalogCounts {
  /** Versions in `published` state — one per product, so also the size of the catalogue. */
  readonly publishedProducts: number;
  readonly categories: number;
}

export interface CatalogSourceInfo {
  readonly source: 'database';
  /**
   * `null` when the database did not answer, never `0`. "Nothing is published" and "the
   * query failed" are different facts, and a status page that renders them the same way
   * turns an outage into a plausible-looking empty catalogue. /health is where the reason
   * lives; /meta stays 200 either way, because the rest of what it reports — the version,
   * the wire conventions — is true of a process that is running regardless.
   */
  readonly counts: CatalogCounts | null;
  readonly currencies: readonly Currency[];
  readonly units: {
    /** Lengths on the wire are integer micrometres (plan 4.1). */
    readonly length: 'micrometre';
    /** Amounts on the wire are integer minor units, as strings, with their currency (plan 4.3). */
    readonly money: 'minor-units';
  };
}

@Injectable()
export class CatalogSourceService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async info(): Promise<CatalogSourceInfo> {
    return {
      source: 'database',
      counts: await this.counts(),
      currencies: CURRENCIES,
      units: { length: 'micrometre', money: 'minor-units' },
    };
  }

  private async counts(): Promise<CatalogCounts | null> {
    try {
      const [published] = await this.db
        .select({ total: count() })
        .from(productVersions)
        .where(isPublished);
      const [category] = await this.db.select({ total: count() }).from(categories);

      /*
       * `Number(...)`, even though drizzle types `count()` as a number. Postgres answers
       * `count(*)` as int8 and this pool's type parser turns every int8 into a bigint
       * (src/database/pg-types.ts) — which drizzle's own `mapWith(Number)` then converts,
       * but only while that mapper is in the path. Narrowing here means a bigint can
       * never reach `JSON.stringify`, which throws on one and would take out /meta.
       */
      return {
        publishedProducts: Number(published?.total ?? 0),
        categories: Number(category?.total ?? 0),
      };
    } catch {
      // Deliberately swallowed. /meta answers "what is running"; a database that is down
      // is /health's answer to give, and this endpoint failing with it would take away
      // the version and conventions somebody is reading it to find out.
      return null;
    }
  }
}
