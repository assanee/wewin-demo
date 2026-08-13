import type { PlainKey } from '../../i18n/keys';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Which section of the account is showing, and — the part that carries risk —
 * which one shows when nobody said.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⭐ **`/account` is a payment entry point, and the default tab is what keeps it one.**
 *
 * `MyQuotations` renders a `ชำระเงิน` link per payable order, and its own header records why
 * that link is load-bearing: it is the door for a customer who closed the tab and came back
 * the next day with neither the quotation open nor the email to hand. There is no other
 * customer-facing list of orders, so that link exists in exactly one place.
 *
 * Putting the quotations behind a tab therefore *moves* that door, and moving it behind a tab
 * a fresh visit does not land on would close it: the customer would arrive at `/th/account`,
 * see a password form, and have to guess. So `DEFAULT_ACCOUNT_TAB` is the quotations, and an
 * absent, empty or unrecognised `?tab=` resolves to it rather than to the first entry of some
 * list that a later edit could reorder.
 *
 * That is a one-line fact with a two-day blast radius, which is why it is a named constant in
 * a module of its own with a test on it rather than a `useState('quotations')` inside a
 * component that cannot be rendered by this app's test environment (`environment: 'node'`, no
 * jsdom — deliberately; see `vitest.config.ts`).
 *
 * ── Why the tab is in the query string at all ────────────────────────────────
 *
 * Because the alternative is a section of the account that nothing can link to. `?tab=` means
 * a future "change your password" prompt, a support reply, or a bookmark can name a section;
 * without it the password form is reachable only by arriving and clicking. The cost is one
 * parameter and it is read the way this app reads every parameter — by the client island,
 * through `useUrlSearch`, never by the page (`searchParams` on a page opts the route out of
 * static rendering, which is plan 8.2's second trap and what `tests/cache-policy.test.ts`
 * scans for).
 *
 * ⚠️ The reverse direction — writing the tab back on a click — uses `history.replaceState`
 * rather than a router navigation, the same as `CatalogBrowser`: the URL is a bookmark of an
 * interaction here, not a request for another document. It also deliberately leaves no history
 * entry, so Back from `/account` returns to wherever the customer came from rather than
 * stepping them through two tabs first.
 */

/** The query-string parameter. One spelling, shared by the reader and the writer. */
export const ACCOUNT_TAB_PARAM = 'tab';

/**
 * The tabs, in the order they are rendered.
 *
 * ⚠️ The order is presentation only. Nothing may read `ACCOUNT_TABS[0]` as "the default" —
 * `DEFAULT_ACCOUNT_TAB` says which one that is, so that adding the shipping address at the
 * front cannot silently take the payment door off a fresh visit.
 */
export const ACCOUNT_TABS = ['quotations', 'password'] as const;

export type AccountTab = (typeof ACCOUNT_TABS)[number];

/**
 * ⭐ What a fresh visit to `/account` lands on. See the header: this is the payment door.
 */
export const DEFAULT_ACCOUNT_TAB: AccountTab = 'quotations';

/**
 * The catalogue key each tab is labelled with.
 *
 * Both are existing keys, reused rather than reinvented, and they read as labels because they
 * were already written as section titles: `ใบเสนอราคาของฉัน` and `เปลี่ยนรหัสผ่าน` are noun
 * phrases naming a part of the account in all eight locales. A second pair of keys saying the
 * same words would be eight more strings to keep in step with these ones for no gain.
 */
export const ACCOUNT_TAB_LABEL_KEYS: Record<AccountTab, PlainKey> = {
  quotations: 'account.myQuotations',
  password: 'account.password.section',
};

const isAccountTab = (value: string): value is AccountTab =>
  (ACCOUNT_TABS as readonly string[]).includes(value);

/**
 * The tab a URL asks for, or the default.
 *
 * Total by construction: every input that is not exactly one of the known tab names — absent,
 * empty, `?tab=Password`, `?tab=billing`, a repeated parameter — resolves to
 * `DEFAULT_ACCOUNT_TAB`. A hand-typed or stale link therefore lands on the quotations rather
 * than on a blank panel, which is the same failure as landing on the wrong tab.
 */
export function accountTabFromSearch(search: URLSearchParams): AccountTab {
  const asked = search.get(ACCOUNT_TAB_PARAM);
  return asked !== null && isAccountTab(asked) ? asked : DEFAULT_ACCOUNT_TAB;
}

/**
 * The query string `/account` should carry for a tab — `''` for the default.
 *
 * The default is spelled as *no parameter* rather than as `?tab=quotations`, so that the
 * canonical account URL stays `/th/account` and pressing the first tab does not decorate it.
 */
export function accountTabSearch(tab: AccountTab, from: URLSearchParams): string {
  const params = new URLSearchParams(from);
  if (tab === DEFAULT_ACCOUNT_TAB) params.delete(ACCOUNT_TAB_PARAM);
  else params.set(ACCOUNT_TAB_PARAM, tab);
  return params.toString();
}
