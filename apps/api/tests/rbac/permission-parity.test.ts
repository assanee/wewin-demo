import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { PERMISSION_CODES } from '../../src/rbac/permissions';

/**
 * ⭐ The dashboard keeps its own copy of the permission list, and nothing checked it.
 *
 * `apps/dashboard/src/lib/auth/permissions.ts` exists because the dashboard decides which
 * menu entries to render before it has spoken to the API. Its header argues that every
 * direction of drift fails towards *less* menu, which is true and is also why the drift is
 * invisible: a screen that never appears looks like a screen nobody built.
 *
 * A source scan rather than an import, because the two packages do not depend on each other
 * and `boundaries` is what keeps it that way. This is the same shape `phone-authority.test.ts`
 * and `apps/web/tests/print.test.ts` use for a cross-package invariant a type cannot express.
 *
 * `__dirname`, not `import.meta.url`: this package compiles to CommonJS output (see
 * tsconfig.build.json), and `tsc` rejects `import.meta` there with TS1470 even though
 * Vitest itself would run it fine. `phone-authority.test.ts` in this same directory
 * already uses `__dirname` for exactly this reason.
 */
const dashboardSource = readFileSync(
  join(__dirname, '..', '..', '..', 'dashboard', 'src', 'lib', 'auth', 'permissions.ts'),
  'utf8',
);

const withoutComments = (text: string): string => text.replaceAll(/\/\*[\s\S]*?\*\//g, '');

describe('the dashboard copy of the permission list', () => {
  it('was found, and is not empty', () => {
    // The empty-scan failure this repo has met before: a scan over nothing passes.
    expect(dashboardSource.length).toBeGreaterThan(200);
  });

  it('names exactly the codes the API declares', () => {
    const quoted = [...withoutComments(dashboardSource).matchAll(/'([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)'/gu)];
    const inDashboard = [...new Set(quoted.map((match) => match[1] ?? ''))].sort();

    expect(inDashboard).toStrictEqual([...PERMISSION_CODES].sort());
  });
});
