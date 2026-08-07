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
 * Clients branch on `code`, never on `message`.
 *
 * ── 6a: the message is now rendered, and a key travels beside it ─────────────────
 *
 * This header used to say the message was "scheduled to be translated in phase 6". This is
 * that phase. apps/api renders every migrated error in the language the caller asks for
 * (`lib/i18n/locale.ts` states it on every request) and sends `messageKey` alongside for a
 * client that would rather render for itself.
 *
 * This dashboard does **not** render for itself, and that is the decision, not an omission.
 * It is staff-facing and Thai-first (plan 8.4); shipping a second copy of a ~100-entry
 * catalogue into a bundle so it can reproduce a sentence the server already produced is two
 * catalogues to keep in step for no reader's benefit. What the key is for here is a log
 * line and a support ticket — see `ApiError.messageKey`.
 *
 * The one thing that must not happen is a key reaching a screen. `displayMessage` and
 * `looksLikeAKey` below are that guarantee, and `tests/locale.test.ts` is its evidence.
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
 * What language the server answered in, when it said.
 *
 * `degraded` means the API had no catalogue entry for this message in the language we asked
 * for and used Thai instead. Kept rather than dropped because it is the only way a screen
 * can honestly say "this one is not translated yet" — and because plan 13's translation
 * bottleneck is a real, long-lived state that ought to be visible to the people who could
 * do something about it, rather than something a customer discovers.
 */
export interface ErrorLocale {
  readonly requested: string | null;
  readonly rendered: string;
  readonly degraded: boolean;
}

function readLocale(value: unknown): ErrorLocale | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { requested, rendered, degraded } = value as Record<string, unknown>;
  if (typeof rendered !== 'string' || typeof degraded !== 'boolean') return undefined;

  return {
    requested: typeof requested === 'string' ? requested : null,
    rendered,
    degraded,
  };
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
  /**
   * The catalogue key the API rendered `message` from, when it had one.
   *
   * ⚠️ **Never render this.** It is here for a log line, a bug report and a support
   * conversation — "the customer got `error.slip.foot_mismatch`" is a far better ticket than
   * a screenshot of a sentence somebody then has to grep for. The thing a person reads is
   * always `message`, which the server has already rendered in a real language.
   *
   * `undefined` for the ~146 API call sites that still throw a hand-written Thai string, and
   * that absence is the honest signal rather than a placeholder key.
   */
  readonly messageKey: string | undefined;
  readonly locale: ErrorLocale | undefined;

  constructor(init: {
    status: number;
    code: ErrorCode | 'NETWORK' | 'MALFORMED';
    message: string;
    requestId?: string | undefined;
    details?: unknown;
    messageKey?: string | undefined;
    locale?: ErrorLocale | undefined;
  }) {
    super(init.message);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId;
    this.details = init.details;
    this.messageKey = init.messageKey;
    this.locale = init.locale;
  }

  /** True when signing in again could plausibly help. `FORBIDDEN` is not one of these. */
  get isUnauthenticated(): boolean {
    return this.code === 'UNAUTHENTICATED';
  }

  /** True when this sentence came back in Thai because the asked-for language has no entry. */
  get isUntranslated(): boolean {
    return this.locale?.degraded ?? false;
  }
}

/**
 * The one sentence a screen may show, and the reason this function exists at all.
 *
 * ── The failure it prevents ──────────────────────────────────────────────────────
 *
 * 6a made every migrated API error carry a key. A key is a fine thing to log and a terrible
 * thing to display: `error.quote.frozen.reprice_line` in a toast is worse than the Thai it
 * replaced, because at least the Thai could be forwarded to somebody who reads it. The
 * brief for this round says the dashboard "must not be the place a raw key leaks to a
 * screen", and this is where that is enforced rather than remembered.
 *
 * So: `message` if the server sent one, and a generic sentence if it did not. There is no
 * branch that reaches for `messageKey`, and `apiErrorFromResponse` below refuses to *build*
 * an `ApiError` whose message is a key, so the two together mean a key cannot arrive here
 * in the first place.
 */
export function displayMessage(error: ApiError): string {
  const text = error.message.trim();
  if (text.length > 0) return text;

  /*
   * Reachable only if the API answered an empty message, which its own renderer cannot
   * produce (`renderInThai` falls back to a complete Thai catalogue). A proxy, a truncated
   * body or a future version could. A sentence with the request id beats an empty toast,
   * which reads as "nothing happened".
   */
  return error.requestId === undefined
    ? 'เกิดข้อผิดพลาดที่ระบบยังอธิบายไม่ได้'
    : `เกิดข้อผิดพลาดที่ระบบยังอธิบายไม่ได้ (อ้างอิง ${error.requestId})`;
}

/**
 * Whether a string the server sent is a message key rather than a sentence.
 *
 * Deliberately shape-based and not a list: the dashboard does not hold the key registry —
 * apps/api does, and copying ~100 keys here to check against would be a second registry
 * that drifts. What is stable is the *shape* the scheme guarantees: dotted, lower-case,
 * no whitespace, at least two segments. A real sentence in any of the eight languages
 * contains a space or a non-Latin character long before it looks like this.
 */
function looksLikeAKey(value: string): boolean {
  return /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/.test(value.trim());
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
      const sent = typeof envelope['message'] === 'string' ? envelope['message'] : response.statusText;
      const requestId =
        typeof envelope['requestId'] === 'string' ? envelope['requestId'] : undefined;
      const messageKey =
        typeof envelope['messageKey'] === 'string' ? envelope['messageKey'] : undefined;

      /*
       * ⚠️ The last gate. If a build of the API ever answers with the key in the `message`
       * field — a renderer that returned its input, a catalogue entry someone wrote as
       * `'error.foo.bar'`, a proxy substituting a body — it stops here rather than reaching
       * a screen. The generic sentence carries the request id, which is what makes it a
       * usable bug report instead of a dead end.
       */
      const message = looksLikeAKey(sent) ? '' : sent;

      return new ApiError({
        status: response.status,
        code,
        message,
        requestId,
        details: envelope['details'],
        messageKey: messageKey ?? (looksLikeAKey(sent) ? sent : undefined),
        locale: readLocale(envelope['locale']),
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

/**
 * Anything thrown, as a sentence a person can read.
 *
 * ⚠️ There are three older copies of this — `catalog-api.ts`, `quote-api.ts` and
 * `user-api.ts` each grew their own, identical, before there was an obvious home for it.
 * This is the home. New callers use this one; folding the other three in is a tidy-up that
 * touches three working screens and belongs in its own change.
 */
export function failureMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message !== '') return error.message;
  return 'เกิดข้อผิดพลาดที่ไม่รู้จัก';
}
