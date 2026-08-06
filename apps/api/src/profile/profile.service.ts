import { Injectable } from '@nestjs/common';

import { coverageOf, normaliseLocale, resolveAgainst, type SupportedLocale } from '../i18n';
import { PREFERENCE_EFFECTS } from './preference-effects';
import type {
  MessageLocaleWire,
  PreferencesRequest,
  PreferencesResponseWire,
  PreferencesWire,
} from './profile.contract';
import { ProfileRepository, type StoredPreferences } from './profile.repository';

/**
 * Read, replace and forget a person's presentation preferences — and say what each one does.
 *
 * ── The single rule this service exists to keep ──────────────────────────────────
 *
 * **A preference is presentation, and this module is structurally incapable of being a
 * fourth way to change a stored number.** Sections 4.1 and 4.2 settled it before there was
 * any code, phase 2 pinned it for units (`toMicrons` is the *only* function allowed to
 * produce a new canonical length, and only from something a person typed) and phase 6a
 * pinned it for locale. Three properties keep it true here rather than merely intended, and
 * all three are checkable rather than argued:
 *
 *   ⓵ **Nothing in this directory imports a converter.** No `fromMicrons`, no `toMicrons`,
 *      no rate, no `formatMoney`. `tests/profile/no-conversion.test.ts` reads the source of
 *      every file under `src/profile/` and fails on one.
 *   ⓶ **No quantity crosses this module.** The response carries three enum values, four
 *      timestamps-or-nulls and twelve booleans. There is no `bigint` and no number that is a
 *      measure of anything — so there is nothing here for a preference to be multiplied into.
 *   ⓷ **Nothing references `user_preferences`.** The schema keeps that true from the other
 *      end (its header: "a row here cannot be a term of a contract"), which is what
 *      `order_documents.pinned_locale` is for.
 *
 * ── The second rule: an unhonoured preference must not look honoured ─────────────
 *
 * Every response carries `PREFERENCE_EFFECTS` — all twelve preference × surface pairs,
 * including the eight that are `false`. Eight of twelve is not a defect to hide; it is the
 * sum of four correct decisions (pinned documents, a cached storefront, a THB ledger, a
 * closed foreign-currency line) and the only defence against shipping a form that saves a
 * currency nobody will ever render is to answer with the arithmetic. See
 * `preference-effects.ts`, which is where each `false` is argued.
 */
@Injectable()
export class ProfileService {
  constructor(private readonly preferences: ProfileRepository) {}

  async read(userId: string): Promise<PreferencesResponseWire> {
    return present(await this.preferences.read(userId));
  }

  /**
   * The resource for a caller who has no account — and for one who has an account with no row.
   *
   * The same presenter, deliberately. `GET /me/preferences` is anonymous (see the controller
   * for why: the `effects` table is the honest half and the anonymous visitor is the main
   * funnel), and the cheapest way for that to go wrong is a second construction of the empty
   * answer that drifts from this one — an `effects` list that is stale in the anonymous branch,
   * a `messageLocale` that reports `degraded: true` for nobody. There is one branch.
   *
   * Synchronous by nature and `async` by signature, so the controller's two arms are the same
   * shape and neither needs a `void`-returning special case.
   */
  async empty(): Promise<PreferencesResponseWire> {
    return present(null);
  }

  /**
   * PUT: replace all three.
   *
   * All three `null` is not an error and is not a row of nulls — it is a delete, and the two
   * spellings deliberately reach the same code. `user_preferences_says_something` refuses a
   * row that prefers nothing, and that CHECK is load-bearing: the schema's header explains
   * that a table full of `('th','THB','mm')` rows nobody set would make a choice
   * indistinguishable from an absence, and an all-null row is the same mistake with fewer
   * columns. Letting the CHECK fire instead would answer a perfectly reasonable request with
   * a 500 out of a trigger.
   */
  async replace(userId: string, request: PreferencesRequest): Promise<PreferencesResponseWire> {
    const saysNothing =
      request.preferredLocale === null &&
      request.displayCurrency === null &&
      request.displayLengthUnit === null;

    if (saysNothing) return this.clear(userId);

    return present(await this.preferences.replace(userId, request));
  }

