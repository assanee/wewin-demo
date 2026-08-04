/**
 * Injection token for this module's configuration.
 *
 * A symbol rather than the class, because `SessionConfig` is an interface — it holds a
 * `KeyObject` and two lifetimes, and giving it a class only so Nest has something to
 * `inject` would invite somebody to put behaviour on it.
 */
export const SESSION_CONFIG = Symbol('wewin.auth.sessionConfig');
