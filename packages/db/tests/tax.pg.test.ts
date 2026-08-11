import { expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { Database } from '../src/client.js';
import { PG, connect, connectPool, describeDb, errorCode } from './support/db.js';

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
      // rate_bp: 0, not 600 — a nonzero rate on a non-'standard' treatment now also trips
      // `tax_countries_rate_matches_treatment` (added in review of this task), and 'reduced'
      // is not 'standard' either way. Zero isolates this test to the one constraint it names.
      await expectCheckViolation(
        db.execute(sql`
          insert into tax_countries (code, name_th, rate_bp, treatment, prices_include_tax)
          values ('MY', 'มาเลเซีย', 0, 'reduced', false)
        `),
        'tax_countries_treatment_allowed',
      );
    });
  });

  /*
   * The pairing that decides what a frozen quotation prints. Spec §8.3 renders the rate as
   * `String(document.vatRateBp / 100)` with no awareness of `treatment`
   * (packages/core/src/quotation.ts:184) — safe only while a non-`standard` treatment always
   * carries `rate_bp = 0`, since `charges()` (packages/core/src/vat.ts:46) already computes
   * ฿0 for anything non-`standard` regardless of the rate stored. Added in review of this
   * task: `('SG', …, rate_bp = 900, treatment = 'zero_rated')` stored fine, computed ฿0 VAT,
   * and would have printed "VAT 9%" on a document nobody could reconcile and nobody could
   * un-freeze.
   */
  it('refuses a non-standard treatment paired with a nonzero rate', async () => {
    await withConnection(async (db) => {
      await expectCheckViolation(
        db.execute(sql`
          insert into tax_countries (code, name_th, rate_bp, treatment, prices_include_tax)
          values ('JP', 'ญี่ปุ่น', 900, 'zero_rated', true)
        `),
        'tax_countries_rate_matches_treatment',
      );
    });
  });

  /*
   * The case the constraint must NOT catch. `standard` at 0 bp still files differently from
   * `exempt` (packages/core/src/vat.ts:47) — a future tightening to `rate_bp = 0` outright
   * would silently make that distinction impossible to record, and nothing above this test
   * would notice.
   *
   * ⚠️ Run inside a transaction that is rolled back, not through `withConnection`/`db.execute`.
   * Every other test in this describe block exercises a rejection, so nothing they do commits
   * a row; this is the first one where the insert is supposed to succeed. Committing it would
   * leave a permanent 'AU' row that `seeds exactly Thailand` — which asserts the table holds
   * *exactly* one row — would then depend on running before this test, i.e. on this file's
   * declaration order rather than on anything either test actually asserts. Same idiom
   * `erasure.test.ts`'s `attemptSelfErasure` uses for the identical reason: a real INSERT, on
   * a real connection, that never becomes a fact the rest of the suite has to account for.
   */
  it('accepts standard at zero rate — the pairing the constraint must not catch', async () => {
    const pool = await connectPool();
    const client = await pool.connect();
    try {
      await client.query('begin');
      await expect(
        client.query(
          `insert into tax_countries (code, name_th, rate_bp, treatment, prices_include_tax)
           values ('AU', 'ออสเตรเลีย', 0, 'standard', true)`,
        ),
      ).resolves.toBeDefined();
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }
  });

  /*
   * The actual fraud shape `tax_country_changes` exists to catch: flip a live, nonzero-rate
   * country to `zero_rated` for one deal without changing the rate, meaning to flip it back
   * later. A CHECK enforces UPDATE exactly as it enforces INSERT — asserted rather than
   * assumed, per this task's own mutation-testing standard.
   */
  it('refuses flipping an existing standard row to zero_rated while its rate stays nonzero', async () => {
    await withConnection(async (db) => {
      await expectCheckViolation(
        db.execute(sql`update tax_countries set treatment = 'zero_rated' where code = 'TH'`),
        'tax_countries_rate_matches_treatment',
      );
    });
  });

  /* ── The exchange-rate settings (migration 0036) ──────────────────────────────────
   *
   * Two settings per destination — a percentage spread off the mid-market rate, and a manual
   * override taken from a bank — plus the currency that makes the second one mean anything.
   * `packages/core/src/fx.ts` is the arithmetic and carries the argument for each; these tests
   * are about what the table refuses to hold.
   * ──────────────────────────────────────────────────────────────────────────────── */

  it('leaves the seeded row converting nothing — the defaults are inert, so 0036 backfilled none', async () => {
    await withConnection(async (db) => {
      const rows = await db.execute(sql`
        select fx_currency, fx_spread_bp, fx_manual_rate from tax_countries where code = 'TH'
      `);
      expect(rows.rows[0]).toStrictEqual({
        fx_currency: null,
        fx_spread_bp: 0,
        fx_manual_rate: null,
      });
    });
  });

  /*
   * The quietest way this feature could overcharge: a destination set to THB with a spread
   * marks the *domestic* price up by that spread, and no figure on a Thai quotation would
   * move to show it. `resolveFxRate` refuses the same pair, so neither guard is the only one.
   */
  it('refuses THB as a destination currency — baht to baht is not a conversion', async () => {
    await withConnection(async (db) => {
      await expectCheckViolation(
        db.execute(sql`update tax_countries set fx_currency = 'THB' where code = 'TH'`),
        'tax_countries_fx_currency_not_thb',
      );
    });
  });

  it('refuses a currency outside the list core knows', async () => {
    await withConnection(async (db) => {
      await expectCheckViolation(
        db.execute(sql`update tax_countries set fx_currency = 'XBT' where code = 'TH'`),
        'tax_countries_fx_currency_known',
      );
    });
  });

  /*
   * 2 000 bp is the ceiling — five times the worst retail FX spread. `20` typed meaning twenty
   * basis points and read as twenty per cent is the mistake; core's own bound is 100%, where
   * the effective rate is zero and the division stops existing, so this is the business one.
   */
  it('refuses a spread above 20 per cent, which core would happily compute', async () => {
    await withConnection(async (db) => {
      await expectCheckViolation(
        db.execute(sql`update tax_countries set fx_spread_bp = 2001 where code = 'TH'`),
        'tax_countries_fx_spread_in_range',
      );
      await expectCheckViolation(
        db.execute(sql`update tax_countries set fx_spread_bp = -1 where code = 'TH'`),
        'tax_countries_fx_spread_in_range',
      );
    });
  });

  /*
   * ⭐ The constraint with no zod equivalent, and the reason `pg-errors.ts` grew a fourth
   * entry: `{ fxManualRate: '35.90' }` is a perfectly well-formed patch, and whether it is
   * legal depends on the `fx_currency` already sitting on the row. A rate is baht per one
   * unit of *something*.
   */
  it('refuses an override rate on a destination with no currency', async () => {
    await withConnection(async (db) => {
      await expectCheckViolation(
        db.execute(sql`update tax_countries set fx_manual_rate = 35.9 where code = 'TH'`),
        'tax_countries_fx_manual_rate_needs_currency',
      );
    });
  });

  it('refuses a zero or negative override rate', async () => {
    await withConnection(async (db) => {
      for (const rate of [0, -1]) {
        await expectCheckViolation(
          db.execute(sql`
            insert into tax_countries (code, name_th, rate_bp, treatment, prices_include_tax,
                                       fx_currency, fx_manual_rate)
            values ('JP', 'ญี่ปุ่น', 0, 'zero_rated', true, 'USD', ${rate})
          `),
          'tax_countries_fx_manual_rate_positive',
        );
      }
    });
  });

  /*
   * ⭐ The pair the constraints must NOT catch, and the one this whole feature exists to
   * store: a destination carrying both settings at once. The table holds them side by side on
   * purpose — `resolveFxRate` decides which applies (the override, exactly as typed), and the
   * spread stays on the row so that clearing the override restores it. A CHECK that refused
   * the pair would have made that impossible to express.
   *
   * ⚠️ Same rolled-back-transaction idiom as the `standard`-at-zero test above, and for the
   * same reason: this insert is meant to succeed, and a committed 'AU' row would make `seeds
   * exactly Thailand` depend on declaration order.
   */
  it('accepts a spread and an override together — which one wins is core’s decision, not a CHECK’s', async () => {
    const pool = await connectPool();
    const client = await pool.connect();
    try {
      await client.query('begin');
      await expect(
        client.query(
          `insert into tax_countries (code, name_th, rate_bp, treatment, prices_include_tax,
                                      fx_currency, fx_spread_bp, fx_manual_rate)
           values ('AU', 'ออสเตรเลีย', 0, 'zero_rated', true, 'USD', 200, 35.9)`,
        ),
      ).resolves.toBeDefined();

      const stored = await client.query<{ fx_manual_rate: string }>(
        `select fx_manual_rate from tax_countries where code = 'AU'`,
      );
      // numeric, not a float: it comes back as exact digits, padded to the column's scale.
      expect(stored.rows[0]?.fx_manual_rate).toBe('35.9000000000');
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }
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

  /*
   * ⚠️ Both the UPDATE and the DELETE below are scoped to the one row this test just
   * inserted, not to the whole table. Unscoped, they pass today only because
   * `tax_country_changes_append_only` refuses them before they touch anything — if that
   * trigger were ever dropped, an unscoped statement would wipe the shared history table for
   * every other test and every other subject `erasure.test.ts` writes there, instead of
   * failing in place on the one row this test owns. Same class of defect as the leak above:
   * a test whose safety depends on something other than what it names in its own assertion.
   */
  it('records history that cannot be edited or un-recorded', async () => {
    await withConnection(async (db) => {
      const inserted = await db.execute(sql`
        insert into tax_country_changes (tax_country_code, after)
        values ('TH', '{"rateBp":700}'::jsonb)
        returning id
      `);
      const id = inserted.rows[0]?.['id'];

      await expectRefusal(
        db.execute(sql`update tax_country_changes set after = '{"rateBp":0}'::jsonb where id = ${id}`),
        'append-only',
      );
      await expectRefusal(
        db.execute(sql`delete from tax_country_changes where id = ${id}`),
        'append-only',
      );
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
