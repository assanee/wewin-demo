import { describe, expect, it } from 'vitest';

import {
  mintGrantKey,
  mintImageGrant,
  mintUploadHandle,
  verifyImageGrant,
  verifyUploadHandle,
} from '../../../src/payments/slips';

/**
 * The signed grants — plan 7.6's short-lived URLs, and the upload handle behind them.
 *
 * Every case here is a property somebody could remove and still have a working feature, and
 * that is the point of testing them separately from the HTTP suite: a round-trip test alone
 * passes with the MAC deleted.
 */

const KEY = mintGrantKey();
const OTHER_KEY = mintGrantKey();
const NOW = Date.UTC(2026, 7, 4, 9, 0, 0);

const upload = {
  orderId: '11111111-1111-4111-8111-111111111111',
  storageKey: 'slips/11111111-1111-4111-8111-111111111111/abc.jpg',
  contentType: 'image/jpeg',
  byteSize: 4096,
  width: 800,
  height: 1200,
};

const image = {
  slipId: '22222222-2222-4222-8222-222222222222',
  storageKey: 'slips/11111111-1111-4111-8111-111111111111/abc.jpg',
  audience: 'user:33333333-3333-4333-8333-333333333333',
};

describe('the upload handle', () => {
  it('round-trips every claim, so the storage key never has to come from the client', () => {
    const { token } = mintUploadHandle(upload, KEY, NOW);
    const verified = verifyUploadHandle(token, KEY, NOW + 1000);

    expect(verified.ok).toBe(true);
    if (!verified.ok) return;

    expect(verified.claims).toMatchObject({
      kind: 'upload',
      orderId: upload.orderId,
      storageKey: upload.storageKey,
      contentType: 'image/jpeg',
      byteSize: 4096,
    });
  });

  /**
   * The whole reason the handle is signed rather than being the key in plain text.
   *
   * Without the MAC, a caller edits the order id in the payload, presents the handle against
   * an order of their own, and the slip they create names a stranger's slip image — which
   * their own view grant then serves to them, legitimately, because every check downstream
   * is about the slip they really do own.
   */
  it('refuses a payload whose order id has been edited', () => {
    const { token } = mintUploadHandle(upload, KEY, NOW);
    const [body = '', mac = ''] = token.split('.');

    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
    claims['o'] = '99999999-9999-4999-8999-999999999999';
    const forged = `${Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')}.${mac}`;

    expect(verifyUploadHandle(forged, KEY, NOW + 1000)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('refuses a token signed with another key', () => {
    const { token } = mintUploadHandle(upload, OTHER_KEY, NOW);
    expect(verifyUploadHandle(token, KEY, NOW + 1000)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('expires', () => {
    const { token, expiresAtMs } = mintUploadHandle(upload, KEY, NOW, 60);
    expect(verifyUploadHandle(token, KEY, expiresAtMs - 1).ok).toBe(true);
    expect(verifyUploadHandle(token, KEY, expiresAtMs)).toEqual({ ok: false, reason: 'expired' });
  });

  it.each(['', '.', 'nomac', 'a.', '.b', 'not-base64url!!.zzzz'])(
    'refuses the malformed token %j without throwing',
    (token) => {
      expect(verifyUploadHandle(token, KEY, NOW).ok).toBe(false);
    },
  );
});

describe('the image grant', () => {
  it('reports the purpose it was minted with, so the route cannot choose', () => {
    const view = mintImageGrant({ ...image, purpose: 'view' }, KEY, NOW);
    const download = mintImageGrant({ ...image, purpose: 'download' }, KEY, NOW);

    const asView = verifyImageGrant(view.token, KEY, NOW + 1000);
    const asDownload = verifyImageGrant(download.token, KEY, NOW + 1000);

    expect(asView.ok && asView.claims.kind).toBe('view');
    expect(asDownload.ok && asDownload.claims.kind).toBe('download');
  });

  /**
   * ⚠️ DOMAIN SEPARATION, AND IT IS NOT DECORATION.
   *
   * The kind is part of the signed message. Without it, an upload handle — which a caller is
   * *given*, and which names a storage key — would verify as an image grant for that key,
   * and the upload route would be minting read capabilities for the bucket.
   */
  it('cannot be satisfied by an upload handle for the same key', () => {
    const { token } = mintUploadHandle(upload, KEY, NOW);
    expect(verifyImageGrant(token, KEY, NOW + 1000)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('and an image grant is not an upload handle either', () => {
    const { token } = mintImageGrant({ ...image, purpose: 'view' }, KEY, NOW);
    expect(verifyUploadHandle(token, KEY, NOW + 1000)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  /**
   * An expired grant reports `expired` rather than `bad_signature`, which matters because
   * `verifyImageGrant` tries two kinds in a loop: reporting the second kind's signature
   * failure would turn every expiry into a confusing "not signed by us".
   */
  it('expires, and says so rather than blaming the signature', () => {
    const { token, expiresAtMs } = mintImageGrant({ ...image, purpose: 'view' }, KEY, NOW, 60);
    expect(verifyImageGrant(token, KEY, expiresAtMs - 1).ok).toBe(true);
    expect(verifyImageGrant(token, KEY, expiresAtMs)).toEqual({ ok: false, reason: 'expired' });
  });

  it('carries the audience it was minted for, which is what makes the log line worth writing', () => {
    const { token } = mintImageGrant({ ...image, purpose: 'download' }, KEY, NOW);
    const verified = verifyImageGrant(token, KEY, NOW + 1000);

    expect(verified.ok && verified.claims.audience).toBe(image.audience);
  });
});
