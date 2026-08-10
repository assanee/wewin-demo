# VAT per Destination Country, the Destination Field, and the Deposit Percentage — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the three numbers `apps/api/src/orders/defaults.ts` stands in for — the VAT rate, the VAT treatment, and the deposit percentage — into per-destination-country configuration an admin can edit, and make the quotation compute and print from it.

**Architecture:** A new `tax_countries` table carries a rate, a treatment and a `prices_include_tax` flag per ISO country, with an append-only change history modelled exactly on P1's `bank_accounts` pair. At submit, the order's destination resolves to a `DestinationTax` which selects `fromNet` (exclusive) or `fromGrand` (inclusive) — both functions already exist in `packages/core/src/vat.ts` — and the resolved rate, treatment, country code and basis are pinned onto the document. The deposit percentage becomes one company-wide number on `organisation_profile`, read once in the submit transaction and threaded to both the schedule planner and the concession floor.

**Tech Stack:** pnpm workspaces + Turborepo · NestJS 11 (`apps/api`) · Next.js 15 App Router (`apps/dashboard`, `apps/web`) · Drizzle ORM + PostgreSQL 17 · zod 4.4.3 · vitest · oxlint

**Spec:** `docs/superpowers/specs/2026-08-10-vat-per-destination-and-deposit-design.md` — read the section a task names before starting it. The spec's §-numbers are cited throughout.

---

## Global Constraints

Copied from the spec. Every task's requirements implicitly include this section.

- **Deletion is always a status flag, never a real DELETE.** Standing project rule, enforced mechanically by `*_block_delete` triggers. Never write `DELETE FROM` against a configuration table.
- **`TaxRule` stays two fields.** `{ rateBp: number; treatment: TaxTreatment }`. No basis flag is ever added to it — the basis travels beside it, never inside it. (Spec §3.)
- **`grandMinor` always includes VAT.** `vatMinor` is always derived, never typed by a human. (`packages/core/src/vat.ts:11-14`.)
- **No column DEFAULT for a business placeholder number.** `apps/api/src/orders/defaults.ts:12-15` forbids it by name: *"a `DEFAULT 700` in a migration is exactly how a placeholder becomes a fact nobody remembers choosing"*. Structural defaults (`is_active DEFAULT true`, `sort_order DEFAULT 0`) follow P1's `bank_accounts` and are fine.
- **Both new pinned document fields are OPTIONAL and must appear in `orderDocumentWireSchema` AND the `OrderDocumentWire` interface.** A field written to the JSON but undeclared is silently stripped on every read, forever, and the freeze trigger means it can never be repaired. (Spec §6.2.)
- **`documentSchemaVersion` does not change.** A bump 503s all 21 issued quotations.
- **Money is `bigint` minor units** (`THB.satang`). Never `number`. Rendering uses the existing sign-split `f.baht`, never a fresh division — `-150n` naively rendered gives `-1.-50`.
- **Hand-written migrations get a journal entry and a `.sql` file, and NO snapshot.** `pnpm db:generate --custom` does **not** diff the schema; it clones the previous snapshot forward. 0022, 0024, 0025 and 0028 have no snapshot and that is correct.
- **Migration and `ERASURE_TREATMENTS` ship in the same change.** The coverage test reads `information_schema`, so it fails in both directions if they are split.
- **`vitest run` does not type-check.** esbuild strips types. Type errors only surface under `pnpm typecheck`.
- **Only `wewin` needs `pnpm db:migrate` by hand.** `wewin_api_test` and `wewin_db_test` are dropped, re-created and migrated by their own `globalSetup` on every run.
- **Eight storefront locales**, `['de','en','hi','la','my','th','vi','zh']`. `th.ts` is typed `UiCatalogue` (a missing key is a compile error); the other seven are `PartialUiCatalogue` and fail only at `apps/web/src/i18n/catalogue.test.ts:446`.
- **No new permission code.** P2 reuses `organisation.read` / `organisation.write`.
- **Never pre-judge a reviewer's finding.** If a step here conflicts with what the code actually does, stop and report it — this plan has already been wrong twice about how deep a seam sits.

---

## Verified Repo Facts — read this before any task

The first draft of this plan guessed at these and was wrong about every one. Each line below was
checked first-hand against the file or the running database. **Where a task's snippet disagrees
with this section, this section wins.**

**Package entry points.** The root export of `@wewin/db`, `@wewin/contract` and `@wewin/i18n` is
**types-only** — `{ "types": "./dist/index.d.ts" }` with no runtime condition. Importing a value
from the root throws `ERR_PACKAGE_PATH_NOT_EXPORTED` at boot. Runtime values come from explicit
subpaths, and the maps are **hand-maintained with no wildcard**:

```ts
import type { Database } from '@wewin/db';                          // types: root is fine
import { taxCountries, taxCountryChanges } from '@wewin/db/schema';  // values: subpath
import { and, asc, eq } from '@wewin/db/sql';                        // drizzle operators
import { LOCALES } from '@wewin/i18n/locales';                       // not from '@wewin/i18n'
import { orderDocumentWireSchema } from '@wewin/contract/order';
```

**A new contract module needs a new exports entry.** `packages/contract/src/tax.ts` (Task 2) is
unreachable until `"./tax": "./dist/tax.js"` is added to `packages/contract/package.json`'s
`exports`. Adding a re-export to `src/index.ts` does **not** make it importable at runtime.

**A filtered test run must use `exec vitest run`, never `test -- <pattern>`.** `pnpm run test --
<pattern>` hands `--` to vitest, which ignores it *and* the pattern and runs the whole suite —
exiting 0. Verified: `pnpm --filter @wewin/dashboard test -- navigation` ran 19 files / 221 tests;
`pnpm --filter @wewin/dashboard exec vitest run navigation` ran 1 file / 9 tests. **Every "run it and
watch it fail" step in this plan depends on this**: with the wrong form an implementer sees a green
suite, concludes the new test passes, and never notices it was not collected.

**`apps/api`'s test script type-checks first:** `tsc -p tsconfig.build.json && vitest run`. A
step that deliberately leaves a type error cannot use `pnpm --filter @wewin/api test` — vitest
never runs. Use `pnpm --filter @wewin/api exec vitest run <pattern>` when that is the situation.

**There is no DOM or component test infrastructure, deliberately.** Both `apps/web` and
`apps/dashboard` use `environment: 'node'` with `include: ['tests/**/*.test.ts',
'src/**/*.test.ts']`, and each config carries a comment explaining that components are
deliberately not rendered. There is no `@testing-library/*`, no `jsdom`, no `msw` anywhere in the
repo. **A `.test.tsx` file is not collected and silently never runs.**

Tasks 6, 13 and 15 therefore test in the repo's own idiom, decided by the owner:
- pure logic and API-module tests as `*.test.ts` under `tests/` or beside the source;
- `renderToStaticMarkup` from `react-dom/server` where markup genuinely needs asserting;
- and the browser step each of those tasks already carries, which is where interaction is checked.

Do **not** add a testing library. The configs' comments are a decision, and a tax feature is not
the place to reverse it.

**`packages/db/tests/support/db.ts` exports** — there is no `withDb`:

```ts
export const describeDb = describe.skipIf(!url);   // :24
export async function connect(): Promise<Database>  // :47
export async function connectPool(): Promise<Pool>  // :70
export const PG = { … }                             // :83  — error-code constants
export function errorCode(error: unknown): string | undefined  // :101
```

Use `const db = await connect();` at the top of each `it`. For a CHECK or trigger violation,
prefer `packages/db/tests/erasure.test.ts`'s own `expectViolation` (`:58`) and `expectRefusal`
(`:195`) over a bare `rejects.toThrow`.

**`packages/db/tests/erasure.test.ts` helpers** — there is no `eraseUser`:

```ts
async function createSubject(db: Database, label: string): Promise<Subject>   // :81 — TWO args
const erase = (db, userId, requestedBy = null) => …                          // :179
```

**`erase_user` takes four parameters and the user one is `p_user`:**
`erase_user(p_user uuid, p_requested_by uuid, p_channel text, p_legal_basis text)`. plpgsql
resolves identifiers at execution, so a body referring to a name that does not exist applies
cleanly and then raises on every call.

**Dump it with `pg_get_functiondef`, not `prosrc`.** `pg_proc.prosrc` is only the inner block —
it begins at `DECLARE` and ends at `END;`, with no parameter list, no `RETURNS`, no `AS $$ … $$`
and no `LANGUAGE plpgsql`:

```bash
docker exec wewin-demo-postgres-1 psql -U wewin -d wewin -tAc \
  "SELECT pg_get_functiondef(oid) FROM pg_proc WHERE proname = 'erase_user'" > /tmp/erase_user.sql
```

**`AllowAnonymous` demands a reason:** `export function AllowAnonymous(reason: string)`
(`apps/api/src/rbac/access.ts:114`). The boot-time route audit prints it. `@AllowAnonymous()`
with no argument does not compile.

**There is no `harness()` to copy.** `apps/api/tests/organisation/organisation.pg.test.ts` is
`beforeAll`-scoped closures (`app`, `db`, `reader`, `writer`) calling routes through raw `fetch`.
Where a task's snippet says `harness()`, **write** one, lifting `makeActor` (`:84`) and the app
boot helper from `apps/api/tests/support`, and state its return shape in the task's own commit.

**`ScopedOrder` is a hand-written interface with an ownership brand**
(`apps/api/src/orders/scope/scoped-order.ts:46`), and `ORDER_COLUMNS` in the same file is the
only column set a scoped load selects. **A new database column does not appear on it.** Any task
reading `order.destinationCountry` must extend both.

**`payInFullTerms()`** exists at `apps/api/src/payments/schedule/terms.ts:54`, beside
`depositPercentTerms` (`:71`) and `depositFixedTerms` (`:85`).

**`pinsForSubmit` returns an object, not an array**, and contains a fail-closed check that must
survive:

```ts
  async pinsForSubmit(tx: LedgerTx, grandTotalThbMinor: bigint): Promise<{
    readonly instalments: readonly PlannedInstalment[];
    readonly scheduledDepositThbMinor: bigint;
    readonly forfeitPolicyId: string;
  }>
```

`effectiveForfeitPolicy(tx)` is consulted inside it and throws when no policy is in force. **Show
the change as a diff against the existing body; never as a replacement body.**

**`PrintableQuotation` carries formatted strings, not minor units.** `PrintableLine` has
`netText: string`; `charges` is `{ labelTh: string; amountText: string }[]`. Assert money
footing against the `PinnedDocument` instead, which does carry minor units —
`PinnedLine.netMinor` (`packages/core/src/quotation.ts:48`) and `PinnedCharge.amountMinor`
(`:53`).

**`applyOverrides` has three call sites, not five:** `apps/api/src/quotes/quotes.service.ts:864`,
`apps/api/src/orders/order-document.ts:266`, and `apps/api/tests/quotes/overrides.test.ts:69`.

**`measureFor` has three callers and `gate` is not one of them.** The chain is
`measureCashflow` → `measureFor` → { `measure` (`:139`), `assess` (`:247`), `request` (`:407`) },
and `gate` calls `assess` (`:359`). Two of those entry points are reached from HTTP controllers
with no submit transaction.

**`OrganisationService.putProfile(actorUserId, input)`** — that name, and the **actor comes
first** (`apps/api/src/organisation/organisation.service.ts:111`). Its request schema is
`organisationProfilePutSchema`. There is no `updateProfile`.

**`AppError`'s message and details are separate.** The first argument becomes `Error.message`; a
`{ reason }` object goes to `details`, which `expect(...).rejects.toThrow(/reason/)` never sees.
Assert `rejects.toMatchObject({ details: { reason: '…' } })`.

---

## File Structure

**New files**

| Path | Responsibility |
|---|---|
| `packages/db/src/schema/tax.ts` | `taxCountries`, `taxCountryChanges` Drizzle tables |
| `packages/db/drizzle/0029_tax_countries.sql` | the two tables, their triggers, `organisation_profile.deposit_bp`, `organisation_profile_changes`, the `TH` seed |
| `packages/db/drizzle/0030_erase_tax_actors.sql` | `erase_user()` re-emitted whole with three new scrub statements |
| `packages/db/drizzle/0031_order_destination.sql` | `orders.destination_country` |
| `packages/db/tests/tax.pg.test.ts` | table guards, CHECKs, seed, and the three named scrub tests |
| `packages/contract/src/tax.ts` | tax-country request/response wires and `DESTINATION_TAX_BASES` |
| `apps/api/src/organisation/tax-country.repository.ts` | queries, including the `.for('update')` pre-image read |
| `apps/api/src/organisation/tax-country.service.ts` | write + history in one transaction; `resolveDestination` |
| `apps/api/tests/organisation/tax-country.pg.test.ts` | history contiguity, the lock, refusal semantics |
| `apps/dashboard/src/components/organisation/tax-countries.tsx` | the admin table and its form |
| `apps/web/src/components/quote/DestinationSelect.tsx` | the storefront country picker |

**Modified files** — with what changes and why

| Path | Change |
|---|---|
| `packages/db/src/schema/organisation.ts` | `depositBp` column; `organisationProfileChanges` table |
| `packages/db/src/schema/auth.ts` | three `ERASURE_TREATMENTS` entries, all `scrub` |
| `packages/db/src/schema/order.ts` | `destinationCountry` column |
| `packages/db/tests/erasure.test.ts` | three named scrub tests + `createSubject` rows |
| `packages/contract/src/order.ts` | `orderDocumentWireSchema` + `OrderDocumentWire` gain two optional fields; `orderContactRequestSchema` + `OrderContactRequestWire` gain `destinationCountry`; `OrderContactWire` gains it for read-back |
| `packages/core/src/vat.ts` | header clause 2 amended (spec §3) |
| `packages/core/src/quotation.ts` | `PinnedDocument` gains `destinationCountry` + `taxBasis`; `printableQuotation` picks a layout |
| `apps/api/src/orders/order-document.ts` | `PriceOrderParams` gains the two fields; the `withHash` literal writes them |
| `apps/api/src/orders/orders.service.ts` | resolve before pricing; pass the rule; pin from it; write the column; supply `depositBp` |
| `apps/api/src/quotes/overrides.ts` | `ApplyOverridesInput` gains `basis`; `:224` and `:268` branch on it; the stale `:256` comment is corrected |
| `apps/api/src/quotes/quotes.service.ts` | `effective()` takes rule + basis; five call sites resolve the destination |
| `apps/api/src/quotes/authority/concession.ts` | `measureCashflow` gains `floorBp` |
| `apps/api/src/quotes/authority/authority.service.ts` | `measureFor` threads the floor; the stale prose at `:66-74` is corrected |
| `apps/api/src/payments/lifecycle/lifecycle.service.ts` | `pinsForSubmit` gains `depositBp` and selects terms |
| `apps/api/src/organisation/organisation.{controller,service,repository}.ts` | tax-country routes; `deposit_bp` in the profile payload with history |
| `apps/api/src/rbac/…` | **nothing** — no new permission code |
| `apps/api/tests/admin/route-permissions.test.ts` | five new `/admin` route keys |
| `apps/api/tests/rbac/route-audit.test.ts` | six new route lines, sorted |
| `apps/web/src/i18n/keys.ts` + all eight `catalogues/*.ts` | four keys deleted, one renamed, one added |
| `apps/web/src/app/[locale]/page.tsx`, `about/page.tsx`, `components/shell/AppFooter.tsx`, `components/quote/QuoteScreen.tsx`, `components/configurator/{ConfiguratorIsland,PriceSummary}.tsx` | VAT-claim render sites removed |
| `apps/web/src/components/quotation/QuotationIsland.tsx` + `apps/dashboard/src/components/quotes/quotation-sheet.tsx` | inclusive layout, together |

---

## Task Order and Why

Tasks 1–6 build the settings and can be reviewed without touching pricing. Task 7 is the resolver. Tasks 8–12 are the pricing changes, in dependency order — the rule must reach the document (9) before the quote screen can agree with it (11). Tasks 13–15 are customer-facing.

**Task 9 is the one that decides whether this feature exists at all.** Everything before it configures a number nobody reads.

---

### Task 1: The tables, the migration, and erasure — one deliverable

**Files:**
- Create: `packages/db/src/schema/tax.ts`
- Create: `packages/db/drizzle/0029_tax_countries.sql`
- Create: `packages/db/drizzle/0030_erase_tax_actors.sql`
- Create: `packages/db/tests/tax.pg.test.ts`
- Modify: `packages/db/src/schema/organisation.ts`
- Modify: `packages/db/src/schema/auth.ts` (`ERASURE_TREATMENTS`)
- Modify: `packages/db/src/schema/index.ts` (export the new module)
- Modify: `packages/db/drizzle/meta/_journal.json`
- Modify: `packages/db/tests/erasure.test.ts`

**Why one task, not four:** Drizzle puts a new column into every generated INSERT, so the tree cannot be green between the schema change and the migration. And `packages/db/tests/erasure.test.ts:663-682` reads `information_schema` and asserts live-FKs-minus-declared **and** declared-minus-live are both empty — so a migration without its treatments fails, and treatments without their migration fail too. P1 learned both of these the hard way.

**Interfaces:**
- Produces: `taxCountries`, `taxCountryChanges` (Drizzle tables, exported from `@wewin/db`); `organisationProfileChanges`; `organisationProfile.depositBp`.
- Consumes: nothing.

- [ ] **Step 1: Write the failing test**

