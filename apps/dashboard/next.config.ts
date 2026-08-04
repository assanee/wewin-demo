import type { NextConfig } from 'next';

/**
 * Almost nothing, and the empty spots are decisions.
 *
 * **No `transpilePackages`.** `@wewin/contract` and `@wewin/core` are compiled to plain
 * JavaScript by `tsc` before anything here imports them (plan section 1 — "compile, not
 * share source"). Listing them would hand Next a second compiler for code CI already
 * type-checked, and the repository's rule is that what CI checks is what production runs.
 *
 * **No rewrites proxying `/api/*` to apps/api.** A proxy would put the dashboard and the
 * API on one origin, which sounds like an improvement until you look at the refresh cookie:
 * it is `__Host-` prefixed, so it carries no `Domain` and belongs to the API's host alone
 * (apps/api/src/auth/session/refresh-cookie.ts spends a paragraph on why that prefix is the
 * whole design). Proxying would mean this server forwarding a credential it must never
 * hold. The browser talks to the API directly instead — same-site, `credentials: 'include'`,
 * which is exactly the arrangement that file says it was built for.
 */
const nextConfig: NextConfig = {
  /*
   * The dashboard is an internal tool behind a sign-in; there is nothing here for a crawler
   * or a preview card, and `X-Powered-By` names the stack on every response for free.
   */
  poweredByHeader: false,

  /*
   * The route union in `.next/types` is what makes `src/lib/nav/navigation.ts` — the seam
   * between this shell and the product screens — checkable rather than merely agreed.
   * Verified by pointing an entry at `/does-not-exist` and watching `next build` refuse it.
   */
  typedRoutes: true,

  /*
   * Next 16 writes an AGENTS.md and a CLAUDE.md into this directory on every `dev` unless
   * told not to. Both are generated files about the framework rather than about this
   * project, they reappear after every deletion, and a CLAUDE.md in particular is a file
   * this repository's contributors would reasonably expect somebody chose to write.
   */
  agentRules: false,
};

export default nextConfig;
