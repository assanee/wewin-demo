import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ NOTHING ATTACHES TO A NUMBER NOBODY PROVED.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A telephone number signs somebody in **without** being verified. That was a decision, and
 * it is only safe because of a second one that lives nowhere in particular:
 *
 *   ⓵ `user_phones_number_key` — one account per number, so the sign-in lookup has exactly
 *     one answer. In the schema, tested in `packages/db/tests/auth.test.ts`.
 *   ⓶ **nothing else may read a number without `verified_at`.** Not in the schema, not in a
 *     type, and true today only because there is exactly one reader.
 *
 * ⓶ is what makes squatting worthless. Somebody can claim a number that is not theirs — and
 * the real owner then has to telephone — but the squatter's account contains only what they
 * put in it. The moment a second reader appears that finds a *customer* by number and
 * attaches an order to them, the denial of service becomes a takeover: the squatter starts
 * receiving somebody else's quotations.
 *
 * ⚠️ This test is a **source scan**, which is a blunt instrument and is chosen on purpose.
 * The property is "no second reader exists", and no runtime assertion can see the absence of
 * code. A reader added in good faith — a customer search, a duplicate check, a merge — turns
 * this red, and the fix is to add `verified_at is not null` to it and list it below.
 *
 * ── How to make this pass again ──────────────────────────────────────────────
 *
 * Filter the new query on `verified_at`, then add the file to `READERS`. If a reader
 * genuinely needs unverified claims — the signup collision check will — say so in its entry
 * and explain why it cannot be used to reach a customer.
 */

const SOURCE = join(__dirname, '..', '..', 'src');

const files = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return files(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });

/**
 * Every file allowed to touch `user_phones`, and what makes each one safe.
 *
 * `password.repository.ts` — the sign-in lookup, and the only one that *reads* a claim
 * without `verified_at`. Safe because ⓵ makes it unambiguous and because what it returns is
 * the account that made the claim, never a customer somebody else is looking for.
 *
 * `registration.service.ts` — **writes** one, and reads none. It inserts with `verified_at`
 * null and `is_primary` false, so it cannot manufacture the authority this file protects;
 * `user_phones_primary_is_verified` would refuse the row if it tried. The collision it must
 * handle is answered by the unique index rather than by a lookup, which is why it needs no
 * SELECT — see its own comment on why a check-then-insert would be a race.
 *
 * `account/account.repository.ts` — reads unverified claims too, for a different and safe
 * reason: `listPhones` is keyed by `userId`, never by `number`, and that `userId` comes from
 * the caller's own verified access token, the same as every other query in that file. It
 * cannot be pointed at a phone number to find whoever claimed it — there is no number in its
 * input at all — so it is not the second reader ⓶ warns about. It exists so `GET /me/account`
 * can show somebody their own number back, which is showing a claim to the person who made
 * it, not attaching one to a stranger who found it.
 *
 * ⚠️ It now **selects** `userPhones.verifiedAt` and `userPhones.verifiedByUserId` as well, so
 * that a customer's own profile screen can say whether their number was proved and by whom —
 * before that, the only verification signal on the wire was `isPrimary`, which is a sound
 * reading for the primary number and calls every *verified non-primary* one an unproven claim.
 * Reporting those columns is not filtering by them, and this file must not confuse the two:
 * see `withoutProjections` below for the scan that keeps them apart and for why deleting this
 * entry from the `unfiltered` expectation would have re-introduced the very weakness the
 * `verified_at` scan's own warning was written about.
 *
 * `users/users.repository.ts` — the staff-verification screen, added for the same reason
 * `account.repository.ts` is safe and one step further from the number than it is: every
 * query here is keyed by the phone row's own `id` or by `userId`, and none takes a `number`
 * as input at all — grep the file for `eq(userPhones.number` and it is not there. The
 * dashboard list (`list()`) reads every claim on an already-identified account, unverified
 * ones included, because the verify button needs the unverified row on screen to act on —
 * exactly the shape `emails` on the same query avoids and phones deliberately does not,
 * see `UserPhoneWire`. `findPhone`/`verifyPhone`/`unverifyPhone` act on one row a caller
 * already named by its own id, having reached it through that same per-account list. None of
 * this can be used to find *whose* claim a number is — the one thing ⓶ forbids.
 */
