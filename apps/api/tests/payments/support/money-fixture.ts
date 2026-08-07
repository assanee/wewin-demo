import { randomUUID } from 'node:crypto';

import type { Database } from '@wewin/db/client';
import { sql } from '@wewin/db/sql';

/**
 * An order that actually holds money, built the way the schema insists it be built.
 *
 * ── Why this file exists, and what it is evidence of ─────────────────────────────
 *
 * The refunds module starts from *"money is held on a cancelled order"*. Producing that state
 * needs a schedule, an instalment, a slip, an allocation and a ledger entry — and three of
 * those five belong to modules being written by other agents in this same round. Reaching for
 * their HTTP routes would make this suite fail whenever theirs is mid-edit and would prove
 * nothing about refunds; stubbing the balances would prove nothing at all, because every
 * number this module refuses on comes out of a SQL fold over real rows.
 *
 * So the fixture writes the rows directly, and every statement below is the shape the schema
 * forces rather than a convenience:
 *
 *   * the allocation and the acceptance are one transaction, because `assert_slip_allocations`
 *     refuses allocations on a non-accepted slip *and* refuses an accepted slip whose
 *     allocations do not sum to it — the two are only simultaneously satisfiable at COMMIT;
 *   * the instalment foots to `orders.grand_total_thb_minor` exactly, because
 *     `assert_order_schedule` says so;
 *   * the cancellation closes the schedule **in the same transaction**, because that same
 *     assertion refuses a terminal order whose schedule is still open.
 *
 * ── ⚠️ That last one is a cross-module finding, not a fixture detail ─────────────
 *
 * `cancelWithScheduleClosed` exists because `POST /orders/:id/transitions/cancelled` **cannot**
 * cancel an order that has a payment schedule: 5a's handler knows nothing about
 * `order_payment_schedules`, the assertion fires at COMMIT, and the request is a 409. The
 * suite pins that as a test rather than working around it silently — see
 * `refunds.pg.test.ts`, "the cancellation path has to close the schedule".
 */

export interface HeldMoneyOptions {
  readonly orderId: string;
  readonly grandTotalThbMinor: bigint;
  /** What arrived. Less than the total is a deposit; equal is payment in full. */
  readonly paidThbMinor: bigint;
  /**
   * Null models a slip whose payer was never recorded — the columns are nullable, and PDPA
   * erasure is allowed to clear them. It is the state in which there is no account to refund to,
   * which is the state the "fails closed" path is about.
   */
  readonly payerName: string | null;
  readonly payerAccountLast4: string | null;
  readonly reviewerUserId: string;
  /**
   * When the reviewer accepted it. Defaults to `now()`.
   *
   * ⚠️ Set **here** or not at all. `payment_slips_guard_write()` freezes `reviewed_at` the
   * moment a slip leaves `submitted` — "slip % was reviewed at % and is frozen" — so a test
   * that wants an acceptance in a particular month cannot back-date one afterwards, and
   * should not be able to: a reviewed slip is evidence, and evidence whose date can be moved
   * is not evidence. `overview.pg.test.ts` needs one on either side of a month boundary.
   */
  readonly reviewedAt?: Date;
  /** `false` puts the money in `remittance_in_transit` — plan 7.11's cross-border wire. */
  readonly landed?: boolean;
  /**
   * What the bank actually credited, when it is not what the slip says. Defaults to the slip.
   *
   * The slip is what the customer transferred and is what the allocation settles; this is what
   * arrived. They differ by a bank fee, and the difference is `settlement_variance`'s whole
   * reason for existing — see the "three numbers" test in `ledger.pg.test.ts`.
   */
  readonly cashThbMinor?: bigint;
}

export interface HeldMoney {
  readonly slipId: string;
  readonly instalmentId: string;
  readonly ledgerEntryId: string;
}

/**
 * A schedule of one `remainder` instalment gating `production_confirmed`, one accepted slip,
 * one allocation, and the ledger entry that records the money arriving.
 *
 * One instalment and not two on purpose: plan 7.5(ก)'s point is that no-deposit, 30/70 and
 * payment-in-full are the same code path, and the refund module's arithmetic is about
 * `deposit_held` and the *pinned* `scheduled_deposit_thb_minor`, neither of which changes shape
 * with the number of rows. The 30/70 case is the instalments module's to exercise.
 */
