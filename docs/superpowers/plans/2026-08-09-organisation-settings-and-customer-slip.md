# Organisation Settings and the Customer Payment Slip — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a customer see where to transfer money, attach a payment slip, and let an administrator maintain the receiving bank accounts and the company details that documents print.

**Architecture:** Three new tables (`bank_accounts`, `bank_account_changes`, `organisation_profile`) plus one column on `payment_slips`, behind two new permissions and one new API module. The slip API already exists and is untouched — this adds the screen that calls it, plus one new read route that tells a customer how much is outstanding and which accounts to pay into. PromptPay payload generation is a pure function in `packages/core`, rendered by the QR component `apps/web` already has.

**Tech Stack:** pnpm workspaces + Turborepo · NestJS 11 · Drizzle ORM + Postgres 16 · Next.js App Router (two apps) · zod 4 · vitest · Tailwind v4 with a closed token set.

## Global Constraints

- **Deletion is a status flag, never a real delete.** `is_active = false`, enforced by a trigger.
- **Money is `bigint` minor units end to end.** Never a float. `MoneyWire` on the wire is `{ unit: 'THB.satang', digits: string }`.
- **`packages/core` root is types-only.** Every runtime value comes from a subpath. `./money` already exists.
- **Every API route must carry an access decorator** or the app fails at `listen()`, not in a test.
- **All eight i18n catalogues must stay at 100%.** `th.ts` missing a key is a compile error.
- **Do not add anything to `apps/api/src/rbac/route-declarations.ts`** — a route that is both decorated and declared fails the boot audit.
- **Tailwind: only the project's token classes compile.** `text-sm`, `bg-slate-800`, `sm:` produce nothing and fail `check-tokens`.
- **Thai is the source language.** Error sentences that reach a customer come from the API already translated.
- Gate command, used at the end of every task: `pnpm typecheck && pnpm lint && pnpm boundaries && pnpm test`
- Baseline before this plan: **3,052 tests, none skipped.** Count tests; do not trust exit codes — `describeDb` is `describe.skipIf(!url)` and pg suites skip silently without a database.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `packages/core/src/promptpay.ts` | EMVCo payload string + CRC16-CCITT. Pure, no DOM. |
| `packages/core/tests/promptpay.test.ts` | Reference-vector tests for the above. |
| `packages/db/drizzle/0027_organisation.sql` | Three tables, their CHECKs, and three triggers. |
| `packages/db/src/schema/organisation.ts` | Drizzle definitions for the three tables. |
| `packages/db/tests/organisation.test.ts` | Guards: single row, block-delete, append-only. |
| `packages/contract/src/organisation.ts` | Request schemas and wire types. |
| `apps/api/src/organisation/organisation.controller.ts` | The six admin routes. |
| `apps/api/src/organisation/organisation.service.ts` | Reads/writes, and the history row on every change. |
| `apps/api/src/organisation/organisation.repository.ts` | Drizzle queries. |
| `apps/api/src/organisation/organisation.module.ts` | Wiring. |
| `apps/api/src/organisation/index.ts` | Barrel — module only. |
| `apps/api/tests/organisation/organisation.pg.test.ts` | Route behaviour against a real database. |
| `apps/api/tests/rbac/permission-parity.test.ts` | API vs dashboard permission-list parity. |
| `apps/dashboard/src/app/(app)/organisation/page.tsx` | Screen shell. |
| `apps/dashboard/src/components/organisation/organisation-screen.tsx` | The client screen. |
| `apps/dashboard/src/components/organisation/organisation-api.ts` | Fetch + decode. |
| `apps/dashboard/src/components/organisation/bank-account-dialog.tsx` | Create/edit form. |
| `apps/web/src/app/[locale]/payment/page.tsx` | Route file + metadata. |
| `apps/web/src/components/payment/PaymentIsland.tsx` | The client page. |
| `apps/web/src/components/payment/SlipForm.tsx` | Image + amount + time + reference. |
| `apps/web/src/components/payment/AccountPicker.tsx` | Account list + PromptPay QR. |
| `apps/web/src/lib/payment/api.ts` | The three calls this page makes. |
| `apps/web/tests/payment.test.ts` | Error-path behaviour. |

**Modified**

| File | Change |
|---|---|
| `packages/db/drizzle/meta/*` | Snapshot baseline reconciled (Task 1). |
| `packages/core/src/money.ts` | Gains `readSatang`, `satangField`, `ParseResult`. |
| `packages/core/tests/money.test.ts` | Gains the moved tests. |
| `packages/core/src/quotation.ts` | Comment only — records why its private `money()` is not the same function. |
| `apps/dashboard/src/components/slips/allocation-plan.ts` | Loses the two functions; imports them. |
| `apps/dashboard/tests/slip-allocation.test.ts` | Loses the moved describe block. |
| `apps/dashboard/src/components/slips/slip-review-dialog.tsx` | Import path. |
| `packages/db/src/schema/index.ts` | Re-exports `organisation.js`. |
| `packages/db/src/schema/auth.ts` | Three `ERASURE_TREATMENTS` entries. |
| `packages/db/tests/erasure.test.ts` | `createSubject` seeds the three new rows. |
| `apps/api/src/rbac/permissions.ts` | Two codes. |
| `apps/api/src/app.module.ts` | Imports `OrganisationModule`. |
| `apps/api/src/orders/orders.controller.ts` | One new GET. |
| `apps/api/tests/rbac/route-audit.test.ts` | Seven inventory entries. |
| `apps/api/tests/admin/route-permissions.test.ts` | Six rows. |
| `apps/dashboard/src/lib/auth/permissions.ts` | Two codes. |
| `apps/dashboard/src/lib/nav/navigation.ts` | One nav entry. |
| `apps/web/src/i18n/keys.ts` + all eight catalogues | ~28 keys. |
| `apps/web/src/i18n/catalogue.test.ts` | New `SAMPLE_PARAMS` entries. |
| `packages/core/src/quotation.ts:107` | Renderable locales fixed. |
| `apps/web/src/components/shell/LanguagePicker.tsx` | Stale `lang="th"` and header. |
| `apps/web/src/components/shell/AppFooter.tsx` | Stale docstring. |
| `apps/api/src/payments/slips/slips.module.ts` | Stale wiring comment. |

---

## Task 1: Reconcile the migration baseline

Nothing else can be migrated until this is done. `drizzle/meta/` stops at `0023`, and that snapshot records constraint names that `0023_admin_events.sql` never created, so `drizzle-kit generate` emits `DROP CONSTRAINT` statements for objects that have never existed and `migrate` aborts on the first one.

**Files:**
- Modify: `packages/db/drizzle/meta/0023_snapshot.json` (or replace the baseline — see Step 3)
- Modify: `packages/db/drizzle/meta/_journal.json`

**Interfaces:**
- Consumes: nothing.
- Produces: a `drizzle/meta/` state where `pnpm db:generate` emits only new objects.

- [ ] **Step 1: Prove the live database already matches the TypeScript schema**

Run each of these and record the output in the commit message. They are the evidence that the repair is a metadata fix and not a schema change.

```bash
docker exec wewin-demo-postgres-1 psql -U wewin -d wewin -c \
  "SELECT conname FROM pg_constraint WHERE conrelid='admin_events'::regclass ORDER BY 1;"
docker exec wewin-demo-postgres-1 psql -U wewin -d wewin -c \
  "SELECT conname FROM pg_constraint WHERE conrelid='user_phones'::regclass ORDER BY 1;"
docker exec wewin-demo-postgres-1 psql -U wewin -d wewin -c \
  "SELECT indexname FROM pg_indexes WHERE tablename='user_phones' ORDER BY 1;"
docker exec wewin-demo-postgres-1 psql -U wewin -d wewin -c \
  "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='orders_submitted_has_a_contact_channel';"
```

Expected, and already verified on 2026-08-09:
- `admin_events` has `admin_events_not_both_subjects` and `admin_events_group_actions_carry_a_code` — matching `auth.ts:1540,1555`, **not** the snapshot's `admin_events_one_subject` / `..._name_a_group`. It has no `subject_group_id` FK, which `auth.ts:1507-1515` explains is deliberate: `ON DELETE SET NULL` is an UPDATE and collides with `admin_events_append_only`.
- `user_phones` has `user_phones_number_e164` (`auth.ts:881`) and indexes `user_phones_number_idx`, `user_phones_one_primary_per_user`.
- `orders_submitted_has_a_contact_channel` is `submitted_at IS NULL OR contact_email IS NOT NULL OR contact_phone IS NOT NULL` — the post-0025 phone-inclusive version.

If any of these disagree, **stop and report**. The rest of this task assumes the database is correct and only the metadata is stale.

- [ ] **Step 2: Generate a snapshot that describes the current schema**

```bash
cd packages/db && pnpm db:generate
```

Expected: it writes `drizzle/0027_<generated-name>.sql`, `drizzle/meta/0027_snapshot.json`, and a `_journal.json` entry with `idx: 27`. The SQL will contain the `DROP CONSTRAINT` statements this task exists to eliminate — **that is the failure, made visible.** Read it, confirm it names `admin_events_one_subject`, and record it in the report.

⚠️ **Do not use `--custom` here.** It does not diff against the TypeScript schema at all — it clones the previous snapshot forward unchanged, so it would carry the stale `admin_events_one_subject` into the new file and fix nothing. Verified against drizzle-kit 0.31.10.

- [ ] **Step 3: Keep the snapshot, discard the rest, and name it after the last real migration**

The snapshot is the only useful artefact: it describes the current TypeScript schema, which is also what the database has. The SQL file and the journal entry must go.

```bash
rm packages/db/drizzle/0027_<generated-name>.sql
git checkout packages/db/drizzle/meta/_journal.json
mv packages/db/drizzle/meta/0027_snapshot.json packages/db/drizzle/meta/0026_snapshot.json
```

⚠️ **The journal entry must not survive, and this is not a style preference.** `drizzle-orm`'s `readMigrationFiles()` requires every `_journal.json` entry to have a matching `.sql` file, and it runs in the db suite's global setup — a dangling `idx: 27` entry makes all 326 tests fail before one of them executes. Task 5 writes the journal entry and the SQL file together, which is the only order that holds.

⚠️ **`0026` and not `0027`.** `drizzle-kit` picks its baseline by globbing `meta/` and taking the highest, not by reading the journal, so the name only has to sort last. `0026` is also the honest name: the snapshot describes the state *after* migration `0026_phone_one_claim`, which is the newest migration that exists. Naming it `0027` would claim a migration that has not been written, and would push Task 5's generated migration to `0028`.

- [ ] **Step 4: Prove the baseline is now clean**

```bash
cd packages/db && pnpm db:generate
```

Expected: **"No schema changes, nothing to migrate 😴"** — the snapshot matches the TypeScript schema exactly. If it emits any `DROP CONSTRAINT`, the baseline is still wrong; stop and report.

- [ ] **Step 5: Run the database suite**

```bash
pnpm --filter @wewin/db test
```
Expected: all pass, and the count matches the pre-change count. Record the number.

- [ ] **Step 6: Commit**

```bash
git add packages/db/drizzle/meta
git commit -m "fix(db): reconcile the migration snapshot baseline with reality

meta/ stopped at 0023 and that snapshot recorded constraint names
0023_admin_events.sql never created, so drizzle-kit generate emitted DROPs of
objects that have never existed in any database built from drizzle/ and
migrate aborted on the first one, before reaching any new table.

The live database already agrees with the TypeScript schema on all three
drifted objects; only meta/ was stale. Verified by querying pg_constraint and
pg_indexes for admin_events, user_phones and the orders contact-channel check
before touching anything.

The new baseline is named 0026 because that is the newest migration that
exists. drizzle-kit picks its baseline by globbing meta/ and taking the
highest, so the name only has to sort last — and claiming a 0027 that nobody
has written would push the real one to 0028. No journal entry is added:
readMigrationFiles requires every entry to have a .sql file, and it runs in
the db suite's global setup, so a dangling entry fails all 326 tests before
one executes."
```

---

## Task 2: Move `readSatang` and `satangField` into `packages/core`

`apps/web` has one money formatter, `f.baht()`, and it renders whole baht — `numerals.test.ts:220` pins `f.baht(879_100n) === '฿8,791'`. A payment page built on it silently drops satang. The dashboard already solved both directions with tests; `apps/web` cannot import from `apps/dashboard`, and rewriting means rewriting the bug.

**Files:**
- Modify: `packages/core/src/money.ts`
- Modify: `packages/core/tests/money.test.ts`
- Modify: `packages/core/src/quotation.ts` (comment only)
- Modify: `apps/dashboard/src/components/slips/allocation-plan.ts:113-164` (delete the block, import instead)
- Modify: `apps/dashboard/tests/slip-allocation.test.ts:1-3, 125-175`
- Modify: `apps/dashboard/src/components/slips/slip-review-dialog.tsx:24`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  // from '@wewin/core/money'
  export type ParseResult =
    | { readonly ok: true; readonly value: bigint }
    | { readonly ok: false; readonly problemTh: string };
  export function satangField(minor: bigint): string;
  export function readSatang(text: string): ParseResult;
  ```
  `./money` is **already** in `packages/core/package.json` exports — no new entry is needed.

- [ ] **Step 1: Move the tests first, and watch them fail**

Cut the whole `describe('⭐ reading baht-and-satang out of a text box', …)` block from `apps/dashboard/tests/slip-allocation.test.ts:125-175` and paste it into `packages/core/tests/money.test.ts`, changing only the import to the relative form core's own tests use:

```ts
import { readSatang, satangField } from '../src/money.js';
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @wewin/core exec vitest run tests/money.test.ts
```
Expected: FAIL — `readSatang is not a function` / no export named `readSatang`.

- [ ] **Step 3: Move the implementation**

Append to `packages/core/src/money.ts`, verbatim from `allocation-plan.ts:113-164` including every comment:

```ts
/* ------------------------------------------------------------------ *
 * Reading an amount out of a text box
 * ------------------------------------------------------------------ */

