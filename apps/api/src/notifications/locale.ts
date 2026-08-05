import {
  FALLBACK_LOCALE,
  isSupportedLocale,
  normaliseLocale,
  preferredLocaleOf as preferredLocaleFromSources,
  resolveAgainst,
  SUPPORTED_LOCALES,
  type RecipientLocaleSources,
  type RenderLocale,
  type SupportedLocale,
} from '../i18n';
import { hasTemplate } from './templates/templates';

/**
 * Which language a *notification* goes out in — plan 10.6, and only that half of it.
 *
 * ── What moved out of this file in 6a, and why ───────────────────────────────────
 *
 * The list of languages used to live here, as `SUPPORTED_LOCALES = ['th']`, and that was
 * right while notifications were the only thing that had a language. They are not: HTTP
 * error messages have one, and so does every pinned document. Three features each holding
 * their own list is three lists that agree until the day one of them adds a language, and
 * the day they disagree is the day somebody's `en` preference is honoured by the API and
 * ignored by the mailer.
 *
 * So the eight locales live in `src/i18n/locales.ts` and this file re-exports them. What
 * stays here is the part that is genuinely about notifications: **which templates exist**.
 *
 * ── The distinction that keeps this honest: supported ≠ renderable ───────────────
 *
 * `SUPPORTED_LOCALES` is now eight, and the template catalogue is still one. If
 * `resolveRenderLocale` were still "is this in the list?", every one of the seven new
 * languages would resolve to itself and `renderTemplate` would return `undefined` — which
 * the worker treats as a **permanent** failure and drops into the dead queue. Widening the
 * list without widening this function would have quietly stopped delivering mail to anybody
 * who ever set a preference.
 *
 * It therefore asks `hasTemplate`, per template, and a language with no template for *this*
 * event falls back to Thai and says so. `notification_attempts.locale` records what was
 * rendered, so "we sent them Thai because we have no Burmese yet" stays a fact in the
 * evidence table rather than a guess during a dispute.
 *
 * ── Still deliberately NOT here: the document half ───────────────────────────────
 *
 * `order_documents.pinned_locale` is written by `orders/order-document.ts` through
 * `pinnedLocaleOf`, and nothing in this file reads it. A shared `getLocale()` serving both
 * would be the exact confusion plan 10.6 separates: a notification follows the reader, a
 * document does not.
 */

export {
  FALLBACK_LOCALE,
  isSupportedLocale,
  SUPPORTED_LOCALES,
  type RecipientLocaleSources,
  type RenderLocale,
  type SupportedLocale,
};

/**
 * What the recipient asked for, before anybody checks whether we can honour it.
 *
 * Narrowed to `string` rather than `string | null`: a notification always has a recipient
 * and `orders.contact_locale` is `NOT NULL DEFAULT 'th'`, so there is always an answer. The
 * shared helper allows `null` because an HTTP request may genuinely express no preference.
 */
export function preferredLocaleOf(sources: RecipientLocaleSources): string {
  return preferredLocaleFromSources(sources) ?? FALLBACK_LOCALE;
}

/**
 * The language a template for `templateKey` actually exists in.
 *
 * `templateKey` is a parameter and not an afterthought: coverage is per message, so a
 * half-translated catalogue delivers its translated half in the reader's language and the
 * rest in Thai. Holding every language back until the last of ~96 messages lands (plan
 * 10.6's own estimate) would mean the first 95 translations sit finished and unsent.
 *
 * `th-TH` resolves to `th`. BCP 47 is how a preference is reported, and refusing to match a
 * region subtag against a base catalogue would send Thai customers the fallback — which
 * happens to also be Thai, which is exactly why nobody would notice until it was not.
 */
export function resolveRenderLocale(requested: string, templateKey: string): RenderLocale {
  return resolveAgainst(requested, (candidate) => hasTemplate(candidate, templateKey));
}

/**
 * A requested language narrowed to one of the eight, with no question of coverage.
 *
 * For the callers that need to know "is this a language at all" rather than "can we write
 * to them in it" — recording a preference, validating a request body.
 */
export function toSupportedLocale(requested: string): SupportedLocale | null {
  return normaliseLocale(requested);
}
