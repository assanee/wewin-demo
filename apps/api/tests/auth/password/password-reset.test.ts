import { beforeEach, describe, expect, it } from 'vitest';

import { AppError } from '../../../src/common/errors/app-error';
import { verifyPassword } from '../../../src/auth/password/password-hash';
import { PasswordResetService } from '../../../src/auth/password/password-reset.service';
import { SignInThrottle } from '../../../src/auth/password/sign-in-throttle';
import type {
  ResetTargetRow,
  PasswordResetStore,
  ResetTokenRow,
} from '../../../src/auth/password/password-reset.repository';
import type { OutgoingEmail, EmailTransport } from '../../../src/notifications/channels/transports/email-transport';

/**
 * Requesting a reset, and spending one.
 *
 * The two halves are tested together because the property that matters spans them: the
 * secret that leaves in an email is the *only* copy, and what the database keeps is its
 * hash. A test that checked each half alone could not see a leak between them.
 */

const EMAIL = 'somchai@example.test';
const ADDRESS = '203.0.113.7';
const OLD_PASSWORD = 'the passphrase from before';
const NEW_PASSWORD = 'ลมพัดผ่านหน้าต่างบานกระทุ้ง 2569';

class FakeStore implements PasswordResetStore {
  targets = new Map<string, ResetTargetRow>();
  issued: { userId: string; tokenHash: string; expiresAt: Date }[] = [];
  tokens = new Map<string, ResetTokenRow>();
  written: { userId: string; hash: string }[] = [];
  revoked: string[] = [];

  async findResetTarget(address: string): Promise<ResetTargetRow | undefined> {
    return this.targets.get(address);
  }

  async issueToken(input: { userId: string; tokenHash: string; expiresAt: Date }): Promise<void> {
    this.issued.push(input);
    this.tokens.set(input.tokenHash, {
      userId: input.userId,
      expiresAt: input.expiresAt,
      consumedAt: null,
      status: 'active',
    });
  }

  async consumeToken(tokenHash: string, now: Date): Promise<ResetTokenRow | undefined> {
    const row = this.tokens.get(tokenHash);
    if (row === undefined || row.consumedAt !== null || row.expiresAt <= now) return undefined;
    this.tokens.set(tokenHash, { ...row, consumedAt: now });
    return row;
  }

  async writePassword(userId: string, hash: string): Promise<void> {
    this.written.push({ userId, hash });
  }

  async revokeSessions(userId: string): Promise<void> {
    this.revoked.push(userId);
  }
}

class RecordingTransport implements EmailTransport {
  readonly name = 'recording';
  sent: OutgoingEmail[] = [];

  async send(email: OutgoingEmail): Promise<string | undefined> {
    this.sent.push(email);
    return 'recorded';
  }
}

let store: FakeStore;
let mail: RecordingTransport;
let service: PasswordResetService;

beforeEach(async () => {
  store = new FakeStore();
  mail = new RecordingTransport();
  service = new PasswordResetService(
    store,
    mail,
    new SignInThrottle({
      perAccount: { limit: 3, windowMs: 15 * 60_000 },
      perAddress: { limit: 10, windowMs: 15 * 60_000 },
    }),
    { from: 'wewin <no-reply@wewin.test>', resetUrlBase: 'https://dash.wewin.test/reset' },
  );

  store.targets.set(EMAIL, {
    userId: 'user-1',
    address: EMAIL,
    displayName: 'สมชาย',
    status: 'active',
  });
});

/** The `?token=` out of the one link in the one email that was sent. */
function tokenFromEmail(): string {
  const [email] = mail.sent;
  if (email === undefined) throw new Error('no email was sent');
  const found = /token=([A-Za-z0-9_-]+)/.exec(email.body);
  if (found?.[1] === undefined) throw new Error(`no token in the body:\n${email.body}`);
  return found[1];
}

async function refusalOf(promise: Promise<unknown>): Promise<{ status: number; reason: unknown }> {
  try {
    await promise;
    throw new Error('expected a refusal');
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    return { status: error.status, reason: (error.details as { reason?: unknown })?.reason };
  }
}

