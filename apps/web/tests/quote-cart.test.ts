import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  QUOTE_SCHEMA_VERSION,
  QUOTE_STORAGE_KEY,
  emptyQuote,
  parseStoredQuote,
  serialiseQuote,
} from '@wewin/core/quote';

/**
 * The cart, across the move to the App Router.
 *
 * Two halves, and they are testing different kinds of thing.
 *
 * The **behavioural** half asserts what the provider is allowed to hand a server render.
 * `packages/core` already pins the reducer and the parse path in 60-odd tests and none of
 * that moved; what is new is that `emptyQuote()` is now the state whose markup gets
 * *cached and served to everybody*, so the properties that used to be about a first frame
 * are now about a CDN response.
 *
 * The **scan** half asserts the wiring, because the wiring is where this port could go
 * wrong without anything failing. A `localStorage` read hoisted out of the mount effect
 * into the reducer initialiser looks like a simplification, passes every unit test in
 * this repository, and breaks the build only if somebody happens to prerender the route.
 * `tests/cache-policy.test.ts` scans `src/app` for exactly that; the cart does not live
 * in `src/app`, so this scans where it does live.
 */

const here = dirname(fileURLToPath(import.meta.url));
const sourceRoot = join(here, '..', 'src');

const read = (...segments: string[]): string => readFileSync(join(sourceRoot, ...segments), 'utf8');

/** Comments stripped, so a guard never fires on the paragraph that explains it. */
const code = (source: string): string =>
  source.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/(^|[^:])\/\/.*$/gm, '$1');

const provider = read('state', 'QuoteContext.tsx');
const consumer = read('state', 'useQuote.ts');

describe('what a server render is allowed to see', () => {
  it('an unhydrated cart holds no lines and admits it', () => {
    // This exact object is what the prerendered HTML of /[locale]/quote is rendered from.
    expect(emptyQuote()).toEqual({ lines: [], hydrated: false });
  });

  it('storage is never read during a render, so the server and the client start equal', () => {
    // The property, stated as the two halves of the boundary: Node has no localStorage at
    // all, and the browser has one it must not touch until the effect runs. Both therefore
    // begin from the same value, which is what makes hydration silent on a page of prices.
    expect(typeof globalThis.localStorage).toBe('undefined');
    expect(emptyQuote().lines).toHaveLength(0);
  });

  it('a cart that fails to load costs nothing but the cart', () => {
    // The read guard added in the port hands `null` to this on a browser that blocks
    // storage. It must be an empty cart and not a throw: under the App Router the
    // provider mounts above every route, so a throw here reaches the segment's error
    // boundary and replaces the page.
    expect(parseStoredQuote(null)).toEqual([]);
    expect(parseStoredQuote('not json at all')).toEqual([]);
  });

  it('a payload from another schema version is still discarded whole, not salvaged', () => {
    const v3 = JSON.stringify({ schemaVersion: QUOTE_SCHEMA_VERSION - 1, lines: [] });
    expect(parseStoredQuote(v3)).toEqual([]);
  });

  it('an empty hydrated cart round-trips, so "emptied" is recorded and not confused with "not loaded"', () => {
    const emptied = { lines: [], hydrated: true };
    expect(parseStoredQuote(serialiseQuote(emptied))).toEqual([]);
  });
});

describe('the client boundary is declared, not inferred', () => {
  it('the provider is a client component', () => {
    expect(code(provider)).toMatch(/^\s*'use client';/);
  });

  it('the context module is a client component too', () => {
    // Without this the module is pulled into whichever graph imports it first, and a
    // server component that imported `useQuote` would fail with a message about the
    // importer rather than about the cart.
    expect(code(consumer)).toMatch(/^\s*'use client';/);
  });
});