export async function giveOrderHeldMoney(
  db: Database,
  options: HeldMoneyOptions,
): Promise<HeldMoney> {
  const slipId = randomUUID();
  let instalmentId: string = randomUUID();
  const entryId = randomUUID();
  const landed = options.landed ?? true;
  const cashAccount = landed ? 'bank_thb' : 'remittance_in_transit';

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      insert into order_payment_schedules (order_id) values (${options.orderId}::uuid)
      on conflict (order_id) do nothing
    `);

    /*
     * ⚠️ THE SUBMIT NOW WRITES THIS ROW, AND THAT IS THE CLOSING ROUND'S LARGEST FIX.
     *
     * This fixture used to INSERT the instalment unconditionally, and it worked because
     * `OrdersService.submit` created no schedule at all — which is the same reason no slip could
     * ever be accepted through the running application and the freeze gate was vacuous. Now the
     * submit calls `PaymentLifecycleService`, so the row exists, and inserting a second one
     * collides on `order_instalments_order_seq_key`.
     *
     * Adopting the real one rather than deleting and replacing it is deliberate: the fixture's
     * job is to put money on an order, not to have an opinion about the schedule, and a fixture
     * that overwrote the production schedule would go on passing on the day the production
     * schedule became wrong.
     */
    const existing = await tx.execute(sql`
      select id::text as id from order_instalments
       where order_id = ${options.orderId}::uuid order by seq asc limit 1
    `);

    const existingRows = (existing as { rows?: unknown }).rows;
    const existingRow = Array.isArray(existingRows)
      ? (existingRows[0] as Record<string, unknown> | undefined)
      : undefined;
    const existingId = existingRow?.['id'];

    if (typeof existingId === 'string') {
      instalmentId = existingId;
    } else {
      await tx.execute(sql`
        insert into order_instalments (id, order_id, seq, basis, due_thb_minor, gates_entry_to)
        values (${instalmentId}::uuid, ${options.orderId}::uuid, 1, 'remainder',
                ${options.grandTotalThbMinor.toString()}::bigint, 'production_confirmed')
      `);
    }

    await tx.execute(sql`
      insert into payment_slips
        (id, order_id, status, amount_thb_minor, transferred_at, payer_name, payer_account_last4)
      values (${slipId}::uuid, ${options.orderId}::uuid, 'submitted',
              ${options.paidThbMinor.toString()}::bigint, now(),
              ${options.payerName}, ${options.payerAccountLast4})
    `);

    /*
     * Allocation first, then acceptance — the order is irrelevant because both assertions are
     * deferred, and writing it this way says out loud that neither row is legal on its own.
     */
    await tx.execute(sql`
      insert into slip_allocations (slip_id, instalment_id, amount_thb_minor)
      values (${slipId}::uuid, ${instalmentId}::uuid, ${options.paidThbMinor.toString()}::bigint)
    `);

    /*
     * The reviewer attests the payer in the same statement that accepts the slip — which is the
     * only statement `payment_slips_guard_write()` allows it in, and the reason is 5b red-team
     * RT-2: `payer_name` / `payer_account_last4` arrive on the *customer's* create-slip body, so
     * until somebody has read them off the image they are a field the payer typed.
     * `RefundsRepository.acceptedPayers` ignores unattested slips, so a fixture that skipped this
     * would produce an order with money and no refundable destination.
     */
    const reviewedAt =
      options.reviewedAt === undefined ? sql`now()` : sql`${options.reviewedAt.toISOString()}::timestamptz`;

    await tx.execute(sql`
      update payment_slips
         set status = 'accepted', reviewed_by_user_id = ${options.reviewerUserId}::uuid,
             reviewed_at = ${reviewedAt},
             payer_verified_by_user_id = case when ${options.payerName}::text is null then null
                                              else ${options.reviewerUserId}::uuid end,
             payer_verified_at = case when ${options.payerName}::text is null then null
                                      else ${reviewedAt} end
       where id = ${slipId}::uuid
    `);

    /*
     * The ledger leg that makes `order_held_thb_minor()` non-zero: debit cash, credit the
     * obligation, for the amount that actually arrived. Topping the customer's credit back up
     * to the slip's face value is a `variance` entry of its own — `ledger_entries_variance_shape`
     * requires `variance_kind` on exactly the `variance` kind, so it cannot be a third leg here.
     */
    const cash = options.cashThbMinor ?? options.paidThbMinor;

    await tx.execute(sql`
      insert into ledger_entries (id, order_id, kind, slip_id, memo_th)
      values (${entryId}::uuid, ${options.orderId}::uuid, 'slip_accepted', ${slipId}::uuid,
              'fixture: รับสลิปที่ตรวจแล้ว')
    `);

    await tx.execute(sql`
      insert into ledger_postings (entry_id, order_id, leg_no, account, amount_thb_minor)
      values
        (${entryId}::uuid, ${options.orderId}::uuid, 1, ${cashAccount}, ${cash.toString()}::bigint),
        (${entryId}::uuid, ${options.orderId}::uuid, 2, 'deposit_held', ${(-cash).toString()}::bigint)
    `);
  });

  return { slipId, instalmentId, ledgerEntryId: entryId };
}

export interface CancelOptions {
  readonly orderId: string;
  readonly fromStatus: string;
  readonly actorKind: 'customer' | 'guest' | 'staff';
  readonly actorUserId: string | null;
  readonly reasonTh: string;
  /**
   * Only settable on a post-freeze cancellation, and only because 5a's own handler would have
   * derived it from an unresolved bounce. The fixture writes the payload the handler would have
   * written; nothing in `src/payments` may supply it.
   */
  readonly fault?: 'customer' | 'company';
}

/**
 * Cancel an order and close its schedule, in one transaction — what the lifecycle must do.
 *
 * ⚠️ Not a shortcut around the API. `POST /orders/:id/transitions/cancelled` genuinely cannot
 * do this today: `assert_order_schedule` refuses a `cancelled` order whose
 * `order_payment_schedules.closed_at` is null, that UPDATE is not in 5a's handler, and the
 * assertion is deferred so the failure arrives at COMMIT. Three statements, in the order the
 * schema forces:
 *
 *   1. the event, because the spine comes first and `orders_guard_update()` refuses a status
 *      change that no new event recorded;
 *   2. the order;
 *   3. the schedule's `closed_at`, whose absence is what the deferred assertion would refuse.
 */
export async function cancelWithScheduleClosed(
  db: Database,
  options: CancelOptions,
): Promise<{ readonly eventId: string }> {
  const eventId = randomUUID();
  const payload =
    options.fault === undefined
      ? { reason: options.reasonTh }
      : { reason: options.reasonTh, fault: options.fault };

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      insert into order_events
        (id, order_id, event_type, from_status, to_status, actor_kind, actor_user_id, payload)
      values (${eventId}::uuid, ${options.orderId}::uuid, 'cancelled', ${options.fromStatus},
              'cancelled', ${options.actorKind},
              ${options.actorUserId === null ? null : options.actorUserId}::uuid,
              ${JSON.stringify(payload)}::jsonb)
    `);

    await tx.execute(sql`
      update orders set status = 'cancelled', status_event_id = ${eventId}::uuid
       where id = ${options.orderId}::uuid
    `);

    await tx.execute(sql`
      update order_payment_schedules
         set closed_at = now(), closed_reason = 'cancelled'
       where order_id = ${options.orderId}::uuid
    `);
  });

  return { eventId };
}

