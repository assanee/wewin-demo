import { groupPermissions, groups, userEmails, userGroups, users } from '@wewin/db/schema';
import { afterAll, describe, expect, it } from 'vitest';

import { PermissionRepository } from '../../src/rbac/permission.repository';
import { createPgHarness } from '../support/pg-harness';

/**
 * `PermissionRepository.addressesHolding` — who can be told, resolved from the permission model.
 *
 * `FxStalenessService` mails the holders of `organisation.write` because they are the only people
 * who can end an exchange-rate outage. Everything about *that decision* is unit-tested against a
 * fake in `tests/fx/fx-staleness.test.ts`; everything here is about **rows** — because a fake
 * cannot prove that a `closed` account is filtered by SQL rather than by a comment claiming it is.
 *
 * ⚠️ This is a list of people the system sends mail to, which makes a false positive here a
 * different class of defect from a missing row: writing to an erased account is a privacy failure
 * under plan 9, not an inconvenience. So the whitelist is asserted from both directions — the
 * addresses that appear *and*, via `toStrictEqual` on the whole list, the ones that must not.
 *
 * ⭐ Two of the four statuses are excluded by our `WHERE` (`suspended`, `closed`); the third
 * (`erased`) turned out to be excluded by the *schema*, which refuses to let such a user hold an
 * address at all. That was discovered by this file rather than assumed — the first draft tried to
 * build an erased holder with an email and Postgres refused. Both facts are pinned, separately,
 * because they can stop being true independently.
 *
 * Skipped, not failed, without a database.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

describeWithPg('PermissionRepository.addressesHolding against Postgres', () => {
  const base = createPgHarness(url ?? '');

  const harness = async () => {
    const { app, db } = await base.harness();

    /** A group carrying exactly the permissions named. */
    const group = async (code: string, permissions: readonly string[]): Promise<string> => {
      const [row] = await db
        .insert(groups)
        .values({ code, nameTh: code })
        .returning({ id: groups.id });
      if (!row) throw new Error('group insert returned nothing');
      if (permissions.length > 0) {
        await db
          .insert(groupPermissions)
          .values(permissions.map((permissionCode) => ({ groupId: row.id, permissionCode })));
      }
      return row.id;
    };

    /**
     * A person, in a given status, with a primary (therefore verified) address, in given groups.
     *
     * The status columns are set together with the status because the schema insists:
     * `users_closed_at_present` and `users_erased_at_present` refuse a status without its stamp,
     * and `users_erased_display_name_null` refuses an erased row that still has a name. Building
     * the fixtures through those CHECKs rather than around them is what makes them realistic.
     */
    const person = async (
      address: string,
      status: 'active' | 'suspended' | 'closed' | 'erased',
      groupIds: readonly string[],
      options: { readonly withEmail?: boolean; readonly primary?: boolean } = {},
    ): Promise<string> => {
      const now = new Date();
      const [row] = await db
        .insert(users)
        .values({
          displayName: status === 'erased' ? null : address,
          status,
          ...(status === 'suspended' ? { suspendedAt: now } : {}),
          ...(status === 'closed' ? { closedAt: now } : {}),
          ...(status === 'erased' ? { erasedAt: now } : {}),
        })
        .returning({ id: users.id });
      if (!row) throw new Error('user insert returned nothing');

      if (options.withEmail !== false) {
        const primary = options.primary !== false;
        await db.insert(userEmails).values({
          userId: row.id,
          address,
          /* Primary implies verified — `user_emails_primary_is_verified` would refuse otherwise. */
          verifiedAt: primary ? now : null,
          isPrimary: primary,
        });
      }

      if (groupIds.length > 0) {
        await db.insert(userGroups).values(groupIds.map((groupId) => ({ userId: row.id, groupId })));
      }
      return row.id;
    };

    return { db, people: app.app.get(PermissionRepository), group, person };
  };

  afterAll(base.closeOpened);

  /**
   * ⭐ The whole exclusion policy, in one fixture, asserted exhaustively.
   *
   * Three people all holding `organisation.write` through the same group, differing only in
   * status, plus one who holds a different permission entirely. `toStrictEqual` on the full list
   * rather than `toContain`, so an exclusion that stops working fails here instead of passing
   * quietly with an extra address nobody looked at.
   */
  it('returns only active holders, excluding suspended and closed', async () => {
    const { people, group, person } = await harness();
    const admin = await group('fx_admin', ['organisation.write']);
    const reader = await group('fx_reader', ['organisation.read']);

    await person('active@probe.test', 'active', [admin]);
    await person('suspended@probe.test', 'suspended', [admin]);
    await person('closed@probe.test', 'closed', [admin]);
    /* Holds a neighbouring permission on the same table — must not be swept in. */
    await person('reader@probe.test', 'active', [reader]);

    expect(await people.addressesHolding('organisation.write')).toStrictEqual([
      'active@probe.test',
    ]);
  });

  /**
   * ⭐ AN ERASED HOLDER HAS NO ADDRESS TO BE MAILED AT — and that is a schema guarantee, not a
   * predicate in our query.
   *
   * This case was originally written as a fourth row in the fixture above, and the database
   * refused to build it: `user_emails_refuse_erased_user` (0009) raises `restrict_violation` on
   * INSERT, and the erasure procedure `DELETE FROM user_emails WHERE user_id = p_user` removes any
   * that already existed — the migration's own note says the rows are *"DELETED, never scrubbed"*
   * because deletion is the only thing that releases `user_emails_one_verified_owner`.
   *
   * So an erased user cannot hold an address in either direction of time, and the join on
   * `user_emails` (with its `is_primary` predicate) excludes them on its own. `status = 'active'` is therefore the *second*
   * independent wall rather than the only one, which is the strongest version of this guarantee
   * and worth pinning as such: this test fails if erasure ever starts leaving the row behind, and
   * that is exactly when the status filter would become load-bearing without anybody noticing.
   */
  it('cannot even give an erased holder an address, so the join can never reach one', async () => {
    const { db, group, person } = await harness();
    const admin = await group('fx_admin', ['organisation.write']);
    const erased = await person('gone@probe.test', 'erased', [], { withEmail: false });

    await expect(
      db.insert(userEmails).values({
        userId: erased,
        address: 'gone@probe.test',
        verifiedAt: new Date(),
        isPrimary: true,
      }),
    ).rejects.toMatchObject({ cause: { code: '23001' } });

    /* And the group grant is refused by the same trigger, so they cannot hold the permission
       either — both halves of "reachable again" are closed. */
    await expect(
      db.insert(userGroups).values({ userId: erased, groupId: admin }),
    ).rejects.toMatchObject({ cause: { code: '23001' } });
  });

  /**
   * ⭐ One address per person, however many groups carry the permission.
   *
   * Two groups both granting `organisation.write`, one person in both. Without `selectDistinct`
   * the join yields two rows and the service sends the same person two identical emails — the
   * kind of defect that never fails anything and quietly trains somebody to filter the alert.
   */
  it('returns one address for somebody holding the permission through two groups', async () => {
    const { people, group, person } = await harness();
    const first = await group('fx_admin_a', ['organisation.write']);
    const second = await group('fx_admin_b', ['organisation.write', 'organisation.read']);

    await person('both@probe.test', 'active', [first, second]);

    expect(await people.addressesHolding('organisation.write')).toStrictEqual(['both@probe.test']);
  });

  /**
   * ⚠️ An unverified address is not a destination.
   *
   * `is_primary` is the filter, and `user_emails_primary_is_verified` is what makes that equal to
   * "verified". This person holds the permission and has an address row that is neither — the
   * state an attacker creates per `user_emails_one_verified_owner`'s note — and must not be
   * mailed. Asserted as an empty list, so a query that dropped the `is_primary` predicate fails.
   */
  it('excludes a holder whose only address is unverified and not primary', async () => {
    const { people, group, person } = await harness();
    const admin = await group('fx_admin', ['organisation.write']);

    await person('unverified@probe.test', 'active', [admin], { primary: false });

    expect(await people.addressesHolding('organisation.write')).toStrictEqual([]);
  });

  /**
   * A holder with no address row at all.
   *
   * ⚠️ **`is_primary` is what excludes them, not the `innerJoin`** — established by mutation and
   * corrected here, because the obvious reading is wrong. Switching the join to `leftJoin` does
   * *not* break this test: the emailless row arrives with `is_primary` as SQL `NULL`, and
   * `eq(userEmails.isPrimary, true)` is then `NULL` rather than true, so the `WHERE` drops it
   * before it can reach the result as an `address: null`. The two guards are genuinely
   * independent, and it is the predicate that does the work; the inner join states the intent and
   * lets the planner see it. Dropping the `is_primary` predicate *does* redden this.
   */
  it('excludes a holder with no email row at all', async () => {
    const { people, group, person } = await harness();
    const admin = await group('fx_admin', ['organisation.write']);

    await person('nomail@probe.test', 'active', [admin], { withEmail: false });

    expect(await people.addressesHolding('organisation.write')).toStrictEqual([]);
  });

  /**
   * ⭐ The empty set is a real, reachable state — and it is what `FxStalenessService` raises its
   * loudest alarm about. Proving it comes back as `[]` rather than throwing is what lets that
   * branch be a decision rather than an exception nobody planned for.
   */
  it('answers with an empty list when nobody holds the permission', async () => {
    const { people } = await harness();

    expect(await people.addressesHolding('organisation.write')).toStrictEqual([]);
  });

  /**
   * ⭐ A super admin is included without being named.
   *
   * `bootstrap_staff` carries every permission code, which is what "super admin" means in this
   * system — there is deliberately no wildcard code, because a wildcard would have to be
   * special-cased inside `RequirePermissions` (the one chokepoint with no bypass) and would
   * silently grant every permission added in future. Routing on `organisation.write` reaches such
   * a person anyway, which is the property that made the wildcard unnecessary.
   */
  it('includes a holder of every permission code without naming a role', async () => {
    const { people, group, person } = await harness();
    const everything = await group('super', ['organisation.write', 'organisation.read', 'orders.read']);

    await person('super@probe.test', 'active', [everything]);

    expect(await people.addressesHolding('organisation.write')).toStrictEqual(['super@probe.test']);
  });

  /** Deterministic order, so a log line and a test read the same way twice. */
  it('returns addresses in a stable order', async () => {
    const { people, group, person } = await harness();
    const admin = await group('fx_admin', ['organisation.write']);

    for (const address of ['zebra@probe.test', 'aardvark@probe.test', 'moose@probe.test']) {
      await person(address, 'active', [admin]);
    }

    expect(await people.addressesHolding('organisation.write')).toStrictEqual([
      'aardvark@probe.test',
      'moose@probe.test',
      'zebra@probe.test',
    ]);
  });
});
