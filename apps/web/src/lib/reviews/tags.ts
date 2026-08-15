/**
 * The cache tags a product page carries — **named once, so the reader and the writer
 * cannot drift apart.**
 *
 * This module is small on purpose and it is the hinge of plan 9.5. The storefront runs
 * `revalidate = false` (see `app/[locale]/layout.tsx`), so a product page is built once and
 * served until something explicitly says otherwise. "Something explicitly says otherwise"
 * is `revalidateTag`, and a tag is a **string agreed between two files that never import
 * each other**: the `fetch` that reads the reviews, and the route handler that invalidates
 * them. A typo in either is not an error anywhere — it is a page that silently never
 * updates, which is the failure mode plan 8.2 opens with.
 *
 * So neither side is allowed to write the string. `lib/reviews/api.ts` tags its fetch with
 * `tagsForProduct(id)`; `app/api/revalidate/route.ts` pokes `tagsForProduct(id)`;
 * `tests/reviews.test.ts` asserts that the two are the same call and that the strings are
 * shaped the way the plan names them. Change the spelling here and both halves move
 * together, which is the only arrangement in which "deliberate invalidation" is a property
 * rather than an intention.
 *
 * ── Two tags, not one, and the difference is which fact went stale ───────────────
 *
 * `product:<id>` is the tag plan 8.2 names, and it means *the catalogue changed* — a new
 * version published from the dashboard, a price moved. Nothing on this storefront reads a
 * price from a fetch yet (prices are compiled in from `@wewin/core/fixtures`; the long note
 * in `ProductCard` is the argument), so poking it today re-renders a page into the same
 * bytes. It is attached anyway, because the day a price does come from a fetch is the day
 * somebody needs this tag to already exist and already be poked by the dashboard.
 *
 * `reviews:<id>` means *what customers said changed* — a review published, hidden,
 * unhidden, replied to. It is separate so that a review appearing cannot masquerade as a
 * price being fresh, and so that a catalogue publish does not have to claim it refreshed
 * opinions it never read.
 */

/** The catalogue tag from plan 8.2 — "the product changed". */
export const productTag = (productId: string): string => `product:${productId}`;

/**
 * ⭐ The catalogue tag keyed by **slug**, for the one fetch that cannot use the id.
 *
 * `loadPublishedProduct` asks `GET /catalog/products/:slug` for a product the fixtures do
 * not contain — and a `fetch` must carry its tags at call time, while the product id only
 * arrives in the response body. Keying that entry by slug is the only spelling available to
 * it.
 *
 * ⚠️ A slug is not a stable identity the way an id is: changing a product's slug changes
 * which entry this names. That is acceptable here because a slug change already invalidates
 * the URL itself — the old page is gone either way — whereas keying reviews or a price by
 * slug would silently strand them.
 */
export const productSlugTag = (slug: string): string => `product-slug:${slug}`;

/**
 * ⭐ The whole published catalogue — what the list page depends on.
 *
 * One tag rather than one per product, because the list is one cache entry: a product added,
 * renamed or unpublished changes that entry, and there is nothing finer to invalidate.
 */
export const catalogTag = (): string => 'catalog:published';

/** The review tag — "what customers said about this product changed". */
export const reviewsTag = (productId: string): string => `reviews:${productId}`;

/**
 * Every tag one product's page depends on.
 *
 * Both halves call this and neither builds a tag by hand. A caller that only wants to
 * invalidate reviews still pokes both: the cost is re-rendering a page into identical
 * bytes, and the alternative is a caller deciding which facts moved, from the outside,
 * without the page in front of it.
 */
export const tagsForProduct = (productId: string): readonly string[] => [
  productTag(productId),
  reviewsTag(productId),
];
