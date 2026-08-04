import { generateKeyPairSync, verify as verifySignature } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createAppleClientSecret } from '../../../src/auth/oauth/providers/apple-client-secret';

/**
 * Apple's `client_secret`, which is the one no other provider has.
 *
 * The signature encoding is the part that is easy to get wrong and impossible to notice:
 * node defaults to the DER wrapping used by TLS, JOSE requires raw r‖s, and Apple answers
 * `invalid_client` to both a DER signature and a wrong team id. This verifies the JWT the
 * way Apple would, so the two failures stay distinguishable here rather than in production.
 */
describe('createAppleClientSecret', () => {
  const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const privateKeyPem = key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

  const build = (now = new Date()): string =>
    createAppleClientSecret({
      teamId: 'TEAMID1234',
      keyId: 'KEYID56789',
      privateKeyPem,
      clientId: 'com.example.services',
      now,
    });

  const parts = (token: string): { header: Record<string, unknown>; claims: Record<string, unknown> } => {
    const [header, claims] = token.split('.');
    return {
      header: JSON.parse(Buffer.from(header ?? '', 'base64url').toString('utf8')) as Record<string, unknown>,
      claims: JSON.parse(Buffer.from(claims ?? '', 'base64url').toString('utf8')) as Record<string, unknown>,
    };
  };

  it('signs ES256 in the JOSE r‖s encoding Apple accepts', () => {
    const token = build();
    const [header, claims, signature] = token.split('.');

    const verified = verifySignature(
      'sha256',
      Buffer.from(`${header ?? ''}.${claims ?? ''}`, 'utf8'),
      { key: key.publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature ?? '', 'base64url'),
    );
    expect(verified).toBe(true);
  });

  it('is not verifiable as DER, which is what node would have produced by default', () => {
    const token = build();
    const [header, claims, signature] = token.split('.');

    const asDer = verifySignature(
      'sha256',
      Buffer.from(`${header ?? ''}.${claims ?? ''}`, 'utf8'),
      { key: key.publicKey, dsaEncoding: 'der' },
      Buffer.from(signature ?? '', 'base64url'),
    );
    expect(asDer).toBe(false);
  });

  it('carries the claims Apple checks, and an expiry inside its six-month ceiling', () => {
    const now = new Date('2026-08-03T00:00:00Z');
    const { header, claims } = parts(build(now));

    expect(header).toMatchObject({ alg: 'ES256', kid: 'KEYID56789' });
    expect(claims['iss']).toBe('TEAMID1234');
    expect(claims['sub']).toBe('com.example.services');
    expect(claims['aud']).toBe('https://appleid.apple.com');
    expect(claims['exp']).toBe(Math.floor(now.getTime() / 1000) + 300);
  });

  it('refuses an unreadable key without saying anything about it', () => {
    expect(() =>
      createAppleClientSecret({
        teamId: 'T',
        keyId: 'K',
        privateKeyPem: 'not a pem at all',
        clientId: 'c',
        now: new Date(),
      }),
    ).toThrow(/not a readable PEM private key/);
  });
});