  /**
   * DELETE: back to having no preference at all.
   *
   * Answers the same shape as a read, which is what lets a screen re-render from one response
   * whichever button was pressed. Whether a row actually went is not reported: "you had none
   * and now have none" is the same state as "you had some and now have none", and turning the
   * first into a 404 would make a double-click an error.
   */
  async clear(userId: string): Promise<PreferencesResponseWire> {
    await this.preferences.clear(userId);
    return present(null);
  }
}

/**
 * A stored row (or its absence) as the wire carries it.
 *
 * ── Why `preferredLocale` is narrowed here and `requested` is not ────────────────
 *
 * The column is `text` with a *shape* CHECK, so it can hold `'ja'` — well-formed, and a
 * language this build has no catalogue for. Two different consumers need two different
 * answers about that row:
 *
 *   `preferences.preferredLocale` is what a **form control** is set from, so it is narrowed
 *   to one of the eight. A `<select>` whose value is not among its options renders as blank
 *   in some browsers and as the first option in others, and the second silently rewrites the
 *   person's stored preference the next time they press save.
 *
 *   `messageLocale.requested` is **verbatim**, because "they asked for something we do not
 *   have" is a fact worth keeping — it is the whole reason `RenderLocale` reports `requested`
 *   and `rendered` separately rather than letting a reader derive one from the other.
 *
 * A screen that shows the first and the second together is a screen that can say "you have
 * `ja` stored; this build cannot offer it" instead of quietly dropping it.
 */
function present(stored: StoredPreferences | null): PreferencesResponseWire {
  const preferences: PreferencesWire = {
    preferredLocale: narrowLocale(stored?.preferredLocale ?? null),
    displayCurrency: stored?.displayCurrency ?? null,
    displayLengthUnit: stored?.displayLengthUnit ?? null,
    updatedAt: stored?.updatedAt.toISOString() ?? null,
  };

  return {
    preferences,
    messageLocale: messageLocaleOf(stored?.preferredLocale ?? null),
    effects: PREFERENCE_EFFECTS,
  };
}

function narrowLocale(value: string | null): SupportedLocale | null {
  return value === null ? null : normaliseLocale(value);
}

/**
 * Plan 10.6's live half: what a message from this API would actually be written in today.
 *
 * ── The predicate, and why it is "has this locale any entry at all" ──────────────
 *
 * `resolveAgainst` takes a coverage predicate because coverage is genuinely per key —
 * `covers(locale, key)` is what an individual error message asks, so a 60%-translated
 * language renders its 60% in the reader's language rather than waiting for the last string.
 * A preferences screen is asking a different question: *will choosing this do anything at
 * all?* The honest predicate for that is "this locale has at least one entry", which makes
 * `degraded` mean exactly "everything you receive will be Thai" and nothing weaker.
 *
 * The partial case is not lost, it is reported as the two counts beside it. `en` today comes
 * back `degraded: false, translated: 11, total: 100` — not degraded, because eleven sentences
 * really do arrive in English, and visibly partial, because a screen can print `11/100`. A
 * `degraded` that were true for every locale short of complete would be permanently on, which
 * is the same as not being there — `RenderLocale`'s own header makes that argument for a
 * neighbouring case.
 *
 * The counts come from `coverageOf`, which reads the catalogue rather than a hand-kept list,
 * so the notice on the screen shrinks by itself as translations land and no test has to be
 * updated to let it.
 */
function messageLocaleOf(requested: string | null): MessageLocaleWire {
  const resolved = resolveAgainst(requested, (locale) => coverageOf(locale).translated > 0);
  const counts = coverageOf(resolved.rendered);

  return {
    requested: resolved.requested,
    rendered: resolved.rendered,
    degraded: resolved.degraded,
    /*
     * Counted for the locale that will actually be *rendered*, not for the one that was
     * asked for. A reader who chose German and is being sent Thai needs to know how complete
     * the Thai they are getting is (205/205), not how empty the German they are not getting
     * is — `degraded` is what tells them the substitution happened.
     */
    translated: counts.translated,
    total: counts.total,
  };
}
