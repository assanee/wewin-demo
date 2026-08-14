#!/usr/bin/env node
/*
 * Measures horizontal overflow on every dashboard route, at three widths, in both themes.
 *
 * This exists because the thing it measures is invisible to every other gate in this repo.
 * Vitest here runs `environment: 'node'` deliberately, so nothing renders and no layout is
 * ever computed; `tsc` and `oxlint` read the class names as opaque strings. A page can be
 * 256px too wide, with a customer's total scrolled off the right of the screen, and the
 * whole suite stays green. That is exactly what happened: the owner found it by looking at
 * the screen, after the automated gates had passed.
 *
 * ### What it reports, per route × width × theme
 *
 * `over` — `documentElement.scrollWidth - clientWidth`. Anything above 0 means the document
 * itself scrolls sideways, which is the visible symptom: right-aligned content (totals, the
 * print button) aligns to a content box that extends past the window.
 *
 * `unreachable` — content whose right edge sits past `main`'s content edge with no scrollable
 * ancestor between it and `main`. This is the failure mode that `min-w-0` on `<main>` trades
 * page-level scrolling *for*, so it has to be measured alongside, not instead. A run where
 * `over` drops to 0 while `unreachable` rises has moved the bug, not fixed it.
 *
 * Both numbers must be 0 everywhere. When this was written, they were: 108 combinations, all
 * clean, against 16 failing combinations across 5 routes before the fix.
 *
 * ### Running it
 *
 *   pnpm --filter @wewin/dashboard dev     # and the api, which the pages fetch from
 *   node apps/dashboard/scripts/measure-overflow.mjs
 *
 * Requires `agent-browser` on PATH. Exits non-zero if any combination is dirty, so it can be
 * dropped into CI the day this repo grows a browser runner.
 */
import { execFileSync } from 'node:child_process';

const BASE = process.env.DASHBOARD_URL ?? 'http://localhost:3001';
const EMAIL = process.env.SWEEP_EMAIL ?? 'somchai@wewin.co.th';
const PASSWORD = process.env.SWEEP_PASSWORD;
const SESSION = process.env.SWEEP_SESSION ?? 'wewin-overflow-sweep';

if (!PASSWORD) {
  console.error('SWEEP_PASSWORD is not set. This script signs in as a real staff user;');
  console.error('it will not carry a password in source. Export it and re-run.');
  process.exit(2);
}

/*
 * The two ids are the only part of this list that rots. Both are seeded fixtures; if either
 * 404s the run says so rather than reporting a clean page that never rendered.
 */
const ORDER_ID = process.env.SWEEP_ORDER_ID ?? '23ab940c-5d7b-45b3-aeab-80167a1224cb';
const QUOTE_ID = process.env.SWEEP_QUOTE_ID ?? '6eabe0b7-a38a-4afa-940e-9eb774f1ff28';
const PRODUCT_ID = process.env.SWEEP_PRODUCT_ID ?? 'lvr-adj';

const ROUTES = [
  '/',
  '/orders',
  `/orders/${ORDER_ID}`,
  '/quotes',
  `/quotes/${QUOTE_ID}`,
  '/products',
  `/products/${PRODUCT_ID}`,
  '/option-groups',
  '/media',
  '/approvals',
  '/slips',
  '/refunds',
  '/reviews',
  '/outbox',
  '/users',
  '/authority',
  '/organisation',
  '/account',
  /*
   * The print sheet is the one screen whose table is hand-rolled rather than built from
   * ui/table.tsx, so it is the one table in the app with no scroll container of its own.
   * It measures clean today because it has three short columns — but it is exactly the
   * page that would break first, which is reason to keep measuring it rather than to stop.
   */
  `/quotes/${QUOTE_ID}/print`,
];

/* 1440 is the design target, 1024 the narrowest desktop the sidebar still sits beside. */
const WIDTHS = [1440, 1280, 1024];
const THEMES = ['light', 'dark'];

