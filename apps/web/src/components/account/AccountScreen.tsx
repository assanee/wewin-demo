'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';

import type { Session } from '../../lib/auth/account';
import { localeHref } from '../../lib/routing';
import { useLocale } from '../../state/localeContext';
import { useUrlSearch } from '../../state/useUrlSearch';
import { AccountGate } from './AccountGate';
import { ChangePassword } from './ChangePassword';
import { MyProfile } from './MyProfile';
import { MyQuotations } from './MyQuotations';
import { MyReviews } from './MyReviews';
import {
  ACCOUNT_TABS,
  ACCOUNT_TAB_LABEL_KEYS,
  DEFAULT_ACCOUNT_TAB,
  accountTabFromSearch,
  accountTabSearch,
  type AccountTab,
} from './accountTabs';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The account page: sign in here, and see what has been asked for.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠️ **"บัญชีของฉัน" and not "ใบเสนอราคาของฉัน"**, and the difference is about what comes
 * next rather than about wording. A shipping address and a change of password belong on this
 * page, and a menu named after one of its sections has to be renamed the day a second arrives
 * — by which time customers have learned the old name and links to it exist.
 *
 * So the page is the account and the quotations are one **tab** of it. Adding the next one is
 * an entry in `ACCOUNT_TABS`, a label key and a branch in `AccountPanel`, with nothing above it
 * to reconsider — and the third tab, `ข้อมูลผู้ใช้งาน`, arrived that way and proved the claim
 * half true. The list, the label and the URL cost three lines exactly as promised. The **panel**
 * did not: it was a two-armed ternary, which is correct for two tabs and silently serves the
 * password form for a third. See `AccountPanel` at the bottom of this file for what replaced it
 * and why the replacement is a `switch` with no `default`.
 *
 * ── The sections are tabs, and the default one is not a style choice ─────────
 *
 * ⭐ **A fresh visit must land on the quotations, because that is where the `ชำระเงิน` link
 * is.** `MyQuotations` is the only customer-facing list of orders, so it holds the only door to
 * the payment screen for somebody who closed the tab and came back the next day. Behind a tab
 * that a bare `/th/account` does not open, that door is shut. `accountTabs.ts` carries the
 * decision, the argument and the test; this component only obeys it.
 *
 * ── Hand-rolled, because there is nothing here to lean on ────────────────────
 *
 * `apps/dashboard` has `components/ui/tabs.tsx` over Radix. `apps/web` has no component
 * library and no Radix, deliberately — adding one for a handful of tabs would be a new dependency
 * in the bundle every customer downloads. It does have a **house dialect for exactly this**, and
 * this follows it rather than inventing a second: `OptionGroupBase` is the roving-tabindex
 * keyboard group (container `onKeyDown`, `querySelectorAll` by role, wrap, Home/End), and
 * `UnitPicker` is the segmented look (one hairline frame, `bg-sel-bg` fill, `border-sel-line`
 * rule under the selected segment carrying the state as a *shape* as well as a colour, and an
 * inset focus ring because the frame clips an outset one).
 *
 * ⚠️ Those two are `radiogroup`s and this is not, which is the one place the dialect could not
 * be copied wholesale. A radio group is "pick a value"; a tab set is "show me that part", and
 * a screen reader has to say "tab, 1 of 3, selected" and be able to jump to the panel. Hence
 * real `role="tab"`/`role="tabpanel"` with `aria-controls`/`aria-labelledby` rather than the
 * native radios `UnitPicker` gets its arrow keys free from.
 *
 * ⚠️ **No headings inside the panels.** The tab *is* the section's name — it is what
 * `aria-labelledby` points the panel at — and repeating `ใบเสนอราคาของฉัน` as an `h2` directly
 * under a selected tab of the same words is a duplicate to a screen reader and noise on screen.
 * The old `<Section>` wrapper is gone with them: `h1` is still the page, and the outline below
 * it is the tablist.
 *
 * ⚠️ **Every panel is rendered, with `hidden` on the ones not showing** — and this is a
 * reversal that the browser caught. Rendering only the selected panel is what Radix does by
 * default and it looked right; reading the live accessibility tree showed the consequence, which
 * is that the *unselected* tab's `aria-controls` points at an element that does not exist. A
 * dangling IDREF is a real defect and it is invisible on screen, which is the only kind this
 * page is likely to keep.
 *
 * The cost of the fix is that every panel's mount effect runs on every visit: `GET /orders?limit=50`
 * for a customer sitting on the password tab, and — since `ข้อมูลผู้ใช้งาน` landed — `GET /me/account`
 * beside it. That is worth an accurate accessibility tree, and it buys something else: the password
 * form keeps what has been typed into it across a tab press, where unmounting would have silently
 * emptied three fields.
 *
 * ⚠️ The wording above is deliberately not a *count* of panels or of requests. Both numbers have
 * already changed once, and a comment that says "both" over three things is the same defect this
 * project's catalogue shipped as "all four" over a three-item list.
 *
 * No transition on the tab change. There is nothing to animate that would tell the customer
 * anything, so there is nothing for `prefers-reduced-motion` to have an opinion about.
 */