const READERS: readonly string[] = [
  'account/account.repository.ts',
  'auth/password/password.repository.ts',
  'auth/password/registration.service.ts',
  'users/users.repository.ts',
];

const relative = (path: string): string => path.slice(SOURCE.length + 1).replaceAll('\\', '/');

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ Naming a column as an output is not the same as filtering on it.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Every scan below asks "does this file *use* `userPhones.<column>` in a position that
 * decides which rows come back". A Drizzle projection mentions the column in a position that
 * decides nothing:
 *
 *     .select({ verifiedAt: userPhones.verifiedAt })     ← reports the column
 *     .where(sql`${userPhones.verifiedAt} is not null`)  ← restricts by the column
 *     .where(eq(userPhones.number, number))             ← keyed by the column
 *
 * Stripping the first shape and re-testing is what tells them apart. It is the same class of
 * confusion the `verified_at` scan below already carries a warning about one level down — that
 * one was satisfied by a mention of a *different table*, this one by a mention in a *different
 * position* — and it arrived the same way: `GET /me/account` gained `verifiedAt` on its wire so
 * a customer's own profile screen could say whether their number was proved, the projection
 * made `account.repository.ts` look filtered, and the file silently left the `unfiltered` list
 * that its own entry in `READERS` argues at length it belongs in.
 *
 * ⚠️ **Deleting it from the expectation was the tempting fix and would have been the bug.** It
 * would make this file assert that `account.repository.ts` filters on `verified_at`, which it
 * does not and must not — leaving nothing to notice the day the filter that matters was
 * removed from somewhere that does. The detector is what changed; the expectation below is
 * byte-for-byte what it was before the wire grew the column, which is the evidence that
 * nothing was weakened to make this pass.
 *
 * ⚠️ Known limit, stated rather than papered over: a mention inside `orderBy(desc(…))` survives
 * the strip and would read as a restriction. Nothing does that today. The scan is blunt on
 * purpose — see the file header — and the assertion that actually carries the property is
 * `keyed by a telephone number`, below, which does not depend on this distinction at all.
 */
const PROJECTED = /\b[A-Za-z_$][\w$]*\s*:\s*userPhones\.[A-Za-z_$][\w$]*\b/gu;

const withoutProjections = (source: string): string => source.replaceAll(PROJECTED, '');

/** Files with a query reading `user_phones`, as repository-relative paths. */
const phoneReaders = (): readonly { path: string; source: string }[] =>
  files(SOURCE)
    .map((path) => ({ path: relative(path), source: readFileSync(path, 'utf8') }))
    .filter((file) => /\bfrom\(userPhones\)/u.test(file.source));

