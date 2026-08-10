import { eq } from 'drizzle-orm';
import { beforeAll, expect, it } from 'vitest';

import type { Database } from '../src/client.js';
import { bankAccountChanges, bankAccounts, organisationProfile } from '../src/schema/index.js';
import { PG, connect, describeDb, errorCode } from './support/db.js';

let db: Database;

beforeAll(async () => {
  db = await connect();
});

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

describeDb('the organisation profile is one row, and Postgres is what says so', () => {
  it('refuses a second row', async () => {
    await expectViolation(
      db.insert(organisationProfile).values({
        id: 2,
        legalNameTh: 'บริษัท ทดสอบ จำกัด',
        addressTh: '1 ถนนทดสอบ',
        phone: '+6621234567',
        depositBp: 10_000,
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
        accountNumber: '1000000001',
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
