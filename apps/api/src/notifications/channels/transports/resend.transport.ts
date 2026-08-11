import { Logger } from '@nestjs/common';
import { Resend, type CreateEmailRequestOptions, type CreateEmailResponse } from 'resend';

import { PermanentTransportError, type EmailTransport, type OutgoingEmail } from './email-transport';

/**
 * Resend — the transport that actually leaves the building, via the official SDK.
 *
 * ── Why the SDK and not another hand-rolled client ────────────────────────────────────
 *
 * `auth/oauth/http.ts` and `fx/fx-http.ts` are hand-rolled on purpose: each talks to one
 * endpoint, sends one shape of request, and a fifty-line client the team owns end to end is
 * less risk than a dependency for that little surface. This one *was* hand-rolled the same
 * way — see git history — and was deliberately swapped for `resend` (`apps/api/package.json`)
 * for a reason specific to this provider: **quotation PDFs will need to be attached to
 * emails**, and Resend's attachment shape (`content`/`filename`/`path`, base64 or a
 * `Buffer`, multipart under the hood) is exactly the part not worth re-implementing by hand.
 * The pattern here differs from its two siblings for that one reason, not because the key
 * discipline below matters any less — it doesn't, and every protection those two files
 * apply by writing `fetch` calls by hand, this file re-establishes by threading the same
 * options through the SDK's escape hatch (see `send`).
 *
 * ── The SDK's error shape — audited, not assumed ──────────────────────────────────────
 *
 * `resend@6.19.0`'s `dist/index.mjs` (`Resend.fetchRequest`) never throws: every path —
 * a non-2xx response, a response body that fails to parse, and a **network failure or an
 * aborted request** — is caught internally and turned into `{ data: null, error, headers }`.
 * `error` is always the SDK's own typed `ErrorResponse` shape, `{ message, statusCode, name }`
 * — confirmed against the SDK's own `RESEND_ERROR_CODE_KEY` union in `dist/index.d.mts`,
 * which is a more authoritative source than the public docs page this file's previous
 * version had to fall back on. Crucially, **on a network failure or an abort the SDK
 * discards the real underlying error entirely** and returns a fixed generic message
 * (`"Unable to fetch data. The request could not be resolved."`) — verified live, including
 * with `.cause` inspected by dumping every enumerable property of the thrown/returned value.
 * There is no `.cause` anywhere in what this SDK hands back, because there is no original
 * error left by the time it does. Net effect: **the key cannot reach this file's error or
 * log output via the SDK's error object, because the object structurally has nowhere to
 * carry a request header** — `error.headers` in the raw HTTP sense doesn't exist on
 * `ErrorResponse` at all, and the *response* headers the SDK does expose
 * (`Object.fromEntries(response.headers.entries())`) are never read here regardless (see
 * `send`, below). This was proved by triggering a real 401 with a deliberately wrong key and
 * a real network failure against the live API and inspecting the whole result object,
 * `JSON.stringify`'d and `String()`'d — the key was in neither, in either case.
 *
 * ── What the SDK does *not* do, proved rather than assumed ───────────────────────────
 *
 *   timeout       none. A black-hole server (accepts the connection, never responds) left a
 *                 bare `resend.emails.send(...)` unresolved past a two-second watchdog in
 *                 testing. `CreateEmailRequestOptions` has no typed `signal` field, but the
 *                 SDK's `post()` spreads its `options` parameter directly into the object it
 *                 hands `fetch()` — so a `signal` an object literal doesn't declare a type
 *                 for still reaches `fetch` unchanged. Verified live: the same black-hole
 *                 server aborted at ~300ms once `signal: AbortSignal.timeout(300)` was passed
 *                 through `options`. `send`, below, does this on every call.
 *   redirects     followed by default — verified live with a 302 to a second local server,
 *                 whose response came back as if it were Resend's own. `redirect` is exactly
 *                 as absent from the typed options as `signal` is, and reaches `fetch` the
 *                 same way; `redirect: 'error'` passed through `options` was verified to
 *                 block it (the call failed instead of silently returning the second
 *                 server's body). This is `auth/oauth/http.ts`'s exact concern — an endpoint
 *                 answering `3xx` sends whatever the client sends next to wherever it names —
 *                 and it applies here unchanged, so `send` sets it on every call too.
 *   retries       none anywhere in the bundle (`grep -i retry` over the whole of
 *                 `dist/index.mjs` returns nothing). A failure means exactly one attempt was
 *                 made, which is what makes `Idempotency-Key` (below) meaningful rather than
 *                 redundant with something the SDK might already be doing.
 *   size ceiling  none, and — unlike the two gaps above — this file cannot supply one. The
 *                 SDK owns the `fetch` call and the `response.text()`/`JSON.parse` after it;
 *                 nothing in `ResendOptions` or `CreateEmailRequestOptions` exposes a hook to
 *                 read the stream ourselves, and building one would mean re-implementing the
 *                 exact HTTP client the SDK exists to replace. Accepted as-is: Resend's own
 *                 success body is one field (`{"id": "…"}`) and this is Resend's server
 *                 answering, not arbitrary third-party content.
 *
 * ── The one thing this file must keep doing regardless of the transport underneath ───
 *
 * Never read `error.message` or `error.name` into a log line or a thrown error, even though
 * live testing found both safe today. An SDK's error vocabulary is not this file's contract
 * to rely on forever — the status code alone is enough to classify the failure (see `send`),
 * and a field this file does not need is a field it does not have to keep re-auditing.
 */

