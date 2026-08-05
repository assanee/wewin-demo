/**
 * The eight languages, and the two questions every other module here asks about one:
 * *which tag does ICU know it by*, and *which one am I allowed to use for this job*.
 *
 * ── The tag the project uses is not always the tag ICU knows ──────────────────
 *
 * The eight are named in the brief as `de · en · hi · la · my · th · vi · zh`, and one
 * of those is not the language it looks like. In BCP 47 `la` is **Latin**, the dead
 * one; Lao is `lo`. ICU has no data for `la`, so `new Intl.NumberFormat('la')` resolves
 * to `en-US` and silently formats Lao as American English — verified on this machine:
 *
 *     Intl.NumberFormat('la').resolvedOptions().locale        // 'en-US'
 *     Intl.DateTimeFormat('la', {dateStyle:'long'}).format(d) // 'August 6, 2026'
 *
 * That is the worst failure mode this package can have: not an error, not a fallback,
 * but a plausible wrong answer in a language nobody on the team reads. So the project
 * tag and the ICU tag are two different things and `INTL_TAG` is the only place the
 * second one is written down. `tests/locales.test.ts` fails if any tag resolves to a
 * different language than the one it claims.
 */

/**
 * Every locale the storefront, the dashboard and the notification worker can render.
 *
 * Ordered by tag rather than by importance: any other order is a claim about the
 * business that this package is not entitled to make.
 */
export const LOCALES = ['de', 'en', 'hi', 'la', 'my', 'th', 'vi', 'zh'] as const;

export type Locale = (typeof LOCALES)[number];

/**
 * Thai, and it is two facts wearing one value.
 *
 * `SOURCE_LOCALE` is where content is *authored*: the catalogue, the rule messages and
 * every template in this package start life in Thai and a translator works from them.
 * `FALLBACK_LOCALE` is what a customer *sees* when a translation is missing. They are
 * the same language today and they are not the same idea — if the business ever
 * authored in English, only one of the two would move.
 */
export const SOURCE_LOCALE = 'th' satisfies Locale;

/**
 * What a missing translation degrades to.
 *
 * Thai rather than English on purpose, and it is the same call `apps/api`'s notification
 * locale makes: this is a Thai company, and a message in the language the business
 * speaks can at least be forwarded to somebody who reads it. An English fallback would
 * be a second translation nobody had reviewed.
 */
export const FALLBACK_LOCALE = SOURCE_LOCALE;

export const isLocale = (value: unknown): value is Locale =>
  typeof value === 'string' && (LOCALES as readonly string[]).includes(value);

/**
 * The tag handed to `Intl`. **Not** always the project tag — see the header.
 *
 * Regions are explicit rather than left to ICU's default for the bare language, because
 * the default is a fact about ICU's data and not about this business, and it changes
 * between ICU versions.
 *
 * Two entries are decisions rather than facts, and both are one line to revise:
 *
 *   `en → en-GB`  long dates read day-first, like the other seven. `en-US` is the only
 *                 tag in the set that reverses them, and an invoice a customer reads as
 *                 06/08 must not mean June to one of them and August to the rest.
 *   `zh → zh-CN`  Simplified. It is the script that pairs with CNY, the only Chinese
 *                 currency in `@wewin/core/money`. Traditional is `zh-TW` when asked for.
 */
export const INTL_TAG: Readonly<Record<Locale, string>> = {
  de: 'de-DE',
  en: 'en-GB',
  hi: 'hi-IN',
  // Lao. NOT `la`, which is Latin and resolves to en-US. See the header.
  la: 'lo-LA',
  my: 'my-MM',
  th: 'th-TH',
  vi: 'vi-VN',
  zh: 'zh-CN',
};

/**
 * What each language calls itself. For a language switcher, and only for that.
 *
 * Endonyms are facts about a language rather than translations of content, so they can
 * be shipped without a translator — unlike everything in `catalogs/`, which cannot.
 */
