import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, createPool, type Database, type Pool } from '@wewin/db/client';
import { userPhones } from '@wewin/db/schema';
import { eq, sql } from '@wewin/db/sql';

import {
  bootLifecycleApp,
  client,
  lifecycleEnv,
  makeActor,
  type Actor,
  type LifecycleApp,
} from '../orders/support/lifecycle-app';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * A member of staff, having spoken to the customer, marks a number verified.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * There is no SMS OTP anywhere in this build — the owner's decision, stated in the brief
 * this feature answers: no provider, no per-message cost nobody agreed to pay. So what this
 * button records is weaker than "the customer holds the phone": it is "a person at this
 * company says so", and `verified_by_user_id` is the column that keeps a later reader from
 * reading the stronger claim into a weaker fact. Every test below is really testing that one
 * distinction from a different angle:
 *
 *   ⭐ verifying stamps the *caller*, not a bystander;
 *   ⭐ un-verifying clears both columns together, because a voucher on an unverified row is
 *     a state `user_phones_voucher_needs_a_verification` refuses to hold;
 *   ⭐ verifying an already-verified number is refused rather than silently re-stamped — the
 *     one property a compare-and-set UPDATE has to have or the first assertion is lost the
 *     moment a second person clicks the same stale button.
 *
 * Skipped, not failed, without a database.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

const tag = randomUUID().slice(0, 8);

let phoneSeq = 0;
/** `user_phones_number_e164`-shaped and unique within this run — nothing here needs a real one. */
function freshPhoneNumber(): string {
  phoneSeq += 1;
  return `+6690${String(1_000_000 + phoneSeq).padStart(7, '0')}`;
}

