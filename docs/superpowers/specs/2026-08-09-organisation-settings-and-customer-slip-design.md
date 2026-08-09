# Organisation settings and the customer payment slip

**Date** 2026-08-09
**Status** approved, ready for an implementation plan
**Scope** P1 of a two-part split. P2 — VAT per destination country, the destination-country field, and the deposit percentage — is agreed in principle and **has not been specified yet**; it gets its own spec before any of it is built.

---

## Why this exists

A customer cannot pay. `POST orders/:orderId/payment-slips` and its image leg have been
complete, ownership-scoped and tested for several phases, and **no screen in `apps/web`
calls either of them** — a search of `apps/web/src` finds no occurrence of the word *slip*.
The database agrees: every one of the 16 orders sits in `awaiting_payment`, and the only
status transition ever executed is `draft → awaiting_payment`.

Closing that hole needs one thing the system does not have: somewhere to tell the customer
where to transfer money to. `payment_slips` records who paid (`payer_name`,
`payer_account_last4`) and never which company account received it, and there is no table of
company accounts at all.

So this round is: **the organisation's own details, and the screen that spends them.**

## What is in scope

1. `bank_accounts` — a list, orderable, deactivatable, with an optional PromptPay identifier.
2. `bank_account_changes` — full history of every edit to a bank account.
3. `organisation_profile` — one row: legal name, address, tax id, contact, for documents.
4. `payment_slips.received_bank_account_id` — which account the money went to.
5. A dashboard screen to edit 1 and 3.
6. A storefront page where a customer picks an account, sees a PromptPay QR, and submits a slip.
7. Four stale-comment / wrong-data fixes found while mapping (see *Incidental fixes*).

## What is deliberately out of scope

**VAT, destination country, deposit percentage.** They change money arithmetic and belong in
P2 with their own mutation testing. `apps/api/src/orders/defaults.ts` keeps standing in for
them, which is what its header already says it is for.

**The storefront footer's marketing content** — opening hours, service area, LINE. Moving
those into a settings store looks like the same job and is not; see *The static-build
constraint* below.

**Full document identity pinning.** Company details render from current settings at print
time, not from the pinned document; see *Why company details are not pinned*.

---

## Blockers that must be cleared first

### 1. A new table cannot be migrated today

`packages/db/drizzle/meta/0023_snapshot.json` does not describe what
`0023_admin_events.sql` actually creates. The snapshot records constraints named
`admin_events_one_subject` and `admin_events_group_actions_name_a_group`; the SQL file
creates `admin_events_not_both_subjects` and `admin_events_group_actions_carry_a_code`, and
only two foreign keys where the snapshot records three.

Running `drizzle-kit generate` against the current schema therefore emits a migration that
opens with:

```sql
ALTER TABLE "admin_events" DROP CONSTRAINT "admin_events_one_subject";
```

Two of the objects it drops have never existed in a database built from `drizzle/`.
`drizzle-kit migrate` aborts on the first one, long before reaching any new table.

This fails loudly and early rather than silently and destructively, which is the good
version of this problem — but it means **reconciling the 0023 snapshot is the first task of
the implementation, not a footnote.**

⚠️ `pnpm db:generate --custom` writes the journal entry *and* a full snapshot. Doing that and
then hand-writing a journal entry produces a duplicate `idx`. Worse, the auto-written
snapshot is of the whole current TypeScript schema, so dropping it in marks all outstanding
drift as already migrated and the next `db:generate` emits nothing. Whether to repair or to
absorb is a decision to make explicitly, once, with the diff visible.

### 2. Company details must not go into the pinned document

`packages/contract/src/order.ts:302` pins `documentSchemaVersion: z.literal(...)`, and
`apps/api/src/orders/order.repository.ts:722` `safeParse`s every stored document **on the way
out**, throwing `AppError.databaseUnavailable` on failure. There is no v1/v2 union reader.

Bumping `ORDER_DOCUMENT_SCHEMA_VERSION` to add seller fields would stop every already-issued
quotation from printing — all 16, in the dashboard sheet and through the customer's `?t=`
link both. `OrderDocumentWire.documentSchemaVersion` is also declared as a bare literal at
`order.ts:222`, so the exported constant is not the only edit.

This is fine, because it is also the correct behaviour: **a company that changes its address
wants old quotations reprinted at the new address.** Prices are frozen because a price is an
offer; a letterhead is not.

### 3. The word "settings" is taken

`/[locale]/settings` already exists in `apps/web` and means *the customer's own display
preferences* — language, unit, currency. Naming an admin module `settings` gives one word two
meanings in one repository.

