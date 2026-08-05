import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  boolean,
  char,
  check,
  foreignKey,
  index,
  inet,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * The identity layer: who a request is, and what that lets it do.
 *
 * Auth is written by hand rather than bought in (plan section 6) because LINE decides the
 * shape and no turnkey provider's marketing page is evidence it works. What that buys is
 * also what it costs: every rule a hosted provider would have enforced has to be written
 * down somewhere, and the four vulnerabilities plan 6 names are all cases where "somewhere"
 * was application code and application code lost a race.
 *
 * So the split this file makes is the same one `catalog.ts` makes for the catalogue: an
 * invariant that two concurrent requests could both step over belongs in Postgres, not in
 * a service. Four of them are load-bearing and each is marked ⓐ ⓑ ⓒ ⓓ against the plan's
 * numbering, in the constraint that carries it:
 *
 *   ⓐ pre-hijacking      `user_emails_one_verified_owner`, plus the strip trigger in
 *                        drizzle/0003_auth_guards.sql
 *   ⓑ OAuth state        `oauth_states.binding_hash` — a row alone is not a browser
 *   ⓒ rotation races     `rotate_refresh_token()` in the same migration: one statement,
 *                        one winner, a grace window instead of a false theft alarm
 *   ⓓ permission drift   `permissions.code` is the primary key, so a rollback cannot
 *                        renumber what a grant points at
 *
 * Three conventions hold everywhere below and are not repeated at each column:
 *
 *   digests    every column that holds token material is `char(64)` and CHECKed against
 *              `^[0-9a-f]{64}$` — a lower-case hex SHA-256 and nothing else. See the note
 *              on `digest()` for why SHA-256 and not a password KDF, and why the CHECK is
 *              the thing that makes storing a raw token a write error rather than a habit.
 *   times      `timestamptz`, always. The server runs UTC (docker-compose.yml) and every
 *              window in here — a grace period, an expiry — is a comparison against
 *              `now()`, which is meaningless across two frames of reference.
 *   deletion   ⚠️ **THIS RULE CHANGED IN 5b. READ IT BEFORE ADDING A TABLE.**
 *
 *              It used to say: `on delete cascade` towards the user; an erasure request is
 *              one `DELETE FROM users`, and anything that survives it is a leak with a
 *              paper trail. That sentence is now false, and leaving it in place would be
 *              worse than deleting it, because the next reader would trust it.
 *
 *              The business owner's decision (plan 7.15 item 1) is that deletion is a
 *              status flag: nothing is ever really deleted. `orders.customer_user_id` is
 *              `ON DELETE RESTRICT`, so a `DELETE FROM users` was already refused for any
 *              customer who had ever ordered — the cascades below have never once run on
 *              a real erasure and never will.
 *
 *              What replaces them is `erase_user()` in drizzle/0009_user_erasure.sql: a
 *              named function that deletes each credential table by hand, and a trigger
 *              (`users_erasure_is_earned`) that refuses to let a row *claim* the `erased`
 *              status until those rows are actually gone. The cascade clauses stay where
 *              they are — they are still the right answer for a hard delete in a test
 *              fixture, and removing a guard because policy has made it unreachable is how
 *              the next policy change becomes data loss — but they are no longer the
 *              specification of what personal data hangs off a user.
 *
 *              The specification is now `ERASURE_TREATMENTS` in this file, and
 *              tests/erasure.test.ts fails when a new foreign key to `users` appears
 *              without one. Read the ⚠️ on that constant: it names, out loud, the class of
 *              personal data it structurally cannot see.
 */

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

/**
 * A SHA-256 digest, lower-case hex, in a fixed-width column.
 *
 * **Why hashed at all.** Every secret in this file — a refresh token, an email
 * verification link, an OAuth `state`, the cookie that binds that state to a browser —
 * is a bearer token: whoever holds the bytes is the user. A dump of this database is
 * therefore a login for every open session unless the bytes are not in it. Storing the
 * digest means the database can still *recognise* a token presented to it and can never
 * *produce* one.
 *
 * **Why SHA-256 and not argon2.** The opposite choice from `password_credentials` below,
 * and for the opposite reason. These values are 256 bits from a CSPRNG, so there is no
 * dictionary to walk and no work factor worth paying: brute-forcing the preimage of one
 * of these digests is brute-forcing the token itself. A slow KDF here would only buy
 * latency on the hot path — every API call refreshes eventually — while a human-chosen
 * password has a small search space and needs the work factor to survive a dump.
 *
 * **Why `char(64)` with a format CHECK and not `text`.** The CHECK is the interesting
 * part. A SHA-256 hex digest is exactly 64 characters of `[0-9a-f]`; a raw token is
 * base64url and is not. So a service that ever forgets to hash — passing the token
 * straight through — fails on the INSERT that did it, on the row that did it, instead
 * of quietly storing a live credential that nothing downstream can tell apart from a
 * digest. The constraint is not describing the column, it is defending it.
 */
const digest = (name: string) => char(name, { length: 64 });

const digestIsHex = (column: AnyPgColumn, constraintName: string) =>
  check(constraintName, sql`${column} ~ '^[0-9a-f]{64}$'`);

/**
 * The providers a `sub` can come from.
 *
 * An enum and not `text` for the same reason as the catalogue's enums: `'gooogle'` in a
 * `text` column is a second, empty namespace in which `(provider, subject)` is unique
 * against nothing at all. LINE is first because it is the one that decided the build
 * (plan section 6) — it is also the one that may return no email, which is why
 * `provider_identities.asserted_email` is nullable.
 */
export const authProvider = pgEnum('auth_provider', ['line', 'google', 'facebook', 'apple']);

