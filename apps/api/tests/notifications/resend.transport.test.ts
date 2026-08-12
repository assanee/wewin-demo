import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PermanentTransportError, type OutgoingEmail } from '../../src/notifications/channels/transports/email-transport';
import { FileEmailTransport } from '../../src/notifications/channels/transports/file.transport';
import { ResendEmailTransport } from '../../src/notifications/channels/transports/resend.transport';
import { createEmailTransport } from '../../src/notifications/channels/transports/create-transport';
import { parseNotificationsConfig } from '../../src/notifications/notifications.config';

/**
 * Resend, against `vi.stubGlobal('fetch', …)` — this repo's own idiom for it
 * (`apps/web/tests/reviews.test.ts:385-410`, `tests/fx/fx-rates.pg.test.ts`), and still the
 * right one after the SDK swap: `resend`'s own client calls the *global* `fetch` (confirmed
 * by reading `dist/index.mjs`), so stubbing it exercises the real SDK's request-building and
 * error-parsing, not a mock standing in for it. Response bodies below are the ones this
 * repo's own copy of the SDK returned when the same requests were sent for real (see
 * `resend.transport.ts`'s header).
 *
 * ── Why the key-safety assertions matter more than the happy path ────────────────────
 *
 * `resend.transport.ts`'s whole argument for reading only `result.error.statusCode` — never
 * `.message`, `.name`, or anything the SDK hands back wholesale — rests on nobody adding
 * `JSON.stringify(result.error)` to a log line or a thrown error six months from now because
 * it "helps debugging". `keyNeverAppearsIn` below is the enforcement, and it checks more than
 * `.message`: a thrown `Error`'s `.cause` is exactly where a well-meaning "attach the
 * original error for context" change would put the SDK's raw error object, so it is checked
 * too. Every scenario constructs the transport with a fake key and crafts the mocked
 * response body to *contain* that key — a real Resend error body has never been observed to
 * do this (see resend.transport.ts's header for the shapes actually observed against the
 * live API) — so a client that started surfacing the body wholesale would fail here even
 * though no real response would ever demonstrate the bug on its own.
 */

const FAKE_API_KEY = `re_${'x'.repeat(33)}`; // 36 characters, matching the real key's length.

