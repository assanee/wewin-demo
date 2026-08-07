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
 * Every file allowed to query `user_phones`, and what makes each one safe.
 *
 * `password.repository.ts` — the sign-in lookup, and the **only** one that reads a claim
 * without `verified_at`. Safe because ⓵ makes it unambiguous and because what it returns is
 * the account that made the claim, never a customer somebody else is looking for.
 */
const READERS: readonly string[] = ['auth/password/password.repository.ts'];

const relative = (path: string): string => path.slice(SOURCE.length + 1).replaceAll('\\', '/');

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
    const unfiltered = files(SOURCE).flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      if (!/\bfrom\(userPhones\)/u.test(source)) return [];
      return /userPhones\.verifiedAt/u.test(source) ? [] : [relative(path)];
    });

    expect(unfiltered).toStrictEqual(['auth/password/password.repository.ts']);
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