Create `packages/db/tests/tax.pg.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { connect, describeDb, type Database } from './support/db.js';

/*
 * There is no `withDb` in this repo — the helper is `connect()` (support/db.ts:47). One local
 * wrapper keeps each `it` a single statement without inventing a shared API that does not exist.
 */
const withConnection = async (body: (db: Database) => Promise<void>): Promise<void> => {
  const db = await connect();
  await body(db);
};

describeDb('tax_countries', () => {
  it('seeds exactly Thailand, at the defaults defaults.ts stands in for', async () => {
    await withConnection(async (db) => {
      const rows = await db.execute(sql`
        select code, rate_bp, treatment, prices_include_tax, is_active
        from tax_countries order by code
      `);
      expect(rows.rows).toStrictEqual([
        { code: 'TH', rate_bp: 700, treatment: 'standard', prices_include_tax: false, is_active: true },
      ]);
    });
  });

  it('refuses a rate above 100 per cent, which core would happily compute', async () => {
    await withConnection(async (db) => {
      await expect(
        db.execute(sql`
          insert into tax_countries (code, name_th, rate_bp, treatment, prices_include_tax)
          values ('SG', 'สิงคโปร์', 15000, 'standard', true)
        `),
      ).rejects.toThrow(/tax_countries_rate_in_range/u);
    });
  });

  it('refuses a treatment outside the four', async () => {
    await withConnection(async (db) => {
      await expect(
        db.execute(sql`
          insert into tax_countries (code, name_th, rate_bp, treatment, prices_include_tax)
          values ('MY', 'มาเลเซีย', 600, 'reduced', false)
        `),
      ).rejects.toThrow(/tax_countries_treatment_allowed/u);
    });
  });

  it('refuses a lower-case or three-letter code', async () => {
    await withConnection(async (db) => {
      await expect(
        db.execute(sql`
          insert into tax_countries (code, name_th, rate_bp, treatment, prices_include_tax)
          values ('sg', 'สิงคโปร์', 900, 'standard', true)
        `),
      ).rejects.toThrow(/tax_countries_code_shape/u);
    });
  });

  it('cannot be deleted — withdrawal is is_active, per the standing project rule', async () => {
    await withConnection(async (db) => {
      await expect(db.execute(sql`delete from tax_countries where code = 'TH'`)).rejects.toThrow(
        /deactivate it instead of deleting it/u,
      );
    });
  });

  it('records history that cannot be edited or un-recorded', async () => {
    await withConnection(async (db) => {
      await db.execute(sql`
        insert into tax_country_changes (tax_country_code, after)
        values ('TH', '{"rateBp":700}'::jsonb)
      `);
      await expect(
        db.execute(sql`update tax_country_changes set after = '{"rateBp":0}'::jsonb`),
      ).rejects.toThrow(/append-only/u);
      await expect(db.execute(sql`delete from tax_country_changes`)).rejects.toThrow(/append-only/u);
    });
  });
});

describeDb('organisation_profile.deposit_bp', () => {
  it('starts at payment in full, and the column carries no DEFAULT', async () => {
    await withConnection(async (db) => {
      const value = await db.execute(sql`select deposit_bp from organisation_profile where id = 1`);
      expect(value.rows[0]).toStrictEqual({ deposit_bp: 10000 });

      const column = await db.execute(sql`
        select column_default, is_nullable from information_schema.columns
        where table_name = 'organisation_profile' and column_name = 'deposit_bp'
      `);
      expect(column.rows[0]).toStrictEqual({ column_default: null, is_nullable: 'NO' });
    });
  });

  it('refuses zero, because depositPercentTerms refuses zero', async () => {
    await withConnection(async (db) => {
      await expect(
        db.execute(sql`update organisation_profile set deposit_bp = 0 where id = 1`),
      ).rejects.toThrow(/organisation_profile_deposit_in_range/u);
    });
  });
});
```

> **On the helpers:** `packages/db/tests/support/db.ts` exports `describeDb` (`:24`), `connect()` (`:47`), `PG` (`:83`) and `errorCode()` (`:101`). There is **no `withDb`**. For the CHECK and trigger assertions above, prefer `expectViolation` (`packages/db/tests/erasure.test.ts:58`) and `expectRefusal` (`:195`) over a bare `rejects.toThrow` — they assert on the Postgres error code as well as the message, so a rule that starts failing for a different reason is not silently accepted.

- [ ] **Step 2: Run the test and watch it fail for the right reason**

```bash
pnpm --filter @wewin/db exec vitest run tax.pg.test.ts
```

