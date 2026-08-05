import { randomUUID } from 'node:crypto';

import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createDatabase, createPool, type Database, type Pool } from '@wewin/db/client';
import { sql } from '@wewin/db/sql';
import { encodeThb } from '@wewin/contract/order';
import { encodeUm } from '@wewin/contract/measure';
import type { OrderLineRequestWire, OrderWire } from '@wewin/contract/order';

import { makePng } from '../../media/fixtures';
import { ScheduleService, depositPercentTerms } from '../../../src/payments/schedule';
import {
  bootPaymentsApp,
  client,
  makeActor,
  paymentsEnv,
  type Actor,
  type PaymentsApp,
} from '../support/payments-app';
import { uploadImage } from '../slips/support/slips-app';

/** THE WALK — one order, ฿8,791 net, from quote to a cancellation that keeps nothing. */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;
const tag = randomUUID().slice(0, 8);

const baht = (minor: bigint): string => {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  return `${negative ? '-' : ''}฿${(abs / 100n).toLocaleString('en-US')}.${(abs % 100n).toString().padStart(2, '0')}`;
};

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

describeWithPg('WALK', () => {
  let pool: Pool;
  let db: Database;
  let app: PaymentsApp;
  let call: ReturnType<typeof client>;
  let customer: Actor;
  let reviewer: Actor;
  let staff: Actor;

  beforeAll(async () => {
    pool = createPool(url ?? '');
    db = createDatabase(pool);
    app = await bootPaymentsApp(paymentsEnv(url ?? ''));
    call = client(app.baseUrl);
    customer = await makeActor(db, app, `walk customer ${tag}`, []);
    reviewer = await makeActor(db, app, `walk reviewer ${tag}`, [
      'payments.verify',
      'payments.read',
      'orders.read',
      'orders.write',
    ]);
    staff = await makeActor(db, app, `walk staff ${tag}`, ['orders.read', 'orders.write']);
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('walks sld-2p 180×220 WH/CLR/T6/LK1 from quote to cancellation', async () => {
    /* ── the line: pricing spec case 6, ฿8,791.2 → ฿8,791 net ── */
    const listed = await call('GET', '/catalog/products', {});
    const published = (
      listed.body as { products: readonly { productVersionId: string; documentHash: string; product: { id: string } }[] }
    ).products.find((row) => row.product.id === 'sld-2p');
    if (!published) throw new Error('sld-2p is not published');

    const line: OrderLineRequestWire = {
      productVersionId: published.productVersionId,
      documentHash: published.documentHash,
      productId: 'sld-2p',
      selections: { profile_color: 'WH', glass_color: 'CLR', glass_thickness: 'T6', lock_type: 'LK1' },
      measures: { width: encodeUm(1_800_000n), height: encodeUm(2_200_000n) },
      enteredUnits: { width: 'cm', height: 'cm' },
      qty: 1,
    };

    const created = await call('POST', '/orders', { token: customer.token, body: {} });
    const draft = created.body as OrderWire;
    const submitted = await call('POST', `/orders/${draft.id}/transitions/awaiting_payment`, {
      token: customer.token,
      body: {
        contact: { email: `walk-${tag}@probe.invalid`, name: `walk ${tag}` },
        lines: [line],
      },
    });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    const order = submitted.body as OrderWire;
    const id = order.id;

    const money = await db.execute<{ net: string; vat: string; grand: string; rate: number; deposit: string; policy: string }>(sql`
      select o.net_thb_minor::text as net, o.vat_thb_minor::text as vat,
             o.grand_total_thb_minor::text as grand, d.pinned_vat_rate_bp as rate,
             o.scheduled_deposit_thb_minor::text as deposit,
             (select code from forfeit_policies f where f.id = o.forfeit_policy_id) as policy
        from orders o join order_documents d on d.id = o.document_id
       where o.id = ${id}::uuid
    `);
    const net = BigInt(money.rows[0]?.net ?? '0');
    const vat = BigInt(money.rows[0]?.vat ?? '0');
    const grand = BigInt(money.rows[0]?.grand ?? '0');

    say('');
    say('════ 1 · THE QUOTE ════════════════════════════════════════════════════');
    say(`  line               sld-2p 180×220 cm · WH/CLR/T6/LK1 · qty 1`);
    say(`  net_thb_minor      ${net}            = ${baht(net)}`);
    say(`  vat_rate_bp        ${String(money.rows[0]?.rate)}                 (plan 13 default, pinned on the document)`);
    say(`  vat_thb_minor      ${vat}             = ${baht(vat)}   ← derived: round_half_up(net × 700 / 10000)`);
    say(`  grand_total        ${grand}            = ${baht(grand)}   ← net + vat, and VAT-INCLUSIVE always`);
    say(`  foots              ${net} + ${vat} = ${net + vat}  ${net + vat === grand ? '✓' : '✗'}`);
    say(`  pinned at submit   scheduled_deposit = ${baht(BigInt(money.rows[0]?.deposit ?? '0'))} · forfeit_policy = ${String(money.rows[0]?.policy)}`);

    expect(net).toBe(879_100n);
    expect(net + vat).toBe(grand);

    /* ── 2 · the 30/70 ── */
    const deposit = (grand * 3000n + 5000n) / 10000n;
    const balance = grand - deposit;
    const schedule = app.app.get(ScheduleService);
    await db.transaction(async (tx) => {
      await schedule.replace(
        { tx, orderId: id, status: 'awaiting_payment', grandTotalThbMinor: grand },
        depositPercentTerms(3000),
      );
      await tx.execute(
        sql`update orders set scheduled_deposit_thb_minor = ${deposit.toString()}::bigint where id = ${id}::uuid`,
      );
    });

    const rows = await db.execute<{ seq: number; basis: string; due: string; gate: string | null }>(sql`
      select seq, basis, due_thb_minor::text as due, gates_entry_to::text as gate
        from order_instalments where order_id = ${id}::uuid order by seq
    `);

    say('');
    say('════ 2 · THE SCHEDULE — 30 % deposit ══════════════════════════════════');
    for (const row of rows.rows) {
      say(
        `  seq ${row.seq}  ${row.basis.padEnd(9)} ${baht(BigInt(row.due)).padStart(12)}  gate → ${row.gate ?? '(none)'}`,
      );
    }
    const scheduled = rows.rows.reduce((sum, row) => sum + BigInt(row.due), 0n);
    say(`  SUM(due)           ${scheduled} = ${baht(scheduled)}  ${scheduled === grand ? '✓ foots to the grand total' : '✗'}`);
    say(`  exact 30 %         ${grand} × 0.30 = ${Number(grand) * 0.3} satang → half_up ${deposit}`);
    say(`  the balance is the DIFFERENCE, never a second rounding: ${grand} − ${deposit} = ${balance}`);
    expect(scheduled).toBe(grand);

    /* ── 3 · the deposit slip ── */
    const upload = async (amount: bigint): Promise<string> => {
      const image = await uploadImage(
        app.baseUrl,
        `/orders/${id}/payment-slips/image`,
        customer.token,
        makePng(),
      );
      const slip = await call('POST', `/orders/${id}/payment-slips`, {
        token: customer.token,
        body: {
          imageHandle: (image.body as { imageHandle: string }).imageHandle,
          amountThbMinor: encodeThb(amount),
          transferredAt: new Date().toISOString(),
          bankReference: `WALK-${randomUUID().slice(0, 6)}`,
          payerName: 'สมชาย ใจดี',
          payerAccountLast4: '4321',
        },
      });
      return (slip.body as { id: string }).id;
    };

    const gate = async (): Promise<boolean> => {
      const row = await db.execute<{ open: boolean }>(
        sql`select order_gate_is_open(${id}::uuid, 'production_confirmed') as open`,
      );
      return row.rows[0]?.open ?? false;
    };

    const before = await gate();
    const depositSlip = await upload(deposit);
    const accepted = await call('POST', `/payments/slips/${depositSlip}/acceptance`, {
      token: reviewer.token,
      body: {
        allocations: [{ instalmentId: rows.rows[0]?.seq === 1 ? await firstId(db, id) : '', amountThbMinor: encodeThb(deposit) }],
        payer: { name: 'สมชาย ใจดี', accountLast4: '4321' },
      },
    });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    const result = accepted.body as { gateOpened: boolean; orderTransition: { to: string } | null };

    say('');
    say('════ 3 · THE DEPOSIT SLIP ═════════════════════════════════════════════');
    say(`  slip amount        ${baht(deposit)}   allocated to instalment seq 1`);
    say(`  gate before        ${String(before)}      ← ฿0.00 received, production is shut`);
    say(`  gate after         ${String(await gate())}`);
    say(`  gateOpened         ${String(result.gateOpened)}   orderTransition → ${result.orderTransition?.to ?? 'null'}`);
    say(`  settledThrough     ${String(await through(db, id))}         (MAX(seq) over the settled prefix, never a count)`);
    await ledger(db, id, '  ');

    /* ── 4 · the balance ── */
    const balanceSlip = await upload(balance);
    const second = await call('POST', `/payments/slips/${balanceSlip}/acceptance`, {
      token: reviewer.token,
      body: {
        allocations: [{ instalmentId: await secondId(db, id), amountThbMinor: encodeThb(balance) }],
        payer: { name: 'สมชาย ใจดี', accountLast4: '4321' },
      },
    });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    const secondResult = second.body as { gateOpened: boolean; orderTransition: unknown };

    say('');
    say('════ 4 · THE BALANCE ══════════════════════════════════════════════════');
    say(`  slip amount        ${baht(balance)}   allocated to instalment seq 2`);
    say(`  gateOpened         ${String(secondResult.gateOpened)}   orderTransition → ${String(secondResult.orderTransition)}   ← a payment event, the order does not move`);
    say(`  settledThrough     ${String(await through(db, id))}`);
    await ledger(db, id, '  ');

    /* ── 5 · into production, then cancelled ── */
    const moved = await call('POST', `/orders/${id}/transitions/in_production`, {
      token: staff.token,
      body: {},
    });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);

    const cancelled = await call('POST', `/orders/${id}/transitions/cancelled`, {
      token: customer.token,
      body: { reason: 'เปลี่ยนใจหลังเริ่มผลิต' },
    });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);

    const policy = await db.execute<{ bp: number | null; code: string }>(sql`
      select c.forfeit_bp as bp, f.code
        from orders o
        join forfeit_policies f on f.id = o.forfeit_policy_id
        join forfeit_policy_rules c
          on c.policy_id = f.id and c.from_status = 'in_production' and c.fault = 'customer'
       where o.id = ${id}::uuid
    `);

    say('');
    say('════ 5 · CANCELLED FROM in_production ═════════════════════════════════');
    say(`  fault              customer   ← derived from who cancelled, never from a body field`);
    say(`  policy             ${String(policy.rows[0]?.code)} · (in_production × customer) = ${String(policy.rows[0]?.bp)} bp   ← plan 13 DEFAULT`);
    say(`  forfeit base       min(received ${baht(grand)}, pinned deposit ${baht(deposit)}) = ${baht(deposit)}`);
    say(`  forfeit            ${baht(deposit)} × ${String(policy.rows[0]?.bp)} bp = ${baht(0n)}   ← nothing is kept, so no posting is written`);
    const closed = await db.execute<{ closed: string | null; status: string; bucket: string }>(sql`
      select (select s.closed_at::text from order_payment_schedules s where s.order_id = o.id) as closed,
             o.status, order_payment_queue_bucket(o.id) as bucket
        from orders o where o.id = ${id}::uuid
    `);
    say(`  status             ${String(closed.rows[0]?.status)}   schedule_closed_at ${closed.rows[0]?.closed === null ? 'NULL ✗' : 'stamped ✓'}`);
    say(`  queue bucket       ${String(closed.rows[0]?.bucket)}   ← plan 7.8's bucket that must be visible`);
    await ledger(db, id, '  ');

    const refund = await call('POST', '/payments/refunds', {
      token: staff.token,
      body: { orderId: id },
    });
    say(`  refund request     ${String(refund.status)} ${refund.status === 403 ? '(the reviewer/staff separation — a colleague requests it)' : ''}`);

    say('');
    say('════ THE LEDGER, EXPLAINED ════════════════════════════════════════════');
    say(`  bank_thb        ${baht(await acct(db, id, 'bank_thb')).padStart(12)}  two transfers at face value: ${baht(deposit)} + ${baht(balance)}`);
    say(`  deposit_held    ${baht(await acct(db, id, 'deposit_held')).padStart(12)}  a credit balance: the company holds ${baht(grand)} that is not its own`);
    say(`  forfeited       ${baht(await acct(db, id, 'forfeited')).padStart(12)}  0 bp in every cell — plan 13's default, shipped knowingly`);
    say(`  revenue         ${baht(await acct(db, id, 'revenue')).padStart(12)}  the job was never delivered, so none is recognised`);
    say(`  refund_payable  ${baht(await acct(db, id, 'refund_payable')).padStart(12)}  nothing accrued yet — the request above was refused`);
    say(`  credit_clearing ${baht(await acct(db, id, 'credit_clearing')).padStart(12)}  no revision, so nothing was carried`);
    say(`  remittance…     ${baht(await acct(db, id, 'remittance_in_transit')).padStart(12)}  THB only, so every slip lands on acceptance`);
    say(`  trade_receivable${baht(await acct(db, id, 'trade_receivable')).padStart(12)}  unused in 5b: nothing is invoiced before it is paid`);
    say(`  settlement_var… ${baht(await acct(db, id, 'settlement_variance')).padStart(12)}  no bank fee written off on this order`);
    say('');
    say(`  cash  ${baht((await foldsOf(db, id)).cash)}   held  ${baht((await foldsOf(db, id)).held)}   settled  ${baht((await foldsOf(db, id)).settled)}`);
    say(`  outstanding ${baht((await foldsOf(db, id)).outstanding)}  — derived, never a status (plan 7.5(ข) forbids awaiting_balance)`);
    say('');
  }, 180_000);
});

