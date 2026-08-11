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
 *
 * ── ⚠️ "Not yet on the list" is not "not on the list" — a review-round finding ────
 *
 * The guard above answers a question that only makes sense once the read has actually settled.
 * A first cut of this module let the caller reach for `isKnownDestination` against whatever
 * options state happened to hold at the moment `send()` ran — and the pre-fill effect and this
 * module's own fetch are two independent, unsequenced requests. Hold `GET /destinations` open
 * while a returning customer's fast pre-fill sets `destinationCountry` to `'SG'`, and the
 * component's options were still sitting at their initial value: indistinguishable, by content
 * alone, from "the read failed and degraded to Thailand". The guard fired, told the customer to
 * choose again, and the only option visibly on screen was Thailand — so a customer who did
 * exactly what the banner asked would submit at the wrong destination and the wrong VAT rate.
 *
 * `DestinationsRead` names the third state explicitly rather than inferring it from content:
 * `loading` (the request is in flight — the guard must not fire, because there is nothing yet
 * to check against), `ready` (a real list came back), `failed` (it did not, and the options are
 * the same Thailand-only degrade as always). `destinationIsSubmittable` is the guard, now a
 * function of that state rather than of a bare options array — `isKnownDestination` still does
 * the actual list check and stays exported, because `ready` and `failed` both still need it.
 *
 * The alternative — sequencing the destinations fetch ahead of the pre-fill, so options are
 * never in an ambiguous state when a destination might already be set — was rejected: it would
 * slow the common path (an ordinary customer with nothing to pre-fill) to close a window that
 * affects only a returning customer whose pre-fill lands before a settings read most requests
 * finish in milliseconds.
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

/** Whether the read actually reached a real list, without collapsing that into its result. */
interface RawRead {
  readonly ok: boolean;
  readonly options: readonly Destination[];
}

/**
 * `{ destinations: [{code, nameTh}] }` off `GET /destinations` — active rows, `sort_order` as
 * the API applied it, never re-sorted here. `ok: false` on every failure — no API configured,
 * unreachable, a bad status, a body this bundle cannot read, or an empty list — paired with
 * `THAILAND_ONLY` either way, so a caller that only wants *something to render* never has to
 * branch on `ok` at all.
 */
async function readRaw(): Promise<RawRead> {
  const base = reviewsApiBaseUrl();
  if (base === null) return { ok: false, options: THAILAND_ONLY };

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
    if (!response.ok) return { ok: false, options: THAILAND_ONLY };

    const body: unknown = await response.json();
    if (!isRecord(body) || !Array.isArray(body['destinations'])) return { ok: false, options: THAILAND_ONLY };

    const destinations = body['destinations'].flatMap((raw) => {
      if (!isRecord(raw) || typeof raw['code'] !== 'string' || typeof raw['nameTh'] !== 'string') {
        return [];
      }
      return [{ code: raw['code'], nameTh: raw['nameTh'] }];
    });

    return destinations.length > 0 ? { ok: true, options: destinations } : { ok: false, options: THAILAND_ONLY };
  } catch {
    return { ok: false, options: THAILAND_ONLY };
  }
}

/**
 * Where the destinations read stands, as a state a guard can act on — not inferred from the
 * content of an options array, which cannot tell "nothing has come back yet" apart from "the
 * read failed and this is the degrade". See the module note for the bug this shape replaced.
 */
export type DestinationsRead =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly options: readonly Destination[] }
  | { readonly kind: 'failed'; readonly options: readonly Destination[] };

/**
 * The read every caller now uses — `DestinationSelect`'s data and the submit guard both come
 * from here rather than from a bare array, so success and failure are never collapsed into the
 * same shape. Never itself resolves to `{kind: 'loading'}` — that is the caller's own state
 * before this promise settles, which is the whole point: the caller decides what "still
 * waiting" means to it, this module only ever reports what actually came back.
 */
export async function readDestinations(): Promise<Exclude<DestinationsRead, { readonly kind: 'loading' }>> {
  const { ok, options } = await readRaw();
  return ok ? { kind: 'ready', options } : { kind: 'failed', options };
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

/**
 * ⭐ May `code` be submitted, given where the destinations read currently stands?
 *
 * The guard, restated as a function of `DestinationsRead` rather than of a bare options array —
 * see the module note. `loading` always answers yes: there is nothing yet to check against, and
 * refusing on incomplete information is exactly the bug this function exists to close. `ready`
 * and `failed` both defer to `isKnownDestination`, unchanged — the Thailand-only degrade is not
 * an exemption from the guard, only from what the guard has to work with.
 */
export function destinationIsSubmittable(code: string, state: DestinationsRead): boolean {
  if (state.kind === 'loading') return true;
  return isKnownDestination(code, state.options);
}
