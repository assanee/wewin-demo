import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { EmailChannelAdapter } from '../../src/notifications/channels/email.channel';
import {
  PermanentTransportError,
  serialiseEmail,
  type EmailTransport,
  type OutgoingEmail,
} from '../../src/notifications/channels/transports/email-transport';
import { FileEmailTransport } from '../../src/notifications/channels/transports/file.transport';
import { maskRecipientKey } from '../../src/notifications/notifications.contract';
import { parseNotificationsConfig, type NotificationsConfig } from '../../src/notifications/notifications.config';
import type { RenderedMessage } from '../../src/notifications/channels/channel';

/**
 * Email: the message on the wire, the local transport, and how a failure is classified.
 *
 * The classification assertions are the load-bearing ones. Getting retryable/permanent
 * backwards is invisible in both directions until it matters: a permanent failure retried
 * five times delays the dead queue by a quarter of an hour, during which the company
 * believes the customer was told (plan 10.5(3)); a transient one treated as permanent
 * throws a message away because a mail server was busy for a second.
 */

const MESSAGE: RenderedMessage = {
  recipientKey: 'email:somchai@example.com',
  subject: 'ยืนยันการชำระเงินแล้ว — ใบสั่งซื้อเลขที่ 25-000123',
  body: 'เรียน คุณสมชาย\n\nเราตรวจสอบและยืนยันการชำระเงินของท่านแล้ว',
  locale: 'th',
  notificationId: '11111111-1111-4111-8111-111111111111',
  orderId: '22222222-2222-4222-8222-222222222222',
  eventId: '33333333-3333-4333-8333-333333333333',
};

const OUTGOING: OutgoingEmail = {
  from: 'wewin <no-reply@wewin.local>',
  to: 'somchai@example.com',
  subject: MESSAGE.subject,
  body: MESSAGE.body,
  messageId: MESSAGE.notificationId,
  headers: { 'X-Wewin-Order': MESSAGE.orderId },
};

const config = (overrides: Record<string, string | undefined> = {}): NotificationsConfig =>
  parseNotificationsConfig({ NODE_ENV: 'test', ...overrides });

class StubTransport implements EmailTransport {
  readonly name = 'stub';
  readonly sent: OutgoingEmail[] = [];

  constructor(private readonly outcome: 'ok' | Error = 'ok') {}

  async send(email: OutgoingEmail): Promise<string | undefined> {
    if (this.outcome !== 'ok') throw this.outcome;
    this.sent.push(email);
    return 'stub-id';
  }
}

describe('the message on the wire', () => {
  it('encodes a Thai subject rather than putting UTF-8 bytes in a header', () => {
    const wire = serialiseEmail(OUTGOING, new Date('2026-08-04T09:15:00Z'));

    // RFC 2047 encoded-word. Without it the subject is mojibake in a large share of clients
    // — and it is the *only* part of a notification most recipients read before deciding
    // whether to open it.
    expect(wire).toContain('Subject: =?UTF-8?B?');
    expect(wire).not.toContain(MESSAGE.subject);
  });

  it('keeps the address routable while encoding the display name', () => {
    const wire = serialiseEmail({ ...OUTGOING, from: 'วีวิน <no-reply@wewin.local>' }, new Date());

    // The obvious one-line version of the header encoder base64s the whole value and
    // produces a `From:` no MTA can route.
    expect(wire).toContain('<no-reply@wewin.local>');
    expect(wire).toMatch(/From: =\?UTF-8\?B\?[^?]+\?= <no-reply@wewin\.local>/);
  });

  it('base64s the body, so no line can end the DATA phase early', () => {
    const wire = serialiseEmail({ ...OUTGOING, body: 'first\n.\nlast' }, new Date());

    expect(wire).toContain('Content-Transfer-Encoding: base64');
    // A bare `.` on its own line terminates SMTP DATA: a server that saw one would accept a
    // truncated message and answer 250, which is a silent data-loss bug with a success code.
    expect(wire.split('\r\n\r\n')[1] ?? '').not.toMatch(/^\.$/m);

    const body = Buffer.from((wire.split('\r\n\r\n')[1] ?? '').replace(/\r\n/g, ''), 'base64').toString('utf8');
    expect(body).toBe('first\n.\nlast');
  });

  it('carries the ids that make a mailbox message traceable back to its event', () => {
    const wire = serialiseEmail(OUTGOING, new Date());

    expect(wire).toContain(`Message-ID: <${MESSAGE.notificationId}@wewin>`);
    expect(wire).toContain(`X-Wewin-Order: ${MESSAGE.orderId}`);
  });
});

