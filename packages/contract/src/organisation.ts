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
  /** Basis points of the grand total due before production may start. 10 000 is payment in full. */
  depositBp: z.int().min(1).max(10_000).optional(),
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
  readonly depositBp: number;
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

/* ------------------------------------------------------------------ *
 * The exchange-rate feed, as a screen sees it
 * ------------------------------------------------------------------ */

/**
 * ⭐ How old the newest exchange rate is, and how many syncs have failed since it landed.
 *
 * Read-only, and there is no request shape beside it on purpose: nothing here is settable.
 * The two thresholds are constants in `apps/api/src/fx/staleness.ts` and are reported *down*
 * rather than configured up, so a screen never has to hold a second copy of them — the panel
 * that renders "36 ชั่วโมง" gets the 36 from the same constant the refusal compares against,
 * and the two cannot drift into a screen showing green over a submit that is being refused.
 *
 * ⚠️ **Both clocks travel, and the pair is the diagnosis.** `observedAt` is when the provider
 * struck the rate and `fetchedAt` is when we stored it; `ageHours` is measured on the *first*
 * (see `staleness.ts`). A `fetchedAt` of minutes ago beside an `observedAt` of three weeks ago
 * is a provider whose feed has frozen while its HTTP endpoint stays healthy — the failure that
 * is invisible to any check built on fetch time — and it is only legible when a reader can see
 * both. Neither is derivable from the other, so neither is redundant.
 */
export interface FxRateHealthWire {
  /** `'ok' | 'warn' | 'blocked'`, decided server-side by the same function the refusal uses. */
  readonly status: string;
  /**
   * Hours since `observedAt`, exact. `null` — and only — when `fx_rates` has never had a row,
   * which is a different fact from "an age of zero" and is reported as `status: 'blocked'`
   * because that is what a foreign-currency submit already does about it.
   */
  readonly ageHours: number | null;
  /** ISO 8601. `null` when there is no observation at all. */
  readonly observedAt: string | null;
  /** ISO 8601. `null` when there is no observation at all. */
  readonly fetchedAt: string | null;
  /**
   * Failed syncs recorded since the newest stored rate — so a landed retry resets it by
   * arithmetic rather than by anybody clearing a counter.
   *
   * ⚠️ A **lower bound**. A failure the database refused to record is a failure that is not
   * counted; see `FxRatesService.record` for why that path swallows rather than throws. Zero
   * beside a large `ageHours` is therefore its own signal: it means nothing is even trying,
   * which is a stopped scheduler rather than a struggling provider.
   */
  readonly consecutiveFailures: number;
  /** ISO 8601 of the newest recorded failure, or `null` when none has been recorded. */
  readonly lastFailureAt: string | null;
  /** The soft threshold, in hours — reported so a screen holds no copy of it. */
  readonly warnAfterHours: number;
  /** The hard threshold, in hours. Past this a foreign-currency submit is refused. */
  readonly refuseAfterHours: number;
  /**
   * ⭐ How many people could actually be told — holders of `organisation.write` with an active
   * account and a primary (therefore verified) email address.
   *
   * Here because **zero is a worse condition than a stale rate**, and until it was on this
   * payload it was only ever a line in a log. Nobody holding the permission means the staleness
   * warning has no destination that can act on it: the mail still goes to the sales queue, but
   * the people who could type `fxManualRate` are not reachable, and the next foreign-currency
   * submit is refused with nobody having been warned. That is the precise failure class this
   * whole phase exists to remove, so it is reported on the same card as the staleness itself.
   *
   * It deliberately counts *reachability*, not authority: somebody who holds the permission but
   * whose account is suspended, or who has no primary address, is not counted, because they
   * cannot be told. See `PermissionRepository.addressesHolding`.
   */
  readonly warningRecipients: number;
}
