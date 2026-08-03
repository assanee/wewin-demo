import { describe, expect, it } from 'vitest';

import { EnvValidationError, parseEnv } from '../src/config/env';

const MINIMAL = { DATABASE_URL: 'postgres://wewin:wewin@127.0.0.1:5432/wewin' } as const;

describe('parseEnv', () => {
  it('names the missing variable instead of describing a type mismatch', () => {
    let caught: unknown;
    try {
      parseEnv({});
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(EnvValidationError);
    const problems = (caught as EnvValidationError).problems;
    expect(problems).toEqual(['DATABASE_URL is required but not set']);
    expect((caught as EnvValidationError).message).toContain('DATABASE_URL is required but not set');
  });

  it('rejects a connection string that is not Postgres', () => {
    expect(() => parseEnv({ DATABASE_URL: 'mysql://wewin@127.0.0.1:3306/wewin' })).toThrow(
      /postgres:\/\/ or postgresql:\/\//,
    );
    expect(() => parseEnv({ DATABASE_URL: 'not a url' })).toThrow(EnvValidationError);
    expect(() => parseEnv({ ...MINIMAL, DATABASE_URL: 'postgresql://host/db' })).not.toThrow();
  });

  it('applies defaults so that only DATABASE_URL is mandatory', () => {
    const env = parseEnv({ ...MINIMAL });

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
    expect(env.HOST).toBe('0.0.0.0');
    expect(env.SERVICE_VERSION).toBe('dev');
    expect(env.DATABASE_POOL_MAX).toBe(10);
    expect(env.DATABASE_STATEMENT_TIMEOUT_MS).toBe(15_000);
    expect(env.SHUTDOWN_GRACE_MS).toBe(0);
    expect(env.CORS_ORIGINS).toEqual([]);
  });

  it('parses numbers as numbers, and refuses the shapes Number() would accept', () => {
    expect(parseEnv({ ...MINIMAL, PORT: '8080' }).PORT).toBe(8080);

    // Number('') is 0 and Number(' 12 ') is 12; neither is a port anyone typed on purpose.
    for (const port of ['', ' ', '12.5', '0', '70000', '3000abc']) {
      expect(() => parseEnv({ ...MINIMAL, PORT: port })).toThrow(EnvValidationError);
    }
  });

  it('splits CORS_ORIGINS and drops the empty entries a trailing comma leaves', () => {
    const env = parseEnv({ ...MINIMAL, CORS_ORIGINS: 'http://localhost:5173, https://wewin.example ,' });
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:5173', 'https://wewin.example']);
  });

  it('reports every problem at once rather than one per restart', () => {
    let caught: EnvValidationError | undefined;
    try {
      parseEnv({ PORT: 'nope', LOG_LEVEL: 'chatty' });
    } catch (error) {
      caught = error as EnvValidationError;
    }

    expect(caught?.problems).toHaveLength(3);
    expect(caught?.problems.join('\n')).toMatch(/DATABASE_URL/);
    expect(caught?.problems.join('\n')).toMatch(/PORT/);
    expect(caught?.problems.join('\n')).toMatch(/LOG_LEVEL/);
  });

  it('freezes the result — configuration is read, never patched at runtime', () => {
    const env = parseEnv({ ...MINIMAL });
    expect(Object.isFrozen(env)).toBe(true);
  });
});
