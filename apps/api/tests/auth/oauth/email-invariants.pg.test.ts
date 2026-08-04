import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { databaseUrl } from './support/db';

/**
 * ⓐ The invariants the linking rule stands on, probed at the SQL level.
 *
 * `account-linking.pg.test.ts` exercises the rule through the real sign-in flow. This file
 * attacks the layer underneath it with two connections and no application code at all,
 * because the two findings here are both about *concurrency* and neither is reachable
 * through a single-threaded HTTP test.
 *
 * The claim these tests are about is one sentence in 0003_auth_guards.sql: putting the strip
 * in a trigger "removes the window in which a concurrent signup can insert one more
 * unverified claim behind it". That sentence was false when it was written. An AFTER trigger
 * deletes only what its snapshot can see, and nothing locked the address — so a transaction
 * that inserted an unverified claim first and committed second survived the proof entirely,
 * and plan 6(a) was back. 0004_auth_hardening.sql adds the lock and a guard against
 * re-planting; these are what make the sentence true.
 */

const describeWithPg = databaseUrl === undefined ? describe.skip : describe;

describeWithPg('user_emails under concurrency', () => {
  let pool: pg.Pool;
  const created: string[] = [];

  const newUser = async (): Promise<string> => {
    const { rows } = await pool.query<{ id: string }>(
      `insert into users (display_name) values ('invariants') returning id`,
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('inserting a user returned no row');
    created.push(id);
    return id;
  };

  const address = (label: string): string => `${label}-${randomUUID().slice(0, 8)}@wewin.test`;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: databaseUrl ?? '', max: 6 });
  });

  afterAll(async () => {
    if (created.length > 0) {
      await pool.query('delete from users where id = any($1::uuid[])', [created]);
    }
    await pool.end();
  });

  /**
   * The race, run as a race.
   *
   * The choreography matters and is worth reading slowly. The attacker's transaction opens
   * first and inserts an unverified claim without committing. The victim's proving INSERT is
   * then *fired without being awaited* — it blocks inside `user_emails_claim_guard` on the
   * advisory lock the attacker holds. Only then does the attacker commit, and the victim's
   * statement wakes up, takes a fresh snapshot, sees the row that raced it, and strips it.
   *
   * Awaiting the victim's insert before committing the attacker would hang, which is itself
   * the proof that the two are serialised: before 0004 this same script ran straight through
   * and left two rows behind.
   */
  it('strips an unverified claim that raced the proving statement', async () => {
    const mailbox = address('race');
    const attacker = await newUser();
    const victim = await newUser();

    const attackerTx = await pool.connect();
    const victimTx = await pool.connect();

    try {
      await attackerTx.query('begin');
      await attackerTx.query(
        'insert into user_emails (user_id, address, verified_at) values ($1, $2, null)',
        [attacker, mailbox],
      );

      await victimTx.query('begin');
      const proving = victimTx.query(
        'insert into user_emails (user_id, address, verified_at, is_primary) values ($1, $2, now(), true)',
        [victim, mailbox],
      );

      // Long enough for the victim's statement to reach the lock and block on it. If it
      // did not, the attacker's commit below simply happens first and the test still
      // asserts the right thing — it just stops being about the race.
      await new Promise((resolve) => setTimeout(resolve, 250));
      await attackerTx.query('commit');

      await proving;
      await victimTx.query('commit');
    } finally {
      attackerTx.release();
      victimTx.release();
    }

    const { rows } = await pool.query<{ user_id: string; verified_at: Date | null }>(
      'select user_id, verified_at from user_emails where address = $1',
      [mailbox],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.user_id).toBe(victim);
    expect(rows[0]?.verified_at).not.toBeNull();
  });

  /**
   * The other half: a claim planted *after* the proof.
   *
   * The strip was a point-in-time sweep on the proving statement, so an attacker who
   * re-planted the claim a second later was never swept again — and every later proof by the
   * owner returned early without stripping. Prevention rather than repeated cleaning: there
   * is no moment at which the row is allowed to exist.
   */
  it('refuses an unverified claim on an address somebody has already proven', async () => {
    const mailbox = address('replant');
    const owner = await newUser();
    const attacker = await newUser();

    await pool.query(
      'insert into user_emails (user_id, address, verified_at, is_primary) values ($1, $2, now(), true)',
      [owner, mailbox],
    );

    const failure = await pool
      .query('insert into user_emails (user_id, address) values ($1, $2)', [attacker, mailbox])
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(failure).toBeDefined();
    expect((failure as { code?: string }).code).toBe('23505');
    // And the message names no account: "that address is taken" must not be an oracle for
    // which accounts exist.
    expect(String((failure as { message?: string }).message)).not.toContain(owner);
  });

  it('still allows several unverified claims on an address nobody has proven', async () => {
    // The state the attack starts from is legal, and has to stay legal: two people may each
    // claim an address before either proves it. Refusing that would make "somebody typed
    // your email at signup" a denial of service on your own signup.
    const mailbox = address('crowded');
    const first = await newUser();
    const second = await newUser();

    await pool.query('insert into user_emails (user_id, address) values ($1, $2)', [first, mailbox]);
    await pool.query('insert into user_emails (user_id, address) values ($1, $2)', [second, mailbox]);

    const { rows } = await pool.query('select 1 from user_emails where address = $1', [mailbox]);
    expect(rows).toHaveLength(2);
  });

  it('refuses a second verified owner for a Unicode variant of the same address', async () => {
    const tag = randomUUID().slice(0, 8);
    // Escapes, not literals: the two differ by one byte sequence and look identical in
    // every editor, so a literal would be at the mercy of the last tool to save this file.
    const composed = `\u00e5${tag}@wewin.test`;
    const decomposed = `a\u030a${tag}@wewin.test`;
    expect(composed).not.toBe(decomposed);
    expect(decomposed.normalize('NFC')).toBe(composed);

    const owner = await newUser();
    const attacker = await newUser();

    await pool.query(
      'insert into user_emails (user_id, address, verified_at, is_primary) values ($1, $2, now(), true)',
      [owner, composed],
    );

    /*
     * Refused by `user_emails_address_nfc`, not by the unique index — and that is the
     * stronger place for it. The index compares bytes and would have accepted these two as
     * different mailboxes forever; the CHECK means the decomposed spelling cannot be stored
     * at all, so a writer that forgets to normalise fails loudly instead of quietly creating
     * a second owner for one mailbox.
     */
    const failure = await pool
      .query(
        'insert into user_emails (user_id, address, verified_at, is_primary) values ($1, $2, now(), true)',
        [attacker, decomposed],
      )
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(failure).toBeDefined();
    expect(String((failure as { constraint?: string }).constraint)).toBe('user_emails_address_nfc');
  });
});
