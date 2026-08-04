import { describe, expect, it } from 'vitest';

import type { RenderedMessage } from '../../src/notifications/channels/channel';
import { LineChannelAdapter } from '../../src/notifications/channels/line.channel';
import { parseNotificationsConfig } from '../../src/notifications/notifications.config';

/**
 * LINE — what can be proved without credentials, and a plain statement of what cannot.
 *
 * ── ⚠️ UNVERIFIED ────────────────────────────────────────────────────────────
 *
 * There are no LINE credentials in this repository. Nothing below has spoken to LINE. What
 * is asserted is the request this adapter *builds* and how it classifies each answer, against
 * an injected `fetch`. What is not asserted, and must be smoke-tested by whoever first sets
 * `NOTIFICATIONS_LINE_CHANNEL_ACCESS_TOKEN`:
 *
 *   - that the push endpoint and body shape still match LINE's current Messaging API;
 *   - that a `userId` from this app's LINE sign-in is a valid push target for *this* OA —
 *     it is not, unless the customer added the account as a friend (plan 10.2's funnel cost);
 *   - the real rate limits and what they answer with.
 *
 * ── AND IT IS UNREACHABLE TODAY, WHICH IS A DATABASE FACT ────────────────────
 *
 * `notification_rules` has no `line` rows (plan 13's channel question is unanswered), and
 * `order_events_fan_out_notifications()` resolves an address for `email` only — every other
 * channel is written as `suppressed` with `channel_disabled`. So no LINE row can currently
 * be produced for this adapter to deliver. Enabling the channel is a rule row, a recipient
 * resolution in that trigger, and this adapter registered by configuration; this module can
 * supply only the third. The test below is about the third.
 */

const MESSAGE: RenderedMessage = {
  recipientKey: 'line:U4af4980629',
  subject: 'ยืนยันการชำระเงินแล้ว',
  body: 'เรียน คุณสมชาย',
  locale: 'th',
  notificationId: '11111111-1111-4111-8111-111111111111',
  orderId: '22222222-2222-4222-8222-222222222222',
  eventId: '33333333-3333-4333-8333-333333333333',
};

const config = (token: string | undefined) =>
  parseNotificationsConfig({
    NODE_ENV: 'test',
    ...(token === undefined ? {} : { NOTIFICATIONS_LINE_CHANNEL_ACCESS_TOKEN: token }),
  });

function stubFetch(response: Response): { readonly fetch: typeof fetch; readonly calls: Request[] } {
  const calls: Request[] = [];
  // `Parameters<typeof fetch>` rather than `RequestInfo`: this package compiles with
  // `types: ["node"]` and no DOM library, so the global fetch types are Node's and
  // `RequestInfo` is not among the names they publish.
  const impl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    calls.push(new Request(input instanceof Request ? input : String(input), init));
    return response;
  }) as typeof fetch;

  return { fetch: impl, calls };
}

describe('LINE adapter', () => {
  it('builds a push with the retry key that keeps a timeout from becoming two messages', async () => {
    const stub = stubFetch(new Response('{}', { status: 200, headers: { 'x-line-request-id': 'req-1' } }));
    const adapter = new LineChannelAdapter(config('token'), stub.fetch);

    const result = await adapter.send(MESSAGE);

    expect(result).toStrictEqual({ ok: true, providerMessageId: 'req-1' });

    const request = stub.calls[0];
    expect(request?.url).toBe('https://api.line.me/v2/bot/message/push');
    expect(request?.headers.get('authorization')).toBe('Bearer token');
    /*
     * Plan 10.5(1) is "do not send twice". The unique constraint enforces that on our side;
     * this header is the same rule at the far end of the wire, where a retry after a
     * timeout — a push that may well have succeeded — would otherwise be a second message.
     */
    expect(request?.headers.get('x-line-retry-key')).toBe(MESSAGE.notificationId);

    const body = (await request?.json()) as { to: string; messages: { text: string }[] };
    expect(body.to).toBe('U4af4980629');
    // LINE has no subject line. Dropping it would silently lose the part of the message
    // written to be readable in a notification preview.
    expect(body.messages[0]?.text).toContain(MESSAGE.subject);
    expect(body.messages[0]?.text).toContain(MESSAGE.body);
  });

  it('retries a rate limit and an outage, and gives up on a bad recipient', async () => {
    const adapter = (status: number, text = '{}') =>
      new LineChannelAdapter(config('token'), stubFetch(new Response(text, { status })).fetch);

    // 429 and 5xx come back — LINE having a bad afternoon must not lose a message.
    expect(await adapter(429).send(MESSAGE)).toMatchObject({ ok: false, retryable: true });
    expect(await adapter(503).send(MESSAGE)).toMatchObject({ ok: false, retryable: true });

    // A 4xx that is neither means this message is wrong — an unknown user id, or a customer
    // who never added the OA as a friend — and it will be wrong on the fifth attempt too.
    // That belongs in the dead queue now, not in a quarter of an hour.
    expect(await adapter(400, '{"message":"Invalid to"}').send(MESSAGE)).toMatchObject({
      ok: false,
      retryable: false,
    });
    expect(await adapter(403).send(MESSAGE)).toMatchObject({ ok: false, retryable: false });
  });

  it('treats a network failure as transient', async () => {
    const failing = (async () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND api.line.me'), { code: 'ENOTFOUND' });
    }) as typeof fetch;

    const result = await new LineChannelAdapter(config('token'), failing).send(MESSAGE);

    expect(result).toMatchObject({ ok: false, retryable: true });
    if (result.ok) return;
    expect(result.error).toContain('ENOTFOUND');
  });

  it('claims no support without a token, so the worker reports a configuration problem', async () => {
    // The worker distinguishes "no adapter that can address this" — permanent, and it names
    // the channel in the dead queue — from "the adapter tried and failed". A LINE row in a
    // build with no token must land in the first category, not burn five attempts.
    const adapter = new LineChannelAdapter(config(undefined));

    expect(adapter.supports('line:U4af4980629')).toBe(false);
    expect(await adapter.send(MESSAGE)).toMatchObject({ ok: false, retryable: false });
  });

  it('does not claim recipient keys belonging to another channel', () => {
    const adapter = new LineChannelAdapter(config('token'));

    expect(adapter.supports('line:U4af4980629')).toBe(true);
    expect(adapter.supports('email:a@b.test')).toBe(false);
    expect(adapter.supports('group:sales_queue')).toBe(false);
  });
});
