import 'client-only';

import { apiFetch, apiJson } from '@/lib/api/client';
import { apiErrorFromResponse } from '@/lib/api/errors';

/**
 * The second factor, from the account screen.
 *
 * ⚠️ Shapes restated from `apps/api/src/auth/mfa/mfa-account.controller.ts` — the same
 * boundary debt as every other feature client here, recorded in plan 12.1.
 *
 * ⭐ **There is no `getRecoveryCodes`, and there cannot be.** The API stores SHA-256
 * fingerprints, so nothing on the server can produce the codes a second time. They arrive
 * once from `confirmEnrolment` and once from `regenerateRecoveryCodes`, and a screen that
 * offered to show them again would be a screen somebody on an unlocked laptop could open.
 *
 * ⚠️ From **confirm**, not from enrolment. A person who starts an enrolment and walks away
 * now receives no codes at all, and the ones who do get them have just proved they hold the
 * authenticator.
 */

export interface MfaState {
  readonly enabled: boolean;
  /** A secret written and never proved. The gate is **not** up. */
  readonly enrolling: boolean;
  readonly recoveryCodesRemaining: number;
  readonly recoveryCodesLow: boolean;
  readonly confirmedAt: string | null;
}

export interface Enrolment {
  /** What the QR encodes. The panel draws it locally — nothing fetches an image. */
  readonly otpauthUri: string;
  /** Beside the QR, for a phone whose camera will not cooperate. */
  readonly secretBase32: string;
}

const asRecord = (value: unknown, what: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${what}: expected an object`);
  }
  return value as Record<string, unknown>;
};

const asText = (value: unknown, what: string): string => {
  if (typeof value !== 'string') throw new TypeError(`${what}: expected a string`);
  return value;
};

export const getMfaState = (): Promise<MfaState> =>
  apiJson('/me/account/mfa', (body) => {
    const state = asRecord(body, 'สถานะการยืนยันสองขั้น');

    return {
      enabled: state['enabled'] === true,
      enrolling: state['enrolling'] === true,
      recoveryCodesRemaining:
        typeof state['recoveryCodesRemaining'] === 'number' ? state['recoveryCodesRemaining'] : 0,
      recoveryCodesLow: state['recoveryCodesLow'] === true,
      confirmedAt: typeof state['confirmedAt'] === 'string' ? state['confirmedAt'] : null,
    };
  });

export const beginEnrolment = (): Promise<Enrolment> =>
  apiJson(
    '/me/account/mfa/enrolment',
    (body) => {
      const raw = asRecord(body, 'การตั้งค่า');
      return {
        otpauthUri: asText(raw['otpauthUri'], 'otpauthUri'),
        secretBase32: asText(raw['secretBase32'], 'secretBase32'),
      };
    },
    { method: 'POST' },
  );

/**
 * ⭐ Returns the recovery codes — the one response that ever does.
 *
 * ⚠️ An empty list is refused loudly rather than rendered as an empty box. The gate is up by
 * the time this resolves, so a person shown "no codes" would be behind a factor with no way
 * through it and no way to find out. The API's own trigger makes that state impossible, so a
 * response like it means something is wrong upstream and stopping is the right answer.
 */
export const confirmEnrolment = (code: string): Promise<readonly string[]> =>
  apiJson(
    '/me/account/mfa',
    (body) => {
      const codes = asRecord(body, 'ยืนยัน')['recoveryCodes'];
      if (!Array.isArray(codes) || codes.length === 0) {
        throw new TypeError('ยืนยัน: ไม่มีรหัสสำรองกลับมา');
      }
      return codes.map((code, index) => asText(code, `recoveryCodes[${String(index)}]`));
    },
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: code.trim() }),
    },
  );

/** ⚠️ Costs the password — see the API's `reproof.ts`. */
export const disableMfa = async (password: string): Promise<void> => {
  const response = await apiFetch('/me/account/mfa', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });

  if (!response.ok) throw await apiErrorFromResponse(response);
};

/** ⚠️ Also costs the password: the old set dies and the new one is on screen. */
export const regenerateRecoveryCodes = (password: string): Promise<readonly string[]> =>
  apiJson(
    '/me/account/mfa/recovery-codes',
    (body) => {
      const codes = asRecord(body, 'รหัสสำรอง')['recoveryCodes'];
      if (!Array.isArray(codes)) throw new TypeError('รหัสสำรอง: ไม่ใช่รายการ');
      return codes.map((code, index) => asText(code, `recoveryCodes[${String(index)}]`));
    },
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    },
  );
