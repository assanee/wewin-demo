import { Inject, Injectable, Logger, type BeforeApplicationShutdown } from '@nestjs/common';

import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { DatabaseService } from '../database/database.service';
import type { CheckResult, HealthReport, HealthStatus, LivenessReport } from './health.types';

const SERVICE_NAME = 'wewin-api';

@Injectable()
export class HealthService implements BeforeApplicationShutdown {
  private readonly logger = new Logger(HealthService.name);
  private readonly startedAt = performance.now();
  private draining = false;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly database: DatabaseService,
  ) {}

  liveness(): LivenessReport {
    // Deliberately touches nothing external: a liveness probe that fails when the database
    // does gets the process killed for someone else's outage.
    return { status: 'ok', uptimeMs: this.uptimeMs() };
  }

  async report(): Promise<HealthReport> {
    const probe = await this.database.probe();
    const database: CheckResult = probe.ok
      ? { status: 'up', latencyMs: probe.latencyMs }
      : // `||` and not `??`: the shape that got through here was `''`, which is not nullish.
        // `DatabaseService.probe` no longer produces one, and this is the belt to that brace.
        { status: 'down', latencyMs: probe.latencyMs, error: probe.error || 'unknown error' };

    return {
      status: this.statusFrom(database),
      service: SERVICE_NAME,
      version: this.env.SERVICE_VERSION,
      uptimeMs: this.uptimeMs(),
      checks: { database },
    };
  }

  /** Readiness is the only place `draining` outranks a passing check. */
  isReady(report: HealthReport): boolean {
    return report.status === 'ok';
  }

  /*
   * `beforeApplicationShutdown` runs while the HTTP server is still accepting connections,
   * which is the whole point: readiness starts failing first, the load balancer stops
   * sending work, and only then does Nest close the socket. Without the pause the first
   * failing probe and the closed socket arrive together and in-flight requests are lost.
   */
  async beforeApplicationShutdown(signal?: string): Promise<void> {
    this.draining = true;
    const grace = this.env.SHUTDOWN_GRACE_MS;
    this.logger.log(`Draining after ${signal ?? 'shutdown'}${grace > 0 ? `, waiting ${grace}ms` : ''}`);
    if (grace > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, grace).unref();
      });
    }
  }

  private statusFrom(database: CheckResult): HealthStatus {
    if (this.draining) {
      return 'draining';
    }
    return database.status === 'up' ? 'ok' : 'degraded';
  }

  private uptimeMs(): number {
    return Math.round(performance.now() - this.startedAt);
  }
}