**Everything here is named `organisation`**: permissions `organisation.read` /
`organisation.write`, dashboard route `/organisation`, tables `organisation_profile`,
`bank_accounts`, `bank_account_changes`.

---

## Storage

### `bank_accounts`

```
id                  uuid pk
bank_code           text     CHECK ~ '^[A-Z]{3,8}$'      -- KBANK, SCB, BBL, TTB…
account_number      text     CHECK ~ '^[0-9]{10,15}$'    -- digits only, punctuation stripped on the way in
account_name        text     CHECK length(trim(...)) > 0
promptpay_id        text NULL CHECK ~ '^([0-9]{10}|[0-9]{13})$'
sort_order          integer  not null default 0
is_active           boolean  not null default true
updated_by_user_id  uuid NULL references users(id) on delete set null
created_at, updated_at
```

`promptpay_id` is ten digits (a mobile number, national format) or thirteen (a tax id) —
the two forms EMVCo tag 29 accepts here. The distinction is by length, so the builder needs
no separate type column.

`bank_code` is `text` + CHECK rather than a `pgEnum` on the rule `auth.ts:119-124` states for
itself: the choice is about whether the set can *grow*. Thai banks merge — TMB and Thanachart
became ttb — so it grows.

A `bank_accounts_block_delete()` trigger refuses `DELETE`, matching `orders_block_delete()`.
Deactivation is `is_active = false`. This follows the project-wide rule that deletion is a
status flag, and is also forced by `payment_slips` referencing accounts that may be retired.

### `bank_account_changes`

Full history, because editing the receiving account number is a classic fraud pattern —
change it, wait for a transfer, change it back, leave nothing behind.

```
id                 uuid pk
bank_account_id    uuid references bank_accounts(id)
changed_by_user_id uuid NULL references users(id) on delete set null
changed_at         timestamptz not null default now()
before             jsonb NULL   -- null on create
after              jsonb NULL   -- null on deactivate-only rows
```

Append-only: a trigger refuses `UPDATE` and `DELETE`.

### `organisation_profile`

```
id                 smallint pk default 1 CHECK (id = 1)
legal_name_th      text
legal_name_en      text NULL
address_th         text
address_en         text NULL
tax_id             char(13) NULL   -- CHECK: 13 digits when present
phone              text
email              text NULL
updated_by_user_id uuid NULL references users(id) on delete set null
created_at, updated_at
```

There is no single-row table anywhere in this schema yet. `CHECK (id = 1)` puts the
constraint in Postgres rather than in the hope that no code path inserts a second row.

`tax_id` is genuinely new — nothing in the repository contains `taxId`, `tax_id`, `vatId` or
`ผู้เสียภาษี`, although a Thai quotation needs one.

### `payment_slips.received_bank_account_id`

Nullable FK. Nullable because zero slips exist today, and because a retired account must stay
referenceable.

### Erasure

`organisation_profile.updated_by_user_id`, `bank_accounts.updated_by_user_id` and
`bank_account_changes.changed_by_user_id` are all **`'scrub'`**, not `'delete'`. Erasing a
user must not erase the record that a bank account was changed; it removes the identity, not
the event.

⚠️ `ERASURE_TREATMENTS` (`auth.ts:226-455`) is `satisfies Record<string, …>`, so a mistyped
column key is **not** a compile error — only the runtime FK-coverage test catches it.

---

## Permissions

Two codes in `apps/api/src/rbac/permissions.ts`:

```
organisation.read    see the organisation profile and bank accounts
organisation.write   change the organisation profile and bank accounts
```

**No migration.** `permission-sync.service.ts` runs `onApplicationBootstrap` and does one
`insert(...).onConflictDoUpdate(...)` over `PERMISSION_CODES`. New codes reach Postgres on the
next boot. `packages/db/src/seed.ts` does not mention permissions at all and must not be
edited.

Descriptions must be ≥ 10 characters after trimming — `tests/rbac/permissions.test.ts`
enforces that, along with the code-shape regex that mirrors the Postgres CHECK.

Declaration order in `permissions.ts` is user-visible: `users.service.ts` `listGroups()`
returns `available: PERMISSION_CODES` in that order, and it is what the group-permission
checkbox list renders.

`apps/dashboard/src/lib/auth/permissions.ts` is a hand-maintained **copy** of the code list
with nothing testing parity. It must be updated by hand, and this spec adds the test that
would have caught forgetting (see *Testing*).

⚠️ Do **not** add anything to `apps/api/src/rbac/route-declarations.ts` — a route that is both
decorated and declared fails the boot audit.

---

## Routes