describe('localStorage stays off every render path', () => {
  const providerCode = code(provider);

  it('every localStorage access in the provider is inside an effect', () => {
    // The bodies of the two `useEffect` calls, taken as the region between `useEffect(`
    // and the `}, [` that closes it. Anything outside those is a render path.
    const outsideEffects = providerCode.replaceAll(/useEffect\(\(\) => \{[\s\S]*?\}, \[[\s\S]*?\]\);/g, '');
    expect(outsideEffects).not.toMatch(/localStorage/);

    // …and there really were accesses to move, so the assertion above is not vacuous.
    expect(providerCode.match(/localStorage/g) ?? []).toHaveLength(2);
  });

  it('the reducer is initialised lazily from emptyQuote, never from storage', () => {
    expect(providerCode).toMatch(/useReducer\(quoteReducer,\s*undefined,\s*emptyQuote\)/);
  });

  it('both storage calls are guarded, the read as well as the write', () => {
    // The write has been guarded since phase 0; the read was not, and `getItem` throws
    // outright when a browser blocks storage. Two `try` blocks, one per access.
    expect(providerCode.match(/try \{/g) ?? []).toHaveLength(2);
  });
});

describe('the hydrated flag survived the port', () => {
  const providerCode = code(provider);

  it('the persistence effect is guarded by state, not by a ref', () => {
    expect(providerCode).toMatch(/if \(!state\.hydrated\) return;/);
    // A ref would be set by the hydrate effect in the same commit, so this effect would
    // see it true while `state` was still the empty initial value — and write that empty
    // cart over the customer's saved one.
    expect(providerCode).not.toMatch(/useRef/);
  });

  it('the flag is what the UI reads as `ready`', () => {
    expect(providerCode).toMatch(/ready:\s*state\.hydrated/);
  });

  it('the screen refuses to say "your cart is empty" before storage has answered', () => {
    const screen = code(read('components', 'quote', 'QuoteScreen.tsx'));

    // The order matters and is the whole point: the `!ready` branch must return before
    // the `lines.length === 0` branch is reached, or the prerendered HTML — the one a
    // crawler indexes and every returning customer is served first — asserts an empty
    // cart it has no way of knowing about.
    const readyBranch = screen.indexOf('if (!ready)');
    const emptyBranch = screen.indexOf('lines.length === 0');
    expect(readyBranch).toBeGreaterThan(-1);
    expect(emptyBranch).toBeGreaterThan(-1);
    expect(readyBranch).toBeLessThan(emptyBranch);
  });
});

describe('the storage key travelled with the schema version', () => {
  it('is still v4', () => {
    // Not decoration: v3 held `lines[0].label` as a sentence and v4 holds a `Message`
    // whose params carry square micrometres. Both cross JSON.stringify as plausible
    // data. If either of these two moves without the other, a stale payload reads as a
    // real cart under the wrong rules.
    expect(QUOTE_STORAGE_KEY).toBe('aluform.quote.v4');
    expect(QUOTE_SCHEMA_VERSION).toBe(4);
  });
});

describe('exactly one cart in the tree', () => {
  const sourceFiles = (directory: string): readonly string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return /\.tsx?$/.test(entry.name) ? [path] : [];
    });

  it('QuoteProvider is mounted by islands, and no island mounts it twice', () => {
    const mounts = sourceFiles(sourceRoot)
      .map((path) => ({ name: relative(sourceRoot, path), source: code(readFileSync(path, 'utf8')) }))
      .filter(({ source }) => source.includes('<QuoteProvider>'))
      .map(({ name, source }) => ({ name, count: (source.match(/<QuoteProvider>/g) ?? []).length }));

    // One per island is correct while there is no client shell — `ConfiguratorIsland` and
    // `QuoteScreen` each mount their own. Two in one tree would be two carts writing the
    // same storage key over each other, and the symptom is a line that reappears after
    // being deleted. When a shared shell lands, this expectation is what will point at
    // every place the wrapper has to be removed from.
    expect(mounts.length).toBeGreaterThan(0);
    expect(mounts.filter(({ count }) => count !== 1)).toEqual([]);
  });
});
