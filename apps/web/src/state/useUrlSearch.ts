import { useEffect, useMemo, useState } from 'react';

/**
 * The current query string, as `URLSearchParams` — empty until the browser has it.
 *
 * ## Why this exists rather than `useSearchParams()` from `next/navigation`
 *
 * `useSearchParams()` reads a value that only exists per request. In a statically
 * rendered route Next refuses to prerender the subtree that calls it: the build fails
 * unless the caller sits inside a `<Suspense>`, and once it does, **the fallback is what
 * goes into the prerendered HTML** and the real subtree renders in the browser.
 *
 * For this route that is the whole return on phase 6b given away. Eight locales × 81
 * products is 648 pages that should be crawlable, and a `<Suspense>` around the
 * configurator makes 648 pages of skeleton. Plan 8.2's second trap is `searchParams` in
 * `generateMetadata` silently making a route dynamic; this is the same trap one floor
 * down, and it costs the same thing.
 *
 * So the query string is read the way the scaffold's own README says it should be —
 * "query strings are read by the client island and nowhere else" — and this hook is that
 * client island reading it.
 *
 * ## The hydration rule it exists to obey
 *
 * A value that differs between the server render and the first client render is a
 * mismatch, and React answers a mismatch by quietly re-rendering rather than by saying
 * so. `window.location.search` is exactly such a value. The state therefore starts at
 * `''` — which is what the server renders — and the browser's real query string arrives
 * in an effect, one commit later, as a normal state update that React is expecting.
 *
 * `popstate` is subscribed because back and forward change the query without unmounting
 * anything; a share link opened, then backed out of, has to stop being applied.
 */
export function useUrlSearch(): URLSearchParams {
  const [search, setSearch] = useState('');

  useEffect(() => {
    const read = () => setSearch(window.location.search);

    read();
    window.addEventListener('popstate', read);
    return () => window.removeEventListener('popstate', read);
  }, []);

  return useMemo(() => new URLSearchParams(search), [search]);
}

/**
 * The document's origin, or `''` before hydration.
 *
 * Same rule as above, for the same reason. `buildShareUrl` takes an origin and falls back
 * to a relative URL without one, so the server and the first client render agree on a
 * relative URL and the absolute one arrives with the effect.
 *
 * The alternative — `typeof window === 'undefined' ? '' : window.location.origin` read
 * during render — returns a different string on the server than on the first client
 * render *by construction*. It happens to be invisible today only because the share sheet
 * is closed at first paint and `BottomSheet` renders `null` while closed. That is a
 * property of an unrelated component, which is not a thing to depend on.
 */
export function useOrigin(): string {
  const [origin, setOrigin] = useState('');

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  return origin;
}
