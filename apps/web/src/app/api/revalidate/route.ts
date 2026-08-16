import { revalidateTag } from 'next/cache';

import { catalogTag, productSlugTag, tagsForProduct } from '@/lib/reviews/tags';

/**
 * The write half of plan 9.5 — **and it is written in the commit that also calls it.**
 *
 * The locale layout has carried this note since 6b closed:
 *
 * > There is deliberately no route handler for it here: an invalidation endpoint that
 * > nothing calls is the exact failure plan 7.18(ข) names as the most expensive of its
 * > round — finished, tested, and wired to nothing. It gets written in the commit that
 * > also calls it.
 *
 * This is that commit. `lib/reviews/api.ts` now reads a product's reviews through a
 * tag-cached `fetch`, so there is something to invalidate; `apps/dashboard`'s moderation
 * screen calls this route after moderating, through its own server route handler that holds
 * the secret; and apps/api is expected to call it when a customer's review is accepted.
 *
 * ⚠️ **This paragraph used to say "after every hide, unhide, publish and reply", and one of
 * those four was not true for a year.** `unhideReview` sat in `review-api.ts` with no
 * importer, because hiding a review dropped it out of the moderation queue —
 * `not review_is_moderated(...)` is false the moment `hidden_at` is set — and there was no
 * list that could show a hidden one, so there was nowhere for the button to be. A comment
 * asserting behaviour nothing implements is worse than no comment: it is what a reader
 * checks against instead of the code. The queue now takes `?state=hidden` and the screen has
 * a ที่ซ่อนไว้ tab, so the sentence is true — and this note stays as the record of how long
 * it was not.
 *
 * Reader and writer name their tags with the same function
 * (`lib/reviews/tags.ts`), which is what stops the two drifting into a page that silently
 * never updates.
 *
 * ── What it deliberately does not do ─────────────────────────────────────────────
 *
 * **It does not decide what changed.** The body is a list of product ids and nothing else:
 * no review id, no verb, no "reason". A route that took a verb would be a second copy of
 * the moderation rules, in the app furthest from them, and the first time the two
 * disagreed the storefront would be the one showing the wrong page.
 *
 * **It does not sweep.** A review that publishes itself when its moderation window elapses
 * (plan 9.3) changes a cached page with **no request behind it** — the one direction plan
 * 8.2 does not name and the one this route cannot close on its own, because nothing calls
 * it at that moment. `product_review_schedule` in packages/db says, per product, when the
 * next such change is due; a caller holding those rows can poke exactly this endpoint with
 * exactly those ids. Building a sweep here without one would be the endpoint-with-no-caller
 * failure again, one level up.
 *
 * ── Fail closed ──────────────────────────────────────────────────────────────────
 *
 * With no `REVALIDATE_TOKEN` in the environment this route answers 503 rather than
 * accepting everything. An unauthenticated invalidation endpoint is not a data leak — every
 * page it can rebuild is public — but it is a way to make a static site rebuild 648
 * documents on demand, and "the deployment forgot the variable" must not be the state in
 * which that is possible. The comparison is length-checked and constant-time-ish; a token
 * is not a password, and this is the cheap end of not leaking its prefix through timing.
 */

/** Header the caller presents. Same spelling in `apps/dashboard/src/app/api/storefront-revalidate`. */
export const REVALIDATE_TOKEN_HEADER = 'x-wewin-revalidate-token';

/**
 * A cap on one request, not a business rule.
 *
 * 81 products exist today. A caller that means "everything" is a caller that has lost track
 * of what changed, and a body with ten thousand ids in it is a way to spend a build's worth
 * of rendering on one POST.
 */
export const MAX_PRODUCT_IDS = 200;

/** Two strings compared without an early exit on the first differing byte. */
function tokensMatch(presented: string, expected: string): boolean {
  if (presented.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < presented.length; index += 1) {
    difference |= presented.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

/** The ids in a body, or `null` if the body is not the shape this route accepts. */
/**
 * The optional `slugs` list. `[]` and absent both mean "none"; anything else malformed is
 * `null`, which the handler answers 400 for rather than ignoring — a caller that misspells
 * this field would otherwise believe it had invalidated a page it had not.
 */
export function slugsFrom(body: unknown): readonly string[] | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const value = (body as Readonly<Record<string, unknown>>)['slugs'];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_PRODUCT_IDS) return null;
  if (!value.every((entry) => typeof entry === 'string' && entry.trim() !== '')) return null;
  return [...new Set(value as readonly string[])];
}

