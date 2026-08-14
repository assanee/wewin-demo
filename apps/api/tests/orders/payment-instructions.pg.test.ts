import { randomInt, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, createPool, type Database, type Pool } from '@wewin/db/client';
import { sql } from '@wewin/db/sql';
import { toBigInt } from '@wewin/contract/exact';
import type { OrderLineRequestWire, OrderWire } from '@wewin/contract/order';
import type { BankAccountWire, PaymentInstructionsWire } from '@wewin/contract/organisation';

import {
  bootPaymentsApp,
  client,
  liveLine,
  makeActor,
  paymentsEnv,
  submittedOrder,
  type Actor,
  type Json,
  type PaymentsApp,
} from '../payments/support/payments-app';
import { giveOrderHeldMoney } from '../payments/support/money-fixture';
import { uploadImage, writeThirtySeventy } from '../payments/slips/support/slips-app';
import { makePng } from '../media/fixtures';

/**
 * `GET /orders/:orderId/payment-instructions` — task 10.
 *
 * ── Why this reuses the payments harness rather than `tests/orders/support` ──────
 *
 * The interesting property is not the route's shape, it is *where the number comes from*.
 * `order_outstanding_thb_minor()` — `packages/db/drizzle/0011_payment_guards.sql` — is the
 * same fold `SlipsRepository.orderMoney()` reads for the staff slip-review wire
 * (`apps/dashboard/src/components/slips/slip-review-dialog.tsx:140`'s
 * `review.money.outstandingThbMinor`), and the only way to prove this route reads the same
 * fold rather than a client-side subtraction is to put real money on a real schedule and read
 * the answer back over real HTTP. `writeThirtySeventy` and `giveOrderHeldMoney` are the
 * fixtures the slips and ledger suites already use for exactly that, chosen over inventing a
 * third so this suite cannot quietly test a different world from theirs.
 *
 * Skipped, not failed, without a database.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

const tag = randomUUID().slice(0, 8);
const contactFor = (who: string): { email: string; name: string } => ({
  email: `payment-instructions-${who}-${tag}@probe.invalid`,
  name: `payment instructions probe ${tag}`,
});

/** Ten to fifteen digits, freshly random, so `bank_accounts_number_key` never collides. */
function freshAccountNumber(): string {
  return Array.from({ length: 12 }, () => String(randomInt(10))).join('');
}