export const LOCALE_ENDONYM: Readonly<Record<Locale, string>> = {
  de: 'Deutsch',
  en: 'English',
  hi: 'हिन्दी',
  la: 'ລາວ',
  my: 'မြန်မာ',
  th: 'ไทย',
  vi: 'Tiếng Việt',
  zh: '中文',
};

/**
 * The script each language is written in — for font stacks (plan 8.3).
 *
 * Plan 8.3 names Devanagari (`hi`) and CJK (`zh`) as the two scripts the current fonts
 * do not cover. This table says there are **four**: Lao and Myanmar are not Latin
 * either, and `my-MM` additionally renders its *digits* in Myanmar numerals by default,
 * so a page that loads no Myanmar face shows tofu where the prices are.
 *
 * And the harder one, which follows from `FALLBACK_LOCALE` rather than from this table:
 * **every locale's page can contain Thai**, because an untranslated message degrades to
 * Thai in place. There is no locale whose font stack may omit a Thai face.
 */
export const LOCALE_SCRIPT: Readonly<
  Record<Locale, 'latin' | 'devanagari' | 'lao' | 'myanmar' | 'thai' | 'han'>
> = {
  de: 'latin',
  en: 'latin',
  hi: 'devanagari',
  la: 'lao',
  my: 'myanmar',
  th: 'thai',
  vi: 'latin',
  zh: 'han',
};

/**
 * The calendar dates are rendered in, stated rather than inherited.
 *
 * `th-TH` defaults to the **Buddhist** era in ICU: today is 2569, not 2026. That is
 * correct for a Thai document and catastrophic if it arrives by accident in a locale
 * that did not ask for it, so both halves are written down. A caller that needs the
 * Common Era for one particular field passes `calendar: 'gregory'` and gets it in every
 * locale, including Thai.
 */
export const LOCALE_CALENDAR: Readonly<Record<Locale, 'buddhist' | 'gregory'>> = {
  de: 'gregory',
  en: 'gregory',
  hi: 'gregory',
  la: 'gregory',
  my: 'gregory',
  th: 'buddhist',
  vi: 'gregory',
  zh: 'gregory',
};

/**
 * Where the company is, and therefore which day a timestamp falls on.
 *
 * Never the host's zone. A quote submitted at 06:00 in Bangkok is dated the day before
 * if a server in São Paulo renders it, and the reprint that plan 10.6 requires to be
 * identical would not be.
 */
export const BUSINESS_TIME_ZONE = 'Asia/Bangkok';

/* ------------------------------------------------------------------ *
 * Resolution
 * ------------------------------------------------------------------ */

/**
 * What was asked for, and what will actually be rendered.
 *
 * Two fields rather than one because they are two facts. `apps/api` records the
 * rendered one in `notification_attempts.locale`, so "we sent them Thai because we have
 * no Burmese yet" is evidence in a table rather than a guess during a dispute.
 */
export interface RenderLocale {
  /** Exactly what the caller passed, untouched. Logged when it differs. */
  readonly requested: string;
  /** A locale this package can render. */
  readonly rendered: Locale;
  /** Whether the request had to be given up on entirely. */
  readonly fallback: boolean;
}

/**
 * Narrow one requested tag to one of the eight.
 *
 * `th-TH` resolves to `th`, because a BCP 47 tag is how a browser reports a language
 * *and a region*, and refusing to match it would send every Thai customer the fallback —
 * which is also Thai, which is exactly why nobody would notice until it was not.
 *
 * `zh-Hans` and `zh-Hant` both resolve to `zh`: this package has one Chinese catalogue,
 * and pretending otherwise by matching only one of the scripts would leave the other
 * silently on Thai.
 */
export function resolveRenderLocale(requested: string): RenderLocale {
  const normalised = requested.trim().toLowerCase();
  if (isLocale(normalised)) return { requested, rendered: normalised, fallback: false };

  const base = normalised.split(/[-_]/)[0] ?? '';
  if (isLocale(base)) return { requested, rendered: base, fallback: false };

  return { requested, rendered: FALLBACK_LOCALE, fallback: true };
}

