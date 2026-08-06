'use client';

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { Check, Minus } from 'lucide-react';
import { LENGTH_UNITS, type LengthUnit } from '@wewin/core/units';

import { LOCALE_ENDONYMS, LOCALES, type Locale } from '../../i18n/locales';
import type { PlainKey } from '../../i18n/keys';
import type { Translate } from '../../i18n/translate';
import { useLocale } from '../../state/localeContext';
import { useDisplayUnit } from '../../state/displayUnitContext';
import {
  fetchPreferences,
  forgetPreferences,
  refreshAccessToken,
  savePreferences,
  type AccessToken,
} from '../../lib/preferences/client';
import type { PreferenceKind, PreferenceSurface, Preferences } from '../../lib/preferences/wire';

/**
 * The settings island — everything on `/[locale]/settings` that depends on who is reading.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HOW A SIGNED-IN PREFERENCE REACHES THE READER WITHOUT UN-CACHING ANYTHING
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Plan 8.2 trap 3, stated as the storefront's answer to it: *the storefront fixes currency per
 * locale and keeps the display unit in a client island precisely so a cached page never carries
 * one visitor's preference. A signed-in preference must not undo that.*
 *
 * It does not, because **the account is storage, not a channel.** The two mechanisms that
 * actually apply a preference are unchanged and both of them predate any account:
 *
 *   **language** → the `wewin.locale` cookie plus a navigation, through `LocaleProvider.setLocale`
 *   — the same call the header's `LanguagePicker` has always made. The locale is the first path
 *   segment (`lib/routing.ts`), so it is in every cache key *structurally*: choosing a language
 *   does not modify a cached page, it selects a different one. `src/proxy.ts` reads the cookie
 *   only on unprefixed URLs and answers `no-store` with the `Vary` that says why.
 *
 *   **unit** → `DisplayUnitProvider`'s `localStorage` key, through `setUnit`. Every cached page
 *   already contains all five renderings (`components/catalog/unitVariants.ts`); the island
 *   indexes into strings Node produced once from `bigint` micrometres. Nothing is converted in a
 *   browser and nothing per-reader was ever rendered on a server.
 *
 * So this component reads and writes the account, and applies nothing the anonymous visitor
 * could not already apply. **No page in this app renders differently because a request carried a
 * session** — which is the property `tests/preferences-cache.test.ts` checks by scanning for a
 * `fetch(`, a request-time API or an import of `lib/preferences/client` in any module that is
 * not `'use client'`.
 *
 * ── Why the storefront does not check for a session anywhere else ────────────────
 *
 * It would cost a `POST /auth/refresh` in front of every first paint, on a site whose pitch is
 * that you can price a window without signing in — and it would buy nothing that the cookie and
 * the storage key do not already deliver on the second page view. The consequence is honest and
 * visible rather than hidden: an account preference reaches a device by being *copied onto* it
 * here. When the account and the device disagree about language, this screen says so and offers
 * a button; it does not navigate the reader somewhere they did not ask to go, and it would have
 * to do that on every visit, because the header's language picker does not write to the account.
 *
 * ── Currency has no control, and that is the point ───────────────────────────────
 *
 * There is no currency `<select>` here. Every price is calculated and stored in THB minor units
 * (`orders_currency_is_thb`), `ProductCard` renders `f.baht(...)` in a *server* component so a
 * per-reader currency would need either the cache key or a `cookies()` read, and plan 13 keeps
 * the foreign-currency line closed until the owner answers five questions no engineer can
 * invent. A `<select>` offering nine currencies that changed nothing on any page would be the
 * exact failure this whole screen is built to avoid. What is here instead is the fact, the
 * reason, and — from the API rather than from this file — the four `false`s that prove it.
 *
 * ⚠️ A currency **already stored** on the account is preserved on every write below. This screen
 * has no control for it, which is not a licence to erase what another surface set.
 */
/**
 * `checking` until the session question is answered, then where the choice is kept and whether
 * the last write landed. Five states and no booleans: "signed in" and "saved" are different
 * facts, and a pair of booleans would make the fourth combination — saved but signed out —
 * representable and meaningless.
 */
type SaveStatus = 'checking' | 'local' | 'saving' | 'saved' | 'failed';

