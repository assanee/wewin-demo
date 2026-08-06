/**
 * Injection token for the parsed review-photo configuration.
 *
 * A token rather than a class so that `parseReviewPhotoConfig` stays a pure function of a
 * record — testable without a container, and parsed once at module construction rather than
 * once per provider that happens to need the bucket name. Same arrangement as `MEDIA_CONFIG`
 * and `SLIP_STORAGE_CONFIG`.
 */
export const REVIEW_PHOTO_CONFIG = Symbol('wewin.reviewPhotoConfig');