const EMAIL: OutgoingEmail = {
  from: 'wewin <no-reply@wewin.local>',
  to: 'somchai@example.com',
  subject: 'ยืนยันการชำระเงินแล้ว',
  body: 'เรียน คุณสมชาย',
  messageId: '11111111-1111-4111-8111-111111111111',
  headers: { 'X-Wewin-Order': '22222222-2222-4222-8222-222222222222' },
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

let warn: ReturnType<typeof vi.spyOn> | undefined;

afterEach(() => {
  vi.unstubAllGlobals();
  warn?.mockRestore();
  warn = undefined;
});

/** Every `Logger.prototype.warn` call made anywhere in the process, joined into one string. */
function loggedText(): string {
  const calls = (warn?.mock.calls ?? []) as unknown[][];
  return calls.map((call) => call.map((arg) => String(arg)).join(' ')).join('\n');
}

/**
 * The key must not appear in the thrown error, its `.cause` (however deep), or anything
 * logged along the way. Checked with both `String()` and `JSON.stringify()` because a plain
 * data object (which is what the SDK's `ErrorResponse` is) leaks nothing through `String()`
 * — it prints `[object Object]` — but does through `JSON.stringify()`, and a real mutation
 * could reasonably reach for either.
 */
function keyNeverAppearsIn(thrown: unknown): void {
  expect(thrown).toBeInstanceOf(Error);
  const error = thrown as Error;
  expect(error.message).not.toContain(FAKE_API_KEY);
  expect(String(error.cause)).not.toContain(FAKE_API_KEY);
  expect(JSON.stringify(error.cause ?? null)).not.toContain(FAKE_API_KEY);
  expect(loggedText()).not.toContain(FAKE_API_KEY);
}

describe('ResendEmailTransport', () => {
  it('sends the envelope Resend documents, authenticated by header, and returns the id on 200', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, { id: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794' }));
    vi.stubGlobal('fetch', fetchSpy);

    const transport = new ResendEmailTransport(FAKE_API_KEY, 2_000);
    const id = await transport.send(EMAIL);

    expect(id).toBe('49a3999c-0ce1-4ea6-ab68-afcd6dc2e794');
    expect(transport.name).toBe('resend');

    const [url, init] = fetchSpy.mock.calls[0] as [string | URL, RequestInit];
    expect(String(url)).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    // Neither is in the SDK's typed options — both are threaded through by hand. See
    // resend.transport.ts's header for how this was proved to actually reach `fetch`.
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);

    // The SDK builds a real `Headers` instance, not a plain object.
    const headers = init.headers as Headers;
    expect(headers.get('Authorization')).toBe(`Bearer ${FAKE_API_KEY}`);
    expect(headers.get('Content-Type')).toBe('application/json');
    // Stable across retries of *this* message (see the header comment), namespaced so it
    // is recognisable in Resend's own dashboard among every other application on the key.
    expect(headers.get('Idempotency-Key')).toBe(`wewin:${EMAIL.messageId}`);

    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      from: EMAIL.from,
      to: EMAIL.to,
      subject: EMAIL.subject,
      text: EMAIL.body,
      headers: EMAIL.headers,
    });
  });

  it('caps a runaway Idempotency-Key at 256 characters', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { id: 'x' })));
    const transport = new ResendEmailTransport(FAKE_API_KEY, 2_000);

    await transport.send({ ...EMAIL, messageId: 'm'.repeat(400) });

    const fetchSpy = vi.mocked(fetch);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const key = (init.headers as Headers).get('Idempotency-Key') ?? '';
    expect(key.length).toBeLessThanOrEqual(256);
  });

  it('treats a 4xx as permanent — this exact request will not become valid by retrying', async () => {
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(422, { statusCode: 422, name: 'missing_required_field', message: 'Missing `to` field.' }),
      ),
    );

    const thrown = await new ResendEmailTransport(FAKE_API_KEY, 2_000)
      .send(EMAIL)
      .then(() => undefined, (error: unknown) => error);

    expect(thrown).toBeInstanceOf(PermanentTransportError);
    expect((thrown as Error).message).toContain('422');
    // The body said `missing_required_field` and quoted the field — none of it belongs in
    // the thrown error or the log. See the file header for why this is the rule regardless
    // of whether *this* body happens to be safe.
    expect((thrown as Error).message).not.toContain('missing_required_field');
    expect(loggedText()).not.toContain('missing_required_field');
  });

  it('treats 401, 403 and 405 as permanent too — an observed sample, not a guess', async () => {
    // Bodies as actually returned by the live API against this deployment's own key, and
    // cross-checked against the SDK's own RESEND_ERROR_CODE_KEY union in dist/index.d.mts
    // (see resend.transport.ts's header) — the public docs page alone would not have caught
    // that the live 401's `name` is `validation_error`, not the documented `invalid_api_key`.
    const observed: ReadonlyArray<[number, unknown]> = [
      [401, { statusCode: 401, name: 'validation_error', message: 'API key is invalid' }],
      [
        403,
        {
          statusCode: 403,
          name: 'validation_error',
          message: 'The wewin.local domain is not verified. Please, add and verify your domain on https://resend.com/domains',
        },
      ],
      [405, { statusCode: 405, name: 'method_not_allowed', message: 'Method not allowed' }],
    ];

    for (const [status, body] of observed) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(status, body)));
      const thrown = await new ResendEmailTransport(FAKE_API_KEY, 2_000)
        .send(EMAIL)
        .then(() => undefined, (error: unknown) => error);
      expect(thrown, `status ${String(status)}`).toBeInstanceOf(PermanentTransportError);
    }
  });

  it('treats 429 as transient — a rate or quota limit is not a statement about this message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(429, { statusCode: 429, name: 'rate_limit_exceeded', message: 'Too many requests' })),
    );

    const thrown = await new ResendEmailTransport(FAKE_API_KEY, 2_000)
      .send(EMAIL)
      .then(() => undefined, (error: unknown) => error);

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(PermanentTransportError);
  });

  it('treats a 5xx as transient — Resend having a bad moment, not this message being wrong', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 500 })));

    const thrown = await new ResendEmailTransport(FAKE_API_KEY, 2_000)
      .send(EMAIL)
      .then(() => undefined, (error: unknown) => error);

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(PermanentTransportError);
  });

  it('fails transiently, never permanently, when the network itself fails', async () => {
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

    const thrown = await new ResendEmailTransport(FAKE_API_KEY, 2_000)
      .send(EMAIL)
      .then(() => undefined, (error: unknown) => error);

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(PermanentTransportError);
    keyNeverAppearsIn(thrown);
  });

  it('treats a malformed 200 body as transient — the SDK cannot tell it apart from a network failure', async () => {
    // Different from the hand-rolled client on purpose, not an oversight: the SDK's
    // `fetchRequest` wraps `await response.json()` in the *same* catch as the `fetch()` call
    // itself (verified by reading dist/index.mjs and by sending this exact malformed body
    // through the real SDK), so a malformed 200 body and a dropped connection are the same
    // `statusCode: null` outcome from here. Retrying costs nothing extra given
    // Idempotency-Key already makes a retry safe, and is honester than quietly treating an
    // unparseable "success" as one.
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{not json', { status: 200 })));

    const thrown = await new ResendEmailTransport(FAKE_API_KEY, 2_000)
      .send(EMAIL)
      .then(() => undefined, (error: unknown) => error);

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(PermanentTransportError);
    expect(warn).toHaveBeenCalled();
  });

  it("the outer catch is reachable, not decorative, and keeps the same .name-only discipline", async () => {
    // The one path that happens *before* the SDK's own safety net: `JSON.stringify` inside
    // its `post()`, called synchronously ahead of `fetchRequest`'s try/catch. A BigInt in the
    // headers a caller is not supposed to be able to construct (OutgoingEmail types headers
    // as strings) reaches it anyway if something upstream ever slipped past that type — this
    // proves ResendEmailTransport's own catch block still holds the line if it does.
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const tainted = { ...EMAIL, headers: { poisoned: 1n } } as unknown as OutgoingEmail;

    const thrown = await new ResendEmailTransport(FAKE_API_KEY, 2_000)
      .send(tainted)
      .then(() => undefined, (error: unknown) => error);

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(PermanentTransportError);
    expect((thrown as Error).message).toBe('resend request failed');
  });

  describe('the key never appears in any log or error', () => {
    it('not when the network fails', async () => {
      warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      // The SDK's own catch discards whatever `fetch` rejected with before this file's code
      // ever sees it (see resend.transport.ts's header) — this asserts the guarantee holds
      // end to end regardless of *why* it holds.
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error(`connect ECONNREFUSED, key was ${FAKE_API_KEY}`)));

      const thrown = await new ResendEmailTransport(FAKE_API_KEY, 2_000)
        .send(EMAIL)
        .then(() => undefined, (error: unknown) => error);

      keyNeverAppearsIn(thrown);
    });

    it('not when the response body is crafted to contain it', async () => {
      warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      // No real Resend error body has ever been observed to echo the key (see the header in
      // resend.transport.ts) — this manufactures the adversarial case anyway, because the
      // client's discipline should not depend on the provider continuing to behave, and
      // because it now runs through the real SDK's own JSON parsing rather than a hand-built
      // error object, so this also proves the SDK doesn't do anything surprising with it.
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          jsonResponse(403, {
            statusCode: 403,
            name: 'validation_error',
            message: `leaked marker, must never surface: ${FAKE_API_KEY}`,
          }),
        ),
      );

      const thrown = await new ResendEmailTransport(FAKE_API_KEY, 2_000)
        .send(EMAIL)
        .then(() => undefined, (error: unknown) => error);

      keyNeverAppearsIn(thrown);
    });
  });
});

