/**
 * The API's error envelope, as this client reads it.
 *
 * It is restated here rather than imported, and that is a debt with an owner:
 * apps/api/src/common/errors/app-error.ts says in its own header that this type "moves to
 * packages/contract when contract lands so that web and dashboard share it instead of
 * restating it" — and it has not moved yet (there is no `ErrorEnvelope` in
 * packages/contract/src as of this phase). Importing from apps/api is not the alternative:
 * that app is CommonJS with decorator metadata, and `turbo boundaries` exists to keep
 * app-to-app reaching from becoming normal. So: restated, narrowly, with the drift written
 * down. When it lands in contract, delete everything above `ApiError` and import instead.
 *
 * Clients branch on `code`, never on `message`. The message is prose for a human and is
 * scheduled to be translated in phase 6.
 */

export const ERROR_CODES = [
  'BAD_REQUEST',
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'PAYLOAD_TOO_LARGE',
  'DATABASE_UNAVAILABLE',
  'SERVICE_UNAVAILABLE',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}

/**
 * Everything that can go wrong with a call, as one type.
 *
 * `status` is 0 for the failures that never produced a response at all — the API being
 * down, DNS, and the one that will actually bite somebody here: a CORS preflight the API
 * refused because this origin is not in its `CORS_ORIGINS`. `fetch` reports all three as an
 * indistinguishable `TypeError`, so the message says so rather than pretending to know.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode | 'NETWORK' | 'MALFORMED';
  readonly requestId: string | undefined;
  readonly details: unknown;

  constructor(init: {
    status: number;
    code: ErrorCode | 'NETWORK' | 'MALFORMED';
    message: string;
    requestId?: string | undefined;
    details?: unknown;
  }) {
    super(init.message);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId;
    this.details = init.details;
  }

  /** True when signing in again could plausibly help. `FORBIDDEN` is not one of these. */
  get isUnauthenticated(): boolean {
    return this.code === 'UNAUTHENTICATED';
  }
}

/**
 * Turns a non-2xx `Response` into an `ApiError` without ever assuming it is our envelope.
 *
 * A 502 from a load balancer is HTML, a 413 can be empty, and `response.json()` throws on
 * both. Reading the body defensively is not paranoia here — the alternative is that the
 * dashboard's error handling breaks precisely when the API is the thing that is broken.
 */
export async function apiErrorFromResponse(response: Response): Promise<ApiError> {
  const body: unknown = await response.json().catch(() => undefined);

  if (typeof body === 'object' && body !== null && 'error' in body) {
    const { error } = body as { error: unknown };
    if (typeof error === 'object' && error !== null) {
      const envelope = error as Record<string, unknown>;
      const code = isErrorCode(envelope['code']) ? envelope['code'] : 'MALFORMED';
      const message =
        typeof envelope['message'] === 'string' ? envelope['message'] : response.statusText;
      const requestId =
        typeof envelope['requestId'] === 'string' ? envelope['requestId'] : undefined;

      return new ApiError({
        status: response.status,
        code,
        message,
        requestId,
        details: envelope['details'],
      });
    }
  }

  return new ApiError({
    status: response.status,
    code: 'MALFORMED',
    message: `เซิร์ฟเวอร์ตอบกลับด้วยสถานะ ${String(response.status)} ในรูปแบบที่อ่านไม่ได้`,
  });
}

/** The `fetch` rejected outright: no response, so no status and no request id. */
export function networkError(cause: unknown): ApiError {
  return new ApiError({
    status: 0,
    code: 'NETWORK',
    message:
      'ติดต่อเซิร์ฟเวอร์ไม่ได้ — อาจเป็นเพราะ API ไม่ทำงาน หรือ origin นี้ไม่อยู่ใน CORS_ORIGINS ของ API',
    details: cause,
  });
}
