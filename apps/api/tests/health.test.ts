import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { DatabaseService } from '../src/database/database.service';

/**
 * A failed check has to say what failed.
 *
 * This exists because of something only a live outage produced: with the API running and
 * `docker compose stop postgres`, the in-flight statement rejected with an Error whose
 * `message` was the empty string, and /health answered
 * `{"status":"down","latencyMs":2,"error":""}`. Every automated test passed — the one in
 * http.test.ts points at an unroutable port, where the message is a perfectly good
 * "ECONNREFUSED" — so nothing was watching the case that actually happens in production,
 * which is a server that was there a moment ago and now is not.
 *
 * The pool is a stub rather than a real one on purpose: reproducing a mid-statement
 * disconnect from a test is flaky, and the behaviour under test is the reporting, not the
 * disconnect. What the stub cannot do is invent the empty message — that came from
 * watching it happen, and is written down in DatabaseService.
 */
type StubPool = Pick<Pool, 'query'>;

const serviceRejectingWith = (error: unknown): DatabaseService => {
  const pool: StubPool = {
    query: () => Promise.reject(error),
  } as StubPool;
  // The service touches `query` and, at shutdown, `end`; neither the container nor a
  // second implementation is needed to ask it what it reports.
  return new DatabaseService(pool as Pool);
};

describe('DatabaseService.probe describes the failure', () => {
  it('never reports a failure with an empty explanation', async () => {
    // Exactly the shape observed when Postgres went away mid-statement.
    const blank = new Error('');
    const probe = await serviceRejectingWith(blank).probe();

    expect(probe.ok).toBe(false);
    expect(probe.error).toBeTruthy();
    expect(probe.error).not.toBe('');
  });

  it('prefers the pg error code, which is the part that names the cause', async () => {
    const reset = Object.assign(new Error(''), { code: 'ECONNRESET' });
    expect((await serviceRejectingWith(reset).probe()).error).toBe('ECONNRESET');

    // 57P01 is what an `ALTER SYSTEM`-style admin shutdown sends; message and code
    // together read better than either alone.
    const shutdown = Object.assign(new Error('terminating connection due to administrator command'), {
      code: '57P01',
    });
    expect((await serviceRejectingWith(shutdown).probe()).error).toBe(
      '57P01: terminating connection due to administrator command',
    );
  });

  it('survives a rejection that is not an Error at all', async () => {
    expect((await serviceRejectingWith('boom').probe()).error).toBe('boom');
    expect((await serviceRejectingWith(undefined).probe()).error).toBe('undefined');
  });
});