describe('selecting the transport', () => {
  it('does not construct a Resend transport when configuration says file', () => {
    // The developer-with-no-Resend-account case the brief is built around: `file` is the
    // default, and nothing about a healthy boot should reach for RESEND_API_KEY.
    const transport = createEmailTransport(parseNotificationsConfig({ NODE_ENV: 'test' }));
    expect(transport).toBeInstanceOf(FileEmailTransport);
    expect(transport).not.toBeInstanceOf(ResendEmailTransport);
  });

  it('constructs Resend only once NOTIFICATIONS_EMAIL_TRANSPORT=resend opts in', () => {
    const transport = createEmailTransport(
      parseNotificationsConfig({
        NODE_ENV: 'test',
        NOTIFICATIONS_EMAIL_TRANSPORT: 'resend',
        RESEND_API_KEY: FAKE_API_KEY,
      }),
    );
    expect(transport).toBeInstanceOf(ResendEmailTransport);
    expect(transport.name).toBe('resend');
  });

  it('refuses to build a Resend transport from a config object with no key', () => {
    // `parseNotificationsConfig` already refuses this combination at boot (see
    // notifications.config.ts); this is the second guard, for a config assembled by hand.
    expect(() =>
      createEmailTransport({ emailTransport: 'resend', emailDir: '/tmp', resendApiKey: undefined, smtp: undefined as never }),
    ).toThrow(/RESEND_API_KEY/);
  });
});
