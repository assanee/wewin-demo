/**
 * Injection token for the parsed media configuration.
 *
 * A token rather than a class so that `parseMediaConfig` stays a pure function of a record —
 * testable without a container, and parsed once at module construction rather than once per
 * provider that happens to need the bucket name.
 */
export const MEDIA_CONFIG = Symbol('wewin.mediaConfig');
