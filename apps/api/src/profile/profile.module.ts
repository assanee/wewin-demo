import { Module } from '@nestjs/common';

import { ProfileController } from './profile.controller';
import { ProfileRepository } from './profile.repository';
import { ProfileService } from './profile.service';

/**
 * Per-user presentation preferences: locale, currency, measurement unit.
 *
 * No imports. `DatabaseModule` is `@Global()`, so the `DRIZZLE` token is in scope without
 * being asked for, and this module reaches nothing else in the process — not orders, not
 * notifications, not documents. That is the dependency graph agreeing with the rule the
 * service states: a preference cannot become a term of a contract if the module that owns it
 * cannot see one.
 *
 * Nothing is exported either. Two features will eventually want to *read* a preference and
 * neither should do it through this module:
 *
 *   **the notification worker** (plan 10.6, live half) fills
 *   `RecipientLocaleSources.accountLocale`, which is a column in its own query. That seam is
 *   named in `src/i18n/locales.ts` and its own comment says the change is "a repository query
 *   and not this file's shape" — a join, not an injected service, because the worker reads
 *   rows in batches and a per-row service call is a per-row round trip.
 *
 *   **`order-document.ts`** must not read it at all. A document uses the locale pinned at
 *   `submit_for_payment` (plan 10.6, frozen half), and an exported `ProfileService` is
 *   precisely the thing somebody would inject there to "fix" a customer complaint about
 *   language, silently making every reprint a different document.
 *
 * ⚠️ **NOT WIRED INTO `AppModule` BY THIS ROUND — and that is a one-line debt, not a design.**
 *
 * `src/app.module.ts` does not list this module, so against the assembled application
 * `GET /me/preferences` is a 404 today. That is the failure the plan names as the largest
 * finding of two consecutive rounds — 5b left `SlipsModule` and `RefundsModule` out, 5c left
 * `QuotesModule` and `AuthorityModule` out, each time with complete suites passing against a
 * graph the tests booted by hand — and it is being repeated here **knowingly and visibly**
 * rather than accidentally, because wiring it requires editing two files this round does not
 * own while another round is editing them:
 *
 * ── Wired in phase 7's closing commit ────────────────────────────────────────────
 *
 * `AppModule.forRoot` imports this module, and `tests/rbac/route-audit.test.ts` names its
 * three routes. That suite asserts the process's *entire* route inventory with
 * `toStrictEqual`, deliberately, so a new endpoint appears in a diff somebody reads.
 *
 * ⚠️ The audit recorded `GET /me/preferences` as **`[anonymous]`**, not the `[authenticated]`
 * this note first predicted. The controller is right and the prediction was wrong: the GET
 * carries `@AllowAnonymous` on purpose, and `ProfileController` argues it at length. An
 * anonymous caller gets the empty resource — `userIdOrNull` is an exhaustive `matchScope` in
 * which only `user` yields an id — so there is no request in which this route reaches another
 * person's row. Left written down because a note that disagrees with the route table is how
 * the *next* reader talks themselves out of checking.
 *
 * This module's own suite boots `AppModule.forRoot(…)` plus `ProfileModule`, the arrangement
 * `tests/orders/support/lifecycle-app.ts` already uses and explains: the route audit is the
 * alarm, the module suite is the exercise, and the two failing independently is the division
 * of labour to want.
 */
@Module({
  controllers: [ProfileController],
  providers: [ProfileService, ProfileRepository],
})
export class ProfileModule {}