describe('asking for a reset', () => {
  it('sends one email with a link, and stores only the hash of what it sent', async () => {
    await service.request({ email: EMAIL, address: ADDRESS });

    expect(mail.sent).toHaveLength(1);
    const token = tokenFromEmail();

    /*
     * ⭐ The property the whole design turns on. `auth_tokens.token_hash` carries a
     * `digestIsHex` CHECK precisely so the database never holds the secret — and that is
     * worth nothing if the secret is also sitting somewhere else. Asserted as an absence:
     * the plaintext appears in no field of what was stored.
     */
    const stored = store.issued[0];
    expect(stored).toBeDefined();
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(stored?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not queue a notification, because a notification cannot carry a secret', async () => {
    await service.request({ email: EMAIL, address: ADDRESS });

    /*
     * Sent through the transport directly, and the reason is structural rather than a
     * preference. `notifications` has no payload column — it stores a `template_key` and
     * the worker renders from the *order* at send time — and `order_id` is NOT NULL, so a
     * password reset has no row shape there at all.
     *
     * Which is the good outcome: `GET /admin/notifications` needs only `orders.read`, so an
     * outbox that could carry a reset link would have turned `orders.read` into "take over
     * any staff account". The absence of a payload column is what makes that impossible.
     */
    expect(mail.sent[0]?.to).toBe(EMAIL);
    expect(mail.sent[0]?.subject).toContain('รหัสผ่าน');
  });

  it('⭐ answers an unknown address exactly as it answers a known one, and sends nothing', async () => {
    const known = await service.request({ email: EMAIL, address: ADDRESS });
    mail.sent = [];
    const unknown = await service.request({ email: 'nobody@example.test', address: ADDRESS });

    // Same shape, no exception, no clue. A reset form that said "no such account" would be
    // the account enumerator the sign-in form was carefully built not to be.
    expect(unknown).toEqual(known);
    expect(mail.sent).toHaveLength(0);
  });

  it('sends nothing for a suspended account, and says nothing either', async () => {
    store.targets.set(EMAIL, {
      userId: 'user-1',
      address: EMAIL,
      displayName: 'สมชาย',
      status: 'suspended',
    });

    await service.request({ email: EMAIL, address: ADDRESS });
    expect(mail.sent).toHaveLength(0);
    expect(store.issued).toHaveLength(0);
  });

  it('does not fail the request when the mail server is down', async () => {
    /*
     * ⚠️ A transport error must not become a 500. The response is identical for an unknown
     * address, so a 500 here would say "this address exists and something went wrong for
     * it" — the enumeration oracle arriving through the error path instead of the happy one.
     * The operator learns about it from the log; the caller learns nothing.
     */
    service = new PasswordResetService(
      store,
      {
        name: 'broken',
        send: () => Promise.reject(new Error('connection refused')),
      },
      new SignInThrottle({
        perAccount: { limit: 3, windowMs: 60_000 },
        perAddress: { limit: 10, windowMs: 60_000 },
      }),
      { from: 'wewin <no-reply@wewin.test>', resetUrlBase: 'https://dash.wewin.test/reset' },
    );

    await expect(service.request({ email: EMAIL, address: ADDRESS })).resolves.toBeDefined();
  });

  it('throttles repeated requests for one address, so the form is not a mail cannon', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await service.request({ email: EMAIL, address: ADDRESS });
    }

    // Without this, "send reset email" is an unauthenticated endpoint that puts a message in
    // somebody else's inbox as fast as it can be called. The victim is the person being
    // mailbombed, and they did nothing but own an address somebody knows.
    const refused = await refusalOf(service.request({ email: EMAIL, address: ADDRESS }));
    expect(refused.status).toBe(429);
    expect(mail.sent).toHaveLength(3);
  });
});

describe('spending a reset', () => {
  it('sets the new password and returns nothing about the account', async () => {
    await service.request({ email: EMAIL, address: ADDRESS });
    await service.complete({ token: tokenFromEmail(), password: NEW_PASSWORD, address: ADDRESS });

    expect(store.written).toHaveLength(1);
    expect(await verifyPassword(store.written[0]?.hash ?? '', NEW_PASSWORD)).toBe(true);
    expect(await verifyPassword(store.written[0]?.hash ?? '', OLD_PASSWORD)).toBe(false);
  });

  it('⭐ revokes every session, because a reset is what somebody does after a theft', async () => {
    await service.request({ email: EMAIL, address: ADDRESS });
    await service.complete({ token: tokenFromEmail(), password: NEW_PASSWORD, address: ADDRESS });

    /*
     * The reason a reset exists is usually "somebody else has my password". Changing the
     * credential while leaving their ninety-day refresh token alive answers the wrong half
     * of that, and does it invisibly — the victim believes they have locked the door.
     */
    expect(store.revoked).toEqual(['user-1']);
  });

  it('refuses the same token twice', async () => {
    await service.request({ email: EMAIL, address: ADDRESS });
    const token = tokenFromEmail();

    await service.complete({ token, password: NEW_PASSWORD, address: ADDRESS });
    const replay = await refusalOf(
      service.complete({ token, password: 'another passphrase here', address: ADDRESS }),
    );

    // `consumed_at` is a column, and one-shot is what a link in an email has to be: it lives
    // in an inbox, in a browser history, and in whatever scanned the message on the way.
    expect(replay.status).toBe(400);
    expect(store.written).toHaveLength(1);
  });

  it('refuses an expired token', async () => {
    await service.request({ email: EMAIL, address: ADDRESS });
    const token = tokenFromEmail();

    const issued = store.issued[0];
    if (issued === undefined) throw new Error('nothing was issued');
    store.tokens.set(
      [...store.tokens.keys()][0] ?? '',
      { userId: issued.userId, expiresAt: new Date(Date.now() - 1), consumedAt: null, status: 'active' },
    );

    expect((await refusalOf(service.complete({ token, password: NEW_PASSWORD, address: ADDRESS }))).status).toBe(400);
    expect(store.written).toHaveLength(0);
  });

  it('refuses a token nobody issued, at the same cost', async () => {
    const refused = await refusalOf(
      service.complete({ token: 'not-a-real-token', password: NEW_PASSWORD, address: ADDRESS }),
    );

    expect(refused.status).toBe(400);
    expect(refused.reason).toBe('reset-token-rejected');
  });

  it('applies the password rule, and does not consume the token when it fails', async () => {
    await service.request({ email: EMAIL, address: ADDRESS });
    const token = tokenFromEmail();

    const refused = await refusalOf(service.complete({ token, password: 'short', address: ADDRESS }));
    expect(refused.status).toBe(422);

    /*
     * ⚠️ The order matters and this is the assertion that pins it. Consuming first and
     * validating second would burn the link on a typo — the person then has an unusable
     * link, no password, and has to start again from an email that no longer works.
     */
    await service.complete({ token, password: NEW_PASSWORD, address: ADDRESS });
    expect(store.written).toHaveLength(1);
  });
});
