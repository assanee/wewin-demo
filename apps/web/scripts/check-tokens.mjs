#!/usr/bin/env node
/**
 * The token lockdown, checked three ways — and the third way is the one that was missing.
 *
 * `src/app/globals.css` wipes four Tailwind namespaces with `: initial` so that `text-sm`,
 * `sm:` and `bg-slate-800` produce **no CSS at all**. The project's design tokens are
 * enforced by the tooling rather than by review, and the plan measured the result: 0 uses
 * of the stock scales against 193 of the project's. Phase 2 verified it by building and
 * grepping the emitted stylesheet; this is that check, wired into every build of this app
 * — because the thing most likely to undo it is a framework scaffold quietly restoring the
 * defaults, which produces no error anywhere, only text that reverts to the browser's 16px
 * and reads as a design mistake rather than as a bug.
 *
 * ── The three halves, and the question each one asks ─────────────────────────────
 *
 *   **lockdown → the built CSS.** "Does `.text-sm` produce a rule, and does
 *      `.text-body`?" Only the emitted stylesheet can answer, and it is the question
 *      phase 2 asked. It catches **a wiped namespace coming back**.
 *
 *   **lock file → the source CSS.** "Is the palette still the palette?" Tailwind v4
 *      emits only the theme variables the generated utilities reference, so a token
 *      nothing has used yet is legitimately absent from the bundle and present in the
 *      `@theme` block. Comparing source against `scripts/tokens.lock.json` compares
 *      every token including those.
 *
 *   **dead utilities → both.** "Every class this app *writes* — does it produce a rule?"
 *      This is the inverse of the first question, it was absent until 6b closed, and its
 *      absence was demonstrated rather than deduced: `text-sm sm:flex bg-slate-800`
 *      written into the real `className` of `Badge.tsx` built, type-checked, linted and
 *      passed this very script, then shipped three utilities that styled nothing. The
 *      first half cannot see that, by construction — see half three's own header.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');

const failures = [];
const notes = [];

/* ------------------------------------------------------------------ *
 * Half one — the lockdown, against the built stylesheet
 * ------------------------------------------------------------------ */

/**
 * Every `.css` under a directory tree, concatenated.
 *
 * Recursive rather than a fixed path, because the fixed path is a fact about a bundler
 * version and not about this project: Turbopack writes `.next/static/chunks/*.css` where
 * webpack wrote `.next/static/css/*.css`. A check that looked only in the old place would
 * have reported "no CSS", which is indistinguishable from "the build is broken" and would
 * most likely have been *fixed* by deleting the check.
 */
const readCssUnder = (directory) => {
  if (!existsSync(directory)) return null;
  const collected = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'cache') walk(path);
      } else if (entry.name.endsWith('.css')) {
        collected.push(readFileSync(path, 'utf8'));
      }
    }
  };
  walk(directory);
  return collected.length === 0 ? null : collected.join('\n');
};

const built = readCssUnder(join(appRoot, '.next', 'static'));
if (built === null) {
  console.error('check-tokens: no CSS under apps/web/.next/static — run `next build` first.');
  process.exit(1);
}

/*
 * `\.text-sm` alone is wrong, and the Vite build is what proves it: `.text-small` contains
 * the substring `text-sm`, so a naive grep reports the stock scale alive in a stylesheet
 * that does not have it. The class name has to be followed by a terminator.
 */
const classIsGenerated = (name) =>
  new RegExp(String.raw`\.${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\w-])`).test(built);

// Must exist: the project's own scale, and it must resolve through the project's variable.
for (const [name, variable] of [
  ['text-caption', '--text-caption'],
  ['text-body', '--text-body'],
  ['text-lead', '--text-lead'],
  ['text-display', '--text-display'],
]) {
  if (!classIsGenerated(name)) {
    failures.push(`project token \`${name}\` produced no rule — the type scale is not loading`);
  } else if (!built.includes(`var(${variable})`)) {
    failures.push(`\`${name}\` produced a rule but does not reference \`${variable}\``);
  }
}
if (!classIsGenerated('numeric') || !classIsGenerated('container-page')) {
  failures.push('the project @utility rules (`numeric`, `container-page`) produced no CSS');
}

