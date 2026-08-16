import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, createPool, type Database, type Pool } from '@wewin/db/client';
import { eq, sql } from '@wewin/db/sql';
import { approvals, userGroups } from '@wewin/db/schema';
import type { OrderLineRequestWire, OrderWire } from '@wewin/contract/order';

/* The files, not the directory: `src/quotes/authority.ts` shadows `authority/index.ts`. */
import {
  client,
  liveLine,
  makeActor,
  submittedOrder,
  type Actor,
} from '../../payments/support/payments-app';
import { authorityEnv, bootAuthorityApp, type AuthorityApp } from './support/authority-app';
import { purgeAuthorityLimits } from '../support/authority-reset';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ ขออนุมัติตัดยอดค้างทิ้ง — the third fold, and the two guards around it.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Over real HTTP, against a real Postgres, on an order priced by the application through
 * `submit_for_payment`. Every property here lives *between* the layers and none of it is
 * observable from a unit test:
 *
 *   ⓵ the balance is a **SQL fold** — `order_outstanding_thb_minor()` — with three terms since
 *     0048, and the assertion that matters is that approving a write-off moves it while
 *     `order_settled_thb_minor()` does not budge. A test that computed either figure in
 *     TypeScript would be checking its own arithmetic.
 *   ⓶ the over-write-off guard is a **trigger**, so it holds against a writer that is not this
 *     service — which is the only reason it is in the database at all, and is unreachable
 *     through a mocked repository.
 *   ⓷ "fail closed" is a claim about `authority_limits` with **no live row in it**, plus a
 *     permission granted to nobody at boot. Both are facts about a migrated database.
 *
 * ── ⚠️ WHAT THIS SUITE DELIBERATELY DOES NOT DO ─────────────────────────────
 *
 * It never inserts an `approvals` row by hand for the paths under test. The request goes through
 * `POST /orders/:orderId/write-offs` and the decision through
 * `POST /quotes/approvals/:approvalId/decision`, because the whole design question of the round
 * was *which route, which permission, which kind* — and a fixture that wrote the row itself would
 * answer none of them. The one direct write is in the last block, where the point is precisely
 * that the trigger stops a writer the service does not control.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

const tag = randomUUID().slice(0, 8);

