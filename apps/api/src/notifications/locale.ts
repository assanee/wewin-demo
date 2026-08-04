/**
 * Which language a message goes out in — plan 10.6, and only the notification half of it.
 *
 * The plan splits two things that look like one:
 *
 *   a **notification** uses the recipient's language *at the time of sending*. Somebody who
 *     switched to English yesterday should get English today.
 *   a **document** (quotation, invoice, tax invoice) uses the language pinned at
 *     `submit_for_payment`, alongside the other six things pinned there (plan 7.13). A
 *     reprint that comes out in a different language is a document that cannot be cited.
 *
 * This file is the first one. The second is `order_documents.pinned_locale` and belongs to
 * whoever renders documents; nothing here reads it, on purpose — a shared "getLocale" that
 * served both would be the exact confusion the plan separates.
 *
 * ── ⚠️ THE SEAM, AND WHAT IS DELIBERATELY NOT BUILT ──────────────────────────
 *
 * Phase 6 is i18n. This is not phase 6. What exists here is the *resolution* seam and one
 * complete language; what does not exist is a message catalogue in eight languages, which
 * plan 10.6 identifies as a translator bottleneck (~12 events × 8 languages ≈ 96 messages)
 * shared with plan 13's content row.
 *
 * The two pieces the seam is shaped around:
 *
 *   1. `preferredLocaleOf` takes what the database knows about the recipient. Today that is
 *      `orders.contact_locale` — the column exists precisely because a guest has no account
 *      to hold a preference. **There is no `users.preferred_locale` column yet**, so a
 *      signed-in customer is resolved the same way. When phase 6 adds one, it is read here
 *      and nowhere else, and the ordering (account preference, then the order's contact
 *      locale, then the fallback) is already written down below.
 *
 *   2. `resolveRenderLocale` returns the language a template *actually exists in*, which is
 *      not always the one that was asked for. The rendered locale — not the requested one —
 *      is what `notification_attempts.locale` records, so "we sent them Thai because we have
 *      no English yet" is a fact in the evidence table rather than a guess during a dispute.
 */

/** Languages a message can be rendered in today. Phase 6 grows this; nothing else changes. */
export const SUPPORTED_LOCALES = ['th'] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/**
 * Thai, and it is the fallback rather than English on purpose: this is a Thai company
 * selling to Thai customers, and a message in the language the *business* speaks can at
 * least be forwarded to somebody who reads it.
 */
export const FALLBACK_LOCALE: SupportedLocale = 'th';

export function isSupportedLocale(value: string): value is SupportedLocale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/**
 * What the recipient asked for, before anybody checks whether we can honour it.
 *
 * Kept as a plain string, not narrowed to `SupportedLocale`: the whole point of separating
 * this from `resolveRenderLocale` is that "they want `en`" and "we can only send `th`" are
 * two different facts, and collapsing them here would erase the first one before it could
 * be recorded.
 */
export interface RecipientLocaleSources {
  /**
   * SEAM phase 6: `users.preferred_locale`, which does not exist yet.
   *
   * Left as an explicit `undefined`-able input rather than omitted, so adding the column is
   * a change in the repository query and not a change in this file's shape.
   */
  readonly accountLocale?: string | null;
  /** `orders.contact_locale` — `NOT NULL DEFAULT 'th'`, and meant to be updated. */
  readonly contactLocale: string;
}

export function preferredLocaleOf(sources: RecipientLocaleSources): string {
  const account = sources.accountLocale?.trim();
  if (account !== undefined && account.length > 0) return account;
  return sources.contactLocale;
}

export interface RenderLocale {
  /** What the recipient wanted. Logged when it differs from what was rendered. */
  readonly requested: string;
  /** What a template exists in, and what `notification_attempts.locale` records. */
  readonly rendered: SupportedLocale;
}

/**
 * Narrows a requested language to one we have messages in.
 *
 * `th-TH` resolves to `th`: BCP 47 subtags are how a browser reports a language and a
 * region, and refusing to match `th-TH` against a `th` catalogue would silently send Thai
 * customers the fallback — which happens to also be Thai today, which is exactly why it
 * would go unnoticed until the day it does not.
 */
export function resolveRenderLocale(requested: string): RenderLocale {
  const normalised = requested.trim().toLowerCase();
  const base = normalised.split(/[-_]/)[0] ?? '';

  if (isSupportedLocale(normalised)) return { requested, rendered: normalised };
  if (isSupportedLocale(base)) return { requested, rendered: base };

  return { requested, rendered: FALLBACK_LOCALE };
}
