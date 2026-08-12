import {
  FALLBACK_LOCALE,
  LOCALES,
  SOURCE_LOCALE,
  type Locale,
  isLocale,
  resolveRenderLocale,
} from '@wewin/i18n/locales';

/**
 * The eight languages, and the two different questions "which language?" can mean.
 *
 * ── Plan 10.6, as two functions rather than one ──────────────────────────────────
 *
 * > การแจ้งเตือน ใช้ภาษาที่ผู้รับตั้งไว้ ณ ตอนส่ง
 * > เอกสาร ใช้ภาษาที่ตรึงตอน `submit_for_payment`
 *
 * A **notification** asks "what does this person read *today*". A **document** asks "what
 * language was this promise made in", and that answer was fixed months ago and may not
 * move — a quotation reprinted next year in a different language is not the same document
 * and cannot be cited. Both questions produce a `SupportedLocale`, which is why it is
 * tempting to answer them with one function; they differ in *where the input comes from*,
 * and a shared `getLocale()` would be the exact confusion the plan separates.
 *
 * So: `preferredLocaleOf` (notifications, and every HTTP response) reads a live preference.
 * `pinnedLocaleOf` (documents) reads what was frozen. Neither calls the other.
 *
 * ── Why the list is here and not in notifications/locale.ts ──────────────────────
 *
 * It used to be there, as `SUPPORTED_LOCALES = ['th']`, scoped to notification templates.
 * The moment HTTP error messages, documents and notifications all have to agree on what
 * `'my'` means, a per-feature list becomes three lists that disagree at the edges — and the
 * edge is exactly where this matters, because the edge is "we do not have that language".
 *
 * ── Supported ≠ available, and that distinction is the whole design ──────────────
 *
 * All eight are **supported**: a person may choose any of them and the system must not lose
 * the choice. Only Thai is **complete**. Plan 13 names 81 products × 8 languages as a human
 * translator bottleneck, not a code task, and the honest consequence is that a request for
 * Burmese is answered in Thai *and says so*. `resolveAgainst` is where that is decided, and
 * it returns both halves so that "they asked for `my`, they got `th`" is a recordable fact
 * rather than something inferred later from an empty column.
 */

/**
 * de · en · hi · la · my · th · vi · zh — **re-exported from `@wewin/i18n`, not declared.**
 *
 * It was declared here, and `apps/web` declared a third copy, and phase 6a's review found
 * the three already disagreeing on two of the eight: `la` (Latin here, Lao there) and `en`
 * (`en-US` here, `en-GB` there — so one surface dated an invoice 06/08 meaning June and the
 * other meaning August). Three lists is three lists that disagree at the edges, and the
 * edge is exactly where this matters, because the edge is "we do not have that language".
 *
 * The alias survives because ~200 call sites and five `Map` types name `SupportedLocale`,
 * and because the *word* is right for this file: all eight are supported, only Thai is
 * complete, and `resolveAgainst` is where that distinction lives.
 */
export const SUPPORTED_LOCALES = LOCALES;

export type SupportedLocale = Locale;

/**
 * Thai is both the source language and the fallback, and those are two claims.
 *
 * *Source*: every message is authored in Thai first and the other catalogues are
 * translations of it. *Fallback*: an untranslated message renders in Thai rather than in a
 * raw key or an empty string. Fallback is Thai and not English deliberately — this is a
 * Thai company, so a message in the language the business speaks can at least be forwarded
 * to somebody who reads it, whereas a key cannot.
 */
export { SOURCE_LOCALE, FALLBACK_LOCALE };

export const isSupportedLocale = isLocale;

/**
 * `th-TH` → `th`, `ZH_Hans_CN` → `zh`, `klingon` → `null`.
 *
 * BCP 47 is how a browser reports a language *and a region*, and refusing to match `th-TH`
 * against a `th` catalogue would silently send Thai customers the fallback — which happens
 * to also be Thai, which is precisely why it would go unnoticed until the day it did not.
 *
 * `null` rather than the fallback, because "they asked for something we do not have" and
 * "they asked for Thai" are different facts and only one of them is worth logging.
 */
