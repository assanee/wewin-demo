import { createHmac, generateKeyPairSync, sign as signPayload, type KeyObject } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { hmacKeyFromSecret, publicKeyFromJwk, verifyIdToken, type Jwk } from '../../../src/auth/oauth/jwt';

/**
 * The id_token verifier, attacked rather than demonstrated.
 *
 * Every `it` below is a way an attacker gets a token accepted that should not be, and the
 * list is not arbitrary: it is what a JWT library's defaults would or would not have caught.
 * The first two are the reason this code names the algorithm instead of reading it out of
 * the header.
 */

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const secret = 'a-channel-secret-that-is-long-enough';

const encode = (value: object): string =>
  Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

function makeToken(options: {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
  sign: (input: string) => string;
}): string {
  const input = `${encode(options.header)}.${encode(options.claims)}`;
  return `${input}.${options.sign(input)}`;
}

const rsaSign = (input: string): string =>
  signPayload('sha256', Buffer.from(input, 'utf8'), rsa.privateKey).toString('base64url');

const hmacSign = (key: string) => (input: string) =>
  createHmac('sha256', key).update(input, 'utf8').digest('base64url');

const baseClaims = (): Record<string, unknown> => ({
  iss: 'https://issuer.example',
  aud: 'client-1',
  sub: 'subject-1',
  iat: nowSeconds(),
  exp: nowSeconds() + 600,
  nonce: 'the-nonce',
});

const options = (algorithm: 'RS256' | 'HS256', keys: () => KeyObject) => ({
  algorithm,
  issuer: 'https://issuer.example',
  audience: 'client-1',
  nonce: 'the-nonce',
  keys,
});

const publicRsa = (): KeyObject => rsa.publicKey;
const hmacKey = (): KeyObject => hmacKeyFromSecret(secret);

describe('verifyIdToken', () => {
  it('accepts an RS256 token from the expected issuer, audience and nonce', async () => {
    const token = makeToken({ header: { alg: 'RS256', kid: 'k1' }, claims: baseClaims(), sign: rsaSign });
    const claims = await verifyIdToken(token, options('RS256', publicRsa));
    expect(claims['sub']).toBe('subject-1');
  });

  it('accepts an HS256 token, which is how LINE signs', async () => {
    const token = makeToken({
      header: { alg: 'HS256' },
      claims: baseClaims(),
      sign: hmacSign(secret),
    });
    const claims = await verifyIdToken(token, options('HS256', hmacKey));
    expect(claims['sub']).toBe('subject-1');
  });

  it('refuses an HS256 token signed with the RSA public key where RS256 was expected', async () => {
    /*
     * The canonical algorithm-confusion attack: the attacker takes material that is public
     * by design — the provider's RSA public key — and uses it as an HMAC secret. A verifier
     * that trusts `alg` from the header hands them a signed token for any account they like.
     * This codebase is the one place it is most tempting, because LINE really does sign
     * HS256 while Google and Apple sign RS256.
     */
    const publicPem = rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const token = makeToken({
      header: { alg: 'HS256' },
      claims: baseClaims(),
      sign: hmacSign(publicPem),
    });

    await expect(verifyIdToken(token, options('RS256', publicRsa))).rejects.toThrow(/signed with HS256/);
  });

  it('refuses alg: none', async () => {
    const token = makeToken({ header: { alg: 'none' }, claims: baseClaims(), sign: () => '' });
    await expect(verifyIdToken(token, options('RS256', publicRsa))).rejects.toThrow(/signed with none/);
  });

  it('refuses a signature made with a key the provider never published', async () => {
    const impostor = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const token = makeToken({
      header: { alg: 'RS256', kid: 'k1' },
      claims: baseClaims(),
      sign: (input) =>
        signPayload('sha256', Buffer.from(input, 'utf8'), impostor.privateKey).toString('base64url'),
    });

    await expect(verifyIdToken(token, options('RS256', publicRsa))).rejects.toThrow(/does not verify/);
  });

  it('refuses a token whose payload was edited after signing', async () => {
    const token = makeToken({ header: { alg: 'RS256' }, claims: baseClaims(), sign: rsaSign });
    const [header, , signature] = token.split('.');
    const tampered = `${header ?? ''}.${encode({ ...baseClaims(), sub: 'somebody-else' })}.${signature ?? ''}`;

    await expect(verifyIdToken(tampered, options('RS256', publicRsa))).rejects.toThrow(/does not verify/);
  });

  it.each([
    ['a different issuer', { iss: 'https://impostor.example' }, /different issuer/],
    ['a different audience', { aud: 'another-client' }, /not issued for this client/],
    ['an expiry in the past', { exp: nowSeconds() - 3600 }, /expired/],
    ['an issue time in the future', { iat: nowSeconds() + 3600 }, /issued in the future/],
    ['a nonce from another flow', { nonce: 'somebody-elses-nonce' }, /nonce does not match/],
  ])('refuses %s', async (_label, override, message) => {
    const token = makeToken({
      header: { alg: 'RS256' },
      claims: { ...baseClaims(), ...override },
      sign: rsaSign,
    });
    await expect(verifyIdToken(token, options('RS256', publicRsa))).rejects.toThrow(message);
  });

  it('refuses a token with no nonce at all', async () => {
    // "Check it if present" is a check an attacker turns off by omitting the claim.
    const { nonce: _dropped, ...withoutNonce } = baseClaims();
    const token = makeToken({ header: { alg: 'RS256' }, claims: withoutNonce, sign: rsaSign });
    await expect(verifyIdToken(token, options('RS256', publicRsa))).rejects.toThrow(/nonce does not match/);
  });

  it('accepts the array form of aud, which the spec allows and providers do use', async () => {
    const token = makeToken({
      header: { alg: 'RS256' },
      claims: { ...baseClaims(), aud: ['another-client', 'client-1'] },
      sign: rsaSign,
    });
    await expect(verifyIdToken(token, options('RS256', publicRsa))).resolves.toBeDefined();
  });

  it.each([
    ['not three segments', 'a.b'],
    ['not JSON', `${Buffer.from('nope').toString('base64url')}.x.y`],
  ])('refuses a token that is %s', async (_label, token) => {
    await expect(verifyIdToken(token, options('RS256', publicRsa))).rejects.toThrow();
  });

  it('refuses an implausibly long token before parsing it', async () => {
    await expect(verifyIdToken('a'.repeat(9000), options('RS256', publicRsa))).rejects.toThrow(
      /implausibly long/,
    );
  });
});

describe('publicKeyFromJwk', () => {
  it('loads a published RSA signing key', () => {
    const jwk = rsa.publicKey.export({ format: 'jwk' }) as unknown as Jwk;
    expect(publicKeyFromJwk(jwk).type).toBe('public');
  });

  it('refuses an entry carrying private key material', () => {
    // A key set containing a private key is a provider that leaked one; this service must
    // not become the thing that used it.
    const jwk = rsa.privateKey.export({ format: 'jwk' }) as unknown as Jwk;
    expect(() => publicKeyFromJwk(jwk)).toThrow(/private key material/);
  });
});
