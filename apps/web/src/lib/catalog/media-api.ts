import { productTag } from '@/lib/reviews/tags';
import { reviewsApiBaseUrl } from '@/lib/reviews/api';

import type { ProductMedia } from './gallery';

/**
 * ⭐ 0052. One product's pictures and video, read from the API at build time.
 *
 * ── Why this is a fetch when the rest of the catalogue is compiled in ────────────
 *
 * Everything else on a product page comes from `@wewin/core/fixtures` — the name, the price,
 * every option — and that is what keeps 648 pages prerendered with no API in the build. The
 * pictures cannot come from there: they are attached in the dashboard, stored in
 * `product_images`, and a fixture file cannot know about a photograph somebody uploaded this
 * morning. So this is the second fetch on the storefront, and it is modelled exactly on the
 * first (`lib/reviews/api.ts`), down to the failure handling.
 *
 * ⚠️ **Every failure returns `null`, and none of them throws.** A build machine with no API
 * beside it must still produce 648 working pages — a product page without its gallery is a
 * product page, and a build that fails because an image list could not be fetched is not.
 * This is the same argument `reviewsApiBaseUrl` makes for returning `null` rather than
 * throwing, and it is why the storefront can be built from a clean checkout.
 *
 * ⭐ **The tag was already waiting.** `lib/reviews/tags.ts` has shipped `product:<id>` since
 * plan 8.2 and says in its own comment that nothing reads a fetch keyed by it *yet*, and
 * that it is poked anyway "because the day a price does come from a fetch is the day
 * somebody needs this tag to already exist and already be poked". This is that fetch. The
 * publish path in the dashboard already invalidates it, so a gallery edited and published
 * reaches the storefront without a redeploy and without a line of new invalidation code.
 */

export type MediaFailure = 'unconfigured' | 'unreachable' | 'refused' | 'malformed';

const warned = new Set<string>();

/** Once per reason per process — 648 identical build-log lines is a log nobody reads. */
function warnOnce(reason: MediaFailure, detail: string): void {
  if (warned.has(reason)) return;
  warned.add(reason);
  console.warn(`[catalog] product gallery hidden on every product page: ${reason} — ${detail}`);
}

/**
 * Read `product` out of a `ProductDocumentWire` body without trusting any of it.
 *
 * Hand-decoded rather than run through `productWireSchema`: this needs three fields out of a
 * body that carries the whole catalogue document — every option group, every rule — and
 * parsing all of it to reach `images` would make an unrelated schema change able to blank
 * the gallery. A field that is missing or the wrong type is simply absent here.
 */
function decodeMedia(body: unknown): ProductMedia | null {
  if (typeof body !== 'object' || body === null) return null;
  const product = (body as { product?: unknown }).product;
  if (typeof product !== 'object' || product === null) return null;

  const row = product as Record<string, unknown>;
  const heroImage = typeof row['heroImage'] === 'string' ? row['heroImage'] : '';

  const rawImages = row['images'];
  const images = Array.isArray(rawImages)
    ? rawImages.filter((path): path is string => typeof path === 'string')
    : [];

  const rawVideo = row['videoUrl'];
  const videoUrl = typeof rawVideo === 'string' && rawVideo !== '' ? rawVideo : null;

  return { images, videoUrl, heroImage };
}

/**
 * The gallery for one product, or `null` when it could not be read.
 *
 * ⚠️ Fetched **by slug** and tagged **by id**. The public endpoint is
 * `GET /catalog/products/:slug`; the invalidation tag is keyed by the catalogue's product
 * id, because that is the spelling the dashboard's publish poke uses. Getting these two
 * crossed produces a page that is served forever and never updates, with nothing anywhere to
 * say so — which is why both come from the caller, who holds the product and knows both.
 */
export async function loadProductMedia(
  slug: string,
  productId: string,
): Promise<ProductMedia | null> {
  const base = reviewsApiBaseUrl();
  if (base === null) {
    warnOnce('unconfigured', 'NEXT_PUBLIC_API_BASE_URL is not set');
    return null;
  }

  let response: Response;
  try {
    response = await fetch(`${base}/catalog/products/${encodeURIComponent(slug)}`, {
      headers: { accept: 'application/json' },
      cache: 'force-cache',
      next: { tags: [productTag(productId)] },
    });
  } catch (cause) {
    warnOnce('unreachable', cause instanceof Error ? cause.message : String(cause));
    return null;
  }

  if (!response.ok) {
    warnOnce('refused', `HTTP ${String(response.status)}`);
    return null;
  }

  try {
    return decodeMedia(await response.json());
  } catch (cause) {
    warnOnce('malformed', cause instanceof Error ? cause.message : String(cause));
    return null;
  }
}