/** The fold this route must agree with, read directly — the same function `LedgerRepository.money()` calls. */
async function outstandingFold(db: Database, orderId: string): Promise<bigint> {
  const result = await db.execute<{ outstanding: string }>(
    sql`select coalesce(order_outstanding_thb_minor(${orderId}::uuid), 0)::text as outstanding`,
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('the fold returned no row');
  return BigInt(row.outstanding);
}

describeWithPg('GET /orders/:orderId/payment-instructions', () => {
  let pool: Pool;
  let db: Database;
  let app: PaymentsApp;
  let call: ReturnType<typeof client>;

  let customerA: Actor;
  let customerB: Actor;
  let staff: Actor;
  let writer: Actor;
  let line: OrderLineRequestWire;

  let activeAccountId: string;
  let inactiveAccountId: string;

  beforeAll(async () => {
    pool = createPool(url ?? '');
    db = createDatabase(pool);

    app = await bootPaymentsApp(paymentsEnv(url ?? ''));
    call = client(app.baseUrl);

    customerA = await makeActor(db, app, `payment-instructions customer A ${tag}`, []);
    customerB = await makeActor(db, app, `payment-instructions customer B ${tag}`, []);
    staff = await makeActor(db, app, `payment-instructions staff ${tag}`, ['orders.read']);
    writer = await makeActor(db, app, `payment-instructions writer ${tag}`, ['organisation.write']);
    line = await liveLine(call);

    /* One active account this route must serve, one inactive account it must never serve. */
    const active = (await call('POST', '/admin/organisation/bank-accounts', {
      token: writer.token,
      body: {
        bankCode: 'KBANK',
        accountNumber: freshAccountNumber(),
        accountName: `probe active ${tag}`,
        promptpayId: null,
        sortOrder: 1,
      },
    })) as Json;
    if (active.status !== 201) throw new Error(`could not seed an active account: ${JSON.stringify(active.body)}`);
    activeAccountId = (active.body as BankAccountWire).id;

    const inactive = (await call('POST', '/admin/organisation/bank-accounts', {
      token: writer.token,
      body: {
        bankCode: 'SCB',
        accountNumber: freshAccountNumber(),
        accountName: `probe inactive ${tag}`,
        promptpayId: null,
        sortOrder: 2,
      },
    })) as Json;
    if (inactive.status !== 201) throw new Error(`could not seed an inactive account: ${JSON.stringify(inactive.body)}`);
    inactiveAccountId = (inactive.body as BankAccountWire).id;

    const deactivated = await call('PUT', `/admin/organisation/bank-accounts/${inactiveAccountId}/availability`, {
      token: writer.token,
      body: { isActive: false },
    });
    if (deactivated.status !== 200) {
      throw new Error(`could not deactivate the probe account: ${JSON.stringify(deactivated.body)}`);
    }
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  /* ---------------------------------------------------------------- *
   * The ownership boundary — the anti-oracle rule this codebase follows everywhere
   * ---------------------------------------------------------------- */

  it('answers 404 for an order id that names nothing', async () => {
    const answer = await call('GET', `/orders/${randomUUID()}/payment-instructions`, {
      token: customerA.token,
    });
    expect(answer.status).toBe(404);
  });

  it('answers 404 — never 403 — when the order exists but belongs to somebody else', async () => {
    const order = await submittedOrder(call, customerA, line, contactFor('boundary'));

    const asOwner = await call('GET', `/orders/${order.id}/payment-instructions`, {
      token: customerA.token,
    });
    expect(asOwner.status).toBe(200);

    const asStranger = await call('GET', `/orders/${order.id}/payment-instructions`, {
      token: customerB.token,
    });
    expect(asStranger.status).toBe(404);

    /*
     * The whole point of the anti-oracle rule: "exists but not yours" and "does not exist" have
     * to be indistinguishable from the response, or an id can be confirmed real by the status
     * code alone. `path`, `requestId` and `timestamp` are per-request by construction, so the
     * comparison is on the two fields that would leak the distinction if there were one.
     */
    const asStrangerOnMissing = await call('GET', `/orders/${randomUUID()}/payment-instructions`, {
      token: customerB.token,
    });
    const errorOf = (body: unknown): { code: unknown; message: unknown } => {
      const error = (body as { error?: { code?: unknown; message?: unknown } }).error;
      return { code: error?.code, message: error?.message };
    };
    expect(asStrangerOnMissing.status).toBe(asStranger.status);
    expect(errorOf(asStrangerOnMissing.body)).toStrictEqual(errorOf(asStranger.body));
  });

  it('answers 401 for a caller with no principal at all', async () => {
    const order = await submittedOrder(call, customerA, line, contactFor('anon'));
    const answer = await call('GET', `/orders/${order.id}/payment-instructions`, {});
    expect(answer.status).toBe(401);
  });

  /* ---------------------------------------------------------------- *
   * The shape: money, and only the accounts a customer may see
   * ---------------------------------------------------------------- */

  it('gives the owner the grand total, the outstanding balance, and only active accounts', async () => {
    const order = await submittedOrder(call, customerA, line, contactFor('owner'));
    const grandTotal = toBigInt(order.grandTotalThbMinor ?? never('a submitted order has a grand total'));

    const answer = await call('GET', `/orders/${order.id}/payment-instructions`, {
      token: customerA.token,
    });
    expect(answer.status).toBe(200);
    const body = answer.body as PaymentInstructionsWire;

    expect(toBigInt(body.grandTotalThbMinor)).toBe(grandTotal);
    /* Plan 13's default: one instalment covering the whole total, and nothing paid yet. */
    expect(toBigInt(body.outstandingThbMinor)).toBe(grandTotal);

    const ids = body.accounts.map((account) => account.id);
    expect(ids).toContain(activeAccountId);
    expect(ids).not.toContain(inactiveAccountId);

    /*
     * ⚠️ The privacy boundary, checked on every account in the answer — including the ones
     * other suites left behind in this shared table, not only the two this file just created.
     * `isActive`, `sortOrder` and `updatedAt` are internal ordering and administration; a
     * customer gets none of them.
     */
    for (const account of body.accounts) {
      expect(Object.keys(account).sort()).toStrictEqual(
        ['accountName', 'accountNumber', 'bankCode', 'id', 'promptpayId'].sort(),
      );
    }
  });

  it('serves the accounts in `sort_order`, faithfully forwarding what `activeAccounts()` returns', async () => {
    const order = await submittedOrder(call, customerA, line, contactFor('sort-order'));

    const first = (await call('POST', '/admin/organisation/bank-accounts', {
      token: writer.token,
      body: {
        bankCode: 'BBL',
        accountNumber: freshAccountNumber(),
        accountName: `probe sort-order first ${tag}`,
        promptpayId: null,
        sortOrder: 10,
      },
    })) as Json;
    const second = (await call('POST', '/admin/organisation/bank-accounts', {
      token: writer.token,
      body: {
        bankCode: 'BBL',
        accountNumber: freshAccountNumber(),
        accountName: `probe sort-order second ${tag}`,
        promptpayId: null,
        sortOrder: 20,
      },
    })) as Json;
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const firstId = (first.body as BankAccountWire).id;
    const secondId = (second.body as BankAccountWire).id;

    const answer = await call('GET', `/orders/${order.id}/payment-instructions`, {
      token: customerA.token,
    });
    const body = answer.body as PaymentInstructionsWire;
    const ids = body.accounts.map((account) => account.id);

    expect(ids.indexOf(firstId)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(secondId)).toBeGreaterThan(ids.indexOf(firstId));
  });

  /* ---------------------------------------------------------------- *
   * The fold — not a subtraction this service assembles itself
   * ---------------------------------------------------------------- */

  it(
    'reads the same fold the staff slip-review wire reads: the balance owed after only the ' +
      'deposit instalment is settled, not zero and not a per-slip subtraction',
    async () => {
      const order = await submittedOrder(call, customerA, line, contactFor('fold'));
      const grandTotal = toBigInt(order.grandTotalThbMinor ?? never('a submitted order has a grand total'));

      const schedule = await writeThirtySeventy(db, app, order.id, grandTotal);

      /*
       * Only the deposit (the gate instalment) is paid. A route that answered ฿0.00 here
       * mistook "the gate is open" for "nothing is owed" — order_gate_is_open() and
       * order_outstanding_thb_minor() are different questions, and plan 7.5(ค) is explicit that
       * conflating them is the bug. A route that instead summed accepted *slip* amounts rather
       * than *allocations* would happen to agree here too, which is exactly why this fixture pays
       * no more and no less than the instalment's own due: the divergence this test is pinned
       * against is "did every instalment get folded in", not "was a slip's face value used
       * instead of its allocation" — that second one is `slips.pg.test.ts`'s and
       * `ledger.pg.test.ts`'s to hold.
       */
      await giveOrderHeldMoney(db, {
        orderId: order.id,
        grandTotalThbMinor: grandTotal,
        paidThbMinor: schedule.depositThbMinor,
        payerName: `payer ${tag}`,
        payerAccountLast4: '4821',
        reviewerUserId: staff.userId,
      });

      const expected = await outstandingFold(db, order.id);
      expect(expected).toBe(schedule.balanceThbMinor);
      expect(expected).not.toBe(0n);

      const answer = await call('GET', `/orders/${order.id}/payment-instructions`, {
        token: customerA.token,
      });
      expect(answer.status).toBe(200);
      const body = answer.body as PaymentInstructionsWire;

      expect(toBigInt(body.outstandingThbMinor)).toBe(expected);
      expect(toBigInt(body.outstandingThbMinor)).toBe(schedule.balanceThbMinor);
    },
  );

  /* ---------------------------------------------------------------- *
   * ⭐ Whether the order can still be paid — the question this route did not answer
   * ---------------------------------------------------------------- */

  it('says a live order can still receive a payment', async () => {
    /*
     * The control the interesting test needs: without it, a route hard-coding `false` — or an
     * `acceptsPayment` that lost its list — would pass the cancellation assertion below and be
     * a screen that never lets anybody pay.
     */
    const order = await submittedOrder(call, customerA, line, contactFor('live'));

    const answer = await call('GET', `/orders/${order.id}/payment-instructions`, {
      token: customerA.token,
    });
    expect(answer.status).toBe(200);
    expect((answer.body as PaymentInstructionsWire).acceptsPayment).toBe(true);
  });

  it(
    '⭐ says payment is closed the moment the order is cancelled — while the figures still ' +
      'describe the residue, and the upload route agrees',
    async () => {
      /*
       * ─────────────────────────────────────────────────────────────────────────────
       * ⭐ THE ASSERTION THIS FIX TURNS ON.
       * ─────────────────────────────────────────────────────────────────────────────
       *
       * This route does not go through `encodeOrderSummary`, so the live-order predicate that
       * fixed `GET /orders` and `GET /orders/:id` never reached it. Executed against this very
       * database, one cancelled order answered:
       *
       *     GET /orders/:id/payment-instructions → outstanding 1035418, nextDue 1035418
       *     GET /orders            (same order)  → null
       *
       * and `PaymentIsland` — which had no status gate at all, only
       * `outstandingThbMinor <= 0n` — printed "ยอดคงค้างทั้งหมด ฿10,354.18" in `text-lead
       * text-lime` with the slip-upload form beneath it, on an order the customer had
       * cancelled and on which the company owed *them* the deposit they had already paid.
       *
       * A deposit is paid here before the cancellation precisely so the wrong answer is the
       * cruel one: there is real money on the order, a real unpaid balance behind it, and the
       * company is the party that owes.
       */
      const order = await submittedOrder(call, customerA, line, contactFor('cancelled'));
      const grandTotal = toBigInt(order.grandTotalThbMinor ?? never('a submitted order has a grand total'));
      const schedule = await writeThirtySeventy(db, app, order.id, grandTotal);

      await giveOrderHeldMoney(db, {
        orderId: order.id,
        grandTotalThbMinor: grandTotal,
        paidThbMinor: schedule.depositThbMinor,
        payerName: `payer ${tag}`,
        payerAccountLast4: '5150',
        reviewerUserId: staff.userId,
      });

      const before = await call('GET', `/orders/${order.id}/payment-instructions`, {
        token: customerA.token,
      });
      expect(before.status).toBe(200);
      expect((before.body as PaymentInstructionsWire).acceptsPayment).toBe(true);

      const cancelled = await call('POST', `/orders/${order.id}/transitions/cancelled`, {
        token: customerA.token,
        body: { reason: 'เปลี่ยนใจ ยังไม่พร้อมติดตั้ง' },
      });
      expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
      expect((cancelled.body as OrderWire).status).toBe('cancelled');

      const answer = await call('GET', `/orders/${order.id}/payment-instructions`, {
        token: customerA.token,
      });
      expect(answer.status).toBe(200);
      const body = answer.body as PaymentInstructionsWire;

      /* The one field the screen gates on. */
      expect(body.acceptsPayment).toBe(false);

      /*
       * ⚠️ And the figures are still *stated*, which is the difference between withholding a
       * bill and losing a number. `GET /orders` nulls its two folds on a cancelled row —
       * a ค้างชำระ column has no honest value there — but this response has exactly one
       * reader, and it is the screen that must be able to show a customer what happened on an
       * order that has stopped. What changed is not the arithmetic; it is that the screen is
       * told not to print it as a demand.
       *
       * Compared against the fold read straight from Postgres, so a future "fix" that zeroed
       * the figures here instead of gating the screen fails this line rather than passing it.
       */
      const residue = await outstandingFold(db, order.id);
      expect(residue, 'the deposit is paid and the balance is not — there is a residue').toBeGreaterThan(0n);
      expect(toBigInt(body.outstandingThbMinor)).toBe(residue);
      expect(toBigInt(body.grandTotalThbMinor)).toBe(grandTotal);

      /*
       * ⭐ And the boolean is the *same list* the upload route refuses on. This is what makes
       * it a fix rather than a second opinion: had the screen kept its own copy of the
       * statuses — as `apps/web/src/lib/payment/payable.ts` does for the two link sites — the
       * two could drift, and the drift is silent in the direction that hurts (a form offered
       * over an endpoint that answers 409).
       */
      const refused = await uploadImage(
        app.baseUrl,
        `/orders/${order.id}/payment-slips/image`,
        customerA.token,
        makePng(),
      );
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({
        error: { details: { reason: 'order_not_accepting_slips', status: 'cancelled' } },
      });
    },
    60_000,
  );
});

function never(message: string): never {
  throw new Error(message);
}