describe('⭐ a telephone number is a way in, not an authority', () => {
  it('⭐ has exactly one reader of `user_phones`, and it is the sign-in lookup', () => {
    const readers = files(SOURCE)
      .filter((path) => /\buserPhones\b/u.test(readFileSync(path, 'utf8')))
      .map(relative)
      .filter((path) => !path.endsWith('username.ts')) // mentions it in prose only
      .sort();

    expect(readers, 'a new reader of user_phones appeared — see the comment at the top').toStrictEqual(
      [...READERS].sort(),
    );
  });

  it('⭐ the sign-in lookup is the only query without a `verified_at` term', () => {
    /*
     * The half the file list misses. `READERS` could gain an entry that filters correctly and
     * this stays honest; what must not happen is a *second* unfiltered query, which is what
     * would let a customer be found by a number nobody proved.
     */
    /*
     * ⚠️ `userPhones.verifiedAt` and not bare `verifiedAt`.
     *
     * The first version of this matched the plain identifier and passed — because
     * `password.repository.ts` also holds `userEmails.verifiedAt`, on the *address* lookup
     * two methods above. A predicate about one table satisfied by a mention of another is a
     * test that would go green the day somebody removed the filter that matters.
     */
    /*
     * ⚠️⚠️ And `withoutProjections` first, which is the other half of the same lesson — see its
     * own header. `account.repository.ts` *selects* `userPhones.verifiedAt` to report it to the
     * number's owner and filters on nothing; without the strip, reporting a column would count
     * as restricting by it, and this list would quietly shrink by one.
     */
    const unfiltered = phoneReaders().flatMap((file) =>
      /userPhones\.verifiedAt/u.test(withoutProjections(file.source)) ? [] : [file.path],
    );

    /*
     * Two, not one — see `READERS` above for why `account.repository.ts` earns the second slot:
     * it is keyed by `userId`, never by `number`, so it cannot be the reader ⓶ warns about. Both
     * stay named explicitly rather than counted, so a *third* unfiltered query still turns this
     * red.
     */
    expect(unfiltered).toStrictEqual([
      'account/account.repository.ts',
      'auth/password/password.repository.ts',
    ]);
  });

  /**
   * ─────────────────────────────────────────────────────────────────────────────
   * ⭐⭐ THE ASSERTION THAT ACTUALLY CARRIES ⓶.
   * ─────────────────────────────────────────────────────────────────────────────
   *
   * The scan above counts *unfiltered queries*, which is a proxy. The property the file header
   * states is narrower and sharper, and every entry in `READERS` is argued in its terms rather
   * than in the proxy's:
   *
   *   `account.repository.ts` — "keyed by `userId`, never by `number` … there is no number in
   *      its input at all"
   *   `users/users.repository.ts` — "none takes a `number` as input at all — grep the file for
   *      `eq(userPhones.number` and it is not there"
   *
   * Both comments are telling the reader to run *this* scan, which until now did not exist. So
   * it exists: **a query keyed on `userPhones.number` is the dangerous shape**, because that and
   * only that can answer "whose claim is this number?" — the question that turns a squat from a
   * denial of service into a takeover.
   *
   * ⚠️ This is deliberately not derived from the `unfiltered` list, and the reason is worth
   * having: `users/users.repository.ts` is absent from that list only because of
   * `sql`${userPhones.verifiedAt} is null`` — the guard that stops re-verifying an already
   * verified number. That is a restriction on `verified_at` and it is emphatically **not** a
   * requirement that the row be proved; the proxy reads it as one. This scan does not care, and
   * would redden for that file the day it grew a by-number lookup.
   *
   * ⚠️ Projections stripped here too. `account.repository.ts` selects `number: userPhones.number`
   * to show a customer their own number back, which names the column without keying on it.
   */
  it('⭐⭐ nothing looks an account up by telephone number except the sign-in lookup', () => {
    const keyedByNumber = phoneReaders()
      .filter((file) => /userPhones\.number/u.test(withoutProjections(file.source)))
      .map((file) => file.path);

    /*
     * One, and it is the sign-in lookup — `findByClaimedPhone`, whose own comment says "No
     * `verified_at` term, and its absence is the design" and explains why `user_phones_number_key`
     * makes that safe: it returns the account that *made* the claim, never a customer somebody
     * else was looking for.
     *
     * A second entry here is the takeover ⓶ forbids, and the fix is never to add it to this list.
     * It is either to key the new query on `userId` — the shape `account.repository.ts` and
     * `users/users.repository.ts` both use — or, if it truly must take a number, to require
     * `verified_at is not null` on it and say here why the row it returns cannot reach a
     * customer.
     */
    expect(
      keyedByNumber,
      'a query now finds an account by telephone number — see ⓶ at the top of this file',
    ).toStrictEqual(['auth/password/password.repository.ts']);
  });

  it('⭐ password reset never accepts a telephone number', () => {
    /*
     * The one that turns the accepted denial of service straight back into a takeover.
     *
     * A squatter holds an unverified claim on the victim's number. If a reset could be
     * requested *by number*, it would go to whatever channel that account has — the
     * squatter's — and the victim's account would be reachable. Email-only is therefore
     * load-bearing now rather than incidental, which it was when this was written.
     */
    const reset = files(join(SOURCE, 'auth', 'password'))
      .filter((path) => relative(path).includes('password-reset'))
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n');

    expect(reset).not.toMatch(/\buserPhones\b/u);
    expect(reset).not.toMatch(/findByClaimedPhone|findByVerifiedPhone/u);
  });
});