const DEFAULT_TIMEOUT_MS = 8_000;

export class ResendEmailTransport implements EmailTransport {
  readonly name = 'resend';
  private readonly logger = new Logger('ResendEmailTransport');
  private readonly client: Resend;

  constructor(
    apiKey: string,
    /** Overridden in tests so a hostile server never costs a real timeout. */
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {
    this.client = new Resend(apiKey);
  }

  async send(email: OutgoingEmail): Promise<string | undefined> {
    /*
     * `signal` and `redirect` are not in `CreateEmailRequestOptions`'s declared shape — see
     * the header for why they are still required, and why assigning to this explicitly-typed
     * local (rather than passing an object literal straight to `emails.send`) is what lets
     * TypeScript accept the extra fields without a cast: excess-property checking only
     * applies to object literals at the call site, and a supertype of the declared options
     * is assignable wherever the declared type is expected.
     */
    const options: CreateEmailRequestOptions & { signal: AbortSignal; redirect: RequestInit['redirect'] } = {
      idempotencyKey: idempotencyKeyFor(email.messageId),
      signal: AbortSignal.timeout(this.timeoutMs),
      redirect: 'error',
    };

    let result: CreateEmailResponse;
    try {
      result = await this.client.emails.send(
        {
          from: email.from,
          to: email.to,
          subject: email.subject,
          text: email.body,
          headers: { ...email.headers },
        },
        options,
      );
    } catch (error) {
      /*
       * Defensive, not expected: `Resend.fetchRequest` catches everything that reaches it
       * and never rethrows (see the header). What is *not* wrapped in that catch is
       * `JSON.stringify(entity)` inside the SDK's own `post()`, called before `fetchRequest`
       * — unreachable with the plain-string payload this file always sends, but "verified
       * today" is not "guaranteed by the SDK's contract". `.name` only, never `.message` or
       * `.cause` — the same rule every other client in this codebase applies to a caught
       * `fetch` failure, for the same reason: a message or a cause chain can carry request
       * detail this file has not audited.
       */
      const reason = error instanceof Error ? error.name : 'unknown error';
      this.logger.warn(`resend emails.send threw: ${reason}`);
      throw new Error('resend request failed');
    }

    if (result.error !== null) {
      const status = result.error.statusCode;
      this.logger.warn(`resend emails.send returned ${status === null ? 'no response' : String(status)}`);
      const description = `resend request returned ${status === null ? 'no response' : String(status)}`;

      /*
       * The mirror of SmtpEmailTransport's 5xx-is-permanent rule (see that file). SMTP's 5xx
       * is the *server* refusing this exact message; Resend's REST 4xx means *this request*
       * — key, `from`, shape — was wrong, and none of that changes by retrying five times in
       * an hour, so it is permanent. `null` covers a network failure, a timeout, and a
       * blocked redirect alike (the SDK does not distinguish them — see the header) and is
       * treated as transient, same as any 5xx: "when in doubt an adapter says retryable:
       * true" (channel.ts). `429` is the one 4xx carved out, because a rate or quota limit is
       * not a statement about this message and can clear before the next attempt.
       */
      if (status === null || status === 429 || status >= 500) throw new Error(description);
      throw new PermanentTransportError(description);
    }

    return result.data.id;
  }
}

/**
 * `wewin:` plus the message id `EmailChannelAdapter` and `PasswordResetService` already use
 * for `Message-ID` — stable across every retry of *this* message and different for every
 * other one, so a retry within Resend's 24-hour idempotency window replays the first
 * attempt's result instead of sending a second, different password-reset link. Unchanged by
 * the SDK swap: `IdempotentRequest.idempotencyKey` maps straight onto the same
 * `Idempotency-Key` header the hand-rolled version set directly. The slice is defensive —
 * every messageId in this codebase today is far under Resend's 256-character ceiling.
 */
function idempotencyKeyFor(messageId: string): string {
  return `wewin:${messageId}`.slice(0, 256);
}
