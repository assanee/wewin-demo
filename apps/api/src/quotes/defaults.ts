/**
 * ⚠️ THE NUMBERS ON THIS PAGE ARE DEFAULTS, NOT DECISIONS — plan section 13.
 *
 * The same rule, and the same file name, as `src/orders/defaults.ts`: plan 13 exists because
 * the "sales can edit anything" design round produced more than thirty invented numbers that
 * read like answers. Every constant here names the question it is standing in for, and none
 * of them is a column default in Postgres.
 */

/**
 * The lead time a quote promises when nobody has overridden it — plan 13, and **not in it**.
 *
 * Said plainly: there is no lead time anywhere in this system. `grep -rn 'lead_time'` over
 * `packages/core`, `packages/db` and `apps/api` returns nothing outside 5c, the catalogue
 * carries no manufacturing time per product, and the factory has never been asked. So this
 * is not even a plan 13 default; it is this module's floor under a hole the schema opens by
 * making `lead_time_days` an anchor.
 *
 * The anchor is right to exist — plan 7.9(ค) lists lead time among the things sales sets, and
 * a second override mechanism for the one promise that is not money is precisely plan 7.13's
 * opening finding. What the anchor needs and does not have is a *baseline*, because
 * `quote_overrides_value_shape` requires `computed_days` beside `override_days`: an override
 * with no baseline cannot be re-verified, and a baseline nobody computed is this constant.
 *
 * 30 days is chosen to be a number a salesperson will immediately recognise as wrong for
 * their product and correct by hand, which is the most useful thing a placeholder can be.
 * **The real answer is per product and belongs in the catalogue document**, at which point
 * this constant is deleted and `computedDays` comes from the same place `computedTotal` does.
 */
export const DEFAULT_LEAD_TIME_DAYS = 30;

/**
 * The largest lead time a human may promise, in days.
 *
 * A bound on a request field and not a business rule — `override_days` is a Postgres
 * `integer` and the CHECK only requires it to be non-negative, so without this a typo turns
 * into a delivery date in the year 7000 on a document that is then frozen. Five years.
 */
export const MAX_LEAD_TIME_DAYS = 1825;

/**
 * How many lines one quote may carry.
 *
 * A request-size bound of the same kind as `submitOrderRequestSchema`'s `.max(100)`, restated
 * here because that one bounds a single submit body and this one bounds an accumulation: a
 * hundred separate `POST …/quote/lines` calls reach the same place one body of a hundred
 * lines would. Each line costs a `calcPrice` on every subsequent read of the quote.
 */
export const MAX_QUOTE_LINES = 100;
