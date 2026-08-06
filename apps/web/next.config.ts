import type { NextConfig } from 'next';

/**
 * Deliberately close to `apps/dashboard/next.config.ts`. Two Next.js apps in one workspace
 * are only cheaper than one Next and one Vite if they are configured the same way, so the
 * differences below are the ones that follow from this app being *public*.
 *
 * **No `transpilePackages`.** `@wewin/core` and `@wewin/i18n` are compiled to plain
 * JavaScript by `tsc` before anything here imports them (plan section 1 — "compile, not
 * share source"). Listing them would hand Next a second compiler for code CI has already
 * type-checked.
 *
 * **No `i18n` key.** That option belongs to the Pages Router and is ignored by the App
 * Router; locale routing here is a `[locale]` path segment plus `src/middleware.ts`. Left
 * unset rather than set-and-ignored, which reads like it is doing something.
 */
const nextConfig: NextConfig = {
  /*
   * `X-Powered-By` names the stack on every response and buys nothing. The dashboard turns
   * it off because it is internal; this app turns it off because it is not.
   */
  poweredByHeader: false,

  /*
   * The route union in `.next/types`. On a storefront its job is narrower than on the
   * dashboard but sharper: every `href` in this app is locale-prefixed, and a link that
   * drops the prefix is the failure that sends a German reader to a Thai page. A typed
   * route makes that a compile error instead.
   */
  typedRoutes: true,

  /*
   * Next 16 writes an AGENTS.md and a CLAUDE.md into this directory on every `dev` unless
   * told not to — generated files about the framework, in a repository where a CLAUDE.md
   * is a file contributors would reasonably assume somebody chose to write. Same reasoning,
   * same setting, as the dashboard.
   */
  agentRules: false,

  /**
   * 🔴 **A bounded shared-cache lifetime, because `revalidate = false` is not one.**
   *
   * The locale layout spends sixteen lines arguing that no route may set a time-based
   * `revalidate`, and that argument is right: an interval is a smaller window in which
   * "the screen disagrees with the invoice" is true, and there is no interval at which it
   * is false. What nobody measured until 6b's adversarial pass is what Next then *sends*:
   *
   * ```
   *   GET /en/products/awn-4t → Cache-Control: s-maxage=31536000
   * ```
   *
   * One year. **8,760× the `revalidate = 3600` the plan names as unacceptable**, on every
   * price-bearing page, emitted by the option chosen for being the safe one. On Vercel a
   * redeploy mints a new cache namespace so its own edge is unaffected — but that is a
   * fact about one host, and the header is addressed to every shared cache between this
   * server and a reader: a corporate proxy, an ISP cache, a CDN somebody puts in front.
   * None of those are redeployed with us.
   *
   * So the pages stay statically prerendered — nothing here reintroduces ISR, no route
   * gains a `revalidate`, `next build` still emits 683 documents — and the *header* says
   * ten minutes, with a day of `stale-while-revalidate` behind it so a shared cache keeps
   * serving instantly while it refreshes. The origin is not doing any more work: it is
   * returning the same prerendered file it already had.
   *
   * `must-revalidate` is deliberately absent: it would turn a refresh failure into an
   * error page, when the honest answer for a catalogue is the slightly older page.
   */
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, max-age=0, s-maxage=600, stale-while-revalidate=86400',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
