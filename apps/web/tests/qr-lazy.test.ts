import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The QR encoder stays out of the bundle every other visitor downloads.
 *
 * It was a 7.29 kB gzip chunk of its own in the Vite build, and it is needed by exactly
 * one interaction: opening the share sheet and asking for the code. A bundler will only
 * split it out if the import is dynamic, and turning `import('qrcode-generator')` into a
 * top-level `import qrcode from 'qrcode-generator'` is a one-line "tidy-up" that produces
 * an identical-looking screen, an identical test result, and 7 kB on every first paint.
 * Nothing fails. That is precisely why it needs a guard rather than a reviewer.
 *
 * Two assertions, because they fail on different mistakes: one says the dynamic import is
 * still there, the other says no static one appeared anywhere — including in a file that
 * did not exist when this was written.
 */

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

const sourceFiles = (directory: string): readonly { name: string; source: string }[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!/\.tsx?$/.test(entry.name)) return [];
    return [{ name: relative(sourceRoot, path), source: readFileSync(path, 'utf8') }];
  });

const files = sourceFiles(sourceRoot);

/** Comments stripped, so the paragraph above a guard cannot trip it. */
const code = (source: string): string =>
  source.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/(^|[^:])\/\/.*$/gm, '$1');

describe('the QR encoder is loaded on demand', () => {
  const users = files.filter(({ source }) => code(source).includes('qrcode-generator'));

  it('somebody uses it, so the scans below have something to be about', () => {
    expect(users.length).toBeGreaterThan(0);
  });

  it('every reference to it is a dynamic import', () => {
    const offenders = users
      .filter(({ source }) => !/import\(\s*['"]qrcode-generator['"]\s*\)/.test(code(source)))
      .map(({ name }) => name);

    expect(offenders).toEqual([]);
  });

  it('no file imports it statically', () => {
    // The regex has to allow for `import qrcode from`, `import { … } from` and a bare
    // `import 'qrcode-generator'`, and must not match the dynamic call — which is why it
    // anchors on a line start rather than on the module name.
    const offenders = files
      .filter(({ source }) => /^\s*import\s[^(]*['"]qrcode-generator['"]/m.test(code(source)))
      .map(({ name }) => name);

    expect(offenders).toEqual([]);
  });

  it('a chunk-load failure has somewhere to land', () => {
    // `qr.failed` is the fallback: the sheet keeps its copy-link button and says the code
    // could not be drawn. Without the `.catch` the rejected import is an unhandled
    // rejection and the sheet shows the placeholder box for ever — a QR that never
    // arrives, with nothing on screen to say so.
    const withCatch = users.filter(({ source }) => /\.catch\(/.test(code(source)));
    expect(withCatch.length).toBe(users.length);
  });
});
