import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { createPool } from '../src/database/database.module';
import { bootApp, testEnv, type BootedApp } from './support/app';
import { parseEnv } from '../src/config/env';

/*
 * Needs the real thing: `pnpm db:up`, then `pnpm test`. Skipped rather than failed when no
 * database is configured, because a laptop without Docker should still be able to run the
 * other tests — but nothing here can be faked, which is the point.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

describeWithPg('Postgres integration', () => {
  const env = parseEnv({ NODE_ENV: 'test', DATABASE_URL: url ?? 'postgres://unused/unused' });
  const pool = createPool(env);
  const pools: pg.Pool[] = [pool];
  const apps: BootedApp[] = [];

  afterAll(async () => {
    await Promise.all(apps.map((booted) => booted.close()));
    await Promise.all(pools.map((each) => each.end()));
  });

  it('hands back bigint for int8, exactly, past 2^53', async () => {
    const result = await pool.query<{ big: bigint; small: bigint }>(
      'select 9223372036854775807::bigint as big, 1::bigint as small',
    );
    const row = result.rows[0];

    expect(typeof row?.big).toBe('bigint');
    expect(row?.big).toBe(9223372036854775807n);
    expect(row?.small).toBe(1n);

    // Why it has to be bigint: the same integer cannot survive a round trip through
    // `number`. (Nor can it be written as a numeric literal in this file — 9223372036854775807
    // parses to ...808 — which is the whole problem in one line.)
    expect(BigInt(Number(row?.big ?? 0n))).not.toBe(row?.big);
    expect(String(row?.big)).toBe('9223372036854775807');
  });

  it('would have been a string without the parser this pool installs', async () => {
    const plain = new pg.Pool({ connectionString: env.DATABASE_URL });
    pools.push(plain);

    const result = await plain.query<{ big: unknown }>('select 9223372036854775807::bigint as big');
    // node-postgres' default. Left here so that a future "simplification" that drops
    // bigintAwareTypes fails a test instead of quietly turning money into strings.
    expect(typeof result.rows[0]?.big).toBe('string');
  });

  it('round-trips satang and micrometres through bigint columns without loss', async () => {
    const client = await pool.connect();
    try {
      await client.query('create temporary table money_probe (amount_minor bigint, length_um bigint)');
      // ฿92,233,720,368,547.75 in satang, and 2.4km in micrometres.
      await client.query('insert into money_probe values ($1, $2)', [9223372036854775n, 2_400_000_000n]);

      const read = await client.query<{ amount_minor: bigint; length_um: bigint }>(
        'select amount_minor, length_um from money_probe',
      );
      expect(read.rows[0]?.amount_minor).toBe(9223372036854775n);
      expect(read.rows[0]?.length_um).toBe(2_400_000_000n);
    } finally {
      client.release();
    }
  });

  it('counts as bigint too, which is the accepted cost of the parser', async () => {
    const result = await pool.query<{ n: bigint }>('select count(*) as n from (values (1), (2)) as t(x)');
    expect(result.rows[0]?.n).toBe(2n);
  });

  it('leaves numeric alone — money must never be stored in it, and this proves the parser is narrow', async () => {
    const result = await pool.query<{ n: unknown }>("select '1.05'::numeric as n");
    expect(typeof result.rows[0]?.n).toBe('string');
  });

  it('reports the database up through /health/ready', async () => {
    const booted = await bootApp(testEnv({ DATABASE_URL: env.DATABASE_URL }));
    apps.push(booted);

    const response = await fetch(`${booted.baseUrl}/health/ready`);
    expect(response.status).toBe(200);

    const body = (await response.json()) as { status: string; checks: { database: { status: string } } };
    expect(body.status).toBe('ok');
    expect(body.checks.database.status).toBe('up');
  });
});
