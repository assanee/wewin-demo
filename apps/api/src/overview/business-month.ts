import { sql } from '@wewin/db/sql';
import { BUSINESS_TIME_ZONE } from '@wewin/i18n/locales';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE FIRST INSTANT OF THE CURRENT MONTH, WHERE THE COMPANY IS.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * "รับชำระเดือนนี้" is a claim about a *calendar*, and a calendar belongs to a place.
 * Bangkok is UTC+7, so the first seven hours of every Thai month are still last month in
 * UTC: a boundary written the obvious way —
 *
 *     date_trunc('month', now())              ⟵ wrong
 *
 * — lands seven hours late and drops every payment accepted on the 1st before lunchtime
 * into the month before. Nobody notices for a month, and then the figure for a month that
 * has closed changes, which is the kind of number an accountant stops trusting entirely.
 *
 *     date_trunc('month', now() AT TIME ZONE tz) AT TIME ZONE tz
 *
 * The first `AT TIME ZONE` turns the instant into Bangkok wall-clock time so `date_trunc`
 * cuts on a Thai midnight; the second turns midnight-in-Bangkok back into an instant, which
 * is what `timestamptz` columns are compared against. Same expression twice, opposite
 * directions — that symmetry is the whole trick, and dropping either half type-checks.
 *
 * ── Two clocks, again ────────────────────────────────────────────────────────
 *
 * `now()` is **Postgres's** clock, not this process's, for the reason phase 7 found the
 * expensive way in `order.repository.ts`: two containers hold two clocks, they disagree by
 * tens of milliseconds, and a boundary computed in Node and compared against a column
 * stamped by Postgres is a comparison between two different times. A month boundary is
 * forgiving about 25ms in a way `orders_frozen_after_submitted` was not — but the reason to
 * use one clock does not depend on the tolerance, and the day this expression is reused
 * somewhere tighter is not the day to discover it took the host's.
 *
 * `BUSINESS_TIME_ZONE` is bound as a parameter rather than interpolated: `AT TIME ZONE`
 * takes a `text` expression, so the zone travels as data and there is no string being
 * pasted into SQL.
 */
export const businessMonthStart = sql`date_trunc('month', now() at time zone ${BUSINESS_TIME_ZONE}) at time zone ${BUSINESS_TIME_ZONE}`;
