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
 * once from `beginEnrolment` and once from `regenerateRecoveryCodes`, and a screen that
 * offered to show them again would be a screen somebody on an unlocked laptop could open.
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
  /** For the QR code. */
  readonly otpauthUri: string;
  /** For a phone whose camera will not cooperate. */
  readonly secretBase32: string;
  /** ⚠️ Shown once. Nothing returns these again. */
  readonly recoveryCodes: readonly string[];
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

const decodeEnrolment = (body: unknown): Enrolment => {
  const raw = asRecord(body, 'การตั้งค่า');
  const codes = raw['recoveryCodes'];

  if (!Array.isArray(codes) || codes.length === 0) {
    /*
     * ⚠️ Loud rather than lenient. An enrolment that arrived without codes would put somebody
     * behind a gate with no way through it — and the API's own trigger refuses to raise the
     * gate in that state, so a response like this means something is wrong upstream and the
     * right move is to stop, not to carry on and show an empty list.
     */
    throw new TypeError('การตั้งค่า: ไม่มีรหัสสำรองกลับมา');
  }

  return {
    otpauthUri: asText(raw['otpauthUri'], 'otpauthUri'),
    secretBase32: asText(raw['secretBase32'], 'secretBase32'),
    recoveryCodes: codes.map((code, index) => asText(code, `recoveryCodes[${String(index)}]`)),
  };
};

export const beginEnrolment = (): Promise<Enrolment> =>
  apiJson('/me/account/mfa/enrolment', decodeEnrolment, { method: 'POST' });

export const confirmEnrolment = async (code: string): Promise<void> => {
  const response = await apiFetch('/me/account/mfa', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: code.trim() }),
  });

  if (!response.ok) throw await apiErrorFromResponse(response);
};

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