// Must NOT exist: Tailwind's stock scales, wiped by `: initial`.
for (const name of ['text-sm', 'text-xs', 'text-base', 'text-lg', 'text-xl', 'text-2xl']) {
  if (classIsGenerated(name)) {
    failures.push(
      `stock type token \`${name}\` produced CSS — \`--text-*: initial\` is no longer in effect`,
    );
  }
}
for (const name of ['bg-slate-800', 'text-slate-500', 'bg-gray-100', 'border-zinc-700']) {
  if (classIsGenerated(name)) {
    failures.push(
      `stock palette class \`${name}\` produced CSS — \`--color-*: initial\` is no longer in effect`,
    );
  }
}
// Stock Tailwind's breakpoints are 40/48/64/80/96rem. This project has two, both in pixels.
for (const width of ['40rem', '48rem', '64rem', '80rem', '96rem']) {
  if (built.includes(`min-width:${width}`) || built.includes(`min-width: ${width}`)) {
    failures.push(
      `a stock breakpoint (${width}) reached the stylesheet — \`--breakpoint-*: initial\` is no longer in effect`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * Half two — the token table, against a snapshot that outlived the app it came from
 * ------------------------------------------------------------------ */

/**
 * This half used to compare `src/app/globals.css` against `apps/web/src/index.css`, the
 * Vite storefront's stylesheet, token for token. That app is gone — 6b finished and the
 * App Router one took its name — and the script said in as many words what should happen
 * on this day: *the parity half is what gets rewritten in the commit that removes it, not
 * deleted*.
 *
 * So the comparison keeps both of its properties and loses its second copy of the app.
 * `scripts/tokens.lock.json` is the Vite `@theme` block's 38 declarations, extracted from
 * `apps/web/src/index.css` at its last commit and checked in. Drift is still a diff
 * against a value somebody wrote down on purpose; what changed is that the value now
 * lives in a file whose only job is to be that value, rather than in a second application
 * that had to be kept alive to hold it.
 *
 * Editing the lock file is allowed and is the point — a token *should* be changeable. It
 * is a four-line diff in a review, which is exactly the visibility the check exists for,
 * and the thing it stops is the silent case: a scaffold, a merge or a copied component
 * quietly reintroducing Tailwind's stock palette underneath the project's.
 */

const themeBlock = (css) => {
  const start = css.indexOf('@theme {');
  if (start === -1) return null;
  const end = css.indexOf('\n}', start);
  return end === -1 ? null : css.slice(start, end);
};

const declarations = (css) => {
  const found = new Map();
  // The trailing `\*?` is not optional: the four wipes are named `--color-*`, `--text-*`,
  // `--breakpoint-*` and `--font-*`, and a name pattern without it silently skips the only
  // four declarations in the file that decide whether the lockdown exists at all.
  for (const match of css.matchAll(/(--[a-z0-9-]+\*?)\s*:\s*([^;}]+)/gi)) {
    const [, name = '', raw = ''] = match;
    // First wins: `--leading-reading` is declared once on `:root` and again on
    // `:root[data-script='han']`, and the base value is the one that must match.
    if (!found.has(name)) found.set(name, raw.trim());
  }
  return found;
};

const lockPath = join(here, 'tokens.lock.json');
const ownSource = join(appRoot, 'src', 'app', 'globals.css');
const ownCss = readFileSync(ownSource, 'utf8');
const ownTheme = themeBlock(ownCss);

if (!existsSync(lockPath)) {
  failures.push(`token lock: ${lockPath} does not exist — nothing to compare against`);
} else if (ownTheme === null) {
  failures.push('token lock: could not find an `@theme { … }` block in globals.css');
} else {
  const expected = new Map(Object.entries(JSON.parse(readFileSync(lockPath, 'utf8'))));
  const actual = declarations(ownTheme);

  /*
   * The four reading line-heights are routed through `--leading-reading` here, so that
   * Han can drop the Thai allowance with a single override (plan 8.3: "one value with a
   * per-script override, NOT eight type scales"). Resolving the variable back to its base
   * value is what makes this a comparison of values rather than of spellings.
   */
  const leading = declarations(ownCss).get('--leading-reading');
  const resolve = (value) =>
    leading === undefined ? value : value.replaceAll('var(--leading-reading)', leading);

  /*
   * The four wipes themselves, asserted at source level rather than inferred from the
   * bundle — and this is the assertion the whole check rests on.
   *
   * The built-CSS half above can only see a stock class that was *written somewhere*,
   * because Tailwind emits nothing it has not found in source. Its sensitivity is
   * therefore an accident of what the app happens to contain — and since the specimen
   * page that used to name `text-sm` and `bg-slate-800` in its prose was replaced by the
   * real home page, the text those greps hunt for survives in exactly one scanned file:
   * this one. That is load-bearing and it is pinned by `tests/tokens.test.ts`.
   *
   * These four lines cannot go quiet. If one is missing, the namespace is live whether
   * or not anything has used it yet.
   */
  for (const namespace of ['--color-*', '--text-*', '--breakpoint-*', '--font-*']) {
    if (actual.get(namespace) !== 'initial') {
      failures.push(
        `\`${namespace}: initial\` is missing from globals.css — Tailwind's stock ${namespace.slice(2, -2)} scale is live again, and every class in it will now silently produce CSS`,
      );
    }
    if (expected.get(namespace) !== 'initial') {
      failures.push(`\`${namespace}: initial\` is missing from scripts/tokens.lock.json`);
    }
  }

  const compared = [...expected.keys()].filter(
    (name) =>
      name.startsWith('--color-') ||
      name.startsWith('--text-') ||
      name.startsWith('--breakpoint-'),
  );

  if (compared.length < 30) {
    failures.push(
      `token lock holds only ${compared.length} properties — the file is wrong, not the CSS`,
    );
  }

  for (const name of compared) {
    const want = expected.get(name);
    const got = actual.get(name);
    if (got === undefined) {
      failures.push(`token \`${name}\` is in the lock file and missing from globals.css`);
    } else if (resolve(got) !== want) {
      failures.push(`token \`${name}\` drifted: lock \`${want}\` vs globals.css \`${resolve(got)}\``);
    }
  }

  for (const name of actual.keys()) {
    if (name.endsWith('-*')) continue;
    if (!name.startsWith('--font-') && !expected.has(name)) {
      failures.push(`token \`${name}\` was invented in globals.css and is not in the lock file`);
    }
  }

  notes.push(
    `check-tokens: ${compared.length} design tokens compared against scripts/tokens.lock.json, value for value.`,
  );
}

/* ------------------------------------------------------------------ *
 * Half three — every utility a component actually wrote produces CSS
 * ------------------------------------------------------------------ */

/**
 * 🔴 The half that was missing, and the mutation that proved it was missing.
 *
 * Half one asks *"does `.text-sm` appear in the emitted stylesheet"* and requires the
 * answer to be no. That answer is no whether or not anybody wrote `text-sm` — Tailwind
 * emits nothing it did not find in source — so half one detects **a namespace coming
 * back** and can never detect **a utility that is dead**. Those are inverses, and the
 * plan's 8.5 failure mode is the second one.
 *
 * Measured, not argued: `text-sm sm:flex bg-slate-800` was written into the real
 * `className` of the inner `<span>` in `components/common/Badge.tsx` — a component on all
 * 81 catalogue cards. `next build` passed, `tsc` passed, `oxlint` passed, and this script
 * printed *"the type scale produces CSS, the stock scales produce none. OK"*. The built
 * page shipped with three utilities that produce no rule at all: font-size inherited at
 * 12px instead of 13px, background transparent, `display: block` where `flex` was asked
 * for. Nothing anywhere said a word.
 *
 * So this half asks the opposite question of the same stylesheet: **for every class token
 * this app writes, is there a rule?** It is the direction that catches a contributor
 * reaching for muscle memory, which is the way the lockdown actually gets violated.
 *
 * ── The escaping, which is where a naive version of this goes wrong ──────────────
 *
 * A class *token* is not a CSS *selector*. Tailwind escapes `:`, `/`, `.`, `[`, `]`, `(`,
 * `)`, `,`, `%` and `!` with a backslash, and a leading digit as a hex escape. Looking for
 * `.md:grid-cols-2` finds nothing in a stylesheet that spells it `.md\:grid-cols-2`, and a
 * scanner that reports every responsive utility as dead is a scanner that gets deleted on
 * its first run. `escapeClass` below is the same transformation Tailwind applies.
 */

const IGNORED_PREFIXES = [
  // `group`/`peer` are markers: they parent a `group-hover:` rule and emit nothing
  // themselves. Same for the `sr-only`-adjacent `not-sr-only`, which only ever appears
  // behind a `focus:` variant that does emit.
  'group',
  'peer',
];

const escapeClass = (name) => {
  let out = '';
  for (const [index, character] of [...name].entries()) {
    if (/[\w-]/.test(character)) {
      // A leading digit has to be a hex escape; `.2xl` is not a selector.
      out += index === 0 && /\d/.test(character) ? `\\3${character} ` : character;
    } else {
      out += `\\${character}`;
    }
  }
  return out;
};

const sourceRoot = join(appRoot, 'src');
const sourceFiles = [];
const walkSource = (current) => {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) walkSource(path);
    else if (/\.tsx?$/.test(entry.name)) sourceFiles.push(path);
  }
};
walkSource(sourceRoot);