Expected: FAIL with `relation "tax_countries" does not exist`. If it fails with a missing-helper import error instead, fix the import (Step 1's note) and re-run until the failure is the missing relation.

- [ ] **Step 3: Write the Drizzle schema**

Create `packages/db/src/schema/tax.ts`:

```ts
import { boolean, char, check, index, integer, pgTable, text, timestamp, uuid, jsonb } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './auth';

/**
 * A destination the company actually sells to, and what tax it attracts there.
 *
 * `treatment` is `text` + CHECK rather than a `pgEnum`, following `bank_accounts.bank_code`:
 * the set is data, and an enum makes changing it a migration.
 *
 * `prices_include_tax` is the switch the whole feature turns on. It does NOT belong on
 * `TaxRule` — see the spec's §3 and the amended header of `packages/core/src/vat.ts`. It
 * says what a catalogue number *means* for this destination, and the caller picks
 * `fromNet` or `fromGrand` from it.
 */
export const taxCountries = pgTable(
  'tax_countries',
  {
    code: char('code', { length: 2 }).primaryKey(),
    nameTh: text('name_th').notNull(),
    rateBp: integer('rate_bp').notNull(),
    treatment: text('treatment').notNull(),
    pricesIncludeTax: boolean('prices_include_tax').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    updatedByUserId: uuid('updated_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('tax_countries_code_shape', sql`${t.code} ~ '^[A-Z]{2}$'`),
    /*
     * The ceiling has to be here. `assertRate` (packages/core/src/vat.ts:40-44) rejects
     * non-integers and negatives and has NO upper bound — a rate of 15000 computes without
     * complaint — and this table is read by code that calls core directly.
     */
    check('tax_countries_rate_in_range', sql`${t.rateBp} between 0 and 10000`),
    check(
      'tax_countries_treatment_allowed',
      sql`${t.treatment} in ('standard', 'zero_rated', 'exempt', 'out_of_scope')`,
    ),
    check('tax_countries_name_says_something', sql`length(btrim(${t.nameTh})) > 0`),
    index('tax_countries_active_idx').on(t.isActive, t.sortOrder),
  ],
);

/**
 * Append-only, before and after, every field.
 *
 * A VAT rate is the input to a ภ.พ.30 filing. The attack this guards is the same shape as
 * the one `bank_account_changes` guards: set a country to `zero_rated` for one deal, then set
 * it back. The pinned document proves what rate ran; only this table proves who moved it.
 */
export const taxCountryChanges = pgTable(
  'tax_country_changes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taxCountryCode: char('tax_country_code', { length: 2 })
      .notNull()
      .references(() => taxCountries.code, { onDelete: 'restrict' }),
    changedByUserId: uuid('changed_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
    before: jsonb('before'),
    after: jsonb('after').notNull(),
  },
  (t) => [index('tax_country_changes_code_idx').on(t.taxCountryCode, t.changedAt)],
);
```

- [ ] **Step 4: Add `depositBp` and the profile history table**

In `packages/db/src/schema/organisation.ts`, add to the `organisationProfile` column list:

```ts
  /*
   * The share of the grand total that must be received before production may start.
   *
   * No `.default()`. `apps/api/src/orders/defaults.ts:12-15` forbids a column default for a
   * placeholder business number by name; migration 0029 writes 10000 into the single row
   * instead, so the value sits somewhere a person can see it was chosen.
   *
   * Lower bound 1, not 0: `depositPercentTerms` already refuses 0 bp
   * (`apps/api/src/payments/schedule/plan.test.ts:171-177`), and the CHECK reports that
   * refusal at the layer where it is cheap instead of at submit.
   */
  depositBp: smallint('deposit_bp').notNull(),
```

⚠️ **`.notNull()` with no `.default()` makes the field required in Drizzle's insert type.** Any
existing code that inserts an `organisationProfile` row — the seed, a test fixture, a bootstrap
path — stops compiling until it supplies `depositBp`. Grep for `organisationProfile` inserts before
Step 7 and fix each one to pass `10_000`, in the same commit. This is the intended trade: the
alternative is a column default, which `defaults.ts:12-15` forbids for exactly this number.

and to its constraint list:

```ts
    check('organisation_profile_deposit_in_range', sql`${t.depositBp} between 1 and 10000`),
```

Then add, in the same file:

```ts
/**
 * The letterhead did not have a history and now does.
 *
 * D4 put the deposit percentage on this row, and a deposit percentage is a money control —
 * it is the line that decides what counts as a concession needing approval. Once one audited
 * field lives here the whole row is cheaper to audit than to split, and the side effect is
 * that changing the company's tax id also stops being untraceable.
 */
export const organisationProfileChanges = pgTable(
  'organisation_profile_changes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    changedByUserId: uuid('changed_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
    before: jsonb('before'),
    after: jsonb('after').notNull(),
  },
  (t) => [index('organisation_profile_changes_at_idx').on(t.changedAt)],
);
```

Add `smallint`, `check`, `index`, `jsonb` to that file's `drizzle-orm/pg-core` import and `sql` from `drizzle-orm` if they are not already there. Export `./tax` from `packages/db/src/schema/index.ts` beside the existing `./organisation` export.

- [ ] **Step 5: Write migration 0029 by hand**

Create `packages/db/drizzle/0029_tax_countries.sql`. Match `0027_organisation.sql`'s house style exactly: a banner comment per section, `--> statement-breakpoint` between statements, and a comment saying *why* above each trigger.

```sql
-- ─────────────────────────────────────────────────────────────────────────────
-- ⭐ WHERE THE GOODS ARE GOING, AND WHAT TAX THAT ATTRACTS
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Until this migration `DEFAULT_VAT_RULE` was the only rate the system had, and
-- `apps/api/src/orders/defaults.ts` said so: "the question it is standing in for" was
-- whether an overseas customer is zero-rated. This table is where that question gets an
-- answer per destination — and, deliberately, only for destinations somebody entered on
-- purpose. Nothing here seeds a foreign rate.

CREATE TABLE "tax_countries" (
  "code" char(2) PRIMARY KEY NOT NULL,
  "name_th" text NOT NULL,
  "rate_bp" integer NOT NULL,
  "treatment" text NOT NULL,
  "prices_include_tax" boolean NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "updated_by_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "tax_countries_code_shape" CHECK ("code" ~ '^[A-Z]{2}$'),
  -- packages/core/src/vat.ts assertRate has no upper bound; 15000 bp would compute.
  CONSTRAINT "tax_countries_rate_in_range" CHECK ("rate_bp" BETWEEN 0 AND 10000),
  CONSTRAINT "tax_countries_treatment_allowed"
    CHECK ("treatment" IN ('standard', 'zero_rated', 'exempt', 'out_of_scope')),
  CONSTRAINT "tax_countries_name_says_something" CHECK (length(btrim("name_th")) > 0)
);
--> statement-breakpoint

ALTER TABLE "tax_countries" ADD CONSTRAINT "tax_countries_updated_by_user_id_users_id_fk"
  FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

CREATE INDEX "tax_countries_active_idx" ON "tax_countries" ("is_active","sort_order");
--> statement-breakpoint

-- A country is withdrawn, not removed. Orders and documents record its code, and
-- `tax_country_changes` points at it; a row that can vanish takes their meaning with it.
CREATE FUNCTION tax_countries_block_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'tax country % is recorded on orders and quotations; deactivate it instead of deleting it', OLD.code
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER tax_countries_block_delete
  BEFORE DELETE ON tax_countries
  FOR EACH ROW EXECUTE FUNCTION tax_countries_block_delete();
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ⭐ WHO MOVED THE RATE, AND FROM WHAT
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Set a country to zero-rated for one deal and set it back: the pinned documents prove
-- which rate ran, and nothing else would show that the policy was flipped around them.

CREATE TABLE "tax_country_changes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tax_country_code" char(2) NOT NULL,
  "changed_by_user_id" uuid,
  "changed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "before" jsonb,
  "after" jsonb NOT NULL
);
--> statement-breakpoint

ALTER TABLE "tax_country_changes" ADD CONSTRAINT "tax_country_changes_tax_country_code_tax_countries_code_fk"
  FOREIGN KEY ("tax_country_code") REFERENCES "public"."tax_countries"("code") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "tax_country_changes" ADD CONSTRAINT "tax_country_changes_changed_by_user_id_users_id_fk"
  FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

CREATE INDEX "tax_country_changes_code_idx" ON "tax_country_changes" ("tax_country_code","changed_at");
--> statement-breakpoint

CREATE FUNCTION tax_country_changes_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'tax_country_changes is append-only; a change to a tax rate cannot be un-recorded'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER tax_country_changes_append_only
  BEFORE UPDATE OR DELETE ON tax_country_changes
  FOR EACH ROW EXECUTE FUNCTION tax_country_changes_append_only();
--> statement-breakpoint

-- Thailand, and only Thailand. Its numbers come from DEFAULT_VAT_RULE so the two cannot
-- disagree on day one. A foreign rate is a tax registration somebody has to actually hold —
-- seeding one would put an unverified number where it looks verified.
INSERT INTO "tax_countries" ("code", "name_th", "rate_bp", "treatment", "prices_include_tax", "sort_order")
VALUES ('TH', 'ไทย', 700, 'standard', false, 0);
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ⭐ THE DEPOSIT, AS ONE COMPANY-WIDE NUMBER
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Three statements, not one, and deliberately: no DEFAULT. `apps/api/src/orders/defaults.ts`
-- forbids a column default for a placeholder business number in so many words. Adding the
-- column nullable, writing the value, then tightening to NOT NULL leaves 10000 visible as a
-- decision in this file rather than invisible in a catalogue.

ALTER TABLE "organisation_profile" ADD COLUMN "deposit_bp" smallint;
--> statement-breakpoint

UPDATE "organisation_profile" SET "deposit_bp" = 10000 WHERE "deposit_bp" IS NULL;
--> statement-breakpoint

ALTER TABLE "organisation_profile" ALTER COLUMN "deposit_bp" SET NOT NULL;
--> statement-breakpoint

-- 1, not 0: depositPercentTerms already refuses 0 bp.
ALTER TABLE "organisation_profile" ADD CONSTRAINT "organisation_profile_deposit_in_range"
  CHECK ("deposit_bp" BETWEEN 1 AND 10000);
--> statement-breakpoint

CREATE TABLE "organisation_profile_changes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "changed_by_user_id" uuid,
  "changed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "before" jsonb,
  "after" jsonb NOT NULL
);
--> statement-breakpoint

ALTER TABLE "organisation_profile_changes" ADD CONSTRAINT "organisation_profile_changes_changed_by_user_id_users_id_fk"
  FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

CREATE INDEX "organisation_profile_changes_at_idx" ON "organisation_profile_changes" ("changed_at");
--> statement-breakpoint

CREATE FUNCTION organisation_profile_changes_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'organisation_profile_changes is append-only; a change to the company record cannot be un-recorded'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER organisation_profile_changes_append_only
  BEFORE UPDATE OR DELETE ON organisation_profile_changes
  FOR EACH ROW EXECUTE FUNCTION organisation_profile_changes_append_only();
```

- [ ] **Step 6: Add the journal entry by hand — and no snapshot**

Append to `entries` in `packages/db/drizzle/meta/_journal.json`, after the `0028` entry:

```json
{ "idx": 29, "version": "7", "when": 1786400000000, "tag": "0029_tax_countries", "breakpoints": true }
```

Do **not** run `pnpm db:generate --custom`. It does not diff the schema — it writes a snapshot that is a copy of the previous one with a new uuid, and a later plain `db:generate` would then re-emit `CREATE TABLE` for these tables. 0022, 0024, 0025 and 0028 have no snapshot; this one does not either.

- [ ] **Step 7: Run the test — the tax and deposit assertions should now pass, and erasure should now fail**

```bash
pnpm --filter @wewin/db test
```

Expected: `tax.pg.test.ts` PASSES. `erasure.test.ts` **FAILS** with `a foreign key that no treatment names` listing `organisation_profile_changes.changed_by_user_id`, `tax_countries.updated_by_user_id`, `tax_country_changes.changed_by_user_id`. That failure is the point of the next step — the coverage test reads `information_schema`, so the migration alone trips it.

- [ ] **Step 8: Declare the three treatments**

In `packages/db/src/schema/auth.ts`, beside the existing organisation entries at `:464-466`, add:

```ts
  /*
   * Staff actor ids on configuration rows, exactly like the P1 three above. `scrub`, not
   * `delete`: the row is the company's tax policy and its history, and neither stops being
   * true because the person who typed it exercised erasure.
   */
  'tax_countries.updated_by_user_id': 'scrub',
  'tax_country_changes.changed_by_user_id': 'scrub',
  'organisation_profile_changes.changed_by_user_id': 'scrub',
```

- [ ] **Step 9: Re-emit `erase_user()` whole, with the three new scrubs**

Dump the current body first — the function must be carried verbatim, not reconstructed:

```bash
docker exec wewin-demo-postgres-1 psql -U wewin -d wewin -tAc \
  "SELECT pg_get_functiondef(oid) FROM pg_proc WHERE proname = 'erase_user'" > /tmp/erase_user.sql
wc -l /tmp/erase_user.sql
```

Create `packages/db/drizzle/0030_erase_tax_actors.sql` as `CREATE OR REPLACE FUNCTION erase_user(...)` carrying that definition **unchanged** — all four parameters (`p_user`, `p_requested_by`, `p_channel`, `p_legal_basis`), the `RETURNS`, the `AS $$` wrapper and `LANGUAGE plpgsql` included, plus one new block before its final `RETURN`:

```sql
  -- ── tax and profile actors ────────────────────────────────────────────────
  UPDATE tax_countries SET updated_by_user_id = NULL WHERE updated_by_user_id = p_user;

  -- ⚠️ These two tables are append-only. `session_replication_role = replica` is the
  -- sanctioned bypass (0022_mfa_guards.sql), and it is TRANSACTION-scoped, not statement-
  -- scoped — hence the reset on the very next line. It also disables the FK-integrity
  -- trigger on changed_by_user_id for the duration, which is harmless here only because the
  -- value written is a literal NULL. That is a property of these statements, not of the
  -- bypass.
  SET LOCAL session_replication_role = replica;
  UPDATE tax_country_changes SET changed_by_user_id = NULL WHERE changed_by_user_id = p_user;
  UPDATE organisation_profile_changes SET changed_by_user_id = NULL WHERE changed_by_user_id = p_user;
  SET LOCAL session_replication_role = origin;
```

Match 0028's structure and its header note that the body is carried unchanged. **Dropping any existing statement silently regresses erasure** — diff your file's body against `/tmp/erase_user.sql` before moving on.

Add the journal entry:

```json
{ "idx": 30, "version": "7", "when": 1786400000001, "tag": "0030_erase_tax_actors", "breakpoints": true }
```

- [ ] **Step 10: Write the three named scrub tests, and seed rows for them**

`scrub` has **no generic coverage**: the loop at `packages/db/tests/erasure.test.ts:708` does `if (treatment !== 'delete') continue;`. That file's own comment records that commenting out a real scrub left all 148 package tests and all 721 API tests green. So each new scrub column needs its own named test **and** a row in `createSubject`, or the test counts zero either way and passes vacuously.

Add rows to `createSubject` writing the subject's id into all three columns, then:

```ts
it('scrubs the staff actor from a tax country, keeping the policy', async () => {
  await withConnection(async (db) => {
    const subject = await createSubject(db, `p2-${tag}`);
    await erase(db, subject.id);

    const rows = await db.execute(sql`
      select code, rate_bp, updated_by_user_id from tax_countries where code = 'TH'
    `);
    expect(rows.rows[0]).toStrictEqual({ code: 'TH', rate_bp: 700, updated_by_user_id: null });
  });
});

it('scrubs the actor from tax history without deleting the history', async () => {
  await withConnection(async (db) => {
    const subject = await createSubject(db, `p2-${tag}`);
    const before = await db.execute(sql`select count(*)::int as n from tax_country_changes`);
    await erase(db, subject.id);
    const after = await db.execute(sql`
      select count(*)::int as n, count(changed_by_user_id)::int as actors from tax_country_changes
    `);
    expect(after.rows[0]).toStrictEqual({ n: before.rows[0]?.n, actors: 0 });
  });
});

it('scrubs the actor from profile history without deleting the history', async () => {
  await withConnection(async (db) => {
    const subject = await createSubject(db, `p2-${tag}`);
    const before = await db.execute(sql`select count(*)::int as n from organisation_profile_changes`);
    await erase(db, subject.id);
    const after = await db.execute(sql`
      select count(*)::int as n, count(changed_by_user_id)::int as actors
      from organisation_profile_changes
    `);
    expect(after.rows[0]).toStrictEqual({ n: before.rows[0]?.n, actors: 0 });
  });
});
```

The helpers are `createSubject(db, label)` (`:81`, **two arguments**) and `erase(db, userId, requestedBy = null)` (`:179`) — there is no `eraseUser`. `tag` is the file's existing per-run suffix at `:53`.

- [ ] **Step 11: Mutation-test the scrubs, because nothing else will**

Comment out the `UPDATE tax_country_changes …` line in `0030`, re-migrate the test database, and re-run. The second test must go **red**. If it stays green, `createSubject` is not writing that column and the test proves nothing — fix the fixture, not the assertion. Restore the line afterwards.

```bash
pnpm --filter @wewin/db exec vitest run erasure.test.ts
```

- [ ] **Step 12: Migrate the dev database and confirm the live function**

```bash
pnpm db:migrate
docker exec wewin-demo-postgres-1 psql -U wewin -d wewin -tAc \
  "SELECT prosrc LIKE '%tax_country_changes%' FROM pg_proc WHERE proname = 'erase_user'"
```

Expected: `t`. P1 shipped with `wewin` running a stale `erase_user()` because drizzle recorded a migration applied before the file was corrected — this check is why.

- [ ] **Step 13: Typecheck and commit**

```bash
pnpm typecheck && pnpm --filter @wewin/db test
git add packages/db
git commit -m "feat(db): tax_countries, its change history, and the company deposit percentage

Three new users.id foreign keys, all scrub, each with its own named test and a
createSubject row — the coverage loop skips non-delete treatments, so a scrub
with no named test passes vacuously.

deposit_bp carries no column DEFAULT: defaults.ts:12-15 forbids one for a
placeholder business number, so 0029 writes 10000 into the row instead."
```

---

### Task 2: The contract — tax-country wires, and the document's two optional fields

**Files:**
- Create: `packages/contract/src/tax.ts`
- Modify: `packages/contract/src/index.ts` (export it)
- Modify: `packages/contract/src/order.ts` (`orderDocumentWireSchema` at `:302`, `OrderDocumentWire` at `:229ff`)
- Test: `packages/contract/tests/tax.test.ts` (new), `packages/contract/tests/order-document.test.ts` (add to the existing file if one covers this schema; create it if not)

**Interfaces:**
- Consumes: nothing from Task 1 (the contract does not import `@wewin/db`).
- Produces:
  - `TAX_TREATMENTS_WIRE`, `DESTINATION_TAX_BASES = ['inclusive','exclusive'] as const`
  - `taxCountryWireSchema` / `TaxCountryWire` — `{ code, nameTh, rateBp, treatment, pricesIncludeTax, isActive, sortOrder, updatedAt }`
  - `taxCountryCreateSchema`, `taxCountryPatchSchema`, `taxCountryAvailabilitySchema`
  - `settingChangeWireSchema` / `SettingChangeWire` — `{ id, changedAt, changedByUserId, before, after }`, used by both change logs
  - `destinationWireSchema` / `DestinationWire` — `{ code, nameTh }`, the public read's shape
  - `OrderDocumentWire.destinationCountry?: string`, `OrderDocumentWire.taxBasis?: 'inclusive' | 'exclusive'`

- [ ] **Step 1: Write the failing test for the two document fields — the one that catches the silent strip**

Create or extend the document-schema test:

```ts
import { describe, expect, it } from 'vitest';
import { ORDER_DOCUMENT_SCHEMA_VERSION, orderDocumentWireSchema } from '../src/order';

/** The smallest object the schema accepts. Build it from a real fixture if one exists. */
const legacyDocument = () => ({
  /* …every currently-required field, copied from an existing fixture or test… */
});

describe('the pinned document carries a destination without a version bump', () => {
  it('keeps destinationCountry and taxBasis through a parse', () => {
    const parsed = orderDocumentWireSchema.safeParse({
      ...legacyDocument(),
      destinationCountry: 'SG',
      taxBasis: 'inclusive',
    });

    expect(parsed.success).toBe(true);
    /* The whole point: `parsed.data`, not the input. z.object strips what it does not
       declare, and order.repository.ts:735 returns parsed.data on every read. */
    expect(parsed.success && parsed.data.destinationCountry).toBe('SG');
    expect(parsed.success && parsed.data.taxBasis).toBe('inclusive');
  });

  it('still parses a document written before the fields existed', () => {
    const parsed = orderDocumentWireSchema.safeParse(legacyDocument());

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.destinationCountry).toBeUndefined();
    expect(parsed.success && parsed.data.taxBasis).toBeUndefined();
    expect(parsed.success && parsed.data.documentSchemaVersion).toBe(ORDER_DOCUMENT_SCHEMA_VERSION);
  });

  it('refuses a basis outside the two', () => {
    const parsed = orderDocumentWireSchema.safeParse({ ...legacyDocument(), taxBasis: 'net' });
    expect(parsed.success).toBe(false);
  });
});
```

**`legacyDocument()` must be a real, complete document.** Find an existing fixture — grep the repo for `documentSchemaVersion:` in test files and copy the fullest one. A hand-written partial will fail parsing for unrelated reasons and teach you nothing.

- [ ] **Step 2: Run it and watch the first test fail on the assertion, not on the parse**

```bash
pnpm --filter @wewin/contract exec vitest run destination
```

Expected: the second and third tests PASS already; the **first** fails with `expected 'SG', got undefined`. That failure *is* the silent strip, reproduced. If the first test errors on `parsed.success === false`, `legacyDocument()` is incomplete — fix it before continuing.

- [ ] **Step 3: Declare both fields in the interface and the schema**

In `packages/contract/src/order.ts`, inside the `OrderDocumentWire` interface (`:229ff`):

```ts
  /**
   * Where the goods are going, frozen at submit, and absent on every document issued before
   * this field existed.
   *
   * Optional is what keeps the 21 already-issued quotations readable: `documentSchemaVersion`
   * is a bare `z.literal` with no v1/v2 union reader, and a parse failure is a 503 for staff
   * and customer alike (`apps/api/src/orders/order.repository.ts:722-729`).
   */
  readonly destinationCountry?: string;
  /**
   * Which arithmetic ran, recorded because the printed page needs it and cannot ask.
   *
   * The renderer picks a layout from this. It cannot read `tax_countries` instead: that table
   * is mutable, and a quotation must print what was quoted, not what is policy today.
   */
  readonly taxBasis?: (typeof DESTINATION_TAX_BASES)[number];
```

and in `orderDocumentWireSchema` (`:302`), beside `vat`:

```ts
  destinationCountry: z.string().regex(/^[A-Z]{2}$/u).optional(),
  taxBasis: z.enum(DESTINATION_TAX_BASES).optional(),
```

The schema is annotated `z.ZodType<OrderDocumentWire>`, so **both** edits are required or it does not compile. Import `DESTINATION_TAX_BASES` from `./tax`.

- [ ] **Step 4: Write `packages/contract/src/tax.ts`**

```ts
import { z } from 'zod';

/** Inclusive or exclusive — a property of the destination's settings, never of a quote. */
export const DESTINATION_TAX_BASES = ['inclusive', 'exclusive'] as const;
export type DestinationTaxBasis = (typeof DESTINATION_TAX_BASES)[number];

/** Mirrors the CHECK on `tax_countries.treatment`. Four values, declared here for the wire. */
export const TAX_TREATMENTS_WIRE = ['standard', 'zero_rated', 'exempt', 'out_of_scope'] as const;

const code = z.string().regex(/^[A-Z]{2}$/u, 'code must be an upper-case ISO 3166-1 alpha-2 pair');
const rateBp = z.int().min(0).max(10_000);

export const taxCountryWireSchema = z.strictObject({
  code,
  nameTh: z.string().min(1),
  rateBp,
  treatment: z.enum(TAX_TREATMENTS_WIRE),
  pricesIncludeTax: z.boolean(),
  isActive: z.boolean(),
  sortOrder: z.int(),
  updatedAt: z.string(),
});
export type TaxCountryWire = z.infer<typeof taxCountryWireSchema>;

export const taxCountryCreateSchema = z.strictObject({
  code,
  nameTh: z.string().min(1).max(120),
  rateBp,
  treatment: z.enum(TAX_TREATMENTS_WIRE),
  pricesIncludeTax: z.boolean(),
  sortOrder: z.int().min(0).max(9_999).optional(),
});
export type TaxCountryCreateRequest = z.infer<typeof taxCountryCreateSchema>;

/* Every field optional, but not all-absent: a PATCH that changes nothing would write a
   history row recording no change, which is worse than a 400. */
export const taxCountryPatchSchema = z
  .strictObject({
    nameTh: z.string().min(1).max(120).optional(),
    rateBp: rateBp.optional(),
    treatment: z.enum(TAX_TREATMENTS_WIRE).optional(),
    pricesIncludeTax: z.boolean().optional(),
    sortOrder: z.int().min(0).max(9_999).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'a patch must change something' });
export type TaxCountryPatchRequest = z.infer<typeof taxCountryPatchSchema>;

export const taxCountryAvailabilitySchema = z.strictObject({ isActive: z.boolean() });
export type TaxCountryAvailabilityRequest = z.infer<typeof taxCountryAvailabilitySchema>;

/**
 * One shape for both change logs, tax-country and profile.
 *
 * `changedByUserId`, not a name: nothing in this feature joins `users`, and P1's
 * `bank_account_changes` reader puts the id on the wire for the same reason. A name would be a
 * second query and a second thing to keep true after erasure scrubs the actor to NULL.
 */
export const settingChangeWireSchema = z.strictObject({
  id: z.string(),
  changedAt: z.string(),
  changedByUserId: z.string().nullable(),
  before: z.unknown().nullable(),
  after: z.unknown(),
});
export type SettingChangeWire = z.infer<typeof settingChangeWireSchema>;

/**
 * What an anonymous storefront caller may know: the places we sell to, by name.
 *
 * No rate, no treatment, no basis. Tax policy belongs on the quotation the customer has
 * actually received, which is the same line P1 drew when it kept account numbers behind an
 * order rather than publishing a list.
 */
export const destinationWireSchema = z.strictObject({ code, nameTh: z.string().min(1) });
export type DestinationWire = z.infer<typeof destinationWireSchema>;
```

Then make it reachable at run time. `packages/contract`'s `exports` map is hand-maintained with
no wildcard and its root is types-only, so add:

```json
    "./tax": "./dist/tax.js",
```

beside `"./order"` in `packages/contract/package.json`. **Adding a re-export to `src/index.ts` does
not make it importable** — every consumer in Tasks 5, 6, 9 and 13 imports from
`@wewin/contract/tax`, and without the map entry each throws `ERR_PACKAGE_PATH_NOT_EXPORTED` at
boot.

- [ ] **Step 5: Verify the tests pass and the types hold**

```bash
pnpm --filter @wewin/contract test && pnpm typecheck
```

Expected: all three document tests PASS. `pnpm typecheck` must be clean — `vitest run` strips types and would not have caught a mismatch between the interface and the schema.

- [ ] **Step 6: Mutation-test the strip guard**

Delete the `destinationCountry:` line from `orderDocumentWireSchema` (leave the interface field) and re-run. The first test must go **red** with `expected 'SG', got undefined`. This is the only detector for the failure mode that has no error, no log, and no repair. Restore the line.

- [ ] **Step 7: Commit**

```bash
git add packages/contract
git commit -m "feat(contract): tax-country wires, and two optional fields on the pinned document

Optional, so the 21 issued documents keep parsing — documentSchemaVersion stays
put. Declared in both orderDocumentWireSchema and OrderDocumentWire, because the
schema is annotated z.ZodType<OrderDocumentWire> and because a field in the JSON
but not the schema is stripped on every read, forever, silently."
```

---

### Task 3: The tax-country repository and service — writes with history, in one transaction

**Files:**
- Create: `apps/api/src/organisation/tax-country.repository.ts`
- Create: `apps/api/src/organisation/tax-country.service.ts`
- Create: `apps/api/tests/organisation/tax-country.pg.test.ts`
- Modify: `apps/api/src/organisation/organisation.module.ts` (provide both)

**Interfaces:**
- Consumes: `taxCountries`, `taxCountryChanges` from `@wewin/db`; the schemas from Task 2.
- Produces:
  - `TaxCountryRepository.list(tx?, opts?: { activeOnly?: boolean }): Promise<TaxCountryRow[]>`
  - `TaxCountryRepository.lockCountry(code: string, tx: Tx)` — `.for('update')`
  - `TaxCountryRepository.changes(code: string, tx?: Tx)`
  - `TaxCountryService.list(activeOnly: boolean): Promise<TaxCountryWire[]>`
  - `TaxCountryService.create(body: TaxCountryCreateRequest, userId: string): Promise<TaxCountryWire>`
  - `TaxCountryService.patch(code: string, body: TaxCountryPatchRequest, userId: string): Promise<TaxCountryWire>`
  - `TaxCountryService.setAvailability(code: string, isActive: boolean, userId: string): Promise<TaxCountryWire>`
  - `TaxCountryService.changes(code: string): Promise<SettingChangeWire[]>` — ascending by `changedAt`

Read `apps/api/src/organisation/organisation.service.ts:31-40` and `:70-90`, and `organisation.repository.ts:78-84`, before writing a line. This task is that pattern applied to a second table; do not invent a second pattern.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';

describe('tax country writes', () => {
  it('records a change with the previous values in `before`', async () => {
    const { service, actor } = await harness();

    await service.patch('TH', { rateBp: 800 }, actor.id);
    const [entry] = await service.changes('TH');

    expect(entry?.before).toMatchObject({ rateBp: 700, treatment: 'standard' });
    expect(entry?.after).toMatchObject({ rateBp: 800, treatment: 'standard' });
  });

  it('keeps history contiguous under concurrent patches', async () => {
    const { service, actor } = await harness();

    /* Both at once. Without the row lock in lockCountry, both read 700 and the chain breaks:
       entry[1].before would be 700 rather than entry[0].after. P1's final review found this
       exact defect on a lens that had already passed. */
    await Promise.all([
      service.patch('TH', { rateBp: 800 }, actor.id),
      service.patch('TH', { rateBp: 900 }, actor.id),
    ]);

    /* `changes()` orders by `changedAt` ASC — oldest first — so do NOT reverse it. Entry 1's
       `before` must equal entry 0's `after`; on a reversed array that comparison is backwards and
       passes for the wrong reason. */
    const entries = await service.changes('TH');
    expect(entries).toHaveLength(2);
    expect((entries[1]?.before as { rateBp: number }).rateBp).toBe(
      (entries[0]?.after as { rateBp: number }).rateBp,
    );
  });

  it('writes no history row when the write fails', async () => {
    const { service, actor } = await harness();

    await expect(service.patch('TH', { rateBp: 20_000 }, actor.id)).rejects.toThrow();
    expect(await service.changes('TH')).toHaveLength(0);
  });

  it('creates a country and records the creation with a null `before`', async () => {
    const { service, actor } = await harness();

    await service.create(
      { code: 'SG', nameTh: 'สิงคโปร์', rateBp: 900, treatment: 'standard', pricesIncludeTax: true },
      actor.id,
    );
    const [entry] = await service.changes('SG');

    expect(entry?.before).toBeNull();
    expect(entry?.after).toMatchObject({ code: 'SG', rateBp: 900, pricesIncludeTax: true });
  });

  it('withdraws a country by flag, and the row survives', async () => {
    const { service, actor } = await harness();

    const withdrawn = await service.setAvailability('TH', false, actor.id);

    expect(withdrawn.isActive).toBe(false);
    expect(await service.list(false)).toHaveLength(1);
    expect(await service.list(true)).toHaveLength(0);
  });
});
```

**`harness()` does not exist yet — write it.** `apps/api/tests/organisation/organisation.pg.test.ts` is `beforeAll`-scoped closures (`app`, `db`, `reader`, `writer`) calling routes through raw `fetch`; there is no reusable helper to copy. Lift `makeActor` (`:84`) and the app-boot helper from `apps/api/tests/support`, and have `harness()` return `{ service, repository, actor, db }` so the assertions above read as written. State its shape in this task's commit message so Task 5 can reuse it rather than write a second one.

- [ ] **Step 2: Run and watch it fail**

```bash
pnpm --filter @wewin/api exec vitest run tax-country
```

Expected: FAIL, `Cannot find module '../../src/organisation/tax-country.service'`.

- [ ] **Step 3: Write the repository**

```ts
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { taxCountries, taxCountryChanges, type Database } from '@wewin/db';
import { DRIZZLE } from '../database/database.tokens';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

@Injectable()
export class TaxCountryRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  list(tx?: Tx, opts?: { activeOnly?: boolean }) {
    const runner = tx ?? this.db;
    const query = runner.select().from(taxCountries);
    return opts?.activeOnly
      ? query.where(eq(taxCountries.isActive, true)).orderBy(asc(taxCountries.sortOrder), asc(taxCountries.code))
      : query.orderBy(asc(taxCountries.sortOrder), asc(taxCountries.code));
  }

  /**
   * ⚠️ `.for('update')`, and the lock is the whole reason this method exists.
   *
   * An unlocked pre-image read lets two concurrent PATCHes both see the old row, so the
   * history chain stops being contiguous — entry N's `before` no longer equals entry N−1's
   * `after`. P1's review found exactly this on a lens that had already passed. Same shape as
   * `organisation.repository.ts:80-82`.
   */
  lockCountry(code: string, tx: Tx) {
    return tx.select().from(taxCountries).where(eq(taxCountries.code, code)).limit(1).for('update');
  }

  changes(code: string, tx?: Tx) {
    const runner = tx ?? this.db;
    return runner
      .select()
      .from(taxCountryChanges)
      .where(eq(taxCountryChanges.taxCountryCode, code))
      .orderBy(asc(taxCountryChanges.changedAt));
  }
}
```

Confirm `DRIZZLE`'s import path and the `Database` / transaction-callback types against `apps/api/src/organisation/organisation.repository.ts` — `Transaction` is **not** an exported type in this repo, which is why `Tx` is derived here.

- [ ] **Step 4: Write the service**

The shape, which every method follows:

```ts
  async patch(code: string, body: TaxCountryPatchRequest, userId: string): Promise<TaxCountryWire> {
    return this.db.transaction(async (tx) => {
      /* Pre-image under a row lock, THEN the write, THEN the history row as the last
         statement. All three in one transaction: a history row that can outlive a failed
         write is a lie, and a write with no history row is the thing D3 bought. */
      const [before] = await this.repository.lockCountry(code, tx);
      if (before === undefined) throw AppError.notFound('error.tax_country.unknown');

      const [after] = await tx
        .update(taxCountries)
        .set({ ...body, updatedByUserId: userId, updatedAt: new Date() })
        .where(eq(taxCountries.code, code))
        .returning();

      await tx.insert(taxCountryChanges).values({
        taxCountryCode: code,
        changedByUserId: userId,
        before: snapshot(before),
        after: snapshot(after),
      });

      return wire(after);
    });
  }
