import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DiscoveryService } from '@nestjs/core';
import { afterEach, expect, it } from 'vitest';

import { bootApp, type BootedApp } from '../support/app';

/**
 * Every controller under `src/` is served by the assembled application.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────────
 *
 * Three consecutive phases finished a module — controllers, services, repository, its own
 * green suite — and forgot the one line in `AppModule` that mounts it. Each time, every
 * route in that module was a 404 against the real application while its tests passed, and
 * each time it was the largest finding of the round. Phase 5b, phase 5c, phase 7.
 *
 * Nothing already in the repository could catch it, and it is worth being precise about why,
 * because the near-miss is instructive:
 *
 *   - `tests/rbac/route-audit.test.ts` asserts the *entire* route inventory with
 *     `toStrictEqual`, which is a strong guard — but it compares the routes that exist
 *     against a list of the routes that exist. An unmounted module contributes no route, so
 *     there is no diff, and the audit is green precisely when the module is missing.
 *   - The boot-time audit refuses an *unguarded* route. An absent route is not unguarded.
 *   - The module suites boot their own graph on purpose, which is what makes them fast and
 *     independent — and is exactly what makes them blind to this.
 *
 * Every one of those checks looks at what the application *has*. This one is the only check
 * that looks at what the repository has and asks whether the application caught up.
 *
 * ── What it does not prove ───────────────────────────────────────────────────────
 *
 * That a controller is registered, not that its routes work, are guarded, or are correct.
 * The route audit and the module suites own that. This is the alarm for one specific
 * mistake with a very quiet failure mode, and it should stay that cheap.
 *
 * ── If this fails ────────────────────────────────────────────────────────────────
 *
 * Add the module to `AppModule.forRoot`'s imports, then expect `route-audit.test.ts` to fail
 * next with the new routes in its diff. That second failure is the mechanism working: it is
 * where a human reads the endpoints and their access levels before they exist in production.
 */

const SOURCE = join(__dirname, '..', '..', 'src');

/** Every `.ts` under `src/`, recursively. */
function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}

/**
 * Controller classes declared in a file, by name.
 *
 * A regex and not the TypeScript compiler: the thing being detected is a class that carries
 * `@Controller` and is exported, and both are visible in the text. Pulling in a parser to
 * find them would make the guard the most expensive test in the suite, and would still be
 * looking at the same two tokens.
 *
 * `[\s\S]*?` rather than `.*?` — the decorator and the class are on different lines whenever
 * the decorator takes a path, which is almost always.
 */
const CONTROLLER = /@Controller\([\s\S]*?export class (\w+)/g;

function declaredControllers(): { name: string; file: string }[] {
  return sources(SOURCE).flatMap((path) => {
    const text = readFileSync(path, 'utf8');
    return [...text.matchAll(CONTROLLER)].map((match) => ({
      name: match[1] as string,
      file: path.slice(SOURCE.length + 1),
    }));
  });
}

let app: BootedApp | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

it('mounts every controller that exists in src/, so no module can be finished but unwired', async () => {
  /*
   * The scan must find controllers at all. Without this, a change to how they are declared
   * turns the assertion below into `[] ⊆ anything` — green, permanently, and silently: the
   * exact failure it was written to prevent, wearing this test's own name.
   */
  const declared = declaredControllers();
  expect(declared.length).toBeGreaterThan(15);

  app = await bootApp();
  const mounted = new Set(
    app.app
      .get(DiscoveryService)
      .getControllers()
      .map((wrapper) => wrapper.metatype?.name)
      .filter((name): name is string => name !== undefined),
  );

  const missing = declared.filter((controller) => !mounted.has(controller.name));

  expect(
    missing.map((controller) => `${controller.file} → ${controller.name}`),
    'these controllers exist in src/ but AppModule does not serve them; every one of their routes is a 404',
  ).toStrictEqual([]);
});