/**
 * PKCE code challenge methods, of which there is exactly one.
 *
 * `plain` is in the RFC and is not in this list. A one-member enum reads like a mistake
 * until you notice what it forbids: `plain` sends the verifier to the provider in the
 * authorisation URL, where it lands in browser history and in the provider's logs, which
 * undoes the entire point. Adding it back has to be a migration with a name on it.
 */
export const pkceMethod = pgEnum('pkce_method', ['S256']);

/**
 * What may be done with an account, and whether the person is still in this database.
 *
 * **`text` + CHECK and not `pgEnum`, and the reason is mechanical rather than stylistic.**
 * `order.ts:40-47` already settled this for order statuses after that set grew once having
 * been called final: `ALTER TYPE … ADD VALUE` cannot be rolled back, and — verified against
 * this project's own Postgres 18.4 — a new member cannot be *used* in the transaction that
 * added it. Drizzle's migrator runs each file in one transaction
 * (`src/test-database.ts`), so "add `closed` and `erased`, then backfill, then add a CHECK
 * that mentions them" is not expressible as one migration at all. This set has now grown
 * from two members to four; it is exactly the set that must not be a one-way door.
 *
 * The `{ enum }` narrowing is kept deliberately and is not decoration: it is what makes
 * `UserStatus` a compile-time trip-wire, so a hand-written `'active' | 'suspended'` union
 * somewhere in the API is a type error rather than a runtime lie.
 *
 *   active     signs in.
 *   suspended  administrative, reversible, nothing scrubbed. An operator did this.
 *   closed     "I want my account gone." Sign-in is refused, every session is revoked, and
 *              **nothing is scrubbed** — the verified address is still held, the provider
 *              identities are still attached. Reversible: proving control of the account
 *              again through a provider reinstates it (`IdentityLinkService`), which is the
 *              only reason it is honest to call this state reversible at all.
 *   erased     "Forget me", and the scrub has already run. Terminal. Every credential and
 *              every lookup key is DELETED; the `users` row survives as a tombstone that
 *              carries no personal data and that nothing can authenticate as.
 *
 * `closed` and `erased` are two states because they are two different facts, not two words
 * for one request: closure is a decision and is instant, erasure is a completed job over
 * several tables. A design with only one of them either refuses sign-in before the scrub
 * has run or claims erasure before it happened.
 */
