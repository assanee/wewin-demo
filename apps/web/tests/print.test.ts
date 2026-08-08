import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ WHAT A CUSTOMER'S DOWNLOADED PDF CONTAINS.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A customer printed their quotation and got the wordmark, the language picker and the cart
 * icon across the top of it. Two things were wrong underneath, and the second was worse.
 *
 * **One.** The fix was an `@media print` block, and its first draft said
 * `header, footer { display: none }` — which hid the site chrome and, with it,
 * `article > header`: the block carrying the quotation's number, its date and the customer's
 * own name. One bug traded for a bigger one, silently, because both are invisible on screen.
 *
 * **Two.** This storefront is a dark theme, so its foreground colours are pale by design, and
 * Chrome prints with background graphics off. The grand total printed at relative luminance
 * 0.58 against white — the contrast of a watermark, on the one number the customer is being
 * asked to agree to.
 *
 * ⚠️ **Nothing else in this repository can catch either.** Neither is a type error,
 * `check-tokens` only proves a utility class produces CSS, and every rendering test runs in
 * screen media. The only way to see them is to print, which is what nobody does before
 * shipping — which is how both got there.
 *
 * So this scans the source, and is honest about which half it proves: that the selectors name
 * the shell rather than an element the document also uses, that exactly two components carry
 * the attribute they name, and that no colour is left too pale to read on paper. What it
 * cannot prove is what the paper looks like. That was checked by printing one.
 */

const here = dirname(fileURLToPath(import.meta.url));
const src = (...parts: readonly string[]): string =>
  readFileSync(join(here, '..', 'src', ...parts), 'utf8');

/*
 * ⚠️ Comments stripped, for the reason `fonts.test.ts` strips them: the block explains itself
 * by quoting the very selectors this counts — "`[data-chrome]` and not `header, footer`" — so
 * a scan that read the prose would fail the moment somebody deleted the paragraph, and pass
 * the moment somebody wrote the paragraph without the rule.
 */
const withoutComments = (text: string): string => text.replaceAll(/\/\*[\s\S]*?\*\//g, '');

const css = withoutComments(src('app', 'globals.css'));

/** Every `.tsx` below a directory. Plain recursion, so it needs nothing from the bundler. */
function tsxUnder(root: string): readonly string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return tsxUnder(path);
    return entry.isFile() && path.endsWith('.tsx') ? [path] : [];
  });
}

/** The `@media print { … }` body, brace-counted because `@page` and `:root` nest inside it. */
function printBlock(sheet: string): string {
  const open = sheet.indexOf('@media print');
  if (open === -1) return '';

  const first = sheet.indexOf('{', open);
  let depth = 0;
  for (let i = first; i < sheet.length; i += 1) {
    if (sheet[i] === '{') depth += 1;
    if (sheet[i] === '}') {
      depth -= 1;
      if (depth === 0) return sheet.slice(first + 1, i);
    }
  }
  return '';
}

const block = printBlock(css);

/**
 * The block's rules, as selector-list and declarations.
 *
 * ⚠️ Kept as pairs rather than flattened to a list of selectors, and the first draft of this
 * file flattened them — which reported `article > header` as a violation. It is one in a rule
 * that hides; it is exactly right in the rule saying `break-inside: avoid`, where naming the
 * document's own header is the entire point. A scan that cannot tell the two apart either
 * fails on correct CSS or stops looking at the selector that matters.
 */
const rules: readonly { readonly selectors: readonly string[]; readonly body: string }[] = [
  ...block.replaceAll(/@page[\s\S]*?\}/g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g),
].map((rule) => ({
  selectors: (rule[1] ?? '')
    .split(',')
    .map((one) => one.trim())
    .filter((one) => one !== ''),
  body: rule[2] ?? '',
}));

const hides = (body: string): boolean => /display\s*:\s*none/.test(body);

/*
 * ⚠️ Quote style normalised, so this asserts about selectors rather than about punctuation.
 * `[role='status']` and `[role="status"]` are the same selector, and a test that spelled the
 * quotes would one day be "fixed" by editing the CSS to match it.
 */
const sameQuotes = (selector: string): string => selector.replaceAll("'", '"');

/** Selectors of the rules that make something disappear — the only ones that can lose data. */
const hidden = rules
  .filter((rule) => hides(rule.body))
  .flatMap((rule) => rule.selectors)
  .map(sameQuotes);

describe('the storefront print stylesheet', () => {
  it('exists at all', () => {
    /*
     * ⚠️ The comment beside the print button in `QuotationIsland` asserted this block existed
     * for three phases before it did — "`print:hidden`, and the print stylesheet does the
     * rest". A comment describing a mechanism that is absent makes the absence look like a
     * decision, and survives both review and a green suite.
     */
    expect(block.trim()).not.toBe('');
  });

  it('hides the shell by the attribute the shell carries', () => {
    expect(hidden).toContain('[data-chrome]');
  });

  it('never hides an element the document also uses', () => {
    /*
     * ⭐ The assertion this file exists for.
     *
     * `header` and `footer` are landmarks, not site furniture. `article > header` is the top
     * of the quotation, carrying its number, its date and the customer's name; a rule naming
     * the *element* hides the document's along with the site's, and the printed page loses
     * the three facts that identify it.
     */
    expect(hidden.filter((one) => /(^|\s|>)(header|footer)$/u.test(one))).toEqual([]);
  });

  it('hides a toast in flight, which is chrome the shell renders outside itself', () => {
    expect(hidden).toContain('[role="status"]');
  });

  it('names no selector that matches nothing', () => {
    /*
     * ⚠️ Both were invented and written into the first draft. A rule matching nothing is worse
     * than a missing rule, because it reads as coverage: the skip link needs none (it is
     * `sr-only` until focused) and the toast viewport is `role='status'`.
     */
    expect(block).not.toContain('data-skip-link');
    expect(block).not.toContain('data-toast-viewport');
  });
});