export function productIdsFrom(body: unknown): readonly string[] | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const value = (body as Readonly<Record<string, unknown>>)['productIds'];
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PRODUCT_IDS) return null;

  const ids: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry === '') return null;
    ids.push(entry);
  }
  // Duplicates are a caller's bookkeeping, not this route's: poking the same tag twice is
  // harmless and de-duplicating is one line.
  return [...new Set(ids)];
}

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      /* An invalidation is never itself cacheable. */
      'cache-control': 'no-store',
    },
  });

export async function POST(request: Request): Promise<Response> {
  const expected = process.env.REVALIDATE_TOKEN;
  if (expected === undefined || expected === '') {
    return json(
      {
        error: 'unconfigured',
        message: 'REVALIDATE_TOKEN is not set; this route refuses rather than accepting everything.',
      },
      503,
    );
  }

  /*
   * `request.headers`, not `headers()` from `next/headers`. Identical result here, and the
   * scan in `tests/cache-policy.test.ts` refuses the second spelling anywhere under
   * `src/app` because in a *page* it is what silently turns a prerendered route dynamic.
   * A route handler that reached for it would teach the next reader the wrong habit.
   */
  const presented = request.headers.get(REVALIDATE_TOKEN_HEADER);
  if (presented === null || !tokensMatch(presented, expected)) {
    return json({ error: 'forbidden' }, 403);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'malformed', message: 'body is not JSON' }, 400);
  }

  const productIds = productIdsFrom(body);
  if (productIds === null) {
    return json(
      {
        error: 'malformed',
        message: `expected { productIds: string[] } with 1…${MAX_PRODUCT_IDS} entries`,
      },
      400,
    );
  }

  /*
   * ⭐ Slugs as well as ids, because the catalogue reads by slug and the reviews read by id.
   *
   * `loadPublishedProduct` fetches `/catalog/products/:slug` and must therefore tag that
   * entry by slug — a `fetch` declares its tags before the body that carries the id exists.
   * A caller that sent only ids would refresh the reviews of a product whose *page* stayed
   * frozen, which is the confusing half of a half-invalidation.
   *
   * ⚠️ Optional, so every existing caller and test keeps working unchanged.
   */
  const slugs = slugsFrom(body);
  if (slugs === null) {
    return json({ error: 'malformed', message: 'slugs must be an array of non-empty strings' }, 400);
  }

  const tags = [
    ...productIds.flatMap((productId) => [...tagsForProduct(productId)]),
    ...slugs.map((slug) => productSlugTag(slug)),
    /*
     * Always, and unconditionally. Any product changing — added, renamed, repriced,
     * unpublished — changes the one cache entry the catalogue list is built from, and there
     * is nothing finer to invalidate. A caller cannot forget it because it is not theirs to
     * send.
     */
    catalogTag(),
  ];

  /*
   * De-duplicated across the whole list, not just within the ids. Two products in one call
   * share the catalogue tag, and poking it twice would be two invalidations of one entry —
   * harmless, and still the kind of thing the echoed response should not claim happened.
   */
  const poked = [...new Set(tags)];
  /*
   * `'max'` is Next 16's `cacheLife` profile argument, which became **required** in 16.0 —
   * `revalidateTag(tag)` on its own no longer compiles. It is the widest profile, which is
   * the right one here: this route is told "this product changed", not "this product
   * changed for readers who are at most a minute behind".
   *
   * Not `updateTag`, which is the Server Action spelling for read-your-writes — the caller
   * here is another service, and the thing it is about to read is not this response.
   */
  for (const tag of poked) revalidateTag(tag, 'max');

  /*
   * The tags are echoed back. A caller that pokes a product id the storefront has never
   * heard of gets a 200 and a list it can compare — `revalidateTag` has no notion of a tag
   * that was never used, so this response is the only place a typo can be seen at all.
   */
  return json({ revalidated: poked }, 200);
}