export const USER_STATUSES = ['active', 'suspended', 'closed', 'erased'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/**
 * Why a session stopped being usable. Kept because "logged out" and "we saw a stolen
 * token" need different words in a support conversation.
 *
 * `text` + CHECK for the same reason as `USER_STATUSES`, and this one is the sharper case:
 * `account_closed` is added *and written* by the same migration — `users_status_revoke_sessions`
 * revokes the sessions of any account whose status leaves `active` — which as a pgEnum
 * raises `unsafe use of new value` and fails the deploy that ships the feature.
 *
 * `refresh_reuse` and `account_closed` are the database's to write and are deliberately
 * absent from `RevocationReason` in the API (session.repository.ts): a reason no service
 * may set is a reason no service can set wrongly.
 */
export const SESSION_REVOCATION_REASONS = [
  'logout',
  'refresh_reuse',
  'password_changed',
  'email_changed',
  'revoked_by_admin',
  'account_closed',
] as const;
export type SessionRevocationReason = (typeof SESSION_REVOCATION_REASONS)[number];

/**
 * How every table that references `users` is treated by `erase_user()`.
 *
 * This constant exists because of what the owner's decision broke. The `on delete cascade`
 * clauses towards `users` were an *executable* specification of "what personal data hangs
 * off a person": add a table, give it a cascade, and the one `DELETE FROM users` covered
 * it. Under never-delete those clauses never fire, so the specification stopped executing
 * and nothing replaced it — which means a table added in phase 6 gets a cascade clause by
 * habit, is never deleted from, and its personal data is simply missed.
 *
 * `tests/erasure.test.ts` enumerates every foreign key to `users` out of
 * `information_schema` and fails when one is not named here — keyed `table.column`, because
 * `user_groups` and `user_erasure_requests` each reference `users` twice and the two columns
 * do not get the same answer. Adding a referencing table forces a decision instead of
 * inheriting one.
 *
 *   delete    a credential or a lookup key. Removed by `erase_user()`; the trigger
 *             `users_erasure_is_earned` refuses the `erased` status while any survive.
 *   scrub     a copy of personal data on a row that must stay. Nulled in place.
 *   keep      pseudonymous, or an accounting fact. Left exactly as it is.
 *
 * ⚠️ **WHAT THIS LIST STRUCTURALLY CANNOT SEE.** It is derived from foreign keys to
 * `users`, and the largest concentration of personal data in this system reaches `users`
 * through no foreign key at all: an order submitted by a guest who never signed in carries
 * `contact_email`, `contact_name` and `contact_phone` with `customer_user_id IS NULL`.
 * Plan section 6 calls that anonymous funnel the main path. A coverage test built on this
 * list reports `orders` as covered — because `customer_user_id` is named here — while the
 * row holding the person is untouched. That gap, and the three append-only tables listed
 * as `escalated`, are written into plan 7.15 as the price of this decision. Do not read a
 * green coverage test as "erasure is complete".
 */
export const ERASURE_TREATMENTS = {
  'user_emails.user_id': 'delete',
  'provider_identities.user_id': 'delete',
  'password_credentials.user_id': 'delete',
  'auth_tokens.user_id': 'delete',
  'sessions.user_id': 'delete',
  /*
   * KEPT, against all three design angles, which each listed `user_groups` under "delete
   * at erased".
   *
   * A membership row is a uuid and a group id: it names no person once `display_name` is
   * null. Deleting it answers a staff member's PDPA request by destroying the company's own
   * audit — `order_events.actor_user_id` is `ON DELETE RESTRICT`, so the spine goes on
   * naming that uuid as the actor who cancelled an order forever, and nothing anywhere is
   * left to say what authority they held when they did it. That is the question a refund
   * dispute asks. The tombstone stays unreachable regardless: it holds no credential, and
   * `accountUsability` refuses every non-active status before permissions are consulted.
   */
  'user_groups.user_id': 'keep',
  /* Who granted a membership. Already `set null`, and the comment there says why. */
  'user_groups.granted_by_user_id': 'keep',
  /* The claim link survives; the guest's cookie secret is nulled, which is what revokes it. */
  'guests.claimed_by_user_id': 'scrub',
  /* The paper trail. It is *about* the erasure and cannot be erased by it. */
  'user_erasure_requests.user_id': 'keep',
  'user_erasure_requests.requested_by_user_id': 'keep',
  /*
   * ⚠️ ESCALATED, NOT DONE. Accounting records and media this round does not own
   * (packages/db/src/schema/order.ts, media.ts). `orders.contact_email` cannot even be
   * nulled today — `orders_submitted_has_a_contact_channel` refuses it — and the spine
   * refuses UPDATE outright. `media_objects` deduplicates by checksum, so purging one
   * person's image can purge another's. Named here so the coverage test passes for a stated
   * reason rather than by omission. Plan 7.15 item 1 carries the full list.
   */
  'orders.customer_user_id': 'escalated',
  'order_events.actor_user_id': 'escalated',
  'media_objects.uploaded_by_user_id': 'escalated',

  /*
   * ── Phase 5b, the money tables (packages/db/src/schema/payment.ts) ──────────────
   *
   * Added because the coverage test refused the phase without them, which is the whole
   * point of this constant: a table that references `users` forces a decision instead of
   * inheriting one. Seven new keys, six of them `keep` and one `escalated`, and the split
   * is between *staff acting in a role* and *a person who is the customer*.
   *
   * The six `keep`s are the record of WHO EXERCISED A CONTROL. `payment_slips` review is
   * the single control this design has (plan 7.7); `refunds` carries the two-person rule
   * that decides whether money leaves the company. A uuid on those rows names no person
   * once `display_name` is null — the same argument `user_groups.user_id` makes above —
   * and deleting it answers a staff member's PDPA request by destroying the company's
   * evidence that a refund was ever authorised. That is the question a dispute asks.
   */
  'payment_slips.reviewed_by_user_id': 'keep',
  /*
   * Who read the payer's name and account off the slip image and attested they match.
   * `keep`, for the same reason as the reviewer beside it: manual review is the only
   * control in a model with no payment gateway, and an attestation whose attester has
   * been scrubbed is no longer evidence that anybody checked.
   */
  'payment_slips.payer_verified_by_user_id': 'keep',
  'refunds.requested_by_user_id': 'keep',
  'refunds.approved_by_user_id': 'keep',
  'refunds.disbursed_by_user_id': 'keep',
  'approvals.requested_by_user_id': 'keep',
  'approvals.decided_by_user_id': 'keep',
  /*
   * ⚠️ ESCALATED, NOT DONE — and it is a *customer* column, unlike the six above.
   *
   * A slip is usually uploaded by the person who paid. The row cannot be deleted
   * (`payment_slips_guard_write` refuses it: a slip is evidence of a payment) and the
   * column cannot be nulled without losing which of two people transferred the money. It
   * sits with `orders.customer_user_id` under the accounting exemption and inherits every
   * caveat plan 7.16 puts on that word.
   *
   * The image is a separate question and IS answerable: `storage_key` is nullable and
   * `storage_key_erased_at` records the erasure, so a retention sweep can remove the
   * photograph while the bank reference that reconciles the statement survives — plan
   * 7.6's "delete the image, keep the account row". Nothing schedules that sweep yet;
   * plan 13's retention clock is still unanswered.
   */
  'payment_slips.submitted_by_user_id': 'escalated',

  /*
   * ── Phase 5c, the sales-editable quote (packages/db/src/schema/quote.ts) ────────
   *
   * Four more, and the coverage test refused the phase without them — which is this
   * constant working exactly as intended for the second time in two phases.
   *
   * All four are `keep`, and all four are the same argument as the six above, sharpened:
   * plan 7.9 gives up the ability to ask *"is this total correct?"* and replaces it with
   * *"where did this number come from, and was that person allowed?"*. These columns are
   * the entire answer to the second question. Scrubbing one turns a priced quote into a
   * figure with no author — which is not erasure of personal data, it is destruction of
   * the only control the feature has.
   *
   * A uuid on these rows names nobody once `display_name` is null, exactly as
   * `user_groups.user_id` argues, and none of them is a customer column: a customer cannot
   * set a price, remove a line, or grant authority.
   */
  'quote_overrides.set_by_user_id': 'keep',
  'quote_overrides.superseded_by_user_id': 'keep',
  'quote_lines.removed_by_user_id': 'keep',
  'authority_limits.granted_by_user_id': 'keep',
} as const satisfies Record<string, 'delete' | 'scrub' | 'keep' | 'escalated'>;

export const authTokenPurpose = pgEnum('auth_token_purpose', [
  'email_verification',
  'password_reset',
]);

/**
 * What `rotate_refresh_token()` decided. See drizzle/0003_auth_guards.sql.
 *
 *   `rotated`   this caller consumed the token and holds the successor.
 *   `graced`    another caller consumed it moments ago and this one arrived inside the
 *               grace window — a dashboard with six panels open, not a thief. It gets a
 *               successor of its own and the session is left alone. This member *is*
 *               fix ⓒ: without it there is no vocabulary for the race, and the only
 *               thing left to say about a second arrival is `reused`.
 *   `reused`    the token had already been consumed and the grace window had closed.
 *               That is the theft signature, and the session is revoked.
 *   `rejected`  unknown, expired, or belonging to a session that was already revoked.
 *               Nothing suspicious happened; the caller signs in again.
 *
 * `reused` and `rejected` are separate on purpose. Collapsing them means either revoking
 * a session every time a token merely expired, or never revoking on theft — and the
 * two need different words in front of the user as well as different consequences.
 */
export const refreshRotationOutcome = pgEnum('refresh_rotation_outcome', [
  'rotated',
  'graced',
  'reused',
  'rejected',
]);

/**
 * A person.
 *
 * Deliberately holds no email address. An email is a claim about the world that may or
 * may not have been proven, may be proven by more than one person over time, and may be
 * taken away again — `user_emails` is where that lives, and keeping it off this row is
 * what makes "sign in by email" a join through a verified address rather than a column
 * read. Vulnerability ⓐ starts with a `users.email` column and a lookup that does not
 * ask whether anybody proved it.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * Optional: a password sign-up knows an address and nothing else until the user says
     * otherwise.
     *
     * **The only column on this row that names a person**, which is why it is the one people
     * forget: it is nullable already, so nulling it looks like nothing happened. LINE and
     * Google both hand over a real name here. `users_erased_has_no_name` makes it a write
     * error for an `erased` row to hold one.
     */
    displayName: text('display_name'),
    status: text('status', { enum: USER_STATUSES }).notNull().default('active'),
    suspendedAt: timestamp('suspended_at', { withTimezone: true }),
    /** When the person asked. Set on entering `closed`, and **kept through erasure** — see the CHECK. */
    closedAt: timestamp('closed_at', { withTimezone: true }),
    /** When the scrub finished. Written by `erase_user()` and by nothing else. */
    erasedAt: timestamp('erased_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    /*
     * ONE-WAY IMPLICATIONS, NOT BICONDITIONALS, and the difference is load-bearing.
     *
     * `users_suspended_at_present` was already written this way; the two new ones copy it
     * rather than tightening it. A biconditional (`(status = 'closed') = (closed_at is not
     * null)`) reads stricter and makes the erasure of a closed account unrepresentable: the
     * UPDATE to `erased` would have to NULL `closed_at` to satisfy it, destroying the date
     * the customer asked — which is the one fact that proves the cooling-off period was
     * honoured. The timestamps accumulate as the history they are.
     */
    /* The domain half of the `text` + CHECK pair. Declared here, not only in the migration, so `drizzle-kit generate` tracks it and a member added to `USER_STATUSES` without a migration is a diff rather than a 23514 in production. */
    check(
      'users_status_known',
      sql`${table.status} in ('active', 'suspended', 'closed', 'erased')`,
    ),
    check(
      'users_suspended_at_present',
      sql`${table.status} <> 'suspended' or ${table.suspendedAt} is not null`,
    ),
    check('users_closed_at_present', sql`${table.status} <> 'closed' or ${table.closedAt} is not null`),
    check('users_erased_at_present', sql`${table.status} <> 'erased' or ${table.erasedAt} is not null`),
    /* The converse: a scrub timestamp on a row that does not say erased is a lie in the other direction. */
    check('users_erased_at_shape', sql`${table.erasedAt} is null or ${table.status} = 'erased'`),
    /*
     * The one scrub target that lives on this row. A same-row CHECK can carry exactly this
     * much and no more — every other scrub target is a different row, which is why the real
     * enforcement is a trigger and not a longer list of CHECKs here.
     */
    check(
      'users_erased_has_no_name',
      sql`${table.status} <> 'erased' or ${table.displayName} is null`,
    ),
  ],
);

