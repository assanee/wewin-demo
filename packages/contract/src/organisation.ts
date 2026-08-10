import { z } from 'zod';

import type { MoneyWire } from './money.js';

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
