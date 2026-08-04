import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PermissionSyncService } from '../../src/rbac/permission-sync.service';
import { PERMISSION_CODES } from '../../src/rbac/permissions';
import { bootRbacApp, type BootedRbacApp } from './support/boot';
import { GuardedModule } from './fixtures/guarded.module';

/**
 * The boot sync when there is no database to sync with.
 *
 * DatabaseService already sets the posture: missing *configuration* stops the process,
 * because that is a deploy mistake; an unreachable *database* does not, because that is
 * usually a database still starting and a service that exits on it turns a ten-second
 * outage into a crash loop. The permission sync has to hold the same line — and it is
 * easy to get wrong, because "the permissions I need are not there" feels like a reason
 * to refuse.
 *
 * That every other suite in this directory boots at all is the same proof: they all run
 * against a Drizzle handle that throws on contact.
 */
describe('permission sync with no database', () => {
  let booted: BootedRbacApp;

  beforeAll(async () => {
    booted = await bootRbacApp({ modules: [GuardedModule] });
  });

  afterAll(async () => {
    await booted.close();
  });

  it('boots', () => {
    expect(booted.baseUrl).toContain('http://127.0.0.1:');
  });

  it('reports the failure instead of throwing it', async () => {
    const report = await booted.app.get(PermissionSyncService).sync();

    expect(report.ok).toBe(false);
    expect(report.error).toBeTruthy();
    expect(report.declared).toBe(PERMISSION_CODES.length);
  });

  it('leaves the anonymous funnel serving, because it needs no permission row', async () => {
    const response = await fetch(`${booted.baseUrl}/fixture/anonymous`);
    expect(response.status).toBe(200);
  });
});
