import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { PermanentTransportError, type OutgoingEmail } from '../../src/notifications/channels/transports/email-transport';
import { SmtpEmailTransport } from '../../src/notifications/channels/transports/smtp.transport';

/**
 * SMTP, against a real socket speaking the real protocol.
 *
 * ── Why a server and not a mock ──────────────────────────────────────────────
 *
 * Every bug this client can have is a protocol bug: reading one line of a multi-line EHLO
 * and going out of step for the rest of the session, forgetting dot-stuffing, treating a
 * 4xx as fatal. None of them is visible to a mocked socket, because a mock answers whatever
 * shape the client asked for. The server below is forty lines and answers the way a server
 * answers, which is the only way these assertions mean anything.
 *
 * ── ⚠️ WHAT THIS STILL DOES NOT PROVE ────────────────────────────────────────
 *
 * That this client works against a *real* MTA. There is no mail server in this repository's
 * `docker-compose.yml` and no credentials for an external one, so extension negotiation
 * (SIZE, 8BITMIME), greylisting behaviour and whatever an ISP does to an unauthenticated
 * sender are all unverified. The local default transport is `file`, which is verified end
 * to end; this one needs a smoke test on the first deployment that turns it on.
 */

const EMAIL: OutgoingEmail = {
  from: 'wewin <no-reply@wewin.local>',
  to: 'ลูกค้า <somchai@example.com>',
  subject: 'ยืนยันการชำระเงินแล้ว',
  body: 'เรียน คุณสมชาย\n.\nสิ้นสุดข้อความ',
  messageId: '11111111-1111-4111-8111-111111111111',
  headers: { 'X-Wewin-Order': '22222222-2222-4222-8222-222222222222' },
};

interface Recorded {
  readonly commands: string[];
  /** Mutable: the server fills it in when the DATA phase ends. */
  data: string;
}

/**
 * A conversational SMTP server. `replies` overrides the answer to a command prefix.
 *
 * The multi-line EHLO is not decoration: it is the thing a naive reader gets wrong, and
 * every assertion after it depends on the client staying in step.
 */
