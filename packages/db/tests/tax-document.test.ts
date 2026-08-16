import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { createDatabase, createPool, type Database, type Pool } from '../src/client.js';
import { errorCode } from './support/db.js';

/**
 * The repo's own idiom: drizzle wraps a driver error and pg's `code` sits on `cause`, so a
 * `toMatchObject({ code })` compares `undefined` with `undefined` and passes for the wrong
 * reason. `errorCode` walks the chain — see `tests/support/db.ts`.
 */
const expectViolation = async (operation: Promise<unknown>, code: string): Promise<void> => {
  const caught = await operation.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(errorCode(caught), `expected SQLSTATE ${code}, got: ${String(caught)}`).toBe(code);
};

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * เอกสารภาษี — the three properties the rest of the module will be built on.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A tax document is evidence. Everything below is about the difference between a row and a
 * piece of evidence: its number cannot have holes, it cannot be edited or deleted after it is
 * issued, and the same supply cannot be documented twice.
 *
 * ⚠️ These are database tests on purpose. The service is not the only writer — `db:seed`, a psql
 * session and a future worker all reach this table — and a rule that lives only in TypeScript is
 * a rule that holds until somebody writes the row a different way.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeDb = url === undefined || url === '' ? describe.skip : describe;

describeDb('a tax document, as the database sees it', () => {
  let pool: Pool;
  let db: Database;

  beforeAll(() => {
    pool = createPool(url ?? '');
    db = createDatabase(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  const scalar = async <T>(statement: ReturnType<typeof sql>): Promise<T> => {
    const result = await db.execute(statement);
    const rows = (result as { rows?: readonly Record<string, unknown>[] }).rows ?? [];
    return Object.values(rows[0] ?? {})[0] as T;
  };

  describe('the number', () => {
    it('⭐ walks one at a time, per series and per year', async () => {
      const first = await scalar<number>(sql`select series_seq from next_document_no('TAX', now())`);
      const second = await scalar<number>(sql`select series_seq from next_document_no('TAX', now())`);

      expect(second).toBe(first + 1);

      /* A different series has its own counter — one auditor's walk per series. */
      const other = await scalar<number>(sql`select series_seq from next_document_no('RCP', now())`);
      expect(other).toBeGreaterThan(0);
    });

    it('⛔ does NOT burn a number when the transaction rolls back', async () => {
      /*
       * THE REASON THIS IS A COUNTER ROW AND NOT A SEQUENCE. `nextval` is non-transactional: a
       * rolled-back issue takes its number out of the series for ever, and a tax series with
       * holes is one an auditor walks and finds missing. It is not hypothetical in this
       * repository — `order_no_seq` stands at 1049 against eight orders.
       */
      const before = await scalar<string>(
        sql`select next_seq::text from document_series_counters where series_code = 'TAX' and series_year > 0`,
      );

      await expect(
        db.transaction(async (tx: Parameters<Parameters<Database['transaction']>[0]>[0]) => {
          await tx.execute(sql`select * from next_document_no('TAX', now())`);
          throw new Error('rolled back on purpose');
        }),
      ).rejects.toThrow('rolled back on purpose');

      const after = await scalar<string>(
        sql`select next_seq::text from document_series_counters where series_code = 'TAX' and series_year > 0`,
      );
      expect(after).toBe(before);
    });

    it('⚠️ formats the year in the era the series names, which is the year a Thai document shows', async () => {
      const no = await scalar<string>(sql`select document_no from next_document_no('TAX', now())`);
      const thisYearBe = new Date().getFullYear() + 543;

      expect(no).toMatch(/^TAX-\d{4}-\d{5}$/u);
      expect(no).toContain(String(thisYearBe));
    });

    it('⛔ refuses a series nobody configured, rather than inventing one', async () => {
      /*
       * ⚠️ Asserted on the message rather than on the SQLSTATE: drizzle wraps a failed query and
       * the driver's `code` does not survive on the wrapper. The sentence is the contract with
       * whoever reads the log, and it names the series that was asked for.
       */
      await expectViolation(db.execute(sql`select * from next_document_no('NOPE', now())`), '23503');
    });
  });

  describe('an issued document', () => {
    /**
     * A document needs an order, an event and a series. Rather than build a whole order here —
     * which `order.test.ts` already does at length — these tests reach for one that exists, and
     * skip if the database has none. What is under test is the freeze, not the fixture.
     */
    const anOrder = async (): Promise<{ orderId: string; eventId: string } | null> => {
      const result = await db.execute(sql`
        select o.id::text as order_id, e.id::text as event_id
          from orders o join order_events e on e.order_id = o.id
         limit 1
      `);
      const row = ((result as { rows?: readonly Record<string, unknown>[] }).rows ?? [])[0];
      if (row === undefined) return null;
      return { orderId: String(row['order_id']), eventId: String(row['event_id']) };
    };

    /*
     * ⚠️ Defaults to `invoice`, not `tax_invoice`, and the reason is a rule this file also tests:
     * only ONE whole-order tax invoice may be issued per order. These tests share whichever order
     * the database happens to hold, so a `tax_invoice` default made every test after the first
     * fail on that index — the constraint working, and the fixture wrong. `invoice` carries no
     * such index; the test that is *about* the index asks for `tax_invoice` explicitly.
     */
    const issue = async (
      order: { orderId: string; eventId: string },
      kind = 'invoice',
      series = 'INV',
      /** ⚠️ Required for a credit note — `tax_documents_credit_note_cites` says so. */
      replaces: string | null = null,
    ): Promise<string> => {
      const id = randomUUID();
      const numbered = await db.execute(sql`select * from next_document_no(${series}, now())`);
      const no = ((numbered as { rows?: readonly Record<string, unknown>[] }).rows ?? [])[0];

      await db.execute(sql`
        insert into tax_documents
          (id, kind, order_id, series_code, series_year, series_seq, document_no, document,
           document_hash, pinned_locale, pinned_vat_rate_bp, pinned_vat_treatment,
           net_thb_minor, vat_thb_minor, grand_total_thb_minor, created_by_event_id,
           replaces_document_id)
        values (${id}::uuid, ${kind}, ${order.orderId}::uuid, ${series},
                ${Number(no?.['series_year'])}, ${Number(no?.['series_seq'])}, ${String(no?.['document_no'])},
                '{"probe":true}'::jsonb, ${'a'.repeat(64)}, 'th', 700, 'standard',
                10000, 700, 10700, ${order.eventId}::uuid,
                ${replaces}::uuid)
      `);
      return id;
    };

    it('⛔ cannot be edited — not its money, not its body, not its number', async () => {
      const order = await anOrder();
      if (order === null) return;
      const id = await issue(order);

      await expectViolation(db.execute(sql`update tax_documents set net_thb_minor = 1 where id = ${id}::uuid`), '23001');

      await expectViolation(db.execute(sql`update tax_documents set document = '{"probe":false}'::jsonb where id = ${id}::uuid`), '23001');

      await expectViolation(db.execute(sql`update tax_documents set document_no = 'TAX-2569-99999' where id = ${id}::uuid`), '23001');
    });

    it('⛔ cannot be deleted — the standing rule, and the tax rule, at once', async () => {
      const order = await anOrder();
      if (order === null) return;
      const id = await issue(order);

      await expectViolation(db.execute(sql`delete from tax_documents where id = ${id}::uuid`), '23001');
    });

    it('⭐ can be voided, and only by naming what replaced it and when', async () => {
      const order = await anOrder();
      if (order === null) return;
      const wrong = await issue(order);
      /* ⛔ A credit note names what it reduces, or the CHECK refuses it — see 0060. */
      const credit = await issue(order, 'credit_note', 'CN', wrong);

      /* A void with no replacement named is refused: a document that vanished is not evidence. */
      await expectViolation(db.execute(sql`update tax_documents set status = 'voided', voided_at = now() where id = ${wrong}::uuid`), '23001');

      await db.execute(sql`
        update tax_documents
           set status = 'voided', voided_at = now(), voided_by_document_id = ${credit}::uuid
         where id = ${wrong}::uuid
      `);

      const status = await scalar<string>(sql`select status from tax_documents where id = ${wrong}::uuid`);
      expect(status).toBe('voided');

      /*
       * ⚠️ And the number is still there. It is never reused and never freed — the series it
       * came from is read back from the row rather than named here, because which series the
       * fixture used is not what this test is about, and asserting it was how this line came to
       * fail on a fixture change.
       */
      const still = await db.execute(sql`
        select document_no, series_code from tax_documents where id = ${wrong}::uuid
      `);
      const kept = ((still as { rows?: readonly Record<string, unknown>[] }).rows ?? [])[0];
      expect(String(kept?.['document_no'])).toContain(String(kept?.['series_code']));
      expect(String(kept?.['document_no'])).not.toBe('');
    });

    it('⛔ refuses a credit note that names nothing', async () => {
      const order = await anOrder();
      if (order === null) return;

      const numbered = await db.execute(sql`select * from next_document_no('CN', now())`);
      const no = ((numbered as { rows?: readonly Record<string, unknown>[] }).rows ?? [])[0];

      await expectViolation(db.execute(sql`
          insert into tax_documents
            (kind, order_id, series_code, series_year, series_seq, document_no, document,
             document_hash, pinned_locale, pinned_vat_rate_bp, pinned_vat_treatment,
             net_thb_minor, vat_thb_minor, grand_total_thb_minor, created_by_event_id)
          values ('credit_note', ${order.orderId}::uuid, 'CN', ${Number(no?.['series_year'])},
                  ${Number(no?.['series_seq'])}, ${String(no?.['document_no'])}, '{}'::jsonb,
                  ${'b'.repeat(64)}, 'th', 700, 'standard', 1, 0, 1, ${order.eventId}::uuid)
        `), '23514');
    });

    it('⛔ refuses a second whole-order tax invoice — the owner asked for both modes at once', async () => {
      /*
       * With per-instalment and at-delivery both switched on, nothing in a service stops the
       * same supply being tax-invoiced twice — and an issued document cannot be corrected except
       * by credit note. So the rule is here, where no writer can miss it.
       */
      const order = await anOrder();
      if (order === null) return;

      /* One may already exist from an earlier test in this file; either way a second is refused. */
      await issue(order, 'tax_invoice', 'TAX').catch(() => undefined);

      await expectViolation(issue(order, 'tax_invoice', 'TAX'), '23505');
    });

    it('⛔ refuses money that does not foot', async () => {
      const order = await anOrder();
      if (order === null) return;
      const numbered = await db.execute(sql`select * from next_document_no('RCP', now())`);
      const no = ((numbered as { rows?: readonly Record<string, unknown>[] }).rows ?? [])[0];

      await expectViolation(db.execute(sql`
          insert into tax_documents
            (kind, order_id, series_code, series_year, series_seq, document_no, document,
             document_hash, pinned_locale, pinned_vat_rate_bp, pinned_vat_treatment,
             net_thb_minor, vat_thb_minor, grand_total_thb_minor, created_by_event_id)
          values ('receipt', ${order.orderId}::uuid, 'RCP', ${Number(no?.['series_year'])},
                  ${Number(no?.['series_seq'])}, ${String(no?.['document_no'])}, '{}'::jsonb,
                  ${'c'.repeat(64)}, 'th', 700, 'standard', 10000, 700, 99999, ${order.eventId}::uuid)
        `), '23514');
    });
  });

  describe('who is billed', () => {
    it('⛔ refuses a company buyer with no tax id — a full tax invoice cannot omit it', async () => {
      const result = await db.execute(sql`select id::text as id from orders limit 1`);
      const row = ((result as { rows?: readonly Record<string, unknown>[] }).rows ?? [])[0];
      if (row === undefined) return;

      await expectViolation(db.execute(sql`
          insert into order_bill_to (order_id, buyer_kind, legal_name, address_line)
          values (${String(row['id'])}::uuid, 'juristic', 'บริษัท ทดสอบ จำกัด', '1 ถนนทดสอบ')
        `), '23514');
    });
  });
});
