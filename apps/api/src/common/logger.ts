import { ConsoleLogger, type LogLevel } from '@nestjs/common';

import type { Env, LogLevelName } from '../config/env';

/*
 * Nest's levels are not ordered by the type system, so the order lives here once. Setting
 * LOG_LEVEL enables that level and everything more severe.
 */
const SEVERITY_ASCENDING: readonly LogLevel[] = ['verbose', 'debug', 'log', 'warn', 'error', 'fatal'];

export function levelsAtLeast(level: LogLevelName): LogLevel[] {
  const from = SEVERITY_ASCENDING.indexOf(level);
  return [...SEVERITY_ASCENDING.slice(from === -1 ? 0 : from)];
}

export function createLogger(env: Env): ConsoleLogger {
  const json = env.LOG_FORMAT === 'json';
  return new ConsoleLogger({
    json,
    // Colour codes inside a JSON string field defeat the point of JSON logs.
    colors: !json,
    logLevels: levelsAtLeast(env.LOG_LEVEL),
  });
}