describe('data-chrome', () => {
  it('is carried by the site header and the site footer', () => {
    expect(withoutComments(src('components', 'shell', 'AppHeader.tsx'))).toContain('data-chrome');
    expect(withoutComments(src('components', 'shell', 'AppFooter.tsx'))).toContain('data-chrome');
  });

  it('is carried by nothing else', () => {
    /*
     * ⭐ The other half of the rule, and the half that decays.
     *
     * `[data-chrome]` is only as good as its meaning. The day somebody reaches for it to hide
     * a section of a printed page it stops meaning "the shell", and the next person hides the
     * quotation with it — the bug this file was written for, arriving by a different door.
     */
    const wearing = tsxUnder(join(here, '..', 'src'))
      .filter((file) => withoutComments(readFileSync(file, 'utf8')).includes('data-chrome'))
      .map((file) => basename(file))
      .sort();

    expect(wearing).toEqual(['AppFooter.tsx', 'AppHeader.tsx']);
  });
});

/* ------------------------------------------------------------------ *
 * Ink
 * ------------------------------------------------------------------ */

/** WCAG relative luminance. 0 is black, 1 is white. */
function luminance(hex: string): number {
  const value = hex.trim().replace('#', '');
  const full = value.length === 3 ? [...value].map((digit) => digit + digit).join('') : value;
  const channel = (pair: string): number => {
    const c = Number.parseInt(pair, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * channel(full.slice(0, 2)) +
    0.7152 * channel(full.slice(2, 4)) +
    0.0722 * channel(full.slice(4, 6))
  );
}

/** `--color-*: #hex;` declarations in a chunk of CSS, as a map. */
function colours(chunk: string): Readonly<Record<string, string>> {
  return Object.fromEntries(
    [...chunk.matchAll(/(--color-[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g)].map((found) => [
      found[1] ?? '',
      found[2] ?? '',
    ]),
  );
}

const theme = colours(/@theme\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '');
const inPrint = colours(block);

/**
 * ⚠️ Two thresholds, deliberately far apart.
 *
 * A token must be **re-inked** only if it is genuinely pale (above 0.45), and whatever
 * replaces it must be genuinely dark (0.35 or below). A single threshold would put
 * `--color-chalk-2` — which computes to 0.352 — on a knife edge, where the verdict turns on
 * the last digit of a hex value rather than on whether anybody can read the page.
 */
const TOO_PALE_FOR_PAPER = 0.45;
const DARK_ENOUGH_FOR_PAPER = 0.35;

/** Not foreground colours: white is meant to be white, and these two carry no value. */
const NOT_INK = new Set(['--color-white', '--color-current', '--color-transparent']);

const SURFACES = ['--color-ink', '--color-panel', '--color-panel-2'];

/**
 * Tokens the "must be dark" rule does not apply to, for two different reasons.
 *
 * ⚠️ Surfaces are *supposed* to become white — that is the point of the override. Hairlines
 * are supposed to stay grey, because a table rule in full black prints heavier than the text
 * it separates. Neither is foreground, and a test demanding they be dark would be demanding a
 * worse-looking page.
 */
const NOT_FOREGROUND = [...SURFACES, '--color-line', '--color-line-2'];

describe('printing a dark theme', () => {
  it('has a palette to test — the theme block was found', () => {
    expect(Object.keys(theme).length).toBeGreaterThan(8);
  });

  it('re-inks every colour too pale to read on paper', () => {
    /*
     * ⭐ Derived from the palette, not listed here.
     *
     * A hardcoded list is right until somebody adds the ninth accent colour, at which point it
     * silently stops covering the palette. This asks the theme which of its own colours are
     * pale and demands an override for each — so the next pale token fails this on the day it
     * lands, rather than on the day a customer prints it.
     */
    const pale = Object.entries(theme)
      .filter(([name]) => !NOT_INK.has(name))
      .filter(([, hex]) => luminance(hex) > TOO_PALE_FOR_PAPER)
      .map(([name]) => name)
      .sort();

    /* `--color-lime` is the price. If this list is ever empty the parse broke, not the CSS. */
    expect(pale).toContain('--color-lime');
    expect(pale.filter((name) => !(name in inPrint))).toEqual([]);
  });

  it('re-inks them to something actually dark', () => {
    const stillPale = Object.entries(inPrint)
      .filter(([name]) => !NOT_INK.has(name))
      .filter(([name]) => name in theme)
      .filter(([, hex]) => luminance(hex) > DARK_ENOUGH_FOR_PAPER)
      .map(([name]) => name);

    expect(stillPale.filter((name) => !NOT_FOREGROUND.includes(name))).toEqual([]);
  });

  it('turns the page surfaces white rather than leaving them near-black', () => {
    for (const surface of SURFACES) {
      expect(luminance(inPrint[surface] ?? '#000000')).toBeGreaterThan(0.9);
    }
  });
});
