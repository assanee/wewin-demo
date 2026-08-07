/**
 * Injection tokens, apart from the things they name.
 *
 * `SecretBox` is constructed from a `KeyObject` that comes out of configuration, so Nest
 * cannot resolve it as a class provider — the same shape `SIGN_IN_THROTTLE` documents. The
 * token lives in its own file so a service can import it without importing the module that
 * provides it, which would be a cycle.
 */
export const MFA_SECRET_BOX = Symbol('wewin.auth.mfaSecretBox');
