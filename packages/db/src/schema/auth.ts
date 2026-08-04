import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  boolean,
  char,
  check,
  foreignKey,
  index,
  inet,
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
 *   deletion   `on delete cascade` towards the user. An erasure request has to be one
 *              `DELETE FROM users`, and anything that survives it is a leak with a
 *              paper trail.
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

export const userStatus = pgEnum('user_status', ['active', 'suspended']);

/** Why a session stopped being usable. Kept because "logged out" and "we saw a stolen token" need different words in a support conversation. */
export const sessionRevocationReason = pgEnum('session_revocation_reason', [
  'logout',
  'refresh_reuse',
  'password_changed',
  'email_changed',
  'revoked_by_admin',
]);

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
    /** Optional: a password sign-up knows an address and nothing else until the user says otherwise. */
    displayName: text('display_name'),
    status: userStatus('status').notNull().default('active'),
    suspendedAt: timestamp('suspended_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    check(
      'users_suspended_at_present',
      sql`${table.status} <> 'suspended' or ${table.suspendedAt} is not null`,
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
    revokedReason: sessionRevocationReason('revoked_reason'),
  },
  (table) => [
    index('sessions_user_idx').on(table.userId),
    index('sessions_expires_at_idx').on(table.expiresAt),
    check('sessions_expires_after_created', sql`${table.expiresAt} > ${table.createdAt}`),
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