```
GET   admin/organisation                                    organisation.read
PUT   admin/organisation                                    organisation.write
GET   admin/organisation/bank-accounts                      organisation.read
POST  admin/organisation/bank-accounts                      organisation.write
PATCH admin/organisation/bank-accounts/:id                  organisation.write
PUT   admin/organisation/bank-accounts/:id/availability      organisation.write
GET   admin/organisation/bank-accounts/:id/changes          organisation.read

GET   orders/:orderId/payment-instructions                  @RequirePrincipal
```

`/availability` copies the shape already used at
`apps/api/src/admin/option-catalog.controller.ts:105`.

Because these paths contain `/admin`, `apps/api/tests/admin/route-permissions.test.ts` needs
rows for each — it compares in **both** directions, so a missing row and a stale row both
fail.

`apps/api/tests/rbac/route-audit.test.ts` carries the full route inventory, sorted by
`localeCompare` on `` `${METHOD} ${path}` ``. New entries go in that order.

The new module must be imported in `apps/api/src/app.module.ts`.
`tests/rbac/controller-reachability.test.ts` is what catches forgetting.

### Why the customer route is scoped to an order

`GET orders/:orderId/payment-instructions` rather than a public list of company accounts, for
two reasons. There is no need to publish account numbers to callers with no order. And **P2
makes accounts vary by destination country**, which this shape absorbs without changing the
endpoint.

It returns what the payment page needs and the customer cannot otherwise obtain:

```
{
  grandTotalThbMinor:  MoneyWire<'THB'>,
  outstandingThbMinor: MoneyWire<'THB'>,
  accounts: [
    { id, bankCode, accountNumber, accountName, promptpayId: string | null }
  ]   // is_active = true only, ordered by sort_order
}
```

⚠️ It returns `promptpayId`, **not** a ready-made QR payload. The QR encodes the amount, and
the customer may transfer something other than the outstanding figure — a partial payment, or
a rounded one. Building the payload on the server would freeze an amount the page then lets
them change, so the page rebuilds it client-side from `packages/core` whenever the amount
field changes. Inactive accounts are never returned.

`outstandingThbMinor` exists today only on the staff-facing slip-review wire, behind
`payments.read`. `GET /orders/:id` returns `grandTotalThbMinor` and nothing about what has
been received, and `order_instalments` / `order_payment_schedules` mean a client that
subtracts for itself is wrong the moment there is more than one instalment.

The existing `GET orders/:orderId/payment-slips` supplies the slip history; the page fetches
both in parallel.

---

## The static-build constraint

The footer's marketing content stays in `apps/web/src/data/company.ts` for three reasons
found by reading, not by guessing:

- `apps/web/src/lib/reviews/api.ts:44` states that **`next build` must not require a running
  API.** Identity fetched at build time would render with no company name whenever the API
  was down — on the 24 pages `showsFooter` covers, and on all 683 for anything the header
  reads, since `company.wordmark` is on every route.
- `apps/web/turbo.json` keys `build` on `$TURBO_DEFAULT$`, `.env*` and `NEXT_PUBLIC_*` only.
  Data fetched from the API is in none of them, so `turbo run build` after an admin edit is a
  **cache hit** that restores the old bytes.
- `apps/web/tests/cache-policy.test.ts:160-171` refuses `export const dynamic` outright, so
  the usual escape hatch is already closed on purpose.

The three consumers this round does feed — the dashboard print sheet, the API's rendered
document, and the customer payment page — all read at request time.

**Consequence worth naming:** `/[locale]/orders` is not in `showsFooter`'s set, so the
quotation a customer prints today carries **no company name, address or tax id at all**. The
document says what is being sold and for how much, and never who is offering it.
`organisation_profile` is not only configuration; it fills a hole in the document.

---

## The customer payment page

**Route** `/[locale]/payment?order=<uuid>`, following the query-param shape of
`/[locale]/orders?order=`.

Separate from the quotation page because a quotation is a *document* and a payment is a
*transaction*: the print stylesheet added in phase 16 should not have to fight an upload
form, the slip history needs room, and `robots` differs (`follow: false`, as on
`orders/page.tsx:41`, not `follow: true` as on the account page).

⚠️ `AccountGate`'s signed-out branch opens at `<h2>`. `AccountScreen` avoids a document with
no `<h1>` by putting the heading inside the signed-in branch; this page does the same.

### Flow

1. Read `payment-instructions` and `payment-slips` in parallel.
2. Show the outstanding amount, the slips already submitted and their status.
3. Pick an account → account number with a copy button, and a PromptPay QR when the account
   has a `promptpay_id`.