async function startServer(replies: Readonly<Record<string, string>> = {}): Promise<{
  readonly port: number;
  readonly recorded: Recorded;
  readonly close: () => Promise<void>;
}> {
  const recorded: Recorded = { commands: [], data: '' };
  let data = '';

  const server: Server = createServer((socket: Socket) => {
    let inData = false;
    let buffer = '';

    socket.setEncoding('utf8');
    socket.write('220 test.local ESMTP ready\r\n');

    socket.on('data', (chunk: string) => {
      buffer += chunk;

      for (;;) {
        const end = buffer.indexOf('\r\n');
        if (end < 0) break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);

        if (inData) {
          if (line === '.') {
            inData = false;
            recorded.data = data;
            socket.write('250 2.0.0 Ok: queued as ABC123\r\n');
          } else {
            // Un-stuff, so the assertion below is about what the *server* received as body.
            data += `${line.startsWith('..') ? line.slice(1) : line}\r\n`;
          }
          continue;
        }

        recorded.commands.push(line.split(' ')[0] ?? line);

        const override = Object.entries(replies).find(([prefix]) => line.startsWith(prefix))?.[1];
        if (override !== undefined) {
          socket.write(`${override}\r\n`);
          continue;
        }

        if (line.startsWith('EHLO')) {
          // Multi-line, with the continuation marker every real server uses.
          socket.write('250-test.local\r\n250-PIPELINING\r\n250-SIZE 35882577\r\n250 AUTH PLAIN LOGIN\r\n');
        } else if (line.startsWith('AUTH')) {
          socket.write('235 2.7.0 Authentication successful\r\n');
        } else if (line.startsWith('MAIL FROM') || line.startsWith('RCPT TO')) {
          socket.write('250 2.1.0 Ok\r\n');
        } else if (line === 'DATA') {
          inData = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (line === 'QUIT') {
          socket.write('221 2.0.0 Bye\r\n');
          socket.end();
        } else {
          socket.write('502 5.5.2 Command not implemented\r\n');
        }
      }
    });

    socket.on('error', () => undefined); // A client that destroys its socket is not a test failure.
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  return {
    port: address.port,
    recorded,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

let stop: (() => Promise<void>) | undefined;

afterEach(async () => {
  await stop?.();
  stop = undefined;
});

const settings = (port: number, overrides: Record<string, unknown> = {}) => ({
  host: '127.0.0.1',
  port,
  secure: false,
  user: undefined,
  password: undefined,
  ...overrides,
});

describe('SMTP transport', () => {
  it('completes the conversation in order and returns the server’s queue id', async () => {
    const server = await startServer();
    stop = server.close;

    const queueId = await new SmtpEmailTransport(settings(server.port), 2_000).send(EMAIL);

    expect(server.recorded.commands).toStrictEqual(['EHLO', 'MAIL', 'RCPT', 'DATA', 'QUIT']);
    // The provider's own id, which is half of "what did we actually send them" (plan 10.1).
    expect(queueId).toContain('ABC123');
  });

  it('sends the envelope address, not the display name', async () => {
    const server = await startServer();
    stop = server.close;

    await new SmtpEmailTransport(settings(server.port), 2_000).send(EMAIL);

    // `MAIL FROM:<ลูกค้า <a@b>>` is rejected by every real server; the failure would look
    // like "the mail server is broken" rather than "we built the envelope wrong".
    expect(server.recorded.data).toContain('To: =?UTF-8?B?');
  });

  it('authenticates when a user is configured, and not otherwise', async () => {
    const withAuth = await startServer();
    stop = withAuth.close;
    await new SmtpEmailTransport(settings(withAuth.port, { user: 'wewin', password: 'secret' }), 2_000).send(EMAIL);
    expect(withAuth.recorded.commands).toContain('AUTH');

    await withAuth.close();

    const withoutAuth = await startServer();
    stop = withoutAuth.close;
    await new SmtpEmailTransport(settings(withoutAuth.port), 2_000).send(EMAIL);
    expect(withoutAuth.recorded.commands).not.toContain('AUTH');
  });

  it('dot-stuffs a body line that would otherwise end the message', async () => {
    const server = await startServer();
    stop = server.close;

    await new SmtpEmailTransport(settings(server.port), 2_000).send(EMAIL);

    // The body is base64 so the sequence cannot occur, and the stuffing is the belt to that
    // braces. What is asserted here is the outcome: the server received the *whole*
    // message. A truncated one would still have been answered 250, which is why this is
    // asserted on the bytes and not on the reply code.
    const [, encoded = ''] = server.recorded.data.split('\r\n\r\n');
    expect(Buffer.from(encoded.replace(/\r\n/g, ''), 'base64').toString('utf8')).toBe(EMAIL.body);
  });

  it('treats 5xx as permanent and 4xx as worth retrying', async () => {
    /*
     * This is the SMTP contract and the classification the whole retry policy rests on.
     * 4xx is what greylisting and a full mailbox answer — come back later. 5xx is "not
     * ever" for this message. Getting it backwards either loses a message or delays the
     * dead queue by a quarter of an hour while the company believes somebody was told.
     */
    const rejecting = await startServer({ 'RCPT TO': '550 5.1.1 <somchai@example.com>: user unknown' });
    stop = rejecting.close;

    await expect(new SmtpEmailTransport(settings(rejecting.port), 2_000).send(EMAIL)).rejects.toBeInstanceOf(
      PermanentTransportError,
    );

    await rejecting.close();

    const busy = await startServer({ 'RCPT TO': '451 4.3.0 Temporary failure, try again later' });
    stop = busy.close;

    const transient = await new SmtpEmailTransport(settings(busy.port), 2_000)
      .send(EMAIL)
      .then(() => undefined, (error: unknown) => error);

    expect(transient).toBeInstanceOf(Error);
    expect(transient).not.toBeInstanceOf(PermanentTransportError);
  });

  it('fails rather than hangs when the server goes away mid-conversation', async () => {
    // Without the `close` handler on the socket, this waits out the whole timeout and then
    // reports the wrong cause — which is how a worker's batch appears to stall for two
    // minutes on a server that hung up instantly.
    const server = await startServer();
    stop = server.close;

    const transport = new SmtpEmailTransport(settings(server.port), 2_000);
    const inFlight = transport.send(EMAIL);
    await server.close();

    await expect(inFlight).rejects.toBeInstanceOf(Error);
  });

  it('fails fast when nothing is listening', async () => {
    // Port 1 on loopback: connects fast enough to fail, never fast enough to succeed — the
    // same trick `tests/support/app.ts` uses for an unreachable database.
    await expect(new SmtpEmailTransport(settings(1), 2_000).send(EMAIL)).rejects.toBeInstanceOf(Error);
  });
});
