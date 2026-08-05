import {
  encodeServerMessage,
  renderInThai,
  type ServerMessage,
  type WireMessage,
} from '../../i18n';

/**
 * One error envelope for the whole API.
 *
 * Clients branch on `code`, never on `message`. `details` is the machine-readable part and
 * is the only place a client should read anything structured from.
 *
 * ── What changed in 6a: `message` stopped being written here ─────────────────────
 *
 * It used to say the message "will be translated in phase 6 (plan section 5, `Issue` must
 * stop being a string)". This is that phase, and the debt is paid the same way core paid
 * its own: an error carries a **key and its params**, and the sentence is *rendered* from
 * them. `message` is still a string in the envelope, and that is not a leftover —
 *
 *   - it is rendered in the **caller's** language, negotiated per request by
 *     `AllExceptionsFilter`, so a client that wants nothing to do with keys still gets a
 *     usable sentence in a usable language. That is what makes this change safe for the
 *     dashboard, for a curl, and for a log;
 *   - `messageKey` and `messageParams` travel beside it for a client that would rather
 *     render for itself — the storefront, which owns its own typography and its own digits.
 *
 * ── A string message is still accepted, and that is measured rather than assumed ──
 *
 * There are ~200 `AppError` call sites in this app and 6a converted the enumerable ones:
 * the five constraint translators, the allocation arithmetic, the staleness refusals and
 * the two infrastructure answers. The rest still pass a Thai string, which produces an
 * envelope with no `messageKey` — untranslatable, and *visibly* so.
 *
 * `tests/i18n/coverage.test.ts` counts those sites and pins the number, so the remaining
 * debt is a figure that has to be edited downwards deliberately rather than a vibe. A union
 * type with no counter is how a half-migration becomes permanent.
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
  /*
   * A ceiling was reached, and the caller may try again later. Distinct from `FORBIDDEN` for
   * the same reason the two above are distinct from each other: nothing about this caller is
   * refused, only the rate, and a client that treats it as a permission failure will stop
   * retrying something that would have worked. `Retry-After` carries the window.
   */
  'TOO_MANY_REQUESTS',
  'DATABASE_UNAVAILABLE',
  'SERVICE_UNAVAILABLE',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorBody {
  readonly code: ErrorCode;
  /** Rendered in the language negotiated for this request. Never a key, never empty. */
  readonly message: string;
  /**
   * The key `message` was rendered from, for a client that renders for itself.
   *
   * Absent when this error still carries a hand-written Thai string — see the note at the
   * top of this file. Absent is the honest signal: a client can tell "we have no key for
   * this yet" from "the key is one you do not know", and only the second is worth a bug
   * report.
   */
  readonly messageKey?: string;
  readonly messageParams?: JsonValue;
  /**
   * What language `message` came out in, and whether that was the one asked for.
   *
   * `degraded: true` means the caller asked for a language this message does not exist in
   * and got Thai. Reported rather than hidden, because a storefront showing a Thai sentence
   * inside a German page needs to know to mark it, and because "how much of this is still
   * untranslated in the wild" is otherwise unanswerable.
   */
  readonly locale?: { readonly requested: string | null; readonly rendered: string; readonly degraded: boolean };
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
/**
 * What a call site may hand an `AppError`: a structured message, or a Thai string.
 *
 * The string arm is the un-migrated half of the API and it is temporary by intent rather
 * than by comment — `tests/i18n/coverage.test.ts` holds the count.
 */
export type ErrorText = string | ServerMessage;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: JsonValue | undefined;
  /**
   * The structured message, when there is one.
   *
   * `undefined` for a call site that still passes a string. Kept as the `ServerMessage`
   * itself rather than as its wire form so that `bigint` satang survive to the renderer —
   * encoding here would turn 552960n into "552960" three layers before anything needed it
   * to be a string, and a locale that wanted its own digits would be parsing them back.
   */
  readonly serverMessage: ServerMessage | undefined;

  constructor(code: ErrorCode, status: number, message: ErrorText, details?: JsonValue) {
    /*
     * `Error.message` is Thai, always, and that is not the envelope's message.
     *
     * This string goes into logs, into a stack trace and into every `error.message` read
     * elsewhere in the process, and all three of those audiences are this building. The
     * envelope's `message` is rendered separately, per request, in the caller's language —
     * see `AllExceptionsFilter`. Conflating them would put the customer's language in the
     * server log, which is where somebody has to search for the sentence they were told.
     */
    super(typeof message === 'string' ? message : renderInThai(message));
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
    this.serverMessage = typeof message === 'string' ? undefined : message;
  }

  /** The key and params as JSON, or `undefined` for an un-migrated call site. */
  wireMessage(): WireMessage | undefined {
    return this.serverMessage === undefined ? undefined : encodeServerMessage(this.serverMessage);
  }

  static badRequest(message: ErrorText, details?: JsonValue): AppError {
    return new AppError('BAD_REQUEST', 400, message, details);
  }

  static validationFailed(message: ErrorText, details?: JsonValue): AppError {
    return new AppError('VALIDATION_FAILED', 422, message, details);
  }

  /** Nobody is here yet. The client refreshes or signs in; retrying unchanged is a loop. */
  static unauthenticated(message: ErrorText, details?: JsonValue): AppError {
    return new AppError('UNAUTHENTICATED', 401, message, details);
  }

  static notFound(message: ErrorText, details?: JsonValue): AppError {
    return new AppError('NOT_FOUND', 404, message, details);
  }

  static conflict(message: ErrorText, details?: JsonValue): AppError {
    return new AppError('CONFLICT', 409, message, details);
  }

  static databaseUnavailable(message: ErrorText, details?: JsonValue): AppError {
    return new AppError('DATABASE_UNAVAILABLE', 503, message, details);
  }
}