async function firstId(db: Database, orderId: string): Promise<string> {
  const rows = await db.execute<{ id: string }>(
    sql`select id::text as id from order_instalments where order_id = ${orderId}::uuid order by seq limit 1`,
  );
  return rows.rows[0]?.id ?? '';
}

async function secondId(db: Database, orderId: string): Promise<string> {
  const rows = await db.execute<{ id: string }>(
    sql`select id::text as id from order_instalments where order_id = ${orderId}::uuid order by seq offset 1 limit 1`,
  );
  return rows.rows[0]?.id ?? '';
}

async function through(db: Database, orderId: string): Promise<string> {
  const rows = await db.execute<{ n: string | null }>(
    sql`select order_settled_through(${orderId}::uuid)::text as n`,
  );
  return rows.rows[0]?.n ?? 'null';
}

async function acct(db: Database, orderId: string, name: string): Promise<bigint> {
  const rows = await db.execute<{ amount: string }>(
    sql`select order_account_thb_minor(${orderId}::uuid, ${name})::text as amount`,
  );
  return BigInt(rows.rows[0]?.amount ?? '0');
}

async function foldsOf(
  db: Database,
  orderId: string,
): Promise<{ cash: bigint; held: bigint; settled: bigint; outstanding: bigint }> {
  const rows = await db.execute<{ cash: string; held: string; settled: string; outstanding: string }>(sql`
    select order_cash_thb_minor(${orderId}::uuid)::text as cash,
           order_held_thb_minor(${orderId}::uuid)::text as held,
           order_settled_thb_minor(${orderId}::uuid)::text as settled,
           order_outstanding_thb_minor(${orderId}::uuid)::text as outstanding
  `);
  const row = rows.rows[0];
  return {
    cash: BigInt(row?.cash ?? '0'),
    held: BigInt(row?.held ?? '0'),
    settled: BigInt(row?.settled ?? '0'),
    outstanding: BigInt(row?.outstanding ?? '0'),
  };
}

async function ledger(db: Database, orderId: string, indent: string): Promise<void> {
  const rows = await db.execute<{ kind: string; account: string; amount: string }>(sql`
    select e.kind, p.account, p.amount_thb_minor::text as amount
      from ledger_entries e join ledger_postings p on p.entry_id = e.id
     where e.order_id = ${orderId}::uuid
     order by e.occurred_at, e.id, p.leg_no
  `);
  const folded = await foldsOf(db, orderId);
  process.stdout.write(`${indent}ledger:\n`);
  for (const row of rows.rows) {
    const minor = BigInt(row.amount);
    process.stdout.write(
      `${indent}  ${row.kind.padEnd(18)} ${row.account.padEnd(22)} ${(minor < 0n ? '' : '+') + baht(minor)}\n`,
    );
  }
  process.stdout.write(
    `${indent}  cash ${baht(folded.cash)} · held ${baht(folded.held)} · settled ${baht(folded.settled)} · outstanding ${baht(folded.outstanding)}\n`,
  );
}
