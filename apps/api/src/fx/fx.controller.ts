import { Controller, Get, Header } from '@nestjs/common';
import { CONTRACT_VERSION, CONTRACT_VERSION_HEADER } from '@wewin/contract/version';
import type { FxRateHealthWire } from '@wewin/contract/organisation';

import { RequirePermissions } from '../rbac';
import { FxRatesRepository } from './fx-rates.repository';
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
 * ⚠️ Read-only, and there is deliberately no companion write route. The two thresholds are
 * constants (see `staleness.ts`, which also records what making them settable would take);
 * the *rate* is settable, but through `PATCH /admin/organisation/tax-countries/:code` where it
 * lands in `tax_country_changes` with an actor and a before/after. A second way to influence
 * conversion that skipped that history is exactly what this codebase does not have.
 */
@Controller('admin/fx')
export class FxController {
  constructor(private readonly rates: FxRatesRepository) {}

  @Get('health')
  @contractVersion()
  @RequirePermissions('organisation.read')
  async health(): Promise<FxRateHealthWire> {
    const health = await this.rates.health();
    const newest = health.newest;

    /*
     * `new Date()` here rather than a clock injected for testability: this route reports on the
     * real world at the moment it is asked, the pg test drives the age by writing rows with
     * chosen `rate_timestamp`s (which is what a real stale feed does anyway), and an injected
     * clock would be a seam nothing in production ever moves.
     */
    const ageHours = newest === undefined ? null : fxRateAgeHours(newest.rateTimestamp, new Date());

    return {
      status: fxRateHealthStatus(ageHours),
      ageHours,
      observedAt: newest?.rateTimestamp.toISOString() ?? null,
      fetchedAt: newest?.fetchedAt.toISOString() ?? null,
      consecutiveFailures: health.consecutiveFailures,
      lastFailureAt: health.lastFailureAt?.toISOString() ?? null,
      warnAfterHours: FX_RATE_WARN_AFTER_HOURS,
      refuseAfterHours: FX_RATE_REFUSE_AFTER_HOURS,
    };
  }
}