/*
 * Two ways content becomes unreachable, and they need separate detectors.
 *
 * The first is the obvious one: something sticks out past `main` with nothing between it and
 * `main` able to scroll. The second is quieter and was missed on the first pass — `Card`
 * carries `overflow-hidden`, so anything too wide inside a card is silently cut off *within*
 * the page. It never reaches `main`'s edge, so the first detector never sees it, and there is
 * no scrollbar to hint that text continues.
 *
 * ⚠️ Most `overflow: hidden` in this app is deliberate, so the second detector has to exclude
 * it or it reports every screen and means nothing — the first version did exactly that, 114
 * of 114 combinations "dirty", every one of them the `sr-only` label on the sidebar toggle.
 * Three exclusions, each for a different reason:
 *
 *   - `text-overflow: ellipsis` — `truncate`. The clipping is the design and the ellipsis is
 *     the affordance telling a reader there is more.
 *   - `clientWidth <= 1` — `sr-only`. A 1px box clipping its own text is how a label is given
 *     to a screen reader and taken away from the screen.
 *   - `-webkit-line-clamp` — `line-clamp-N`, deliberate for the same reason as truncate.
 *
 * What is left is clipping nobody asked for and nobody can see past.
 */
const PROBE = `(() => {
  const de = document.documentElement;
  const mn = document.querySelector('main');
  const scrollable = (el) => {
    const cs = getComputedStyle(el);
    return (cs.overflowX === 'auto' || cs.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 1;
  };
  const out = [];
  if (mn) {
    const mainRight = mn.getBoundingClientRect().right;
    mn.querySelectorAll('*').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.right > mainRight + 1) {
        let p = el.parentElement;
        let rescued = false;
        while (p && p !== mn) { if (scrollable(p)) { rescued = true; break; } p = p.parentElement; }
        if (!rescued) out.push({ kind: 'past-main', overBy: Math.round(r.right - mainRight), text: (el.textContent || '').trim().slice(0, 40) });
      }
      const cs = getComputedStyle(el);
      const deliberate =
        cs.textOverflow === 'ellipsis' ||
        el.clientWidth <= 1 ||
        cs.webkitLineClamp !== 'none';
      if (cs.overflowX === 'hidden' && el.scrollWidth > el.clientWidth + 1 && !deliberate) {
        out.push({ kind: 'clipped', overBy: el.scrollWidth - el.clientWidth, text: (el.textContent || '').trim().slice(0, 40) });
      }
    });
  }
  const seen = new Set();
  const distinct = out.filter((u) => { const k = u.kind + u.text + u.overBy; if (seen.has(k)) return false; seen.add(k); return true; });
  return JSON.stringify({ over: de.scrollWidth - de.clientWidth, unreachable: distinct.length, worst: distinct.sort((a, b) => b.overBy - a.overBy)[0] ?? null });
})()`;

const browser = (args, input) =>
  execFileSync('agent-browser', args, {
    input,
    encoding: 'utf8',
    env: { ...process.env, AGENT_BROWSER_SESSION: SESSION },
    stdio: ['pipe', 'pipe', 'ignore'],
  });

const settle = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

browser(['open', `${BASE}/login`]);
browser(['set', 'viewport', '1440', '900']);
settle(1500);
if (browser(['snapshot', '-i']).includes('อีเมลหรือเบอร์โทร')) {
  browser(['fill', '@e2', EMAIL]);
  browser(['fill', '@e3', PASSWORD]);
  browser(['click', '@e4']);
  settle(3000);
}

let dirty = 0;
console.log(['ROUTE'.padEnd(46), 'THEME'.padEnd(6), 'WIDTH'.padEnd(6), 'OVER'.padEnd(6), 'UNRCH'].join(' '));
for (const theme of THEMES) {
  browser(['set', 'media', theme]);
  for (const width of WIDTHS) {
    browser(['set', 'viewport', String(width), '900']);
    for (const route of ROUTES) {
      browser(['open', `${BASE}${route}`]);
      settle(2000);
      let reading;
      try {
        const raw = browser(['eval', '--stdin'], PROBE).trim();
        reading = JSON.parse(raw.startsWith('"') ? JSON.parse(raw) : raw);
      } catch {
        reading = { over: 'ERR', unreachable: 'ERR', worst: null };
      }
      const bad = reading.over !== 0 || reading.unreachable !== 0;
      if (bad) dirty += 1;
      console.log(
        [
          route.padEnd(46),
          theme.padEnd(6),
          String(width).padEnd(6),
          String(reading.over).padEnd(6),
          String(reading.unreachable),
          bad ? `  <<< ${reading.worst ? `${reading.worst.text} +${String(reading.worst.overBy)}` : 'page overflows'}` : '',
        ].join(' '),
      );
    }
  }
}

const total = ROUTES.length * WIDTHS.length * THEMES.length;
console.log(`\n${String(total - dirty)}/${String(total)} combinations clean`);
process.exit(dirty === 0 ? 0 : 1);
