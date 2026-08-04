import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

import type { SmtpSettings } from '../../notifications.config';
import { PermanentTransportError, serialiseEmail, type EmailTransport, type OutgoingEmail } from './email-transport';

/**
 * SMTP, by hand, in the subset a notification needs.
 *
 * ── ⚠️ WHAT IS AND IS NOT VERIFIED ───────────────────────────────────────────
 *
 * `tests/notifications/smtp.test.ts` drives this against a real server socket speaking the
 * real protocol — greeting, EHLO, AUTH PLAIN, MAIL/RCPT/DATA, dot-stuffing, and each of the
 * three failure shapes. That proves the client's half of the conversation.
 *
 * It has **not** been run against a real MTA, and there is no mail server in this
 * repository's `docker-compose.yml` to run it against. What that leaves unproven is the
 * behaviour of a real server's extensions — SIZE limits, 8BITMIME negotiation, greylisting
 * that answers `451` and expects a later retry (which this design handles, because the
 * outbox retries), and anything an ISP does to unauthenticated senders. Treat the local
 * default (`file`) as the verified path and this as the one that needs a smoke test on the
 * first deployment that turns it on.
 *
 * ── Two things deliberately not implemented ──────────────────────────────────
 *
 * **STARTTLS.** Upgrading a live socket and re-issuing EHLO is where a hand-written client
 * gets subtly wrong in the direction of "it worked, and it was in the clear". Implicit TLS
 * (`NOTIFICATIONS_SMTP_SECURE=true`, the port-465 style) is one `tls.connect` and has no
 * downgrade step to get wrong, and `parseNotificationsConfig` refuses a production
 * configuration that would send a password over a plaintext socket.
 *
 * **Pipelining.** One command, one response. A notification worker sends a handful of
 * messages a minute; the round trips cost nothing and the lockstep is what makes the error
 * messages name the command that actually failed.
 */
export class SmtpEmailTransport implements EmailTransport {
  readonly name = 'smtp';

  constructor(
    private readonly settings: SmtpSettings,
    /** Overridden in tests so a hostile server can be reached without waiting two minutes. */
    private readonly timeoutMs = 20_000,
  ) {}

  async send(email: OutgoingEmail): Promise<string | undefined> {
    const session = await SmtpSession.open(this.settings, this.timeoutMs);
    try {
      await session.expect([220]);
      await session.command(`EHLO ${clientName()}`, [250]);

      if (this.settings.user !== undefined && this.settings.password !== undefined) {
        // AUTH PLAIN: \0user\0password, base64. The only mechanism implemented, because it
        // is the one every server supports and the one whose failure mode is a clear 535.
        const secret = Buffer.from(`\0${this.settings.user}\0${this.settings.password}`, 'utf8').toString('base64');
        await session.command(`AUTH PLAIN ${secret}`, [235], 'AUTH PLAIN');
      }

      await session.command(`MAIL FROM:<${bareAddress(email.from)}>`, [250]);
      await session.command(`RCPT TO:<${bareAddress(email.to)}>`, [250, 251]);
      await session.command('DATA', [354]);

      // Dot-stuffing, and it is not optional: a body line consisting of a single '.' ends
      // DATA early, so the server accepts a truncated message and answers 250. The body is
      // base64 here so no such line can occur — this is the belt to that braces, and it
      // stays correct if the serialiser ever stops encoding.
      const wire = serialiseEmail(email, new Date()).replace(/\r\n\./g, '\r\n..');
      const accepted = await session.command(`${wire}\r\n.`, [250], 'DATA payload');

      await session.command('QUIT', [221]).catch(() => undefined); // The message is already accepted.
      return accepted;
    } finally {
      session.destroy();
    }
  }
}

/** The name in EHLO. Not load-bearing for delivery; servers log it, so it should be honest. */
function clientName(): string {
  return process.env['NOTIFICATIONS_SMTP_CLIENT_NAME'] ?? 'wewin-api';
}

/** `wewin <no-reply@wewin.local>` → `no-reply@wewin.local`. The envelope takes the address only. */
function bareAddress(value: string): string {
  const match = /<([^<>]+)>/.exec(value);
  return (match?.[1] ?? value).trim();
}

