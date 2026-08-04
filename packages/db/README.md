# @wewin/db

The Drizzle schema and migrations for the catalogue and for auth. **Only `apps/api` may
depend on this package** — see "The import rule" below.

```
pnpm db:up                      # Postgres 18 on localhost:5433 — compose file at the repo root
cp ../../.env.example ../../.env  # one .env, at the root
pnpm db:migrate                 # apply drizzle/*.sql
pnpm db:seed                    # write the 81-product table from @wewin/core into Postgres
pnpm test                       # 85 tests; skips with a warning when DATABASE_URL is unset
```

`DATABASE_URL` is found by walking up from here to the workspace root (`src/env-file.ts`),
so the root `.env` is enough for the tests, `db:migrate` and `db:seed` alike. A `.env` in
this package still wins, which is how you point migrations at a scratch server without
repointing everything else; an exported variable wins over both. Nothing is ever defaulted
— `db:seed` truncates, and a default is how that lands on a server somebody cared about.

## Two layers

Plan section 5, and the whole shape of this package:

| | what it is | who writes it |
|---|---|---|
| **normalised** | `categories` · `products` · `option_groups` · `option_values` · `product_version_options` · `product_version_option_values` · `product_version_rules` | the dashboard, one field at a time |
| **frozen** | `product_versions.document` — one compiled JSONB per version | the publish step, once, then never again |

Web and api read the document and nothing else. An order line points at a
`product_versions.id`, so what a customer was quoted from stays retrievable after the
catalogue has moved on. `src/compile.ts` is the only thing that builds a document, and
`fromDocument` is the only thing that turns one back into a `@wewin/core` `Product`.

Two things are deliberately *not* in the document:

- **`available`** stays on `option_values`, because stock moves without a publish and a
  frozen row cannot carry a value that has to keep changing (plan 5, point 2). The api
  overlays it via `fromDocument(document, isAvailable)`. A CHECK in
  `drizzle/0001_catalog_freeze.sql` rejects any document that contains the field.
- **anything with a `bigint`** — JSON has one numeric type and it is a double, so every
  length, area and amount inside the document is a decimal string.

The elevation stays one blob. Panels have no identity and nothing ever queries for one.

## ⚠️ Publishing: archive first, publish second

`product_versions_one_published_per_product` is a **partial** unique index. Postgres
evaluates it at the end of each statement, and a partial index cannot be declared
`DEFERRABLE` — only unique *constraints* can be deferred, and a unique constraint cannot
carry a `WHERE` clause. There is no window in which two rows of a product may both be
`published`, not even one that closes before `COMMIT`.

```
1. SELECT id FROM products WHERE id = $1 FOR UPDATE   -- serialise per product
2. UPDATE product_versions SET status='archived' … WHERE status='published'
3. UPDATE product_versions SET status='published' WHERE id = $2
```

Swapping 2 and 3 raises `23505` on a transaction that would have committed a perfectly
legal state. The lock in step 1 is on the **product** row and not on any version row,
because the competing transaction may be about to insert a row that does not exist yet —
there is nothing on the other side to lock.

Use `publishProductVersion` from `@wewin/db/publish`; it is that sequence, and
`tests/publish.test.ts` runs the inversion so the claim cannot quietly stop being true.

## What the database enforces that zod cannot

`parseCatalog` in `@wewin/core/schema` validates one product against itself. Four of its
checks look across rows, which one zod object schema structurally cannot do (plan 5,
point 3):

| invariant | how |
|---|---|
| duplicate product id | `products` primary key |
| duplicate slug | `products_slug_unique` |
| duplicate `skuPrefix` | `products_sku_prefix_unique` |
| `categoryId` that does not exist | foreign key to `categories` |

Beyond those, the schema also refuses: a measurement bound off its own step or off the
25 µm lattice; a surcharge that carries both an amount of money and a percentage; a
percent surcharge in a currency; a price that is not a whole number of baht (which
`calcPrice` would throw on); an option value offered under a group it does not belong
to; and any edit to a published version's document.

Rules keep their AST in JSONB with `referenced_group_codes text[]` beside it. That column
is the handle for the one question worth asking across rows — does this rule name a group
the version actually offers? — and `publishProductVersion` refuses to publish when it
does not.

## Money and lengths

Money is `bigint` minor units (satang) with the currency in a column beside it. Lengths
are `bigint` micrometres, areas square micrometres. Never `numeric`, never
`double precision`.