/**
 * One request to be forgotten, and what happened to it.
 *
 * A separate table and not five more columns on `users`, because a DSAR has to be
 * answerable months later with more than a timestamp — who asked, through what channel, on
 * what basis, what was withheld under the accounting exemption, and who ran it. A status
 * value cannot carry five facts, and a request has to be able to exist *before* the scrub
 * runs, which is the state `closed` covers.
 *
 * **Append-only, and written in the same transaction as the scrub.** Both are enforced in
 * drizzle/0009_user_erasure.sql, and the second is not a nicety: without it the durable
 * fact is the irreversible one and the record justifying it is the erasable one, which is
 * exactly backwards. `write_txid` + `pg_current_xact_id()` is the mechanism
 * `notifications_guard_insert()` already uses for the same sentence about outbox rows
 * (0007_order_guards.sql) — reused rather than reinvented.
 *
 * `user_id` is `ON DELETE RESTRICT`: the proof outlives nothing.
 */
export const userErasureRequests = pgTable(
  'user_erasure_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * Who asked. NULL means the account holder asked for themselves — a uuid here is a
     * staff member acting on their behalf, and erasure-as-a-weapon is the residual risk
     * that makes recording it worth a column. `set null` so the record outlives the
     * operator's own account, the same reasoning as `user_groups.granted_by_user_id`.
     */
    requestedByUserId: uuid('requested_by_user_id').references((): AnyPgColumn => users.id, {
      onDelete: 'set null',
    }),
    /** How the request arrived: `self_service`, `email`, `phone`, `in_person`. Free text on purpose — the list is not ours to close. */
    channel: text('channel').notNull(),
    /** Which right is being exercised, in the words of the law being answered. */
    legalBasis: text('legal_basis').notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    /**
     * What the scrub did *not* reach, and why, as free text.
     *
     * Not a nicety either. The accounting exemption is being claimed over `orders`, and a
     * DSAR answer of "we erased you" that does not say what was withheld is not an answer.
     * `erase_user()` writes this from a constant so the sentence cannot drift from the
     * function's actual coverage.
     */
    withheldScope: text('withheld_scope'),
    /**
     * Which recipe ran. Mirrors `order_documents.pin_schema_version`, for the same reason:
     * a v2 scrub that covers three more tables must not be silently comparable to a v1
     * record that claims the same word.
     */
    scrubSchemaVersion: integer('scrub_schema_version').notNull().default(1),
    /** `pg_current_xact_id()` of the transaction that wrote this row. See the note above. */
    writeTxid: text('write_txid').notNull(),
  },
  (table) => [
    index('user_erasure_requests_user_idx').on(table.userId),
    check('user_erasure_requests_channel_present', sql`length(btrim(${table.channel})) > 0`),
    check('user_erasure_requests_basis_present', sql`length(btrim(${table.legalBasis})) > 0`),
    check(
      'user_erasure_requests_completed_after_requested',
      sql`${table.completedAt} is null or ${table.completedAt} >= ${table.requestedAt}`,
    ),
  ],
);

