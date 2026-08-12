import { Controller, Get, Header, HttpCode, Post } from '@nestjs/common';
import { CONTRACT_VERSION, CONTRACT_VERSION_HEADER } from '@wewin/contract/version';
import type { FxManualSyncResultWire, FxRateHealthWire } from '@wewin/contract/organisation';

import { TaxCountryService } from '../organisation/tax-country.service';
import { RequirePermissions } from '../rbac';
import { PermissionRepository } from '../rbac/permission.repository';
import { configuredRates } from './configured-rates';
import { FxRatesRepository } from './fx-rates.repository';
import { FxRatesService } from './fx-rates.service';
import { manualSyncBudget } from './manual-sync';
import {
  FX_RATE_REFUSE_AFTER_HOURS,
  FX_RATE_WARN_AFTER_HOURS,
  fxRateAgeHours,
  fxRateHealthStatus,
} from './staleness';

const contractVersion = (): MethodDecorator =>
  Header(CONTRACT_VERSION_HEADER, String(CONTRACT_VERSION));

/**
 * ⭐ The rate feed's own health, on a screen instead of in a log.
 *
 *     GET /admin/fx/health
 *
 * Layer 1 of the round, and the reason it is a route at all: before this, the only thing that
 * knew a sync had failed was a `logger.warn`, and the only thing that knew *how old* the
 * newest rate was, was arithmetic nobody performed. Both facts existed and neither was
 * reachable by a person, which is the definition of a silent failure.
 *
 * ── Why `admin/fx` and not `admin/organisation/fx-health` ────────────────────────
 *
 * The dashboard renders this as a card on `/organisation`, beside the tax countries whose
 * `fxManualRate` is the way out of a stale rate, so the *screen* is organisation settings and
 * the prefix is arguably wrong. It is here anyway, for a wiring reason that is not cosmetic:
 * `FxModule` imports `OrganisationModule` for `TaxCountryService`, so hanging this off
 * `OrganisationController` would mean `OrganisationModule` importing `FxModule` back and a
 * cycle in the graph. The alternative — exporting `FxRatesRepository` so organisation could
 * read it — breaks the rule `fx.module.ts` states at length: what leaves this module is the
 * *decision*, never the statement layer under it, so that "which observation counts" has
 * exactly one answer. A URL prefix is the cheaper thing to bend.
 *
 * ── `organisation.read`, not a new permission ────────────────────────────────────
 *
 * It is the permission that already opens the screen this renders on and the tax-country rows
 * this is about. A new code would have to be granted to every group that already holds
 * `organisation.read` on day one, which is a migration to express "the same people".
 *
 * ⚠️ **There is now one write route, and it still sets nothing.** This used to say *"read-only,
 * and there is deliberately no companion write route"*, and the reasoning under that sentence is
 * unchanged and still holds: the two thresholds are constants (see `staleness.ts`), and the
 * *rate* is settable only through `PATCH /admin/organisation/tax-countries/:code`, where it lands
 * in `tax_country_changes` with an actor and a before/after. A second way to influence conversion
 * that skipped that history is exactly what this codebase does not have, and `POST sync` is not
 * one: it stores no value anybody chose, it asks the provider for the same number the 01:00 tick
 * would have asked for, and what it writes is an observation with the provider's own timestamp
 * on it. What it *does* spend is quota — see `syncNow` below and `manual-sync.ts`.
 *
 * ── ⭐ WHAT THIS CARD REPORTS THAT IT DID NOT, AND WHY IT IS ON THIS PAYLOAD ──────
 *
 * `configuredRates` puts the *numbers* on the screen beside the feed's *health*. They are one
 * request rather than two because they are one question — "is the rate alright" is not answerable
 * without "and what is it" — and because a second route would let a screen render an age from one
 * moment beside a figure from another.
 *
 * The list is driven from `tax_countries` and not from the ~170 keys the provider sends, and every
 * figure on it is baht-per-unit with the spread already in it rather than the provider's raw
 * USD-based number. `configured-rates.ts` carries the whole argument for both, including why a
 * destination with a manual override gets no derived mid-market figure at all.
 */
@Controller('admin/fx')
export class FxController {
  constructor(
    private readonly rates: FxRatesRepository,
    /* Who could be told, so an empty set is a sentence on this screen rather than a log line
     * nobody reads — see `FxRateHealthWire.warningRecipients`. */
    private readonly people: PermissionRepository,
    /* The destinations whose currencies are the only ones on this card. `FxModule` already
     * imports `OrganisationModule` for exactly this service — see this file's note above on why
     * that import is what puts the route under `admin/fx` rather than under organisation. */
    private readonly countries: TaxCountryService,
    /*
     * ⚠️ `FxRatesService`, injected — and `fx.module.ts` deliberately does **not** export it.
     *
     * That is not a contradiction: this controller is inside `FxModule`, so nothing outside gains
     * reach. The rule that header states is about *callers in other modules* — specifically, that
     * nobody holding a transaction with a row lock open should be able to trigger a provider
     * round-trip. A controller holds no transaction; it is the one caller for which the objection
     * does not apply, which is why the button is a route here rather than a method exported to
     * somewhere more convenient.
     */
    private readonly sync: FxRatesService,
  ) {}