```

`snapshot(row)` returns every business field — `code`, `nameTh`, `rateBp`, `treatment`, `pricesIncludeTax`, `isActive`, `sortOrder` — and omits `createdAt`, `updatedAt` and `updatedByUserId`, which are metadata about the change rather than the thing that changed. `wire(row)` maps a row to `TaxCountryWire` with `updatedAt: row.updatedAt.toISOString()`. `create` passes `before: null`; `setAvailability` patches only `isActive`. Use `AppError`'s existing factory names from `apps/api/src/errors/app-error.ts` — do not invent codes; add the two new message keys where that file's siblings live.

- [ ] **Step 5: Run the tests**

```bash
pnpm --filter @wewin/api exec vitest run tax-country
```

Expected: all five PASS.

- [ ] **Step 6: Mutation-test the lock**

Remove `.for('update')` from `lockCountry` and re-run. **The contiguity test must go red.** If it stays green the two patches are not actually racing — make the test await them concurrently via `Promise.all` (as written) and check your harness is not serialising them. Restore the lock.

- [ ] **Step 7: Typecheck and commit**

```bash
pnpm typecheck && pnpm --filter @wewin/api exec vitest run tax-country organisation
git add apps/api/src/organisation apps/api/tests/organisation
git commit -m "feat(api): tax-country reads and writes, with locked pre-image and history

The P1 bank-account pattern applied to a second table: SELECT … FOR UPDATE, the
write, then the history INSERT, all in one transaction. Mutation-tested by
removing the lock and watching contiguity break."
```

---

### Task 4: The deposit percentage joins the profile, with history

**Files:**
- Modify: `apps/api/src/organisation/organisation.service.ts` (`putProfile` at `:111`)
- Modify: `apps/api/src/organisation/organisation.repository.ts` (a `lockProfile` beside `lockAccount` at `:80-82`)
- Modify: `packages/contract/src/organisation.ts` (`organisationProfilePutSchema` and the profile wire)
- Modify: `apps/api/src/organisation/encode.ts` (`encodeProfile`, so `depositBp` reaches the wire)
- Test: `apps/api/tests/organisation/organisation.pg.test.ts` (extend)

**Interfaces:**
- Consumes: `organisationProfile.depositBp`, `organisationProfileChanges` (Task 1).
- Produces: `OrganisationProfileWire.depositBp: number`; `organisationProfilePutSchema` accepts `depositBp`; `OrganisationRepository.lockProfile(tx)`; `OrganisationService.putProfile` writes a history row.

`putProfile(actorUserId, input)` — that name, and the actor first — is today a plain UPDATE with no history (`organisation.service.ts:111-121`). This task converts it to the locked-pre-image-plus-history shape, which is what D4 bought: the deposit percentage is the line that decides what counts as a concession, so moving it must leave a trace.

- [ ] **Step 1: Write the failing tests**

```ts
it('records a profile change, before and after', async () => {
  const { service, actor } = await harness();

  await service.putProfile(actor.id, { depositBp: 3000 });
  const [entry] = await service.profileChanges();

  expect((entry?.before as { depositBp: number }).depositBp).toBe(10_000);
  expect((entry?.after as { depositBp: number }).depositBp).toBe(3_000);
});

it('refuses a deposit of zero at the database, not at submit', async () => {
  const { service, actor } = await harness();
  await expect(service.putProfile(actor.id, { depositBp: 0 })).rejects.toThrow();
});