/**
 * One connection, one message.
 *
 * No pooling and no reuse. A worker batch is tens of messages, a connection costs a few
 * milliseconds, and a pooled SMTP connection that has gone stale fails on the *next*
 * message rather than the one that broke it — which is a debugging experience nobody
 * should be given in exchange for that few milliseconds.
 */
class SmtpSession {
  private buffer = '';
  private pending: { resolve: (value: string) => void; reject: (error: Error) => void } | undefined;
  private failure: Error | undefined;

  private constructor(private readonly socket: Socket) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      this.drain();
    });
    socket.on('error', (error: Error) => this.fail(error));
    // A server that hangs up mid-conversation is a failure, not an end of stream: without
    // this the next `expect` waits for the full timeout and reports the wrong cause.
    socket.on('close', () => this.fail(new Error('SMTP connection closed by the server')));
  }

  static async open(settings: SmtpSettings, timeoutMs: number): Promise<SmtpSession> {
    const socket = settings.secure
      ? tlsConnect({ host: settings.host, port: settings.port, servername: settings.host })
      : netConnect({ host: settings.host, port: settings.port });

    socket.setTimeout(timeoutMs, () => socket.destroy(new Error(`SMTP timeout after ${timeoutMs}ms`)));

    await new Promise<void>((resolve, reject) => {
      const onReady = (): void => {
        socket.off('error', onError);
        resolve();
      };
      const onError = (error: Error): void => {
        socket.off('secureConnect', onReady);
        socket.off('connect', onReady);
        reject(error);
      };
      socket.once(settings.secure ? 'secureConnect' : 'connect', onReady);
      socket.once('error', onError);
    });

    return new SmtpSession(socket);
  }

  /**
   * Sends a command and asserts the reply code.
   *
   * The classification lives here and nowhere else: **5xx is permanent, everything else is
   * transient**. That is the SMTP contract — 4xx means "not now" and is what greylisting and
   * a full mailbox answer, 5xx means "not ever" for this message. Getting it backwards in
   * either direction is expensive: a permanent failure retried five times delays the dead
   * queue by a quarter of an hour (plan 10.5(3)), and a transient one treated as permanent
   * throws away a message because a server was busy.
   */
  async command(line: string, accepted: readonly number[], label = line.split(' ')[0] ?? line): Promise<string> {
    this.write(`${line}\r\n`);
    return this.expect(accepted, label);
  }

  async expect(accepted: readonly number[], label = 'greeting'): Promise<string> {
    const reply = await this.read();
    const code = Number.parseInt(reply.slice(0, 3), 10);

    if (accepted.includes(code)) return reply.trim();

    const message = `SMTP ${label} rejected: ${reply.trim()}`;
    if (code >= 500 && code < 600) throw new PermanentTransportError(message);
    throw new Error(message);
  }

  destroy(): void {
    this.socket.destroy();
  }

  private write(data: string): void {
    if (this.failure) throw this.failure;
    this.socket.write(data);
  }

  private read(): Promise<string> {
    if (this.failure) return Promise.reject(this.failure);

    return new Promise<string>((resolve, reject) => {
      this.pending = { resolve, reject };
      this.drain();
    });
  }

  /**
   * A reply is complete when a line reads `NNN<space>` — `NNN-` continues it.
   *
   * Multi-line is the normal case, not an edge case: every EHLO answer is one, and a reader
   * that stops at the first newline goes out of step with the server for the rest of the
   * session and blames whichever command happens to be next.
   */
  private drain(): void {
    if (this.pending === undefined) return;

    const lines = this.buffer.split('\r\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line === undefined || line.length < 4) continue;
      if (line[3] !== ' ') continue;

      const consumed = lines.slice(0, index + 1).join('\r\n');
      this.buffer = this.buffer.slice(consumed.length + 2);
      const pending = this.pending;
      this.pending = undefined;
      pending.resolve(consumed);
      return;
    }
  }

  private fail(error: Error): void {
    this.failure ??= error;
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(this.failure);
  }
}