describe('the file transport', () => {
  it('writes a real message and reports where it put it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wewin-mail-test-'));
    const transport = new FileEmailTransport(directory);

    const path = await transport.send(OUTGOING);

    expect(path).toBeDefined();
    const files = await readdir(directory);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain(MESSAGE.notificationId);

    const contents = await readFile(join(directory, files[0] ?? ''), 'utf8');
    expect(contents).toContain('To: somchai@example.com');
  });

  it('overwrites on a retry instead of accumulating', async () => {
    // The filename is keyed by notification id on purpose: the drop stays the size of the
    // outbox rather than the size of the attempt log, and "was this sent twice?" is
    // answerable from a directory listing.
    const directory = await mkdtemp(join(tmpdir(), 'wewin-mail-test-'));
    const transport = new FileEmailTransport(directory);

    await transport.send(OUTGOING);
    await transport.send(OUTGOING);

    expect(await readdir(directory)).toHaveLength(1);
  });
});

describe('the email adapter', () => {
  it('sends to a customer address and reports the provider id', async () => {
    const transport = new StubTransport();
    const adapter = new EmailChannelAdapter(config(), transport);

    const result = await adapter.send(MESSAGE);

    expect(result).toStrictEqual({ ok: true, providerMessageId: 'stub-id' });
    expect(transport.sent[0]?.to).toBe('somchai@example.com');
    expect(transport.sent[0]?.headers['Content-Language']).toBe('th');
    // A notice, not a conversation: without this, an out-of-office reply comes back to a
    // mailbox nobody reads and, on some providers, loops.
    expect(transport.sent[0]?.headers['Auto-Submitted']).toBe('auto-generated');
  });

  it('resolves a work queue from configuration', async () => {
    // The fan-out writes `group:sales_queue` because at the moment the event commits nobody
    // knows which human is on shift — that is a deployment fact, not an order fact.
    const transport = new StubTransport();
    const adapter = new EmailChannelAdapter(config({ NOTIFICATIONS_SALES_QUEUE_EMAIL: 'sales@example.com' }), transport);

    await adapter.send({ ...MESSAGE, recipientKey: 'group:sales_queue' });

    expect(transport.sent[0]?.to).toBe('sales@example.com');
  });

  it('fails an unconfigured queue permanently, naming the variable', async () => {
    /*
     * Retrying this five times would be four extra failures against a fact that cannot
     * change without a deploy — and a quarter of an hour during which nothing is in the
     * dead queue and nobody knows sales was never told. The message names the variable so
     * the person reading the queue can fix it without reading this file.
     *
     * `NODE_ENV=production` is how the local fallback is removed; the fallback is what
     * makes a fresh checkout work and is exactly what must not exist here.
     */
    const adapter = new EmailChannelAdapter(
      {
        ...config(),
        queueAddresses: { sales_queue: undefined, approver_queue: undefined },
      },
      new StubTransport(),
    );

    const result = await adapter.send({ ...MESSAGE, recipientKey: 'group:sales_queue' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.retryable).toBe(false);
    expect(result.error).toContain('NOTIFICATIONS_SALES_QUEUE_EMAIL');
  });

  it('treats a rejected message as permanent and a broken socket as transient', async () => {
    const permanent = new EmailChannelAdapter(
      config(),
      new StubTransport(new PermanentTransportError('SMTP RCPT rejected: 550 no such user')),
    );
    const transient = new EmailChannelAdapter(config(), new StubTransport(new Error('connect ECONNREFUSED')));

    const rejected = await permanent.send(MESSAGE);
    const refused = await transient.send(MESSAGE);

    expect(rejected).toMatchObject({ ok: false, retryable: false });
    // The outbox exists so that a mail server having a bad afternoon does not lose a
    // message (plan 10.1). Marking this permanent would throw the message away.
    expect(refused).toMatchObject({ ok: false, retryable: true });
  });

  it('does not claim to support a channel it cannot address', async () => {
    const adapter = new EmailChannelAdapter(config(), new StubTransport());

    expect(adapter.supports('email:a@b.test')).toBe(true);
    expect(adapter.supports('group:sales_queue')).toBe(true);
    // The worker uses this to tell "no adapter for this channel" (a configuration problem,
    // permanent) from "the adapter tried and failed" (usually transient).
    expect(adapter.supports('line:U1234')).toBe(false);
    expect(adapter.supports('nonsense')).toBe(false);
  });
});

describe('the dead queue redacts what it does not need to show', () => {
  it('masks a customer address and leaves a work queue alone', () => {
    // Deciding whether to retry needs to know which *kind* of address failed, not what it
    // was. Plan 7.6 draws the same line for payment slips: viewing is not downloading.
    expect(maskRecipientKey('email:somchai@example.com')).toBe('email:s•••@example.com');
    expect(maskRecipientKey('group:sales_queue')).toBe('group:sales_queue');
    expect(maskRecipientKey(null)).toBeNull();
    expect(maskRecipientKey('email:broken')).toBe('email:•••');
  });
});
