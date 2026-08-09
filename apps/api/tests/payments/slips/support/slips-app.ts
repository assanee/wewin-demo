import type { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Database } from '@wewin/db';
import { sql } from '@wewin/db/sql';
import { divRoundHalfUp } from '@wewin/core/money';

import { AppModule } from '../../../../src/app.module';
import { parseOAuthConfig } from '../../../../src/auth/oauth/oauth.config';
import { AllExceptionsFilter } from '../../../../src/common/errors/all-exceptions.filter';
import type { Env } from '../../../../src/config/env';
import { ScheduleService, depositPercentTerms } from '../../../../src/payments/schedule';
import { testSessionConfig , testMfaSecretKey } from '../../../support/app';

/**
 * The real application graph. Nothing added, and that is the change.
 *
 * ── Why the module is no longer named here ───────────────────────────────────────
 *
 * It used to be, because `SlipsModule` was not in `AppModule.forRoot`'s import list — so this
 * suite passed against an application that answered 404 on every route it tested. The alarm
 * (`tests/rbac/route-audit.test.ts`) is what eventually said so.
 *
 * ⚠️ Naming it again is now a *failure*, not a redundancy: `SlipsModule.forRoot()` returns a
 * fresh `DynamicModule` on every call, Nest cannot deduplicate it by class reference, and the
 * boot audit refuses to start with *"shares one handler function with … — an inherited handler
 * cannot carry two access policies"*. The same audit catches both directions.
 *
 * Everything else is the real thing — the same middleware, the same global guard, the same
 * boot-time route audit — so a slip route added without an access policy fails this suite at
 * `listen`, before a single assertion runs.
 *
 * ── The object store is real, and that is deliberate ─────────────────────────────
 *
 * `SlipImageStore` is not stubbed. The upload path is where a slip photograph has its Exif
 * stripped and where the private bucket is separated from the public one, and both are
 * claims about bytes actually written. `docker-compose.yml` brings MinIO up beside Postgres
 * and `pnpm db:up` waits on both, so a suite that has a database has a bucket; the bucket
 * itself is created on first write by `ObjectStorage.ensureBucket`.
 */

export interface SlipsApp {
  readonly app: INestApplication;
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}

export async function bootSlipsApp(env: Env): Promise<SlipsApp> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forRoot(env, {
        session: testSessionConfig(),
        mfaSecretKey: testMfaSecretKey(),
        oauth: parseOAuthConfig({}),
      })],
  }).compile();

  const app = moduleRef.createNestApplication({ logger: false });
  app.useGlobalFilters(new AllExceptionsFilter(env));
  app.enableShutdownHooks();
  await app.listen(0, '127.0.0.1');

  const address = app.getHttpServer().address() as AddressInfo;
  return {
    app,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await app.close();
    },
  };
}

export interface RawResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly bytes: Buffer;
}

/**
 * The upload route takes the file as the request body, so it needs a client that sends one.
 *
 * The shared `client()` in `tests/payments/support` serialises JSON, which is right for
 * every other route in this feature and cannot send a PNG.
 */
export async function uploadImage(
  baseUrl: string,
  path: string,
  token: string,
  bytes: Buffer,
  contentType = 'image/png',
): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': contentType },
    body: new Uint8Array(bytes),
  });

  const text = await response.text();
  return { status: response.status, body: text.length === 0 ? null : (JSON.parse(text) as unknown) };
}

/** A raw GET, for the image route — whose body is bytes and whose headers are the assertion. */
export async function getRaw(baseUrl: string, path: string): Promise<RawResponse> {
  const response = await fetch(`${baseUrl}${path}`);
  return {
    status: response.status,
    headers: response.headers,
    bytes: Buffer.from(await response.arrayBuffer()),
  };
}

export interface Schedule {
  readonly depositThbMinor: bigint;
  readonly balanceThbMinor: bigint;
}

/**
 * Plan 7.5(ก)'s 30/70, written through the real schedule service.
 *
 * ⚠️ IT USED TO BE FOUR RAW STATEMENTS, and it had to be: `OrdersService.submit` created no
 * schedule at all, so a suite about slips had to invent the instalments a slip is allocated
 * against. That is also why no slip could ever be accepted through the shipped application —
 * `planAllocations` had an empty instalment map and every acceptance was
 * `instalment_not_on_this_order`.
 *
 * The submit now opens a schedule (one `remainder` gating `production_confirmed` — plan 13's
 * "gate coverage = payment in full" default), so this replaces it rather than inserting beside
 * it, and it replaces it by calling `ScheduleService.replace` — the same method 5c's authoring
 * route will call. A fixture writing rows by hand is a fixture that goes on passing after the
 * production writer starts producing something else.
 *
 * The deposit is `divRoundHalfUp(grand × 3000, 10000)` and the balance is the *difference*,
 * which is plan 7.5(ก)'s own worked example: ฿8,791 split 50/50 by rounding each half is
 * ฿8,792 and does not foot, and the last instalment being the remainder is the fix.
 *
 * The pinned obligation is re-pinned to match. That is not tidying: `orders.scheduled_deposit_thb_minor`
 * is the ceiling on every forfeit (plan 7.13), and a 30/70 schedule beside a pin of 100% is the
 * ฿5,916.67-versus-฿19,722.24 divergence the red team measured. 5c's authoring route owns this
 * write; until it exists the fixture does what that route will have to do.
 */