it('keeps profile history contiguous under concurrent updates', async () => {
  const { service, actor } = await harness();

  await Promise.all([
    service.putProfile(actor.id, { depositBp: 3000 }),
    service.putProfile(actor.id, { depositBp: 5000 }),
  ]);

  /* Ascending, like `changes()` — see Task 3. Do not reverse. */
  const entries = await service.profileChanges();
  expect(entries).toHaveLength(2);
  expect((entries[1]?.before as { depositBp: number }).depositBp).toBe(
    (entries[0]?.after as { depositBp: number }).depositBp,
  );
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
pnpm --filter @wewin/api exec vitest run organisation
```

Expected: FAIL — `service.profileChanges is not a function`.

- [ ] **Step 3: Add `depositBp` to the contract**

In `packages/contract/src/organisation.ts`, add to the profile wire and the update schema:

```ts
  /** Basis points of the grand total due before production may start. 10 000 is payment in full. */
  depositBp: z.int().min(1).max(10_000),
```

On the update schema make it `.optional()` like its siblings, so a caller editing only the address does not have to resend it.

- [ ] **Step 4: Add `lockProfile` and rewrite `updateProfile`**

```ts
  /** Same reason as `lockAccount`: an unlocked pre-image breaks history contiguity. */
  lockProfile(tx: Tx) {
    return tx.select().from(organisationProfile).where(eq(organisationProfile.id, 1)).limit(1).for('update');
  }
```

`putProfile` becomes one transaction: `lockProfile` → UPDATE → INSERT into `organisationProfileChanges` with `before`/`after` snapshots of every business field (`legalNameTh`, `legalNameEn`, `addressTh`, `addressEn`, `taxId`, `phone`, `email`, `depositBp`). Add `profileChanges()` returning the rows **oldest-first (`asc` on `changedAt`)**, matching `TaxCountryRepository.changes` so both readers behave alike, mapped to the `SettingChangeWire` shape Task 2 defined.

- [ ] **Step 5: Run the tests, then mutation-test the lock**

```bash
pnpm --filter @wewin/api exec vitest run organisation
```

All three PASS. Then remove `.for('update')` from `lockProfile`: the contiguity test must go **red**. Restore it.

- [ ] **Step 6: Commit**

```bash
pnpm typecheck
git add apps/api/src/organisation packages/contract/src/organisation.ts apps/api/tests/organisation
git commit -m "feat(api): deposit percentage on the company profile, with change history

D4 put the deposit on this row and D3 said money settings carry full history, so
updateProfile stops being a bare UPDATE. Side effect: changing the company tax id
is no longer untraceable."
```

---

### Task 5: The routes — five admin, one public, and two exhaustive test tables

**Files:**
- Modify: `apps/api/src/organisation/organisation.controller.ts` (after `:113`, inside the existing `@Controller('admin/organisation')`)
- Create: `apps/api/src/organisation/destinations.controller.ts` (the public read — a separate controller because the path must not be under `/admin`)
- Modify: `apps/api/src/organisation/organisation.module.ts` — **register `DestinationsController`** in `controllers`, beside `OrganisationController`. A Nest controller that is not listed in a module is never routed and `GET /destinations` simply 404s; nothing else in this task would reveal that.
- Modify: `apps/api/tests/admin/route-permissions.test.ts` (`ADMIN_ROUTE_PERMISSIONS`, `:137-143`)
- Modify: `apps/api/tests/rbac/route-audit.test.ts` (`:293-295`, `:389`, `:398`, `:470-471`)
- Test: `apps/api/tests/organisation/tax-country-routes.pg.test.ts` (new)

**Interfaces:**
- Consumes: `TaxCountryService` (Task 3), the schemas (Task 2).
- Produces: the six routes below.

| Method + path | Permission | Body schema |
|---|---|---|
| `GET /admin/organisation/tax-countries` | `organisation.read` | — |
| `POST /admin/organisation/tax-countries` | `organisation.write` (`@HttpCode(201)`) | `taxCountryCreateSchema` |
| `PATCH /admin/organisation/tax-countries/:code` | `organisation.write` | `taxCountryPatchSchema` |
| `PUT /admin/organisation/tax-countries/:code/availability` | `organisation.write` | `taxCountryAvailabilitySchema` |
| `GET /admin/organisation/tax-countries/:code/changes` | `organisation.read` | — |
| `GET /destinations` | **anonymous** | — |

Every admin handler carries `@RequirePermissions(...)`, `@contractVersion()` and `@Body(new ZodBodyPipe(schema))` — copy the idiom from the seven existing handlers at `organisation.controller.ts:46-122`, including the local `userIdOf(scope)` helper at `:142-147`.

- [ ] **Step 1: Write the failing route tests**

```ts
it('refuses a tax-country read without organisation.read', async () => {
  const { request, actorWithout } = await harness();
  await request.get('/admin/organisation/tax-countries').set(actorWithout('organisation.read')).expect(403);
});

it('publishes destinations to an anonymous caller — names only', async () => {
  const { request } = await harness();

  const response = await request.get('/destinations').expect(200);

  expect(response.body).toStrictEqual([{ code: 'TH', nameTh: 'ไทย' }]);
  /* Tax policy is not published. A caller with no order learns where we sell, nothing more. */
  expect(JSON.stringify(response.body)).not.toMatch(/rateBp|treatment|pricesIncludeTax/u);
});

it('omits withdrawn countries from the public list but not from the admin list', async () => {
  const { request, service, actor, admin } = await harness();
  await service.setAvailability('TH', false, actor.id);

  expect((await request.get('/destinations').expect(200)).body).toStrictEqual([]);
  expect((await request.get('/admin/organisation/tax-countries').set(admin).expect(200)).body).toHaveLength(1);
});

it('refuses a patch that changes nothing', async () => {
  const { request, admin } = await harness();
  await request.patch('/admin/organisation/tax-countries/TH').set(admin).send({}).expect(400);
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
pnpm --filter @wewin/api exec vitest run tax-country-routes
```

Expected: 404s where 200s and 403s are asserted.

- [ ] **Step 3: Add the five admin handlers and the public controller**

The public one:

```ts
/**
 * Not under `/admin`, and that is load-bearing twice.
 *
 * `apps/api/tests/admin/route-permissions.test.ts` selects routes by `/admin` prefix and
 * asserts its table both ways, so an anonymous route under `/admin` would fail it. And a
 * customer must pick a destination *before* an order exists, so P1's order-scoping — the
 * shape it chose instead of publishing bank accounts — is unavailable here. What is withheld
 * instead is the policy: rate, treatment and basis never leave the admin routes.
 */
@Controller('destinations')
export class DestinationsController {
  constructor(private readonly taxCountries: TaxCountryService) {}

  @Get()
  /* The reason is mandatory and the boot-time route audit prints it. */
  @AllowAnonymous('a customer must choose a destination before an order exists')
  @contractVersion()
  async list(): Promise<DestinationWire[]> {
    const rows = await this.taxCountries.list(true);
    return rows.map((row) => ({ code: row.code, nameTh: row.nameTh }));
  }
}
```

The decorator is `AllowAnonymous(reason: string)` from `apps/api/src/rbac/access.ts:114` — re-exported from `../rbac`. The `reason` argument is **mandatory**: `@AllowAnonymous()` does not compile, and the boot-time route audit prints the reason for every anonymous route.

- [ ] **Step 4: Update both exhaustive route tables**

`ADMIN_ROUTE_PERMISSIONS` gains the five `/admin` keys — **not** `GET /destinations`. `route-audit.test.ts` gains all six lines, each in its method's block in alphabetical order by path, with the access kind in brackets: five `[permissions]` and `'GET /destinations [anonymous]'`.

`apps/dashboard/src/lib/auth/permissions.ts` needs **no change** — P2 adds no permission code. Do not add a comment mentioning a permission string to that file either: `apps/api/tests/rbac/permission-parity.test.ts:29` strips only `/* */` blocks, so a `//` comment containing `'tax.read'` would fail the API suite.

- [ ] **Step 5: Run the full API suite**

```bash
pnpm --filter @wewin/api test
```

Expected: green, including `route-permissions` and `route-audit`. If `route-audit` fails, the new line is in the wrong sorted position — read the failure diff, it prints both lists.

- [ ] **Step 6: Commit**

```bash
pnpm typecheck
git add apps/api
git commit -m "feat(api): tax-country routes, and a public destinations read

Five admin routes behind organisation.read/.write, plus GET /destinations for the
storefront picker — anonymous, names only, and deliberately outside /admin so the
admin route table's prefix selector stays honest."
```

---

### Task 6: The dashboard screen

**Files:**
- Create: `apps/dashboard/src/components/organisation/tax-countries.tsx`
- Modify: `apps/dashboard/src/components/organisation/organisation-screen.tsx` (render it; add the deposit field to `ProfileForm`)
- Modify: `apps/dashboard/src/components/organisation/organisation-api.ts` (the four new calls)
- Test: `apps/dashboard/src/components/organisation/tax-country-fields.test.ts` (new, beside the module)

**Interfaces:**
- Consumes: the six routes (Task 5), `TaxCountryWire` / `TaxCountryCreateRequest` / `TaxCountryPatchRequest` (Task 2).
- Produces: `TaxCountriesSection` (default-exported named component), rendered by `OrganisationScreen`.

**No new route and no new nav entry.** The table joins the existing `/organisation` page (titled ข้อมูลบริษัท, already in the ระบบ section at `apps/dashboard/src/lib/nav/navigation.ts:213-224`). Consequently `apps/dashboard/tests/navigation.test.ts` will **not** change and will **not** fail — do not go looking for a red test there, and do not edit `navigation.ts` to manufacture one.

Follow `organisation-screen.tsx` exactly: `'use client'`, a per-section discriminated union `{status:'loading'} | {status:'failed'; problem} | {status:'ready'; …}` (`:49-52`), the `baseline !== initial` re-seed derived **during render** rather than in a `useEffect` (`:144-165`), `const editable = can('organisation.write')` gating every write control, and re-fetch on save rather than optimistic update (`:170-183`).

- [ ] **Step 1: Write the failing tests**

**`.test.ts`, and no testing library.** This repo has no DOM environment, no
`@testing-library/*` and no `msw`, and `apps/dashboard/vitest.config.ts` says in a comment that
components are deliberately not rendered (see Verified Repo Facts). A `.test.tsx` file is not even
collected. So the logic worth asserting is extracted into pure functions and tested directly —
which is better design here anyway, because a percentage codec is not a rendering concern.

Create `apps/dashboard/src/components/organisation/tax-country-fields.ts` with the pure parts and
its test **beside it** as `tax-country-fields.test.ts` — `include` covers `src/**/*.test.ts` and
nine dashboard modules already do this. The gating predicate follows
`apps/dashboard/tests/navigation.test.ts`'s treatment of `visibleNavigation` and
`principal.test.ts`'s of `can`:

```ts
import { describe, expect, it } from 'vitest';
import { basisLabelTh, rateField, readRateBp } from '@/components/organisation/tax-country-fields';

describe('the rate edits as a percentage and stores basis points', () => {
  it('round-trips whole and fractional rates', () => {
    expect(rateField(700)).toBe('7');
    expect(rateField(750)).toBe('7.5');
    expect(rateField(0)).toBe('0');
    expect(readRateBp('7')).toBe(700);
    expect(readRateBp('7.5')).toBe(750);
  });

  it('refuses what the API would refuse, before a request is sent', () => {
    /* The CHECK is 0..10 000 bp. A form that posts 200% and shows the server's error is worse
       than one that never sends it. */
    expect(readRateBp('200')).toBeNull();
    expect(readRateBp('-1')).toBeNull();
    expect(readRateBp('')).toBeNull();
    expect(readRateBp('abc')).toBeNull();
  });

  it('names the basis rather than printing a boolean', () => {
    expect(basisLabelTh(true)).toBe('รวมภาษีแล้ว');
    expect(basisLabelTh(false)).toBe('ยังไม่รวมภาษี');
  });
});
```

And one markup assertion for the permission gate, via `renderToStaticMarkup` — which needs no DOM:

```ts
it('shows a reader no save control', () => {
  const markup = renderToStaticMarkup(
    createElement(SessionProvider, { permissions: ['organisation.read'] },
      createElement(TaxCountriesSection, { initial: [thailand()] })),
  );

  expect(markup).toContain('ไทย');
  expect(markup).not.toContain('บันทึก');
});
```

Read `apps/dashboard/src/lib/auth/` for the real session-provider export and the shape it takes.
If `TaxCountriesSection` cannot accept its rows as a prop, give it one — a component that can be
rendered with data supplied is testable without a network layer, which is the whole reason this
works in a node environment.

**The "rejected save keeps what was typed" behaviour is checked in the browser (Step 5), not
here.** It needs typing and clicking, and this repo has no DOM to do that in.

- [ ] **Step 2: Run and watch it fail**

```bash
pnpm --filter @wewin/dashboard exec vitest run tax-countries
```

- [ ] **Step 3: Build the section**

Percentage input: the rate is stored in basis points and shown as a percentage. Use the repo's existing text-box money/percentage idiom — `satangField` / `readSatang` in `packages/core/src/money.ts` is the precedent for "store minor units, edit as a decimal string"; mirror its shape for basis points rather than inventing a parser. `700 ↔ '7'`, `750 ↔ '7.5'`.

Basis renders as words: `pricesIncludeTax ? 'รวมภาษีแล้ว' : 'ยังไม่รวมภาษี'`. Treatment renders through the existing `vatLabelTh` (`apps/dashboard/src/components/quotes/quote-alerts.tsx:205-219`) rather than a second mapping.

The history view reuses the same `/changes` reader shape the bank-account section already renders.

- [ ] **Step 4: Add the deposit field to `ProfileForm`**

One numeric field, labelled `เงินมัดจำก่อนเข้าผลิต (%)`, in the same `fields`/`set`/`submit` flow as the existing profile inputs. Add a helper line under it: `ต่ำกว่านโยบายนี้ต้องขออนุมัติ` — the sentence is what D2 actually decided, and the admin setting the number should see it.

- [ ] **Step 5: Verify in the browser, not only in tests**

```bash
pnpm --filter @wewin/dashboard dev
```

Open `/organisation`, change Thailand to 8%, save, reload, and confirm 8% persists. Then check the history panel names you as the actor. A green component test does not prove the API call is wired to the right path — P1 shipped a route the dashboard never reached.

- [ ] **Step 6: Commit**

```bash
pnpm typecheck && pnpm --filter @wewin/dashboard test
git add apps/dashboard
git commit -m "feat(dashboard): tax-country settings and the deposit percentage

Joins the existing /organisation page, so no new route and no nav entry. Rate
edits as a percentage and stores basis points; basis reads as words rather than a
boolean."
```

---

### Task 7: `resolveDestination` — the one place a code becomes a rule

**Files:**
- Modify: `apps/api/src/organisation/tax-country.service.ts` (add the method)
- Modify: `packages/core/src/vat.ts` (amend the header's clause 2 — spec §3)
- Test: `apps/api/tests/organisation/destination-tax.pg.test.ts` (new)

**Interfaces:**
- Consumes: `TaxCountryRepository` (Task 3).
- Produces:

```ts
export interface DestinationTax {
  /** `null` when the order names no destination. */
  readonly code: string | null;
  /** Two fields, always. The basis is NOT in here — see the amended header of vat.ts. */
  readonly rule: TaxRule;
  readonly basis: 'inclusive' | 'exclusive';
}

/** @throws AppError.validationFailed when `code` names a country that does not exist. */
resolveDestination(code: string | null, tx?: Tx): Promise<DestinationTax>
```

Four cases, and the second is the one a reviewer will want to argue about (spec §5.1):

| Order names | Row | Result |
|---|---|---|
| `'SG'` | exists, active | that row |
| `'SG'` | exists, **inactive** | **that row, resolved normally** |
| `'XX'` | none | **refuse** — `AppError.validationFailed({ reason: 'unknown_destination_country' })` |
| `null` | — | `DEFAULT_VAT_RULE`, `basis: 'exclusive'`, `code: null` |

- [ ] **Step 1: Write the failing tests**

```ts
it('resolves an active country to its own rule and basis', async () => {
  const { service } = await harness();
  await service.create({ code: 'SG', nameTh: 'สิงคโปร์', rateBp: 900, treatment: 'standard', pricesIncludeTax: true }, actor.id);

  expect(await service.resolveDestination('SG')).toStrictEqual({
    code: 'SG',
    rule: { rateBp: 900, treatment: 'standard' },
    basis: 'inclusive',
  });
});

it('still resolves a WITHDRAWN country, because a cart already carrying it must not brick', async () => {
  const { service, actor } = await harness();
  await service.setAvailability('TH', false, actor.id);

  /* is_active governs what new customers are offered, not whether an existing cart is valid.
     Refusing here would turn a routine withdrawal into a customer-facing outage — and would
     make omitting the foreign key (spec §4.4) pointless, since the constraint violation would
     just have been relabelled a validation error. */
  expect(await service.resolveDestination('TH')).toStrictEqual({
    code: 'TH',
    rule: { rateBp: 700, treatment: 'standard' },
    basis: 'exclusive',
  });
});

it('refuses a code that never existed rather than falling back to Thai VAT', async () => {
  const { service } = await harness();

  /* tax_countries_block_delete means a row that once existed still exists, so an unknown code
     is a client bug or a tampered request. A silent fallback would compute Thai tax on a
     foreign sale and pin it, permanently, with nothing recording that a fallback happened. */
  /* `toMatchObject`, not `toThrow`. `AppError` sets `Error.message` from its first argument only;
     a `{ reason }` object goes to `details`, which a message regex never sees. */
  await expect(service.resolveDestination('XX')).rejects.toMatchObject({
    details: { reason: 'unknown_destination_country' },
  });
});

it('falls back to the default rule when the order names no destination', async () => {
  const { service } = await harness();

  expect(await service.resolveDestination(null)).toStrictEqual({
    code: null,
    rule: DEFAULT_VAT_RULE,
    basis: 'exclusive',
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
pnpm --filter @wewin/api exec vitest run destination-tax
```

- [ ] **Step 3: Implement it**

```ts
  async resolveDestination(code: string | null, tx?: Tx): Promise<DestinationTax> {
    if (code === null) return { code: null, rule: DEFAULT_VAT_RULE, basis: 'exclusive' };

    const [row] = await this.repository.byCode(code, tx);
    if (row === undefined) {
      throw AppError.validationFailed('error.order.unknown_destination', {
        reason: 'unknown_destination_country',
      });
    }

    return {
      code: row.code,
      rule: { rateBp: row.rateBp, treatment: row.treatment as TaxTreatment },
      basis: row.pricesIncludeTax ? 'inclusive' : 'exclusive',
    };
  }
```

Add `byCode(code, tx?)` to the repository — a plain `eq` select with no `is_active` filter, which is the whole point. `AppError.validationFailed`'s real signature and location: grep for `class AppError` — it is under `apps/api/src/common/errors/`, not `apps/api/src/errors/`. Match the signature you find, and add the message key beside its siblings. Remember that the first argument becomes `Error.message` and the object becomes `details`.

- [ ] **Step 4: Amend the `vat.ts` header — this is a deliverable, not a comment tidy**

Clause 2 of that header currently says inclusive-versus-exclusive *"stops being a property of the data"*. After this feature that is no longer true, and a header asserting the opposite of the code is the drift this repo's comments exist to prevent. Replace that sentence with what becomes true:

```
 * Inclusive-versus-exclusive is a property of the destination's settings — one row per
 * country in `tax_countries`, editable only by a holder of `organisation.write`, and never a
 * field on a quote. `TaxRule` still carries exactly a rate and a treatment, so no code path
 * can vary the basis per line or per quotation; the caller reads the destination and picks
 * `fromNet` or `fromGrand`. What a salesperson cannot do is still the point.
```

Keep clause 1 (`grandMinor` always includes VAT) exactly as it is — it remains true and `fromGrand` depends on it.

- [ ] **Step 5: Run, typecheck, commit**

```bash
pnpm typecheck && pnpm --filter @wewin/api exec vitest run destination-tax
git add apps/api/src/organisation packages/core/src/vat.ts apps/api/tests/organisation
git commit -m "feat(api): resolveDestination, and vat.ts's header amended to match

Withdrawn resolves, unknown refuses — is_active governs what new customers are
offered, not whether an existing cart is valid. The header's second clause is
amended rather than quietly falsified: the basis is a property of the destination's
settings, and TaxRule still carries two fields."
```

---

### Task 8: `orders.destination_country`, and the field the customer fills in

**Files:**
- Create: `packages/db/drizzle/0031_order_destination.sql`
- Modify: `packages/db/src/schema/order.ts`, `packages/db/drizzle/meta/_journal.json`
- Modify: `packages/contract/src/order.ts` (`orderContactRequestSchema` `:622-632`, `OrderContactRequestWire`)
- Modify: `apps/api/src/orders/orders.service.ts` (the `applySubmission` call at `:776`, fields at `:780-790`)
- Modify: `apps/api/src/orders/scope/scoped-order.ts` — `ScopedOrder` (`:55-104`, beside `contactLocale`) **and** `ORDER_COLUMNS` (`:107-129`, beside `contactLocale: orders.contactLocale`)
- Modify: `apps/api/src/orders/order.repository.ts` — `applySubmission`'s input type (`:418-433`, beside `readonly contactLocale: string`) **and** its `.set({…})` literal (`:437-462`, beside `contactLocale: input.contactLocale`)
- Test: `apps/api/tests/orders/destination-submit.pg.test.ts` (new)

**Two files a database column does not reach on its own.** `ScopedOrder` is a hand-written
interface carrying an ownership brand, and `ORDER_COLUMNS` is the only column set a scoped load
selects — so `order.destinationCountry` is `TS2339` until both are extended — and if forced through, `undefined` at run time. Task 9 reads it too. `OrderRow` is derived from `ScopedOrder` by `Omit`, so it needs no separate edit. Separately, `applySubmission`'s input is a closed object type and its UPDATE writes only
the columns named in `.set({…})`: adding the key at the call site alone is an excess-property
error, and even if it compiled nothing would be written.

**Interfaces:**
- Consumes: nothing from Task 7 yet — this task only *stores* the code; Task 9 consumes it.
- Produces: `orders.destinationCountry`; `OrderContactRequestWire.destinationCountry?: string`.

- [ ] **Step 1: Write the failing tests**

```ts
it('stores the destination the customer chose', async () => {
  const { submit, orderId } = await cart();
  await submit({ contact: { email: 'a@b.co', destinationCountry: 'TH' } });

  expect(await destinationOf(orderId)).toBe('TH');
});

it('does not erase a destination the cart already had', async () => {
  /* orders.service.ts:780-790 records why: "A submit that carries only a telephone number
     must not *erase* an address a cart already had." The destination follows the same
     `body.contact.X ?? order.contactX` shape as every other contact field. */
  const { submit, orderId, setDestination } = await cart();
  await setDestination('TH');

  await submit({ contact: { phone: '0812345678' } });

  expect(await destinationOf(orderId)).toBe('TH');
});

it('refuses a lower-case code at the contract, not at the database', async () => {
  const { submit } = await cart();
  await expect(submit({ contact: { email: 'a@b.co', destinationCountry: 'th' } })).rejects.toMatchObject({
    status: 400,
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
pnpm --filter @wewin/api exec vitest run destination-submit
```

- [ ] **Step 3: Migration 0031**

```sql
-- ─────────────────────────────────────────────────────────────────────────────
-- ⭐ WHERE THIS ORDER IS GOING
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Nullable and mutable, both deliberately. Nullable because all 25 existing orders — the 21
-- carrying an issued document and the 4 drafts — predate the question, and migration 0017
-- established the house answer to inventing a value for a new NOT NULL column: it deleted the
-- rows rather than guess. Mutable because a customer who picks the wrong country should be
-- correctable; the tax that country produced stays pinned on the issued quotation.
--
-- No foreign key to tax_countries. Resolution (`resolveDestination`) does the checking, so it
-- can tell *withdrawn* from *unknown* — a constraint cannot, and would treat both alike.

ALTER TABLE "orders" ADD COLUMN "destination_country" char(2);
--> statement-breakpoint

ALTER TABLE "orders" ADD CONSTRAINT "orders_destination_country_shape"
  CHECK ("destination_country" IS NULL OR "destination_country" ~ '^[A-Z]{2}$');
```

Journal entry:

```json
{ "idx": 31, "version": "7", "when": 1786400000002, "tag": "0031_order_destination", "breakpoints": true }
```

- [ ] **Step 4: Extend the contract**

In `orderContactRequestSchema`'s object literal (`packages/contract/src/order.ts:622-632`), add:

```ts
    destinationCountry: z.string().regex(/^[A-Z]{2}$/u).optional(),
```

and the matching optional field on `OrderContactRequestWire`.

Edit the literal in place. (An earlier draft of the spec claimed the schema is a `ZodEffects` that cannot be `.extend()`ed — **that is false** on this repo's zod 4.4.3, where `.refine()` returns a `ZodObject`. The reason to edit in place is simpler: one declaration, consumed by `submitOrderRequestSchema` at `:646`, and the wire interface has to change anyway.)

- [ ] **Step 5: Write it in the submit service**

At the `applySubmission` call (`orders.service.ts:776`), beside the other contact fields:

```ts
      destinationCountry: body.contact.destinationCountry ?? order.destinationCountry,
```

- [ ] **Step 6: Run everything, migrate dev, commit**

```bash
pnpm typecheck && pnpm --filter @wewin/api test && pnpm db:migrate
git add packages/db packages/contract apps/api
git commit -m "feat: orders.destination_country, chosen at submit

Nullable and mutable — no backfill for the 25 existing orders, and no foreign key,
so resolveDestination can distinguish a withdrawn country from an unknown one.
Read with the ?? fallback every other contact field uses."
```

---

### Task 9: The rule reaches the document — without this, nothing else in the feature exists

**Files:**
- Modify: `apps/api/src/orders/order-document.ts` (`PriceOrderParams` `:119-132`; the `withHash({…})` literal at `:325`)
- Modify: `apps/api/src/orders/orders.service.ts` (`:715-725`, `:747-748`)
- Test: `apps/api/tests/orders/destination-pinning.pg.test.ts` (new)

**Interfaces:**
- Consumes: `resolveDestination` → `DestinationTax` (Task 7); `orders.destinationCountry` (Task 8); the two optional document fields (Task 2).
- Produces: a pinned document whose `vat`, `destinationCountry` and `taxBasis` all come from the resolved destination, and pinned columns that agree with it.

**Read spec §5.2 edit A before starting.** The trap this task exists to avoid: the formula switch (Task 10) is useless on its own, because `orders.service.ts:721` hardcodes `vat: DEFAULT_VAT_RULE` and `:747-748` pin `DEFAULT_VAT_RULE.rateBp` / `.treatment`. A version of this feature that changes only `overrides.ts` computes and pins 700 bp for every country and looks like it works.

**And `:741` cannot carry the two new fields.** `pinDocument` receives the built document plus the pinned *columns*, and there is deliberately no destination column — so the code and the basis travel **inside** `input.document`, which means `PriceOrderParams` and the `withHash` literal, not the pinning call.

- [ ] **Step 1: Write the failing test**

```ts
it('pins the destination country and basis into the document JSON, and the rate into the columns', async () => {
  const { submit, admin, taxCountries } = await harness();
  await taxCountries.create(
    { code: 'SG', nameTh: 'สิงคโปร์', rateBp: 900, treatment: 'standard', pricesIncludeTax: true },
    admin.id,
  );

  const { orderId } = await submit({ contact: { email: 'a@b.co', destinationCountry: 'SG' } });
  const row = await documentRow(orderId);

  expect(row.pinned_vat_rate_bp).toBe(900);
  expect(row.pinned_vat_treatment).toBe('standard');
  expect(row.document.destinationCountry).toBe('SG');
  expect(row.document.taxBasis).toBe('inclusive');
  expect(row.document.vat).toStrictEqual({ rateBp: 900, treatment: 'standard' });
});

it('survives the read path, which is where a missing schema declaration would eat it', async () => {
  const { submit, admin, taxCountries, readDocument } = await harness();
  await taxCountries.create(
    { code: 'SG', nameTh: 'สิงคโปร์', rateBp: 900, treatment: 'standard', pricesIncludeTax: true },
    admin.id,
  );

  const { orderId } = await submit({ contact: { email: 'a@b.co', destinationCountry: 'SG' } });

  /* Through the repository decoder, not straight out of Postgres. `order.repository.ts:735`
     returns `parsed.data`, and zod strips what the schema does not declare — silently, with
     no log, and unrepairable because the document is frozen. */
  const decoded = await readDocument(orderId);
  expect(decoded.destinationCountry).toBe('SG');
  expect(decoded.taxBasis).toBe('inclusive');
});

it('pins nothing new when the order names no destination, and still uses the default rule', async () => {
  const { submit, readDocument } = await harness();

  const { orderId } = await submit({ contact: { email: 'a@b.co' } });
  const decoded = await readDocument(orderId);

  expect(decoded.destinationCountry).toBeUndefined();
  expect(decoded.taxBasis).toBeUndefined();
  expect(decoded.vat).toStrictEqual(DEFAULT_VAT_RULE);
});
```

- [ ] **Step 2: Run and watch the first test fail on the rate, not on a crash**

```bash
pnpm --filter @wewin/api exec vitest run destination-pinning
```

Expected: FAIL with `expected 900, got 700`. **That specific failure is the point** — it is the whole feature, absent. If it fails some other way, fix the harness first.

- [ ] **Step 3: Extend `PriceOrderParams`**

In `apps/api/src/orders/order-document.ts`, add to the interface (`:119-132`), beside `vat`:

```ts
  /**
   * The destination this price was quoted for, or `null` when the order names none.
   *
   * Travels inside the document rather than as a pinned column, because the customer's
   * printed page is rendered from the document (`packages/core/src/quotation.ts:315`) and has
   * to know which layout to use. It cannot ask `tax_countries`: that table is mutable, and a
   * quotation prints what was quoted.
   */
  readonly destinationCountry: string | null;
  /** Which of `fromNet` / `fromGrand` ran. A record of a completed computation. */
  readonly taxBasis: 'inclusive' | 'exclusive';
```

- [ ] **Step 4: Write both into the `withHash` literal**

At `:325`, inside `withHash({ … })`, beside `vat: params.vat`:

```ts
    /* Omitted entirely when absent rather than written as `null`: the field is optional in
       `orderDocumentWireSchema`, and an explicit null would make every legacy document
       distinguishable from a new one for no reason anybody needs. */
    ...(params.destinationCountry === null ? {} : { destinationCountry: params.destinationCountry }),
    ...(params.destinationCountry === null ? {} : { taxBasis: params.taxBasis }),
```

- [ ] **Step 5: Resolve before pricing, and pin from the resolution**

In `apps/api/src/orders/orders.service.ts`, **before** the `priceOrderDocument({…})` call at `:715`:

```ts
    /* Resolution comes before pricing, and therefore before the order row that records the
       country is written at :776. The document is priced at :715 and pinned at :741; a
       resolution placed after either of those would pin a document that never saw it. */
    const destination = await this.taxCountries.resolveDestination(
      body.contact.destinationCountry ?? order.destinationCountry,
      tx,
    );
```

Then in the `priceOrderDocument` argument object, replace `vat: DEFAULT_VAT_RULE` (`:721`) with:

```ts
      vat: destination.rule,
      destinationCountry: destination.code,
      taxBasis: destination.basis,
```

and at `:747-748`:

```ts
      pinnedVatRateBp: destination.rule.rateBp,
      pinnedVatTreatment: destination.rule.treatment,
```

Inject `TaxCountryService` into `OrdersService` and export it from `OrganisationModule` so `OrdersModule` can import it.

- [ ] **Step 6: Run the tests, then mutation-test the pin**

```bash
pnpm --filter @wewin/api exec vitest run destination-pinning
```

All three PASS. Then revert `:747` to `DEFAULT_VAT_RULE.rateBp` and re-run: the first test must go **red** on the column while the JSON still says 900. That divergence — columns and document disagreeing — is exactly what `orders_totals_match_document` does *not* check, so the test is the only guard. Restore it.

- [ ] **Step 7: Confirm the 21 issued documents still read**

```bash
docker exec wewin-demo-postgres-1 psql -U wewin -d wewin -tAc \
  "select count(*), count(*) filter (where document ? 'destinationCountry') from order_documents"
```

Expected: `21|0`. Then, in the browser, open one existing quotation from `apps/web` and confirm it renders. This is the manual step the automated suite cannot do — the test databases are dropped and re-migrated empty on every run, so no suite can see these rows.

- [ ] **Step 8: Commit**

```bash
pnpm typecheck && pnpm --filter @wewin/api test
git add apps/api
git commit -m "feat(api): the resolved destination reaches the document and its pins

The half that makes the feature real: orders.service.ts:721 passed
DEFAULT_VAT_RULE and :747-748 pinned it, so a formula-only change would have
computed 700bp for every country. The code and basis travel inside the document
via PriceOrderParams and the withHash literal, because pinDocument takes columns
and there deliberately is no destination column."
```

---

### Task 10: The formula switch — both `fromNet` sites in `applyOverrides`

**Files:**
- Modify: `apps/api/src/quotes/overrides.ts` (`ApplyOverridesInput` `:166-175`; `:224`; `:256` comment; `:268`)
- Modify: `apps/api/src/orders/order-document.ts` (`:266` — the `applyOverrides` call inside the builder)
- Modify: `apps/api/tests/quotes/overrides.test.ts` (`:69` — its local `apply` helper gains `basis: 'exclusive'`, preserving every existing assertion)
- Test: `apps/api/tests/quotes/inclusive-basis.test.ts` (new — a unit test, no database needed)

**Interfaces:**
- Consumes: `taxBasis` from `PriceOrderParams` (Task 9).
- Produces: `ApplyOverridesInput.basis: 'inclusive' | 'exclusive'` — a **required** field, so every caller is forced to decide. Task 11 fixes the five callers this breaks.

**Read spec §5.2 edit B.** Two `fromNet` calls change and one does not:

| Line | What it computes | Change |
|---|---|---|
| `:224` | `money` — the figures the document and the customer see | branch on basis |
| `:268` | `baseline` — the "before negotiation" figure the dashboard shows | branch on basis, **same switch** |
| `:246` | a human `grand_total` override | **unchanged**, reserved |

`:246` keeps the exempt-charge split and the `belowExempt` refusal that raises `{ reason: 'grand_total_below_exempt_charges' }` (`order-document.ts:279-284`). A grand-total override on an inclusive order therefore composes unchanged — the typed figure is the later authority.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { applyOverrides } from '../../src/quotes/overrides';

const rule = { rateBp: 900, treatment: 'standard' } as const;

/** Two taxable lines, 20 000.00 and 10 000.00 baht, no overrides, no charges. */
const input = (basis: 'inclusive' | 'exclusive') => ({
  computed: [line(2_000_000n), line(1_000_000n)],
  charges: [],
  overrides: [],
  vat: rule,
  basis,
  computedLeadTimeDays: 30,
});

describe('inclusive basis', () => {
  it('treats the catalogue sum as the grand total and derives net from it', () => {
    const { money } = applyOverrides(input('inclusive'));

    expect(money.grandTotalThbMinor).toBe(3_000_000n);
    expect(money.netThbMinor).toBe(2_752_294n); // 3 000 000 × 10 000 / 10 900, half away from zero
    expect(money.vatThbMinor).toBe(247_706n);
    expect(money.netThbMinor + money.vatThbMinor).toBe(money.grandTotalThbMinor);
  });

  it('leaves exclusive exactly as it was', () => {
    const { money } = applyOverrides(input('exclusive'));

    expect(money.netThbMinor).toBe(3_000_000n);
    expect(money.vatThbMinor).toBe(270_000n);
    expect(money.grandTotalThbMinor).toBe(3_270_000n);
  });

  it('reports no phantom concession when nothing was negotiated', () => {
    /* The baseline at :268 must take the same branch as :224. Left on fromNet it lands ~9%
       above the effective total, so the dashboard shows staff a "before negotiation" figure
       above what the customer is charged, on every inclusive quote.

       The authority gate does NOT read this field — measureMargin's input is
       { vat, lines, overrides } and measureFor never calls applyOverrides — so a
       gate assertion would pass whether or not :268 is fixed. This is the assertion that
       cannot. */
    const { money, baseline } = applyOverrides(input('inclusive'));

    expect(baseline.grandTotalThbMinor).toBe(money.grandTotalThbMinor);
  });
});
```

`line(totalMinor)` builds a `ComputedLine` with `isVatApplicable: true`; copy its real shape from an existing `overrides` test.

- [ ] **Step 2: Run and watch two of the three fail**

```bash
pnpm --filter @wewin/api exec vitest run inclusive-basis
```

Expected: the `exclusive` test PASSES (nothing changed for it); the other two FAIL — the first on `netThbMinor`, the third on the baseline. If TypeScript refuses the `basis` property, that is the same signal; add the field in Step 3 and re-run to see the value failures.

- [ ] **Step 3: Add `basis` and branch both sites**

```ts
export interface ApplyOverridesInput {
  readonly computed: readonly ComputedLine[];
  readonly charges: readonly ChargeLine[];
  readonly overrides: readonly LiveOverride[];
  readonly vat: TaxRule;
  /**
   * Whether the line figures already contain the tax.
   *
   * Required, not optional with a default. A caller that has not thought about the
   * destination should not silently get exclusive arithmetic — that is precisely how staff
   * and customer end up holding papers that disagree.
   */
  readonly basis: 'inclusive' | 'exclusive';
  readonly computedLeadTimeDays: number;
}
```

At `:224` and `:268`, replace the direct `fromNet(x, vat)` with one shared local so the two cannot drift:

```ts
  /* One helper, used at both call sites. Two independent ternaries is how :268 gets left
     behind next time somebody touches this function. */
  const taxed = (baseMinor: bigint) =>
    input.basis === 'inclusive' ? fromGrand(baseMinor, vat) : fromNet(baseMinor, vat);
```

- [ ] **Step 4: Correct the stale comment at `:256`**

It currently calls the baseline *"the baseline the concession is measured from"*. Nothing measures a concession from it — `measureMargin` derives every source from override rows, and `AuthorityService.measureFor` never calls `applyOverrides`. Replace it with what is true: the baseline is a figure the sales screen renders, reaching the dashboard as `baselineGrandTotalThbMinor` (`apps/api/src/quotes/encode.ts:96`), and that field is its only consumer. Leaving the sentence is how the next reader repeats the mistake this plan already made once.

- [ ] **Step 5: Pass the basis from the document builder**

At `order-document.ts:266`, the `applyOverrides` call inside the builder gains `basis: params.taxBasis`.

- [ ] **Step 6: Run — and expect Task 11's five call sites to break the build**

```bash
pnpm typecheck
```

Expected: **two type errors** — `apps/api/src/quotes/quotes.service.ts:864` (the `applyOverrides` literal inside `effective()`) and `apps/api/tests/quotes/overrides.test.ts:69` (its local `apply` helper). `applyOverrides` has exactly three call sites and this task edits the third (`order-document.ts:266`) itself. The count is two, not five: `effective()`'s own five *callers* are unaffected until Task 11 changes its signature. That is correct and intended: the field is required so the compiler names every caller. **Do not** add a default to silence them — Task 11 is next and fixes them properly.

```bash
pnpm --filter @wewin/api exec vitest run inclusive-basis
```

All three PASS. **`exec vitest run`, not `test`** — `@wewin/api`'s `test` script is `tsc && vitest run`, so with a type error outstanding the suite would never be reached.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/quotes/overrides.ts apps/api/src/orders/order-document.ts apps/api/tests/quotes
git commit -m "feat(api): applyOverrides takes a basis, and both fromNet sites honour it

:224 for the money and :268 for the baseline, through one shared helper so they
cannot drift. :246 stays reserved for a human grand-total override.

Also corrects :256's comment, which claimed the baseline is what a concession is
measured from — it is not; measureMargin derives sources from override rows and
never sees it. Its only consumer is encode.ts:96, a display field.

pnpm typecheck now names two sites: quotes.service.ts:864 and the overrides test's
apply helper. That is deliberate; Task 11 fixes them."
```

---

### Task 11: The sales quote screen agrees with the document — five call sites

**Files:**
- Modify: `apps/api/src/quotes/quotes.service.ts` (`effective()` at `:864-871`; callers at `:143`, `:210`, `:812`, `:978`, `:1088`; **and the `encodeQuote` calls at `:164`, `:826`, `:890`**)
- Test: `apps/api/tests/quotes/inclusive-quote-screen.pg.test.ts` (new)

**Switching the money is not enough — the rate the dashboard *prints* is separate.** `encodeQuote`
receives `vat: DEFAULT_VAT_RULE` at `:164`, `:826` and `:890`. Left alone, an inclusive 900 bp
order returns money computed at 9% while the screen prints "VAT 7%". Pass `destination.rule` at
all three, and assert the rate as well as the totals:

```ts
  expect(onScreen.money.vat.rateBp).toBe(900);
```

**Interfaces:**
- Consumes: `ApplyOverridesInput.basis` (Task 10); `resolveDestination` (Task 7).
- Produces: `QuotesService.effective(lines, overrides, destination: DestinationTax)` — the third parameter is required.

**Why this is not polish.** `order-document.ts:254` refuses to call `fromNet` itself precisely so the document and the quote screen cannot diverge; its comment names *"how the invoice and the quote screen would come apart"* as the thing it prevents. Leaving `effective()` exclusive while the document goes inclusive recreates that divergence — staff quote one figure, the customer receives another.

- [ ] **Step 1: Write the failing test**

```ts
it('shows staff the same money the customer will be quoted, for an inclusive destination', async () => {
  const { admin, taxCountries, cart, quoteScreen, submit, documentOf } = await harness();
  await taxCountries.create(
    { code: 'SG', nameTh: 'สิงคโปร์', rateBp: 900, treatment: 'standard', pricesIncludeTax: true },
    admin.id,
  );
  const order = await cart({ destinationCountry: 'SG' });

  const onScreen = await quoteScreen(order.id);
  await submit(order.id, { contact: { email: 'a@b.co', destinationCountry: 'SG' } });
  const pinned = await documentOf(order.id);

  expect(onScreen.money.grandTotalThbMinor).toBe(pinned.grandTotalThbMinor);
  expect(onScreen.money.netThbMinor).toBe(pinned.netThbMinor);
  expect(onScreen.money.vatThbMinor).toBe(pinned.vatThbMinor);
});

it('still agrees for a destination that is exclusive', async () => {
  const { cart, quoteScreen, submit, documentOf } = await harness();
  const order = await cart({ destinationCountry: 'TH' });

  const onScreen = await quoteScreen(order.id);
  await submit(order.id, { contact: { email: 'a@b.co', destinationCountry: 'TH' } });

  expect(onScreen.money.grandTotalThbMinor).toBe((await documentOf(order.id)).grandTotalThbMinor);
});
```

- [ ] **Step 2: Run and watch the inclusive one fail**

```bash
pnpm --filter @wewin/api exec vitest run inclusive-quote-screen
```

Expected: the exclusive test PASSES; the inclusive one FAILS with the screen showing `3 270 000` against a document of `3 000 000` — the divergence, reproduced.

- [ ] **Step 3: Give `effective()` the destination and thread it to all five callers**

```ts
  private effective(
    lines: readonly QuoteLineRow[],
    overrides: readonly LiveOverride[],
    destination: DestinationTax,
  ) {
    /* … unchanged body … */
    return applyOverrides({
      computed,
      charges,
      overrides,
      vat: destination.rule,
      basis: destination.basis,
      computedLeadTimeDays: DEFAULT_LEAD_TIME_DAYS,
    });
  }
```

The five callers are not peers: `:143` (`getQuote`), `:812` (`mutate`) and `:978` (`baselineFor`)
are inside public entry points that own their own transaction, while `:210` and `:1088` are reached
from within them. So resolve **once per entry point**, at the top, and pass the same
`DestinationTax` down — never call `resolveDestination` five times in one request.

Read each of the five in the file before editing and confirm which group it is in; if one turns out
to be a third case with no order in scope, stop and report it rather than threading a parameter
through a method that has no business knowing about destinations. `destination_country` should come
back with the lines that call site is already fetching, not from a second round trip.

- [ ] **Step 4: Run the whole quotes suite**

```bash
pnpm typecheck && pnpm --filter @wewin/api test
```

Expected: green, and the five type errors from Task 10 are gone. Any remaining failure in an existing quotes test means a caller is passing a different destination than the one the document will use — read the diff before changing an assertion.

- [ ] **Step 5: Mutation-test the threading**

Hardcode `basis: 'exclusive'` inside `effective()` and re-run. The inclusive test must go **red**. Restore.

- [ ] **Step 6: Commit**

```bash
git add apps/api
git commit -m "feat(api): the quote screen resolves the destination, all five call sites

effective() was hardcoding DEFAULT_VAT_RULE and had no order in hand. Left as it
was, staff would have quoted exclusive money while the pinned document went
inclusive — the exact divergence order-document.ts:254 exists to prevent."
```

---

### Task 12: The deposit percentage becomes configuration

**Files:**
- Modify: `apps/api/src/payments/lifecycle/lifecycle.service.ts` (`pinsForSubmit` `:105-113`)
- Modify: `apps/api/src/orders/orders.service.ts` (`:774`, and the gate call at `:829`)
- Modify: `apps/api/src/quotes/authority/concession.ts` (`measureCashflow` `:361-365`)
- Modify: `apps/api/src/quotes/authority/authority.service.ts` (`measureFor` `:142`, calls at `:178-179`, prose at `:66-74`, `CASHFLOW_FLOOR_BP_DEFAULT` at `:615`)
- Test: `apps/api/tests/payments/deposit-policy.pg.test.ts` (new)

**Interfaces:**
- Consumes: `organisationProfile.depositBp` (Task 1), exposed by `OrganisationService` (Task 4).
- Produces: `pinsForSubmit(tx, grandTotalThbMinor, depositBp)`; `measureCashflow(grandTotalThbMinor, instalments, floorBp)`; `measureFor(order, tx, floorBp)`.

**Read spec §5.3 F–I.** Four groups of edits, and the count matters because an earlier draft of the spec called this "one omitted argument".

**F. Two consumers, and they cannot be fed the same way.** An earlier draft of this plan said
"read it once in the caller that owns the transaction" and passed it to both. That works for the
schedule and **not** for the concession measurement, because the measurement is not reached only
from submit:

```
measureCashflow ← measureFor ← { measure (:139), assess (:247), request (:407) }
                                        ↑
                                    gate (:359, via assess)
```

`measure` and `request` are reached from HTTP controllers with no submit transaction and no
deposit in scope. Threading a required `floorBp` down from every entry point would push a settings
concern into two controllers.

So: **the schedule gets the value passed in; the authority module gets a narrow port injected.**

```ts
/** One method, declared where it is needed. apps/api/src/quotes/authority/deposit-policy.port.ts */
export const DEPOSIT_POLICY = Symbol('DEPOSIT_POLICY');

export interface DepositPolicyPort {
  /** Basis points of the grand total that must be gated before production. */
  depositBp(tx?: AuthorityTx): Promise<number>;
}
```

`AuthorityService` injects it and calls it inside `measureFor`, so all three entry points are
served without any of them knowing about it. `OrganisationModule` provides the implementation.
This does not break the module's header rule — that rule is about not coupling to the Orders and
Schedule *domains*; a one-method port the module declares itself is the standard way to keep that
true while still reading a setting.

`OrdersService.submit` still reads `depositBp` directly for the schedule (G below), because it
already owns that transaction.

**G. At 10 000 bp the terms must stay what they are today.** `depositPercentTerms(10_000)` returns **two** rows — a gating `percent` row plus a `remainder` due `0n` — where submit produces one now. `apps/api/tests/payments/lifecycle/lifecycle.pg.test.ts:188` asserts `expect(rows).toHaveLength(1)`. That test **stays green**; it is not edited.

- [ ] **Step 1: Write the failing tests**

```ts
it('keeps today\'s single-instalment schedule when the policy is payment in full', async () => {
  const { submit, instalmentsOf } = await harness(); // deposit_bp is 10 000 as seeded

  const { orderId, grand } = await submit();
  const rows = await instalmentsOf(orderId);

  /* Exactly one row, due the whole amount. depositPercentTerms(10 000) would give two — a
     percent row plus a remainder due 0n — and would redden lifecycle.pg.test.ts:188 on a
     feature nobody switched on. */
  expect(rows).toHaveLength(1);
  expect(rows[0]?.due).toBe(grand);
});

it('gates production on the configured share when the policy is 30 per cent', async () => {
  const { setDeposit, submit, instalmentsOf } = await harness();
  await setDeposit(3_000);

  const { orderId, grand } = await submit();
  const rows = await instalmentsOf(orderId);

  expect(rows).toHaveLength(2);
  expect(rows[0]?.due).toBe((grand * 3_000n) / 10_000n);
  expect(rows[0]?.gatesStatus).toBe('production_confirmed');
});

it('does not treat a deposit at policy as a concession, so the submit completes', async () => {
  /* Without the floor moving, this is the failure the whole task exists to prevent: the gate
     runs inside the submit transaction (orders.service.ts:829), a below-floor schedule
     measures as a cashflow concession, and authority_limits has zero rows — so fail-closed
     refuses an approval it cannot grant and the entire submit rolls back: document, order,
     schedule and status event. */
  const { setDeposit, submit } = await harness();
  await setDeposit(3_000);

  await expect(submit()).resolves.toMatchObject({ status: 'submitted' });
});

it('still measures a real concession below policy', async () => {
  const { setDeposit, measure, planAt } = await harness();
  await setDeposit(3_000);

  expect(measure(planAt(3_000), 3_000)).toBe(0n);
  expect(measure(planAt(2_000), 3_000)).toBeGreaterThan(0n);
});
```

`measure(rows, floorBp)` calls `cashflowConcessionMinor(total, rows, floorBp)`; `planAt(bp)` builds the schedule from `depositPercentTerms(bp)`.

- [ ] **Step 2: Run and watch the second, third and fourth fail**

```bash
pnpm --filter @wewin/api exec vitest run deposit-policy
```

Expected: the first PASSES (nothing has changed yet); the rest FAIL — the fourth on `measure` being 2-arity.

- [ ] **Step 3: `measureCashflow` gains a floor**

```ts
export function measureCashflow(
  grandTotalThbMinor: bigint,
  instalments: readonly PlannedInstalment[],
  floorBp: number,
): DimensionMeasurement {
  const concession = cashflowConcessionMinor(grandTotalThbMinor, instalments, floorBp);
  /* … unchanged … */
}
```

Required, not defaulted — a default is how this silently returns to 10 000 bp.

`measureFor` (`authority.service.ts:142`) then reads the floor from the injected port rather than
taking it as a parameter:

```ts
  private async measureFor(order: OrderFacts, tx?: AuthorityTx): Promise<DocumentConcessions> {
    /* From the port, not from a parameter. `measure` (:139), `assess` (:247) and `request`
       (:407) all reach here, and two of them come from HTTP controllers with no deposit in
       scope — passing it down from every entry point would put a settings read in a
       controller. */
    const floorBp = await this.depositPolicy.depositBp(tx);
    /* … */
    measureCashflow(grandTotal, instalments, floorBp)
```

**Its signature does not change**, which is why the three callers and `gate` (`:359`, via
`assess`) need no edits at all. Both `measureCashflow` calls inside it — `:178-179`, one of which
is the `measureCashflow(0n, [])` empty case — pass `floorBp`.

- [ ] **Step 4: `pinsForSubmit` gains the deposit and selects terms**

**A diff against the existing body, not a replacement body.** `pinsForSubmit` returns
`{ instalments, scheduledDepositThbMinor, forfeitPolicyId }`, and it consults
`effectiveForfeitPolicy(tx)` and throws when no policy is in force — a fail-closed check with its
own long comment. Replacing the body would delete it.

Add the parameter:

```ts
  async pinsForSubmit(
    tx: LedgerTx,
    grandTotalThbMinor: bigint,
    depositBp: number,
  ): Promise<{ /* …unchanged… */ }> {
```

and change exactly one line inside it:

```ts
-   const instalments = this.schedule.plan(grandTotalThbMinor);
+   /* At payment in full, keep the terms submit has always produced. depositPercentTerms(10 000)
+      is not wrong, just different — a gating percent row plus a remainder due 0n, where submit
+      produces one row — and changing the default configuration's behaviour is not part of making
+      the number configurable. */
+   const instalments = this.schedule.plan(
+     grandTotalThbMinor,
+     depositBp === 10_000 ? payInFullTerms() : depositPercentTerms(depositBp),
+   );
```

`payInFullTerms()` and `depositPercentTerms()` are at `apps/api/src/payments/schedule/terms.ts:54`
and `:71`. Everything below that line — including the `effectiveForfeitPolicy` check and the
returned object — stays exactly as it is. Then `orders.service.ts:774` supplies `depositBp`.

Check `SchedulePlanner.plan`'s current signature before assuming it takes a second argument; if it
does not, add `terms` as an optional second parameter defaulting to today's behaviour, and say so
in the commit.

- [ ] **Step 5: Correct the prose and mark the dead constant**

`authority.service.ts:66-74` says *"authoring a deposit below payment-in-full will demand an approval that fail-closed cannot grant."* After this task that is true **below** policy and false **at** policy. Rewrite it to say both.

`CASHFLOW_FLOOR_BP_DEFAULT` (`:615`) is a re-export nothing reads — the live floor is `plan.ts:449`'s default parameter, and a module constant cannot hold a per-row database value anyway. Add one line saying so, so nobody mistakes editing it for doing the work.

**And record why `concession.ts:195` / `:332` are left alone**, in a comment beside them, because the next reader will see an inclusive-unaware `grossUp` and want to fix it (spec §5.2 D):

```
 * ⚠️ Exclusive-only, deliberately, and inclusive orders overstate here.
 *
 * `grossUp` is applied to the reduction itself (`:283` on the value from `:260`), not to two
 * states that are then differenced — so nothing cancels. Under an inclusive basis the same
 * per-line figures already contain the tax, and at 900 bp a ฿1,000.00 reduction the customer
 * genuinely saves measures ฿1,090.00. `:332` is worse still: it is `fromNet` on an absolute
 * list figure, not a difference at all.
 *
 * Accepted rather than fixed, on the grounds this file already states at `:187-192`: the
 * figure is never posted — it is compared against a ceiling and recorded in
 * `approvals.concession_thb_minor` as what was *asked for*, and nothing derives cash from it.
 * The error's direction is fail-closed: a larger measured concession demands more authority,
 * never less. The costs, so they are not discovered as bugs: on inclusive orders the
 * approver's inbox shows `sources` rows up to the rate above the customer's real saving, and
 * the recorded audit figure carries the same inflation.
 *
 * There is no test for this. Basis is not an input to `measureMargin` at any level —
 * `MarginInput` is `{ vat, lines, overrides }` and `TaxRule` is `{ rateBp, treatment }` — so
 * an "exclusive run versus inclusive run" assertion is one call with identical arguments and
 * cannot fail. Making these two sites basis-aware is a legitimate follow-up; it is out of
 * scope here because the measurement is unreachable in practice while `authority_limits` is
 * empty, and would be built with no way to observe it end to end.
```

- [ ] **Step 6: Run everything, including the test that must stay green**

```bash
pnpm typecheck && pnpm --filter @wewin/api test
```

Expected: all four new tests PASS **and** `lifecycle.pg.test.ts:188` still passes. If that one is red, Step 4's `depositBp === 10_000` branch is missing.

- [ ] **Step 7: Mutation-test the floor**

Revert `concession.ts:365` to two arguments and re-run. The third test — the submit at 30% — must go **red**, because the floor silently returns to 10 000 bp and fail-closed refuses. Restore.

- [ ] **Step 8: Commit**

```bash
git add apps/api
git commit -m "feat(api): the deposit percentage is configuration, and the approval floor moves with it

Four groups of edits, not one: read deposit_bp once in the submit transaction,
thread it into pinsForSubmit (which had no terms parameter), thread a floorBp
through measureCashflow (which is 2-arity and sits inside measureFor), and correct
the prose that said a below-full deposit always demands an ungrantable approval.

At 10 000 bp the terms stay exactly as they were: depositPercentTerms(10 000)
returns two rows where submit produces one, which would have reddened
lifecycle.pg.test.ts:188 on a feature nobody switched on."
```

---

### Task 13: The storefront picker, and the read-back that makes pre-fill possible

**Files:**
- Create: `apps/web/src/components/quote/DestinationSelect.tsx`
- Create: `apps/web/src/lib/quote/destinations.ts` (the `GET /destinations` fetcher)
- Modify: `apps/web/src/components/quote/RequestQuotationForm.tsx`
- Modify: `apps/web/src/lib/quote/prefillContact.ts`
- Modify: `packages/contract/src/order.ts` (`OrderContactWire` at `:346`)
- Modify: `apps/api/src/orders/…` (the order encoder and the repository's column selection)
- Test: `apps/web/tests/quote/destinations.test.ts` (new); extend `apps/web/tests/quote-prefill.test.ts`

**Interfaces:**
- Consumes: `GET /destinations` → `DestinationWire[]` (Task 5); `orders.destinationCountry` (Task 8).
- Produces: `OrderContactWire.destinationCountry: string | null`; `ContactPrefill.destinationCountry`.

**The sixth hop, and why it is its own step.** `OrderContactWire` (`packages/contract/src/order.ts:346`, used at `:387` as `OrderWire.contact`) carries `name`, `phone`, `email` and `locale` — four fields, no destination. `prefillContact.ts` decodes the prior order's contact from `GET /orders/:id` at `:172-176`. Without extending that wire type, its encoder and the repository's column selection, the country can never be pre-filled and the form will silently reset to Thailand for a returning customer. **`locale` is the field to copy from** — it already makes this exact round trip, so whatever it touches, the destination touches too.

- [ ] **Step 1: Write the failing tests**

**`.test.ts`, `fetch` stubbed with `vi.spyOn`, no msw.** There is no msw in this repo and no DOM
environment (see Verified Repo Facts). The three behaviours worth pinning are all reachable without
one: the fetcher's fallback, the prefill merge, and the rendered option list.

```ts
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { fetchDestinations } from '@/lib/quote/destinations';

/* `vi.stubGlobal`, the idiom apps/web/tests/reviews.test.ts:385-410 already uses for exactly
   this — including its 502 and malformed-body cases. */
const respond = (body: unknown, status = 200) =>
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
    ),
  );

describe('the destinations read', () => {
  it('returns what the API published, in the order it published it', async () => {
    respond([{ code: 'TH', nameTh: 'ไทย' }, { code: 'SG', nameTh: 'สิงคโปร์' }]);

    /* Server-side order is `sort_order`; the browser must not re-sort it. */
    expect(await fetchDestinations()).toStrictEqual([
      { code: 'TH', nameTh: 'ไทย' },
      { code: 'SG', nameTh: 'สิงคโปร์' },
    ]);
  });

  it('degrades to Thailand alone when the read fails, rather than throwing', async () => {
    /* A settings endpoint being down must not stop somebody asking for a price. */
    respond({}, 503);

    expect(await fetchDestinations()).toStrictEqual([{ code: 'TH', nameTh: 'ไทย' }]);
  });
});

describe('the select', () => {
  it('defaults to Thailand and lists every option it was given', () => {
    const markup = renderToStaticMarkup(
      createElement(DestinationSelect, {
        options: [{ code: 'TH', nameTh: 'ไทย' }, { code: 'SG', nameTh: 'สิงคโปร์' }],
        value: 'TH',
        onChange: () => {},
      }),
    );

    expect(markup).toContain('สิงคโปร์');
    expect(markup).toMatch(/value="TH"[^>]*selected/u);
  });

  it('starts on the destination a returning customer used last time', () => {
    const markup = renderToStaticMarkup(
      createElement(DestinationSelect, { options: [thailand(), singapore()], value: 'SG', onChange: () => {} }),
    );

    expect(markup).toMatch(/value="SG"[^>]*selected/u);
  });
});
```

`DestinationSelect` therefore takes `options`, `value` and `onChange` as props and does **no
fetching of its own** — the fetch lives in `RequestQuotationForm`, which is what makes both halves
testable without a network layer or a DOM.

Extend `apps/web/tests/quote-prefill.test.ts`, which already states the principle this task
follows — the decisions "live in pure functions (`resolveContactPrefill`, `fieldsToApply`) and are
tested here with no network at all". Both exist: `apps/web/src/lib/quote/prefillContact.ts:73` and
`:107`. Add `destinationCountry` to each and assert it survives the decode, that a prefilled value
beats the `TH` default, and that `newestSubmittedOrder()` still picks by greatest `submittedAt`.

**That the form still submits when the read fails is checked in the browser (Step 6).** It needs a
click.

- [ ] **Step 2: Run and watch it fail**

```bash
pnpm --filter @wewin/web exec vitest run destination-select
```

- [ ] **Step 3: Extend `OrderContactWire` and the read path**

Add `destinationCountry: z.string().nullable()` to `OrderContactWire` and its schema at `:346`, then follow `locale` through: the order encoder that builds the contact object, and the repository's column selection for `GET /orders/:id`. Grep for `contactLocale` in `apps/api/src/orders` and change every place it appears in that round trip.

- [ ] **Step 4: Build the select and the fetcher**

The select is a plain `<select>` with a real `<label>`, defaulting to `TH`, options ordered as the API returned them (`sort_order`, already applied server-side — do not re-sort in the browser). On a failed fetch, render a single Thailand option rather than an empty select or an error.

`apps/web/src/lib/quote/destinations.ts` follows the existing storefront fetcher idiom in `apps/web/src/lib/quotation/api.ts` — same error mapping, same `Cache-Control` expectations.

- [ ] **Step 5: Extend the pre-fill**

Add `destinationCountry` to `ContactPrefill` and `OrderContactRaw` in `prefillContact.ts`, and read it in the decode at `:172-176`. Keep `newestSubmittedOrder()`'s existing rule — greatest `submittedAt`, **not** the list's `updatedAt desc` order, because `moveStatus()` bumps `updatedAt` when staff advance an order while contact fields stay frozen at submit.

- [ ] **Step 6: Verify in the browser**

```bash
pnpm --filter @wewin/web dev
```

Configure Singapore in the dashboard, reload `/quote`, and confirm it appears in the select. Submit with it, then start a second quotation from the same account and confirm Singapore is pre-selected. A green component test with mocked fetches does not prove the round trip.

- [ ] **Step 7: Commit**

```bash
pnpm typecheck && pnpm --filter @wewin/web test
git add apps/web packages/contract apps/api
git commit -m "feat(web): destination picker, and the read-back that lets it pre-fill

OrderContactWire carried four fields and no destination, so without extending it
(plus the encoder and the repository read) the picker would reset to Thailand for
every returning customer. Followed locale, which already makes this round trip."
```

---

### Task 14: The storefront stops claiming a VAT rate it cannot know

**Files:**
- Modify: `apps/web/src/i18n/keys.ts`
- Modify: all eight of `apps/web/src/i18n/catalogues/{de,en,hi,la,my,th,vi,zh}.ts`
- Modify: `apps/web/src/app/[locale]/page.tsx` (`:155`, `:301`), `apps/web/src/app/[locale]/about/page.tsx` (`:190`, and `Fact` at `:305-324`)
- Modify: `apps/web/src/components/shell/AppFooter.tsx` (`:178`), `apps/web/src/components/quote/QuoteScreen.tsx` (`:180`, `:328`), `apps/web/src/components/configurator/ConfiguratorIsland.tsx` (`:611`), `apps/web/src/components/configurator/PriceSummary.tsx` (`:131`)
- Test: `apps/web/src/i18n/catalogue.test.ts` (must stay green), `apps/web/tests/vat-claims.test.ts` (new)

**Interfaces:**
- Consumes: nothing.
- Produces: `summary.area` replacing `summary.areaAndVat`, same `{ areaSqUm: bigint }` params.

**Why remove rather than reword (spec §8.2, D6).** Every render site sits on a route prerendered at build with `revalidate = false` and `dynamicParams = false` (`apps/web/src/app/[locale]/layout.tsx:33-34`, `:85`), so a rate is baked into the HTML. That is harmless today because nobody can change the rate. After this feature **the admin can**, and a prerendered "VAT 7%" becomes false the moment they do. Reading a country from `searchParams` is not an escape: on `products/[slug]` it would silently opt all 648 prerendered pages out of static rendering, with no error (`products/[slug]/page.tsx:43-49`).

**Delete** — from `keys.ts` and all eight catalogues:

| Key | Current Thai | Render sites |
|---|---|---|
| `price.vatExcluded` | `ราคายังไม่รวม VAT 7%` | `page.tsx:155`, `AppFooter.tsx:178`, `QuoteScreen.tsx:180`, `ConfiguratorIsland.tsx:611` |
| `price.vatExcludedShort` | `ยังไม่รวม VAT` | `QuoteScreen.tsx:328` — **one site** |
| `home.pricing.excluded.vat` | `VAT 7%` | `page.tsx:301` |
| `about.fact.startingPrice.note` | `ยังไม่รวม VAT 7%` | `about/page.tsx:190` |

**Rename** `summary.areaAndVat` → `summary.area`, render site `PriceSummary.tsx:131`, typed entry `keys.ts:190`. **Not a mechanical rename**: it is a parameterised key, so the replacement stays a function entry in all eight catalogues, and each of the other seven embeds the VAT clause *inside* the same interpolation — `zh.ts:194` is `` (p, f) => `${f.area(p.areaSqUm)} m² · 价格不含 7% 增值税` ``. Seven non-Thai strings must be **authored**, not copied.

**Keep** `quotation.vat` (`ภาษีมูลค่าเพิ่ม`) — a label on the quotation whose rate is data-driven from the pinned document. **Keep** `home.pricing.excluded.title` (`ราคานี้ยังไม่รวม`) — after `…excluded.vat` is deleted the list still holds `install`, `delivery` and `removal` (`page.tsx:299-306`), so the heading stays true and the block survives.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
/* Not from '@wewin/i18n' — that root is types-only and the import would throw at run time. */
import { LOCALES } from '@wewin/i18n/locales';

/**
 * Any digit seven, in any script these catalogues use, followed by a per-cent sign.
 *
 * `my.ts:43` writes `VAT ၇%` with U+107F, the Burmese seven. A regex matching only ASCII `7`
 * passes that file while the claim is still there — the vacuous-green failure this suite exists
 * to prevent. `de.ts` writes `7 %` with a space before the sign, which is the German
 * convention, so the space is optional rather than absent.
 */
const RATE_CLAIM = /[7๗၇७७७７]\s*%/u;

/** Entry lines only, so a translator note explaining a convention is not treated as a claim. */
const entryLines = (source: string) =>
  source.split('\n').filter((line) => /^\s*'[a-z]/iu.test(line.trimStart()) || /':\s/u.test(line));

describe('the storefront makes no VAT-rate claim', () => {
  it('has no catalogue entry naming a rate, in any locale', () => {
    for (const locale of LOCALES) {
      /* Relative to the vitest root, which for apps/web is the app directory — not the repo
         root. Check `apps/web/vitest.config.ts`'s `root` before trusting a bare path. */
      const source = readFileSync(`src/i18n/catalogues/${locale}.ts`, 'utf8');

      /* A rate baked into a prerendered page is a claim that goes stale the first time an admin
         edits tax_countries, and nothing would fail. */
      for (const line of entryLines(source)) {
        expect(line, `${locale}: ${line.trim()}`).not.toMatch(RATE_CLAIM);
      }
    }
  });

  it('has removed the four exclusivity keys from the key table', () => {
    const keys = readFileSync('apps/web/src/i18n/keys.ts', 'utf8');
    for (const key of [
      'price.vatExcluded',
      'price.vatExcludedShort',
      'home.pricing.excluded.vat',
      'about.fact.startingPrice.note',
    ]) {
      expect(keys, key).not.toContain(`'${key}'`);
    }
  });

  it('keeps the keys that are data-driven or still true', () => {
    const keys = readFileSync('apps/web/src/i18n/keys.ts', 'utf8');
    expect(keys).toContain(`'quotation.vat'`);
    expect(keys).toContain(`'home.pricing.excluded.title'`);
    expect(keys).toContain(`'summary.area'`);
  });
});
```

**Run it against the current tree first and confirm it finds today's occurrences in all eight
files, `my.ts` included.** A regex that misses one locale gives that locale a green test with the
claim still in it.

`de.ts:20`'s translator note — *"MwSt., not VAT. 7 % with a non-breaking space before the sign,
which is the German…"* — is **deliberately left alone**, which is why the assertion runs over entry
lines rather than the whole file. The note documents a convention that still governs any other
percentage German copy might carry; deleting it to satisfy a regex would be the test dictating the
source.

- [ ] **Step 2: Run and watch it fail with a list of real hits**

```bash
pnpm --filter @wewin/web exec vitest run vat-claims
```

Expected: FAIL naming every locale. Read the list — it is your work queue.

- [ ] **Step 3: Delete the four keys everywhere**

`keys.ts` first (so `th.ts` fails to compile and names anything you missed), then all eight catalogues, then the seven render sites.

For `page.tsx:301`, remove the `<li>{t('home.pricing.excluded.vat')}</li>` and leave the other three list items.

- [ ] **Step 4: Make `Fact.note` optional — a required prop cannot simply be dropped**

`about/page.tsx:313` declares `note: string` and `:320` renders it unconditionally in a `<span>`. Change to `note?: string` and guard:

```tsx
        {note === undefined ? null : <span className="block text-caption text-chalk-3">{note}</span>}
```

then remove the `note={…}` argument at `:190`. Removing only the argument would not compile.

- [ ] **Step 5: Rename `summary.areaAndVat`, authoring seven strings**

`keys.ts:190` becomes `'summary.area': { areaSqUm: bigint };`. The Thai entry:

```ts
  'summary.area': (p, f) => `${f.area(p.areaSqUm)} ตร.ม.`,
```

Then each of the other seven, keeping that locale's own unit conventions and dropping only the VAT clause — `zh` keeps `m²`, `my` keeps its numeral handling, and so on. Update `PriceSummary.tsx:131`.

- [ ] **Step 6: Confirm nothing else claimed a rate**

```bash
grep -rn "7 *%\|၇%\|ไม่รวม\|exclud\|zzgl\|不含\|chưa bao gồm\|शामिल नहीं\|ບໍ່ລວມ" apps/web/src | grep -v test
```

Every locale writes the claim in its own words, so an ASCII-only grep would report success while
five catalogues still carried it.

Expected: no VAT claim remains. `AppFooter` is on only three of the ten storefront page routes (`footer-routes.ts:32-34`, gated at `AppShell.tsx:88`), which is exactly why `QuoteScreen` and `ConfiguratorIsland` carried their own copies — this grep is what proves all of them are gone.

- [ ] **Step 7: Run the catalogue gate and the tokens gate**

```bash
pnpm --filter @wewin/web test && pnpm typecheck
```

`apps/web/src/i18n/catalogue.test.ts:446` asserts `coverageOf(locale) === 1` for all eight — deleting keys and renaming one must leave it green. `th.ts` is typed `UiCatalogue`, so a key deleted from `keys.ts` but left in `th.ts` is a compile error; the other seven fail only in that coverage test.

- [ ] **Step 8: Look at all three pages in the browser**

```bash
pnpm --filter @wewin/web dev
```

Check `/`, `/about`, `/quote` and one product page for an orphaned separator — several sites rendered the claim after a `·`, and deleting the text without the separator leaves a dangling dot.

- [ ] **Step 9: Commit**

```bash
git add apps/web
git commit -m "feat(web): the storefront stops claiming a VAT rate

Four keys deleted across eight locales, summary.areaAndVat renamed to summary.area
with seven newly authored strings, and Fact.note made optional because a required
prop cannot simply be dropped.

These pages are prerendered with revalidate = false, so a rate is baked into the
HTML. Harmless while nobody could change it; false the first time an admin does."
```

---

### Task 15: The quotation prints the basis it was computed on

**Files:**
- Modify: `packages/core/src/quotation.ts` (`PinnedDocument` `:56-71`, `pinnedDocumentFrom` `:315`, `printableQuotation` `:172`)
- Modify: `apps/web/src/components/quotation/QuotationIsland.tsx` (`:272`)
- Modify: `apps/dashboard/src/components/quotes/quotation-sheet.tsx` (`:302`)
- Modify: `apps/web/src/i18n/keys.ts` + all eight catalogues (`quotation.vatIncluded`)
- Test: `packages/core/tests/quotation.test.ts` (extend), `apps/web/tests/quotation/inclusive-layout.test.ts` (new — `.ts`, not `.tsx`)

**Interfaces:**
- Consumes: `document.destinationCountry`, `document.taxBasis` (Task 9).
- Produces: `PinnedDocument.taxBasis: 'inclusive' | 'exclusive'` (defaulted on read), `PinnedDocument.destinationCountry: string | null`, `PrintableQuotation.vatIsIncluded: boolean`.

**The layout (spec §8.1, D5).** For an exclusive destination nothing changes. For an inclusive one, line and charge amounts show **the price the customer saw in the catalogue**, and net and VAT appear as a breakdown beneath:

```
1. เก้าอี้อะลูมิเนียม        × 2      20,000.00
2. โต๊ะอะลูมิเนียม          × 1      10,000.00
───────────────────────────────────────────────
ยอดก่อนภาษี                          27,522.94
VAT 9% (รวมอยู่ในราคาแล้ว)             2,477.06
ยอดรวมที่ต้องชำระ                     30,000.00
```

The rejected alternative — scaling each line to its net share — fails on arithmetic, not taste: 20 000/1.09 and 10 000/1.09 round to 18 348.62 and 9 174.31, summing to 27 522.93 against a document net of 27 522.94. A one-satang gap on a page a customer reconciles is the same failure `vat.ts:61-63` cites as the reason `fromGrand` subtracts rather than multiplies.

**Both renderers change together.** `QuotationIsland.tsx:272` (customer) and `quotation-sheet.tsx:302` (staff) are two renderings of one document. If only one learns the layout, staff and customer hold papers that disagree.

- [ ] **Step 1: Write the failing tests**

```ts
it('reads a basis from the document and defaults to exclusive for older ones', () => {
  expect(pinnedDocumentFrom({ ...doc, taxBasis: 'inclusive' }, context).taxBasis).toBe('inclusive');
  /* Lenient, like its neighbours: a document older than the field is not a broken document. */
  expect(pinnedDocumentFrom(doc, context).taxBasis).toBe('exclusive');
  expect(pinnedDocumentFrom(doc, context).destinationCountry).toBeNull();
});

it('reports that VAT is included', () => {
  const pinned = pinnedDocumentFrom(
    { ...doc, taxBasis: 'inclusive', netThbMinor: '2752294', vatThbMinor: '247706', grandTotalThbMinor: '3000000' },
    context,
  );

  expect(printableQuotation(pinned).vatIsIncluded).toBe(true);
});

it('foots: lines and charges together equal the grand total under an inclusive basis', () => {
  /* Asserted on the PinnedDocument, NOT the PrintableQuotation. `PrintableLine` carries
     `netText: string` and `charges` is `{ labelTh, amountText }` — formatted strings, no minor
     units. The minor units live on `PinnedLine.netMinor`
     (packages/core/src/quotation.ts:48) and `PinnedCharge.amountMinor` (:53). */
  const pinned = pinnedDocumentFrom(
    { ...doc, taxBasis: 'inclusive', netThbMinor: '2752294', vatThbMinor: '247706', grandTotalThbMinor: '3000000' },
    context,
  );

  /* Both arrays. `lines` and `charges` are separate in the document
     (packages/contract/src/order.ts:313-314) and under inclusive the grand total is the sum of
     both, so a lines-only assertion is false for any quote carrying a charge. */
  const lineSum = pinned.lines.reduce((total, line) => total + line.netMinor, 0n);
  const chargeSum = pinned.charges.reduce((total, charge) => total + charge.amountMinor, 0n);

  expect(lineSum + chargeSum).toBe(pinned.grandTotalThbMinor);
  expect(pinned.netThbMinor + pinned.vatThbMinor).toBe(pinned.grandTotalThbMinor);
});
```

The `doc` fixture **must include at least one charge row**, or the footing assertion proves nothing
about the case that can break.

And a markup test — **`.test.ts`, not `.test.tsx`**, and `renderToStaticMarkup` rather than a
testing library, because this repo has no DOM environment and deliberately so (see Verified Repo
Facts). `react-dom/server` needs no DOM, so this runs under `environment: 'node'` as it stands:

```ts
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';

const markupFor = (basis: 'inclusive' | 'exclusive') =>
  renderToStaticMarkup(
    createElement(
      LocaleProvider,
      { locale: 'th' },
      createElement(QuotationIsland, { quotation: quotationFixture(basis) }),
    ),
  );

it('tells the customer when the price already contains the tax', () => {
  expect(markupFor('inclusive')).toContain('รวมอยู่ในราคาแล้ว');
});

it('says nothing extra for an exclusive quotation', () => {
  expect(markupFor('exclusive')).not.toContain('รวมอยู่ในราคาแล้ว');
});
```

Use the storefront's real locale-context provider and its real export name — read
`apps/web/src/state/localeContext.tsx`. If `QuotationIsland` needs more context than the locale
(a quote context, a unit preference), wrap those too; if the wrapping becomes unwieldy that is a
signal to assert on `printableQuotation` alone and rely on Step 7's browser check for the markup.

**Interaction is not tested here.** Clicking and typing need a DOM this repo does not provide;
Step 7's browser pass is where that is checked, which is why it is a required step and not a
suggestion.

- [ ] **Step 2: Run and watch them fail**

```bash
pnpm --filter @wewin/core exec vitest run quotation
pnpm --filter @wewin/web exec vitest run inclusive-layout
```

- [ ] **Step 3: Extend `PinnedDocument` and read both fields leniently**

```ts
  /** Frozen at submit; `null` on documents issued before the field existed. */
  readonly destinationCountry: string | null;
  /**
   * ⚠️ From the document, never from `tax_countries` — the same rule `pinnedLocale` follows
   * two fields above. That table is mutable; a quotation prints what was quoted.
   */
  readonly taxBasis: 'inclusive' | 'exclusive';
```

In `pinnedDocumentFrom` (`:315`), beside the `pinnedLocale` line at `:327`:

```ts
    destinationCountry: text(document['destinationCountry']) || null,
    taxBasis: document['taxBasis'] === 'inclusive' ? 'inclusive' : 'exclusive',
```

Lenient by design, matching the file's stated split at `:308-313`: money throws, presentation fields default.

- [ ] **Step 4: Add `vatIsIncluded` to `PrintableQuotation`**

`printableQuotation` sets `vatIsIncluded: document.taxBasis === 'inclusive'`. It computes nothing new — the three money figures are already correct in the document; only the wording changes.

- [ ] **Step 5: Add one i18n key across eight locales**

`keys.ts`: `'quotation.vatIncluded': Plain;`. Thai: `รวมอยู่ในราคาแล้ว`. Then the other seven, each in its own language.

This is the one VAT string the storefront *keeps*, and it is not a contradiction of Task 14: browsing pages are prerendered and cannot know the tax, while a quotation is per-destination and data-driven.

- [ ] **Step 6: Render it in both places**

`QuotationIsland.tsx:272`:

```tsx
        <Row
          label={`${t('quotation.vat')} ${quotation.vatRateText}${
            quotation.vatIsIncluded ? ` (${t('quotation.vatIncluded')})` : ''
          }`}
          value={quotation.vatText}
        />
```

`quotation-sheet.tsx:302` gets the equivalent, in Thai — the staff sheet is Thai-only and stays so.

- [ ] **Step 7: Run both suites, then print the page**

```bash
pnpm typecheck && pnpm --filter @wewin/core test && pnpm --filter @wewin/web test && pnpm --filter @wewin/dashboard test
```

Then, in the browser: create an inclusive-destination order, open its quotation, and print to PDF. Check that the three figures foot, that the lines sum to the grand total, and that the print stylesheet still renders the total in ink rather than as a watermark — `apps/web/src/app/globals.css`'s `@media print` block re-inks the tokens, and a new element inside the totals block could miss it.

- [ ] **Step 8: Commit**

```bash
git add packages/core apps/web apps/dashboard
git commit -m "feat: the quotation says when VAT is already in the price

Lines and charges show the catalogue price and sum to the grand total; net and VAT
read as a breakdown beneath. One new key across eight locales, and both renderers
change together — the customer page and the staff sheet are one document."
```

---

## Self-Review

Run against the spec with fresh eyes. Findings and their resolutions are recorded rather than silently fixed, because two of them changed a task.

**1. Spec coverage**

| Spec section | Task |
|---|---|
| §4.1 `tax_countries` + seed | 1 |
| §4.2 `tax_country_changes` | 1 |
| §4.3 `deposit_bp` + `organisation_profile_changes` | 1 (schema/migration), 4 (service) |
| §4.4 `orders.destination_country` | 8 |
| §5.1 resolution, four cases | 7 |
| §5.2 A (rule injection) | 9 |
| §5.2 B (both `fromNet` sites, stale comment) | 10 |
| §5.2 C (five `effective()` sites) | 11 |
| §5.2 D (per-line measurement untouched, cost documented) | **see finding (a)** |
| §5.2 E (no per-line document tax) | enforced by 9 and 10 touching only document-level calls |
| §5.3 F–I (deposit) | 12 |
| §6.1 hops 1–6 | 8 (1, 3, 5), 13 (2, 6), 9 (4) |
| §6.2 pinned fields | 2 (declaration), 9 (writing), 15 (reading) |
| §7.1 write pattern | 3, 4 |
| §7.2 permissions | 5 |
| §7.3 routes incl. public read | 5 |
| §7.4 two test tables | 5 |
| §7.5 dashboard | 6 |
| §8.1 inclusive layout | 15 |
| §8.2 claim removal | 14 |
| §8.3 left alone | no task, by design |
| §9 erasure | 1 |
| §10 migration mechanics | 1, 8 |
| §11 tests 1–7 | 1: —, 2: test 1 in Task 2 · test 2 in Task 2 · test 3 in Task 15 · test 4 in Task 12 · test 5 in Task 7 · test 6 in Task 14 · test 7 in Task 10 |
| §3 `vat.ts` header | 7 |
| §12 risks | each row's mitigation is a named step |

**(a) Gap found and closed:** §5.2 D says the per-source overstatement on inclusive orders is documented, not tested, and that `concession.ts:195`/`:332` stay exclusive. No task said so, which would leave an implementer free to "fix" it and change a measurement silently. **Resolution:** Task 12 Step 5 is where prose about the authority module is already being corrected; add one sentence there recording that `:195`/`:332` are deliberately untouched and why (never posted; fail-closed in direction). No behaviour change, no new task.

**(b) Gap found and closed:** the spec's §11 test 2 asks for a hand-built legacy fixture *and* a one-off manual read of `wewin` before merge. Task 2 covers the fixture; the manual read appears as Task 9 Step 7. Both are present — no change needed, recorded here so the reviewer can see it was checked.

**2. Placeholder scan**

No `TBD`, no "add error handling", no "similar to Task N". Three places intentionally say *read the real thing rather than trust this snippet* — the `connect()` helper in Task 1, `harness()` in Task 3 (which Task 5 then reuses), and the locale-context provider in Task 15. That is not a placeholder: inventing a fixture API that does not exist is the failure mode those notes prevent, and each names the exact file to copy from.

**3. Type consistency**

- `DestinationTax` — defined in Task 7, consumed with the same three fields in 9 and 11. ✓
- `basis` vs `taxBasis`: `ApplyOverridesInput.basis` (Task 10) and `PriceOrderParams.taxBasis` / the document field `taxBasis` (Tasks 9, 15). **Deliberately different**: the input is a parameter, the document field is a record. Task 10 Step 5 wires one to the other explicitly (`basis: params.taxBasis`) so the mismatch cannot be silent.
- `SettingChangeWire` is declared once in Task 2 and reused by Task 4 rather than re-declared. ✓
- `measureCashflow(grandTotalThbMinor, instalments, floorBp)` in Task 12 matches `cashflowConcessionMinor`'s existing third parameter name. ✓
- `summary.area` — renamed in Task 14, and no other task references `summary.areaAndVat`. ✓
- `pinsForSubmit(tx, grandTotalThbMinor, depositBp)` — Task 12 defines it; only `orders.service.ts:774` calls it. ✓

**4. Ordering**

Task 10 deliberately leaves `pnpm typecheck` red (five callers) and Task 11 fixes it. Any executor that requires a green typecheck at every task boundary must run 10 and 11 as one unit. Flagged in Task 10 Step 6 rather than hidden.
