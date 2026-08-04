import { randomUUID } from 'node:crypto';

import pg from 'pg';

/**
 * A second connection to the same database, for looking at what the flow left behind.
 *
 * Separate from the app's pool on purpose: an assertion that reads through the same service
 * that wrote is an assertion about a cache. These queries are raw SQL against the tables,
 * so what they see is what a support engineer would see.
 *
 * Every row these suites create is tagged with a per-run id, and cleanup deletes by that
 * tag. Not `TRUNCATE`: the catalogue suites run against the same database, and a test that
 * empties tables it does not own is a test that fails other tests.
 */

export const RUN_TAG = randomUUID().slice(0, 8);

/** Unique per test *and* per run, so a re-run never collides with rows a crash left behind. */
export const tagged = (local: string): string => `${local}.${RUN_TAG}.${randomUUID().slice(0, 6)}`;

export const emailFor = (local: string): string => `${tagged(local)}@wewin.test`;

export const subjectFor = (local: string): string => `sub-${tagged(local)}`;

export interface UserEmailRow {
  readonly id: string;
  readonly user_id: string;
  readonly address: string;
  readonly verified_at: Date | null;
  readonly is_primary: boolean;
}

export interface ProviderIdentityRow {
  readonly id: string;
  readonly user_id: string;
  readonly provider: string;
  readonly subject: string;
  readonly asserted_email: string | null;
  readonly asserted_email_verified: boolean;
  readonly last_authenticated_at: Date | null;
}

export interface OAuthStateRow {
  readonly id: string;
  readonly provider: string;
  readonly state_hash: string;
  readonly binding_hash: string;
  readonly pkce_challenge: string;
  readonly return_to: string;
  readonly guest_id: string | null;
  readonly consumed_at: Date | null;
}

export class TestDb {
  private readonly pool: pg.Pool;

  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url, max: 4 });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async query<Row extends pg.QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<Row[]> {
    const result = await this.pool.query<Row>(text, [...values]);
    return result.rows;
  }

  async emailsFor(address: string): Promise<UserEmailRow[]> {
    return this.query<UserEmailRow>(
      'select id, user_id, address, verified_at, is_primary from user_emails where address = $1 order by id',
      [address],
    );
  }

  async identity(provider: string, subject: string): Promise<ProviderIdentityRow | undefined> {
    const [row] = await this.query<ProviderIdentityRow>(
      `select id, user_id, provider, subject, asserted_email, asserted_email_verified, last_authenticated_at
         from provider_identities where provider = $1 and subject = $2`,
      [provider, subject],
    );
    return row;
  }

  async identitiesFor(provider: string, subject: string): Promise<ProviderIdentityRow[]> {
    return this.query<ProviderIdentityRow>(
      `select id, user_id, provider, subject, asserted_email, asserted_email_verified, last_authenticated_at
         from provider_identities where provider = $1 and subject = $2`,
      [provider, subject],
    );
  }

  /** Bans an account the only way the schema offers, so a test can prove the ban is read. */
  async suspend(userId: string): Promise<void> {
    await this.query(`update users set status = 'suspended', suspended_at = now() where id = $1`, [
      userId,
    ]);
  }

  async stateByChallenge(challenge: string): Promise<OAuthStateRow | undefined> {
    const [row] = await this.query<OAuthStateRow>(
      `select id, provider, state_hash, binding_hash, pkce_challenge, return_to, guest_id, consumed_at
         from oauth_states where pkce_challenge = $1`,
      [challenge],
    );
    return row;
  }

  async statesForReturnTo(returnTo: string): Promise<OAuthStateRow[]> {
    return this.query<OAuthStateRow>(
      `select id, provider, state_hash, binding_hash, pkce_challenge, return_to, guest_id, consumed_at
         from oauth_states where return_to = $1 order by created_at`,
      [returnTo],
    );
  }

  /**
   * Force a flow to look expired without sleeping through its ten-minute TTL.
   *
   * `created_at` moves too, because `oauth_states_expires_after_created` refuses a row that
   * expired before it existed — the constraint caught the first version of this helper,
   * which is a small demonstration that it is doing something.
   */
  async expireState(id: string): Promise<void> {
    await this.query(
      `update oauth_states
          set created_at = now() - interval '2 hours',
              expires_at = now() - interval '1 second'
        where id = $1`,
      [id],
    );
  }

  /** The attacker's move in plan 6(a): register the victim's address and never verify it. */
  async createUnverifiedAccount(address: string): Promise<string> {
    const [user] = await this.query<{ id: string }>(
      `insert into users (display_name) values ('attacker') returning id`,
    );
    if (user === undefined) throw new Error('failed to create the attacker account');

    await this.query(`insert into user_emails (user_id, address, verified_at) values ($1, $2, null)`, [
      user.id,
      address,
    ]);
    return user.id;
  }

  async createVerifiedAccount(address: string): Promise<string> {
    const [user] = await this.query<{ id: string }>(
      `insert into users (display_name) values ('rightful owner') returning id`,
    );
    if (user === undefined) throw new Error('failed to create the account');

    await this.query(
      `insert into user_emails (user_id, address, verified_at, is_primary) values ($1, $2, now(), true)`,
      [user.id, address],
    );
    return user.id;
  }

  private readonly createdGuests: string[] = [];

  async createGuest(): Promise<string> {
    const [guest] = await this.query<{ id: string }>(`insert into guests default values returning id`);
    if (guest === undefined) throw new Error('failed to create a guest');
    this.createdGuests.push(guest.id);
    return guest.id;
  }

  async guest(id: string): Promise<{ claimed_by_user_id: string | null } | undefined> {
    const [row] = await this.query<{ claimed_by_user_id: string | null }>(
      'select claimed_by_user_id from guests where id = $1',
      [id],
    );
    return row;
  }

  async userExists(id: string): Promise<boolean> {
    const rows = await this.query('select 1 from users where id = $1', [id]);
    return rows.length > 0;
  }

  /**
   * Deletes only what this run created.
   *
   * `users` cascades to emails, identities and sessions, so the two statements below reach
   * everything an OAuth sign-in touches. `oauth_states` has no user to hang off when a flow
   * failed before linking, so it is cleaned by its `return_to` tag.
   */
  async cleanUp(): Promise<void> {
    await this.query(
      `delete from users u using provider_identities pi
        where pi.user_id = u.id and pi.subject like $1`,
      [`sub-%${RUN_TAG}%`],
    );
    await this.query(
      `delete from users u using user_emails ue
        where ue.user_id = u.id and ue.address like $1`,
      [`%${RUN_TAG}%`],
    );
    await this.query(`delete from oauth_states where return_to like $1`, [`/after/${RUN_TAG}%`]);
    // By id, not by age: a guest row this run did not create belongs to somebody else's test.
    if (this.createdGuests.length > 0) {
      await this.query(`delete from guests where id = any($1::uuid[])`, [this.createdGuests]);
    }
  }
}

/** The same rule as every other database-backed suite here: skipped loudly, never faked. */
export const databaseUrl = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
