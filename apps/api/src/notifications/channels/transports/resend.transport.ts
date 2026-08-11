import { Logger } from '@nestjs/common';

import { PermanentTransportError, type EmailTransport, type OutgoingEmail } from './email-transport';

/**
 * Resend — the transport that actually leaves the building.
 *
 * `file` writes an `.eml` nobody reads unless they go looking; `smtp` has never spoken to a
 * real MTA (see smtp.transport.ts). This one is a REST call to a provider the owner has
 * already chosen, with a key already sitting in `.env`.
 *
 * ── Which of this repo's outbound-client shapes applies here ─────────────────────────
 *
 * `auth/oauth/http.ts` never lets a caught error carry the *response body*, because a token
 * endpoint can echo back the parameters it was sent — including `client_secret`.
 * `fx/fx-http.ts` goes one step further and never lets an error carry the *URL*, because
 * Open Exchange Rates puts its key in the query string, so the URL itself is the secret.
 *
 * Resend is a third shape, not a copy of either. The key travels in the `Authorization`
 * header and nowhere else: there is no query string (`RESEND_API_URL` is a fixed constant,
 * never built from anything secret) and the request body below (`from`/`to`/`subject`/…)
 * never contains it either. So the URL is safe to name in a log line, and — unlike the
 * OAuth case — there is no evidence the response body ever echoes the key back (see the
 * observed shapes below, none of which mention it). The one thing that must never reach a
 * log or a thrown error here is this class's own *request* headers, because the
 * `Authorization` line is the only place the key is ever written down. Nothing below reads
 * `init.headers` back out of the request it built, formats them, or otherwise lets them
 * leak into `describeThrown`-style diagnostics — that is the whole of the discipline this
 * class has to keep, and it is why the tests for this file assert it directly rather than
 * trusting the description above.
 *
 * ── The error shape, from observation ─────────────────────────────────────────────────
 *
 * `resend.com/docs/api-reference/errors` lists status codes and short `name`s but not a
 * body schema. Sending real requests at the real API with this deployment's key (redacted
 * in every case) found the shape to be `{"statusCode": number, "name": string, "message":
 * string}` — for example:
 *
 *   422  {"statusCode":422,"name":"missing_required_field","message":"Missing `to` field."}
 *   403  {"statusCode":403,"name":"validation_error","message":"The wewin.local domain is
 *         not verified. Please, add and verify your domain on https://resend.com/domains"}
 *   401  {"statusCode":401,"name":"validation_error","message":"API key is invalid"}
 *
 * (That last one is worth flagging on its own: the docs list `invalid_api_key` as the 401
 * `name`, but the live API answered `validation_error` — the reference is not exact, which
 * is exactly why this was checked by observation rather than typed in from the docs.) A
 * success is `{"id": "<uuid>"}`, matching the brief's contract precisely.
 *
 * None of the three error bodies above is ever read by this class. Not because the body is
 * known to be safe forever — a provider's undocumented shape can change — but because the
 * status code alone is enough to classify the failure (below), and a body this file does
 * not need is a body it does not have to reason about the safety of.
 *
 * ── Classification: the mirror image of SmtpEmailTransport's ─────────────────────────
 *
 * SMTP's "5xx is permanent" rule is about who is complaining: a 5xx reply is the *server*
 * refusing this exact message, so retrying is pointless. Resend's REST codes read the other
 * way around: a 4xx here means *this request* — its key, its `from` address, its shape —
 * was wrong, and none of that changes by retrying the same message five times inside an
 * hour. A 5xx means Resend's own service had a bad moment, which is what the outbox exists
 * to absorb. `429` is the one 4xx carved out: a rate or quota limit is not a statement about
 * this message and can clear before the next attempt, so — per `channel.ts`'s own rule,
 * "when in doubt an adapter says retryable: true" — it is treated as transient.
 */

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const RESEND_API_URL = 'https://api.resend.com/emails';

export class ResendEmailTransport implements EmailTransport {
  readonly name = 'resend';
  private readonly logger = new Logger('ResendEmailTransport');

  constructor(
    private readonly apiKey: string,
    /** Overridden in tests so a hostile server never costs a real timeout. */
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  async send(email: OutgoingEmail): Promise<string | undefined> {
    let response: Response;
    try {
      response = await fetch(RESEND_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKeyFor(email.messageId),
        },
        body: JSON.stringify({
          from: email.from,
          to: email.to,
          subject: email.subject,
          text: email.body,
          headers: email.headers,
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      // `.name` only, exactly as auth/oauth/http.ts and fx/fx-http.ts already do — a
      // `fetch` failure's `.message` (and `.cause`) has been observed to carry request
      // detail neither of those files is willing to repeat into a log line.
      const reason = error instanceof Error ? error.name : 'unknown error';
      this.logger.warn(`POST api.resend.com/emails failed: ${reason}`);
      throw new Error('resend request failed');
    }

    if (!response.ok) {
      // The body is deliberately never read here — see the header. A connection left with
      // an unconsumed body is still worth releasing.
      await response.body?.cancel().catch(() => undefined);
      this.logger.warn(`POST api.resend.com/emails returned ${String(response.status)}`);
      const description = `resend request returned ${String(response.status)}`;
      if (response.status === 429 || response.status >= 500) throw new Error(description);
      throw new PermanentTransportError(description);
    }

    const text = await readCapped(response);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // A 200 is Resend saying the message was accepted; a body it did not promise is a
      // detail lost, not a delivery that failed. See the interface: "the provider's id when
      // there is one, or undefined".
      this.logger.warn('POST api.resend.com/emails returned 200 with an unparseable body');
      return undefined;
    }

    const id = isIdBody(parsed) ? parsed.id : undefined;
    if (id === undefined) this.logger.warn('POST api.resend.com/emails returned 200 without an id');
    return id;
  }
}

function isIdBody(value: unknown): value is { id: string } {
  return typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'string';
}

/**
 * `wewin:` plus the message id `EmailChannelAdapter` and `PasswordResetService` already use
 * for `Message-ID` — stable across every retry of *this* message (the outbox reclaims the
 * same notification id; a password reset reuses the same token hash within one `send`) and
 * different for every other one. That is exactly what stops a password-reset email from
 * arriving twice with two links and no way to tell which is still live: a retry within
 * Resend's 24-hour idempotency window replays the first attempt's result instead of sending
 * again. `wewin:` namespaces the key inside Resend's own dashboard, where every send across
 * every application on the account shares one 24-hour idempotency space. The slice is
 * defensive: every messageId in this codebase today is a UUID or a short hash, far under
 * Resend's 256-character ceiling, but nothing enforces that at the type level.
 */
function idempotencyKeyFor(messageId: string): string {
  return `wewin:${messageId}`.slice(0, 256);
}

/**
 * Reads at most `MAX_RESPONSE_BYTES` and refuses the rest.
 *
 * Copied from `auth/oauth/http.ts`'s `readCapped` rather than imported, as `fx-http.ts`
 * already does for the same reason: that function is a private implementation detail of a
 * sibling class, and this one is only ever called on a 2xx response — Resend's success body
 * is a one-field object, so the ceiling is pure defence against a misbehaving proxy, not
 * something this endpoint is expected to hit.
 */
async function readCapped(response: Response): Promise<string> {
  const body = response.body;
  if (body === null) return '';

  const decoder = new TextDecoder();
  const reader = body.getReader();
  let received = 0;
  let text = '';

  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += chunk.value.byteLength;
      if (received > MAX_RESPONSE_BYTES) throw new Error('resend response exceeded the size ceiling');
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  return text + decoder.decode();
}
