import { Injectable, Logger } from '@nestjs/common';

/**
 * ⭐ Telling the storefront that a product changed.
 *
 * ── The gap this closes ─────────────────────────────────────────────────────────
 *
 * The storefront runs `revalidate = false`: a page is built once and served until something
 * explicitly says otherwise. `POST /api/revalidate` over there is the "something", it has
 * been shipped and tested since plan 9.5 — and **nothing has ever called it.** Its own
 * docblock names `apps/dashboard/src/app/api/storefront-revalidate` as the caller that holds
 * the secret; that route does not exist, and `apps/dashboard` has no `app/api` directory at
 * all. So a product republished with a new price kept showing the old one until a redeploy,
 * with nothing anywhere to say so.
 *
 * ── Why the API calls it and not the dashboard ──────────────────────────────────
 *
 * The dashboard is where somebody *presses publish*; this service is where a publish
 * **commits**. Those are not the same event: a publish can be triggered by a script, by a
 * future API client, or by a retry the dashboard never saw the end of. Hanging the poke off
 * the commit means it happens once per actual change, whoever caused it.
 *
 * ── It can never fail a publish ─────────────────────────────────────────────────
 *
 * ⛔ Called **after** the transaction commits, and every failure is a log line. The version
 * is frozen and the customer-facing document is correct the moment this runs; a storefront
 * that is down, slow, or not configured is a stale cache, not a bad publish. Throwing here
 * would turn "the shop will update in a minute" into "your publish failed", which is a lie
 * that also loses the work.
 *
 * ⚠️ Unconfigured is silence, not an error. Plenty of deployments — every test run, every
 * developer's laptop, the CI database — have no storefront to tell. It says so once per
 * process so a *production* misconfiguration is visible in a log, and then stops.
 */

/** Same spelling as `apps/web/src/app/api/revalidate/route.ts`. Changing one breaks both. */
const TOKEN_HEADER = 'x-wewin-revalidate-token';

/**
 * How long to wait before giving up.
 *
 * Short on purpose. This runs inside a request that has already done its real work, and the
 * caller is a person watching a publish button — an invalidation that takes longer than this
 * is one that should be a log line rather than a delay somebody feels.
 */
const TIMEOUT_MS = 3_000;

@Injectable()
export class StorefrontRevalidateService {
  private readonly logger = new Logger(StorefrontRevalidateService.name);
  private warnedUnconfigured = false;

  /**
   * Tell the storefront that these products changed. Never throws.
   *
   * Both spellings are sent: the id, which the reviews and gallery entries are keyed by, and
   * the slug, which the product page's own fetch is keyed by. Sending one without the other
   * refreshes half of a page and is worse than refreshing neither, because it looks like it
   * worked.
   */
  async productChanged(productId: string, slug: string): Promise<void> {
    const url = process.env['STOREFRONT_REVALIDATE_URL'];
    const token = process.env['REVALIDATE_TOKEN'];

    if (url === undefined || url === '' || token === undefined || token === '') {
      if (!this.warnedUnconfigured) {
        this.warnedUnconfigured = true;
        this.logger.log(
          'STOREFRONT_REVALIDATE_URL or REVALIDATE_TOKEN is unset — publishing will not refresh the storefront cache. Fine on a laptop; a misconfiguration in production.',
        );
      }
      return;
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [TOKEN_HEADER]: token },
        body: JSON.stringify({ productIds: [productId], slugs: [slug] }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (!response.ok) {
        /*
         * 403 means the two halves disagree about the token; 503 means the storefront has
         * none. Both are worth a warning naming the status, because the symptom otherwise is
         * "the shop is stale" with no clue which side is wrong.
         */
        this.logger.warn(
          `storefront revalidation refused for ${productId}: HTTP ${String(response.status)}`,
        );
      }
    } catch (cause) {
      this.logger.warn(
        `storefront revalidation failed for ${productId}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }
}
