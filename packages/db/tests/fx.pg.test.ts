import { expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { Database } from '../src/client.js';
import { PG, connect, describeDb, errorCode } from './support/db.js';

/*
 * There is no `withDb` in this repo — the helper is `connect()` (support/db.ts:47). Copied
 * from `tax.pg.test.ts` for the same reason that file gives: one local wrapper keeps each
 * `it` a single statement without inventing a shared API that does not exist.
 */
const withConnection = async (body: (db: Database) => Promise<void>): Promise<void> => {
  const db = await connect();
  await body(db);
};

/*
 * `DrizzleQueryError#message` never includes the driver's message — it is hardcoded to the
 * query text and params, and the real reason sits one level down on `.cause`. `errorCode`
 * and `messagesOf` below are `tax.pg.test.ts`'s fix for that, copied rather than imported
 * because that file does not export them (see its own header comment for the full story of
 * why a bare `rejects.toThrow(/constraint_name/)` does not work here).
 */
function messagesOf(error: unknown): string[] {
  const found: string[] = [];
  let current: unknown = error;

  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth += 1) {
    if ('message' in current) {
      const { message } = current as { message: unknown };
      if (typeof message === 'string') found.push(message);
    }
    current = 'cause' in current ? (current as { cause: unknown }).cause : undefined;
  }

  return found;
}

/** A CHECK violation, identified by the constraint Postgres names in its own message. */
const expectCheckViolation = async (operation: Promise<unknown>, constraintName: string): Promise<void> => {
  const caught = await operation.then(
    () => undefined,
    (error: unknown) => error,
  );

  expect(errorCode(caught), `expected SQLSTATE ${PG.checkViolation}, got: ${String(caught)}`).toBe(
    PG.checkViolation,
  );
  expect(messagesOf(caught).join(' | '), `expected a message naming "${constraintName}"`).toContain(
    constraintName,
  );
};

/** A trigger's RAISE EXCEPTION ... USING ERRCODE = 'restrict_violation', by its sentence. */
const expectRefusal = async (operation: Promise<unknown>, fragment: string): Promise<void> => {
  const caught = await operation.then(
    () => undefined,
    (error: unknown) => error,
  );

  expect(errorCode(caught), `expected SQLSTATE ${PG.restrictViolation}, got: ${String(caught)}`).toBe(
    PG.restrictViolation,
  );
  expect(messagesOf(caught).join(' | '), `expected a refusal mentioning "${fragment}"`).toContain(fragment);
};

/**
 * `fx_rates` — ingestion only. What fills this table lives in `apps/api/src/fx`; this file
 * proves the two things only the database can prove: the shape CHECK on `base`, and that a
 * fetched observation cannot be edited or un-recorded once it lands.
 *
 * ⚠️ Rows inserted here are never cleaned up — the append-only trigger this file is testing
 * refuses the DELETE that would do it. Same trade `tax.pg.test.ts` names for
 * `tax_country_changes`: the tests within this `describeDb` block depend on their own
 * declaration order (the second test needs a row from nothing it deletes afterwards), not
 * on the state of any other file — every Postgres suite here runs from a database
 * `globalSetup.ts` drops and rebuilds before the run starts.
 */
describeDb('fx_rates', () => {
  it('refuses a base that is not three upper-case letters', async () => {
    await withConnection(async (db) => {
      await expectCheckViolation(
        db.execute(sql`
          insert into fx_rates (rate_timestamp, base, rates, source)
          values (now(), 'usd', '{}'::jsonb, 'openexchangerates')
        `),
        'fx_rates_base_shape',
      );
    });
  });

  /*
   * Not a CHECK case: `char(3)` itself refuses a fourth character before the CHECK ever
   * runs (SQLSTATE 22001, string_data_right_truncation) — confirmed by running this
   * against `fx_rates_base_shape` first and getting 22001 back instead of 23514. Asserted
   * here anyway, because "the column is 3 wide" and "the 3 characters are upper-case" are
   * two different guarantees and this table's `base char(3)` only states the column type
   * in the migration; the length enforcement is worth pinning by name.
   */
  it('refuses a fourth character — the column width, not the CHECK', async () => {
    await withConnection(async (db) => {
      const caught = await db
        .execute(sql`
          insert into fx_rates (rate_timestamp, base, rates, source)
          values (now(), 'USDT', '{}'::jsonb, 'openexchangerates')
        `)
        .then(
          () => undefined,
          (error: unknown) => error,
        );

      expect(errorCode(caught)).toBe('22001');
    });
  });

  it('records an observation that cannot be edited or un-recorded', async () => {
    await withConnection(async (db) => {
      const inserted = await db.execute<{ id: string }>(sql`
        insert into fx_rates (rate_timestamp, base, rates, source)
        values (now(), 'USD', '{"THB":36.5,"SGD":1.34}'::jsonb, 'openexchangerates')
        returning id
      `);
      const id = inserted.rows[0]?.id;

      await expectRefusal(
        db.execute(sql`update fx_rates set base = 'EUR' where id = ${id}`),
        'append-only',
      );
      await expectRefusal(
        db.execute(sql`delete from fx_rates where id = ${id}`),
        'append-only',
      );
    });
  });
});
