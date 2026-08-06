import {
  Bai_Jamjuree,
  IBM_Plex_Mono,
  IBM_Plex_Sans,
  IBM_Plex_Sans_Thai,
  Noto_Sans_Devanagari,
  Noto_Sans_Lao,
  Noto_Sans_Myanmar,
} from 'next/font/google';

/**
 * The faces, and the one stack they compose into — plan 8.3.
 *
 * ── What 8.3 asked for, and why it comes out as *one* stack ──────────────────────
 *
 * 8.3 asks for "a font stack per script family". 8.7(3) then corrects the count from two
 * non-Latin scripts to four (Devanagari, Lao, Myanmar, Han — Lao and Myanmar were missed)
 * and adds the constraint that actually decides the shape of this file:
 *
 *   > because untranslated text degrades to Thai **in place**, every locale's page can
 *   > contain Thai. There is no locale whose font stack may omit a Thai face.
 *
 * Run that argument once more and it does not stop at Thai. A `de` page carries Thai
 * fallback prose; a `th` page carries a Vietnamese customer's name; a product summary
 * translated into Hindi can sit in a quote read in Chinese. Any locale can contain any
 * script, so no locale's stack may omit any face — and eight stacks that must all list the
 * same eight faces are one stack.
 *
 * That is not a shortcut around 8.3, it is 8.3's own subsetting argument arriving at its
 * conclusion: `unicode-range` already does per-script selection *per character*, at the
 * browser, better than a per-locale stack can. A reader of the German page downloads the
 * Devanagari face if and only if a Devanagari character appears on it.
 *
 * ── Order is the whole design ────────────────────────────────────────────────────
 *
 * `font-family` resolves per character: the first family in the list that has the glyph
 * wins. So the ordering rule is **the shared face first, the script faces after**:
 *
 *   1. IBM Plex Sans Thai — Latin, Latin-ext and Thai. Everything the storefront reads
 *      today comes from here, which is why the Next.js page and the Vite page look the
 *      same in seven of the eight locales.
 *   2. IBM Plex Sans — Vietnamese only (see below).
 *   3. Devanagari, Lao, Myanmar, then Han — each reached only for characters 1 and 2
 *      lack.
 *
 * Han is deliberately last. Noto Sans SC also ships Latin and Vietnamese slices; put it
 * first for `zh` and the Chinese page would render its Latin text and its digits in a
 * different face from the other seven, for no reason anyone chose.
 *
 * ── ⚠️ 8.3 undercounts a third time, and this one is not a script ────────────────
 *
 * Checked against the Google Fonts CSS API rather than assumed:
 *
 *   IBM Plex Sans Thai  →  cyrillic-ext · latin · latin-ext · thai       ← no `vietnamese`
 *   Bai Jamjuree        →  latin · latin-ext · thai · vietnamese
 *   IBM Plex Mono       →  cyrillic · cyrillic-ext · latin · latin-ext · vietnamese
 *
 * `vi` is Latin script, so no per-script table flags it — and the body face has no
 * Vietnamese subset. In the Vite app today, Vietnamese body copy renders its diacritics
 * from whatever `system-ui` resolves to on the reader's machine, mid-word, beside Plex
 * glyphs. `IBM_Plex_Sans` at `subsets: ['vietnamese']` is roughly two kilobytes and is the
 * metric-compatible sibling of the body face, so it slots in behind it and is reached only
 * for the characters Plex Sans Thai does not have.
 *
 * ── Preloading, and the cost that is being accepted ──────────────────────────────
 *
 * `preload` is a build-time flag, not a per-request one, so "preload the faces this
 * locale needs" is not expressible through `next/font`. The split taken here:
 *
 *   preloaded      body · display · mono. Every locale needs all three — Thai fallback
 *                  text can appear on any page, and every price is set in the mono face.
 *   not preloaded  the five script faces. Their `@font-face` rules are still emitted on
 *                  every page (which is what makes the fallback work at all); the browser
 *                  fetches one only when a character in its `unicode-range` appears.
 *
 * The cost is real and belongs written down: a `hi`, `la`, `my` or `zh` reader gets one
 * swap on first paint for their own script. Fixing it means self-hosting subset files
 * under `public/` with `next/font/local` and emitting a `<link rel="preload">` per locale
 * from the layout — a follow-up with a font-subsetting step attached, not a line change.
 *
 * ── Noto Sans SC has no `subsets` argument, and that is on purpose ───────────────
 *
 * Google splits CJK into ~100 numbered `unicode-range` slices rather than named subsets.
 * Passing `subsets: ['latin']` would fetch a Chinese font *without its Chinese glyphs* and
 * fail silently as tofu. `next/font` permits omitting `subsets` only when `preload` is
 * false, which is exactly the combination CJK needs, and it then downloads every slice at
 * build time — a slow build in exchange for a browser that fetches only the slices the
 * page actually uses.
 */

