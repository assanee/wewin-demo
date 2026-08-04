import { Injectable, Logger } from '@nestjs/common';

/**
 * The only thing in this module that talks to the outside world.
 *
 * One class rather than `fetch` at four call sites, because every provider call needs the
 * same three things and none of them are the default:
 *
 *   a timeout          `fetch` has none. A provider that accepts the connection and then
 *                      stops talking would otherwise hold a request, a pool slot and a
 *                      customer's login open until something else gives up first.
 *   a size ceiling     the response is parsed as JSON. Without a ceiling, "how much memory
 *                      does this take" is a question the provider answers.
 *   no redirects       a token endpoint does not redirect. Following one would send the
 *                      client secret to wherever the redirect pointed, which is the whole
 *                      of the attack: a compromised or misconfigured endpoint that answers
 *                      `302` to a host it names.
 *
 * Errors carry the status and the URL and never the body, because a token-endpoint error
 * body can echo the parameters it was sent — including `client_secret` on some providers.
 */

export class OAuthHttpError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'OAuthHttpError';
    this.status = status;
  }
}

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 256 * 1024;

@Injectable()
export class OAuthHttp {
  private readonly logger = new Logger('OAuthHttp');

  constructor(private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS) {}

  async getJson(url: string, headers: Readonly<Record<string, string>> = {}): Promise<unknown> {
    return this.request(url, { method: 'GET', headers: { accept: 'application/json', ...headers } });
  }

  /**
   * `application/x-www-form-urlencoded`, because that is what RFC 6749 specifies for the
   * token endpoint and what all four providers accept. Not JSON: LINE and Facebook reject
   * a JSON body outright.
   */
  async postForm(
    url: string,
    form: Readonly<Record<string, string>>,
    headers: Readonly<Record<string, string>> = {},
  ): Promise<unknown> {
    const body = new URLSearchParams(form).toString();
    return this.request(url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        ...headers,
      },
      body,
    });
  }

  private async request(url: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      // The provider's hostname is useful in a log and harmless in one; the cause chain
      // from `fetch` is not, since a request body carrying a client secret can appear in it.
      const reason = error instanceof Error ? error.name : 'unknown error';
      this.logger.warn(`${init.method ?? 'GET'} ${hostOf(url)} failed: ${reason}`);
      throw new OAuthHttpError(`provider request to ${hostOf(url)} failed`);
    }

    if (!response.ok) {
      throw new OAuthHttpError(
        `provider request to ${hostOf(url)} returned ${String(response.status)}`,
        response.status,
      );
    }

    const text = await readCapped(response);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new OAuthHttpError(`provider request to ${hostOf(url)} returned a non-JSON body`);
    }
  }
}

/**
 * Reads at most `MAX_RESPONSE_BYTES` and refuses the rest.
 *
 * `response.text()` would buffer whatever arrives; a `content-length` check alone is not
 * enough because a chunked response does not have to send one. So the stream is read and
 * counted, and the ceiling is enforced on what was actually received.
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
        throw new OAuthHttpError('provider response exceeded the size ceiling');
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  return text + decoder.decode();
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'an unparseable URL';
  }
}
