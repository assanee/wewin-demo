import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, createPool, type Database, type Pool } from '@wewin/db/client';
import { guests } from '@wewin/db/schema';
import { eq, sql } from '@wewin/db/sql';

import { GuestRepository } from '../../src/rbac/guest.repository';
import {
  guestSecretHash,
  mintGuestSecret,
  readGuestCookie,
  serialiseGuestCookie,
  type GuestCookie,
} from '../../src/rbac/guest-cookie';

/**
 * The guest cookie is a capability, and this is where that is true against a real table.
 *
 * The cookie used to be `guests.id` alone, with an argument written down and internally
 * consistent: a cart built without signing in belongs to whoever holds the browser, so
 * signing the value buys nothing. What that argument did not survive is what the id came to
 * be *worth* — signing in claims the guest, and claiming now attributes the guest's orders to
 * the account (`IdentityLinkService.claimGuest`). Knowing an id, which two log lines print,
 * was therefore enough to take somebody's contract.
 *
 * `tests/rbac/guard.test.ts` proves the guard's policy matrix against a fixture repository
 * that ignores the secret, deliberately — a second implementation of this check in a test
 * double would be a second answer to the question. This file is the real one.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

describeWithPg('the guest cookie as a capability', () => {
  let pool: Pool;
  let db: Database;
  let repository: GuestRepository;

  beforeAll(() => {
    pool = createPool(url ?? '');
    db = createDatabase(pool);
    repository = new GuestRepository(db);
  });

  afterAll(async () => {
    await pool.end();
  });

  /** A guest as `POST /orders` mints one: a row, and the plaintext returned exactly once. */
  const mint = async (): Promise<GuestCookie> => {
    const secret = mintGuestSecret();
    const [row] = await db
      .insert(guests)
      .values({ secretHash: guestSecretHash(secret) })
      .returning({ id: guests.id });
    if (!row) throw new Error('fixture insert returned nothing');
    return { guestId: row.id, secret };
  };

  it('accepts the pair it issued', async () => {
    const cookie = await mint();
    expect(await repository.isOpenGuest(cookie)).toBe(true);
  });

  it('refuses the right id with the wrong secret', async () => {
    const cookie = await mint();
    const other = await mint();

    expect(await repository.isOpenGuest({ guestId: cookie.guestId, secret: other.secret })).toBe(false);
    expect(await repository.isOpenGuest({ guestId: cookie.guestId, secret: mintGuestSecret() })).toBe(false);
  });

  it('refuses an id that names no row', async () => {
    expect(await repository.isOpenGuest({ guestId: randomUUID(), secret: mintGuestSecret() })).toBe(false);
  });

  it('refuses a row that predates the column — there is no secret it could match', async () => {
    /*
     * `secret_hash` is nullable and deliberately not backfilled: inventing a value would be
     * inventing a credential for a browser that will never present it. Such a row is reachable
     * through whatever account claimed it, and as a cookie it is nothing.
     */
    const [row] = await db.insert(guests).values({}).returning({ id: guests.id });
    if (!row) throw new Error('fixture insert returned nothing');

    expect(await repository.isOpenGuest({ guestId: row.id, secret: mintGuestSecret() })).toBe(false);
  });

  it('stops honouring the pair the moment the guest is claimed', async () => {
    const cookie = await mint();
    const [user] = await db.execute(
      sql`insert into users (display_name) values ('guest capability probe') returning id`,
    ).then((result) => result.rows as { id: string }[]);
    if (!user) throw new Error('fixture insert returned nothing');

    await db
      .update(guests)
      .set({ claimedByUserId: user.id, claimedAt: sql`now()` })
      .where(eq(guests.id, cookie.guestId));

    expect(await repository.isOpenGuest(cookie)).toBe(false);
  });

  it('stores only the hash, and the table refuses anything that is not one', async () => {
    const cookie = await mint();

    const [row] = await db
      .select({ hash: guests.secretHash })
      .from(guests)
      .where(eq(guests.id, cookie.guestId));

    expect(row?.hash).toBe(guestSecretHash(cookie.secret));
    expect(row?.hash).not.toBe(cookie.secret);
    expect(row?.hash).toMatch(/^[0-9a-f]{64}$/);

    /* `guests_secret_hash_shape`: the plaintext cannot be written into that column at all. */
    const refused = await db
      .update(guests)
      .set({ secretHash: cookie.secret })
      .where(eq(guests.id, cookie.guestId))
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(String((refused as { cause?: unknown } | undefined)?.cause)).toContain(
      'guests_secret_hash_shape',
    );
  });

  it('round-trips through the header the writer produces', async () => {
    const cookie = await mint();
    const header = serialiseGuestCookie(cookie, { cookieSecure: false, maxAgeSeconds: 60 });
    const value = header.split(';')[0] ?? '';

    const read = readGuestCookie(value, false);
    expect(read).toStrictEqual(cookie);
    expect(await repository.isOpenGuest(read ?? { guestId: '', secret: '' })).toBe(true);

    /* And the id on its own — the shape every pre-secret cookie and every log line has. */
    const idOnly = `${value.split('=')[0] ?? ''}=${cookie.guestId}`;
    expect(readGuestCookie(idOnly, false)).toBeUndefined();
  });
});
