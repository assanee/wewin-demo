export type CheckStatus = 'up' | 'down';

/** 'draining' is reported only between the shutdown signal and the socket closing. */
export type HealthStatus = 'ok' | 'degraded' | 'draining';

export interface CheckResult {
  readonly status: CheckStatus;
  readonly latencyMs: number;
  readonly error?: string;
}

export interface HealthReport {
  readonly status: HealthStatus;
  readonly service: string;
  readonly version: string;
  readonly uptimeMs: number;
  readonly checks: {
    readonly database: CheckResult;
  };
}

export interface LivenessReport {
  readonly status: 'ok';
  readonly uptimeMs: number;
}
