import type { OrganisationProfilePutRequestWire } from '@wewin/contract/organisation';

import { readRateBp, rateField } from './tax-country-fields';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The company profile form, checked before it is sent rather than after.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `organisationProfilePutSchema` (packages/contract/src/organisation.ts) is the authority —
 * `profileFormErrors` mirrors its *shape* rules: `taxId` is thirteen digits or absent,
 * `email` looks like an address or is absent, `depositBp` is 1..10 000 basis points. Restated
 * here so a person sees the refusal beside the field while they are still typing, the same
 * trade `value-dialog.tsx` makes for a swatch hex.
 *
 * ⚠️ **A field that is merely empty is never an "error" here.** `value-dialog.tsx`'s
 * `hexError` sets the precedent this follows: `swatchHex.trim() !== '' && !HEX.test(...)`, so
 * an untouched blank field shows no red text on the moment a dialog opens. `profileFormErrors`
 * does the same — it reports a *shape* problem (a badly formed tax id, an email with no `@`, a
 * deposit outside the schema's range) and never "this is required", which is why the four
 * required fields (`legalNameTh`/`addressTh`/`phone`/`depositPercent`) are not represented in
 * `ProfileFormErrors` at all. `profileFormReady` is where "required" lives, and it only ever
 * disables the Save button — it never paints a field red for a person who has not typed
 * anything yet.
 *
 * ⚠️ **1 is the floor for `depositBp`, not 0.** `organisationProfilePutSchema` says so
 * (`z.int().min(1).max(10_000)`) because "the schedule planner refuses a 0% deposit" — a
 * company that truly wants no deposit still has to say so through the schedule's own terms
 * (`payments/schedule/terms.ts`), not by zeroing this setting. `depositBpFromField` below
 * reuses `readRateBp`'s 0..10 000 range check and adds that floor on top, rather than the two
 * disagreeing about what "valid" means for the same unit.
 */

export interface ProfileFields {
  readonly legalNameTh: string;
  readonly legalNameEn: string;
  readonly addressTh: string;
  readonly addressEn: string;
  readonly taxId: string;
  readonly phone: string;
  readonly email: string;
  readonly depositPercent: string;
}

const TAX_ID = /^[0-9]{13}$/u;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const MIN_DEPOSIT_BP = 1;

/** `null` for a blank field too, on top of whatever `readRateBp` already refuses. */
function depositBpFromField(text: string): number | null {
  const bp = readRateBp(text);
  return bp === null || bp < MIN_DEPOSIT_BP ? null : bp;
}

export interface ProfileFormErrors {
  readonly taxId?: string;
  readonly email?: string;
  readonly depositPercent?: string;
}

export function profileFormErrors(fields: ProfileFields): ProfileFormErrors {
  const errors: Record<string, string> = {};

  if (fields.taxId.trim() !== '' && !TAX_ID.test(fields.taxId.trim())) {
    errors['taxId'] = 'เลขผู้เสียภาษีเป็นตัวเลข 13 หลัก';
  }

  if (fields.email.trim() !== '' && !EMAIL.test(fields.email.trim())) {
    errors['email'] = 'อีเมลไม่ถูกต้อง';
  }

  if (fields.depositPercent.trim() !== '' && depositBpFromField(fields.depositPercent) === null) {
    errors['depositPercent'] = 'กรอกเป็นเปอร์เซ็นต์มากกว่า 0 ถึง 100 ทศนิยมไม่เกิน 2 ตำแหน่ง เช่น 30 หรือ 7.5';
  }

  return errors;
}

/**
 * Whether the form may be submitted: the four required fields hold something, and none of the
 * shape checks above is failing. This is the only place "required" is enforced — it disables
 * the Save button and never paints a field's border red for it.
 */
export function profileFormReady(fields: ProfileFields): boolean {
  return (
    fields.legalNameTh.trim() !== '' &&
    fields.addressTh.trim() !== '' &&
    fields.phone.trim() !== '' &&
    fields.depositPercent.trim() !== '' &&
    Object.keys(profileFormErrors(fields)).length === 0
  );
}

/**
 * The request body, once `profileFormErrors` has come back empty.
 *
 * ⚠️ **A blank optional field is sent as `null`, never omitted.** `organisation.service.ts`
 * `putProfile` spreads the request straight into Drizzle's `.set({ ...input, ... })`, and
 * Drizzle only writes the columns whose key is *present* on that object — an absent key
 * leaves the column exactly as it was. So a client that omitted `taxId` when the field was
 * cleared would not clear it in the database at all; it would silently keep whatever tax id
 * was there before. Sending `null` is what makes this a `PUT` — the whole profile, as typed,
 * every time — rather than a patch of only the fields the form happened to touch.
 */
export function profileRequest(fields: ProfileFields): OrganisationProfilePutRequestWire {
  const legalNameEn = fields.legalNameEn.trim();
  const addressEn = fields.addressEn.trim();
  const taxId = fields.taxId.trim();
  const email = fields.email.trim();

  return {
    legalNameTh: fields.legalNameTh.trim(),
    addressTh: fields.addressTh.trim(),
    phone: fields.phone.trim(),
    /*
     * `?? MIN_DEPOSIT_BP` is not a real fallback — `profileFormReady` gates every call site
     * (`organisation-screen.tsx`'s `submit` returns before this runs otherwise), so
     * `depositBpFromField` is never actually null here. Falling back rather than throwing
     * mirrors `slip-review-dialog.tsx`'s own `parsed.ok ? parsed.value : 0n`: a safe default
     * for a branch the type checker cannot see is unreachable, not a value anyone should see.
     */
    depositBp: depositBpFromField(fields.depositPercent) ?? MIN_DEPOSIT_BP,
    ...(legalNameEn === '' ? { legalNameEn: null } : { legalNameEn }),
    ...(addressEn === '' ? { addressEn: null } : { addressEn }),
    ...(taxId === '' ? { taxId: null } : { taxId }),
    ...(email === '' ? { email: null } : { email }),
  };
}

/** The form, from the profile the server last answered with — the dual of `profileRequest`. */
export function fieldsFromProfile(profile: {
  readonly legalNameTh: string;
  readonly legalNameEn: string | null;
  readonly addressTh: string;
  readonly addressEn: string | null;
  readonly taxId: string | null;
  readonly phone: string;
  readonly email: string | null;
  readonly depositBp: number;
}): ProfileFields {
  return {
    legalNameTh: profile.legalNameTh,
    legalNameEn: profile.legalNameEn ?? '',
    addressTh: profile.addressTh,
    addressEn: profile.addressEn ?? '',
    taxId: profile.taxId ?? '',
    phone: profile.phone,
    email: profile.email ?? '',
    depositPercent: rateField(profile.depositBp),
  };
}
