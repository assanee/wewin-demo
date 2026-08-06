# `@wewin/web` — the storefront

Next.js App Router, eight locales, 683 prerendered pages. **Phase 6b is closed:** the Vite
storefront that lived at this path is deleted, this app moved here from `apps/web-next`
and took its name, and `vercel.json` builds it. There is one storefront again.

Why the move was worth making: eight locales × 81 products is 648 pages that should be
crawlable and fast. That is the entire return. Everything else was the cost of collecting
it — and the twelve things that cost more than the plan predicted are written up in
`docs/monorepo-plan.md` section 8.8, including the two that were shipping wrong numbers
(a year-long `Cache-Control` and a price whose spelling depended on the reader's browser).

```sh
pnpm install
pnpm build                   # @wewin/core and @wewin/i18n compile first (plan section 1);
                             # `next build` then emits 683 documents and check-tokens runs
pnpm --filter @wewin/web start      # http://localhost:3002
```

The 114 tests the Vite app carried were its four i18n suites, and every one of them was a
byte-identical copy of a file in `src/i18n/` here — `diff`-verified in the commit that
removed them, which is why the workspace total moves by −114 without an assertion being
retired.

---

## Run it

```sh
pnpm install
pnpm build                          # @wewin/core and @wewin/i18n compile first
                                    # (plan section 1); `next build` emits 683 documents
pnpm --filter @wewin/web dev        # http://localhost:3002  → redirects to /th
```

`apps/api` keeps 3000 and `apps/dashboard` 3001.

⚠️ **This section used to say "run both".** For the length of the port the Vite storefront
ran beside this one on 5173 and was the reference — the only way to answer "does the
Next.js page render what the Vite page rendered" was to have both up. That app is deleted.
Anything below that reads *"in the Vite app…"* is history, kept because it is the argument
for why something here is shaped the way it is, not an instruction to go and look.

### What "the same page" means, exactly

It does not mean the same content — this app has one specimen page and the Vite app has
five real screens. It means **the same design system**, which is the only thing this round
was responsible for carrying across. Four checks, all of which a reader can run:

**1. The chrome is identical.** Open both and paste this into the console of each:

```js
const b = getComputedStyle(document.body);
console.log({
  background: b.backgroundColor,   // rgb(15, 18, 16)  — --color-ink
  color: b.color,                  // rgb(233, 236, 226) — --color-chalk
  fontSize: b.fontSize,            // 15px — --text-body
  lineHeight: b.lineHeight,        // 24px — 1.6 × 15
  fontFamily: b.fontFamily,
});
```

Everything but `fontFamily` is identical. `fontFamily` differs by design and only by
spelling: the Vite app names `'IBM Plex Sans Thai', system-ui, sans-serif` and fetches it
from Google Fonts at first paint; this app names the self-hosted family `next/font`
generated, followed by the five script faces (see [Fonts](#fonts)).

**2. The tokens are the same values.** Not by eye — by diff:

```sh
pnpm --filter @wewin/web build     # `next build && node scripts/check-tokens.mjs`
# check-tokens: 37 design tokens compared against apps/web/src/index.css, value for value.
# check-tokens: the type scale produces CSS, the stock scales produce none. OK
```

**3. `text-body` produces a rule and `text-sm` produces nothing** — phase 2's check, now
run on every build. See [The token lockdown](#the-token-lockdown).

**4. The numbers did not move.** `/th`, `/de`, `/my` … all render the same amount:

```
th ฿8,791    de 8.791 ฿    en ฿8,791    hi ฿8,791
la ฿8.791    my ၈,၇၉၁ ฿    vi 8.791 ฿    zh ฿8,791
```

Four different spellings — `.` and `,` swap roles between `de` and `la`, the symbol moves
side, and `my` uses Myanmar digits — and one amount. Rendered on the server, from the same
`@wewin/i18n` functions a client island calls.

Eight spellings of one number, from `@wewin/i18n` — the same functions the Vite app calls,
now on the server.

---

## Locale routing

`/[locale]/…` for all eight, **Thai included**. `/` is a 307 to a negotiated locale.

| | |
|---|---|
| `/de`, `/th`, `/la` … | prerendered, one page per locale |
| `/` | 307 → cookie, else `Accept-Language`, else Thai. `Cache-Control: no-store`, `Vary: Accept-Language, Cookie` |
| `/products` | 307 → `/th/products` (prefix added, path kept) |
| `/xx/foo` | 307 → `/th/xx/foo` → 404 inside Thai |
| `/favicon.ico` | untouched — the proxy matcher excludes any path with a dot |

Why prefix Thai too, when the more common pattern is to leave the default bare:

1. **The cache key.** Plan 8.7(2): ISR without locale in the key serves the German page to
   a Thai reader. A path segment puts the locale into *every* cache — Next's, a CDN's, a
   browser's — structurally, because they are different URLs. An unprefixed default reopens
   that hole for the largest audience.
2. **Two URLs for one document**, across 81 products, before it is anything else.
3. **`la`.** The segment is `la`; the `lang` attribute and every `hreflang` is `lo-LA`,
   because `la` in BCP 47 is Latin, the dead language. Keeping the two apart needs a
   segment to keep them apart in.

`export const dynamicParams = false` closes the set: an unknown locale 404s at the router
rather than rendering a page whose every string quietly fell back to Thai.

### `<html lang>` comes from the response

Plan 8.7(1)'s debt, paid. The root layout **is** `src/app/[locale]/layout.tsx` — there is no
`src/app/layout.tsx` — so the locale is known before `<html>` is written:

```
/th → lang="th-TH" data-script="thai"      /hi → lang="hi-IN" data-script="devanagari"
/de → lang="de-DE" data-script="latin"     /la → lang="lo-LA" data-script="lao"
/my → lang="my-MM" data-script="myanmar"   /zh → lang="zh-CN" data-script="han"
```

In the Vite app this is written from a `useEffect` after hydration, and `<title>` and
`<meta description>` are hard-coded Thai in `index.html` — so every crawler, in all eight
languages, read Thai and there was nowhere inside `<head>` to mark it.

`generateMetadata` emits eight `hreflang` links plus `x-default → /th`, a per-route
`canonical`, and `og:locale`. It is set **per route, not in the layout**: layout metadata is
inherited, so a `canonical` there would give all 81 product pages the home page's URL.

---

## The three cache traps (plan 8.2)

### 1 · ISR staleness — decided, and half of it is deliberately not built

`export const revalidate = false` in the locale layout, inherited by everything below. Not
a shorter interval: a shorter interval is a smaller window in which "the screen disagrees
with the invoice" is still true, and there is no interval at which it is false. Pages are
cached until something *says* they changed.

`tests/cache-policy.test.ts` fails if any file under `src/app` exports a numeric
`revalidate` — reaching for `3600` means deleting a test that explains why, in front of a
reviewer.

🔴 **The other two halves are open, and a price may not be rendered on a cached page until
they exist:**

- `revalidateTag('product:' + id)` from the dashboard's publish action. There is
  deliberately **no route handler for it here.** An invalidation endpoint that nothing calls
  is the failure plan 7.18(ข) names as the most expensive of its round — finished, tested,
  wired to nothing — and it would read as coverage while the window stayed wide open. It
  gets written in the commit that also calls it.
- `priceVersion` on the payload, and the API refusing an order line whose version does not
  match. That is the half that makes a stale page *fail* rather than quietly bill a
  different number.

### 2 · `searchParams` in `generateMetadata` — chosen: **never**

Reading it opts the route out of static rendering silently: no prerender, no ISR, a
function invocation per request, no error. On 648 pages whose only reason to be in Next.js
is that they are prerendered, that is the entire return, given away by a destructure.

These routes are static and query strings are read by the client island and nowhere else —
which is what the configurator already is (plan 8.1). A share link's `?width=…&v=3` is
*configuration*; the island computes from it in the browser, and the page's metadata
describes the product, not the configuration. Scanned by `tests/cache-policy.test.ts`.

### 3 · Per-user preferences in no cache key — chosen, and it is three answers

The plan offers "URL / client island / one currency per locale" as if it were one question.
It is three, because the three preferences are not alike:

| preference | where it lives | why |
|---|---|---|
| **language** | the URL, as a path segment | It changes every string on the page. Structural, unforgeable, free. |
| **currency** | one per locale, fixed | Money renders on the server, so a crawler and a customer see the same price. A free currency picker is *already* wrong by risk 7 — currency has to be tied to the shipping destination, not to a toggle. Today all eight resolve to THB, because `f.baht` is the only presentation currency the storefront has; the locale→currency table is the seam, and it is one table. |
| **display unit** | a client island, over a `cm` default | Not money. A cached page always carries the **default** unit, never a visitor's, so no reader can be served another's. The island upgrades it after hydration, and switching units is display-only over an immutable canonical (plan 4.7) — so the number under it does not move. |

The failure being avoided is one reader's preference cached and served to another. Note it
can reappear one layer up: the redirect from `/` depends on a cookie and a header, so it is
`no-store` with the matching `Vary`. A shared cache without that would pin the first
visitor's language onto `/` for everyone behind them.

---

## The token lockdown

`apps/web/src/index.css` wipes four Tailwind namespaces with `: initial`, so `text-sm`,
`sm:` and `bg-slate-800` produce **no CSS at all**. All four are carried across byte for
byte. `text-sm` still produces nothing here.

⚠️ Plan 8.5 proposes a **token bridge** for this app — unlocking `--text-*`,
`--breakpoint-*` and `--font-*` and mapping them 1:1 onto the project scale, so shadcn's
generated components stop silently rendering at the browser's 16px. That is a real argument
and it is **not applied**, because it is the exact opposite of the check this round is
required to pass. It stays a separate, deliberate decision, taken with a screen of shadcn
components in front of it — and the day it lands, `check-tokens.mjs` is rewritten in the
same commit rather than deleted. There is no `components.json` here yet for the same reason.

Two guards, because one is not enough:

| | reads | catches |
|---|---|---|
| `scripts/check-tokens.mjs` (runs in `build`) | the **built** CSS + both `@theme` blocks | the wipe stopped being in effect; a token drifted from `apps/web`; a token was invented here |
| `tests/tokens.test.ts` (runs in `test`) | every `className` value in `src/**` | somebody wrote `text-sm` and got no CSS, no error and no warning |

The second exists because the first cannot see it. Tailwind emits nothing it has not found
in source, so `.text-sm` is absent from the bundle both when the namespace is wiped *and*
when nobody wrote it — the stylesheet cannot tell you a contributor typed it and shipped a
paragraph at 16px that reads as a design mistake rather than a bug. Plan 8.5 names this
precisely: the rule was built to catch code a *person* writes, and meeting code a *machine*
generates turns it from a safety net into a trap. Three agents are about to write a lot of
this app's markup.

`--lime` keeps its cap of two per screen. The specimen page uses it exactly once, and
demonstrates the palette by diffing rather than by painting a swatch of every colour —
which would have broken the one design rule that is enforced by counting.

### Mutation evidence

A guard nobody has watched fail is a guard nobody has evidence for. Every one of these was
applied, run, and reverted:

| mutation | caught by | named the offender |
|---|---|---|
| `text-sm` in a real `className` | `tokens.test.ts` | yes |
| `--color-lime` off by one hex digit | `check-tokens` parity | yes |
| a token invented here that `apps/web` lacks | `check-tokens` parity | yes |
| each of the four `--*: initial` wipes deleted | `check-tokens` parity | yes, one per run |
| `--text-*: initial` deleted **and** `text-2xl` written, then rebuilt | `check-tokens` lockdown | yes — 6 stock classes appeared in the bundle |
| `export const revalidate = 3600` | `cache-policy.test.ts` | yes |
| `searchParams` added to a `generateMetadata` | `cache-policy.test.ts` | yes |
| `window.localStorage` in a server component | `cache-policy.test.ts` | yes |
| the Myanmar face removed from the stack | `fonts.test.ts` | yes |
| the per-script leading override removed | `fonts.test.ts` | yes |

Two of the guards carry their own mutation *inside the suite* — `tokens.test.ts` asserts the
scanner still matches a planted stock class and still ignores the project scale, because a
regex that silently stops matching turns every assertion under it into decoration.

---

## Fonts

Plan 8.3 asks for a stack per script family. It comes out as **one ordered stack**, and
that is 8.3's own argument arriving at its conclusion.

8.7(3) corrects the script count from two to four (Lao and Myanmar were missed) and adds
the constraint that decides the shape: untranslated text degrades to Thai *in place*, so no
locale's stack may omit a Thai face. Run that once more and it does not stop at Thai — a
German page carries Thai fallback prose, a Thai page carries a Vietnamese customer's name,
a Hindi product summary can sit in a quote read in Chinese. Eight stacks that must all list
the same eight faces are one stack. `unicode-range` then does the per-script selection *per
character*, at the browser, better than a per-locale stack can.

```
--stack-body: IBM Plex Sans Thai, IBM Plex Sans (vi), Noto Sans Devanagari,
              Noto Sans Lao, Noto Sans Myanmar, Noto Sans SC, system-ui, sans-serif
```

Order is the design. The shared face is first so Latin and Thai render exactly as they do
in the Vite app; Han is **last** because Noto Sans SC also ships Latin and Vietnamese
slices, and first place would give the Chinese page different digits from the other seven
for no reason anybody chose.

### ⚠️ 8.3 undercounts a third time, and this one is not a script

Checked against the Google Fonts CSS API, not assumed:

```
IBM Plex Sans Thai  →  cyrillic-ext · latin · latin-ext · thai       ← no `vietnamese`
Bai Jamjuree        →  latin · latin-ext · thai · vietnamese
IBM Plex Mono       →  cyrillic · cyrillic-ext · latin · latin-ext · vietnamese
```

`vi` is Latin script, so no per-script table flags it — and the body face has no Vietnamese
subset. In the Vite app today, Vietnamese diacritics render from whatever `system-ui`
resolves to on the reader's machine, mid-word, beside Plex glyphs. `IBM_Plex_Sans` at
`subsets: ['vietnamese']` is about two kilobytes and is the metric-compatible sibling of the
body face.

### Leading: one value, one override

`--leading-reading: 1.6` (Thai stacks vowel and tone marks), dropped to `1.5` under
`:root[data-script='han']` and nowhere else — Devanagari stacks marks too and keeps 1.6.
The seven pixel sizes are untouched: it is a leading, not a second type scale.

### Costs written down rather than discovered

- **Preload.** `preload` is a build-time flag, so "preload what *this* locale needs" is not
  expressible through `next/font`. Body, display and mono are preloaded (every locale needs
  all three); the five script faces are not, and a `hi`/`la`/`my`/`zh` reader gets one swap
  on first paint for their own script. The fix is self-hosted subsets via `next/font/local`
  plus a per-locale `<link rel="preload">` — a follow-up with a subsetting step attached.
- **Build time and network.** `Noto_Sans_SC` is declared with **no `subsets`**, which is
  legal only with `preload: false`. Google splits CJK into ~100 numbered `unicode-range`
  slices rather than named subsets, so `subsets: ['latin']` would fetch a Chinese font
  without its Chinese glyphs and fail silently as tofu. The build downloads 138 woff2 files
  and needs `fonts.gstatic.com`.

---

## 🔴 Found while building this — and closed, in `packages/i18n`

**Server rendering moves numeral-system selection from the browser to Node, and `my` and
`la` are where that showed.** Plan 8.7(4) recorded half of it: Node's full ICU renders
`၈,၇၉၁` where Chromium resolves `my-MM` to `latn`. Under the Vite app both halves ran in
the same browser and always agreed; here the served HTML carried `၇,၆၈၀ ฿` and the browser
respelt it `฿7,680` after hydration — a React hydration mismatch **on a price**, on every
one of the 648 product pages.

The other half was worse and was not in the plan: `lo-LA` has no CLDR data in Chromium
either, and Lao groups with `.` — so the cached, crawlable HTML of every Lao page read
`฿7.680`, which any European convention reads as seven baht sixty-eight. The value never
moved. The spelling did, and the spelling is what a crawler, a screenshot and a printed
page keep.

**Closed in `packages/i18n/src/numberSpec.ts`**: how each locale spells a number is written
down and used at run time, so no engine is asked; `tests/number-spec.test.ts` rebuilds every
field of that table from `Intl` on the test machine, so a ninth locale or a CLDR revision
fails the suite instead of shipping. Verified in a browser afterwards — all eight locales,
served string equal to hydrated string, zero console errors.

Dates are **not** closed: `Intl.DateTimeFormat` is still asked at run time and Lao and
Burmese month names have the same gap. Nothing on the storefront renders a date today, so
the exposure is the dashboard and the notification worker, both Node-only. Risk 25.

## Layout of the package

```
src/
  proxy.ts                   locale negotiation for unprefixed paths (Next 16's middleware)
  lib/routing.ts             the locale segment: pure, no `next/*`, testable under plain Node
  app/
    fonts.ts                 eight faces, one stack, and the argument for both
    globals.css              apps/web/src/index.css, carried across + the font stack + one override
    icon.svg                 the Vite app's favicon, so the two tabs match
    [locale]/
      layout.tsx             THE ROOT LAYOUT — `<html lang>`, `revalidate = false`, metadata contract
      page.tsx               the specimen page. NOT a port of `pages/Home.tsx`
      not-found.tsx          404 inside a valid locale
scripts/check-tokens.mjs     runs inside `build`
tests/                       33 tests: routing · cache policy · tokens · fonts
```

## For the three agents porting onto this

- Routes go under `src/app/[locale]/`. `params` is a `Promise`; narrow it with
  `localeFromSegment` and `notFound()` on `null` — never fall back to Thai at a URL that
  asked for something else.
- `Link href` takes `localeHome(locale)` today. `typedRoutes` is on, so a link to a page
  that does not exist yet is a compile error — when you add `/[locale]/products`, add its
  typed helper beside `localeHome` and the union grows with the app.
- Every route's own `generateMetadata` calls `languageAlternates(itsPath)`. `params` only.
- The configurator is **one** client island (plan 8.1). `useConfigurator`, `MeasureInput`'s
  dirty flag, `history.ts` and the localStorage read are a single boundary; splitting them
  into server components buys nothing and costs correctness.
- `pnpm --filter @wewin/web test` before `build` — the scans are fast and tell you
  which file.

## Not this package's, and still open

- `vercel.json` still builds `@wewin/web` with the Vite preset. Production keeps shipping
  from the app that has 114 passing tests; it moves in the commit that finishes the port.
- The last commit of 6b deletes `apps/web` and renames this package to `@wewin/web`. Until
  then, two entries in the root `tsconfig.json` and two dev servers are the point.
- No `components.json` / shadcn here — see [the token lockdown](#the-token-lockdown).
- The app's 205-key UI catalogue still lives in `apps/web/src/i18n`. This package uses
  `@wewin/i18n` for locales and formatters only; `<title>` is the brand until the catalogue
  moves.