4. Choose an image; enter amount (defaulting to outstanding), transfer time, optional
   reference.
5. `POST …/payment-slips/image` → `imageHandle`.
6. `POST …/payment-slips` with the handle.

### The five traps this flow has

| Trap | What happens without handling | Handling |
|---|---|---|
| `readBoundedBody` calls `request.destroy()` *while* rejecting | An image over 8 MiB surfaces as a thrown `fetch`, lands in the `catch`, and tells the customer the **server is unreachable** about a photo that was merely too big | Check the size in the browser before sending, with the page's own sentence |
| The body is buffered before the status checks run | `POST …/image` itself returns 409 `order_not_accepting_slips` or `too_many_slips` | The `uploading` phase renders the API's sentence, not only the `creating` phase |
| `UPLOAD_HANDLE_TTL_SECONDS = 15 * 60` | The handle expires while the customer fills the form | Upload after the form is complete, not when the file is chosen |
| Nothing consumes an upload handle and `storage_key` has no uniqueness | A retry of the second call creates a **duplicate slip** | Never auto-retry the create; disable the button on the first click |
| `SessionProvider` asks once on mount and never again; `Session.expiresAt` is read by nothing | A page left open past the token lifetime 401s mid-upload with no refresh path | Catch 401, ask for sign-in again, and keep what was typed |

`checkDimensions` also refuses images over 20,000 px per side or 50 MP. `normaliseImage`
dispatches on magic bytes and handles `ftyp` → HEIC/HEIF, which matters because slips are
photographed on phones.

### Money

⚠️ `f.baht()` renders **whole baht** — `numerals.test.ts:220` pins
`f.baht(879_100n) === '฿8,791'` — and it is the only money formatter `apps/web` has. Echoing
a customer's `฿19,722.24` through it prints `฿19,722`, on a page whose entire subject is
reconciling an exact transfer.

`apps/dashboard/src/components/slips/allocation-plan.ts` already solved both directions:

```ts
readSatang(text)    // '19,722.24' → 1972224n; refuses 1e5, 19.722,24, negatives
satangField(minor)  // 1972224n → '19722.24'
```

with tests in `apps/dashboard/tests/slip-allocation.test.ts` and a comment recording that
`Math.trunc(parseFloat(text) * 100)` is wrong 2.6% of the time (`0.29` becomes `28`).

**Move both to `packages/core`** and have the dashboard import them back. `apps/web` cannot
import from `apps/dashboard`, and rewriting is rewriting the bug.

### Transfer time

`createSlipRequestSchema.transferredAt` requires a timezone designator. Verified against the
installed zod: `+07:00` ✓, `Z` ✓, no designator ✗, date-only ✗, `+0700` ✗.
`<input type="datetime-local">` produces `2026-08-09T14:30` with no designator, so the page
converts before sending. `assertTransferPlausible` allows 2 minutes of skew.

### PromptPay

`qrcode-generator` is already a dependency of `apps/web` and `QrCode.tsx:35` lazy-loads it —
the renderer exists. What does not exist is the payload: nothing in the repository mentions
PromptPay.

The EMVCo payload builder and its CRC16-CCITT go in `packages/core` as pure functions, so
they are testable without a DOM.

### i18n

Roughly 28 new keys, and every one needs all eight catalogues — `th.ts` missing a key is a
compile error and `catalogue.test.ts` requires coverage of 1 for all eight.

⚠️ `SAMPLE_PARAMS` in `catalogue.test.ts` is one shared bag, and these names are already
taken with fixed types: `count`, `total`, `translated`, `name`, `title`, `size`, `index`,
`at` (a `Date`), `unit`. Reusing one with a different type poisons the existing key.

⚠️ The `count()` plural helper exists in `de.ts`, `en.ts` and `hi.ts` only. `zh.ts`, `vi.ts`
and `my.ts` each state in their headers that there must not be one.

---

## Incidental fixes

Found while mapping; small, and three are consequences of phase 17.

| File | Problem |
|---|---|
| `apps/web/src/components/shell/LanguagePicker.tsx:82,104` | Marks `locale.partial` `lang="th"` although it is now translated in all eight; German text is announced to assistive tech as Thai. Its header still says "Six of the eight catalogues are empty" |
| `packages/core/src/quotation.ts:107` | The renderable set is `['th','en','zh','ja','de','hi','my','vi']` — it contains `ja`, which is not a storefront locale, and omits `la`, which is. **A Lao-pinned document renders degraded today** |
| `apps/web/src/components/shell/AppFooter.tsx:67` | Docstring claims the footer "appears on every route"; `showsFooter` limits it to 24 paths |
| `apps/api/src/payments/slips/slips.module.ts` | Comment says the module still has to be added to `AppModule` — it is imported at `app.module.ts:20,149`, and adding it a second time fails the boot audit |