/** `resolveRenderLocale` when only the answer is wanted. */
export const resolveLocale = (requested: string): Locale =>
  resolveRenderLocale(requested).rendered;

/**
 * The best of an `Accept-Language` header, honouring q-values.
 *
 * Written out rather than deferred to `Intl.LocaleMatcher` because that does not exist
 * in either runtime yet, and deferred to nothing else because the header is the first
 * thing a first-time visitor is served from — a wrong answer here is the language the
 * storefront greets a customer in.
 *
 * `*` needs no special case: it is not one of the eight and does not narrow to one, so it
 * falls through to the fallback like any other tag this package cannot honour. There was
 * a filter for it here until a mutation showed it could not change an answer — a guard
 * that cannot fail is a guard with nothing behind it, so it is gone and the behaviour is
 * pinned by a test instead.
 */
export function negotiateLocale(acceptLanguage: string): RenderLocale {
  const candidates = acceptLanguage
    .split(',')
    .map((part) => {
      const [tag = '', ...rest] = part.trim().split(';');
      const q = rest
        .map((entry) => /^\s*q\s*=\s*([\d.]+)\s*$/.exec(entry))
        .find((match) => match !== null);

      const quality = q?.[1] === undefined ? 1 : Number(q[1]);
      return { tag: tag.trim(), quality: Number.isFinite(quality) ? quality : 0 };
    })
    .filter((entry) => entry.tag !== '' && entry.quality > 0)
    // Stable within equal quality: the header's own order is the tie-break, which is
    // what the spec says it means.
    .sort((a, b) => b.quality - a.quality);

  for (const candidate of candidates) {
    const resolved = resolveRenderLocale(candidate.tag);
    if (!resolved.fallback) return { ...resolved, requested: acceptLanguage };
  }

  return { requested: acceptLanguage, rendered: FALLBACK_LOCALE, fallback: true };
}

/* ------------------------------------------------------------------ *
 * Plan 10.6 — a notification and a document do not choose a language the same way
 * ------------------------------------------------------------------ */

/**
 * The language a **notification** goes out in: the recipient's preference *right now*.
 *
 * Somebody who switched to English yesterday gets English today. The ordering is
 * account preference, then the order's contact locale, then the fallback — and it is
 * written here once so that the two places that send mail cannot disagree about it.
 */
export interface RecipientLocaleSources {
  /**
   * SEAM: `users.preferred_locale`, which does not exist as a column yet.
   *
   * Explicitly nullable rather than omitted, so adding the column is a change in one
   * repository query and not a change in this signature.
   */
  readonly accountLocale?: string | null;
  /** `orders.contact_locale` — `NOT NULL DEFAULT 'th'`, and meant to be updated. */
  readonly contactLocale?: string | null;
}

export function notificationLocale(sources: RecipientLocaleSources): RenderLocale {
  const account = sources.accountLocale?.trim();
  if (account !== undefined && account !== '') return resolveRenderLocale(account);

  const contact = sources.contactLocale?.trim();
  if (contact !== undefined && contact !== '') return resolveRenderLocale(contact);

  return { requested: '', rendered: FALLBACK_LOCALE, fallback: true };
}

/**
 * The language a **document** renders in: the one pinned at `submit_for_payment`.
 *
 * It takes the pinned value and *nothing else* — no preference, no header, no account.
 * That is the whole point of it being a separate function: a quotation reprinted next
 * year in a different language is not the same document, and the only way to guarantee
 * it cannot happen is for the code path that renders one to have no access to a
 * preference to accidentally prefer.
 *
 * A pinned value that is missing or unknown falls back like anything else, but says so:
 * a document rendered in the fallback because its pin was lost is a fact worth having in
 * the log rather than an invisible language change on a reprint.
 */
export function documentLocale(pinned: string | null | undefined): RenderLocale {
  const value = pinned?.trim();
  if (value === undefined || value === '') {
    return { requested: '', rendered: FALLBACK_LOCALE, fallback: true };
  }
  return resolveRenderLocale(value);
}