export function SettingsScreen(): ReactElement {
  const { locale, setLocale, t } = useLocale();
  const { unit, setUnit } = useDisplayUnit();

  const [token, setToken] = useState<AccessToken>(null);
  const [account, setAccount] = useState<Preferences | null>(null);
  const [status, setStatus] = useState<SaveStatus>('checking');

  /*
   * The account's unit is copied onto this device once, on the first successful load, and never
   * again. The guard is `DisplayUnitProvider`'s own, restated: "if a choice has already been
   * made, a preference arriving afterwards must not roll it back". Without the ref, a save that
   * re-read the account would fight the radio the reader had just pressed.
   */
  const syncedUnit = useRef(false);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const fresh = await refreshAccessToken();
      if (cancelled) return;

      setToken(fresh);
      const answer = await fetchPreferences(fresh);
      if (cancelled) return;

      if (answer.kind !== 'ok') {
        // `signed-out` is the ordinary state of a storefront visitor and is not an error;
        // `failed` here means the *read* failed, and the screen still works entirely on local
        // storage, so both land on the same honest label.
        setStatus('local');
        return;
      }

      setAccount(answer.preferences);
      setStatus(answer.preferences.preferences.updatedAt === null ? 'local' : 'saved');

      const stored = answer.preferences.preferences.displayLengthUnit;
      if (!syncedUnit.current && stored !== null && stored !== unit) {
        syncedUnit.current = true;
        setUnit(stored);
      }
    })();

    return () => {
      cancelled = true;
    };
    // Once, on mount. `unit` and `setUnit` are read inside and deliberately not depended on:
    // re-running this on every unit change would re-apply the account's unit over the reader's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Push the whole resource, because PUT replaces the whole resource.
   *
   * `displayCurrency` is carried through from what was read rather than sent as `null`: this
   * screen has no currency control, and a form that quietly cleared a field it does not show is
   * how a setting made somewhere else disappears.
   *
   * A caller with no token gets `signed-out` from the client and this becomes a no-op, which is
   * correct: the local change has already happened, and there is nowhere to record it.
   */
  const push = useCallback(
    async (next: { readonly locale?: Locale; readonly lengthUnit?: LengthUnit }): Promise<void> => {
      if (token === null) return;

      setStatus('saving');
      const result = await savePreferences(token, {
        preferredLocale: next.locale ?? account?.preferences.preferredLocale ?? locale,
        displayCurrency: account?.preferences.displayCurrency ?? null,
        displayLengthUnit: next.lengthUnit ?? account?.preferences.displayLengthUnit ?? unit,
      });

      if (result.kind === 'ok') {
        setAccount(result.preferences);
        setStatus('saved');
        return;
      }
      // Signed out mid-session is reported the same way a network failure is, because the reader
      // can do the same thing about both and the local half of the change already happened —
      // a silent partial success is how somebody comes to believe a setting is stored.
      setStatus(result.kind === 'signed-out' ? 'local' : 'failed');
    },
    [account, locale, token, unit],
  );

  const chooseUnit = (next: LengthUnit): void => {
    setUnit(next);
    void push({ lengthUnit: next });
  };

  const chooseLocale = (next: Locale): void => {
    // The write goes first and is awaited: `setLocale` is a full document load, and a fetch
    // started immediately before one is a fetch the browser may cancel.
    void push({ locale: next }).then(() => {
      setLocale(next);
    });
  };

  const accountLocale = account?.preferences.preferredLocale ?? null;

  return (
    <div className="mt-10 flex max-w-180 flex-col gap-10">
      <StorageLine
        t={t}
        status={status}
        updatedAt={account?.preferences.updatedAt ?? null}
        signedIn={token !== null}
      />

      {/* ---- Language ------------------------------------------------------ */}
      <fieldset className="min-w-0">
        <legend className="text-caption tracking-[0.08em] text-chalk-3 uppercase">
          {t('settings.language.legend')}
        </legend>

        <select
          value={locale}
          aria-label={t('settings.language.legend')}
          onChange={(event) => {
            const match = LOCALES.find((candidate) => candidate === event.target.value);
            if (match) chooseLocale(match);
          }}
          className="mt-3 min-h-11 w-full rounded-xs border border-line bg-panel-2 px-3 text-body text-chalk hover:border-line-2 md:w-72"
        >
          {LOCALES.map((candidate) => (
            <option key={candidate} value={candidate} lang={candidate}>
              {LOCALE_ENDONYMS[candidate]}
            </option>
          ))}
        </select>

        {accountLocale !== null && accountLocale !== locale ? (
          <p className="mt-3 flex flex-wrap items-center gap-3 text-small text-chalk-2">
            <span>
              {t('settings.language.accountDiffers', { language: LOCALE_ENDONYMS[accountLocale] })}
            </span>
            <button
              type="button"
              onClick={() => {
                setLocale(accountLocale);
              }}
              className="min-h-11 rounded-xs border border-line px-3 text-small text-chalk hover:border-line-2"
            >
              {t('settings.language.applyAccount')}
            </button>
          </p>
        ) : null}
      </fieldset>

      {/* ---- Unit ---------------------------------------------------------- */}
      <fieldset className="min-w-0">
        <legend className="text-caption tracking-[0.08em] text-chalk-3 uppercase">
          {t('settings.unit.legend')}
        </legend>

        <div
          role="radiogroup"
          aria-label={t('settings.unit.legend')}
          className="mt-3 grid grid-cols-5 overflow-hidden rounded-xs border border-line md:w-72"
        >
          {LENGTH_UNITS.map((candidate) => (
            <label key={candidate} className="flex min-h-11 min-w-0 items-center justify-center">
              <input
                type="radio"
                name="settings-display-unit"
                value={candidate}
                checked={candidate === unit}
                onChange={() => {
                  chooseUnit(candidate);
                }}
                aria-label={t(UNIT_NAME_KEYS[candidate])}
                className="peer sr-only"
              />
              <span
                className={`flex h-full w-full items-center justify-center border-b-2 px-1 text-small peer-focus-visible:outline-2 peer-focus-visible:-outline-offset-2 peer-focus-visible:outline-sel-line ${
                  candidate === unit
                    ? 'border-sel-line bg-sel-bg text-chalk'
                    : 'border-transparent bg-panel-2 text-chalk-2 hover:text-chalk'
                }`}
              >
                {candidate}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {/* ---- Currency: a fact, not a control ------------------------------- */}
      <section className="min-w-0">
        <h2 className="text-caption tracking-[0.08em] text-chalk-3 uppercase">
          {t('settings.currency.legend')}
        </h2>
        {/*
         * `THB` is not localised and is not a translation: an ISO 4217 code is an identifier,
         * and `f.baht` is the only thing in this app that renders an amount. Handing the code to
         * the catalogue as a param keeps the sentence around it the translator's.
         */}
        <p className="numeric mt-3 text-body text-chalk">
          {t('settings.currency.fixed', { currency: 'THB' })}
        </p>
        <p className="mt-2 text-small text-chalk-2">{t('settings.currency.why')}</p>
      </section>

      {/* ---- The language messages actually arrive in — plan 10.6 ---------- */}
      {account !== null && account.messageLocale.degraded ? (
        <section className="min-w-0">
          <h2 className="text-caption tracking-[0.08em] text-chalk-3 uppercase">
            {t('settings.messages.heading')}
          </h2>
          <p className="mt-3 text-body text-chalk-2">
            {t('settings.messages.degraded', {
              chosen: endonymOf(account.messageLocale.requested),
              rendered: LOCALE_ENDONYMS[account.messageLocale.rendered],
            })}
          </p>
          <p className="numeric mt-2 text-small text-chalk-3">
            {t('settings.messages.coverage', {
              translated: account.messageLocale.translated,
              total: account.messageLocale.total,
            })}
          </p>
        </section>
      ) : null}

      {/* ---- What these settings change, from the API ---------------------- */}
      {account !== null ? <EffectList t={t} effects={account.effects} /> : null}

      {token !== null && account !== null && account.preferences.updatedAt !== null ? (
        <button
          type="button"
          onClick={() => {
            void (async () => {
              setStatus('saving');
              const result = await forgetPreferences(token);
              if (result.kind === 'ok') {
                setAccount(result.preferences);
                setStatus('local');
                return;
              }
              setStatus(result.kind === 'signed-out' ? 'local' : 'failed');
            })();
          }}
          className="min-h-11 self-start rounded-xs border border-line px-3 text-small text-chalk-2 hover:border-line-2 hover:text-chalk"
        >
          {t('settings.storage.forget')}
        </button>
      ) : null}
    </div>
  );
}

/**
 * Where the choice is kept, which is the whole product difference between signed in and not.
 *
 * Hoisted to module scope rather than nested inside `SettingsScreen`, and `t` comes in as a prop.
 * A component declared inside another component is a *new component type on every render*, so
 * React unmounts and remounts it — which throws away focus and any state it might grow later.
 * The cost is passing `t`; the benefit is that this stays a plain function of its props.
 */
function StorageLine({
  t,
  status,
  updatedAt,
  signedIn,
}: {
  readonly t: Translate;
  readonly status: SaveStatus;
  readonly updatedAt: string | null;
  readonly signedIn: boolean;
}): ReactElement | null {
  // Nothing at all until the session question has been answered. A "kept in this browser only"
  // line that flips to "saved to your account" a round trip later reads as the page correcting
  // itself, which is the same argument `UnitPicker` makes for not animating its segments.
  if (status === 'checking') return null;

  if (status === 'failed') {
    return <p className="text-small text-danger">{t('settings.storage.failed')}</p>;
  }
  if (status === 'saving') {
    return <p className="text-small text-chalk-3">{t('settings.storage.saving')}</p>;
  }
  if (status === 'saved' && updatedAt !== null) {
    const at = new Date(updatedAt);
    // A timestamp the server sent that this browser cannot parse is not worth a broken date on a
    // settings page; the local line below is true either way.
    if (!Number.isNaN(at.getTime())) {
      return <p className="text-small text-chalk-2">{t('settings.storage.account', { at })}</p>;
    }
  }

  return (
    <p className="text-small text-chalk-2">
      {t('settings.storage.local')}
      {signedIn ? null : <> {t('settings.storage.signIn')}</>}
    </p>
  );
}

/**
 * The twelve statements, as the API sends them.
 *
 * Rendered rather than decided. Eight are `false` today — a document is pinned at submit, the
 * storefront is prerendered, the ledger is in baht, plan 13 keeps the foreign line closed — and
 * every one of them is a sentence somebody would otherwise have to discover for themselves. The
 * `false` rows are **shown, not hidden**: hiding them makes the *absence* the message, which is
 * the mistake plan 9.5 refuses when it says not to print "no reviews yet" on 81 pages.
 */
function EffectList({
  t,
  effects,
}: {
  readonly t: Translate;
  readonly effects: Preferences['effects'];
}): ReactElement | null {
  if (effects.length === 0) return null;

  return (
    <section className="min-w-0">
      <h2 className="text-caption tracking-[0.08em] text-chalk-3 uppercase">
        {t('settings.effects.heading')}
      </h2>
      <p className="mt-2 text-small text-chalk-3">{t('settings.effects.intro')}</p>

      <ul className="mt-4 flex flex-col gap-2">
        {effects.map((effect) => (
          <li
            key={`${effect.preference}/${effect.surface}`}
            className="flex items-start gap-3 text-small"
          >
            {effect.honoured ? (
              <Check size={16} aria-hidden className="mt-0.5 shrink-0 text-chalk" />
            ) : (
              <Minus size={16} aria-hidden className="mt-0.5 shrink-0 text-chalk-3" />
            )}
            <span className={effect.honoured ? 'text-chalk-2' : 'text-chalk-3'}>
              {t(EFFECT_LABEL_KEYS[effect.preference][effect.surface])}
            </span>
            {/* The state in words as well as in a glyph: a tick and a dash are the same shape to
                a screen reader, and this list is exactly what a reader came here to find out. */}
            <span className="sr-only">
              {effect.honoured ? t('settings.effect.yes') : t('settings.effect.no')}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The account's own language name, when the stored tag is one this build knows. */
function endonymOf(requested: string | null): string {
  const match = LOCALES.find((candidate) => candidate === requested);
  // A tag the API stored that this build has no name for — `packages/db`'s CHECK is a shape check,
  // so the column can legally hold one. Printed verbatim rather than dropped: the reader is the
  // only person who can tell us what they meant by it.
  return match === undefined ? (requested ?? '') : LOCALE_ENDONYMS[match];
}

/**
 * Spoken names for the units, keyed rather than written: `mm` and `m` are one character apart
 * and a screen reader announcing "em" twice tells the customer nothing. Lifted from
 * `UnitPicker`, which makes the same argument at more length.
 */
const UNIT_NAME_KEYS: Record<LengthUnit, PlainKey> = {
  mm: 'unit.name.mm',
  cm: 'unit.name.cm',
  m: 'unit.name.m',
  in: 'unit.name.in',
  ft: 'unit.name.ft',
};

/**
 * A sentence for every preference × surface the API can name.
 *
 * A full `Record` of `Record`s and not a lookup with a fallback: a preference or a surface added
 * to the API and forgotten here is a **compile error in this file**, rather than a blank row
 * with a tick beside it on a screen whose entire job is to be believed. The wire decoder drops
 * rows this build does not recognise, so the two mechanisms together mean a row is either fully
 * labelled or absent — never half-rendered.
 */
const EFFECT_LABEL_KEYS: Record<PreferenceKind, Record<PreferenceSurface, PlainKey>> = {
  locale: {
    notification: 'settings.effect.locale.notification',
    document: 'settings.effect.locale.document',
    storefront: 'settings.effect.locale.storefront',
    dashboard: 'settings.effect.locale.dashboard',
  },
  currency: {
    notification: 'settings.effect.currency.notification',
    document: 'settings.effect.currency.document',
    storefront: 'settings.effect.currency.storefront',
    dashboard: 'settings.effect.currency.dashboard',
  },
  lengthUnit: {
    notification: 'settings.effect.lengthUnit.notification',
    document: 'settings.effect.lengthUnit.document',
    storefront: 'settings.effect.lengthUnit.storefront',
    dashboard: 'settings.effect.lengthUnit.dashboard',
  },
};
