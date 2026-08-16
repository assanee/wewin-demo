/**
 * Where apps/api is, decided once.
 *
 * `NEXT_PUBLIC_` is not decoration: the browser is what calls the API, so this value is
 * inlined into the bundle at build time and there is no later moment at which it could be
 * read. That makes "the deployment forgot to set it" a *build* failure rather than a
 * runtime one, which is the closest thing this app has to apps/api's rule that a
 * misconfigured process refuses to boot (src/config/env.ts). A production build with no
 * value stops here, loudly, rather than shipping a bundle that calls localhost.
 *
 * Outside production it falls back to the port apps/api listens on by default, because a
 * fresh checkout should run `pnpm dev` and work — the same trade main.ts makes for
 * AUTH_ACCESS_TOKEN_SECRET, and for the same reason: a setup step that fails on a variable
 * no example file can usefully supply is how people end up committing one.
 */

const DEVELOPMENT_FALLBACK = 'http://localhost:3000';

function resolveApiBaseUrl(): string {
  const configured = process.env['NEXT_PUBLIC_API_BASE_URL'];

  if (configured !== undefined && configured !== '') {
    /*
     * Trailing slash stripped once, here, for the reason apps/api's oauth.config.ts strips
     * it: every URL in this app is `API_BASE_URL + '/something'`, and `//something` is read
     * by a browser as a protocol-relative URL to the host `something`.
     */
    return configured.replace(/\/+$/, '');
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'NEXT_PUBLIC_API_BASE_URL is required for a production build of @wewin/dashboard. ' +
        'It is inlined into the browser bundle, so there is no later moment at which it can be read.',
    );
  }

  return DEVELOPMENT_FALLBACK;
}

export const API_BASE_URL = resolveApiBaseUrl();

/** One place that knows a path is joined to the base, so no caller has to remember the slash. */
export function apiUrl(path: string): string {
  return `${API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * ⭐ Where the customer-facing shop is, for linking a staff member to what they published.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────────
 *
 * Reported: "why is the product I added not on /th/products?" It was — under a name and a
 * URL that look nothing like what the dashboard shows. The editor's address is
 * `/products/<id>` and the shop's is `/<locale>/products/<slug>`, and **id and slug are
 * different strings**: the product in question was `uoio` here and `sdfghjkl` there. With
 * eighty-three cards on the page and no link between the two systems, the only way to check
 * your own work was to know that distinction and go hunting.
 *
 * ⚠️ Falls back to the port `apps/web` listens on in dev, and to `null` in production rather
 * than to a guess — a link to the wrong origin is worse than no link, because a staff member
 * follows it, sees someone else's shop or a 404, and concludes their publish failed. No
 * link, and they at least ask.
 */
const STOREFRONT_DEVELOPMENT_FALLBACK = 'http://localhost:3002';

export function storefrontBaseUrl(): string | null {
  const configured = process.env['NEXT_PUBLIC_STOREFRONT_BASE_URL'];
  if (configured !== undefined && configured !== '') return configured.replace(/\/+$/, '');
  return process.env.NODE_ENV === 'production' ? null : STOREFRONT_DEVELOPMENT_FALLBACK;
}

/**
 * The page a customer sees for this product, or `null` when there is not one.
 *
 * ⛔ **By slug, never by id.** The two differ, and the dashboard's own URL uses the id — so
 * building this from the wrong one produces a link that 404s for exactly the products
 * somebody most wants to check.
 *
 * `th` because that is the catalogue's own language and the locale a Thai staff member is
 * checking; the shop redirects an unknown first segment anyway, but a link that lands
 * somewhere and then bounces is a link that looks broken.
 */
export function storefrontProductUrl(slug: string): string | null {
  const base = storefrontBaseUrl();
  return base === null ? null : `${base}/th/products/${encodeURIComponent(slug)}`;
}
