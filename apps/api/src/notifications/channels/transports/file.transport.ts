import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Logger } from '@nestjs/common';

import { serialiseEmail, type EmailTransport, type OutgoingEmail } from './email-transport';

/**
 * The transport that works on a laptop with nothing installed.
 *
 * `docker-compose.yml` runs Postgres and MinIO and no mail server, and adding one is not
 * this round's file to edit — so the local end-to-end path writes a real RFC 5322 message
 * to a directory and says where. That is a weaker claim than "it sends mail" and a much
 * stronger one than a stub that logs a line: the bytes written here are the bytes the SMTP
 * transport puts on the wire, produced by the same `serialiseEmail`, so opening one of
 * these files is a genuine check of the Thai encoding, the headers and the body — the parts
 * that are actually easy to get wrong.
 *
 * `parseNotificationsConfig` refuses this transport under `NODE_ENV=production`, so it
 * cannot be the thing a deployment forgot to change.
 *
 * ── The filename is part of the design ───────────────────────────────────────
 *
 * `<timestamp>-<notification id>.eml`. Sorted by time for a human scanning the directory,
 * and keyed by notification id so that a retry of the same message *overwrites* rather than
 * accumulating — which makes "was this sent twice?" answerable in a file listing, and keeps
 * the drop the same size as the outbox rather than the same size as the attempt log.
 */
export class FileEmailTransport implements EmailTransport {
  readonly name = 'file';
  private readonly logger = new Logger('FileEmailTransport');
  private announced = false;

  constructor(private readonly directory: string) {}

  async send(email: OutgoingEmail): Promise<string | undefined> {
    await mkdir(this.directory, { recursive: true });

    if (!this.announced) {
      // Once per process, at the first real send rather than at construction: a line in the
      // log that names an empty directory is a line nobody connects to the message they are
      // looking for.
      this.logger.log(`Email is being written to ${this.directory} — this transport does not send mail`);
      this.announced = true;
    }

    const path = join(this.directory, `${stamp(new Date())}-${email.messageId}.eml`);
    await writeFile(path, serialiseEmail(email, new Date()), 'utf8');

    // The path is the "provider message id": it is the answer to "what did we actually send
    // them", which is the column's whole purpose (plan 10.1).
    return path;
  }
}

/** `20260804T091500Z` — sortable, filename-safe, and unambiguous about the zone. */
function stamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}
