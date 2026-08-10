import { reviewsApiBaseUrl } from '../reviews/api';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ WHERE THE ORDER IS GOING, READ FROM THE ONE PLACE THAT KNOWS.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `GET /destinations` is anonymous, active rows only, already ordered by `sort_order` on the
 * server (`apps/api/src/organisation/destinations.controller.ts`) — this module never re-sorts
 * what it gets back.
 *
 * ── ⚠️ Failure degrades to Thailand alone, never to nothing ──────────────────
 *
 * A settings endpoint being down must not stop somebody asking for a price. Every other fetcher
 * in this app (`quotation/api.ts`, `prefillContact.ts`) answers a failure with `null` and lets
 * its caller render nothing; this one cannot, because "nothing" here is an empty `<select>` a
 * customer cannot submit through. So every failure — no API configured, unreachable, a bad
 * status, a body this bundle cannot read — answers with the one destination guaranteed to
 * exist: Thailand, exactly as `DestinationSelect` would default to on its own.
 *
 * ── The unknown-code guard, discovered in Task 9 ─────────────────────────────
 *
 * `POST /orders` accepts any `/^[A-Z]{2}$/` code without checking it against `tax_countries` —
 * deliberately, because validating there would duplicate `resolveDestination`'s interpretation
 * of the table on the anonymous cart path, and because *withdrawn* and *unknown* are a
 * distinction only that resolver can draw. The consequence is that a stale value — a destination
 * pre-filled from a prior order that has since been withdrawn, or any value this app did not
 * itself put there — can reach submit without ever having been one of the options a customer was
 * shown, and the refusal then lands at the API, far from the mistake. `isKnownDestination` is the
 * storefront-side check against the list actually on screen: not a foreign key, and not a second
 * opinion about which countries are valid — only "was this one of the options this customer was
 * shown just now".
 */

/** `DestinationWire` (`@wewin/contract/tax`), restated — `code` and `nameTh`, nothing else. */
export interface Destination {
  readonly code: string;
  readonly nameTh: string;
}

/** The fallback for every failure below, and `DestinationSelect`'s own default. */
export const THAILAND_ONLY: readonly Destination[] = [{ code: 'TH', nameTh: 'ไทย' }];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * `{ destinations: [{code, nameTh}] }` off `GET /destinations` — active rows, `sort_order` as
 * the API applied it. Never re-sorted here, and never resolves to an empty list: a fetch that
 * cannot be read as that shape degrades to `THAILAND_ONLY` exactly as a network failure does.
 */
export async function fetchDestinations(): Promise<readonly Destination[]> {
  const base = reviewsApiBaseUrl();
  if (base === null) return THAILAND_ONLY;

  try {
    const response = await fetch(`${base}/destinations`, {
      headers: { accept: 'application/json' },
      /*
       * ⚠️ `no-store`, the same instinct as `fetchCatalogRefs`'s "what may be ordered *right
       * now*": a country the company just withdrew must not keep being offered for as long as a
       * cached list lives, and this is asked for once, at the moment the form is on screen.
       */
      cache: 'no-store',
    });
    if (!response.ok) return THAILAND_ONLY;

    const body: unknown = await response.json();
    if (!isRecord(body) || !Array.isArray(body['destinations'])) return THAILAND_ONLY;

    const destinations = body['destinations'].flatMap((raw) => {
      if (!isRecord(raw) || typeof raw['code'] !== 'string' || typeof raw['nameTh'] !== 'string') {
        return [];
      }
      return [{ code: raw['code'], nameTh: raw['nameTh'] }];
    });

    return destinations.length > 0 ? destinations : THAILAND_ONLY;
  } catch {
    return THAILAND_ONLY;
  }
}

/**
 * ⭐ Was `code` one of the options this customer was actually shown, just now?
 *
 * Pure and synchronous on purpose — it is the last check before a submit, run against whatever
 * `options` the form already has in hand, never a fresh network call of its own.
 */
export function isKnownDestination(code: string, options: readonly Destination[]): boolean {
  return options.some((option) => option.code === code);
}