export function normaliseLocale(value: unknown): SupportedLocale | null {
  if (typeof value !== 'string') return null;

  // `resolveRenderLocale` is `@wewin/i18n`'s, so the storefront's language switcher, this
  // API's `Accept-Language` and the notification worker all narrow a tag by one rule. It
  // reports the fallback rather than hiding it, which is what lets this keep returning
  // `null` — "they asked for something we do not have" and "they asked for Thai" are
  // different facts and only one of them is worth logging.
  const resolved = resolveRenderLocale(value);
  return resolved.fallback ? null : resolved.rendered;
}

/**
 * The language a document was written in, from what was pinned on it.
 *
 * Total, and deliberately so. `order_documents.pinned_locale` is `text`, and rows pinned
 * before this file existed hold whatever the client sent — the column's own validation was
 * `z.string().min(2).max(16)`, which accepts `klingon`. A reprint of one of those rows must
 * still produce a document; it produces a Thai one, which is what those rows were rendered
 * in at the time anyway.
 *
 * What this must never do is *re-negotiate*. A document is not re-rendered into the
 * reader's language, and that is the entire point of pinning it.
 */
export function pinnedLocaleOf(pinned: string): SupportedLocale {
  return normaliseLocale(pinned) ?? FALLBACK_LOCALE;
}

/**
 * What a recipient asked for, before anybody checks whether we can honour it.
 *
 * Kept as `string`, not narrowed: separating "they want `en`" from "we can only send `th`"
 * is the whole reason `resolveAgainst` exists, and narrowing here erases the first fact
 * before it can be recorded.
 */
export interface RecipientLocaleSources {
  /**
   * SEAM: the signed-in customer's stored language — `user_preferences.preferred_locale`.
   *
   * An explicit nullable input rather than an omitted one, so that filling it is a change to a
   * repository query and not to this file's shape.
   *
   * ⚠️ **The column exists; nothing passes it.** This said "which does not exist yet" until the
   * preferences resource shipped it. What is still owed is the *join*:
   * `NotificationsRepository` selects `contact_locale` and no preference, and
   * `NotificationWorkerService.deliver` calls `preferredLocaleOf({ contactLocale })` alone. So
   * every caller of this interface leaves this field `undefined` today, and
   * `profile/preference-effects.ts` says `locale/notification: false` because of it — it said
   * `true` for a round on the strength of this seam being fillable, which put a tick on a
   * customer's settings page beside a promise nothing kept.
   */
  readonly accountLocale?: string | null;
  /** `orders.contact_locale` — `NOT NULL DEFAULT 'th'`; a guest has no account to hold one. */
  readonly contactLocale?: string | null;
  /** `Accept-Language`, for a request that belongs to no order at all. */
  readonly requestLocale?: string | null;
}

/**
 * Account preference, then the order's contact locale, then the request's own header.
 *
 * The order is the priority order and it is not arbitrary: a signed-in person's stated
 * preference beats the language a form was filled in, which beats the language their
 * browser happens to be configured in this morning.
 */
export function preferredLocaleOf(sources: RecipientLocaleSources): string | null {
  for (const candidate of [sources.accountLocale, sources.contactLocale, sources.requestLocale]) {
    const trimmed = candidate?.trim();
    if (trimmed !== undefined && trimmed.length > 0) return trimmed;
  }
  return null;
}

/**
 * One entry of an `Accept-Language` header, after parsing.
 *
 * `q` is kept as the integer thousandths the header spells (`q=0.8` → `800`) rather than a
 * float. Two languages at `q=0.7` must tie exactly so that the earlier one wins by document
 * order, and `0.7 + 0.1 !== 0.8` is not a hypothesis worth betting a customer's language on.
 */
