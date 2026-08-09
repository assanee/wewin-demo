import type { OrganisationProfilePutRequestWire } from '@wewin/contract/organisation';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The company profile form, checked before it is sent rather than after.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `organisationProfilePutSchema` (packages/contract/src/organisation.ts) is the authority —
 * `profileFormErrors` mirrors its two *shape* rules: `taxId` is thirteen digits or absent,
 * `email` looks like an address or is absent. Restated here so a person sees the refusal
 * beside the field while they are still typing, the same trade `value-dialog.tsx` makes for a
 * swatch hex.
 *
 * ⚠️ **A field that is merely empty is never an "error" here.** `value-dialog.tsx`'s
 * `hexError` sets the precedent this follows: `swatchHex.trim() !== '' && !HEX.test(...)`, so
 * an untouched blank field shows no red text on the moment a dialog opens. `profileFormErrors`
 * does the same — it reports a *shape* problem (a badly formed tax id, an email with no `@`)
 * and never "this is required", which is why the three required fields
 * (`legalNameTh`/`addressTh`/`phone`) are not represented in `ProfileFormErrors` at all.
 * `profileFormReady` is where "required" lives, and it only ever disables the Save button —
 * it never paints a field red for a person who has not typed anything yet.
 */

export interface ProfileFields {
  readonly legalNameTh: string;
  readonly legalNameEn: string;
  readonly addressTh: string;
  readonly addressEn: string;
  readonly taxId: string;
  readonly phone: string;
  readonly email: string;
}

const TAX_ID = /^[0-9]{13}$/u;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export interface ProfileFormErrors {
  readonly taxId?: string;
  readonly email?: string;
}

export function profileFormErrors(fields: ProfileFields): ProfileFormErrors {
  const errors: Record<string, string> = {};

  if (fields.taxId.trim() !== '' && !TAX_ID.test(fields.taxId.trim())) {
    errors['taxId'] = 'เลขผู้เสียภาษีเป็นตัวเลข 13 หลัก';
  }

  if (fields.email.trim() !== '' && !EMAIL.test(fields.email.trim())) {
    errors['email'] = 'อีเมลไม่ถูกต้อง';
  }

  return errors;
}

/**
 * Whether the form may be submitted: the three required fields hold something, and neither
 * shape check above is failing. This is the only place "required" is enforced — it disables
 * the Save button and never paints a field's border red for it.
 */
export function profileFormReady(fields: ProfileFields): boolean {
  return (
    fields.legalNameTh.trim() !== '' &&
    fields.addressTh.trim() !== '' &&
    fields.phone.trim() !== '' &&
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
}): ProfileFields {
  return {
    legalNameTh: profile.legalNameTh,
    legalNameEn: profile.legalNameEn ?? '',
    addressTh: profile.addressTh,
    addressEn: profile.addressEn ?? '',
    taxId: profile.taxId ?? '',
    phone: profile.phone,
    email: profile.email ?? '',
  };
}
