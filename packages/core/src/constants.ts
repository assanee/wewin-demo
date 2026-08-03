/**
 * Domain constants that more than one concern needs.
 *
 * These live here rather than beside the reducer because `share-link` clamps the
 * quantity it parses out of a URL, and importing that bound from `quote` would
 * make every consumer of a share link pull the whole cart reducer in behind it.
 * A constant shared by two subpaths belongs to neither of them.
 */

/** Fewer than one window is not an order. */
export const MIN_QTY = 1;

/**
 * Ceiling on a single quote line. Not a business rule about how much anyone may
 * buy — it is the point past which a typo is more likely than an intent.
 */
export const MAX_QTY = 99;
