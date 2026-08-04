import { createPrivateKey, sign as signPayload } from 'node:crypto';

import { ProviderError } from './provider.types';

/**
 * Apple's `client_secret` is a JWT this service signs, not a string somebody pasted.
 *
 * Every other provider hands over a secret at registration and it stays the same until
 * rotated. Apple hands over a `.p8` elliptic-curve private key and expects a fresh ES256
 * JWT, signed with it, as the `client_secret` on every token request. Apple caps its
 * lifetime at six months.
 *
 * That difference is why `ProviderSecret` is a union rather than a string. A "secret" field
 * holding a pre-signed Apple JWT would work for six months and then stop, at a moment
 * unrelated to any deploy, with an error from the token endpoint that says
 * `invalid_client` and nothing else.
 *
 * Signed per request with a five-minute expiry rather than cached: a P-256 signature is
 * microseconds, a cache is a lifetime to get wrong, and a short expiry means a JWT captured
 * from a proxy log is worth almost nothing. The key never leaves this function's arguments
 * and the JWT is never logged.
 */

const AUDIENCE = 'https://appleid.apple.com';
const LIFETIME_SECONDS = 300;

export interface AppleClientSecretInput {
  readonly teamId: string;
  readonly keyId: string;
  /** The contents of the `.p8` file, PEM, including the BEGIN/END lines. */
  readonly privateKeyPem: string;
  /** The Services ID — the same value sent as `client_id`. */
  readonly clientId: string;
  readonly now: Date;
}

export function createAppleClientSecret(input: AppleClientSecretInput): string {
  const issuedAt = Math.floor(input.now.getTime() / 1000);

  const header = { alg: 'ES256', kid: input.keyId, typ: 'JWT' };
  const payload = {
    iss: input.teamId,
    iat: issuedAt,
    exp: issuedAt + LIFETIME_SECONDS,
    aud: AUDIENCE,
    sub: input.clientId,
  };

  const signingInput = `${encode(header)}.${encode(payload)}`;

  let key;
  try {
    key = createPrivateKey({ key: input.privateKeyPem, format: 'pem' });
  } catch {
    // The message deliberately says nothing about the key material it failed to parse.
    throw new ProviderError('Apple signing key is not a readable PEM private key');
  }

  /*
   * `ieee-p1363` is the raw r‖s encoding JOSE requires. Node's default is the DER wrapping
   * used by TLS, and Apple rejects a DER-encoded signature with `invalid_client` — the same
   * error it gives for a wrong team id, which is what makes this a genuinely expensive line
   * to get wrong.
   */
  const signature = signPayload('sha256', Buffer.from(signingInput, 'utf8'), {
    key,
    dsaEncoding: 'ieee-p1363',
  });

  return `${signingInput}.${signature.toString('base64url')}`;
}

function encode(value: object): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}
