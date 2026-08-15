import type { ProductDocumentWire } from '@wewin/contract/catalog';
import { toProduct } from '@wewin/contract/catalog';
import type { Product } from '@wewin/core';

import { catalogTag, productSlugTag } from '@/lib/reviews/tags';
import { reviewsApiBaseUrl } from '@/lib/reviews/api';

/**
 * ⭐ A product that exists only in the database — fetched, so the shop can sell it.
 *
 * ── The problem this closes ─────────────────────────────────────────────────────
 *
 * Every page under `/products/[slug]` is prerendered from `@wewin/core/fixtures`, and
 * `generateStaticParams` enumerates the 81 products compiled into the bundle. A product
 * created in the dashboard is therefore **published, served correctly by
 * `GET /catalog/products/:slug`, and answered 404 by the shop** — verified before this
 * change: a fixture slug returned 200 and two dashboard-created slugs returned 404, one of
 * them created by the copy flow months before any of this round's work. "Add a product" was
 * a back-office capability that produced nothing a customer could buy.
 *
 * ── Why this is a fallback and not a migration ──────────────────────────────────
 *
 * ⚠️ The 81 keep their current path exactly: `getProductBySlug` from the compiled fixtures,
 * no fetch, byte-identical output, and a build that still needs no API. Only a slug the
 * fixtures do not know reaches this module. That is not timidity — it is what keeps three
 * properties that were paid for and are easy to lose:
 *
 *   · `generateStaticParams` stays **synchronous**, so the 648 pages are still enumerated at
 *     build with no network. (`tests/configurator-render.test.ts` calls it synchronously and
 *     counts 81; an async version fails with "expected Promise{…} to have property length".)
 *   · `generateMetadata` does not fetch for a fixture product, so the metadata tests keep
 *     working in an environment with no fetch stub and no network.
 *   · A build machine with no API beside it still produces a working shop.
 *
 * The full migration — the list page, the home page, and the 81 themselves reading from the
 * database — is a larger change and is named in the commit rather than smuggled in here.
 *
 * ── Caching ─────────────────────────────────────────────────────────────────────
 *
 * `force-cache` plus `productTag(id)`, the same pair `loadProductMedia` and
 * `loadProductReviews` use. ⛔ The tag is built by `productTag`, never spelled here:
 * `tests/reviews.test.ts` fails the suite on a hand-written `product:${…}` literal anywhere
 * outside `tags.ts`, because a tag is a string agreed between two files that never import
 * each other and a typo in either is a page that silently never updates.
 *
 * ⚠️ **Nothing pokes that tag on publish today.** `POST /api/revalidate` exists, is tested,
 * and has zero callers in this repo — `REVALIDATE_TOKEN` is not set anywhere either, so it
 * answers 503. Until a caller exists, a *newly created* product appears as soon as somebody
 * requests it (this fetch runs on the first request for that slug), but an *edit republished*
 * to an already-visited product will not. That gap is real and is stated in the commit.
 */

export interface PublishedProduct {
  readonly wire: ProductDocumentWire;
  readonly productId: string;
  readonly nameTh: string;
  readonly summaryTh: string;
  readonly slug: string;
}

const warned = new Set<string>();