export type ParseResult = { readonly ok: true; readonly value: bigint } | { readonly ok: false; readonly problemTh: string };

/** `฿1,972.24` for a text box: no currency mark, no grouping, always two places. */
export function satangField(minor: bigint): string {
  const negative = minor < 0n;
  const magnitude = negative ? -minor : minor;
  const satang = (magnitude % 100n).toString().padStart(2, '0');

  return `${negative ? '-' : ''}${(magnitude / 100n).toString()}.${satang}`;
}

/** Optional thousands separators, then baht, then at most two decimal places. */
const AMOUNT = /^(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?$/u;

/**
 * ⭐ Baht-and-satang from a text box, read as digits rather than as a number.
 *
 * ⚠️ **`Math.trunc(parseFloat(text) * 100)` is wrong 2.6% of the time.** Measured, not
 * assumed: across the 200,000 amounts between ฿0 and ฿40,000 ending in .01/.29/.57/.83/.99,
 * it produces the wrong satang for 5,209 of them — `0.29` becomes 28, `2.01` becomes 200 —
 * because those decimals are not representable in binary and land a hair below.
 *
 * `Math.round` rescues these magnitudes, and that is the problem with it: it is a claim
 * about how large the numbers will be, made in a function whose job is deciding where
 * somebody's money goes. Splitting the string has no magnitude at which it starts being
 * wrong, and needs no argument about which magnitudes are reachable.
 *
 * The API refuses anything but positive amounts (`positiveThbSchema`), so a minus is a typo
 * here and not a credit — refused with a sentence rather than sent and 422'd.
 */
export function readSatang(text: string): ParseResult {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: false, problemTh: 'กรอกจำนวนเงิน' };

  const match = AMOUNT.exec(trimmed);
  if (match === null) {
    return { ok: false, problemTh: 'กรอกเป็นตัวเลข ทศนิยมไม่เกินสองตำแหน่ง เช่น 1972.24' };
  }

  const baht = (match[1] ?? '').replaceAll(',', '');
  /*
   * `.4` is forty satang, not four. Padding rather than parsing is the same decision as
   * above: "5.4" and "5.40" are one amount, and the place a digit sits in decides its value.
   */
  const satang = (match[2] ?? '').padEnd(2, '0');

  return { ok: true, value: BigInt(baht) * 100n + BigInt(satang === '' ? '0' : satang) };
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
pnpm --filter @wewin/core exec vitest run tests/money.test.ts
```
Expected: PASS, 5 tests in the moved describe block.

- [ ] **Step 5: Delete the originals and rewire the dashboard**

Delete `allocation-plan.ts:113-164` (the whole section from the banner comment through the end of `readSatang`) and add at the top of that file:

```ts
import { readSatang, satangField, type ParseResult } from '@wewin/core/money';
```

Then re-export them so existing importers keep working without a sweep:

```ts
export { readSatang, satangField, type ParseResult };
```

In `apps/dashboard/tests/slip-allocation.test.ts`, change line 3 to drop the moved names:

```ts
import { allocationPlan, type Draft } from '../src/components/slips/allocation-plan';
```

`slip-review-dialog.tsx:24` needs no change if the re-export above is in place; verify by typecheck rather than by assumption.

- [ ] **Step 6: Record why `quotation.ts`'s private `money()` is not the same function**

Add above `function money(` in `packages/core/src/quotation.ts`:

```ts
/*
 * ⚠️ Not `satangField` from `./money`, and not a duplicate of it either.
 *
 * `satangField` renders into a *text box*: no currency mark, no grouping, so the value it
 * writes is the value `readSatang` reads back. This one renders onto a *document*: it has
 * the ฿ and it groups thousands in the reader's locale, neither of which a field may carry.
 * They split digits the same way for the same reason, and merging them would break whichever
 * caller lost its half.
 */
```

- [ ] **Step 7: Run the gate**

```bash
pnpm typecheck && pnpm lint && pnpm boundaries && pnpm test
```
Expected: exit 0. Core gains 5 tests, dashboard loses 5 — the total stays at 3,052.

- [ ] **Step 8: Commit**

```bash
git add packages/core apps/dashboard
git commit -m "refactor(core): move readSatang/satangField into @wewin/core/money

apps/web's only money formatter is f.baht(), which renders whole baht —
numerals.test.ts pins f.baht(879_100n) === '฿8,791'. The payment page needs to
echo an exact transfer, so it needs these two, and it cannot import from
apps/dashboard.

Moved rather than rewritten: allocation-plan.ts's comment records that
Math.trunc(parseFloat(text) * 100) is wrong for 5,209 of 200,000 measured
amounts, and a fresh implementation is a fresh chance to reintroduce that.

./money was already in core's exports map, so no new subpath was added.
quotation.ts's private money() stays separate, with a comment saying why:
a field may not carry a currency mark or grouping, and a document must."
```

---

## Task 3: PromptPay payload in `packages/core`

**Files:**
- Create: `packages/core/src/promptpay.ts`
- Create: `packages/core/tests/promptpay.test.ts`
- Modify: `packages/core/package.json` (add `"./promptpay": "./dist/promptpay.js"` to `exports`)

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  // from '@wewin/core/promptpay'
  export type PromptPayTarget =
    | { readonly kind: 'mobile'; readonly digits: string }   // 10 digits, national form
    | { readonly kind: 'taxId'; readonly digits: string };   // 13 digits
  export function promptPayTarget(id: string): PromptPayTarget | null;
  export function promptPayPayload(target: PromptPayTarget, amountMinor: bigint): string;
  export function crc16ccitt(input: string): string;         // four uppercase hex digits
  ```

- [ ] **Step 1: Write the failing test**

`packages/core/tests/promptpay.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { crc16ccitt, promptPayPayload, promptPayTarget } from '../src/promptpay.js';

/**
 * ⭐ A QR that scans and carries the wrong number is the whole risk here.
 *
 * Nothing on screen can show this is wrong — the image renders, the phone reads it, and the
 * amount is off. So the assertions are against known payloads rather than against a
 * re-implementation of the same arithmetic.
 */
describe('CRC16-CCITT (0x1021, init 0xFFFF)', () => {
  it('matches the published check value', () => {
    // The standard test vector for this parameterisation.
    expect(crc16ccitt('123456789')).toBe('29B1');
  });

  it('is four uppercase hex digits, zero-padded', () => {
    expect(crc16ccitt('A')).toMatch(/^[0-9A-F]{4}$/u);
  });
});

describe('reading a PromptPay identifier', () => {
  it('takes ten digits as a mobile number and thirteen as a tax id', () => {
    expect(promptPayTarget('0812345678')).toStrictEqual({ kind: 'mobile', digits: '0812345678' });
    expect(promptPayTarget('0105561000001')).toStrictEqual({
      kind: 'taxId',
      digits: '0105561000001',
    });
  });

  it('refuses anything else rather than guessing', () => {
    for (const bad of ['', '081234567', '08123456789', 'abcdefghij', '081-234-5678']) {
      expect(promptPayTarget(bad), `"${bad}" was accepted`).toBeNull();
    }
  });
});

describe('the payload', () => {
  const mobile = { kind: 'mobile', digits: '0812345678' } as const;

  it('opens with the format indicator and closes with a CRC over everything before it', () => {
    const payload = promptPayPayload(mobile, 100_00n);

    expect(payload.startsWith('000201')).toBe(true);
    expect(payload.slice(-8, -4)).toBe('6304');
    expect(payload.slice(-4)).toBe(crc16ccitt(payload.slice(0, -4)));
  });

  it('writes the amount in baht with two decimal places', () => {
    // ฿1,972.24 → tag 54, length 07, value 1972.24
    expect(promptPayPayload(mobile, 197_224n)).toContain('54071972.24');
    // ฿100.00 → length 06
    expect(promptPayPayload(mobile, 100_00n)).toContain('5406100.00');
  });

  it('carries a mobile number as 66 + the nine digits after the leading zero', () => {
    // Tag 29 → sub-tag 01 (mobile), 13 digits: 0066 + 812345678
    expect(promptPayPayload(mobile, 100_00n)).toContain('01130066812345678');
  });

  it('marks a payload that names an amount as single-use', () => {
    // Point-of-initiation 12 = dynamic. A static QR (11) with an amount is a contradiction.
    expect(promptPayPayload(mobile, 100_00n)).toContain('010212');
  });

  it('refuses a non-positive amount rather than emitting a scannable zero', () => {
    expect(() => promptPayPayload(mobile, 0n)).toThrow(RangeError);
    expect(() => promptPayPayload(mobile, -1n)).toThrow(RangeError);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @wewin/core exec vitest run tests/promptpay.test.ts
```
Expected: FAIL — cannot resolve `../src/promptpay.js`.

- [ ] **Step 3: Write the implementation**

`packages/core/src/promptpay.ts`:

```ts
import { satangField } from './money.js';

/**
 * ⭐ A PromptPay QR payload, built as a string.
 *
 * EMVCo's format is nested TLV in ASCII: a two-digit tag, a two-digit length, then that many
 * characters. Nothing here is base64 or binary, which is why this module needs no dependency
 * and can be tested without rendering anything.
 *
 * ⚠️ **The only failure this can have is silent.** A malformed payload does not scan and is
 * found immediately; a well-formed payload with the wrong amount scans perfectly and moves
 * the wrong money. That is why the tests assert against published vectors rather than
 * against a second implementation of the same arithmetic, and why the last step before
 * shipping this is scanning one with a real banking app.
 */

const ID_APPLICATION = 'A000000677010111';

export type PromptPayTarget =
  | { readonly kind: 'mobile'; readonly digits: string }
  | { readonly kind: 'taxId'; readonly digits: string };

/** `29` sub-tag: `01` for a mobile number, `02` for a tax id or national id. */
const SUB_TAG: Readonly<Record<PromptPayTarget['kind'], string>> = {
  mobile: '01',
  taxId: '02',
};

/** One TLV field. Length is characters, always two digits, so a 100-char value is illegal. */
function field(tag: string, value: string): string {
  if (value.length > 99) throw new RangeError(`promptpay: value for tag ${tag} is too long`);
  return `${tag}${value.length.toString().padStart(2, '0')}${value}`;
}

/**
 * CRC-16/CCITT-FALSE — polynomial 0x1021, initial value 0xFFFF, no reflection, no final xor.
 *
 * This is the parameterisation EMVCo names, and it is not the same as the CRC-16 most
 * libraries default to. `crc16ccitt('123456789') === '29B1'` is the check value that tells
 * the two apart, which is why it is the first assertion in the test.
 */
export function crc16ccitt(input: string): string {
  let crc = 0xffff;

  for (const character of input) {
    crc ^= character.charCodeAt(0) << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) === 0 ? crc << 1 : (crc << 1) ^ 0x1021;
      crc &= 0xffff;
    }
  }

  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * Read a stored `promptpay_id`, which the CHECK constraint has already limited to ten or
 * thirteen digits. Returns `null` rather than throwing, so a bad row shows the account
 * without a QR instead of taking the page down.
 */
export function promptPayTarget(id: string): PromptPayTarget | null {
  if (/^[0-9]{10}$/u.test(id)) return { kind: 'mobile', digits: id };
  if (/^[0-9]{13}$/u.test(id)) return { kind: 'taxId', digits: id };
  return null;
}

/** A mobile number as EMVCo wants it: country code, no leading zero, padded to thirteen. */
function accountValue(target: PromptPayTarget): string {
  if (target.kind === 'taxId') return target.digits;
  return `0066${target.digits.slice(1)}`;
}

/**
 * The payload for one transfer of a known amount.
 *
 * ⚠️ Point-of-initiation is `12` (dynamic), not `11` (static). A static QR means "any
 * amount", and one that also names an amount is a contradiction some banking apps resolve by
 * ignoring the amount — which is the failure that looks like it worked.
 */
export function promptPayPayload(target: PromptPayTarget, amountMinor: bigint): string {
  if (amountMinor <= 0n) {
    throw new RangeError(`promptpay: amount must be positive, got ${amountMinor.toString()}`);
  }

  const merchant = field('00', ID_APPLICATION) + field(SUB_TAG[target.kind], accountValue(target));

  const body =
    field('00', '01') +
    field('01', '12') +
    field('29', merchant) +
    field('53', '764') +
    field('54', satangField(amountMinor)) +
    field('58', 'TH');

  return `${body}6304${crc16ccitt(`${body}6304`)}`;
}
```

- [ ] **Step 4: Add the export and run to verify it passes**

Add to `packages/core/package.json` `exports`, after `"./phone"`:

```json
    "./promptpay": "./dist/promptpay.js"
```

```bash
pnpm --filter @wewin/core exec vitest run tests/promptpay.test.ts
pnpm --filter @wewin/core build
```
Expected: PASS, 8 tests. Build succeeds.

- [ ] **Step 5: Mutate to prove the tests can fail**

Run each, confirm RED, then revert:

| Mutation | Must fail |
|---|---|
| `crc ^= character.charCodeAt(0) << 8` → `<< 4` | the `29B1` check value |
| `field('01', '12')` → `field('01', '11')` | the single-use assertion |
| drop the `field('54', …)` line | both amount assertions |
| `0066${target.digits.slice(1)}` → `0066${target.digits}` | the mobile-number assertion |

- [ ] **Step 6: Commit**

```bash
git add packages/core
git commit -m "feat(core): PromptPay EMVCo payload and CRC16-CCITT

Pure string building, so it is testable without a DOM and without the QR
renderer. The only failure mode this has is silent — a wrong amount still
scans — so the tests assert against the published CRC check value and against
known tag layouts rather than against a second implementation of the same
arithmetic. Four mutations run and killed.

Point-of-initiation is 12 (dynamic) rather than 11: a static QR means 'any
amount', and one that also carries an amount is a contradiction some apps
resolve by ignoring the amount."
```

---

## Task 4: Schema for the three tables

**Files:**
- Create: `packages/db/src/schema/organisation.ts`
- Modify: `packages/db/src/schema/index.ts`
- Modify: `packages/db/src/schema/auth.ts` (`ERASURE_TREATMENTS`)

**Interfaces:**
- Consumes: nothing.
- Produces: `bankAccounts`, `bankAccountChanges`, `organisationProfile` drizzle tables, exported from `@wewin/db/schema`.

- [ ] **Step 1: Write the schema file**

`packages/db/src/schema/organisation.ts`. Note `timestamps` is a module-private const in every schema file — paste it, do not import it.

```ts
import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { users } from './auth.js';

/**
 * The company's own details, and the accounts it is paid into.
 *
 * ⚠️ **Named `organisation` and not `settings`.** `/[locale]/settings` already exists in
 * `apps/web` and means the *customer's* display preferences — language, unit, currency. One
 * word with two meanings in one repository is a bug waiting for a reader in a hurry.
 */

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

/**
 * An account the company is paid into.
 *
 * ⚠️ `bank_code` is `text` with a shape CHECK and **not** a `pgEnum`. The rule `auth.ts`
 * states for itself is about whether the set can grow, and this one grows: TMB and
 * Thanachart became ttb, and the next merger will not wait for a migration window.
 *
 * Rows are never deleted — `bank_accounts_block_delete` refuses it. A retired account is
 * `is_active = false`, because `payment_slips.received_bank_account_id` points at it and a
 * slip from last year must still say where the money went.
 */
export const bankAccounts = pgTable(
  'bank_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bankCode: text('bank_code').notNull(),
    accountNumber: text('account_number').notNull(),
    accountName: text('account_name').notNull(),
    /** Ten digits is a mobile number, thirteen a tax id. `@wewin/core/promptpay` reads it. */
    promptpayId: text('promptpay_id'),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    updatedByUserId: uuid('updated_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...timestamps,
  },
  (table) => [
    unique('bank_accounts_number_key').on(table.bankCode, table.accountNumber),
    check('bank_accounts_bank_code_shape', sql`${table.bankCode} ~ '^[A-Z]{3,8}$'`),
    check('bank_accounts_number_shape', sql`${table.accountNumber} ~ '^[0-9]{10,15}$'`),
    check('bank_accounts_name_says_something', sql`length(btrim(${table.accountName})) > 0`),
    check(
      'bank_accounts_promptpay_shape',
      sql`${table.promptpayId} is null or ${table.promptpayId} ~ '^([0-9]{10}|[0-9]{13})$'`,
    ),
    index('bank_accounts_active_idx').on(table.isActive, table.sortOrder),
  ],
);

/**
 * Every edit to a bank account, kept forever.
 *
 * ⚠️ This exists because changing the receiving account number is the classic version of
 * this fraud: change it, wait for one transfer, change it back. `updated_by_user_id` on the
 * account itself answers "who last touched this" and nothing else — which is exactly the
 * question that shape of attack survives.
 *
 * `before` is null on a create; `after` is null on nothing, because a deactivation is an
 * ordinary field change and is recorded as one.
 */
export const bankAccountChanges = pgTable(
  'bank_account_changes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bankAccountId: uuid('bank_account_id')
      .notNull()
      .references(() => bankAccounts.id, { onDelete: 'restrict' }),
    changedByUserId: uuid('changed_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
    before: jsonb('before'),
    after: jsonb('after').notNull(),
  },
  (table) => [index('bank_account_changes_account_idx').on(table.bankAccountId, table.changedAt)],
);

/**
 * The company, as a document prints it. Exactly one row.
 *
 * ⚠️ **These values are read at render time and never pinned into a document.**
 * `order.repository.ts` `safeParse`s every stored document against a `z.literal` schema
 * version with no union reader, so adding seller fields to the pinned shape would stop every
 * already-issued quotation from printing. It is also the behaviour a company that moves
 * office actually wants: a price is an offer and is frozen, a letterhead is not.
 */
export const organisationProfile = pgTable(
  'organisation_profile',
  {
    /** One row, and Postgres is what says so. */
    id: smallint('id').primaryKey().default(1),
    legalNameTh: text('legal_name_th').notNull(),
    legalNameEn: text('legal_name_en'),
    addressTh: text('address_th').notNull(),
    addressEn: text('address_en'),
    /** Thai tax registration. Nothing in this repository had one before. */
    taxId: char('tax_id', { length: 13 }),
    phone: text('phone').notNull(),
    email: text('email'),
    updatedByUserId: uuid('updated_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...timestamps,
  },
  (table) => [
    check('organisation_profile_one_row', sql`${table.id} = 1`),
    check('organisation_profile_tax_id_shape', sql`${table.taxId} is null or ${table.taxId} ~ '^[0-9]{13}$'`),
    check('organisation_profile_legal_name_says_something', sql`length(btrim(${table.legalNameTh})) > 0`),
    check('organisation_profile_address_says_something', sql`length(btrim(${table.addressTh})) > 0`),
  ],
);
```

- [ ] **Step 2: Re-export from the barrel**

Add to `packages/db/src/schema/index.ts`, following the existing `.js`-suffixed form:

```ts
export * from './organisation.js';
```

- [ ] **Step 3: Add the `payment_slips` column**

In `packages/db/src/schema/payment.ts`, add to the `paymentSlips` table definition:

```ts
    /**
     * Which of the company's accounts received this transfer.
     *
     * Nullable: no slip existed when the column was added, and a retired account must stay
     * referenceable. `on delete restrict` is redundant beside `bank_accounts_block_delete`
     * and is written anyway, because a guard and a constraint fail differently and the
     * constraint is the one a reader finds.
     */
    receivedBankAccountId: uuid('received_bank_account_id').references(() => bankAccounts.id, {
      onDelete: 'restrict',
    }),
```

Import `bankAccounts` at the top of `payment.ts`.

- [ ] **Step 4: Add the erasure treatments**

In `packages/db/src/schema/auth.ts`, inside `ERASURE_TREATMENTS`, keeping the file's grouping:

```ts
  /*
   * ⚠️ `scrub` and not `delete`, for the reason `user_phones.verified_by_user_id` gives.
   *
   * These name the member of *staff* who changed a bank account or the company profile.
   * Erasing that account must not erase the record that the company acted — that record is
   * the company's own history, and it is the only thing standing between a changed account
   * number and nobody being able to say who changed it.
   */
  'bank_accounts.updated_by_user_id': 'scrub',
  'bank_account_changes.changed_by_user_id': 'scrub',
  'organisation_profile.updated_by_user_id': 'scrub',
```

- [ ] **Step 5: Typecheck**

```bash
pnpm --filter @wewin/db typecheck
```
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src
git commit -m "feat(db): organisation profile, bank accounts and their change history

bank_code is text with a shape CHECK rather than a pgEnum, on the rule auth.ts
states for itself: the choice is about whether the set can grow, and Thai banks
merge.

organisation_profile is one row and CHECK (id = 1) is what says so, rather than
the hope that no code path inserts a second.

All three user columns are 'scrub' in ERASURE_TREATMENTS, not 'delete': erasing
a member of staff must not erase the record that a bank account was changed."
```

---

## Task 5: Migration 0027 and its guards

**Files:**
- Create: `packages/db/drizzle/0027_organisation.sql`
- Create: `packages/db/tests/organisation.test.ts`

**Interfaces:**
- Consumes: Task 1's clean baseline, Task 4's schema.
- Produces: the three tables in Postgres, plus `bank_accounts_block_delete`, `bank_account_changes_append_only`, `organisation_profile_block_delete`.

- [ ] **Step 1: Write the guard tests first**

`packages/db/tests/organisation.test.ts`. `expectViolation` is defined per test file in this package — copy it, do not import it.

```ts
import { eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';

import { bankAccountChanges, bankAccounts, organisationProfile } from '../src/schema/index.js';
import { db, describeDb, PG, errorCode } from './support/db.js';

const expectViolation = async (
  operation: Promise<unknown>,
  code: (typeof PG)[keyof typeof PG],
): Promise<void> => {
  const caught = await operation.then(
    () => undefined,
    (error: unknown) => error,
  );

  expect(errorCode(caught), `expected SQLSTATE ${code}, got: ${String(caught)}`).toBe(code);
};

const tag = 'org';

describeDb('the organisation profile is one row, and Postgres is what says so', () => {
  it('refuses a second row', async () => {
    await expectViolation(
      db.insert(organisationProfile).values({
        id: 2,
        legalNameTh: 'บริษัท ทดสอบ จำกัด',
        addressTh: '1 ถนนทดสอบ',
        phone: '+6621234567',
      }),
      PG.checkViolation,
    );
  });

  it('refuses a tax id that is not thirteen digits', async () => {
    await expectViolation(
      db
        .update(organisationProfile)
        .set({ taxId: '123' })
        .where(eq(organisationProfile.id, 1)),
      PG.checkViolation,
    );
  });

  it('refuses a blank legal name, which would print an anonymous quotation', async () => {
    await expectViolation(
      db
        .update(organisationProfile)
        .set({ legalNameTh: '   ' })
        .where(eq(organisationProfile.id, 1)),
      PG.checkViolation,
    );
  });
});

describeDb('a bank account is retired, never deleted', () => {
  it('lets it be deactivated, and refuses to delete it', async () => {
    const [account] = await db
      .insert(bankAccounts)
      .values({
        bankCode: 'KBANK',
        accountNumber: `100${tag}0000001`.slice(0, 12),
        accountName: 'บริษัท ทดสอบ จำกัด',
      })
      .returning({ id: bankAccounts.id });

    // The permitted case actually succeeds — without this, a guard that refused
    // everything would pass the assertion below.
    await db.update(bankAccounts).set({ isActive: false }).where(eq(bankAccounts.id, account!.id));
    const [after] = await db
      .select({ isActive: bankAccounts.isActive })
      .from(bankAccounts)
      .where(eq(bankAccounts.id, account!.id));
    expect(after!.isActive).toBe(false);

    await expectViolation(
      db.delete(bankAccounts).where(eq(bankAccounts.id, account!.id)),
      PG.restrictViolation,
    );
  });

  it('refuses a bank code that is not a code and a number that is not digits', async () => {
    await expectViolation(
      db.insert(bankAccounts).values({
        bankCode: 'kbank',
        accountNumber: '1234567890',
        accountName: 'x',
      }),
      PG.checkViolation,
    );

    await expectViolation(
      db.insert(bankAccounts).values({
        bankCode: 'KBANK',
        accountNumber: '123-456-7890',
        accountName: 'x',
      }),
      PG.checkViolation,
    );
  });

  it('refuses a promptpay id that is neither ten nor thirteen digits', async () => {
    await expectViolation(
      db.insert(bankAccounts).values({
        bankCode: 'SCB',
        accountNumber: '2000000000',
        accountName: 'x',
        promptpayId: '08123456789',
      }),
      PG.checkViolation,
    );
  });
});

describeDb('the change history cannot be rewritten', () => {
  it('refuses UPDATE and DELETE on a history row', async () => {
    const [account] = await db
      .insert(bankAccounts)
      .values({ bankCode: 'BBL', accountNumber: '3000000000', accountName: 'x' })
      .returning({ id: bankAccounts.id });

    const [change] = await db
      .insert(bankAccountChanges)
      .values({ bankAccountId: account!.id, after: { accountName: 'x' } })
      .returning({ id: bankAccountChanges.id });

    await expectViolation(
      db
        .update(bankAccountChanges)
        .set({ after: { accountName: 'y' } })
        .where(eq(bankAccountChanges.id, change!.id)),
      PG.restrictViolation,
    );

    await expectViolation(
      db.delete(bankAccountChanges).where(eq(bankAccountChanges.id, change!.id)),
      PG.restrictViolation,
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @wewin/db exec vitest run tests/organisation.test.ts
```
Expected: FAIL — relation `bank_accounts` does not exist.

⚠️ If it reports **skipped** rather than failed, `DATABASE_URL` is unset. Run `pnpm db:up` from the repo root and copy `.env.example` to `.env` first. A skipped suite proves nothing.

- [ ] **Step 3: Write the migration**

`packages/db/drizzle/0027_organisation.sql`. Follow `0025_user_phones.sql`'s house style: a banner comment per section, `--> statement-breakpoint` after each statement.

```sql
-- ─────────────────────────────────────────────────────────────────────────────
-- ⭐ THE COMPANY, AND THE ACCOUNTS IT IS PAID INTO
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Until this migration there was nowhere to record which account a transfer went to, which
-- is why apps/web has no payment screen: a page that cannot say where to send money is not
-- a page. `payment_slips` recorded who paid and never who was paid.

CREATE TABLE "bank_accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "bank_code" text NOT NULL,
  "account_number" text NOT NULL,
  "account_name" text NOT NULL,
  "promptpay_id" text,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "updated_by_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "bank_accounts_number_key" UNIQUE("bank_code","account_number"),
  CONSTRAINT "bank_accounts_bank_code_shape" CHECK ("bank_code" ~ '^[A-Z]{3,8}$'),
  CONSTRAINT "bank_accounts_number_shape" CHECK ("account_number" ~ '^[0-9]{10,15}$'),
  CONSTRAINT "bank_accounts_name_says_something" CHECK (length(btrim("account_name")) > 0),
  CONSTRAINT "bank_accounts_promptpay_shape" CHECK ("promptpay_id" IS NULL OR "promptpay_id" ~ '^([0-9]{10}|[0-9]{13})$')
);
--> statement-breakpoint

ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_updated_by_user_id_users_id_fk"
  FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

CREATE INDEX "bank_accounts_active_idx" ON "bank_accounts" ("is_active","sort_order");
--> statement-breakpoint

-- An account is retired, not removed. `payment_slips.received_bank_account_id` points at it,
-- and a slip from last year has to keep saying where the money went.
CREATE FUNCTION bank_accounts_block_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'bank account % is referenced by payment records; deactivate it instead of deleting it', OLD.id
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER bank_accounts_block_delete
  BEFORE DELETE ON bank_accounts
  FOR EACH ROW EXECUTE FUNCTION bank_accounts_block_delete();
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ⭐ THE HISTORY, WHICH IS THE POINT
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Changing the receiving account number is the classic shape of this fraud: change it, wait
-- for one transfer, change it back. `updated_by_user_id` on the account answers "who last
-- touched this", which is precisely the question that attack is designed to survive.

CREATE TABLE "bank_account_changes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "bank_account_id" uuid NOT NULL,
  "changed_by_user_id" uuid,
  "changed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "before" jsonb,
  "after" jsonb NOT NULL
);
--> statement-breakpoint

ALTER TABLE "bank_account_changes" ADD CONSTRAINT "bank_account_changes_bank_account_id_bank_accounts_id_fk"
  FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "bank_account_changes" ADD CONSTRAINT "bank_account_changes_changed_by_user_id_users_id_fk"
  FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

CREATE INDEX "bank_account_changes_account_idx" ON "bank_account_changes" ("bank_account_id","changed_at");
--> statement-breakpoint

-- No UPDATE, no DELETE, ever — the same rule `admin_events` and `order_events` follow. A
-- record that can be edited is not a record; it is a table somebody will eventually tidy,
-- usually the person with the most reason to.
CREATE FUNCTION bank_account_changes_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'bank_account_changes is append-only; a change to a receiving account cannot be un-recorded'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER bank_account_changes_append_only
  BEFORE UPDATE OR DELETE ON bank_account_changes
  FOR EACH ROW EXECUTE FUNCTION bank_account_changes_append_only();
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ⭐ THE COMPANY, AS A DOCUMENT PRINTS IT
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Read at render time, never pinned into a document: `order.repository.ts` safeParses stored
-- documents against a z.literal schema version with no union reader, so adding seller fields
-- to the pinned shape would stop every already-issued quotation from printing. It is also
-- what a company that moves office wants — a price is an offer and is frozen, a letterhead
-- is not.

CREATE TABLE "organisation_profile" (
  "id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
  "legal_name_th" text NOT NULL,
  "legal_name_en" text,
  "address_th" text NOT NULL,
  "address_en" text,
  "tax_id" char(13),
  "phone" text NOT NULL,
  "email" text,
  "updated_by_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "organisation_profile_one_row" CHECK ("id" = 1),
  CONSTRAINT "organisation_profile_tax_id_shape" CHECK ("tax_id" IS NULL OR "tax_id" ~ '^[0-9]{13}$'),
  CONSTRAINT "organisation_profile_legal_name_says_something" CHECK (length(btrim("legal_name_th")) > 0),
  CONSTRAINT "organisation_profile_address_says_something" CHECK (length(btrim("address_th")) > 0)
);
--> statement-breakpoint

ALTER TABLE "organisation_profile" ADD CONSTRAINT "organisation_profile_updated_by_user_id_users_id_fk"
  FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

-- The row is the company. Deleting it would leave every document anonymous.
CREATE FUNCTION organisation_profile_block_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'organisation_profile holds the company identity every document prints; it cannot be deleted'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER organisation_profile_block_delete
  BEFORE DELETE ON organisation_profile
  FOR EACH ROW EXECUTE FUNCTION organisation_profile_block_delete();
--> statement-breakpoint

-- The one row, seeded from what apps/web/src/data/company.ts already hard-codes, so the
-- first render after this migration is not blank. Every value here is editable in the
-- dashboard; none of it is a decision this migration is making.
INSERT INTO "organisation_profile" ("id", "legal_name_th", "address_th", "phone")
VALUES (1, 'บริษัท วีวิน180 จำกัด', '291/4 หมู่ที่ 1 ต.บ้านกร่าง อ.เมืองพิษณุโลก จ.พิษณุโลก 65000', '+6655000000')
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint

ALTER TABLE "payment_slips" ADD COLUMN "received_bank_account_id" uuid;
--> statement-breakpoint

ALTER TABLE "payment_slips" ADD CONSTRAINT "payment_slips_received_bank_account_id_bank_accounts_id_fk"
  FOREIGN KEY ("received_bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE restrict ON UPDATE no action;
```

- [ ] **Step 4: Migrate and run the tests**

```bash
cd packages/db && pnpm db:migrate && cd ../..
pnpm --filter @wewin/db exec vitest run tests/organisation.test.ts
```
Expected: PASS, 7 tests.

- [ ] **Step 5: Run the erasure suite, which will now fail**

```bash
pnpm --filter @wewin/db exec vitest run tests/erasure.test.ts
```
Expected: FAIL — the FK-coverage gate finds three new `users` references. Task 6 fixes it.

- [ ] **Step 6: Mutate to prove the guards are load-bearing**

Against the live database, confirm each raises, then move on:

```bash
docker exec wewin-demo-postgres-1 psql -U wewin -d wewin -c "DELETE FROM organisation_profile WHERE id = 1;"
docker exec wewin-demo-postgres-1 psql -U wewin -d wewin -c "INSERT INTO organisation_profile (id, legal_name_th, address_th, phone) VALUES (2,'x','y','z');"
```
Expected: both refused — `restrict_violation` and `check_violation` respectively.

- [ ] **Step 7: Commit**

```bash
git add packages/db
git commit -m "feat(db): migration 0027 — organisation tables and their guards

Three triggers, each with a reason: bank_accounts refuses DELETE because
payment_slips points at it and a retired account must keep saying where money
went; bank_account_changes refuses UPDATE and DELETE because a history that can
be rewritten is not a history; organisation_profile refuses DELETE because
losing the row makes every document anonymous.

The profile row is seeded from what apps/web/src/data/company.ts already
hard-codes, so the first render after this migration is not blank."
```

---

## Task 6: Extend the erasure fixture so the new treatments are actually tested

`erasure.test.ts` counts rows belonging to the erasure subject. **A table the fixture never seeds counts 0 before and after**, so a `scrub` treatment added without extending the fixture buys a green test that checks nothing. The file records at lines 108-117 that this was proved by deleting a real statement and watching twenty tests stay green.

**Files:**
- Modify: `packages/db/tests/erasure.test.ts` (`createSubject`, ~lines 76-141)

**Interfaces:**
- Consumes: Task 4's `ERASURE_TREATMENTS` entries, Task 5's tables.
- Produces: an erasure suite that fails if the scrub is removed.

- [ ] **Step 1: Seed the three rows in `createSubject`**

Inside `createSubject`, after the existing inserts:

```ts
  /*
   * ⚠️ Seeded so the `scrub` coverage below tests something.
   *
   * The row-count loop counts rows *belonging to the subject*; a table the fixture never
   * writes to counts zero either way and passes without asserting anything. This file already
   * records that hazard at the top — these three exist so it does not apply to them.
   */
  const [account] = await db
    .insert(bankAccounts)
    .values({
      bankCode: 'KTB',
      accountNumber: `9${Date.now().toString().slice(-11)}`,
      accountName: 'erasure fixture',
      updatedByUserId: userId,
    })
    .returning({ id: bankAccounts.id });

  await db.insert(bankAccountChanges).values({
    bankAccountId: account!.id,
    changedByUserId: userId,
    after: { accountName: 'erasure fixture' },
  });

  await db
    .update(organisationProfile)
    .set({ updatedByUserId: userId })
    .where(eq(organisationProfile.id, 1));
```

⚠️ `Date.now()` is fine in a test fixture here — this package's suites are serialised (`maxWorkers: 1`) and the value only needs to be unique against the unique index.

- [ ] **Step 2: Run the erasure suite**

```bash
pnpm --filter @wewin/db exec vitest run tests/erasure.test.ts
```
Expected: PASS. The three columns are scrubbed to null and the rows survive.

- [ ] **Step 3: Mutate to prove the fixture made the test real**

Temporarily change `'bank_accounts.updated_by_user_id': 'scrub'` to `'keep'` in `ERASURE_TREATMENTS`.

```bash
pnpm --filter @wewin/db exec vitest run tests/erasure.test.ts
```
Expected: FAIL. Revert.

Then temporarily remove the `bankAccounts` insert from `createSubject` and re-run with the treatment back at `'scrub'`. Expected: **PASS** — which is the failure mode this task exists to close. Restore the insert.

- [ ] **Step 4: Commit**

```bash
git add packages/db/tests/erasure.test.ts
git commit -m "test(db): seed the new organisation rows in the erasure fixture

Without this the three scrub treatments are unverified: the coverage loop
counts rows belonging to the subject, and a table the fixture never writes to
counts zero before and after. Demonstrated both ways — removing the treatment
fails the suite, and removing the fixture row makes it pass again."
```

---

## Task 7: Permissions

**Files:**
- Modify: `apps/api/src/rbac/permissions.ts`
- Modify: `apps/dashboard/src/lib/auth/permissions.ts`
- Create: `apps/api/tests/rbac/permission-parity.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `'organisation.read'` and `'organisation.write'` as `PermissionCode`s.

- [ ] **Step 1: Write the parity test first**

`apps/dashboard/src/lib/auth/permissions.ts` is a hand-maintained copy of the API's list with nothing asserting parity. Adding a code on one side and forgetting the other produces a screen that exists and never appears in the menu, with no failure anywhere.

`apps/api/tests/rbac/permission-parity.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { PERMISSION_CODES } from '../../src/rbac/permissions';

/**
 * ⭐ The dashboard keeps its own copy of the permission list, and nothing checked it.
 *
 * `apps/dashboard/src/lib/auth/permissions.ts` exists because the dashboard decides which
 * menu entries to render before it has spoken to the API. Its header argues that every
 * direction of drift fails towards *less* menu, which is true and is also why the drift is
 * invisible: a screen that never appears looks like a screen nobody built.
 *
 * A source scan rather than an import, because the two packages do not depend on each other
 * and `boundaries` is what keeps it that way. This is the same shape `phone-authority.test.ts`
 * and `apps/web/tests/print.test.ts` use for a cross-package invariant a type cannot express.
 */
const here = dirname(fileURLToPath(import.meta.url));
const dashboardSource = readFileSync(
  join(here, '..', '..', '..', 'dashboard', 'src', 'lib', 'auth', 'permissions.ts'),
  'utf8',
);

const withoutComments = (text: string): string => text.replaceAll(/\/\*[\s\S]*?\*\//g, '');

describe('the dashboard copy of the permission list', () => {
  it('was found, and is not empty', () => {
    // The empty-scan failure this repo has met before: a scan over nothing passes.
    expect(dashboardSource.length).toBeGreaterThan(200);
  });

  it('names exactly the codes the API declares', () => {
    const quoted = [...withoutComments(dashboardSource).matchAll(/'([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)'/gu)];
    const inDashboard = [...new Set(quoted.map((match) => match[1] ?? ''))].sort();

    expect(inDashboard).toStrictEqual([...PERMISSION_CODES].sort());
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @wewin/api exec vitest run tests/rbac/permission-parity.test.ts
```
Expected: PASS at first — the two lists agree today. That is correct: the test is a regression guard, and Step 3 is what makes it earn its place.

- [ ] **Step 3: Add the API codes and watch parity break**

In `apps/api/src/rbac/permissions.ts`, add to the `PERMISSIONS` object. Descriptions must be ≥ 10 characters after trimming — `tests/rbac/permissions.test.ts` enforces it.

```ts
  'organisation.read': 'ดูข้อมูลบริษัทและบัญชีรับเงิน',
  'organisation.write': 'แก้ไขข้อมูลบริษัทและบัญชีรับเงิน',
```

⚠️ Declaration order here is user-visible: `users.service.ts` `listGroups()` returns `available: PERMISSION_CODES` in this order, and that is what the group-permission checkbox list renders. Put them where they read sensibly among the existing groups.

```bash
pnpm --filter @wewin/api exec vitest run tests/rbac/permission-parity.test.ts
```
Expected: **FAIL** — the dashboard list is missing two codes. This is the proof the test works.

- [ ] **Step 4: Add the dashboard codes**

In `apps/dashboard/src/lib/auth/permissions.ts`, add the same two codes in the same order.

```bash
pnpm --filter @wewin/api exec vitest run tests/rbac/permission-parity.test.ts
pnpm --filter @wewin/api exec vitest run tests/rbac/permissions.test.ts
```
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/rbac apps/api/tests/rbac apps/dashboard/src/lib/auth
git commit -m "feat(rbac): organisation.read and organisation.write, and a parity test

No migration: permission-sync.service.ts inserts PERMISSION_CODES on
onApplicationBootstrap with onConflictDoUpdate, so new codes reach Postgres on
the next boot.

The parity test is the part that was missing before. The dashboard keeps a hand
copy of this list and nothing checked it; every direction of drift fails towards
less menu, which is exactly why nobody notices. Demonstrated by adding the API
side first and watching it go red."
```

---

## Task 8: Contract types

**Files:**
- Create: `packages/contract/src/organisation.ts`
- Modify: `packages/contract/src/index.ts`
- Modify: `packages/contract/package.json` (exports)

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export const bankAccountCreateSchema: z.ZodType<{...}>;
  export const bankAccountPatchSchema: z.ZodType<{...}>;
  export const availabilitySchema: z.ZodType<{ isActive: boolean }>;
  export const organisationProfilePutSchema: z.ZodType<{...}>;
  export interface BankAccountWire { readonly id: string; readonly bankCode: string;
    readonly accountNumber: string; readonly accountName: string;
    readonly promptpayId: string | null; readonly sortOrder: number;
    readonly isActive: boolean; readonly updatedAt: string }
  export interface OrganisationProfileWire { readonly legalNameTh: string;
    readonly legalNameEn: string | null; readonly addressTh: string;
    readonly addressEn: string | null; readonly taxId: string | null;
    readonly phone: string; readonly email: string | null; readonly updatedAt: string }
  export interface BankAccountChangeWire { readonly id: string; readonly changedAt: string;
    readonly changedByUserId: string | null;
    readonly before: Readonly<Record<string, unknown>> | null;
    readonly after: Readonly<Record<string, unknown>> }
  export interface PaymentInstructionsWire {
    readonly grandTotalThbMinor: MoneyWire<'THB'>;
    readonly outstandingThbMinor: MoneyWire<'THB'>;
    readonly accounts: readonly BankAccountPublicWire[] }
  export interface BankAccountPublicWire { readonly id: string; readonly bankCode: string;
    readonly accountNumber: string; readonly accountName: string;
    readonly promptpayId: string | null }
  ```

- [ ] **Step 1: Write the contract module**

`packages/contract/src/organisation.ts`. Mirror the CHECK constraints from Task 4 exactly — a shape rule in two places must agree, and the migration is the authority.

```ts
import { z } from 'zod';

import type { MoneyWire } from './exact.js';

/**
 * ⚠️ Every shape rule here mirrors a CHECK in `0027_organisation.sql`.
 *
 * The database is the authority — a request that passes zod and fails the CHECK becomes a
 * 500 rather than a sentence, so these exist to turn a refusal into something readable and
 * not to be the rule. When they disagree, the migration is right.
 */
const bankCode = z.string().regex(/^[A-Z]{3,8}$/u, 'รหัสธนาคารเป็นตัวพิมพ์ใหญ่ 3–8 ตัว');
const accountNumber = z.string().regex(/^[0-9]{10,15}$/u, 'เลขบัญชีเป็นตัวเลข 10–15 หลัก');
const accountName = z.string().trim().min(1).max(200);
const promptpayId = z
  .string()
  .regex(/^([0-9]{10}|[0-9]{13})$/u, 'พร้อมเพย์เป็นเบอร์มือถือ 10 หลัก หรือเลขผู้เสียภาษี 13 หลัก');

export const bankAccountCreateSchema = z.strictObject({
  bankCode,
  accountNumber,
  accountName,
  promptpayId: promptpayId.nullable().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
});

export const bankAccountPatchSchema = z
  .strictObject({
    bankCode: bankCode.optional(),
    accountNumber: accountNumber.optional(),
    accountName: accountName.optional(),
    promptpayId: promptpayId.nullable().optional(),
    sortOrder: z.number().int().min(0).max(9999).optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, 'ไม่มีอะไรให้แก้ไข');

export const availabilitySchema = z.strictObject({ isActive: z.boolean() });

export const organisationProfilePutSchema = z.strictObject({
  legalNameTh: z.string().trim().min(1).max(300),
  legalNameEn: z.string().trim().min(1).max(300).nullable().optional(),
  addressTh: z.string().trim().min(1).max(1000),
  addressEn: z.string().trim().min(1).max(1000).nullable().optional(),
  taxId: z.string().regex(/^[0-9]{13}$/u, 'เลขผู้เสียภาษี 13 หลัก').nullable().optional(),
  phone: z.string().trim().min(1).max(60),
  email: z.string().email().max(320).nullable().optional(),
});

export type BankAccountCreateRequestWire = z.infer<typeof bankAccountCreateSchema>;
export type BankAccountPatchRequestWire = z.infer<typeof bankAccountPatchSchema>;
export type AvailabilityRequestWire = z.infer<typeof availabilitySchema>;
export type OrganisationProfilePutRequestWire = z.infer<typeof organisationProfilePutSchema>;

export interface BankAccountWire {
  readonly id: string;
  readonly bankCode: string;
  readonly accountNumber: string;
  readonly accountName: string;
  readonly promptpayId: string | null;
  readonly sortOrder: number;
  readonly isActive: boolean;
  readonly updatedAt: string;
}

export interface OrganisationProfileWire {
  readonly legalNameTh: string;
  readonly legalNameEn: string | null;
  readonly addressTh: string;
  readonly addressEn: string | null;
  readonly taxId: string | null;
  readonly phone: string;
  readonly email: string | null;
  readonly updatedAt: string;
}

export interface BankAccountChangeWire {
  readonly id: string;
  readonly changedAt: string;
  readonly changedByUserId: string | null;
  readonly before: Readonly<Record<string, unknown>> | null;
  readonly after: Readonly<Record<string, unknown>>;
}

/**
 * What a *customer* may see about an account. No `isActive`, no `sortOrder`, no `updatedAt`:
 * an inactive account is never returned at all, and the rest is internal ordering.
 */
export interface BankAccountPublicWire {
  readonly id: string;
  readonly bankCode: string;
  readonly accountNumber: string;
  readonly accountName: string;
  readonly promptpayId: string | null;
}

/**
 * ⚠️ Carries `promptpayId` and not a ready-made QR payload.
 *
 * The payload encodes the amount, and the page lets the customer transfer something other
 * than the outstanding figure — a partial payment, or a rounded one. A server-built payload
 * would freeze an amount the page then lets them change, so the page rebuilds it from
 * `@wewin/core/promptpay` whenever the amount field changes.
 */
export interface PaymentInstructionsWire {
  readonly grandTotalThbMinor: MoneyWire<'THB'>;
  readonly outstandingThbMinor: MoneyWire<'THB'>;
  readonly accounts: readonly BankAccountPublicWire[];
}
```

- [ ] **Step 2: Re-export and add the subpath**

In `packages/contract/src/index.ts`, add alongside the existing re-exports:

```ts
export * from './organisation.js';
```

In `packages/contract/package.json` `exports`, following the existing entries' shape:

```json
    "./organisation": "./dist/organisation.js"
```

- [ ] **Step 3: Build and typecheck**

```bash
pnpm --filter @wewin/contract build && pnpm --filter @wewin/contract typecheck
```
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add packages/contract
git commit -m "feat(contract): organisation request schemas and wire types

Every shape rule mirrors a CHECK in 0027, with the migration as the authority —
these turn a database refusal into a readable sentence rather than being the
rule themselves.

BankAccountPublicWire is deliberately narrower than BankAccountWire: a customer
sees the account, never its ordering or its active flag, because an inactive
account is never returned to them at all."
```

---

## Task 9: The organisation API module

**Files:**
- Create: `apps/api/src/organisation/{organisation.controller.ts,organisation.service.ts,organisation.repository.ts,organisation.module.ts,index.ts}`
- Create: `apps/api/tests/organisation/organisation.pg.test.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/tests/rbac/route-audit.test.ts`
- Modify: `apps/api/tests/admin/route-permissions.test.ts`

**Interfaces:**
- Consumes: Task 7's permission codes, Task 8's contract module, Task 4/5's tables.
- Produces: the six admin routes listed in the spec.

- [ ] **Step 1: Write the route-inventory entries first, and watch the audit fail**

In `apps/api/tests/rbac/route-audit.test.ts`, add these seven entries in `localeCompare` order on `` `${METHOD} ${path}` ``. Format is `'METHOD /path [kind]'`, six-space indent, trailing comma.

```
      'GET /admin/organisation [permissions]',
      'GET /admin/organisation/bank-accounts [permissions]',
      'GET /admin/organisation/bank-accounts/:id/changes [permissions]',
      'PATCH /admin/organisation/bank-accounts/:id [permissions]',
      'POST /admin/organisation/bank-accounts [permissions]',
      'PUT /admin/organisation [permissions]',
      'PUT /admin/organisation/bank-accounts/:id/availability [permissions]',
```

In `apps/api/tests/admin/route-permissions.test.ts`, add to `ADMIN_ROUTE_PERMISSIONS` (no ` [kind]` suffix in these keys):

```ts
  ['GET /admin/organisation', ['organisation.read']],
  ['PUT /admin/organisation', ['organisation.write']],
  ['GET /admin/organisation/bank-accounts', ['organisation.read']],
  ['POST /admin/organisation/bank-accounts', ['organisation.write']],
  ['PATCH /admin/organisation/bank-accounts/:id', ['organisation.write']],
  ['PUT /admin/organisation/bank-accounts/:id/availability', ['organisation.write']],
  ['GET /admin/organisation/bank-accounts/:id/changes', ['organisation.read']],
```

```bash
pnpm --filter @wewin/api exec vitest run tests/rbac/route-audit.test.ts tests/admin/route-permissions.test.ts
```
Expected: FAIL both — the routes do not exist yet.

- [ ] **Step 2: Write the repository**

`apps/api/src/organisation/organisation.repository.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq } from 'drizzle-orm';

import { bankAccountChanges, bankAccounts, organisationProfile } from '@wewin/db/schema';

import { DRIZZLE, type Database, type Transaction } from '../database/database.module';

@Injectable()
export class OrganisationRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.db.transaction(work);
  }

  profile(tx: Transaction | Database = this.db) {
    return tx.select().from(organisationProfile).where(eq(organisationProfile.id, 1)).limit(1);
  }

  /** Every account, newest ordering first. Admin only — the customer route filters. */
  allAccounts(tx: Transaction | Database = this.db) {
    return tx
      .select()
      .from(bankAccounts)
      .orderBy(asc(bankAccounts.sortOrder), asc(bankAccounts.createdAt));
  }

  activeAccounts(tx: Transaction | Database = this.db) {
    return tx
      .select()
      .from(bankAccounts)
      .where(eq(bankAccounts.isActive, true))
      .orderBy(asc(bankAccounts.sortOrder), asc(bankAccounts.createdAt));
  }

  account(id: string, tx: Transaction | Database = this.db) {
    return tx.select().from(bankAccounts).where(eq(bankAccounts.id, id)).limit(1);
  }

  changes(accountId: string, tx: Transaction | Database = this.db) {
    return tx
      .select()
      .from(bankAccountChanges)
      .where(eq(bankAccountChanges.bankAccountId, accountId))
      .orderBy(desc(bankAccountChanges.changedAt));
  }
}
```

⚠️ Confirm the real names of `DRIZZLE`, `Database` and `Transaction` in `apps/api/src/database/database.module.ts` before writing this — copy whatever `option-catalog.service.ts:46-52` imports.

- [ ] **Step 3: Write the service, with the history row on every write**

`apps/api/src/organisation/organisation.service.ts`. The essential rule: **a bank-account write and its history row are one transaction.** A change without a history row is the exact thing the history exists to prevent.

```ts
import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import { bankAccountChanges, bankAccounts, organisationProfile } from '@wewin/db/schema';
import type {
  BankAccountCreateRequestWire,
  BankAccountPatchRequestWire,
  OrganisationProfilePutRequestWire,
} from '@wewin/contract/organisation';

import { AppError } from '../common/errors/app-error';
import { message } from '../i18n';
import { OrganisationRepository } from './organisation.repository';

/** The fields the history records. Ordering and timestamps are not changes worth keeping. */
const RECORDED = ['bankCode', 'accountNumber', 'accountName', 'promptpayId', 'isActive'] as const;

const snapshot = (row: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(RECORDED.map((key) => [key, row[key] ?? null]));

@Injectable()
export class OrganisationService {
  constructor(private readonly repository: OrganisationRepository) {}

  async createAccount(actorUserId: string, input: BankAccountCreateRequestWire) {
    return this.repository.transaction(async (tx) => {
      const [created] = await tx
        .insert(bankAccounts)
        .values({ ...input, updatedByUserId: actorUserId })
        .returning();

      /*
       * ⚠️ Same transaction as the write, not a follow-up.
       *
       * A history row that can be skipped is a history somebody skips. The append-only
       * trigger stops it being edited afterwards; this is what stops it never existing.
       */
      await tx.insert(bankAccountChanges).values({
        bankAccountId: created!.id,
        changedByUserId: actorUserId,
        before: null,
        after: snapshot(created!),
      });

      return created!;
    });
  }

  async patchAccount(actorUserId: string, id: string, patch: BankAccountPatchRequestWire) {
    return this.repository.transaction(async (tx) => {
      const [before] = await this.repository.account(id, tx);
      if (before === undefined) throw AppError.notFound(message('error.organisation.account_missing'));

      const [after] = await tx
        .update(bankAccounts)
        .set({ ...patch, updatedByUserId: actorUserId, updatedAt: new Date() })
        .where(eq(bankAccounts.id, id))
        .returning();

      await tx.insert(bankAccountChanges).values({
        bankAccountId: id,
        changedByUserId: actorUserId,
        before: snapshot(before),
        after: snapshot(after!),
      });

      return after!;
    });
  }

  async setAvailability(actorUserId: string, id: string, isActive: boolean) {
    return this.patchAccount(actorUserId, id, { isActive } as BankAccountPatchRequestWire);
  }

  async putProfile(actorUserId: string, input: OrganisationProfilePutRequestWire) {
    const [updated] = await this.repository
      .transaction((tx) =>
        tx
          .update(organisationProfile)
          .set({ ...input, updatedByUserId: actorUserId, updatedAt: new Date() })
          .where(eq(organisationProfile.id, 1))
          .returning(),
      );

    return updated!;
  }
}
```

⚠️ `setAvailability` reuses `patchAccount` so a deactivation writes a history row like any other change. `bankAccountPatchSchema` does not accept `isActive` from a client — the cast is deliberate and internal, and the availability route is the only way to set it.

⚠️ `message('error.organisation.account_missing')` needs a matching key in `apps/api/src/i18n`. Add it there in the same commit; `NullaryMessageKey` will not compile otherwise.

- [ ] **Step 4: Write the controller**

`apps/api/src/organisation/organisation.controller.ts`. Copy the decorator stack from `apps/api/src/admin/option-catalog.controller.ts:1-116` exactly — including its local `contractVersion()` helper and the `ZodBodyPipe` usage.

First the encoder, `apps/api/src/organisation/encode.ts`. Never return a database row directly — `Date` objects would serialise inconsistently and a new column would leak to the client the day it is added.

```ts
import type {
  BankAccountChangeWire,
  BankAccountPublicWire,
  BankAccountWire,
  OrganisationProfileWire,
} from '@wewin/contract/organisation';

type AccountRow = {
  id: string;
  bankCode: string;
  accountNumber: string;
  accountName: string;
  promptpayId: string | null;
  sortOrder: number;
  isActive: boolean;
  updatedAt: Date;
};

export const encodeAccount = (row: AccountRow): BankAccountWire => ({
  id: row.id,
  bankCode: row.bankCode,
  accountNumber: row.accountNumber,
  accountName: row.accountName,
  promptpayId: row.promptpayId,
  sortOrder: row.sortOrder,
  isActive: row.isActive,
  updatedAt: row.updatedAt.toISOString(),
});

/** ⚠️ Narrower on purpose: a customer never sees ordering or the active flag. */
export const encodeAccountPublic = (row: AccountRow): BankAccountPublicWire => ({
  id: row.id,
  bankCode: row.bankCode,
  accountNumber: row.accountNumber,
  accountName: row.accountName,
  promptpayId: row.promptpayId,
});

export const encodeProfile = (row: {
  legalNameTh: string;
  legalNameEn: string | null;
  addressTh: string;
  addressEn: string | null;
  taxId: string | null;
  phone: string;
  email: string | null;
  updatedAt: Date;
}): OrganisationProfileWire => ({
  legalNameTh: row.legalNameTh,
  legalNameEn: row.legalNameEn,
  addressTh: row.addressTh,
  addressEn: row.addressEn,
  taxId: row.taxId,
  phone: row.phone,
  email: row.email,
  updatedAt: row.updatedAt.toISOString(),
});

export const encodeChange = (row: {
  id: string;
  changedAt: Date;
  changedByUserId: string | null;
  before: unknown;
  after: unknown;
}): BankAccountChangeWire => ({
  id: row.id,
  changedAt: row.changedAt.toISOString(),
  changedByUserId: row.changedByUserId,
  before: (row.before ?? null) as Readonly<Record<string, unknown>> | null,
  after: (row.after ?? {}) as Readonly<Record<string, unknown>>,
});
```

Then the controller:

```ts
@Controller('admin/organisation')
export class OrganisationController {
  constructor(
    private readonly organisation: OrganisationService,
    private readonly repository: OrganisationRepository,
  ) {}

  @Get()
  @contractVersion()
  @RequirePermissions('organisation.read')
  async profile(): Promise<OrganisationProfileWire> {
    const [row] = await this.repository.profile();
    if (row === undefined) throw AppError.notFound(message('error.organisation.profile_missing'));
    return encodeProfile(row);
  }

  @Put()
  @contractVersion()
  @RequirePermissions('organisation.write')
  async putProfile(
    @CurrentScope() scope: Scope,
    @Body(new ZodBodyPipe(organisationProfilePutSchema)) body: OrganisationProfilePutRequestWire,
  ): Promise<OrganisationProfileWire> {
    return encodeProfile(await this.organisation.putProfile(requireActor(scope), body));
  }

  @Get('bank-accounts')
  @contractVersion()
  @RequirePermissions('organisation.read')
  async accounts(): Promise<{ readonly accounts: readonly BankAccountWire[] }> {
    const rows = await this.repository.allAccounts();
    return { accounts: rows.map(encodeAccount) };
  }

  @Post('bank-accounts')
  @HttpCode(201)
  @contractVersion()
  @RequirePermissions('organisation.write')
  async createAccount(
    @CurrentScope() scope: Scope,
    @Body(new ZodBodyPipe(bankAccountCreateSchema)) body: BankAccountCreateRequestWire,
  ): Promise<BankAccountWire> {
    return encodeAccount(await this.organisation.createAccount(requireActor(scope), body));
  }

  @Patch('bank-accounts/:id')
  @contractVersion()
  @RequirePermissions('organisation.write')
  async patchAccount(
    @CurrentScope() scope: Scope,
    @Param('id') id: string,
    @Body(new ZodBodyPipe(bankAccountPatchSchema)) body: BankAccountPatchRequestWire,
  ): Promise<BankAccountWire> {
    return encodeAccount(await this.organisation.patchAccount(requireActor(scope), id, body));
  }

  @Put('bank-accounts/:id/availability')
  @contractVersion()
  @RequirePermissions('organisation.write')
  async setAvailability(
    @CurrentScope() scope: Scope,
    @Param('id') id: string,
    @Body(new ZodBodyPipe(availabilitySchema)) body: AvailabilityRequestWire,
  ): Promise<BankAccountWire> {
    return encodeAccount(
      await this.organisation.setAvailability(requireActor(scope), id, body.isActive),
    );
  }

  @Get('bank-accounts/:id/changes')
  @contractVersion()
  @RequirePermissions('organisation.read')
  async changes(
    @Param('id') id: string,
  ): Promise<{ readonly changes: readonly BankAccountChangeWire[] }> {
    const rows = await this.repository.changes(id);
    return { changes: rows.map(encodeChange) };
  }
}
```

⚠️ `requireActor(scope)` is the existing helper that turns a `Scope` into a staff user id and refuses a scope that has none — `slips.service.ts:238` calls it. Import it from wherever that file imports it; do not write a second one.

- [ ] **Step 5: Wire the module and mount it**

`organisation.module.ts` follows `apps/api/src/admin/admin.module.ts:1-27`: `controllers`, `providers`, no `forRoot` unless it needs configuration (it does not). `index.ts` exports the module only.

Add `OrganisationModule` to the `imports` array inside `AppModule.forRoot` in `apps/api/src/app.module.ts`.

```bash
pnpm --filter @wewin/api exec vitest run tests/rbac/controller-reachability.test.ts
```
Expected: PASS. If it fails, the module is not mounted.

- [ ] **Step 6: Run the two inventory tests**

```bash
pnpm --filter @wewin/api exec vitest run tests/rbac/route-audit.test.ts tests/admin/route-permissions.test.ts
```
Expected: both PASS now.

- [ ] **Step 7: Write the behaviour test**

`apps/api/tests/organisation/organisation.pg.test.ts` — at minimum: a create writes exactly one history row; a patch writes a history row carrying both `before` and `after`; a deactivation writes one too; `GET bank-accounts` returns inactive accounts and the customer route does not; a caller without `organisation.write` gets 403.

- [ ] **Step 8: Gate and commit**

```bash
pnpm typecheck && pnpm lint && pnpm boundaries && pnpm test
```

```bash
git add apps/api packages/contract
git commit -m "feat(api): organisation module — profile and bank accounts

Every bank-account write and its history row are one transaction. The
append-only trigger stops a history row being edited; this is what stops it
never being written. Deactivation goes through the same patch path for the same
reason, so a retirement is recorded like any other change."
```

---

## Task 10: `GET orders/:orderId/payment-instructions`

The customer cannot currently find out how much they owe. `outstandingThbMinor` exists only on the staff slip-review wire behind `payments.read`; `GET /orders/:id` returns `grandTotalThbMinor` and nothing about what has been received; and `order_instalments` means a client that subtracts for itself is wrong as soon as there is more than one instalment.

**Files:**
- Modify: `apps/api/src/orders/orders.controller.ts`
- Modify: `apps/api/src/orders/orders.service.ts`
- Modify: `apps/api/tests/rbac/route-audit.test.ts` (one entry)
- Create/modify: `apps/api/tests/orders/payment-instructions.pg.test.ts`

**Interfaces:**
- Consumes: Task 8's `PaymentInstructionsWire`, Task 9's repository.
- Produces: `GET /orders/:orderId/payment-instructions` → `PaymentInstructionsWire`, `[principal]`.

- [ ] **Step 1: Add the inventory entry and watch it fail**

```
      'GET /orders/:orderId/payment-instructions [principal]',
```

placed in `localeCompare` order — it sorts after `'GET /orders/:orderId/events [principal]'` and before `'GET /orders/:orderId/payment-slips [principal]'`.

```bash
pnpm --filter @wewin/api exec vitest run tests/rbac/route-audit.test.ts
```
Expected: FAIL.

- [ ] **Step 2: Add the handler**

In `apps/api/src/orders/orders.controller.ts`, beside the existing `@Get(':orderId/document')`:

```ts
  /**
   * How much is owed, and where to send it.
   *
   * ⚠️ Ownership-scoped rather than a public account list, for two reasons. There is no
   * reason to publish the company's account numbers to callers with no order — and P2 makes
   * the accounts vary by destination country, which this shape absorbs without changing the
   * endpoint.
   */
  @Get(':orderId/payment-instructions')
  @contractVersion()
  @RequirePrincipal()
  async paymentInstructions(
    @CurrentScope() scope: Scope,
    @Param('orderId') orderId: string,
  ): Promise<PaymentInstructionsWire> {
    return this.orders.paymentInstructions(scope, orderId);
  }
```

- [ ] **Step 3: Implement `paymentInstructions` in the service**

It must: resolve the order through the same ownership filter every other order route uses (a missing order and someone else's order both answer 404); read the outstanding figure from the same source the staff slip-review wire uses, not by subtracting in TypeScript; and return only `is_active = true` accounts, ordered by `sort_order`.

- [ ] **Step 4: Run the tests**

```bash
pnpm --filter @wewin/api exec vitest run tests/rbac/route-audit.test.ts tests/orders
```
Expected: PASS.

- [ ] **Step 5: Prove the ownership boundary**

The behaviour test must include: a signed-in customer reading **another** customer's order id receives **404**, not 403 — the anti-oracle rule this codebase follows everywhere else.

- [ ] **Step 6: Commit**

```bash
git add apps/api
git commit -m "feat(api): GET orders/:orderId/payment-instructions

The customer had no way to learn what they owe: outstandingThbMinor lived only
on the staff slip-review wire behind payments.read, and GET /orders/:id returns
the grand total and nothing about receipts. Subtracting client-side is wrong the
moment there is more than one instalment.

Scoped to an order rather than a public account list — and that shape is what
lets P2 vary accounts by destination country without a new endpoint."
```

---

## Task 11: The dashboard `/organisation` screen

**Files:**
- Create: `apps/dashboard/src/app/(app)/organisation/page.tsx`
- Create: `apps/dashboard/src/components/organisation/{organisation-screen.tsx,organisation-api.ts,bank-account-dialog.tsx}`
- Modify: `apps/dashboard/src/lib/nav/navigation.ts`

**Interfaces:**
- Consumes: Task 9's routes, Task 8's wire types.
- Produces: a screen; nothing downstream depends on it.

- [ ] **Step 1: Copy the page shell**

`page.tsx` follows `apps/dashboard/src/app/(app)/option-groups/page.tsx:1-24` exactly — a server component that renders the client screen inside the app layout.

- [ ] **Step 2: Write the api module**

`organisation-api.ts` follows `apps/dashboard/src/components/option-groups/option-group-api.ts:1-101`: `apiJson` for reads, `apiFetch` + `apiErrorFromResponse` for writes, and **decode, never cast** — hand-written decoders, as `catalog-api.ts:143-246` does.

- [ ] **Step 3: Write the screen and the dialog**

Two sections: the company profile (a form) and the bank accounts (a list with add/edit/deactivate and a history view). Forms use `useState` per field plus `busy` and `problem` — there is no react-hook-form in this app. Field primitives come from `apps/dashboard/src/components/products/form-field.tsx`.

The account list shows `is_active = false` rows greyed rather than hidden, so an administrator can see what was retired and reactivate it.

- [ ] **Step 4: Add the nav entry**

In `apps/dashboard/src/lib/nav/navigation.ts`, add to the `'ระบบ'` section beside users and account:

```ts
      { href: '/organisation', label: 'ข้อมูลบริษัท', icon: Building2, requires: ['organisation.read'] },
```

- [ ] **Step 5: Verify in the browser**

Start both dev servers, sign in as a user holding `organisation.write`, add an account, edit it, deactivate it, and open its history. Confirm three history rows exist by reading `bank_account_changes` from psql.

- [ ] **Step 6: Gate and commit**

---

## Task 11b: Print the company on the quotation

The spec's claim that `organisation_profile` "fills a hole in the document" needs a task, or it is only configuration. `/[locale]/orders` is not in `showsFooter`'s set, so **the quotation a customer prints today carries no company name, address or tax id at all** — it says what is being sold and for how much, and never who is offering it.

**Files:**
- Modify: `apps/api/src/orders/orders.controller.ts` (the existing `GET :orderId/document`)
- Modify: `apps/api/src/orders/encode.ts`
- Modify: `packages/contract/src/order.ts` (response type only — **not** the pinned document schema)
- Modify: `apps/web/src/components/quotation/QuotationIsland.tsx`
- Modify: `apps/dashboard/src/components/quotes/quotation-sheet.tsx`

**Interfaces:**
- Consumes: Task 9's repository, Task 8's `OrganisationProfileWire`.
- Produces: `GET /orders/:orderId/document` gains a sibling `seller` field.

- [ ] **Step 1: Write the failing test**

```ts
it('carries the seller alongside the pinned document, and not inside it', async () => {
  const body = await getDocument(orderId);

  expect(body.seller.legalNameTh).toBe('บริษัท วีวิน180 จำกัด');
  // ⚠️ The pinned half must be untouched. Adding a field inside `document` would change
  // documentSchemaVersion, and order.repository.ts safeParses stored documents against a
  // z.literal on the way out — every already-issued quotation would stop printing.
  expect(body.document).not.toHaveProperty('seller');
  expect(body.document.documentSchemaVersion).toBe(2);
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @wewin/api exec vitest run tests/orders
```
Expected: FAIL — `body.seller` is undefined.

- [ ] **Step 3: Add `seller` beside `document`, never inside it**

The response becomes `{ document: OrderDocumentWire, seller: OrganisationProfileWire }`. `document` is the frozen half and its shape does not move; `seller` is read live on every request.

```ts
/**
 * ⚠️ Beside the document, not inside it.
 *
 * A price is an offer and is frozen. A letterhead is not: a company that changes address
 * wants last year's quotation reprinted at the new one. And the mechanical reason is
 * sharper — `order.repository.ts` safeParses every stored document against
 * `z.literal(ORDER_DOCUMENT_SCHEMA_VERSION)` with no union reader, so putting the seller
 * inside would stop all 16 already-issued quotations from printing the moment the version
 * moved.
 */
```

- [ ] **Step 4: Render it on both sheets**

On the customer's quotation (`QuotationIsland`), a seller block above the line table: legal name, address, tax id, phone. On the dashboard sheet, replace the hard-coded wordmark at `quotation-sheet.tsx:209` with the fetched profile.

⚠️ The seller block must survive the print rule. It sits inside `<article>`, so `[data-chrome]` does not touch it — verify by printing, not by reading.

- [ ] **Step 5: Verify by printing**

Regenerate the PDF for WW-1014 and confirm the seller block is present and legible. Use the print-media check from phase 16: disable the HTTP cache, `emulateMedia({ media: null })`, then `page.pdf()`.

- [ ] **Step 6: Gate and commit**

```bash
git add apps/api apps/web apps/dashboard packages/contract
git commit -m "feat: print the company on the quotation

/[locale]/orders is not in showsFooter's set, so the quotation a customer
printed carried no company name, address or tax id — a document that says what
is being sold and for how much, and never who is offering it.

The seller sits beside the pinned document rather than inside it. A price is an
offer and is frozen; a letterhead is not. The mechanical reason is sharper: the
repository safeParses stored documents against a z.literal schema version with
no union reader, so moving the version would stop every already-issued
quotation from printing."
```

---

## Task 12: The ~28 i18n keys, in all eight languages

**Files:**
- Modify: `apps/web/src/i18n/keys.ts`
- Modify: all eight of `apps/web/src/i18n/catalogues/*.ts`
- Modify: `apps/web/src/i18n/catalogue.test.ts` (`SAMPLE_PARAMS`)

**Interfaces:**
- Consumes: nothing.
- Produces: the keys Task 13 renders.

⚠️ This is the one task in the plan that is genuinely new prose rather than mechanical work: six languages × ~28 strings.

- [ ] **Step 1: Declare the keys**

In `keys.ts`, add a section following the existing banner style:

```ts
  /* ---- Paying, and attaching a slip ---------------------------------- */
  'payment.meta.title': Plain;
  'payment.heading': Plain;
  'payment.loading': Plain;
  'payment.outstanding': Plain;
  'payment.outstandingAmount': { owedMinor: bigint };
  'payment.settled': Plain;
  'payment.account.legend': Plain;
  'payment.account.copy': { accountDigits: string };
  'payment.account.copied': Plain;
  'payment.account.qrAlt': Plain;
  'payment.account.qrHint': Plain;
  'payment.form.legend': Plain;
  'payment.form.image': Plain;
  'payment.form.imageHint': Plain;
  'payment.form.amount': Plain;
  'payment.form.transferredAt': Plain;
  'payment.form.reference': Plain;
  'payment.form.submit': Plain;
  'payment.phase.uploading': Plain;
  'payment.phase.creating': Plain;
  'payment.done': Plain;
  'payment.history.heading': Plain;
  'payment.history.empty': Plain;
  'payment.history.submitted': { slipMinor: bigint; sentAt: Date };
  'payment.history.accepted': { slipMinor: bigint; sentAt: Date };
  'payment.history.rejected': { slipMinor: bigint; reason: string };
  'payment.problem.noImage': Plain;
  'payment.problem.imageTooBig': { limitMib: number };
  'payment.problem.badAmount': Plain;
  'payment.problem.badTime': Plain;
  'payment.problem.signInAgain': Plain;
  'payment.problem.unreachable': Plain;
```

⚠️ Param names are new on purpose. `SAMPLE_PARAMS` already binds `count`, `total`, `name`, `title`, `size`, `index`, `at` (a `Date`), `unit` and `minor` (a `bigint`) with fixed types — reusing one with a different type poisons the existing key that uses it.

- [ ] **Step 2: Add the sample params**

In `catalogue.test.ts` `SAMPLE_PARAMS`:

```ts
  owedMinor: 2_824_800n,
  slipMinor: 1_412_400n,
  sentAt: new Date('2026-03-14T04:00:00Z'),
  accountDigits: '1234567890',
  reason: 'ยอดเงินไม่ตรงกับที่แจ้ง',
  limitMib: 8,
```

- [ ] **Step 3: Run to verify it fails**

```bash
pnpm --filter @wewin/web exec vitest run src/i18n/catalogue.test.ts
```
Expected: a compile error — `th.ts` is missing every new key, because Thai is typed `UiCatalogue`.

- [ ] **Step 4: Write Thai, then English**

Thai is the source and the fallback; English is asserted complete. Both are given here in full because both are enforced — Thai by the compiler, English by `catalogue.test.ts:299`.

`apps/web/src/i18n/catalogues/th.ts`:

```ts
  /* ---- Paying, and attaching a slip ---------------------------------- */
  'payment.meta.title': 'แจ้งชำระเงิน',
  'payment.heading': 'แจ้งชำระเงิน',
  'payment.loading': 'กำลังเปิดข้อมูลการชำระเงิน…',
  'payment.outstanding': 'ยอดคงค้าง',
  'payment.outstandingAmount': (p, f) => `฿${f.plain(p.owedMinor / 100n)}.${String(p.owedMinor % 100n).padStart(2, '0')}`,
  'payment.settled': 'ออเดอร์นี้ชำระครบแล้ว',
  'payment.account.legend': 'โอนเข้าบัญชีใดบัญชีหนึ่ง',
  'payment.account.copy': (p) => `คัดลอกเลขบัญชี ${p.accountDigits}`,
  'payment.account.copied': 'คัดลอกเลขบัญชีแล้ว',
  'payment.account.qrAlt': 'คิวอาร์โค้ดพร้อมเพย์สำหรับยอดที่กรอกไว้',
  'payment.account.qrHint': 'สแกนด้วยแอปธนาคาร — จำนวนเงินจะถูกกรอกให้อัตโนมัติ',
  'payment.form.legend': 'แนบสลิป',
  'payment.form.image': 'รูปสลิป',
  'payment.form.imageHint': 'ถ่ายจากแอปธนาคารได้เลย ไฟล์ไม่เกิน 8 MB',
  'payment.form.amount': 'จำนวนเงินที่โอน',
  'payment.form.transferredAt': 'วันและเวลาที่โอน',
  'payment.form.reference': 'เลขอ้างอิง (ถ้ามี)',
  'payment.form.submit': 'ส่งสลิป',
  'payment.phase.uploading': 'กำลังอัปโหลดรูป…',
  'payment.phase.creating': 'กำลังบันทึกสลิป…',
  'payment.done': 'ได้รับสลิปแล้ว ทีมงานจะตรวจสอบและแจ้งกลับ',
  'payment.history.heading': 'สลิปที่ส่งไปแล้ว',
  'payment.history.empty': 'ยังไม่ได้ส่งสลิป',
  'payment.history.submitted': (p, f) =>
    `฿${f.plain(p.slipMinor / 100n)} · ส่งเมื่อ ${f.date(p.sentAt)} · รอตรวจสอบ`,
  'payment.history.accepted': (p, f) =>
    `฿${f.plain(p.slipMinor / 100n)} · ส่งเมื่อ ${f.date(p.sentAt)} · รับแล้ว`,
  'payment.history.rejected': (p, f) => `฿${f.plain(p.slipMinor / 100n)} · ไม่ผ่าน — ${p.reason}`,
  'payment.problem.noImage': 'กรุณาแนบรูปสลิป',
  'payment.problem.imageTooBig': (p, f) => `รูปใหญ่เกินไป — ไม่เกิน ${f.plain(p.limitMib)} MB`,
  'payment.problem.badAmount': 'กรอกจำนวนเงินเป็นตัวเลข ทศนิยมไม่เกินสองตำแหน่ง',
  'payment.problem.badTime': 'กรุณาเลือกวันและเวลาที่โอน',
  'payment.problem.signInAgain': 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง ข้อมูลที่กรอกไว้ยังอยู่',
  'payment.problem.unreachable': 'เชื่อมต่อไม่ได้ กรุณาลองใหม่',
```

`apps/web/src/i18n/catalogues/en.ts`:

```ts
  /* ---- Paying, and attaching a slip ---------------------------------- */
  'payment.meta.title': 'Notify us of a payment',
  'payment.heading': 'Notify us of a payment',
  'payment.loading': 'Opening your payment details…',
  'payment.outstanding': 'Still owing',
  'payment.outstandingAmount': (p, f) => `฿${f.plain(p.owedMinor / 100n)}.${String(p.owedMinor % 100n).padStart(2, '0')}`,
  'payment.settled': 'This order is paid in full',
  'payment.account.legend': 'Transfer to any one of these accounts',
  'payment.account.copy': (p) => `Copy account number ${p.accountDigits}`,
  'payment.account.copied': 'Account number copied',
  'payment.account.qrAlt': 'PromptPay QR code for the amount entered',
  'payment.account.qrHint': 'Scan with your banking app — the amount is filled in for you',
  'payment.form.legend': 'Attach the slip',
  'payment.form.image': 'Photo of the slip',
  'payment.form.imageHint': 'A screenshot from your banking app is fine. Up to 8 MB.',
  'payment.form.amount': 'Amount transferred',
  'payment.form.transferredAt': 'Date and time of the transfer',
  'payment.form.reference': 'Reference number (optional)',
  'payment.form.submit': 'Send the slip',
  'payment.phase.uploading': 'Uploading the photo…',
  'payment.phase.creating': 'Saving the slip…',
  'payment.done': 'We have your slip. Our team will check it and get back to you.',
  'payment.history.heading': 'Slips you have sent',
  'payment.history.empty': 'No slips sent yet',
  'payment.history.submitted': (p, f) =>
    `฿${f.plain(p.slipMinor / 100n)} · sent ${f.date(p.sentAt)} · being checked`,
  'payment.history.accepted': (p, f) =>
    `฿${f.plain(p.slipMinor / 100n)} · sent ${f.date(p.sentAt)} · accepted`,
  'payment.history.rejected': (p, f) => `฿${f.plain(p.slipMinor / 100n)} · not accepted — ${p.reason}`,
  'payment.problem.noImage': 'Please attach a photo of the slip.',
  'payment.problem.imageTooBig': (p, f) => `That photo is too large — up to ${f.plain(p.limitMib)} MB.`,
  'payment.problem.badAmount': 'Enter the amount as a number with at most two decimal places.',
  'payment.problem.badTime': 'Please give the date and time of the transfer.',
  'payment.problem.signInAgain': 'Your session expired. Please sign in again — what you typed is still here.',
  'payment.problem.unreachable': 'Cannot connect. Please try again.',
```

⚠️ The amount entries split baht and satang inline rather than calling `f.baht()`, which renders whole baht and would drop the satang — the exact failure this page exists to avoid. `f.plain` is used for the baht part so the Burmese page still gets Burmese digits, and the satang pad is two ASCII digits in every locale because it is a fractional part, not a counted quantity.

- [ ] **Step 5: Write the other six, following each catalogue's own header**

⚠️ The conventions differ per language and each file states its own:

- **de** — plural agreement; the local `count()` helper exists at `de.ts:32`. Amounts follow `um`.
- **hi** — three plural patterns; the local `count()` at `hi.ts:27` takes both forms rather than deriving one.
- **zh** — **no `count()` helper, and its header forbids adding one.** Measure words instead: 笔 for a transfer, 张 for a slip image.
- **vi** — **no `count()` helper.** Classifiers, not plurals.
- **my** — **no `count()` helper.** Verb-final: `X ကို Y လုပ်ရန်`. Text must be Unicode, never Zawgyi.
- **la** — closest to Thai; the risk is the false friend, not the word order.

Every number goes through `f`. `f.baht()` renders whole baht — for an exact transfer amount use the value the page formats with `satangField`, passed in as a param the entry renders, never `f.baht`.

- [ ] **Step 6: Run to verify all eight are complete**

```bash
pnpm --filter @wewin/web exec vitest run src/i18n/
```
Expected: PASS, all eight catalogues at 100%.

- [ ] **Step 7: Commit**

---

## Task 13: The customer payment page

**Files:**
- Create: `apps/web/src/app/[locale]/payment/page.tsx`
- Create: `apps/web/src/components/payment/{PaymentIsland.tsx,SlipForm.tsx,AccountPicker.tsx}`
- Create: `apps/web/src/lib/payment/api.ts`
- Create: `apps/web/tests/payment.test.ts`

**Interfaces:**
- Consumes: Task 3's `promptPayPayload`, Task 2's `readSatang`/`satangField`, Task 10's route, Task 12's keys.
- Produces: nothing downstream.

- [ ] **Step 1: Write the failing error-path tests**

`apps/web/tests/payment.test.ts`. These are the five traps the spec names; each is invisible on a happy path.

```ts
import { describe, expect, it } from 'vitest';

import { MAX_SLIP_BYTES, describeUploadProblem, toInstant } from '../src/lib/payment/api';

describe('an oversize image is refused before it is sent', () => {
  it('names the size, and does not claim the server is unreachable', () => {
    /*
     * ⚠️ readBoundedBody calls request.destroy() *while* rejecting, so an over-limit upload
     * surfaces in the browser as a thrown fetch and lands in the catch — which is the
     * 'unreachable' branch. Without a client-side check the customer is told the server is
     * down about a photo that was merely too big.
     */
    expect(describeUploadProblem(MAX_SLIP_BYTES + 1)).toBe('too-big');
    expect(describeUploadProblem(MAX_SLIP_BYTES)).toBeNull();
  });
});

describe('a datetime-local value becomes something the API accepts', () => {
  it('adds an offset, because zod refuses a bare local time', () => {
    // Verified against the installed zod: '+07:00' ok, 'Z' ok, no designator refused.
    expect(toInstant('2026-08-09T14:30')).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([+-]\d{2}:\d{2}|Z)$/u);
  });

  it('refuses an empty or unparseable value rather than sending it', () => {
    expect(toInstant('')).toBeNull();
    expect(toInstant('not a time')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @wewin/web exec vitest run tests/payment.test.ts
```
Expected: FAIL — cannot resolve `../src/lib/payment/api`.

- [ ] **Step 3: Write `lib/payment/api.ts`**

Mirrors `apps/web/src/lib/auth/account.ts:36-110`: an `isRecord` guard, a result union, and a `post` helper with `credentials: 'include'` and `cache: 'no-store'`.

```ts
/** Mirrored from PAYMENT_SLIP_MAX_BYTES in apps/api/src/payments/slips/slip-storage.config.ts. */
export const MAX_SLIP_BYTES = 8 * 1024 * 1024;

export function describeUploadProblem(byteSize: number): 'too-big' | null {
  return byteSize > MAX_SLIP_BYTES ? 'too-big' : null;
}

/**
 * `<input type="datetime-local">` yields `2026-08-09T14:30` with no timezone designator, and
 * `createSlipRequestSchema.transferredAt` refuses that. The browser's own offset is the
 * right one: the customer is reading a time off their banking app, on this device.
 */
export function toInstant(local: string): string | null {
  if (local.trim() === '') return null;
  const parsed = new Date(local);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}
```

Then `fetchPaymentInstructions`, `fetchSlips`, `uploadSlipImage(file, accessToken)` and `createSlip(...)`.

⚠️ `uploadSlipImage` sends **the `File` as the body**, not `FormData` — `apps/dashboard/src/components/media/media-api.ts:118-141` explains why: the endpoint reads the request stream directly and a multipart envelope is refused as the wrong content type.

- [ ] **Step 4: Run to verify it passes**

```bash
pnpm --filter @wewin/web exec vitest run tests/payment.test.ts
```
Expected: PASS, 4 tests.

- [ ] **Step 5: Write the page**

`page.tsx` copies `apps/web/src/app/[locale]/orders/page.tsx:1-64` — `generateStaticParams` over the eight locales, and `robots: { index: false, follow: false }`.

⚠️ `AccountGate`'s signed-out branch opens at `<h2>`. Put the `<h1>` inside the signed-in branch, as `AccountScreen.tsx:32` does, or the page has no `<h1>` when signed out.

`PaymentIsland` holds a discriminated `Phase` union following `ChangePassword.tsx:42-46`:

```ts
type Phase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'uploading' }
  | { readonly kind: 'creating' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'done' };
```

⚠️ The `uploading` phase must render the API's own sentence on failure, not only `creating` — the body is buffered before the status checks run, so `POST …/image` itself returns 409 `order_not_accepting_slips` or `too_many_slips`.

⚠️ Disable the submit button on the first click and **never auto-retry the create call**. Nothing consumes an upload handle and `storage_key` has no uniqueness, so a retry produces a second slip for one transfer.

⚠️ Upload the image only after the form is complete. `UPLOAD_HANDLE_TTL_SECONDS` is 15 minutes.

- [ ] **Step 6: `AccountPicker` and the QR**

Reuse `apps/web/src/components/configurator/QrCode.tsx` — it lazy-loads `qrcode-generator`, which is already a dependency. Build the payload with `promptPayPayload(promptPayTarget(account.promptpayId), amountMinor)` and rebuild it whenever the amount field changes.

Show no QR when `promptPayTarget` returns `null`; a bad stored id must show the account without a QR, not take the page down.

- [ ] **Step 7: Token check**

```bash
pnpm --filter @wewin/web build
```
Expected: `check-tokens` passes. Any class outside the project's token set produces no CSS and fails here.

- [ ] **Step 8: Gate and commit**

---

## Task 14: The incidental fixes

**Files:**
- Modify: `packages/core/src/quotation.ts:107`
- Modify: `apps/web/src/components/shell/LanguagePicker.tsx:82,104` and its header
- Modify: `apps/web/src/components/shell/AppFooter.tsx:67`
- Modify: `apps/api/src/payments/slips/slips.module.ts`
- Create: a test pinning renderable locales

- [ ] **Step 1: Write the failing locale test**

The renderable set at `quotation.ts:107` is `['th','en','zh','ja','de','hi','my','vi']` — it contains `ja`, which is not a storefront locale, and omits `la`, which is. A Lao-pinned document renders degraded **today**.

```ts
it('can render every locale the storefront offers', () => {
  // A pinned document in a locale missing from this list renders `localeDegraded` — the
  // customer gets Thai. That is a silent failure with no symptom on any other page.
  for (const locale of LOCALES) {
    expect(RENDERABLE_LOCALES, `${locale} is offered but not renderable`).toContain(locale);
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Expected: FAIL — `la is offered but not renderable`.

- [ ] **Step 3: Fix the list**

Replace the hand-written array with one derived from the same source the storefront uses, so the two cannot drift again. If `packages/core` cannot import `@wewin/i18n`, keep the literal and add the test above in the package that can see both.

- [ ] **Step 4: Fix the three stale comments**

`LanguagePicker.tsx` — remove `lang={SOURCE_LOCALE}` from the two `locale.partial` spans (it is translated in all eight now), and rewrite the header, which still says "Six of the eight catalogues are empty".

`AppFooter.tsx:67` — the docstring claims the footer "appears on every route"; `showsFooter` limits it to 24 paths.

`slips.module.ts` — the comment says the module still has to be added to `AppModule`; it is imported at `app.module.ts:20,149`, and adding it twice fails the boot audit.

- [ ] **Step 5: Gate and commit**

---

## Task 15: Verification and security review

- [ ] **Step 1: Full gate, with the tests counted**

```bash
pnpm typecheck && pnpm lint && pnpm boundaries && pnpm test 2>&1 | tee /tmp/gate.log
grep -oE "Tests +[0-9]+ passed" /tmp/gate.log | grep -oE "[0-9]+" | awk '{s+=$1} END {print "TOTAL: " s}'
grep -ciE "skipped|todo" /tmp/gate.log
```
Expected: exit 0, total above 3,052, zero skipped.

- [ ] **Step 2: Build both apps**

```bash
pnpm --filter @wewin/web build && pnpm --filter @wewin/dashboard build
```

- [ ] **Step 3: End-to-end in a real browser**

Sign in as the customer who owns WW-1014, open `/th/payment?order=<id>`, pick an account, upload a slip photo, submit. Then:

```bash
docker exec wewin-demo-postgres-1 psql -U wewin -d wewin -c \
  "SELECT s.amount_thb_minor, s.status, b.bank_code, b.account_number
     FROM payment_slips s JOIN bank_accounts b ON b.id = s.received_bank_account_id
    ORDER BY s.created_at DESC LIMIT 1;"
```
Expected: one row, the chosen account.

⚠️ Disable the browser HTTP cache before measuring anything about CSS or fetched data — the dev CSS chunk filename carries no content hash.

- [ ] **Step 4: Scan the QR with a real banking app**

Confirm the amount shown in the app matches the amount on the page **to the satang**. No automated check substitutes for this; a wrong payload still scans.

- [ ] **Step 5: Security review**

Run the `security-review` skill over the diff. Two surfaces are new: the bank-account editor (change it, wait for a transfer, change it back — answered by the append-only history, which the review should confirm cannot be bypassed by the service) and the first file-upload path open to ordinary users (magic-byte validation, size limits, storage-key handling).

- [ ] **Step 6: Clean up**

Stop both dev servers. Close any probe account with `status='closed', closed_at=now()` — never `DELETE`.

- [ ] **Step 7: Final commit**

---

## Self-review notes

Checked against the spec on 2026-08-09:

- Every spec section maps to a task. The spec's build order (1–10) expands to Tasks 1–15 here; nothing in the spec is unimplemented.
- `readSatang`/`satangField`/`ParseResult` are named identically in Tasks 2, 12 and 13.
- `PaymentInstructionsWire` is defined in Task 8 and consumed in Tasks 10 and 13 with the same field names.
- `promptPayPayload`/`promptPayTarget` are defined in Task 3 and consumed in Task 13 with the same signatures.
- Task 11b was added during this review: the spec claims `organisation_profile` fills a hole
  in the document, and no task was putting it there. The customer's quotation carries no
  seller identity today.
- Two known gaps the implementer must close rather than guess: the exact identifiers of `DRIZZLE`/`Database`/`Transaction` (Task 9 Step 2 says to read them from `option-catalog.service.ts` first), and the outstanding-amount source in Task 10 Step 3, which must reuse whatever the staff slip-review wire reads rather than re-deriving it.