/**
 * An anonymous visitor, as a row.
 *
 * Plan section 6: the guest cart does not fit "every query carries a scope", because a
 * visitor has no user, no group and no permission — and is the main funnel. The answer
 * there is a fourth scope variant `{ kind: 'guest', guestId }`; this table is what makes
 * that `guestId` a real referent, so a cart row can carry a foreign key instead of an
 * opaque string that nothing can join to or clean up.
 *
 * `claimed_by_user_id` is the seam between the two worlds: signing in claims the visitor
 * you already were, which is how a cart built before login survives it. It stays set
 * afterwards rather than being deleted, because the same browser keeps sending the same
 * guest cookie and a second visit must not mint a second cart.
 */
export const guests = pgTable(
  'guests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * SHA-256 of the secret half of the guest cookie. Hex, 64 characters.
     *
     * The cookie used to be the id alone, on the stated reasoning that a cart built without
     * signing in belongs to whoever holds the browser and that signing the value would buy
     * nothing. That was right about the cart and wrong about everything downstream, because
     * of what the id *became*: signing in claims the guest, and claiming now attributes its
     * orders to the account (`IdentityLinkService.claimGuest`). So anybody who learned a
     * guest id — from a log line, from a shared browser, from an old cookie — could put it
     * in their own cookie jar, sign in, and take the cart and every order in it, while the
     * real owner's cookie stopped working and nothing anywhere reported an incident.
     *
     * Knowing the id must therefore not be enough. The cookie carries `id.secret`; this is
     * the only copy of the secret the server keeps, and it is a hash so that a database dump
     * is not a drawer full of live capabilities.
     *
     * Nullable, because rows created before this column existed have no secret — and that is
     * exactly the right meaning: such a row can never again be presented as a cookie
     * (`GuestRepository.isOpenGuest` refuses a null), only reached through the account that
     * claimed it. There is no migration that could invent one, and inventing one would be
     * inventing a credential.
     */
    secretHash: text('secret_hash'),
    claimedByUserId: uuid('claimed_by_user_id').references(() => users.id, {
      onDelete: 'cascade',
    }),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('guests_claimed_by_idx').on(table.claimedByUserId),
    /* Two columns, one fact. Either both say the visitor was claimed or neither does. */
    check(
      'guests_claim_shape',
      sql`(${table.claimedByUserId} is null) = (${table.claimedAt} is null)`,
    ),
    /*
     * Shape, not existence. A present value must be a hex SHA-256 and nothing else, so that
     * "the secret is stored hashed" is a property of the table rather than of the one
     * function that happens to write it today. Null stays legal — see the column.
     */
    check(
      'guests_secret_hash_shape',
      sql`${table.secretHash} is null or ${table.secretHash} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

/**
 * ⓐ An email address and the state of the claim on it.
 *
 * A row here is a *claim*: this user says they can read this mailbox. `verified_at` is
 * the only thing that turns a claim into a fact, and the two partial indexes below are
 * the whole of plan 6(a) that a schema can carry:
 *
 *   `user_emails_one_verified_owner` — UNIQUE on `address` WHERE verified. Two requests
 *   proving the same address at the same instant cannot both win, because the second one
 *   raises 23505 rather than reading a row the first had not committed yet. A service
 *   doing SELECT-then-INSERT has a window between the two statements and both of them
 *   pass; an index has no window. This is the difference the brief asks for, and
 *   `tests/auth.test.ts` runs both halves concurrently to show it.
 *
 *   `user_emails_one_primary_per_user` — plus `user_emails_primary_is_verified`, so an
 *   unverified address can never become the one the system sends mail to or matches on.
 *
 * What the index cannot say is what happens to the *losers*. Plan 6(a) is explicit that
 * proving control must strip the address from every unverified account rather than merge
 * into one, because merging is exactly the handover the attack wants: the attacker signs
 * up first with the victim's address, leaves it unverified, and waits for the victim to
 * arrive through Google. That stripping is a trigger in drizzle/0003_auth_guards.sql, not
 * a service method, so no future caller can forget it and no concurrent signup can slip
 * a fresh unverified row in behind a merge that already decided.
 *
 * Addresses are stored lower-cased and otherwise untouched. Not "canonicalised": dropping
 * dots or `+tags` is a provider-specific rule, and applying Gmail's to a corporate server
 * merges two people who are genuinely two people.
 */
export const userEmails = pgTable(
  'user_emails',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    address: text('address').notNull(),
    /** Null until somebody proved they can read it. Nothing may key off an address while this is null. */
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    isPrimary: boolean('is_primary').notNull().default(false),
    ...timestamps,
  },
  (table) => [
    unique('user_emails_user_address_key').on(table.userId, table.address),
    /* ⓐ The constraint the whole attack turns on. Partial: unverified duplicates are allowed to exist — that is the state an attacker creates — they just never become anybody's identity. */
    uniqueIndex('user_emails_one_verified_owner')
      .on(table.address)
      .where(sql`verified_at is not null`),
    uniqueIndex('user_emails_one_primary_per_user').on(table.userId).where(sql`is_primary`),
    index('user_emails_address_idx').on(table.address),
    check('user_emails_address_lowercase', sql`${table.address} = lower(${table.address})`),
    /*
     * ⓐ Case was not enough. `user_emails_one_verified_owner` is a btree on the raw text
     * under a deterministic collation, so it compares *bytes* — and `å` precomposed
     * (U+00E5) and `a` + U+030A are different bytes naming one mailbox. Without this, two
     * accounts hold a verified claim on the same address, the index never notices, and the
     * victim signing in with a provider that spells it the other way lands in a second
     * account instead of their own. Normalising in the application alone would leave the
     * invariant true only for callers that remembered; this makes the other spelling
     * unrepresentable. `providers/provider.types.ts:normaliseEmail` writes NFC, so the two
     * halves cannot drift without this constraint refusing the write.
     */
    check('user_emails_address_nfc', sql`${table.address} = normalize(${table.address}, nfc)`),
    check(
      'user_emails_address_shape',
      sql`${table.address} ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'`,
    ),
    /* An unverified address must never be the one we send to or match on — that is the merge, wearing a different hat. */
    check(
      'user_emails_primary_is_verified',
      sql`not ${table.isPrimary} or ${table.verifiedAt} is not null`,
    ),
  ],
);

