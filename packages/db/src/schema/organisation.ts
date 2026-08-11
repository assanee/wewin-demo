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
    /*
     * The share of the grand total that must be received before production may start.
     *
     * No `.default()`. `apps/api/src/orders/defaults.ts:12-15` forbids a column default for a
     * placeholder business number by name; migration 0029 writes 10000 into the single row
     * instead, so the value sits somewhere a person can see it was chosen.
     *
     * Lower bound 1, not 0: `depositPercentTerms` already refuses 0 bp
     * (`apps/api/tests/payments/schedule/plan.test.ts:172-173`), and the CHECK reports that
     * refusal at the layer where it is cheap instead of at submit.
     */
    depositBp: smallint('deposit_bp').notNull(),
    ...timestamps,
  },
  (table) => [
    check('organisation_profile_one_row', sql`${table.id} = 1`),
    check('organisation_profile_tax_id_shape', sql`${table.taxId} is null or ${table.taxId} ~ '^[0-9]{13}$'`),
    check('organisation_profile_legal_name_says_something', sql`length(btrim(${table.legalNameTh})) > 0`),
    check('organisation_profile_address_says_something', sql`length(btrim(${table.addressTh})) > 0`),
    check('organisation_profile_deposit_in_range', sql`${table.depositBp} between 1 and 10000`),
  ],
);

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
