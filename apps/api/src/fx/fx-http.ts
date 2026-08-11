import { Injectable, Logger } from '@nestjs/common';

/**
 * Talks to Open Exchange Rates and nothing else.
 *
 * Modelled on `auth/oauth/http.ts`: the same three protections, for the same reasons — a
 * timeout (`fetch` has none, so a provider that accepts the connection and stops talking
 * would otherwise hold a request and a pool slot open indefinitely), a size ceiling (the
 * response is parsed as JSON, so without one "how much memory does this take" is a
 * question the provider answers), and no redirects.
 *
 * ── Where this deviates from that file, and why ──────────────────────────────────
 *
 * `OAuthHttp`'s errors carry the request URL, because the leak risk there is the response
 * *body* — a token-endpoint error can echo back the parameters it was sent, including
 * `client_secret`. Here the credential is `app_id`, and it rides in the URL's own query
 * string, so the URL itself is the thing that must never reach a log line or an error
 * message — carrying it "for debugging" would be carrying the key. This class therefore
 * builds that URL internally from a base that never leaves it and exposes no method that
 * accepts one, and every error path below is built from a fixed string plus (where
 * relevant) a status code — never the URL, and never a caught error's `.message`, which a
 * `fetch` failure has been observed to fill with the request URL. Only `.name` is used,
 * exactly as `auth/oauth/http.ts` already does for the same reason on the body side.
 */
export class FxHttpError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'FxHttpError';
    this.status = status;
  }
}

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const BASE_URL = 'https://openexchangerates.org/api/';

@Injectable()
export class FxHttp {
  private readonly logger = new Logger('FxHttp');

  constructor(private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS) {}

  /** `GET latest.json`, authenticated with `appId` as the `app_id` query parameter. */
  async getLatest(appId: string): Promise<unknown> {
    const url = new URL('latest.json', BASE_URL);
    url.searchParams.set('app_id', appId);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.name : 'unknown error';
      this.logger.warn(`GET latest.json failed: ${reason}`);
      throw new FxHttpError('openexchangerates request failed');
    }

    if (!response.ok) {
      this.logger.warn(`GET latest.json returned ${String(response.status)}`);
      throw new FxHttpError(`openexchangerates request returned ${String(response.status)}`, response.status);
    }

    const text = await readCapped(response);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new FxHttpError('openexchangerates request returned a non-JSON body');
    }
  }
}

/**
 * Reads at most `MAX_RESPONSE_BYTES` and refuses the rest.
 *
 * Copied from `auth/oauth/http.ts`'s `readCapped` rather than imported — that function is
 * a private implementation detail of `OAuthHttp`, and the two classes carry deliberately
 * different error types. `response.text()` would buffer whatever arrives regardless of
 * size, and a `content-length` check alone is not enough because a chunked response does
 * not have to send one; this reads the stream and counts, enforcing the ceiling on what
 * was actually received.
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
      if (received > MAX_RESPONSE_BYTES) {
        throw new FxHttpError('openexchangerates response exceeded the size ceiling');
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  return text + decoder.decode();
}