describeWithPg('staff phone verification', () => {
  let pool: Pool;
  let db: Database;
  let app: LifecycleApp;
  let call: ReturnType<typeof client>;

  /** Holds `users.write` — may verify and un-verify. */
  let admin: Actor;
  /** A second holder, so "the actor is the caller" has two different callers to prove against. */
  let deputy: Actor;
  /** Holds `users.read` only — the split this permission table exists for. */
  let viewer: Actor;
  /** Holds neither. */
  let outsider: Actor;
  /** Whoever the phone belongs to — never the caller, and never a permission holder itself. */
  let customer: Actor;

  const verificationPath = (userId: string, phoneId: string): string =>
    `/admin/users/${userId}/phones/${phoneId}/verification`;

  const insertPhone = async (options: {
    readonly verified?: boolean;
    readonly primary?: boolean;
    /**
     * Unset by default even when `verified` is true — a verified row with no voucher is
     * exactly the "proved with no staff assertion" shape `verifyPhone` never actually
     * produces (see the un-verify test that constructs it on purpose, below). Tests that want
     * an ordinary staff-verified fixture pass this explicitly, the same way the real route
     * always would.
     */
    readonly voucher?: string;
  } = {}): Promise<string> => {
    const [row] = await db
      .insert(userPhones)
      .values({
        userId: customer.userId,
        number: freshPhoneNumber(),
        ...(options.verified === true ? { verifiedAt: new Date() } : {}),
        ...(options.primary === true ? { isPrimary: true } : {}),
        ...(options.voucher !== undefined ? { verifiedByUserId: options.voucher } : {}),
      })
      .returning({ id: userPhones.id });
    if (!row) throw new Error('fixture insert returned nothing');
    return row.id;
  };

  const readPhone = async (
    phoneId: string,
  ): Promise<{ readonly verifiedAt: Date | null; readonly verifiedByUserId: string | null }> => {
    const [row] = await db
      .select({ verifiedAt: userPhones.verifiedAt, verifiedByUserId: userPhones.verifiedByUserId })
      .from(userPhones)
      .where(eq(userPhones.id, phoneId));
    if (!row) throw new Error('phone fixture vanished');
    return row;
  };

  beforeAll(async () => {
    pool = createPool(url ?? '');
    db = createDatabase(pool);
    app = await bootLifecycleApp(lifecycleEnv(url ?? ''));
    call = client(app.baseUrl);

    admin = await makeActor(db, app, `phone admin ${tag}`, ['users.read', 'users.write']);
    deputy = await makeActor(db, app, `phone deputy ${tag}`, ['users.read', 'users.write']);
    viewer = await makeActor(db, app, `phone viewer ${tag}`, ['users.read']);
    outsider = await makeActor(db, app, `phone outsider ${tag}`, ['orders.read']);
    customer = await makeActor(db, app, `phone customer ${tag}`, []);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  /* ---------------------------------------------------------------- *
   * ⭐ Verifying — the actor is the caller, not a fixed value
   * ---------------------------------------------------------------- */

  it('verifies a number and records the caller — not a bystander — as who vouched', async () => {
    const phoneId = await insertPhone();

    const response = await call('POST', verificationPath(customer.userId, phoneId), {
      token: admin.token,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(204);

    const row = await readPhone(phoneId);
    expect(row.verifiedAt).not.toBeNull();
    // ⚠️ The load-bearing assertion. A hardcoded actor, or the wrong local variable, passes
    // every "is it verified" check and fails only this line.
    expect(row.verifiedByUserId).toBe(admin.userId);
  });

  it('records whichever caller actually verified it — a second, different actor', async () => {
    // Same assertion, a different caller, on a different row. A implementation that reads a
    // constant or the *first* caller it ever saw passes the test above and fails this one.
    const phoneId = await insertPhone();

    const response = await call('POST', verificationPath(customer.userId, phoneId), {
      token: deputy.token,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(204);

    const row = await readPhone(phoneId);
    expect(row.verifiedByUserId).toBe(deputy.userId);
  });

  it('refuses a number that does not belong to the named user', async () => {
    const phoneId = await insertPhone();
    const stranger = await makeActor(db, app, `phone stranger ${tag}`, []);

    const response = await call('POST', verificationPath(stranger.userId, phoneId), {
      token: admin.token,
    });
    expect(response.status).toBe(404);
  });

  /* ---------------------------------------------------------------- *
   * ⭐ Verifying twice — the property that matters
   * ---------------------------------------------------------------- */

  it('⭐ refuses to re-verify an already-verified number, and the original actor and timestamp stand', async () => {
    const phoneId = await insertPhone();

    const first = await call('POST', verificationPath(customer.userId, phoneId), {
      token: admin.token,
    });
    expect(first.status).toBe(204);

    const original = await readPhone(phoneId);
    expect(original.verifiedByUserId).toBe(admin.userId);

    // A different member of staff, on the same already-verified row.
    const second = await call('POST', verificationPath(customer.userId, phoneId), {
      token: deputy.token,
    });
    expect(second.status, 'a second verify must not silently succeed').toBe(409);

    const after = await readPhone(phoneId);
    // The property the brief asks for by name: not silently rewritten.
    expect(after.verifiedByUserId).toBe(admin.userId);
    expect(after.verifiedAt?.getTime()).toBe(original.verifiedAt?.getTime());
  });

  /* ---------------------------------------------------------------- *
   * Un-verifying — both columns return to null together
   * ---------------------------------------------------------------- */

  it('un-verifies, clearing who vouched along with when', async () => {
    const phoneId = await insertPhone();
    await call('POST', verificationPath(customer.userId, phoneId), { token: admin.token });

    const response = await call('DELETE', verificationPath(customer.userId, phoneId), {
      token: admin.token,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(204);

    const row = await readPhone(phoneId);
    // `user_phones_voucher_needs_a_verification` refuses a voucher on an unverified row —
    // one clearing without the other is not a state this table can hold, so both are checked.
    expect(row.verifiedAt).toBeNull();
    expect(row.verifiedByUserId).toBeNull();
  });

  it('refuses to un-verify a number that was never verified', async () => {
    const phoneId = await insertPhone();

    const response = await call('DELETE', verificationPath(customer.userId, phoneId), {
      token: admin.token,
    });
    expect(response.status).toBe(409);
  });

  it('refuses to un-verify the primary number', async () => {
    // Primary implies verified (`user_phones_primary_is_verified`) — this is the one
    // combination the schema will not let un-verify leave standing. Vouched for, like any
    // ordinary staff-verified row, so this isolates the primary-number rule from the
    // no-voucher rule the test below is about — without a voucher the no-voucher refusal
    // would fire first and this would stop proving what its name says it proves.
    const phoneId = await insertPhone({ verified: true, primary: true, voucher: admin.userId });

    const response = await call('DELETE', verificationPath(customer.userId, phoneId), {
      token: admin.token,
    });
    expect(response.status).toBe(409);
    expect((response.body as { error?: { details?: { reason?: string } } }).error?.details?.reason).toBe(
      'primary-number',
    );

    // Refused, not partially applied.
    const row = await readPhone(phoneId);
    expect(row.verifiedAt).not.toBeNull();
  });

  it('refuses to un-verify a row proved with no voucher — a state no route writes today, built directly on the fixture', async () => {
    // `verifyPhone` is the only writer of `verified_at`, and it always sets `verified_
    // by_user_id` alongside it — so this shape (verified, no voucher: the future OTP this
    // table was built to anticipate) is unreachable through today's routes. `insertPhone`
    // constructs it directly rather than pretending a route can reach it. Without the
    // service's own guard, this UPDATE still matches `verified_at is not null and not is_
    // primary` and reaches `user_phones_verification_is_final`, which raises `restrict_
    // violation` — and `users/` has no `pg-errors.ts` to translate that, so it would surface
    // as a 500 rather than the 409 asserted below.
    const phoneId = await insertPhone({ verified: true });

    const response = await call('DELETE', verificationPath(customer.userId, phoneId), {
      token: admin.token,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect((response.body as { error?: { details?: { reason?: string } } }).error?.details?.reason).toBe(
      'not-staff-verified',
    );

    // Refused, not partially applied.
    const row = await readPhone(phoneId);
    expect(row.verifiedAt).not.toBeNull();
  });

  /* ---------------------------------------------------------------- *
   * The permission split
   * ---------------------------------------------------------------- */

  it('refuses users.read alone, both directions', async () => {
    const phoneId = await insertPhone();

    const verify = await call('POST', verificationPath(customer.userId, phoneId), {
      token: viewer.token,
    });
    expect(verify.status).toBe(403);

    const verified = await insertPhone({ verified: true });
    const unverify = await call('DELETE', verificationPath(customer.userId, verified), {
      token: viewer.token,
    });
    expect(unverify.status).toBe(403);
  });

  it('refuses somebody holding neither permission', async () => {
    const phoneId = await insertPhone();
    const response = await call('POST', verificationPath(customer.userId, phoneId), {
      token: outsider.token,
    });
    expect(response.status).toBe(403);
  });

  /* ---------------------------------------------------------------- *
   * The record — admin_events carries what the row alone loses on un-verify
   * ---------------------------------------------------------------- */

  it('records both actions in admin_events, naming the customer as the subject', async () => {
    const phoneId = await insertPhone();
    await call('POST', verificationPath(customer.userId, phoneId), { token: admin.token });
    await call('DELETE', verificationPath(customer.userId, phoneId), { token: admin.token });

    const rows = await db.execute<{ action: string; actor_user_id: string; subject_user_id: string }>(sql`
      select action, actor_user_id::text as actor_user_id, subject_user_id::text as subject_user_id
        from admin_events
       where payload->>'phoneId' = ${phoneId}
       order by seq
    `);

    expect(rows.rows.map((row) => row.action)).toStrictEqual(['user.phone_verified', 'user.phone_unverified']);
    expect(rows.rows.every((row) => row.subject_user_id === customer.userId)).toBe(true);
    expect(rows.rows.every((row) => row.actor_user_id === admin.userId)).toBe(true);
  });
});
