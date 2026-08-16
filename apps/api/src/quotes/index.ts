/**
 * What the rest of the app imports from the sales-editable quote — phase 5c.
 *
 * The surface is small and what is missing from it is deliberate: `QuoteRepository` is wiring,
 * and a module that reached for it would be a second thing writing `quote_overrides`. The
 * append-only rule and the stamp-then-insert order the partial unique index forces hold only
 * while there is one path through them.
 *
 * **Nothing here answers "was this allowed?".** That is `src/quotes/authority`, which owns
 * `authority_limits`, `approvals` and both ceiling dimensions, and this module deliberately
 * does not have a second copy of it — plan 7.13's opening finding is the same mechanism
 * written six times. See the note on the concession below.
 *
 * The pure functions *are* exported, because they carry decisions other rounds need to read
 * rather than re-derive:
 *
 *   `applyOverrides`   the single function producing the effective money. The dashboard's
 *                      preview and any future report must not each grow their own cascade.
 *   `worksOrderLines`  the projection a production sheet renders from — sku and resolved
 *                      options, never sales prose (plan 7.9(ค)'s ⚠️).
 *   `normaliseEntry`   the one place a typed figure becomes an anchor value (plan 7.9(ข)).
 *
 * ═════════════════════════════════════════════════════════════════════════════════
 * ⚠️  THE TWO SEAMS THIS MODULE SHIPPED WITH OPEN, AND WHAT CLOSED THEM
 * ═════════════════════════════════════════════════════════════════════════════════
 *
 * Both were in `apps/api/src/orders`, and both are closed. They are written down here rather
 * than deleted, because "complete and unreachable" is the largest finding two phases running
 * and the note is what makes the next one visible.
 *
 * **① `AppModule.forRoot` now imports `QuotesModule`.** Until it did, every route in
 * `quotes.controller.ts` was a 404 in the assembled application — exactly as `SlipsModule` and
 * `RefundsModule` were for the whole of 5b.
 *
 * **② `OrdersService.submit` now calls `assertSubmittable` and prices `quote_lines`.**
 *
 *   *The gate.* Plan 7.9(จ): *"ตอน pin ต้อง re-verify ทุก override ว่า baseline ยังตรง"*. It runs
 *   inside the pin transaction, on the locked row, and it throws `409` with every affected line
 *   when a publish landed underneath a promise — and an **integrity alarm**, not a 409, when
 *   `calcPrice` returns a different figure from a catalogue document that did not change.
 *   `POST …/quote/verification` is the same check as a screen, and a check a client may decline
 *   to call is not a gate.
 *
 *   *The source of the lines.* Submit priced `body.lines` — the browser's cart — and never read
 *   `quote_lines` at all, so a quote edited through this module was not the quote that got
 *   pinned: ฿1.07 on the screen against ฿14,791.68 on the order row, on one real order. It now
 *   prices the quote, always; `body.lines` is optional and is *adopted into* the quote on the
 *   way in, and is refused outright when a quote already exists.
 *
 * ⚠️ The gate above is the **staleness** half only. The **authority** half is
 * `AuthorityService.gate`, called in the same transaction *after* the document is pinned — see
 * `authority/index.ts`. Two calls, not one, because they answer different questions and fail at
 * different moments: a stale baseline must stop the pin, and an unapproved concession can only
 * be measured once the revision exists.
 *
 * ═════════════════════════════════════════════════════════════════════════════════
 * ⚠️  ONE MEASUREMENT OF A CONCESSION, AND THE THREE WAYS THERE WERE TWO
 * ═════════════════════════════════════════════════════════════════════════════════
 *
 * `applyOverrides` used to produce `marginConcessionThbMinor` as one subtraction — the untouched
 * document less the effective one — while `authority/concession.ts` produced the same quantity
 * as a sum of named sources. The claim in this file was that *"both are right, they agree"*,
 * kept by `tests/quotes/concession-agreement.test.ts`.
 *
 * They did not agree, in three cases and in both directions:
 *
 *   netting             line A up ฿10,000, line B down ฿10,000: subtraction ฿0, sum ฿10,700.
 *   a stale document baseline
 *                       subtraction ฿19,628.61, sum ฿0.00, on plan 7.9's own figures.
 *   write order         a document promise written before a line promise, or a line promise
 *                       revoked from under one: ±฿1,070 on identical rows.
 *
 * `measureMargin` is the only one now. The subtraction is deleted, `applyOverrides` returns
 * money and a baseline to render, and the agreement test is gone with the thing it certified.
 * The write-order case is closed at the source by `0018_quote_document_freeze.sql`, and the
 * stale-baseline case by `verifyBaselines` now checking the document anchor.
 */

export { QuotesModule } from './quotes.module';
export { QuotesService } from './quotes.service';

export {
  applyOverrides,
  baselineMatches,
  type ApplyOverridesInput,
  type ChargeLine,
  type ComputedLine,
  type EffectiveLine,
  type EffectiveMoney,
  type EffectiveQuote,
  type LiveOverride,
} from './overrides';

export { normaliseCharge, normaliseEntry, EntryError, type NormalisedEntry } from './entry';

export { worksOrderLines, type WorksOrderLine, type WorksOrderSource } from './works-order';

export { quoteRevision } from './revision';

export { verifyBaselines, type VerificationInput } from './verification';

export {
  QUOTE_BASELINES_STALE,
  QUOTE_STALE,
  baselinesStale,
  catalogStale,
  integrityAlarm,
  quoteHasMoney,
  quoteStale,
} from './errors';

export {
  DEFAULT_LEAD_TIME_DAYS,
  MAX_LEAD_TIME_DAYS,
  MAX_QUOTE_LINES,
} from './defaults';

export { translateQuoteError, withTranslatedQuoteErrors, type QuoteOperation } from './pg-errors';