/**
 * A `sub` at a provider, and the account it signs in to.
 *
 * `(provider, subject)` is the identity. The email beside it is **not**: it is recorded
 * as `asserted_email` — what the provider claimed, at the time it claimed it — and is
 * never on its own a reason to attach this identity to an existing account. That rule is
 * the other half of ⓐ, and the column names say so: an *assertion* is not a verified
 * address, and `user_emails` is the only place a verified address exists.
 *
 * Nullable because LINE returns an email only when the channel has been approved for it,
 * and Apple returns one only on the very first authorisation and never again. A schema
 * that made it `not null` would be a schema that cannot represent the two providers this
 * project exists for.
 */
export const providerIdentities = pgTable(
  'provider_identities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: authProvider('provider').notNull(),
    /** The provider's `sub` claim. Opaque, stable, and the only thing that identifies the account there. */
    subject: text('subject').notNull(),
    assertedEmail: text('asserted_email'),
    /** What the provider said about its own claim. Recorded, never trusted as a link key. */
    assertedEmailVerified: boolean('asserted_email_verified').notNull().default(false),
    lastAuthenticatedAt: timestamp('last_authenticated_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    /* One account per subject per provider. Without it, a second callback for the same `sub` creates a second user and the first one's orders become unreachable. */
    unique('provider_identities_provider_subject_key').on(table.provider, table.subject),
    index('provider_identities_user_idx').on(table.userId),
    check(
      'provider_identities_asserted_email_lowercase',
      sql`${table.assertedEmail} is null or ${table.assertedEmail} = lower(${table.assertedEmail})`,
    ),
    check(
      'provider_identities_asserted_email_present',
      sql`not ${table.assertedEmailVerified} or ${table.assertedEmail} is not null`,
    ),
  ],
);

/**
 * A password, for the accounts that have one.
 *
 * Separate table and not a column on `users`, so the common read — load the user — does
 * not carry the hash through every service that touches it. One row per user at most.
 *
 * `password_hash` is a PHC string (`$argon2id$v=19$m=…,t=…,p=…$salt$hash`), stored whole.
 * The encoding carries the algorithm, the parameters and the salt, so raising the cost
 * factor next year is a re-hash on next login and not a migration; a schema that split
 * them into columns would have to migrate to change its mind.
 *
 * The CHECK is doing the same job as `digestIsHex` above, at a different address: it
 * rejects a bcrypt hash, an unsalted digest and — the one that matters — a plaintext
 * password, on the write that attempted it. Argon2id specifically because it is the
 * memory-hard variant with side-channel resistance, and because the thing being protected
 * here is a human's choice out of a very small space.
 */
export const passwordCredentials = pgTable(
  'password_credentials',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    passwordHash: text('password_hash').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('password_credentials_argon2id', sql`${table.passwordHash} like '$argon2id$%'`),
  ],
);

/**
 * A one-shot link sent to an email address.
 *
 * Both purposes share a table because they share every property that matters: single
 * use, short lived, delivered out of band, and worth exactly one account to whoever
 * intercepts it. `token_hash` holds the digest; the link in the mail is the only place
 * the raw value ever exists, which is the point (see `digest`).
 *
 * `user_email_id` is required for a verification and forbidden for a reset, and the CHECK
 * says so rather than a comment: a verification link proves *one address*, and a reset
 * that pointed at an address would be a reset that could be aimed at a different one.
 */
export const authTokens = pgTable(
  'auth_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    purpose: authTokenPurpose('purpose').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    userEmailId: uuid('user_email_id').references(() => userEmails.id, { onDelete: 'cascade' }),
    tokenHash: digest('token_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (table) => [
    unique('auth_tokens_token_hash_key').on(table.tokenHash),
    digestIsHex(table.tokenHash, 'auth_tokens_token_hash_is_digest'),
    index('auth_tokens_user_idx').on(table.userId),
    /* Sweeping expired rows is a range scan on this, not a sequential scan of every token ever issued. */
    index('auth_tokens_expires_at_idx').on(table.expiresAt),
    check('auth_tokens_expires_after_created', sql`${table.expiresAt} > ${table.createdAt}`),
    check(
      'auth_tokens_email_target_shape',
      sql`case ${table.purpose}
            when 'email_verification' then ${table.userEmailId} is not null
            else ${table.userEmailId} is null
          end`,
    ),
  ],
);

