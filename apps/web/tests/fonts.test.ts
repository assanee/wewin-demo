import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LOCALES, LOCALE_SCRIPT } from '@wewin/i18n/locales';

/**
 * Plan 8.3, checked against the CSS and the font module rather than against intent.
 *
 * `fonts.ts` cannot be imported here — `next/font/google` is a build-time transform, not a
 * runtime module — so these read the two files as text. That is a weaker check than
 * executing them and it is the honest one: what it can prove is that every script in the
 * eight has a face named in the stack, in the right order, and that the reading leading
 * has exactly one override. What it cannot prove is that the glyphs render, which is what
 * the specimen page at `/[locale]` is for.
 */

const here = dirname(fileURLToPath(import.meta.url));
const fonts = readFileSync(join(here, '..', 'src', 'app', 'fonts.ts'), 'utf8');

/*
 * Comments stripped. Both files explain themselves at length and quote the very selectors
 * and variable names these assertions count — `:root[data-script='han']` appears twice in
 * globals.css, once as a rule and once in the paragraph saying why there is only one. A
 * scan that counts the paragraph is a scan whose failure is fixed by deleting the
 * paragraph, which is the worst outcome available for a rule whose reasoning is the only
 * thing keeping it alive.
 */
const css = readFileSync(join(here, '..', 'src', 'app', 'globals.css'), 'utf8').replaceAll(
  /\/\*[\s\S]*?\*\//g,
  '',
);

const stack = /--stack-body:\s*([^;]+);/.exec(css)?.[1]?.replaceAll(/\s+/g, ' ').trim() ?? '';

/** Which `--face-*` variable is expected to cover each script in `LOCALE_SCRIPT`. */
const FACE_FOR_SCRIPT = {
  latin: '--face-body',
  thai: '--face-body',
  devanagari: '--face-devanagari',
  lao: '--face-lao',
  myanmar: '--face-myanmar',
  han: '--face-han-system',
} as const;

describe('every locale can be rendered', () => {
  it('names a face for all four non-Latin scripts', () => {
    // 8.3 counted two (Devanagari and CJK). 8.7(3) corrected it to four — Lao and Myanmar
    // are not Latin either, and `my-MM` renders its *digits* in Myanmar numerals by
    // default, so a page with no Myanmar face shows tofu where the prices are.
    const scripts = new Set(LOCALES.map((locale) => LOCALE_SCRIPT[locale]));
    expect(scripts).toEqual(new Set(['latin', 'devanagari', 'lao', 'myanmar', 'thai', 'han']));

    for (const script of scripts) {
      expect(stack, `no face in the body stack covers ${script}`).toContain(
        FACE_FOR_SCRIPT[script],
      );
    }
  });

  it('keeps the Thai face in the stack for every locale, because there is one stack', () => {
    // 8.7(3): untranslated text degrades to Thai *in place*, so no locale's stack may omit
    // a Thai face. Run that argument to its end and eight stacks collapse into one.
    expect(css).not.toMatch(/\[data-script=['"][a-z]+['"]\]\s*\{[^}]*--stack-body/);
    expect(stack).toContain('--face-body');
  });

  it('puts the shared face first and Han last', () => {
    // font-family resolves per character. A CJK face also ships Latin and Vietnamese
    // glyphs, so first place would give the Chinese page a different face for its digits
    // and its Latin than the other seven have, for no reason anybody chose. Han is a
    // system stack rather than a downloaded face now (see globals.css), and its position
    // in the list matters for exactly the same reason it did before.
    const order = [...stack.matchAll(/--face-[a-z-]+/g)].map((match) => match[0]);
    expect(order[0]).toBe('--face-body');
    expect(order.at(-1)).toBe('--face-han-system');
  });

  it('carries a Vietnamese face, which the body face does not have', () => {
    // Verified against the Google Fonts CSS API, not assumed: IBM Plex Sans Thai ships
    // cyrillic-ext, latin, latin-ext and thai — no `vietnamese`. `vi` is Latin script, so
    // no per-script table flags it, and its diacritics fall to a system font mid-word.
    expect(stack).toContain('--face-latin-vi');
    expect(fonts).toMatch(/IBM_Plex_Sans\(\{[\s\S]*?subsets:\s*\['vietnamese'\]/);
  });
});

describe('one leading, one override', () => {
  it('routes all four reading sizes through a single variable', () => {
    for (const size of ['caption', 'small', 'body', 'lead']) {
      expect(css).toContain(`--text-${size}--line-height: var(--leading-reading);`);
    }
  });

  it('overrides it for Han and for nothing else', () => {
    // 8.3: "one value with a per-script override, NOT eight type scales." Thai stacks
    // vowels and tone marks and needs 1.6; Devanagari stacks marks too and keeps it; CJK
    // does not, and drops back.
    const overrides = [...css.matchAll(/:root\[data-script=['"]([a-z]+)['"]\]/g)].map(
      (match) => match[1],
    );
    expect(overrides).toEqual(['han']);
    expect(css).toMatch(/:root\[data-script='han'\]\s*\{\s*--leading-reading:\s*1\.5;/);
  });

  it('leaves the seven pixel sizes untouched', () => {
    // The override is a leading, not a second type scale.
    for (const [token, px] of [
      ['caption', '12px'],
      ['small', '13px'],
      ['body', '15px'],
      ['lead', '18px'],
      ['title', '24px'],
      ['display', '34px'],
      ['hero', '52px'],
    ]) {
      expect(css).toContain(`--text-${token}: ${px};`);
    }
  });
});

describe('the faces that are downloaded', () => {
  it('preloads the three every locale needs and none of the script faces', () => {
    // `preload` is a build-time flag, so "preload what this locale needs" is not
    // expressible. Body, display and mono are needed everywhere — Thai fallback text can
    // appear on any page and every price is set in the mono face. The five script faces
    // are fetched on demand via unicode-range; the cost is one swap on first paint for a
    // hi/la/my/zh reader, and it is written down in fonts.ts rather than discovered.
    // Seven, not eight: the CJK face is a system stack now and downloads nothing.
    const declarations = [...fonts.matchAll(/const (\w+) = \w+\(\{([\s\S]*?)\n\}\);/g)];
    expect(declarations).toHaveLength(7);

    const preloaded = declarations
      .filter(([, , options = '']) => !options.includes('preload: false'))
      .map(([, name]) => name);
    expect(preloaded.sort()).toEqual(['body', 'display', 'mono']);
  });

  it('downloads no CJK face at all, and names the system one instead', () => {
    // 🔴 Measured: `Noto_Sans_SC` through `next/font/google` put 202 `@font-face` rules —
    // 186,121 bytes, 67 KB gzipped — into the render-blocking stylesheet of every one of
    // the 683 pages, describing slices seven of the eight locales never fetch. The
    // subsetting worked; that is what made the weight pure cost.
    expect(fonts).not.toContain('Noto_Sans_SC');

    // Every platform that can draw Chinese ships one of these. Ordered by platform:
    // macOS/iOS, older macOS, Windows, then the Noto/Source Han families.
    for (const family of ['PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC']) {
      expect(css).toContain(family);
    }

    // And the trap for whoever re-adds a downloaded face is written down where they will
    // look: `subsets: ['latin']` fetches a Chinese font without its Chinese glyphs and
    // fails silently as tofu, and omitting `subsets` is legal only with `preload: false`.
    expect(fonts).toMatch(/subsets/);
    expect(fonts).toMatch(/preload: false/);
  });
});
