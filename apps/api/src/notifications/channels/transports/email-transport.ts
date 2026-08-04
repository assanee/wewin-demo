/**
 * One rendered email, and the two ways this process can put one somewhere.
 *
 * The transport is a seam *inside* the email adapter rather than a second channel, because
 * a file drop and an SMTP conversation deliver the same message to the same address with
 * the same failure semantics — only the wire differs. Making them channels would give
 * `notification_rules` a row per wire, and "which transport" is a deployment fact, not a
 * business rule about who hears what.
 */

export interface OutgoingEmail {
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  /**
   * Becomes `Message-ID`, so a retry of the same notification is recognisable as the same
   * message by anything that threads. The notification id is the right value: it is stable
   * across attempts and it is what the dead queue shows.
   */
  readonly messageId: string;
  /** `X-Wewin-*` diagnostics, so a message found in a mailbox can be traced back to its event. */
  readonly headers: Readonly<Record<string, string>>;
}

export interface EmailTransport {
  /** A word for the log and for the attempt record: `file`, `smtp`. */
  readonly name: string;
  /**
   * Resolves with the provider's id when there is one, or `undefined`.
   *
   * Throws on failure — classification into retryable/permanent happens in the adapter, in
   * one place, so a second transport cannot invent its own idea of what is worth retrying.
   */
  send(email: OutgoingEmail): Promise<string | undefined>;
}

/**
 * A failure the adapter must not retry: the message will be rejected the same way forever.
 *
 * Thrown by a transport when the *server* said no in a way that is about this message —
 * SMTP 5xx, a mailbox that does not exist — as opposed to a socket that would not open.
 */
export class PermanentTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentTransportError';
  }
}

/**
 * RFC 5322, the small subset a notification needs.
 *
 * Written by hand, and it is worth saying why rather than reaching for a library: this app
 * has no mail dependency, `apps/api/package.json` is not this round's file to change, and
 * the subset is genuinely small — no attachments, no alternatives, one text part. What the
 * subset does *not* skip is encoding, because the entire message is Thai: a naive writer
 * would put UTF-8 bytes straight into a header and produce a subject that reads as mojibake
 * in half the clients that receive it.
 *
 * Two encodings, for the two halves:
 *
 *   headers — RFC 2047 encoded-word, base64, one per header. Chosen over quoted-printable
 *     because every Thai character would be three `=XX` escapes and the result is longer
 *     than the base64 of the same bytes.
 *   body    — base64 with `Content-Transfer-Encoding: base64`, so no line in the body can
 *     exceed the 998-octet limit and no `\n.` sequence can end the DATA phase early. That
 *     second one is not theoretical: a body containing a line that is exactly `.` is how a
 *     hand-rolled SMTP client truncates a message and reports success.
 */
export function serialiseEmail(email: OutgoingEmail, date: Date): string {
  const headers: string[] = [
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${email.messageId}@wewin>`,
    `From: ${encodeHeaderValue(email.from)}`,
    `To: ${encodeHeaderValue(email.to)}`,
    `Subject: ${encodeHeaderValue(email.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
  ];

  for (const [name, value] of Object.entries(email.headers)) {
    headers.push(`${name}: ${encodeHeaderValue(value)}`);
  }

  return `${headers.join('\r\n')}\r\n\r\n${wrap(Buffer.from(email.body, 'utf8').toString('base64'))}\r\n`;
}

/**
 * An address like `wewin <no-reply@wewin.local>` keeps its structure; only a non-ASCII
 * display name is encoded. Encoding the whole thing would produce a `To:` header no MTA
 * can route, which is the failure mode of the obvious one-line version of this function.
 */
function encodeHeaderValue(value: string): string {
  const match = /^(.*?)\s*<([^<>]+)>$/.exec(value);
  if (match) {
    const [, display = '', addressPart = ''] = match;
    return display.length === 0 ? `<${addressPart}>` : `${encodeWord(display)} <${addressPart}>`;
  }
  return encodeWord(value);
}

function encodeWord(value: string): string {
  // eslint-disable-next-line no-control-regex -- the point is to detect anything a header cannot carry raw.
  if (!/[^\x20-\x7e]/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/** 76 columns, the MIME limit for base64. */
function wrap(base64: string): string {
  const lines: string[] = [];
  for (let index = 0; index < base64.length; index += 76) {
    lines.push(base64.slice(index, index + 76));
  }
  return lines.join('\r\n');
}