/**
 * ⓑ One OAuth authorisation attempt, in flight.
 *
 * The row exists so the callback can prove the flow was started here. That is necessary
 * and — plan 6(b) — nowhere near sufficient: a server-side row is not a browser. The
 * attacker starts a flow of their own, signs in as themselves, gets the victim's browser
 * to open the resulting callback URL, and the victim is now logged into the attacker's
 * account, quietly, with the attacker reading whatever they do next. Every check that
 * looks only at `state` passes, because `state` is genuine — it just belongs to somebody
 * else's browser.
 *
 * So the callback needs two secrets and this table stores neither:
 *
 *   `state_hash`    digest of the `state` parameter that came back in the URL.
 *   `binding_hash`  digest of a value that only ever travelled in a `Set-Cookie` on the
 *                   response that started the flow — `httpOnly`, `Secure`,
 *                   `SameSite=None`. `None` and not `Lax` because Apple returns by
 *                   cross-site `POST` (`response_mode=form_post`) and a `Lax` cookie is
 *                   not sent on it, so the flow that most needs the binding is the one
 *                   that silently loses it. Which is why this is `not null`: a nullable
 *                   column is an optional check, and an optional check is fix ⓑ removed.
 *
 * A dump therefore contains no way to complete anybody's flow: the URL half is hashed and
 * the cookie half never left the browser.
 *
 * `pkce_challenge` is the exception that proves the rule — it is stored raw because it is
 * public. It is `SHA256(verifier)`, it was already sent to the provider in the
 * authorisation URL, and the *verifier* is what is secret. The verifier rides in the same
 * httpOnly cookie as the binding secret and is never written down here, so this row is
 * useless to a thief in both directions.
 */
export const oauthStates = pgTable(
  'oauth_states',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: authProvider('provider').notNull(),
    stateHash: digest('state_hash').notNull(),
    /* ⓑ Not null. The browser half of the proof. */
    bindingHash: digest('binding_hash').notNull(),
    pkceMethod: pkceMethod('pkce_method').notNull().default('S256'),
    /** base64url of SHA-256 over the verifier: 43 characters, no padding. */
    pkceChallenge: text('pkce_challenge').notNull(),
    /**
     * Where to send the user afterwards.
     *
     * A path on this site, never a URL. The CHECK rejects `//evil.example` and `/\evil`
     * as well as `https://…`, because a browser reads the first two as protocol-relative
     * and an open redirect on the login callback is a phishing page with our domain in
     * front of it.
     */
    returnTo: text('return_to').notNull().default('/'),
    /** The anonymous visitor this flow began as, so their cart survives signing in. */
    guestId: uuid('guest_id').references(() => guests.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (table) => [
    unique('oauth_states_state_hash_key').on(table.stateHash),
    digestIsHex(table.stateHash, 'oauth_states_state_hash_is_digest'),
    digestIsHex(table.bindingHash, 'oauth_states_binding_hash_is_digest'),
    index('oauth_states_expires_at_idx').on(table.expiresAt),
    check('oauth_states_expires_after_created', sql`${table.expiresAt} > ${table.createdAt}`),
    check(
      'oauth_states_pkce_challenge_shape',
      sql`${table.pkceChallenge} ~ '^[A-Za-z0-9_-]{43}$'`,
    ),
    check(
      'oauth_states_return_to_is_local',
      sql`left(${table.returnTo}, 1) = '/'
          and left(${table.returnTo}, 2) <> '//'
          and left(${table.returnTo}, 2) <> ('/' || chr(92))`,
    ),
  ],
);

/**
 * One sign-in on one device.
 *
 * The unit revocation acts on: "sign out everywhere" and the reuse detection in
 * `rotate_refresh_token()` both work by revoking a session, never by chasing individual
 * tokens. `user_agent` and `ip` exist for the user's own device list — "Chrome on
 * Windows, Bangkok, 2 hours ago" — which is the only way a person notices a session they
 * did not start.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    userAgent: text('user_agent'),
    ip: inet('ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    /** Absolute lifetime. A session that is refreshed forever is a session that is never re-authenticated. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason', { enum: SESSION_REVOCATION_REASONS }),
  },
  (table) => [
    index('sessions_user_idx').on(table.userId),
    index('sessions_expires_at_idx').on(table.expiresAt),
    check('sessions_expires_after_created', sql`${table.expiresAt} > ${table.createdAt}`),
    check(
      'sessions_revoked_reason_known',
      sql`${table.revokedReason} is null or ${table.revokedReason} in ('logout', 'refresh_reuse', 'password_changed', 'email_changed', 'revoked_by_admin', 'account_closed')`,
    ),
    /* A revocation with no reason is an incident nobody can describe afterwards. */
    check(
      'sessions_revocation_shape',
      sql`(${table.revokedAt} is null) = (${table.revokedReason} is null)`,
    ),
  ],
);