  @Get('health')
  @contractVersion()
  @RequirePermissions('organisation.read')
  async health(): Promise<FxRateHealthWire> {
    /*
     * `new Date()` here rather than a clock injected for testability: this route reports on the
     * real world at the moment it is asked, the pg test drives the age by writing rows with
     * chosen `rate_timestamp`s (which is what a real stale feed does anyway), and an injected
     * clock would be a seam nothing in production ever moves.
     *
     * Read **once** and passed to both the age and the budget, so the card cannot report an age
     * measured at one instant beside a countdown measured at another.
     */
    const now = new Date();

    const [health, warningRecipients, destinations, usage] = await Promise.all([
      this.rates.health(),
      this.people.addressesHolding('organisation.write'),
      /*
       * Every destination, not `activeOnly`. A withdrawn country's rate can still be pinned —
       * `TaxCountryRepository.byCode` has no `is_active` filter and says at length why — so
       * filtering here would hide a number that is still live. `configuredRates` marks them.
       */
      this.countries.list(false),
      this.rates.manualSyncUsage(now),
    ]);
    const newest = health.newest;

    const ageHours = newest === undefined ? null : fxRateAgeHours(newest.rateTimestamp, now);

    return {
      status: fxRateHealthStatus(ageHours),
      ageHours,
      observedAt: newest?.rateTimestamp.toISOString() ?? null,
      fetchedAt: newest?.fetchedAt.toISOString() ?? null,
      consecutiveFailures: health.consecutiveFailures,
      lastFailureAt: health.lastFailureAt?.toISOString() ?? null,
      warnAfterHours: FX_RATE_WARN_AFTER_HOURS,
      refuseAfterHours: FX_RATE_REFUSE_AFTER_HOURS,
      warningRecipients: warningRecipients.length,
      configuredRates: configuredRates(destinations, newest),
      base: newest?.base ?? null,
      manualSync: manualSyncBudget(usage, now),
    };
  }

  /**
   * ⭐ Fetch now, instead of waiting for 01:00.
   *
   * ── ⭐ `organisation.write`, and why not `organisation.read` that opens the screen ─
   *
   * `RequirePermissions` means **every** listed code, so this is one code and not two. It is
   * `organisation.write` for three reasons that all point the same way:
   *
   *   1. **It spends a shared, finite resource.** Ten of these a day is 310 requests a month out
   *      of a plan of 1,000 that the scheduled sync also draws on. Reading a screen costs nothing
   *      and this costs something that runs out, which is the line `organisation.read` and
   *      `organisation.write` are drawn on everywhere else on this page.
   *   2. **It is the same people.** `organisation.write` is already the permission that can end a
   *      stale-rate outage by typing `อัตราแลกเปลี่ยนกำหนดเอง`, it is who the staleness email is
   *      routed to (`FxStalenessService`), and it is what `FxRateHealthWire.warningRecipients`
   *      counts. Whoever is being emailed about a stale rate is exactly who should be able to try
   *      a fetch before reaching for an override.
   *   3. **A new code would be a migration to say "the same people".** `permissions.ts` makes this
   *      argument for the tax-country routes in the same words, and it applies unchanged here.
   *
   * Listing `organisation.read` beside it was considered and rejected: it would be redundant for
   * every group that exists, and for a group holding write without read it would be a surprise
   * 403 on the one action that group most needs — a conjunction quietly narrowing access is the
   * failure mode `RequirePermissions`' own header warns about from the other direction.
   *
   * ⚠️ `@HttpCode(200)` is **required**, not decorative: Nest answers `@Post` with **201** by
   * default, and this creates nothing a client can address. A 201 with no `Location` and a body
   * that is a report rather than a resource is a lie about what happened, and it is the specific
   * lie a caller would build a retry rule on. (`organisation.controller.ts` writes `@HttpCode(201)`
   * explicitly on both of its creates, which reads as though 201 were the exception — it is the
   * default, and this line is what opts out of it.)
   *
   * `@Body` and a zod schema would be a pipe over an empty object — there is nothing to send, and
   * there must not be: a parameter here would be a way to influence what gets fetched, which is
   * the surface `FxHttp` exists to keep closed.
   */
  @Post('sync')
  @HttpCode(200)
  @contractVersion()
  @RequirePermissions('organisation.write')
  async syncNow(): Promise<FxManualSyncResultWire> {
    return this.sync.syncNow(new Date());
  }
}