function warnOnce(reason: string, detail: string): void {
  const key = `${reason}:${detail}`;
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[catalog] product not served from the database: ${reason} — ${detail}`);
}

/**
 * One published product from the API, or `null` when there is not one.
 *
 * ⚠️ `null` for every failure, never a throw. The caller answers `notFound()`, which is the
 * right answer for "no published product with that slug" and the least wrong one for "the
 * API is unreachable" — a 500 on a storefront product page is worse than a 404, and the
 * alternative during a build is 648 pages that fail to generate because one slug could not
 * be checked.
 */
export async function loadPublishedProduct(slug: string): Promise<PublishedProduct | null> {
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
      /*
       * ⛔ Keyed by slug, not by id, and `tags.ts` carries the argument. A `fetch` must
       * declare its tags at call time; the product id is in the response body, which does
       * not exist yet. The string is built by the helper and never spelled here —
       * `tests/reviews.test.ts` fails the suite on a hand-written tag literal.
       */
      next: { tags: [productSlugTag(slug)] },
    });
  } catch (cause) {
    warnOnce('unreachable', cause instanceof Error ? cause.message : String(cause));
    return null;
  }

  /* 404 is the normal answer for a slug nobody published. Not worth a warning. */
  if (response.status === 404) return null;
  if (!response.ok) {
    warnOnce('refused', `HTTP ${String(response.status)}`);
    return null;
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    warnOnce('malformed', cause instanceof Error ? cause.message : String(cause));
    return null;
  }

  return decode(body);
}

/**
 * Read the three strings the server half needs and keep the wire intact for the client.
 *
 * ⚠️ Hand-checked at the edges rather than parsed with `productWireSchema`. The wire is
 * handed to the island untouched and decoded there by the package's own `toProduct`, so a
 * second full parse here would buy nothing except a second place for the catalogue's shape
 * to be restated — which is the failure mode this round has already paid for twice. What is
 * checked is exactly what this half reads.
 */
function decode(body: unknown): PublishedProduct | null {
  if (typeof body !== 'object' || body === null) return null;
  const document = body as Record<string, unknown>;
  const product = document['product'];
  if (typeof product !== 'object' || product === null) return null;

  const row = product as Record<string, unknown>;
  const productId = row['id'];
  const nameTh = row['nameTh'];
  const summaryTh = row['summaryTh'];
  const slug = row['slug'];

  if (
    typeof productId !== 'string' ||
    typeof nameTh !== 'string' ||
    typeof summaryTh !== 'string' ||
    typeof slug !== 'string'
  ) {
    warnOnce('malformed', 'the document is missing id, nameTh, summaryTh or slug');
    return null;
  }

  return {
    wire: body as ProductDocumentWire,
    productId,
    nameTh,
    summaryTh,
    slug,
  };
}

/**
 * ⭐ Every published product the fixtures do not contain, as domain products.
 *
 * For the catalogue list. `ProductCard` is a **server** component and takes a `Product`, so
 * `toProduct` runs here and the bigints never approach a serialiser — the boundary problem
 * that shapes the product page does not exist on this route.
 *
 * ⚠️ Returns an empty list on every failure, never a throw. A shop that cannot reach its API
 * shows the 81 it has compiled in, which is a working catalogue; one that throws shows
 * nothing at all.
 *
 * ⚠️ The endpoint answers with **every** published product, including the 81, and returns
 * each one's full document — every option group and every rule. That is more than a list
 * needs and it is unpaginated, which is a real cost the day this catalogue is thousands
 * rather than eighty-two. Noted rather than fixed: adding a list projection to the API is a
 * change to a contract two apps read.
 */
export async function loadProductsNotInFixtures(
  knownSlugs: ReadonlySet<string>,
): Promise<readonly Product[]> {
  const base = reviewsApiBaseUrl();
  if (base === null) {
    warnOnce('unconfigured', 'NEXT_PUBLIC_API_BASE_URL is not set');
    return [];
  }

  let response: Response;
  try {
    response = await fetch(`${base}/catalog/products`, {
      headers: { accept: 'application/json' },
      cache: 'force-cache',
      next: { tags: [catalogTag()] },
    });
  } catch (cause) {
    warnOnce('unreachable', cause instanceof Error ? cause.message : String(cause));
    return [];
  }

  if (!response.ok) {
    warnOnce('refused', `HTTP ${String(response.status)}`);
    return [];
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    warnOnce('malformed', cause instanceof Error ? cause.message : String(cause));
    return [];
  }

  if (typeof body !== 'object' || body === null) return [];
  const list = (body as { products?: unknown }).products;
  if (!Array.isArray(list)) {
    warnOnce('malformed', 'the catalogue list is missing its products array');
    return [];
  }

  const extra: Product[] = [];
  for (const raw of list) {
    const document = decode(raw);
    /*
     * ⛔ The fixtures win for any slug they know. Their pages are prerendered and
     * byte-identical today; decoding the API's copy of the same product instead would put a
     * second source of truth on the busiest page in the shop for no gain.
     */
    if (document === null || knownSlugs.has(document.slug)) continue;
    try {
      extra.push(toProduct(document.wire.product));
    } catch (cause) {
      /* One unreadable product must not cost the whole catalogue. */
      warnOnce('malformed', `${document.slug}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  return extra;
}
