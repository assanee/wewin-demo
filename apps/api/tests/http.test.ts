import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { REQUEST_ID_HEADER } from '../src/common/request-id';
import { bootApp, testEnv, type BootedApp } from './support/app';

describe('HTTP surface (database unreachable)', () => {
  let booted: BootedApp;

  beforeAll(async () => {
    booted = await bootApp();
  });

  afterAll(async () => {
    await booted.close();
  });

  it('stays alive when the database is not', async () => {
    const response = await fetch(`${booted.baseUrl}/health/live`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok' });
  });

  it('refuses readiness, and says which check failed', async () => {
    const response = await fetch(`${booted.baseUrl}/health/ready`);
    expect(response.status).toBe(503);

    const body = (await response.json()) as {
      status: string;
      checks: { database: { status: string; error?: string; latencyMs: number } };
    };
    expect(body.status).toBe('degraded');
    expect(body.checks.database.status).toBe('down');
    // The point of the whole exercise: this is a real round trip, not a flag someone set.
    expect(body.checks.database.error).toBeTruthy();
    expect(body.checks.database.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('answers /meta with null counts rather than numbers it cannot stand behind', async () => {
    const response = await fetch(`${booted.baseUrl}/meta`);
    // 200, not 503: the version and the wire conventions are true of this process whether
    // or not Postgres is answering, and they are what somebody reads /meta to find out.
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      service: string;
      catalog: { source: string; counts: unknown; currencies: string[] };
    };
    expect(body.service).toBe('wewin-api');
    expect(body.catalog.source).toBe('database');
    /*
     * The regression this pins. /meta used to count `@wewin/core/fixtures` and report 81
     * products from the TS table — with the database unreachable, as it is here. Anything
     * other than null is that bug coming back; `0` in particular would read as an empty
     * catalogue rather than as an outage.
     */
    expect(body.catalog.counts).toBeNull();
    expect(body.catalog.currencies).toContain('THB');
  });

  it('answers an unknown route with the error envelope, not the framework default body', async () => {
    const response = await fetch(`${booted.baseUrl}/does-not-exist`);
    expect(response.status).toBe(404);

    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error).toMatchObject({ code: 'NOT_FOUND', path: '/does-not-exist' });
    expect(typeof body.error['message']).toBe('string');
    expect(typeof body.error['timestamp']).toBe('string');
    expect(body.error['requestId']).toBe(response.headers.get(REQUEST_ID_HEADER));
  });

  it('echoes a caller-supplied request id and invents one otherwise', async () => {
    const supplied = await fetch(`${booted.baseUrl}/health/live`, {
      headers: { [REQUEST_ID_HEADER]: 'trace-abc.123' },
    });
    expect(supplied.headers.get(REQUEST_ID_HEADER)).toBe('trace-abc.123');

    // A header is attacker-controlled and ends up in logs; anything unsafe is replaced.
    const hostile = await fetch(`${booted.baseUrl}/health/live`, {
      headers: { [REQUEST_ID_HEADER]: 'evil\tvalue with spaces' },
    });
    const generated = hostile.headers.get(REQUEST_ID_HEADER);
    expect(generated).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('graceful shutdown', () => {
  it('reports draining while the socket is still open', async () => {
    const booted = await bootApp(testEnv({ SHUTDOWN_GRACE_MS: '1500' }));

    const closing = booted.close();
    // Long enough for beforeApplicationShutdown to have flipped the flag, well short of
    // the grace window, so the server must still be accepting connections.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const response = await fetch(`${booted.baseUrl}/health/ready`);
    expect(response.status).toBe(503);
    expect(((await response.json()) as { status: string }).status).toBe('draining');

    await closing;

    // And once close() resolves, nothing is listening.
    await expect(fetch(`${booted.baseUrl}/health/live`)).rejects.toThrow();
  });
});