export function AccountScreen(): ReactElement {
  const { t, locale } = useLocale();

  /*
   * The query string, `''` until the browser has it — never `useSearchParams()`, which would
   * force a `<Suspense>` boundary and put its fallback in the prerendered HTML of all eight
   * shells. `state/useUrlSearch.ts` is the long version.
   *
   * ⚠️ It matters here that the pre-hydration value resolves to the *default* tab: the server
   * render, the first client render and a visit with no `?tab=` are then the same markup, and
   * a `?tab=password` link arrives one commit later as an ordinary state update rather than as
   * a hydration mismatch React would paper over silently.
   */
  const search = useUrlSearch();
  const fromUrl = accountTabFromSearch(search);
  const [tab, setTab] = useState<AccountTab>(DEFAULT_ACCOUNT_TAB);

  /*
   * The URL is the seed, not the authority. `search` only changes on hydration and on
   * `popstate`, so this does not fight the click below — which writes the URL with
   * `replaceState`, and `replaceState` fires no `popstate`.
   */
  useEffect(() => {
    setTab(fromUrl);
  }, [fromUrl]);

  const tablistRef = useRef<HTMLDivElement>(null);
  // One id per mount, because two account screens in one document would otherwise share
  // `aria-controls` targets and point every tab at the first one's panel.
  const idBase = useId();
  const tabId = (candidate: AccountTab) => `${idBase}-tab-${candidate}`;
  const panelId = (candidate: AccountTab) => `${idBase}-panel-${candidate}`;

  const select = (next: AccountTab) => {
    setTab(next);

    /*
     * `history.replaceState`, as `CatalogBrowser` does: the URL is a bookmark of an
     * interaction, not a request for another document, and a router navigation would ask the
     * server for a page it already has. No history entry either — Back should leave the
     * account, not walk back through tabs.
     */
    const query = accountTabSearch(next, new URLSearchParams(window.location.search));
    window.history.replaceState(null, '', query === '' ? window.location.pathname : `?${query}`);
  };

  /**
   * Arrow keys across the tabs, with focus and selection moving together.
   *
   * Automatic activation is what the ARIA practices call for when showing a panel is
   * immediate, and it is what the two existing groups in this app already do — arrowing in
   * `OptionGroupBase` selects as it moves. With every panel already in the
   * bundle there is nothing an explicit `Enter` would be protecting the customer from.
   *
   * ⚠️ Left/Right and Home/End only. This tablist is horizontal, and binding Up/Down would
   * take the page scroll away from a keyboard user standing on a tab.
   */
  const moveFocus = (index: number) => {
    const tabs = [...(tablistRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])];
    if (tabs.length === 0) return;

    const target = tabs[(index + tabs.length) % tabs.length];
    const next = target?.dataset['tab'];
    if (target === undefined || next === undefined) return;

    target.focus();
    if ((ACCOUNT_TABS as readonly string[]).includes(next)) select(next as AccountTab);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const tabs = [...(tablistRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])];
    const current = tabs.findIndex((element) => element === document.activeElement);
    if (current === -1) return;

    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault();
        moveFocus(current + 1);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        moveFocus(current - 1);
        break;
      case 'Home':
        event.preventDefault();
        moveFocus(0);
        break;
      case 'End':
        event.preventDefault();
        moveFocus(tabs.length - 1);
        break;
      default:
        break;
    }
  };

  return (
    <AccountGate>
      {(session) => (
        <div className="flex flex-col gap-4">
          <h1 className="text-title text-chalk">{t('account.title')}</h1>

          <div className="flex flex-col">
            <div
              ref={tablistRef}
              role="tablist"
              aria-label={t('account.tabs.label')}
              onKeyDown={onKeyDown}
              // One frame around the set, `-mb-px` so the panel's own top border sits on the
              // tablist's bottom one rather than beside it as a two-pixel seam.
              className="-mb-px flex min-w-0 flex-wrap"
            >
              {ACCOUNT_TABS.map((candidate) => {
                const isSelected = candidate === tab;

                return (
                  <button
                    key={candidate}
                    type="button"
                    role="tab"
                    id={tabId(candidate)}
                    data-tab={candidate}
                    aria-selected={isSelected}
                    aria-controls={panelId(candidate)}
                    // Roving tabindex: one Tab stop for the whole set, then arrows within it.
                    // Without this a keyboard user pays one Tab press per section to get past
                    // the header of a page whose first control is a link.
                    tabIndex={isSelected ? 0 : -1}
                    onClick={() => select(candidate)}
                    // The fill alone would leave the current tab legible only to somebody who
                    // can separate #33421f from #202519, so the rule under the label carries
                    // the state as a shape too. Both states reserve it, or selecting one would
                    // shift the row by two pixels.
                    //
                    // The ring is offset inwards to match `UnitPicker` — the panel frame below
                    // clips an outset one on the first tab.
                    className={`min-h-11 min-w-0 border border-b-2 px-4 py-2 text-small focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sel-line ${
                      isSelected
                        ? 'border-line border-b-sel-line bg-sel-bg text-chalk'
                        : 'border-transparent border-b-line bg-panel-2 text-chalk-2 hover:text-chalk'
                    }`}
                  >
                    {t(ACCOUNT_TAB_LABEL_KEYS[candidate])}
                  </button>
                );
              })}
            </div>

            {/*
              ⚠️ `tabIndex={0}` on the panel, which the ARIA practices ask for only when a panel
              has no focusable content — and this one is the reason the rule exists. The
              quotations panel is a list of links when there are orders and the bare sentence
              "ยังไม่มีใบเสนอราคา" when there are none, so on a new account arrowing off the
              tablist would otherwise skip straight past the panel to the products link and the
              customer would never hear why the page was empty. A `hidden` panel is not
              focusable, so this adds one stop and not two.
            */}
            {ACCOUNT_TABS.map((candidate) => (
              <section
                key={candidate}
                role="tabpanel"
                id={panelId(candidate)}
                aria-labelledby={tabId(candidate)}
                hidden={candidate !== tab}
                tabIndex={0}
                className="border border-line bg-panel p-4 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sel-line"
              >
                <AccountPanel tab={candidate} session={session} />
              </section>
            ))}
          </div>

          {/*
            The next section goes here — a shipping address — as an entry in `ACCOUNT_TABS`, a
            label key and one more branch in `AccountPanel`.

            ⚠️ Append it, do not put it first, and do not touch `DEFAULT_ACCOUNT_TAB`: a fresh
            visit landing on anything but the quotations closes the only payment door a
            returning customer has. `accountTabs.ts` argues it and its test proves it.
          */}

          <a
            className="w-fit border border-line px-4 py-2 text-small text-chalk"
            href={localeHref(locale, '/products')}
          >
            {t('nav.products')}
          </a>
        </div>
      )}
    </AccountGate>
  );
}