/**
 * A forfeit policy with real rates, because a suite that only ever tests 0 bp proves nothing.
 *
 * The shipped policy (`plan13_default`) forfeits nothing in every cell — plan 13's documented
 * default — so every assertion about the forfeit *arithmetic* against it is `0 === 0` and stays
 * green if the multiplication, the `least()`, the clamp and the fault lookup are all deleted.
 * This seeds a second, later-effective policy with a non-zero customer-fault rate so the
 * numbers can move; the two cells the schema holds at zero by CHECK
 * (`production_confirmed`, and every `company` fault) stay at zero because they cannot be
 * anything else.
 *
 * `effective_from` is `now()`, which makes it the policy `effectiveForfeitPolicy()` resolves —
 * and that is itself the evidence for the finding recorded there: nothing pins a policy to an
 * order, so publishing one changes what every later cancellation refunds.
 */
export async function seedForfeitPolicy(
  db: Database,
  input: { readonly code: string; readonly customerFaultBp: number },
): Promise<string> {
  const policyId = randomUUID();

  /*
   * One transaction, and that is the schema teaching the fixture something: `forfeit_policies_complete`
   * is a DEFERRED constraint trigger, so an effective policy is legal only at a COMMIT by which
   * every cell exists. Two separate statements put the policy row's own commit between them and
   * the assertion fires on the first one — which is exactly the behaviour that makes a
   * half-filled policy unrepresentable in production.
   */
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      insert into forfeit_policies (id, code, description_th, effective_from)
      values (${policyId}::uuid, ${input.code}, 'ชุดทดสอบ — อัตราริบที่ไม่ใช่ศูนย์', now())
    `);

    await tx.execute(sql`
      insert into forfeit_policy_rules (policy_id, from_status, fault, forfeit_bp, note_th)
      select ${policyId}::uuid, cell.from_status, cell.fault,
             case
               when cell.fault = 'company' then 0
               when cell.from_status = 'production_confirmed' then 0
               else ${input.customerFaultBp}
             end,
             'ชุดทดสอบ'
        from (
          select distinct t.from_status, f.fault
            from order_status_transitions t
            cross join (values ('customer'), ('company')) as f(fault)
           where t.to_status = 'cancelled'
        ) as cell
    `);
  });

  return policyId;
}

/**
 * Retire a seeded policy so the shipped default is the effective one again.
 *
 * ⚠️ IT USED TO BE A `DELETE`, AND THE ROW CANNOT BE DELETED ANY MORE. Since
 * `0012_payment_closure.sql` an order **pins** the policy it was contracted under
 * (`orders.forfeit_policy_id`, `ON DELETE restrict`), so deleting one is destroying the only
 * record of the rate that applies to somebody's cancellation — which is exactly what the FK is
 * for. Clearing `effective_from` is the honest operation: the policy stops applying to new
 * contracts and goes on meaning what it meant for the ones already signed under it.
 *
 * The pin is also why this no longer has to run at all for correctness. The suite used to drop
 * its policy because leaving it effective silently re-rated every other suite's cancellation;
 * now the rate an order is judged by was decided at *its own* submit, so a later policy cannot
 * reach backwards. That is the finding closing, visible as a fixture getting simpler.
 */
export async function dropForfeitPolicy(db: Database, policyId: string): Promise<void> {
  await db.execute(
    sql`update forfeit_policies set effective_from = null where id = ${policyId}::uuid`,
  );
}

/**
 * Every message in an error's cause chain, joined — because the real one is never on top.
 *
 * Drizzle rethrows as `DrizzleQueryError`, whose message is `Failed query: …` and whose
 * `.cause` is the driver error carrying the trigger's `RAISE`. `expect(…).rejects.toThrow(/…/)`
 * reads only the top, so an assertion written the obvious way passes for *any* failure of that
 * statement — including one caused by the guard being deleted. `src/orders/pg-errors.ts` walks
 * the same chain for the same reason; this is the test-side half of that lesson.
 */
export function causeChain(error: unknown): string {
  const messages: string[] = [];

  for (let current: unknown = error, depth = 0; depth < 8; depth += 1) {
    if (typeof current !== 'object' || current === null) break;
    if ('message' in current && typeof (current as { message: unknown }).message === 'string') {
      messages.push((current as { message: string }).message);
    }
    current = 'cause' in current ? (current as { cause: unknown }).cause : undefined;
  }

  return messages.join(' | ');
}

/** `await expectRejection(promise, /append-only/)` — asserts on the whole chain, not the wrapper. */
export async function expectRejection(promise: Promise<unknown>, pattern: RegExp): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const chain = causeChain(error);
    if (!pattern.test(chain)) {
      throw new Error(`expected the failure to match ${String(pattern)}, but it was: ${chain}`);
    }
    return chain;
  }

  throw new Error(`expected a rejection matching ${String(pattern)}, but the promise resolved`);
}

/** One account's balance for an order, read the same way production reads it. */
export async function accountBalance(
  db: Database,
  orderId: string,
  account: string,
): Promise<bigint> {
  const result = await db.execute(
    sql`select order_account_thb_minor(${orderId}::uuid, ${account})::text as amount`,
  );
  const rows = (result as { rows?: unknown }).rows;
  const row = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined;
  const amount = row?.['amount'];
  if (typeof amount !== 'string') throw new Error('fixture: the balance fold returned no row');
  return BigInt(amount);
}