/** Headings. Weight 600 only — the same single weight `apps/web/index.html` requests. */
const display = Bai_Jamjuree({
  weight: ['600'],
  subsets: ['latin', 'latin-ext', 'thai', 'vietnamese'],
  variable: '--face-display',
  display: 'swap',
});

/** Body copy. 400/500, matching the Vite app's request exactly so nothing shifts weight. */
const body = IBM_Plex_Sans_Thai({
  weight: ['400', '500'],
  subsets: ['latin', 'latin-ext', 'thai'],
  variable: '--face-body',
  display: 'swap',
});

/** Prices, measurements and codes — the `numeric` utility. */
const mono = IBM_Plex_Mono({
  weight: ['400', '500'],
  subsets: ['latin', 'latin-ext'],
  variable: '--face-mono',
  display: 'swap',
});

/**
 * Vietnamese diacritics, and nothing else. Same superfamily as `body`, so a Vietnamese
 * word is not half Plex and half whatever the operating system had.
 */
const latinVietnamese = IBM_Plex_Sans({
  weight: ['400', '500'],
  subsets: ['vietnamese'],
  variable: '--face-latin-vi',
  preload: false,
  display: 'swap',
});

const devanagari = Noto_Sans_Devanagari({
  weight: ['400', '500'],
  subsets: ['devanagari'],
  variable: '--face-devanagari',
  preload: false,
  display: 'swap',
});

const lao = Noto_Sans_Lao({
  weight: ['400', '500'],
  subsets: ['lao'],
  variable: '--face-lao',
  preload: false,
  display: 'swap',
});

const myanmar = Noto_Sans_Myanmar({
  weight: ['400', '500'],
  subsets: ['myanmar'],
  variable: '--face-myanmar',
  preload: false,
  display: 'swap',
});

/*
 * 🔴 **Noto Sans SC is gone, and `globals.css` says why at length.**
 *
 * Summary, because a reader arriving at this file will look for it here: importing it
 * emitted 202 `@font-face` rules — 186,121 bytes, 67 KB gzipped — into the
 * render-blocking stylesheet of all 683 pages, to describe slices that seven of the eight
 * locales never fetch. Han now resolves through `--face-han-system`, a stack of the CJK
 * faces every platform that can draw Chinese already ships. The paragraph below about
 * omitting `subsets` is kept because it is the trap anybody re-adding this will fall into:
 * Google splits CJK into ~100 numbered `unicode-range` slices rather than named subsets,
 * `subsets: ['latin']` fetches a Chinese font *without its Chinese glyphs* and fails
 * silently as tofu, and `next/font` only permits omitting `subsets` when `preload` is
 * false. If it comes back, it comes back subsetted and self-hosted through
 * `next/font/local`.
 */

/**
 * The class list for `<html>`. Every face's CSS variable, in one string.
 *
 * All eight are attached on every page rather than per locale, because the stack in
 * `globals.css` names all eight and a `var()` that resolves to nothing would silently drop
 * that face out of the middle of the list — the failure being avoided is a Thai sentence
 * inside a German page rendering in a system font.
 */
export const FONT_VARIABLE_CLASSES = [
  display.variable,
  body.variable,
  mono.variable,
  latinVietnamese.variable,
  devanagari.variable,
  lao.variable,
  myanmar.variable,
].join(' ');