/*
 * Comments first, and this is not tidiness. Half three reads *class lists*, and a prose
 * paragraph inside a component is a run of words that a naive reader turns into forty
 * "dead utilities" called `the`, `so` and `does).` — a report nobody would read twice and
 * a check that would be deleted within the day. The same strip runs in
 * `tests/cache-policy.test.ts` for the same reason, and the `[^:]` guard on the line
 * comment is what stops it eating the `//` in a `https://` inside a string.
 */
const stripComments = (source) =>
  source.replaceAll(/\/\*[\s\S]*?\*\//g, ' ').replaceAll(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

/**
 * Every string literal in an expression, with template holes removed.
 *
 * `` `flex ${active ? 'text-chalk' : 'text-chalk-2'}` `` yields `flex`, `text-chalk` and
 * `text-chalk-2` — the hole is cut out before the backtick run is read, so the ternary's
 * own `?` and `:` never reach the token list, and both branches are still checked because
 * they are string literals in their own right.
 */
const stringLiterals = (expression) => {
  const withoutHoles = expression.replaceAll(/\$\{[^{}]*\}/g, ' ');
  const found = [];
  for (const match of withoutHoles.matchAll(/'([^']*)'|"([^"]*)"|`([^`]*)`/g)) {
    found.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return found;
};

/**
 * The class lists this app writes, from the two places it writes them.
 *
 * 1. `className="…"` and `className={…}` — the attribute itself, with the expression
 *    scanned to its matching brace rather than to the first `}`, so a template literal
 *    containing `${…}` does not truncate the read.
 * 2. A `const` whose **name contains `class`**, case-insensitively. Utilities live in
 *    named constants often enough that ignoring them would leave a real hole:
 *    `AppHeader`'s `navLinkClass` and `AppFooter`'s `SECTION_HEADING_CLASS` are the whole
 *    styling of a nav item and a footer heading. Naming the convention is what makes it
 *    checkable — `tests/tokens.test.ts` fails if a component holds a utility string in a
 *    constant this scanner cannot see.
 */
const declaredClassConstant = /(?:const|let)\s+([A-Za-z0-9_]*[Cc][Ll][Aa][Ss][Ss][A-Za-z0-9_]*)\s*(?::[^=]*)?=/g;

const classLists = (source) => {
  const lists = [];
  const pattern = /className\s*=\s*/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    let index = match.index + match[0].length;
    const opener = source[index];

    if (opener === '"' || opener === "'") {
      const end = source.indexOf(opener, index + 1);
      if (end === -1) continue;
      lists.push(source.slice(index + 1, end));
      pattern.lastIndex = end;
      continue;
    }
    if (opener !== '{') continue;

    let depth = 0;
    let quote = null;
    let cursor = index;
    for (; cursor < source.length; cursor += 1) {
      const character = source[cursor];
      if (quote !== null) {
        if (character === '\\') cursor += 1;
        else if (character === quote) quote = null;
        continue;
      }
      if (character === '"' || character === "'" || character === '`') quote = character;
      else if (character === '{') depth += 1;
      else if (character === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    lists.push(...stringLiterals(source.slice(index + 1, cursor)));
    pattern.lastIndex = cursor;
  }

  for (const constant of source.matchAll(declaredClassConstant)) {
    const from = constant.index + constant[0].length;
    lists.push(...stringLiterals(source.slice(from, endOfInitialiser(source, from))));
  }

  return lists;
};

/**
 * Where a declaration's initialiser ends: the first `;` outside every bracket and quote.
 *
 * A fixed window was the first attempt and it read past the end of `ACTION_CLASS` into a
 * `t('quote.action.edit')` two lines below, then reported that translation key as a dead
 * utility. A scanner whose false positives are other people's correct code is a scanner
 * that gets switched off, so the bound is the syntax rather than a character count.
 */
const endOfInitialiser = (source, from) => {
  let depth = 0;
  let quote = null;
  for (let cursor = from; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    if (quote !== null) {
      if (character === '\\') cursor += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') quote = character;
    else if ('{[('.includes(character)) depth += 1;
    else if ('}])'.includes(character)) depth -= 1;
    else if (character === ';' && depth <= 0) return cursor;
  }
  return source.length;
};

/** A class token, as opposed to a word: no spaces, and it starts like a utility. */
const looksLikeUtility = (token) => /^[a-z0-9[!@-]/i.test(token) && !/[${}<>;]/.test(token);

const written = new Map();
for (const path of sourceFiles) {
  const source = stripComments(readFileSync(path, 'utf8'));
  for (const list of classLists(source)) {
    for (const token of list.split(/\s+/)) {
      if (token === '' || !looksLikeUtility(token)) continue;
      if (!written.has(token)) written.set(token, relative(appRoot, path));
    }
  }
}

if (written.size < 100) {
  // The empty-scan failure, again: a regex that stopped matching would report zero dead
  // utilities out of zero utilities and read exactly like a clean run.
  failures.push(
    `the className scan found only ${written.size} distinct utilities — the scan is broken, not the CSS`,
  );
}

const dead = [];
for (const [token, file] of written) {
  if (IGNORED_PREFIXES.includes(token)) continue;
  const selector = `.${escapeClass(token)}`;
  /*
   * Escaping, twice, for two different languages — and getting the second one wrong is
   * how the first attempt at this died. `escapeClass` produced the CSS *selector*
   * (`.md\:grid-cols-\[repeat\(auto-fit\,minmax\(140px\,1fr\)\)\]`); handing that to
   * `RegExp` unescaped made the `[…]` a character class and threw "range out of order".
   * Escaping every character that is not a word character or a hyphen covers the
   * backslashes `escapeClass` just added along with everything else.
   *
   * The terminator matters for the same reason it does in half one: `.text-small`
   * contains `.text-sm`. Here the risk runs the other way — `.grid` must not be satisfied
   * by `.grid-cols-3` — so the character after the selector must not continue the name.
   */
  const pattern = selector.replaceAll(/[^\w-]/g, (character) => `\\${character}`);
  if (!new RegExp(`${pattern}(?![\\w-])`).test(built)) {
    dead.push(`${token} (${file})`);
  }
}

if (dead.length > 0) {
  failures.push(
    `${dead.length} utilities produce no CSS at all — they are in a wiped namespace or misspelt, ` +
      `and they fail silently on the page:\n      ${dead.join('\n      ')}`,
  );
}

notes.push(
  `check-tokens: ${written.size} distinct utilities written across ${sourceFiles.length} components, every one of them producing a rule.`,
);

/* ------------------------------------------------------------------ */

for (const note of notes) console.log(note);

if (failures.length > 0) {
  console.error('\ncheck-tokens FAILED:');
  for (const failure of failures) console.error(`  · ${failure}`);
  console.error(
    '\nThe design tokens are enforced by this check and by nothing else. If a change here was ' +
      'intended, plan 8.5 is the argument to read first — and this check has to be rewritten in ' +
      'the same commit, not deleted.\n',
  );
  process.exit(1);
}

console.log('check-tokens: the type scale produces CSS, the stock scales produce none. OK');