/**
 * ⭐ Which section's content a panel holds — an exhaustive `switch`, and that is the point.
 *
 * ⚠️ **This replaced a two-armed ternary, which was a trap with a third tab in it.** The old form
 * was `candidate === 'quotations' ? <MyQuotations/> : <ChangePassword/>`: correct for two tabs,
 * and *silently wrong* for three. Appending `profile` to `ACCOUNT_TABS` would have given the new
 * tab a label, a URL, a panel, an accessible name and the password form inside it — a defect that
 * typechecks, renders, and is invisible to every scan in `accountTabs.test.ts`, because a panel
 * holding the wrong component still holds a component.
 *
 * A `switch` over the union with **no `default` and a declared return type** cannot do that: a
 * fourth tab added to `ACCOUNT_TABS` without a branch here is `error TS2366`, "function lacks
 * ending return statement". That is the same mechanism `matchScope` and `matchUserStatus` exist
 * for on the API side, and it is why this is a function rather than a longer ternary — a `default`
 * or an `else` would restore exactly the failure it is here to prevent.
 */
function AccountPanel({
  tab,
  session,
}: {
  readonly tab: AccountTab;
  readonly session: Session;
}): ReactElement {
  switch (tab) {
    case 'quotations':
      return <MyQuotations session={session} />;
    case 'reviews':
      return <MyReviews session={session} />;
    case 'password':
      return <ChangePassword session={session} />;
    case 'profile':
      return <MyProfile session={session} />;
  }
}