---

## Testing

Chosen by one rule: **what breaks while the page still looks right.**

| Under test | Silent when wrong? | Mutation that must fail |
|---|---|---|
| `readSatang` / `satangField` in core | Yes — 2.6% of inputs | `* 100n` → `* 10n`; remove `,` grouping support |
| PromptPay payload + CRC16 | Completely — the QR scans, the amount is wrong | Flip the polynomial; drop the amount field; check against published reference payloads |
| `organisation_profile` single row | Yes — a second row, then documents pick one | `INSERT` a second row directly in psql; Postgres must refuse |
| `bank_accounts` delete guard | Yes | `DELETE` directly in psql; the trigger must refuse |
| `bank_account_changes` append-only | Yes — history that can be rewritten is not history | `UPDATE` and `DELETE` directly; both must be refused |
| Renderable locales ⊇ `LOCALES` | Yes — a Lao customer gets a Thai document | Remove `la` again; must go red |

### The trap that produces a green test proving nothing

`erasure.test.ts:668` counts rows for the erasure subject. **A table the fixture never seeded
counts 0 before and after**, so the assertion passes without testing anything. The file
records at lines 108-117 that this was proved by deleting a real statement and watching
twenty tests stay green.

`createSubject` must therefore be extended to seed `organisation_profile`,
`bank_accounts` and `bank_account_changes` rows attributed to the subject, or the `'scrub'`
treatments are unverified.

### The test that should already exist

`apps/dashboard/src/lib/auth/permissions.ts` is a hand-copy of the API's permission list with
nothing asserting parity. Adding `organisation.read` on the API side and forgetting the
dashboard produces a screen that exists and never appears in the menu, with no failure.

Add a source-scan test comparing the two files, in the style of `phone-authority.test.ts` and
`print.test.ts` — the established pattern here for a cross-package invariant that types
cannot express.

### The payment page's own tests

An oversize image produces a readable sentence and **not** "cannot connect". A 409 on the
upload leg renders the API's message. Two clicks produce one slip. A 401 mid-flow preserves
what was typed. A `datetime-local` value round-trips through the API's actual zod schema.

### Free coverage

`closed-account-routes.pg.test.ts` is registry-driven and covers new routes the day they
exist. `controller-reachability.test.ts` catches a forgotten `AppModule` import.
`catalogue.test.ts` enforces all eight catalogues. `route-audit.test.ts` and
`route-permissions.test.ts` fail loudly on a missed inventory entry.

### Test infrastructure notes

`packages/db/vitest.config.ts` overrides `DATABASE_URL` for every worker to
`<base>/wewin_db_test` and pins `fileParallelism: false`, `pool: 'forks'`, `maxWorkers: 1` —
a new `.pg.test.ts` joins a strictly serialised suite sharing one server. `describeDb` is
`describe.skipIf(!url)`, so a pg suite **skips silently** without a database; count the tests
rather than trusting the exit code.

### Verification by hand

The full gate, plus `pnpm --filter @wewin/web build` for `check-tokens`. Then a real browser:
submit a slip against WW-1014, read it back from psql to confirm it carries the chosen
account, and **scan the PromptPay QR with a real banking app to confirm the amount** — no
automated check substitutes for that one.

Afterwards: stop the dev servers, and close any probe account with `status='closed'` rather
than deleting it.

### Security review

Two new attack surfaces: a screen that edits the receiving bank account (change it, wait for
a transfer, change it back), and the first file-upload path open to ordinary users. The first
is answered by the append-only history. The second gets a review of magic-byte validation,
size limits and storage-key handling at the end of implementation.

---

## Build order

1. Reconcile the `0023` snapshot drift so migrations run at all.
2. Move `readSatang` / `satangField` into `packages/core`; dashboard imports them back.
3. Schema: `bank_accounts`, `bank_account_changes`, `organisation_profile`, the
   `payment_slips` column, triggers, `ERASURE_TREATMENTS`, `createSubject`.
4. Permissions and the admin routes.
5. Dashboard `/organisation` screen.
6. `GET orders/:orderId/payment-instructions`.
7. PromptPay payload in `packages/core`.
8. The storefront payment page, its ~28 keys across eight catalogues.
9. Incidental fixes.
10. Gate, browser, QR scan, security review.

Steps 2 and 7 are pure functions with no dependency on the rest and can be built first if a
green test is wanted early.
