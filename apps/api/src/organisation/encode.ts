import type {
  BankAccountChangeWire,
  BankAccountPublicWire,
  BankAccountWire,
  OrganisationProfileWire,
} from '@wewin/contract/organisation';

/**
 * Never a database row directly. A `Date` would serialise inconsistently across drivers and
 * a new column would leak to the client the day it is added — every wire shape below is
 * spelled out field by field for that reason, not for ceremony.
 */

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
  depositBp: number;
  updatedAt: Date;
}): OrganisationProfileWire => ({
  legalNameTh: row.legalNameTh,
  legalNameEn: row.legalNameEn,
  addressTh: row.addressTh,
  addressEn: row.addressEn,
  taxId: row.taxId,
  phone: row.phone,
  email: row.email,
  depositBp: row.depositBp,
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
