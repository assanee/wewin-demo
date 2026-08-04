import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { equalsConstantTime, randomSecret, sha256Hex } from '../../../src/auth/oauth/crypto';
import { deriveNonce } from '../../../src/auth/oauth/nonce';
import { createPkce, verifierMatches } from '../../../src/auth/oauth/pkce';

describe('PKCE', () => {
  it('produces an S256 challenge of the shape the oauth_states CHECK accepts', () => {
    const { verifier, challenge } = createPkce();

    // 43 base64url characters, no padding — RFC 7636's minimum and exactly what
    // `oauth_states_pkce_challenge_shape` requires.
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(createHash('sha256').update(verifier, 'utf8').digest('base64url'));
    expect(verifierMatches(verifier, challenge)).toBe(true);
  });

  it('refuses a verifier from another flow', () => {
    const mine = createPkce();
    const theirs = createPkce();
    expect(verifierMatches(theirs.verifier, mine.challenge)).toBe(false);
  });

  it('never repeats', () => {
    const seen = new Set(Array.from({ length: 64 }, () => createPkce().verifier));
    expect(seen.size).toBe(64);
  });
});

describe('nonce', () => {
  it('is derived from the verifier, so it is never stored anywhere', () => {
    const { verifier } = createPkce();
    expect(deriveNonce(verifier)).toBe(deriveNonce(verifier));
    expect(deriveNonce(verifier)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('is not the PKCE challenge under another name', () => {
    // The label in the derivation is what keeps these two apart; without it the challenge
    // would be sent to the provider twice under two parameter names.
    const { verifier, challenge } = createPkce();
    expect(deriveNonce(verifier)).not.toBe(challenge);
  });

  it('differs per flow', () => {
    expect(deriveNonce(createPkce().verifier)).not.toBe(deriveNonce(createPkce().verifier));
  });
});

describe('secrets', () => {
  it('are 256 bits of base64url', () => {
    const secret = randomSecret();
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(secret, 'base64url')).toHaveLength(32);
  });

  it('hash to exactly the lower-case hex the char(64) CHECK constraints accept', () => {
    // A raw token is not 64 lower-case hex characters, which is what makes a service that
    // forgot to hash fail on the INSERT that did it — see packages/db/src/schema/auth.ts.
    expect(sha256Hex(randomSecret())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('compares without leaking how far it got', () => {
    expect(equalsConstantTime('abc', 'abc')).toBe(true);
    expect(equalsConstantTime('abc', 'abd')).toBe(false);
    expect(equalsConstantTime('abc', 'abcd')).toBe(false);
    expect(equalsConstantTime('', '')).toBe(true);
  });
});