`bigint(name, { mode: 'bigint' })` is load-bearing: node-postgres hands `int8` back as a
**string**, and a string that looks like a number concatenates where the domain would
have multiplied. `tests/bigint.test.ts` asserts the type — not only the value — and
round-trips 2^53 + 1 through a real server.

## The import rule

`packages/db` is a server-side detail. Web and dashboard read the compiled document over
HTTP; they never see a table.

pnpm already makes an *undeclared* import impossible — a package that does not list
`@wewin/db` cannot resolve it. What is left is a *declared* one, and that is what
`turbo boundaries` is for. This package is tagged `db` in its own `turbo.json`; the
matching rule belongs in the root `turbo.json`, which this package does not own:

```jsonc
{
  "boundaries": {
    "tags": {
      "db": { "dependents": { "allow": ["api"] } }
    }
  }
}
```

with `"tags": ["api"]` in `apps/api/turbo.json`. Until both halves exist,
`turbo boundaries` has nothing to check and the rule is back to being a review promise.

## Auth — `src/schema/auth.ts`

Written by hand rather than bought in, because LINE decides the shape (plan section 6).
Everything a hosted provider would have enforced has to be written down here instead, and
the four vulnerabilities the plan names are all cases where "here" must be Postgres and
not a service method:

| plan | attack | what closes it |
|---|---|---|
| **(a)** account pre-hijacking | attacker registers the victim's address unverified and waits for the victim to arrive through Google | `user_emails_one_verified_owner` — UNIQUE on `address` WHERE verified — plus the `user_emails_strip_unverified` trigger, which deletes every unverified claim on an address inside the statement that proved it |
| **(b)** OAuth `state` unbound | attacker starts the flow, signs in as themselves, gets the victim's browser to open the callback | `oauth_states.binding_hash`, `NOT NULL` — the digest of a cookie that only ever existed in the browser that started the flow. `SameSite=None` on that cookie because Apple posts back cross-site |
| **(c)** refresh rotation races | six dashboard panels refresh at the same instant and reuse-detection reads five of them as theft | `rotate_refresh_token()` — one statement, `consumed_at` write-once, and a 15-second grace window that answers `graced` instead of `reused` |
| **(d)** permission mismatch on boot | release N+1 adds a permission, the rollback to N does not recognise it and will not start | `permissions.code` **is** the primary key, so an upsert at boot is one statement and an unknown code in the database breaks nothing |

Two more things from section 6: `guests` gives the plan's fourth scope variant
`{ kind: 'guest', guestId }` something real to point at, so the anonymous funnel is
representable; and there is no `menu` table, because permissions are the single source of
truth and a hidden menu is not authorisation.

### What holds a secret, and why it is that shape

| column | holds | shape |
|---|---|---|
| `refresh_tokens.token_hash` · `auth_tokens.token_hash` · `oauth_states.state_hash` · `oauth_states.binding_hash` | SHA-256 of 256 random bits | `char(64)` + `CHECK ~ '^[0-9a-f]{64}$'` |
| `password_credentials.password_hash` | argon2id PHC string | `CHECK LIKE '$argon2id$%'` |
| `oauth_states.pkce_challenge` | the S256 challenge — public, already sent to the provider | plain `text`; the *verifier* rides in the httpOnly cookie and is never stored |

SHA-256 for the random tokens and argon2id for the password is the same decision made
twice from opposite premises: a 256-bit random token has no search space worth a work
factor, and a human's password has nothing but search space. The format CHECKs are the
load-bearing part — a raw base64url token is not 64 lower-case hex characters, so a
service that forgets to hash fails on the write that did it rather than storing a live
credential nothing downstream can tell from a digest. A dump of this database contains
nothing that can be replayed.

## Migrations

`drizzle/0000_catalog.sql` and `drizzle/0002_auth.sql` are generated from `src/schema` —
regenerate with `pnpm db:generate`, never edit by hand. `drizzle/0001_catalog_freeze.sql`
and `drizzle/0003_auth_guards.sql` are written by hand (via `db:generate --custom`)
because drizzle-kit does not generate triggers or functions: the first holds the freeze
triggers and the publish-order note, the second holds the auth triggers and
`rotate_refresh_token()`. All four are applied by the same `drizzle-kit migrate`, in
order.