describeWithPg('⭐ write-offs — forgiving a balance the customer owes', () => {
  let pool: Pool;
  let db: Database;
  let app: AuthorityApp;
  let call: ReturnType<typeof client>;
  let line: OrderLineRequestWire;

  /** Collections: may ask for a write-off. Holds neither deciding code, ever. */
  let clerk: Actor;
  /**
   * ⭐ Holds `quotes.approve` AND `payments.write_off` — the conjunction under test.
   *
   * ⚠️ In a real deployment `payments.write_off` is granted to nobody at boot and the owner grants
   * it by hand. The fixture grants it so that the thing refusing an over-write-off is the
   * **balance** and the thing refusing a stranger is the **permission**, each in its own test,
   * rather than one missing grant hiding both.
   */
  let approver: Actor;
  /** ⚠️ `quotes.approve` and NOT `payments.write_off` — the caller the second code is about. */
  let quoteApprover: Actor;
  /** Group administration — the only role that may write a ceiling. */
  let owner: Actor;
  let customer: Actor;

  let approverGroupId: string;
  let quoteApproverGroupId: string;

  beforeAll(async () => {
    pool = createPool(url ?? '');
    db = createDatabase(pool);

    app = await bootAuthorityApp(authorityEnv(url ?? ''));
    call = client(app.baseUrl);

    customer = await makeActor(db, app, `writeoff customer ${tag}`, []);
    /*
     * ⚠️ Exactly the two codes `WriteOffsController` declares, and no third.
     *
     * If this actor held `payments.write_off` the suite could not tell "the ask is allowed" from
     * "the decision is allowed", and the four-eyes test below would be proving the CHECK while a
     * permission was silently doing the work.
     */
    clerk = await makeActor(db, app, `writeoff clerk ${tag}`, [
      'orders.read',
      'orders.write',
      'payments.read',
      'quotes.read',
    ]);
    approver = await makeActor(db, app, `writeoff approver ${tag}`, [
      'quotes.read',
      'quotes.approve',
      'payments.write_off',
      'orders.read',
      'orders.write',
      'payments.read',
    ]);
    quoteApprover = await makeActor(db, app, `writeoff quoteapprover ${tag}`, [
      'quotes.read',
      'quotes.approve',
    ]);
    owner = await makeActor(db, app, `writeoff owner ${tag}`, [
      'groups.read',
      'groups.write',
      'quotes.read',
    ]);

    approverGroupId = await groupIdOf(approver.userId);
    quoteApproverGroupId = await groupIdOf(quoteApprover.userId);

    line = await liveLine(call);
  }, 60_000);

  afterAll(async () => {
    /* Leave the ceiling table as it was found: empty is another suite's assertion. */
    await purgeAuthorityLimits(db, approverGroupId);
    await purgeAuthorityLimits(db, quoteApproverGroupId);
    await app.close();
    await pool.end();
  });

  async function groupIdOf(userId: string): Promise<string> {
    const [row] = await db
      .select({ groupId: userGroups.groupId })
      .from(userGroups)
      .where(eq(userGroups.userId, userId));
    if (row === undefined) throw new Error('fixture actor has no group');
    return row.groupId;
  }

  const quote = async (who: string): Promise<OrderWire> =>
    submittedOrder(db, call, customer, line, {
      email: `writeoff-${who}-${tag}@probe.invalid`,
      name: `writeoff probe ${tag}`,
    });

  /** A live `cashflow` ceiling for the approver's role, granted through the real endpoint. */
  async function grantCashflowCeiling(groupId: string, thbMinor: string): Promise<void> {
    const granted = await call('PUT', '/quotes/authority/limits', {
      token: owner.token,
      body: { groupId, dimension: 'cashflow', maxConcessionThbMinor: thbMinor, noteTh: 'ทดสอบตัดยอด' },
    });
    if (granted.status !== 200) throw new Error(`ceiling grant failed: ${JSON.stringify(granted.body)}`);
  }

  /**
   * ⛔ Every figure in this suite comes from here, and Postgres computes all four.
   *
   * The point of the round is that `outstanding` changed and `settled` did not, so both are read
   * from their own functions rather than one being inferred from the other.
   */
  async function folds(orderId: string): Promise<{
    readonly grandTotal: bigint;
    readonly settled: bigint;
    readonly writtenOff: bigint;
    readonly outstanding: bigint;
    readonly nextDue: bigint;
  }> {
    const result = await db.execute(sql`
      select coalesce(o.grand_total_thb_minor, 0)::text            as grand_total,
             order_settled_thb_minor(o.id)::text                   as settled,
             order_written_off_thb_minor(o.id)::text                as written_off,
             coalesce(order_outstanding_thb_minor(o.id), 0)::text   as outstanding,
             order_next_due_thb_minor(o.id)::text                   as next_due
        from orders o where o.id = ${orderId}
    `);
    const rows = (result as unknown as { readonly rows?: readonly Record<string, string>[] }).rows
      ?? (result as unknown as readonly Record<string, string>[]);
    const row = rows[0];
    if (row === undefined) throw new Error('no order to fold');
    return {
      grandTotal: BigInt(row['grand_total'] ?? '0'),
      settled: BigInt(row['settled'] ?? '0'),
      writtenOff: BigInt(row['written_off'] ?? '0'),
      outstanding: BigInt(row['outstanding'] ?? '0'),
      nextDue: BigInt(row['next_due'] ?? '0'),
    };
  }

  /* ================================================================= *
   * ⓵ THE THIRD FOLD
   * ================================================================= */

  describe('⓵ the fold: outstanding = grand_total − settled − written_off', () => {
    it('⭐ an APPROVED write-off moves the outstanding and leaves `settled` untouched', async () => {
      /*
       * THE WHOLE ROUND, ASSERTED IN ONE TEST.
       *
       * ⚠️ `settled` is the assertion that matters as much as `outstanding`. Folding forgiveness
       * into `order_settled_thb_minor()` would have made both figures move together and every
       * expectation about the outstanding below would still pass — so the one that pins the design
       * is `after.settled === before.settled`. The day somebody "simplifies" the three-term fold
       * into two terms, that is the line that fails.
       */
      const order = await quote('fold');
      await grantCashflowCeiling(approverGroupId, '99999999');

      const before = await folds(order.id);
      expect(before.writtenOff).toBe(0n);
      expect(before.outstanding).toBe(before.grandTotal);

      const asked = await call('POST', `/orders/${order.id}/write-offs`, {
        token: clerk.token,
        body: { amountThbMinor: before.outstanding.toString(), reasonTh: 'ลูกค้าไม่ยอมชำระส่วนที่เหลือ' },
      });
      expect(asked.status).toBe(201);
      const requested = asked.body as { readonly id: string; readonly kind: string; readonly dimension: string };
      expect(requested.kind).toBe('write_off');
      expect(requested.dimension).toBe('cashflow');

      /* ⚠️ A PENDING write-off forgives nothing. The balance must not have moved yet. */
      const whilePending = await folds(order.id);
      expect(whilePending.writtenOff).toBe(0n);
      expect(whilePending.outstanding).toBe(before.outstanding);

      const decided = await call('POST', `/quotes/approvals/${requested.id}/decision`, {
        token: approver.token,
        body: { decision: 'approved' },
      });
      expect(decided.status).toBe(200);

      const after = await folds(order.id);
      expect(after.writtenOff).toBe(before.outstanding);
      expect(after.outstanding).toBe(0n);
      /* ⭐ The load-bearing one: money that never arrived is not money that arrived. */
      expect(after.settled).toBe(before.settled);
      expect(after.grandTotal).toBe(before.grandTotal);
    });

    it('⭐ next-due is capped by the outstanding, so no screen asks for more than the debt', async () => {
      /*
       * `order_next_due_thb_minor()` folds **per instalment** and 0042 never read the outstanding.
       * Left alone, a fully written-off order reported the deposit still due — ฿4,320.00
       * "งวดถัดไปต้องการ" under ฿0.00 ค้างชำระ — which is a defect whichever number the reader
       * believes. 0048 wraps the per-instalment answer in `least(…, outstanding)`.
       *
       * ⚠️ It is a cap and not an allocation: nothing in the data says which instalment a write-off
       * forgives, so the schedule's own rows are untouched and `order_settled_through()` still
       * reports the same production frontier. That is why this asserts the *cap* and not a
       * per-instalment figure.
       */
      const order = await quote('nextdue');
      await grantCashflowCeiling(approverGroupId, '99999999');

      const before = await folds(order.id);
      /* The fixture is a 30/70, so next-due starts strictly below the outstanding. */
      expect(before.nextDue).toBeGreaterThan(0n);

      const asked = await call('POST', `/orders/${order.id}/write-offs`, {
        token: clerk.token,
        body: { amountThbMinor: before.outstanding.toString(), reasonTh: 'ยกยอดทั้งหมด' },
      });
      const requested = asked.body as { readonly id: string };
      await call('POST', `/quotes/approvals/${requested.id}/decision`, {
        token: approver.token,
        body: { decision: 'approved' },
      });

      const after = await folds(order.id);
      expect(after.outstanding).toBe(0n);
      expect(after.nextDue).toBe(0n);
      /* Stated as the invariant rather than as a value, because that is the rule 0048 added. */
      expect(after.nextDue).toBeLessThanOrEqual(after.outstanding);
    });

    it('⭐ the order leaves the ค้างชำระ filter and stops stating a debt on GET /orders', async () => {
      /*
       * The reader the fold change is *for*. `?payment=outstanding` filters on
       * `order_outstanding_thb_minor(o.id) > 0` inside the same statement it sorts and selects by
       * (`scoped-order.ts`'s `OUTSTANDING_FOLD`), so a written-off order has to disappear from it —
       * and `writtenOffThbMinor` has to arrive on the row, or every screen has one number for two
       * facts and no way to tell "paid" from "forgiven".
       */
      const order = await quote('filter');
      await grantCashflowCeiling(approverGroupId, '99999999');
      const before = await folds(order.id);

      const owing = await call('GET', '/orders?payment=outstanding&limit=200', { token: clerk.token });
      expect(owing.status).toBe(200);
      const owingIds = (owing.body as { readonly orders: readonly { readonly id: string }[] }).orders.map(
        (row) => row.id,
      );
      expect(owingIds).toContain(order.id);

      const asked = await call('POST', `/orders/${order.id}/write-offs`, {
        token: clerk.token,
        body: { amountThbMinor: before.outstanding.toString(), reasonTh: 'ไม่คุ้มค่าติดตาม' },
      });
      await call('POST', `/quotes/approvals/${(asked.body as { readonly id: string }).id}/decision`, {
        token: approver.token,
        body: { decision: 'approved' },
      });

      const stillOwing = await call('GET', '/orders?payment=outstanding&limit=200', { token: clerk.token });
      const stillOwingIds = (
        stillOwing.body as { readonly orders: readonly { readonly id: string }[] }
      ).orders.map((row) => row.id);
      expect(stillOwingIds).not.toContain(order.id);

      const read = await call('GET', `/orders/${order.id}`, { token: clerk.token });
      const wire = read.body as {
        readonly outstandingThbMinor: { readonly digits: string } | null;
        readonly writtenOffThbMinor: { readonly digits: string } | null;
      };
      expect(wire.outstandingThbMinor?.digits).toBe('0');
      /* ⭐ Named on the wire, so ฿0.00-because-paid and ฿0.00-because-forgiven are distinguishable. */
      expect(wire.writtenOffThbMinor?.digits).toBe(before.outstanding.toString());
    });

    it('⓸ the customer’s payment screen reports the forgiven figure', async () => {
      /*
       * ⓸ IN THE ONE PLACE IT MATTERS MOST. `describePaymentPanel` (apps/web) reads
       * `writtenOffThbMinor` to say *"ยอดคงค้างส่วนที่เหลือได้รับการอนุมัติให้ตัดยอดแล้ว"* instead of
       * *"ออเดอร์นี้ชำระครบแล้ว"* — but only if the API sends it. This is the API half; the sentence
       * itself is pinned in `apps/web/src/components/payment/paymentPanel.test.ts`.
       */
      const order = await quote('panel');
      await grantCashflowCeiling(approverGroupId, '99999999');
      const before = await folds(order.id);

      const asked = await call('POST', `/orders/${order.id}/write-offs`, {
        token: clerk.token,
        body: { amountThbMinor: before.outstanding.toString(), reasonTh: 'ตกลงยุติเรื่อง' },
      });
      await call('POST', `/quotes/approvals/${(asked.body as { readonly id: string }).id}/decision`, {
        token: approver.token,
        body: { decision: 'approved' },
      });

      const instructions = await call('GET', `/orders/${order.id}/payment-instructions`, {
        token: customer.token,
      });
      expect(instructions.status).toBe(200);
      const wire = instructions.body as {
        readonly outstandingThbMinor: { readonly digits: string };
        readonly writtenOffThbMinor: { readonly digits: string };
      };
      expect(wire.outstandingThbMinor.digits).toBe('0');
      expect(wire.writtenOffThbMinor.digits).toBe(before.outstanding.toString());
    });
  });

  /* ================================================================= *
   * ⓶ THE GUARD, AT BOTH MOMENTS
   * ================================================================= */

  /* ================================================================= *
   * ⓵b THE SPINE — 0051
   * ================================================================= */

  /**
   * Reads `order_events` for one order, newest first.
   *
   * Raw SQL rather than the drizzle table so that a column rename in the schema shows up here as
   * a failure rather than as a silently-empty result — this helper's whole job is to prove a row
   * exists, and a reader that cannot fail is a reader that always agrees with you.
   */
  async function spine(orderId: string): Promise<readonly Record<string, unknown>[]> {
    const result = await db.execute(sql`
      select event_type, from_status, to_status, actor_kind, actor_user_id, payload
        from order_events where order_id = ${orderId} order by seq desc
    `);
    return (result as unknown as { readonly rows?: readonly Record<string, unknown>[] }).rows
      ?? (result as unknown as readonly Record<string, unknown>[]);
  }

  describe('⓵b the forgiven debt reaches the order timeline', () => {
    it('⭐ an APPROVED write-off appends `balance_written_off`, naming the decider and the amount', async () => {
      /*
       * WW-1044 is why this test exists. ฿9,886.80 was forgiven on a live order and its timeline
       * still ended at `installation_scheduled` from the day before — every other movement of
       * money leaves a row, and the one that makes a balance vanish left nothing. Somebody
       * reading that order later would find a total that no longer matches what was collected
       * and no row saying why.
       */
      const order = await quote('spine');
      await grantCashflowCeiling(approverGroupId, '99999999');
      const before = await folds(order.id);
      const beforeRows = await spine(order.id);

      const asked = await call('POST', `/orders/${order.id}/write-offs`, {
        token: clerk.token,
        body: {
          amountThbMinor: before.outstanding.toString(),
          reasonTh: 'ลูกค้าแจ้งว่าจะไม่ชำระส่วนที่เหลือ ตกลงยุติกันด้วยยอดมัดจำที่จ่ายมาแล้ว',
        },
      });
      expect(asked.status).toBe(201);
      const requested = asked.body as { readonly id: string };

      /* ⚠️ Asking forgives nothing and says nothing. The row belongs to the decision. */
      expect(await spine(order.id)).toHaveLength(beforeRows.length);

      const decided = await call('POST', `/quotes/approvals/${requested.id}/decision`, {
        token: approver.token,
        body: { decision: 'approved', noteTh: 'ตรวจกับยอดคงค้างแล้ว ยุติตามที่ตกลงกันทางโทรศัพท์' },
      });
      expect(decided.status).toBe(200);

      const rows = await spine(order.id);
      expect(rows).toHaveLength(beforeRows.length + 1);

      const row = rows[0];
      expect(row?.['event_type']).toBe('balance_written_off');
      /* No status moved: the work is still to be delivered, only the debt is gone. */
      expect(row?.['from_status']).toBeNull();
      expect(row?.['to_status']).toBeNull();
      /*
       * ⭐ The decider, not the requester. Four-eyes means these are two different people, and a
       * timeline that named the person who *asked* would credit the wrong one with the decision.
       */
      expect(row?.['actor_kind']).toBe('staff');
      expect(row?.['actor_user_id']).toBe(approver.userId);

      const payload = row?.['payload'] as Record<string, unknown>;
      expect(payload['written_off_thb_minor']).toBe(before.outstanding.toString());
      expect(payload['reason']).toContain('ตกลงยุติกัน');
      expect(payload['note_th']).toContain('ยุติตามที่ตกลงกันทางโทรศัพท์');
    });

    it('⚠️ a REFUSED write-off appends nothing — no money moved', async () => {
      const order = await quote('spine-no');
      await grantCashflowCeiling(approverGroupId, '99999999');
      const before = await spine(order.id);

      const asked = await call('POST', `/orders/${order.id}/write-offs`, {
        token: clerk.token,
        body: { amountThbMinor: '100000', reasonTh: 'ขอตัดยอดเพราะลูกค้าต่อรอง' },
      });
      const requested = asked.body as { readonly id: string };

      const decided = await call('POST', `/quotes/approvals/${requested.id}/decision`, {
        token: approver.token,
        body: { decision: 'rejected', noteTh: 'ยังเก็บได้ ให้ตามต่อ' },
      });
      expect(decided.status).toBe(200);

      expect(await spine(order.id)).toHaveLength(before.length);
    });

    it('⭐ THE DATABASE refuses the row without an amount, and refuses a customer as its actor', async () => {
      /*
       * The service always supplies both, so these go through raw SQL: the guard exists for the
       * day a second caller appears, and a guard nothing tests is a comment.
       *
       * ⚠️ Each refusal is paired with an insert that must SUCCEED, and that pairing is the whole
       * design of this test. The driver wraps Postgres's message as "Failed query: …", so a bare
       * `.rejects.toThrow()` cannot tell *which* rule refused — it would pass just as happily if
       * the column list were wrong and every insert here failed. The row that goes in proves the
       * statement is otherwise sound, so the row that bounces bounced on the guard.
       */
      const order = await quote('spine-guard');
      const insert = (actorKind: string, actorId: string, payload: string) =>
        db.execute(sql`
          insert into order_events (order_id, event_type, actor_kind, actor_user_id, payload)
          values (${order.id}, 'balance_written_off', ${actorKind}, ${actorId}, ${payload}::jsonb)
        `);

      /* No amount: a row saying a debt was forgiven without saying how much looks complete. */
      await expect(insert('staff', approver.userId, '{}')).rejects.toThrow();

      /* A customer cannot forgive their own debt, whatever the payload says. */
      await expect(
        insert('customer', clerk.userId, '{"written_off_thb_minor":"100"}'),
      ).rejects.toThrow();

      /* The control: same statement, both rules satisfied. */
      await expect(
        insert('staff', approver.userId, '{"written_off_thb_minor":"100"}'),
      ).resolves.toBeDefined();
    });
  });

  describe('⓶ a concession larger than the balance owed', () => {
    it('⭐ refuses the ASK when the amount is above the outstanding', async () => {
      const order = await quote('overask');
      const before = await folds(order.id);

      const asked = await call('POST', `/orders/${order.id}/write-offs`, {
        token: clerk.token,
        body: {
          amountThbMinor: (before.outstanding + 1n).toString(),
          reasonTh: 'มากกว่ายอดคงค้างหนึ่งสตางค์',
        },
      });

      expect(asked.status).toBe(409);
      /* And nothing was written: a refused ask is not a queue item somebody has to clear. */
      const rows = await db.select({ id: approvals.id }).from(approvals).where(eq(approvals.orderId, order.id));
      expect(rows).toHaveLength(0);
    });

    it('accepts the ask for exactly the whole balance — the commonest write-off there is', async () => {
      /*
       * The boundary, in the direction it has to fail. A `>=` anywhere in this chain would refuse
       * the customer-will-not-pay-anything case, which is the requirement's central example.
       */
      const order = await quote('exact');
      const before = await folds(order.id);

      const asked = await call('POST', `/orders/${order.id}/write-offs`, {
        token: clerk.token,
        body: { amountThbMinor: before.outstanding.toString(), reasonTh: 'ทั้งยอด' },
      });

      expect(asked.status).toBe(201);
    });

    it('⭐ THE DATABASE refuses an over-write-off written by something other than this service', async () => {
      /*
       * ⚠️ THE REASON THE GUARD IS IN POSTGRES AT ALL. The service is not the only writer — `db:seed`,
       * a psql session, a future worker — so this test bypasses the service entirely and inserts the
       * row itself. `approvals_write_off_within_balance` is what refuses it.
       *
       * ⚠️ `kind` is what the trigger keys on, so this is also the assertion that a `write_off` row
       * is bounded where a `quote_concession` row deliberately is not: a legitimate discount on a
       * quote whose deposit has already been paid may exceed what is still outstanding, and bounding
       * *that* would refuse ordinary quote approvals.
       */
      const order = await quote('trigger');
      const before = await folds(order.id);

      await expect(
        db.insert(approvals).values({
          orderId: order.id,
          dimension: 'cashflow',
          kind: 'write_off',
          concessionThbMinor: before.outstanding + 100_000n,
          reasonTh: 'เขียนตรงเข้าตาราง',
          requestedByUserId: clerk.userId,
          quoteRevision: '0123456789abcdef',
        }),
      ).rejects.toThrow();
    });

    it('⭐ refuses the YES when the customer has paid since the request was raised', async () => {
      /*
       * ⚠️ THE MOMENT THAT IS EASY TO LEAVE OUT. Both checks are needed and neither implies the
       * other: the ask was valid when it was made, and the balance moved underneath it.
       *
       * The balance is moved here by a **second, smaller write-off approved first** rather than by a
       * slip, deliberately — a slip needs a review path this suite does not own, and what is under
       * test is the arithmetic of the fold, which cannot tell the two apart. `order_written_off` and
       * `order_settled` are both terms of one subtraction.
       *
       * ⚠️ And the answer is a REFUSAL, not a silent reduction to what is left. See
       * `AuthorityService.decide`: `approvals.concession_thb_minor` is frozen while pending, so
       * approving a smaller figure would either defeat that guard or record a decision nobody made.
       */
      const order = await quote('moved');
      await grantCashflowCeiling(approverGroupId, '99999999');
      const before = await folds(order.id);

      /* Ask for the whole balance. Valid right now. */
      const whole = await call('POST', `/orders/${order.id}/write-offs`, {
        token: clerk.token,
        body: { amountThbMinor: before.outstanding.toString(), reasonTh: 'ขอทั้งยอด' },
      });
      expect(whole.status).toBe(201);
      const pendingId = (whole.body as { readonly id: string }).id;

      /*
       * The balance falls: a partial write-off, born approved, inserted directly because the HTTP
       * route would be refused by `approvals_one_open_per_order_dimension` while the row above is
       * pending — which is itself the correct behaviour and is asserted in its own test below.
       */
      await db.insert(approvals).values({
        orderId: order.id,
        dimension: 'cashflow',
        kind: 'write_off',
        status: 'approved',
        concessionThbMinor: 100_000n,
        reasonTh: 'ตัดบางส่วนไปก่อน',
        requestedByUserId: clerk.userId,
        decidedByUserId: approver.userId,
        decidedAt: new Date(),
        decidedCeilingThbMinor: 99_999_999n,
        quoteRevision: '0123456789abcdef',
      });

      const moved = await folds(order.id);
      expect(moved.outstanding).toBe(before.outstanding - 100_000n);

      /* ⭐ The approval that was valid on Monday. */
      const decided = await call('POST', `/quotes/approvals/${pendingId}/decision`, {
        token: approver.token,
        body: { decision: 'approved' },
      });
      expect(decided.status).toBe(409);

      /* Nothing was forgiven by the refusal, and the balance is exactly where it was. */
      const after = await folds(order.id);
      expect(after.outstanding).toBe(moved.outstanding);
      expect(after.outstanding).toBeGreaterThan(0n);

      /*
       * ⚠️ And REJECTING it is still available, which is the whole reason the refusal is acceptable:
       * the request would otherwise sit in the order's cashflow slot for ever.
       */
      const rejected = await call('POST', `/quotes/approvals/${pendingId}/decision`, {
        token: approver.token,
        body: { decision: 'rejected', noteTh: 'ยอดคงค้างลดลงแล้ว ให้ยื่นใหม่ตามยอดปัจจุบัน' },
      });
      expect(rejected.status).toBe(200);
    });

    it('⭐ the reported rights say `above_balance` before the button is pressed', async () => {
      /*
       * The queue and the detail read must not offer a decision the endpoint refuses — that is the
       * one property `approval-rights.ts` exists to have. So the same movement as the test above,
       * observed through `GET /quotes/approvals/:id`.
       */
      const order = await quote('rights');
      await grantCashflowCeiling(approverGroupId, '99999999');
      const before = await folds(order.id);

      const whole = await call('POST', `/orders/${order.id}/write-offs`, {
        token: clerk.token,
        body: { amountThbMinor: before.outstanding.toString(), reasonTh: 'ขอทั้งยอด' },
      });
      const pendingId = (whole.body as { readonly id: string }).id;

      const fresh = await call('GET', `/quotes/approvals/${pendingId}`, { token: approver.token });
      const freshWire = fresh.body as {
        readonly rights: { readonly mayApprove: boolean; readonly because: string };
        readonly writeOff: { readonly outstandingThbMinor: string; readonly stillCovered: boolean } | null;
      };
      expect(freshWire.rights.mayApprove).toBe(true);
      /* ⭐ The write-off's own warning block — present exactly because this row is a write-off. */
      expect(freshWire.writeOff?.stillCovered).toBe(true);
      expect(freshWire.writeOff?.outstandingThbMinor).toBe(before.outstanding.toString());

      await db.insert(approvals).values({
        orderId: order.id,
        dimension: 'cashflow',
        kind: 'write_off',
        status: 'approved',
        concessionThbMinor: 100_000n,
        reasonTh: 'ตัดบางส่วนไปก่อน',
        requestedByUserId: clerk.userId,
        decidedByUserId: approver.userId,
        decidedAt: new Date(),
        decidedCeilingThbMinor: 99_999_999n,
        quoteRevision: '0123456789abcdef',
      });

      const stale = await call('GET', `/quotes/approvals/${pendingId}`, { token: approver.token });
      const staleWire = stale.body as {
        readonly rights: { readonly mayApprove: boolean; readonly mayRefuse: boolean; readonly because: string };
        readonly writeOff: { readonly stillCovered: boolean } | null;
      };
      expect(staleWire.rights.mayApprove).toBe(false);
      expect(staleWire.rights.because).toBe('above_balance');
      /* Refusing stays open — the screen must offer the one button that still works. */
      expect(staleWire.rights.mayRefuse).toBe(true);
      expect(staleWire.writeOff?.stillCovered).toBe(false);
    });
  });

  /* ================================================================= *
   * ⓷ THE PERMISSION, AND THE CEILING BESIDE IT
   * ================================================================= */

  describe('⓷ who may decide one', () => {
    it('⭐ refuses a caller who holds `quotes.approve` and not `payments.write_off`', async () => {
      /*
       * THE SPLIT THIS ROUND ADDED. `quoteApprover` may decide any quote concession in the company
       * and may not forgive a single satang of debt. The refusal is 403 and it comes from the
       * **service**, not the guard — the guard runs before the row is read and cannot know which
       * kind it is, which is why `POST /quotes/approvals/:id/decision` still declares
       * `quotes.approve` alone.
       *
       * ⚠️ A ceiling is granted to this role first, so what refuses is unambiguously the permission
       * and not fail-closed authority.
       */
      const order = await quote('perm');
      await grantCashflowCeiling(quoteApproverGroupId, '99999999');
      const before = await folds(order.id);

      const asked = await call('POST', `/orders/${order.id}/write-offs`, {
        token: clerk.token,
        body: { amountThbMinor: before.outstanding.toString(), reasonTh: 'ทดสอบสิทธิ์' },
      });
      const approvalId = (asked.body as { readonly id: string }).id;

      const refused = await call('POST', `/quotes/approvals/${approvalId}/decision`, {
        token: quoteApprover.token,
        body: { decision: 'approved' },
      });
      expect(refused.status).toBe(403);

      /* Nothing forgiven. */
      expect((await folds(order.id)).writtenOff).toBe(0n);

      /*
       * ⚠️ And the same caller may not REFUSE it either — `mayRefuse: false`, which is the one place
       * this module's "saying no needs no authority" rule does not apply. A quote approver rejecting
       * somebody's write-off request would answer it with no standing to.
       */
      const rejected = await call('POST', `/quotes/approvals/${approvalId}/decision`, {
        token: quoteApprover.token,
        body: { decision: 'rejected', noteTh: 'ไม่เกี่ยวกับฉัน' },
      });
      expect(rejected.status).toBe(403);

      const reported = await call('GET', `/quotes/approvals/${approvalId}`, { token: quoteApprover.token });
      const wire = reported.body as {
        readonly rights: { readonly mayApprove: boolean; readonly mayRefuse: boolean; readonly because: string };
      };
      expect(wire.rights.because).toBe('not_a_write_off_approver');
      expect(wire.rights.mayApprove).toBe(false);
      expect(wire.rights.mayRefuse).toBe(false);
    });

    it('⚠️ a holder of both codes with NO live cashflow ceiling still cannot approve', async () => {
      /*
       * Fail-closed, and the permission does not replace the ceiling. `purgeAuthorityLimits` empties
       * the role's rows first so this is a claim about an empty table rather than about a big number.
       */
      const order = await quote('noceiling');
      await purgeAuthorityLimits(db, approverGroupId);
      const before = await folds(order.id);

      const asked = await call('POST', `/orders/${order.id}/write-offs`, {
        token: clerk.token,
        body: { amountThbMinor: before.outstanding.toString(), reasonTh: 'ทดสอบเพดาน' },
      });
      const approvalId = (asked.body as { readonly id: string }).id;

      const refused = await call('POST', `/quotes/approvals/${approvalId}/decision`, {
        token: approver.token,
        body: { decision: 'approved' },
      });
      expect(refused.status).toBe(403);
      expect((await folds(order.id)).writtenOff).toBe(0n);
    });

    it('⭐ the four-eyes rule: the person who asked cannot be the person who agrees', async () => {
      /*
       * `approvals_decider_is_not_requester`, reached through the write-off path. `approver` holds
       * every code needed to ask **and** to decide in this fixture precisely so that what refuses is
       * the two-person rule rather than a missing permission.
       */
      const order = await quote('foureyes');
      await grantCashflowCeiling(approverGroupId, '99999999');
      const before = await folds(order.id);

      const asked = await call('POST', `/orders/${order.id}/write-offs`, {
        token: approver.token,
        body: { amountThbMinor: before.outstanding.toString(), reasonTh: 'ขอเองอนุมัติเอง' },
      });
      expect(asked.status).toBe(201);

      const refused = await call('POST', `/quotes/approvals/${(asked.body as { readonly id: string }).id}/decision`, {
        token: approver.token,
        body: { decision: 'approved' },
      });
      expect(refused.status).toBe(409);
      expect((await folds(order.id)).writtenOff).toBe(0n);
    });

    it('refuses the ask from a customer, whatever they send', async () => {
      /*
       * The route is under `/orders` and states `orders.write` + `payments.read` for this reason: a
       * `principal` policy here would let any signed-in customer ask the company to forgive their
       * own debt.
       */
      const order = await quote('customer');

      const asked = await call('POST', `/orders/${order.id}/write-offs`, {
        token: customer.token,
        body: { amountThbMinor: '100', reasonTh: 'ขอลดหนี้ตัวเอง' },
      });

      expect(asked.status).toBe(403);
    });
  });

  /* ================================================================= *
   * The mechanism `cashflow` already had, and must not be confused with
   * ================================================================= */

  describe('⚠️ a write-off is not a quote concession, though both are `cashflow`', () => {
    it('⭐ an approved write-off does NOT cover a quote-time cashflow concession', async () => {
      /*
       * ⚠️ THE DEFECT THE `kind` COLUMN EXISTS TO PREVENT, ASSERTED FROM THE OTHER SIDE.
       *
       * `AuthorityService.judge` finds a `covering` approval by dimension, status, revision and
       * figure. Without `kind === 'quote_concession'` in that predicate an approved write-off would
       * *cover* a `gate_below_floor` concession on the same order — a deposit schedule passing the
       * submit gate on the authority of a decision about an unrelated debt. Nobody would have
       * approved that; the two mechanisms simply share a column.
       *
       * ── ⚠️ THE FIXTURE HAS TO CONCEDE CASHFLOW, OR THIS TEST PROVES NOTHING ────
       *
       * A first version of this test asserted `cashflow.approvalId === null` on an ordinary order,
       * and a mutation run caught it passing with the `kind` term **deleted**: an order submitted at
       * the company's own deposit policy concedes ฿0.00 of cashflow, so `judge` returns
       * `nothing_conceded` and never reaches the `covering` search at all. The id was null for a
       * reason that had nothing to do with the rule under test.
       *
       * So this fixture is given a schedule that really does gate less than the floor. The order
       * ships pay-in-full — one instalment, `gates_entry_to = 'production_confirmed'`, and
       * `deposit_floor_bp` pinned at 10 000 — so `cashflowConcessionMinor` is
       * `floor − gated = grandTotal − grandTotal = 0`, and **no value of the floor can change that**:
       * nothing can be above payment in full. What has to move is the *gated prefix*, so the gate is
       * cleared from the instalment and the concession becomes the whole total — the extreme of plan
       * 7.10's "the company extending credit", which is precisely the state `cashflow` exists for and
       * which no route can author yet (`authority.service.ts` note 2 says so).
       *
       * The write-off is for the whole balance, so it is comfortably ≥ that figure, and the revision
       * matches (`WriteOffService` stamps the order's current digest) — exactly the shape `covering`
       * would match on.
       */
      const order = await quote('kinds');
      await grantCashflowCeiling(approverGroupId, '99999999');
      const before = await folds(order.id);

      await db.execute(sql`update orders set deposit_floor_bp = 10000 where id = ${order.id}`);
      await db.execute(
        sql`update order_instalments set gates_entry_to = null where order_id = ${order.id}`,
      );

      /* The concession is real now — assert it, so a fixture that stops working is visible here. */
      const conceding = await call('GET', `/quotes/authority/orders/${order.id}`, {
        token: clerk.token,
      });
      const conceded = conceding.body as {
        readonly cashflow: { readonly concessionThbMinor: string; readonly outcome: string };
      };
      expect(BigInt(conceded.cashflow.concessionThbMinor)).toBeGreaterThan(0n);
      expect(conceded.cashflow.outcome).toBe('needs_approval');

      const asked = await call('POST', `/orders/${order.id}/write-offs`, {
        token: clerk.token,
        body: { amountThbMinor: before.outstanding.toString(), reasonTh: 'ตัดยอดทิ้ง' },
      });
      expect(asked.status).toBe(201);
      const decided = await call(
        'POST',
        `/quotes/approvals/${(asked.body as { readonly id: string }).id}/decision`,
        { token: approver.token, body: { decision: 'approved' } },
      );
      expect(decided.status).toBe(200);

      /*
       * ⭐ The assertion. `cashflow.approvalId` is the id `judge` matched, and `outcome` is what it
       * concluded. Both must be untouched by the write-off: the quote still needs an approval it has
       * never been given.
       */
      const assessed = await call('GET', `/quotes/authority/orders/${order.id}`, {
        token: clerk.token,
      });
      expect(assessed.status).toBe(200);
      const wire = assessed.body as {
        readonly cashflow: { readonly approvalId: string | null; readonly outcome: string };
      };
      expect(wire.cashflow.outcome).toBe('needs_approval');
      expect(wire.cashflow.approvalId).toBeNull();
      expect(wire.cashflow.outcome).not.toBe('covered_by_approval');
    });

    it('one open cashflow question per order — the write-off holds the slot until it is answered', async () => {
      /*
       * `approvals_one_open_per_order_dimension` is `(order_id, dimension) WHERE status = 'pending'`
       * and knows nothing about `kind`, so a pending write-off really does occupy this order's
       * cashflow slot. Refused with a Thai sentence rather than a 23505, and the message names which
       * of the two mechanisms is in the way — see `WriteOffService.request`.
       */
      const order = await quote('slot');
      const before = await folds(order.id);

      const first = await call('POST', `/orders/${order.id}/write-offs`, {
        token: clerk.token,
        body: { amountThbMinor: '100', reasonTh: 'คำขอแรก' },
      });
      expect(first.status).toBe(201);

      const second = await call('POST', `/orders/${order.id}/write-offs`, {
        token: clerk.token,
        body: { amountThbMinor: (before.outstanding - 100n).toString(), reasonTh: 'คำขอที่สอง' },
      });
      expect(second.status).toBe(409);
    });

    it('refuses a write-off on an order with no contract, and on one that owes nothing', async () => {
      /*
       * A cart's `grand_total_thb_minor` is NULL and the fold coalesces it to ฿0.00, so without the
       * first refusal the caller would read "มากกว่ายอดคงค้าง ฿0.00" about an order that has no
       * balance to speak of at all. Two states, two sentences, both 409.
       */
      const created = await call('POST', '/orders', { token: customer.token, body: {} });
      const cart = created.body as OrderWire;

      const onCart = await call('POST', `/orders/${cart.id}/write-offs`, {
        token: clerk.token,
        body: { amountThbMinor: '100', reasonTh: 'ตะกร้า' },
      });
      expect(onCart.status).toBe(409);

      /* And an order whose balance is already fully forgiven owes nothing to forgive again. */
      const order = await quote('twice');
      await grantCashflowCeiling(approverGroupId, '99999999');
      const before = await folds(order.id);

      const asked = await call('POST', `/orders/${order.id}/write-offs`, {
        token: clerk.token,
        body: { amountThbMinor: before.outstanding.toString(), reasonTh: 'ครั้งแรก' },
      });
      await call('POST', `/quotes/approvals/${(asked.body as { readonly id: string }).id}/decision`, {
        token: approver.token,
        body: { decision: 'approved' },
      });

      const again = await call('POST', `/orders/${order.id}/write-offs`, {
        token: clerk.token,
        body: { amountThbMinor: '100', reasonTh: 'ครั้งที่สอง' },
      });
      expect(again.status).toBe(409);
    });

    it('refuses a zero amount at the schema, not with a CHECK violation from Postgres', async () => {
      /*
       * `approvals_concession_positive` would refuse this too — as a 23514, which reaches a client as
       * a 500 with a `DrizzleQueryError` in it. `requestWriteOffSchema` refuses it first, so the
       * caller gets `ZodBodyPipe`'s 400 and a field name. Both layers hold; only one is readable.
       */
      const order = await quote('zero');

      const asked = await call('POST', `/orders/${order.id}/write-offs`, {
        token: clerk.token,
        body: { amountThbMinor: '0', reasonTh: 'ศูนย์' },
      });

      expect(asked.status).toBe(400);
    });

    it('⭐ refuses a write-off on a CANCELLED order, and the database refuses it too', async () => {
      /*
       * ⭐ THE PRECONDITION 0048 LEFT OUT. `order_outstanding_thb_minor()` answers about an order in
       * any status — deliberately, because a refund is priced from exactly that number — so a
       * cancelled order that never paid folds to its **whole grand total** and passed every test the
       * ask made: there is a contract, the outstanding is positive, the amount is within it. What it
       * would have recorded is a forgiveness of a debt the cancellation already disposed of through
       * `forfeit_policy_rules` and the refund module, paid for out of the approver's cashflow
       * ceiling, on an order whose wire states no money at all (`encodeOrderSummary` nulls all four
       * fields on a non-live order) — so nobody would ever have seen the figure.
       *
       * ⚠️ Asserted at **both** layers in one test, because they are two different claims:
       *
       *   the 409       `WriteOffService.request` reading `isLiveOrder` — a sentence staff can act on
       *   the throw     `approvals_write_off_order_is_live` (0049) against a writer that is not the
       *                 service at all, which is the only reason the rule is in Postgres
       *
       * ⚠️ And the balance is asserted to be positive *after* the cancellation, so this test cannot
       * pass for the wrong reason: if the fold ever started answering ฿0.00 on a cancelled order the
       * refusal would come from "ไม่มียอดคงค้าง" instead and prove nothing about the status rule.
       */
      const order = await quote('cancelled');

      const cancelled = await call('POST', `/orders/${order.id}/transitions/cancelled`, {
        token: customer.token,
        body: { reason: 'เปลี่ยนใจ ยังไม่พร้อมติดตั้ง' },
      });
      expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);

      const after = await folds(order.id);
      expect(after.outstanding).toBeGreaterThan(0n);

      const asked = await call('POST', `/orders/${order.id}/write-offs`, {
        token: clerk.token,
        body: { amountThbMinor: after.outstanding.toString(), reasonTh: 'ออเดอร์ที่ยกเลิกแล้ว' },
      });
      expect(asked.status, JSON.stringify(asked.body)).toBe(409);

      /* Nothing was written: a refused ask is not a queue item somebody has to clear. */
      const rows = await db.select({ id: approvals.id }).from(approvals).where(eq(approvals.orderId, order.id));
      expect(rows).toHaveLength(0);

      /* ⭐ And the same row written straight into the table, bypassing the service entirely. */
      await expect(
        db.insert(approvals).values({
          orderId: order.id,
          dimension: 'cashflow',
          kind: 'write_off',
          concessionThbMinor: 100_000n,
          reasonTh: 'เขียนตรงเข้าตารางบนออเดอร์ที่ยกเลิก',
          requestedByUserId: clerk.userId,
          quoteRevision: '0123456789abcdef',
        }),
      ).rejects.toThrow();

      /* ⚠️ A quote concession on the same cancelled order is still perfectly legal. */
      await expect(
        db.insert(approvals).values({
          orderId: order.id,
          dimension: 'margin',
          kind: 'quote_concession',
          concessionThbMinor: 100_000n,
          reasonTh: 'ส่วนลดที่บันทึกไว้ตามปกติ',
          requestedByUserId: clerk.userId,
          quoteRevision: '0123456789abcdef',
        }),
      ).resolves.toBeDefined();
    });

    it('⭐ refuses the YES when the order was cancelled after the request was raised', async () => {
      /*
       * ⚠️ THE OTHER MOMENT, and it needs its own test for the same reason 0048's balance guard does:
       * the ask was honest on Monday and the *order* moved underneath it. A pending write-off does
       * not stop anybody cancelling, so this is reachable by two ordinary acts in the wrong order.
       *
       * The refusal is `AuthorityService.decide`'s, so the approver reads a Thai sentence rather than
       * the trigger's `check_violation` — and the trigger behind it is what makes the refusal true
       * against a writer that is not the service.
       *
       * ⚠️ REJECTING it stays available, which is why refusing to approve is acceptable at all: the
       * pending row holds this order's one cashflow slot until somebody answers it.
       */
      const order = await quote('cancelledlater');
      await grantCashflowCeiling(approverGroupId, '99999999');
      const before = await folds(order.id);

      const asked = await call('POST', `/orders/${order.id}/write-offs`, {
        token: clerk.token,
        body: { amountThbMinor: before.outstanding.toString(), reasonTh: 'ขอตัดยอดตอนที่ยังไม่ยกเลิก' },
      });
      expect(asked.status).toBe(201);
      const approvalId = (asked.body as { readonly id: string }).id;

      const cancelled = await call('POST', `/orders/${order.id}/transitions/cancelled`, {
        token: customer.token,
        body: { reason: 'ยกเลิกหลังยื่นคำขอแล้ว' },
      });
      expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);

      const refused = await call('POST', `/quotes/approvals/${approvalId}/decision`, {
        token: approver.token,
        body: { decision: 'approved' },
      });
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);

      /* Nothing forgiven — the fold has not moved. */
      expect((await folds(order.id)).writtenOff).toBe(0n);

      const rejected = await call('POST', `/quotes/approvals/${approvalId}/decision`, {
        token: approver.token,
        body: { decision: 'rejected', noteTh: 'ออเดอร์ถูกยกเลิกแล้ว ไม่ต้องตัดยอด' },
      });
      expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    });

    it('⚠️ `kind` cannot be edited while the request is pending', async () => {
      /*
       * `approvals_guard_write()` froze four columns and 0048 makes it five. Turning a pending
       * `quote_concession` into a `write_off` under an approver who had already read the reason would
       * convert an agreed discount into a forgiven debt at the same figure, with the same four-eyes
       * row to show for it.
       */
      const order = await quote('frozen');

      const asked = await call('POST', `/orders/${order.id}/write-offs`, {
        token: clerk.token,
        body: { amountThbMinor: '100', reasonTh: 'ตรึงคอลัมน์' },
      });
      const approvalId = (asked.body as { readonly id: string }).id;

      await expect(
        db.execute(sql`update approvals set kind = 'quote_concession' where id = ${approvalId}`),
      ).rejects.toThrow();
    });
  });
});
