import { Inject, Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import type { Pool } from 'pg';

import { PG_POOL } from './database.tokens';

export interface DatabaseProbe {
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly error?: string;
}

@Injectable()
export class DatabaseService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(DatabaseService.name);

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * Boot probes but does not refuse to boot.
   *
   * Missing configuration is a deploy mistake and stops the process (see config/env.ts);
   * an unreachable database is usually a database that is still starting, and a service
   * that exits on it turns a ten-second outage into a crash loop. Readiness reports the
   * truth in the meantime, so nothing routes traffic here until the probe passes.
   */
  async onModuleInit(): Promise<void> {
    const probe = await this.probe();
    if (probe.ok) {
      this.logger.log(`Database reachable in ${probe.latencyMs}ms`);
    } else {
      this.logger.error(`Database unreachable at boot: ${probe.error ?? 'unknown error'}`);
    }
  }

  /** Round-trips a real statement — a pool that has never connected reports healthy otherwise. */
  async probe(): Promise<DatabaseProbe> {
    const startedAt = performance.now();
    try {
      await this.pool.query('select 1');
      return { ok: true, latencyMs: elapsed(startedAt) };
    } catch (error) {
      return { ok: false, latencyMs: elapsed(startedAt), error: describe(error) };
    }
  }

  async onApplicationShutdown(): Promise<void> {
    // Last hook Nest runs, so the HTTP server has already stopped and no in-flight request
    // is still holding a client.
    await this.pool.end();
    this.logger.log('Database pool closed');
  }
}

function elapsed(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

/**
 * Something a human can act on, for every shape of failure — including the empty one.
 *
 * `error.message` alone was not enough, and it took stopping Postgres under a live
 * process to find out: when the server goes away mid-statement, `pg` rejects with an
 * Error whose `message` is the empty string, so /health answered
 * `{"status":"down","error":""}` — a check that reports a failure and then declines to
 * say anything about it, which is exactly the outage where somebody is reading it. The
 * `?? 'unknown error'` at the call site did not catch it either: `''` is not nullish.
 *
 * `code` is where node-postgres puts the useful part in that case (ECONNRESET, 57P01 on
 * an admin shutdown), so it is preferred over a message that may be blank and appended to
 * one that is not.
 */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error) || 'unknown error';

  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  const message = error.message.trim();

  if (message && code) return `${code}: ${message}`;
  return message || code || error.name || 'unknown error';
}