/**
 * ⓒ One refresh token in a session's rotation chain.
 *
 * The shape exists to make plan 6(c) expressible in one statement. The failure it is
 * built against is not an attack: a dashboard opens six panels, six requests find the
 * access token expired within the same millisecond, six refreshes arrive carrying the
 * same refresh token, and naive reuse-detection reads five of them as a stolen token and
 * signs the user out in the middle of their work.
 *
 * Three columns carry the fix:
 *
 *   `consumed_at`  written exactly once — a trigger in drizzle/0003_auth_guards.sql
 *                  refuses to change it once set, so "consumed" is a fact about the row
 *                  and not a value the last writer decides. The claim is therefore a
 *                  single UPDATE whose WHERE clause is the mutual exclusion; there is no
 *                  read-then-write for a second connection to interleave with.
 *   `revoked_at`   mirrored down from the session by trigger when the session is revoked,
 *                  so the rotation statement never has to join `sessions` to know whether
 *                  it may proceed. One table, one statement, one row lock.
 *   `parent_id`    the chain. Kept because a support question — "when did this device
 *                  last really re-authenticate?" — is a walk backwards, and because a
 *                  graced sibling and the winner both point at the same parent, which is
 *                  what makes the race visible after the fact instead of inferred.
 *
 * `rotate_refresh_token()` is that statement, in the migration beside this file, and
 * `tests/auth.test.ts` fires eight concurrent rotations at one token to show that exactly
 * one wins, seven are graced and nobody is logged out.
 */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    tokenHash: digest('token_hash').notNull(),
    parentId: uuid('parent_id'),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: 'refresh_tokens_parent_fk',
      columns: [table.parentId],
      foreignColumns: [table.id],
    }).onDelete('cascade'),
    unique('refresh_tokens_token_hash_key').on(table.tokenHash),
    digestIsHex(table.tokenHash, 'refresh_tokens_token_hash_is_digest'),
    index('refresh_tokens_session_idx').on(table.sessionId),
    index('refresh_tokens_expires_at_idx').on(table.expiresAt),
    check('refresh_tokens_expires_after_issued', sql`${table.expiresAt} > ${table.issuedAt}`),
    /* A token cannot have been used before it existed; a clock that says otherwise is a clock worth failing on. */
    check(
      'refresh_tokens_consumed_after_issued',
      sql`${table.consumedAt} is null or ${table.consumedAt} >= ${table.issuedAt}`,
    ),
    check('refresh_tokens_not_own_parent', sql`${table.parentId} is distinct from ${table.id}`),
  ],
);

/**
 * ⓓ A permission, named by a code that survives a rollback.
 *
 * **The primary key is the code.** Not a serial id with the code beside it, and this is
 * the whole of plan 6(d) that the schema can carry: a grant stores what it points at, and
 * if that were a generated number then re-seeding the table on a rolled-back release
 * would renumber it and every grant in the database would quietly mean something else.
 * `'orders.refund'` means `'orders.refund'` on every machine, in every direction, forever.
 *
 * The rest of 6(d) is boot behaviour, and this table is shaped so both directions are
 * possible without a schema change:
 *
 *   missing in the database → `INSERT … ON CONFLICT (code) DO UPDATE SET description = …`
 *     at boot. Safe, forward-only, and idempotent; the primary key is what makes it a
 *     single statement, and existing grants are untouched because they reference the code
 *     that already matched.
 *   extra in the database  → nothing. No constraint here can be violated by a code the
 *     running binary has never heard of, which is the point: release N+1 adds
 *     `orders.refund`, the rollback to N does not know it, and N still boots. The strict
 *     comparison belongs in CI, where it can fail a pull request instead of a deploy.
 *     `group_permissions` references this table `ON DELETE RESTRICT` for the same reason —
 *     tidying up an unrecognised permission must not silently drop somebody's access.
 */
export const permissions = pgTable(
  'permissions',
  {
    /** `resource.action`, e.g. `orders.read`. Lower snake segments so a code is never ambiguous about its own casing. */
    code: text('code').primaryKey(),
    description: text('description').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'permissions_code_shape',
      sql`${table.code} ~ '^[a-z][a-z0-9_]*([.][a-z][a-z0-9_]*)+$'`,
    ),
  ],
);

/**
 * A named bundle of permissions — sales, production, admin.
 *
 * Groups exist so a role change is one row and not a fan-out, but permissions stay the
 * single source of truth (plan section 6): a guard asks "does this principal hold
 * `orders.refund`", never "is this principal in sales", and a menu is rendered from the
 * answer. Hiding a menu item is not authorisation and nothing in this schema pretends
 * otherwise — there is no `menu` table.
 *
 * `is_system` marks the groups the application itself boots with. A trigger refuses to
 * delete one, for the same reason as ⓓ: a rollback that finds `admin` missing because
 * somebody tidied it is a rollback that cannot start.
 */
export const groups = pgTable(
  'groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull().unique(),
    nameTh: text('name_th').notNull(),
    isSystem: boolean('is_system').notNull().default(false),
    ...timestamps,
  },
  (table) => [check('groups_code_shape', sql`${table.code} ~ '^[a-z][a-z0-9_]*$'`)],
);

/**
 * Which permissions a group carries.
 *
 * `ON DELETE RESTRICT` towards `permissions` is deliberate and is the other half of ⓓ:
 * a permission the running code does not recognise is warned about, not deleted, and if
 * somebody tries to delete one anyway the grants that depend on it stop them.
 */
export const groupPermissions = pgTable(
  'group_permissions',
  {
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    permissionCode: text('permission_code')
      .notNull()
      .references(() => permissions.code, { onUpdate: 'cascade', onDelete: 'restrict' }),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: 'group_permissions_pkey', columns: [table.groupId, table.permissionCode] }),
    index('group_permissions_permission_idx').on(table.permissionCode),
  ],
);

/**
 * Membership.
 *
 * There is deliberately no table granting a permission straight to a user. Every extra
 * path into an effective-permission set is another query that has to be got right in
 * every guard, and "why can this person refund?" has to have one answer that a support
 * conversation can reach: they are in a group, and the group holds it. A one-off need is
 * a group with one member, which is visible; a direct grant is not.
 */
export const userGroups = pgTable(
  'user_groups',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
    /** Who did it. `set null` and not `cascade`: the audit outlives the administrator's account. */
    grantedByUserId: uuid('granted_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [
    primaryKey({ name: 'user_groups_pkey', columns: [table.userId, table.groupId] }),
    index('user_groups_group_idx').on(table.groupId),
  ],
);
