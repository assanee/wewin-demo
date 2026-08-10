import { expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { Database } from '../src/client.js';
import { PG, connect, describeDb, errorCode } from './support/db.js';

/*
 * There is no `withDb` in this repo — the helper is `connect()` (support/db.ts:47). One local
 * wrapper keeps each `it` a single statement without inventing a shared API that does not exist.
 */
const withConnection = async (body: (db: Database) => Promise<void>): Promise<void> => {
  const db = await connect();
  await body(db);
};

/*
 * ⚠️ The brief this file was written from used a bare `rejects.toThrow(/constraint_name/)`
 * against `db.execute(sql\`...\`)`. That does not work, and cannot be made to work by fixing
 * the migration: `DrizzleQueryError#message` (drizzle-orm/errors.js) is hardcoded to
 * `Failed query: ${query}\nparams: ${params}` — it NEVER includes the driver's message, which
 * sits one level down on `.cause`. Confirmed by running the two non-violation tests in this
 * file green (the migration is correct) while every `rejects.toThrow(regex)` failed identically
 * with the query text, not the constraint name, as the "received" string.
 *
 * `errorCode` and `messagesOf` are the fix erasure.test.ts already uses for the same reason
 * (`support/db.ts:101`'s own doc comment: "pg's `code` is on no type the driver exports, so it
 * is read defensively rather than cast"). `messagesOf` is copied rather than imported because
 * erasure.test.ts does not export it.
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

describeDb('tax_countries', () => {
  it('seeds exactly Thailand, at the defaults defaults.ts stands in for', async () => {
    await withConnection(async (db) => {
      const rows = await db.execute(sql`
        select code, rate_bp, treatment, prices_include_tax, is_active
        from tax_countries order by code
      `);
      expect(rows.rows).toStrictEqual([
        { code: 'TH', rate_bp: 700, treatment: 'standard', prices_include_tax: false, is_active: true },
      ]);
    });
  });

  it('refuses a rate above 100 per cent, which core would happily compute', async () => {
    await withConnection(async (db) => {
      await expectCheckViolation(
        db.execute(sql`
          insert into tax_countries (code, name_th, rate_bp, treatment, prices_include_tax)
          values ('SG', 'สิงคโปร์', 15000, 'standard', true)
        `),
        'tax_countries_rate_in_range',
      );
    });
  });

  it('refuses a treatment outside the four', async () => {
    await withConnection(async (db) => {
      await expectCheckViolation(
        db.execute(sql`
          insert into tax_countries (code, name_th, rate_bp, treatment, prices_include_tax)
          values ('MY', 'มาเลเซีย', 600, 'reduced', false)
        `),
        'tax_countries_treatment_allowed',
      );
    });
  });

  it('refuses a lower-case or three-letter code', async () => {
    await withConnection(async (db) => {
      await expectCheckViolation(
        db.execute(sql`
          insert into tax_countries (code, name_th, rate_bp, treatment, prices_include_tax)
          values ('sg', 'สิงคโปร์', 900, 'standard', true)
        `),
        'tax_countries_code_shape',
      );
    });
  });

  it('cannot be deleted — withdrawal is is_active, per the standing project rule', async () => {
    await withConnection(async (db) => {
      await expectRefusal(
        db.execute(sql`delete from tax_countries where code = 'TH'`),
        'deactivate it instead of deleting it',
      );
    });
  });

  it('records history that cannot be edited or un-recorded', async () => {
    await withConnection(async (db) => {
      await db.execute(sql`
        insert into tax_country_changes (tax_country_code, after)
        values ('TH', '{"rateBp":700}'::jsonb)
      `);
      await expectRefusal(
        db.execute(sql`update tax_country_changes set after = '{"rateBp":0}'::jsonb`),
        'append-only',
      );
      await expectRefusal(db.execute(sql`delete from tax_country_changes`), 'append-only');
    });
  });
});

describeDb('organisation_profile.deposit_bp', () => {
  it('starts at payment in full, and the column carries no DEFAULT', async () => {
    await withConnection(async (db) => {
      const value = await db.execute(sql`select deposit_bp from organisation_profile where id = 1`);
      expect(value.rows[0]).toStrictEqual({ deposit_bp: 10000 });

      const column = await db.execute(sql`
        select column_default, is_nullable from information_schema.columns
        where table_name = 'organisation_profile' and column_name = 'deposit_bp'
      `);
      expect(column.rows[0]).toStrictEqual({ column_default: null, is_nullable: 'NO' });
    });
  });

  it('refuses zero, because depositPercentTerms refuses zero', async () => {
    await withConnection(async (db) => {
      await expectCheckViolation(
        db.execute(sql`update organisation_profile set deposit_bp = 0 where id = 1`),
        'organisation_profile_deposit_in_range',
      );
    });
  });
});
