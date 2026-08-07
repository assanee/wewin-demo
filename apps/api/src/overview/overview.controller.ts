import { Controller, Get, Header } from '@nestjs/common';
import { CONTRACT_VERSION, CONTRACT_VERSION_HEADER } from '@wewin/contract/version';

import { CurrentScope, RequireAuthenticated, type Scope } from '../rbac';
import type { OverviewWire } from './overview.contract';
import { OverviewService } from './overview.service';

const contractVersion = (): MethodDecorator =>
  Header(CONTRACT_VERSION_HEADER, String(CONTRACT_VERSION));

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The one screen that reads across every subsystem.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *     GET /overview     the cards this caller is entitled to, and no others
 *
 * ── ⚠️ WHY IT IS NOT UNDER `/admin` ──────────────────────────────────────────
 *
 * It was, for one commit, and `tests/admin/route-permissions.test.ts` refused it:
 * **"never reaches an admin route without a permission"**. That rule is worth keeping
 * absolute — its job is to catch a copy-pasted `@AllowAnonymous` on a write endpoint, and a
 * rule with one documented exception is a rule with a shape somebody has to remember.
 *
 * The test was right and the path was wrong. Every other `/admin/*` route is one
 * administrative capability, named, with the permission it needs written on it. This is not
 * a capability at all — it is a digest of what the caller is already entitled to see,
 * which puts it in `/me`'s family rather than `/admin`'s.
 *
 * ── ⚠️ WHY THIS ROUTE ASKS FOR NO PERMISSION ─────────────────────────────────
 *
 * `@RequireAuthenticated()` and no `@RequirePermissions`, which looks like a gap and is the
 * design. There is no permission that means "may see the overview": the screen is a
 * different screen for a catalogue editor and for a finance lead, and any single code
 * chosen here would be wrong for one of them — too tight and the page 403s for people who
 * should see *something*, too loose and it becomes the one endpoint that reads across
 * everything.
 *
 * The gate is `sections.ts`, one entry per card, each holding the permissions of the queue
 * its number is about. `overview.service.ts` never fetches a card the caller may not see,
 * so an unpermitted count does not exist in this process, let alone in the response.
 *
 * A session is still required. The counts are about the company's work, and "how many
 * orders are in production" is not a public fact — `route-audit.test.ts` records this route
 * as `[authenticated]`, so removing the decorator changes a line in a test rather than
 * quietly opening the page to crawlers.
 *
 * ── Cache-Control ────────────────────────────────────────────────────────────
 *
 * `no-store`, like `/me/account`. The response is per-caller by construction — two people
 * signed in at the same moment get different key sets — so anything that caches it by URL
 * would serve one person's entitlements to another.
 */
@Controller('overview')
export class OverviewController {
  constructor(private readonly overview: OverviewService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @contractVersion()
  @RequireAuthenticated()
  async read(@CurrentScope() scope: Scope): Promise<OverviewWire> {
    return this.overview.overview(scope);
  }
}
