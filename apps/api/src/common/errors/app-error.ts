/**
 * One error envelope for the whole API.
 *
 * Clients branch on `code`, never on `message` — the message is prose for a human and
 * will be translated in phase 6 (plan section 5, "`Issue` must stop being a string").
 * `details` is the machine-readable part and is the only place a client should read
 * anything structured from.
 *
 * When packages/contract lands, this envelope type moves there so that web and dashboard
 * share it instead of restating it.
 */

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export const ERROR_CODES = [
  'BAD_REQUEST',
  'VALIDATION_FAILED',
  /*
   * Two codes and not one, because a client does two different things with them.
   * `UNAUTHENTICATED` means "there is nobody here yet" and the answer is to refresh or sign
   * in; `FORBIDDEN` means "we know who you are and no", and retrying with a new token is a
   * loop. Until these existed both serialised as `BAD_REQUEST` — the HTTP status was right
   * and the envelope, which is the part clients are told to branch on, was a lie.
   */
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

export interface ErrorBody {
  readonly code: ErrorCode;
  readonly message: string;
  readonly details?: JsonValue;
  readonly requestId: string;
  readonly path: string;
  readonly timestamp: string;
}

export interface ErrorEnvelope {
  readonly error: ErrorBody;
}

/**
 * The status lives on the error rather than in a lookup table because the same code can
 * legitimately carry different statuses later (a CONFLICT that is 409 for a stale catalog
 * document, 423 for a frozen order), and a table would have to be edited in two places.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: JsonValue | undefined;

  constructor(code: ErrorCode, status: number, message: string, details?: JsonValue) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }

  static badRequest(message: string, details?: JsonValue): AppError {
    return new AppError('BAD_REQUEST', 400, message, details);
  }

  static validationFailed(message: string, details?: JsonValue): AppError {
    return new AppError('VALIDATION_FAILED', 422, message, details);
  }

  /** Nobody is here yet. The client refreshes or signs in; retrying unchanged is a loop. */
  static unauthenticated(message: string, details?: JsonValue): AppError {
    return new AppError('UNAUTHENTICATED', 401, message, details);
  }

  static notFound(message: string, details?: JsonValue): AppError {
    return new AppError('NOT_FOUND', 404, message, details);
  }

  static conflict(message: string, details?: JsonValue): AppError {
    return new AppError('CONFLICT', 409, message, details);
  }

  static databaseUnavailable(message: string, details?: JsonValue): AppError {
    return new AppError('DATABASE_UNAVAILABLE', 503, message, details);
  }
}