interface AcceptedLanguage {
  readonly locale: SupportedLocale;
  readonly q: number;
  readonly at: number;
}

const Q_SCALE = 1000;

/**
 * Highest-quality supported language in an `Accept-Language` header, or `null`.
 *
 * `null` and not the fallback: the caller may have a better source than a browser header —
 * an account preference, an order's contact locale — and collapsing "the header named
 * nothing we support" into "Thai" here would let the header quietly outrank all of them.
 *
 * `q=0` means *explicitly not this one* and is dropped rather than ranked last, which is
 * what the grammar says and is the only part of it that changes an outcome here.
 */
export function parseAcceptLanguage(header: string | null | undefined): SupportedLocale | null {
  if (typeof header !== 'string' || header.trim().length === 0) return null;

  const accepted: AcceptedLanguage[] = [];

  header.split(',').forEach((part, at) => {
    const [tag, ...parameters] = part.split(';');
    if (tag === undefined) return;

    const locale = normaliseLocale(tag);
    if (locale === null) return;

    const q = qualityOf(parameters);
    if (q <= 0) return;

    accepted.push({ locale, q, at });
  });

  if (accepted.length === 0) return null;

  const best = accepted.reduce((left, right) =>
    /* Strictly greater, so an equal q keeps the earlier entry — document order breaks ties. */
    right.q > left.q ? right : left,
  );

  return best.locale;
}

function qualityOf(parameters: readonly string[]): number {
  for (const parameter of parameters) {
    const [name, value] = parameter.split('=');
    if (name === undefined || value === undefined) continue;
    if (name.trim().toLowerCase() !== 'q') continue;

    const parsed = Number.parseFloat(value.trim());
    if (Number.isNaN(parsed)) return 0;
    /* Clamped, then scaled: `q=1.5` is malformed and must not outrank a well-formed `q=1`. */
    return Math.round(Math.min(Math.max(parsed, 0), 1) * Q_SCALE);
  }
  return Q_SCALE;
}

/**
 * What a message will actually be rendered in, given what a catalogue covers.
 *
 * `degraded` is a field and not something a reader derives from `requested !== rendered`,
 * because those are different questions: `requested: 'th-TH'` renders as `th` and is not a
 * degradation, while `requested: 'my'` rendering as `th` is. Getting that wrong turns a
 * dashboard's "we could not translate this" banner into permanent noise, which is the same
 * as having no banner.
 */
export interface RenderLocale {
  /** What the recipient wanted, verbatim. `null` when nobody expressed a preference. */
  readonly requested: string | null;
  /** What a message exists in. `notification_attempts.locale` records *this* one. */
  readonly rendered: SupportedLocale;
  /** True when the request was for a language we do not have this message in. */
  readonly degraded: boolean;
}

/**
 * Narrow a requested language down to one the given catalogue actually covers.
 *
 * `covered` is passed in rather than imported so that this function works for any
 * catalogue: HTTP error messages, notification templates and documents all have their own
 * coverage and will reach completeness on different days. A single global "is `en` ready?"
 * would have to be false until the last of the three was done, which means the first two
 * would sit finished and unused.
 */
export function resolveAgainst(
  requested: string | null,
  covered: (locale: SupportedLocale) => boolean,
): RenderLocale {
  if (requested === null) {
    return { requested: null, rendered: FALLBACK_LOCALE, degraded: false };
  }

  const wanted = normaliseLocale(requested);
  if (wanted === null) {
    /*
     * An unrecognised tag is not a degradation of anything — there was no language to
     * degrade *from*. Reporting it as one would fill the evidence table with "we could not
     * translate `undefined`" every time a script forgot the header.
     */
    return { requested, rendered: FALLBACK_LOCALE, degraded: false };
  }

  if (covered(wanted)) return { requested, rendered: wanted, degraded: false };

  return { requested, rendered: FALLBACK_LOCALE, degraded: wanted !== FALLBACK_LOCALE };
}