export async function writeThirtySeventy(
  db: Database,
  app: SlipsApp,
  orderId: string,
  grandTotalThbMinor: bigint,
): Promise<Schedule> {
  const depositThbMinor = divRoundHalfUp(grandTotalThbMinor * 3000n, 10000n);
  const balanceThbMinor = grandTotalThbMinor - depositThbMinor;

  const schedule = app.app.get(ScheduleService);

  await db.transaction(async (tx) => {
    await schedule.replace(
      { tx, orderId, status: 'awaiting_payment', grandTotalThbMinor },
      depositPercentTerms(3000),
    );

    await tx.execute(sql`
      update orders set scheduled_deposit_thb_minor = ${depositThbMinor.toString()}::bigint
       where id = ${orderId}::uuid
    `);
  });

  return { depositThbMinor, balanceThbMinor };
}

/** The instalment ids of an order, in `seq` order. */
export async function instalmentIds(db: Database, orderId: string): Promise<string[]> {
  const result = await db.execute<{ id: string }>(
    sql`select id from order_instalments where order_id = ${orderId} order by seq`,
  );
  return result.rows.map((row) => row.id);
}

/** How many rows the spine carries. The rejection test is entirely about this not changing. */
export async function eventCount(db: Database, orderId: string): Promise<number> {
  const result = await db.execute<{ n: string }>(
    sql`select count(*)::text as n from order_events where order_id = ${orderId}`,
  );
  return Number(result.rows[0]?.n ?? '0');
}

/** How many ledger entries an order carries, and of which kinds. */
export async function ledgerKinds(db: Database, orderId: string): Promise<string[]> {
  const result = await db.execute<{ kind: string }>(
    sql`select kind from ledger_entries where order_id = ${orderId} order by occurred_at, kind`,
  );
  return result.rows.map((row) => row.kind);
}

/** `order_cash_thb_minor` / `order_held_thb_minor` / `order_settled_thb_minor`, from the database. */
export async function folds(
  db: Database,
  orderId: string,
): Promise<{ cash: bigint; held: bigint; settled: bigint; settledThrough: number | null }> {
  const result = await db.execute<{
    cash: string;
    held: string;
    settled: string;
    through: number | null;
  }>(sql`
    select order_cash_thb_minor(${orderId})::text     as cash,
           order_held_thb_minor(${orderId})::text     as held,
           order_settled_thb_minor(${orderId})::text  as settled,
           order_settled_through(${orderId})          as through
  `);

  const row = result.rows[0];
  if (row === undefined) throw new Error('the folds returned no row');

  return {
    cash: BigInt(row.cash),
    held: BigInt(row.held),
    settled: BigInt(row.settled),
    settledThrough: row.through === null ? null : Number(row.through),
  };
}

/**
 * A bank account, written directly — task 13 fix round 1.
 *
 * `bank_accounts_block_delete` refuses a `DELETE` on this table, so every row this inserts
 * outlives the test that created it; the caller is expected to pass an account number unique
 * to the run (the pg suites here already tag orders and users with a random suffix for the
 * same reason).
 */
export async function makeBankAccount(
  db: Database,
  input: {
    readonly bankCode: string;
    readonly accountNumber: string;
    readonly accountName: string;
    readonly isActive: boolean;
  },
): Promise<string> {
  const result = await db.execute<{ id: string }>(sql`
    insert into bank_accounts (bank_code, account_number, account_name, is_active)
    values (${input.bankCode}, ${input.accountNumber}, ${input.accountName}, ${input.isActive})
    returning id
  `);
  const row = result.rows[0];
  if (row === undefined) throw new Error('the bank account could not be created');
  return row.id;
}

/**
 * `payment_slips.received_bank_account_id`, read directly.
 *
 * Not on the wire — `SlipWire` does not carry it (see `slips.contract.ts`'s own note on why
 * this task did not add it there) — so the only way to observe what `createSlip` actually
 * wrote is to read the column itself.
 */
export async function receivedAccountOf(db: Database, slipId: string): Promise<string | null> {
  const result = await db.execute<{ id: string | null }>(
    sql`select received_bank_account_id as id from payment_slips where id = ${slipId}`,
  );
  return result.rows[0]?.id ?? null;
}
