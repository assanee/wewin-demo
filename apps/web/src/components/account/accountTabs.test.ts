import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_TABS,
  ACCOUNT_TAB_LABEL_KEYS,
  ACCOUNT_TAB_PARAM,
  DEFAULT_ACCOUNT_TAB,
  accountTabFromSearch,
  accountTabSearch,
} from './accountTabs';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ The one assertion here that is about money.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `MyQuotations` is the only customer-facing list of orders and therefore the only place the
 * `ชำระเงิน` link exists for somebody who closed the tab and came back. Moving that list behind
 * a tab is safe exactly as long as a **fresh visit to `/account` lands on it** — a visit with
 * no `?tab=`, which is every visit from the header menu, from a bookmark, and from a typed URL.
 *
 * So `a fresh visit lands on the quotations` below is not a test of a default value; it is the
 * test that the payment door added two days ago is still open. It fails if anybody flips
 * `DEFAULT_ACCOUNT_TAB`, reorders `ACCOUNT_TABS` and reads `[0]`, or makes the resolver fall
 * through to the password form on an input it does not recognise.
 *
 * Rendering is not available to it — `apps/web`'s vitest is `environment: 'node'` with no jsdom
 * on purpose — which is why the decision lives in `accountTabs.ts` as a function over a
 * `URLSearchParams` instead of inside `AccountScreen`'s state. The browser pass then confirms
 * the component actually asks this function; the file scan at the bottom is what stops that
 * wiring being quietly cut.
 */
describe('which account tab a visit lands on', () => {
  it('⭐ a fresh visit lands on the quotations, which is where the payment link is', () => {
    // No query string at all: the header link, a bookmark, a typed URL.
    expect(accountTabFromSearch(new URLSearchParams(''))).toBe('quotations');
  });

  it('a visit carrying unrelated parameters still lands on the quotations', () => {
    // `?order=` and friends reach this page from links elsewhere; none of them may move the tab.
    expect(accountTabFromSearch(new URLSearchParams('?order=abc&utm_source=email'))).toBe(
      'quotations',
    );
  });

  it('reads and writes the same parameter name', () => {
    // One spelling. A reader looking for `tab` and a writer emitting `section` would produce a
    // link that works when clicked and lands on the default when opened.
    expect(ACCOUNT_TAB_PARAM).toBe('tab');
    expect(accountTabSearch('password', new URLSearchParams(''))).toContain(ACCOUNT_TAB_PARAM);
    expect(accountTabFromSearch(new URLSearchParams(`?${ACCOUNT_TAB_PARAM}=password`))).toBe(
      'password',
    );
  });

  it('names the default rather than trusting the render order', () => {
    // The guard on "someone adds the shipping address at the front and reads ACCOUNT_TABS[0]".
    expect(DEFAULT_ACCOUNT_TAB).toBe('quotations');
    expect(ACCOUNT_TABS).toContain(DEFAULT_ACCOUNT_TAB);
  });

  it('honours a link that names a tab', () => {
    expect(accountTabFromSearch(new URLSearchParams('?tab=password'))).toBe('password');
    expect(accountTabFromSearch(new URLSearchParams('?tab=quotations'))).toBe('quotations');
  });

  it('falls back to the default on anything it does not recognise', () => {
    for (const query of ['?tab=', '?tab=Password', '?tab=billing', '?tab=address', '?tab=0']) {
      expect(accountTabFromSearch(new URLSearchParams(query))).toBe(DEFAULT_ACCOUNT_TAB);
    }
  });

  it('reads the first value when the parameter is repeated', () => {
    // `URLSearchParams.get` is first-wins; asserted rather than assumed, because the failure
    // would be a link with a stray duplicate silently landing on a blank panel.
    expect(accountTabFromSearch(new URLSearchParams('?tab=password&tab=billing'))).toBe('password');
  });
});

describe('what the tab writes back to the URL', () => {
  it('spells the default as no parameter, so /account stays /account', () => {
    expect(accountTabSearch('quotations', new URLSearchParams(''))).toBe('');
    expect(accountTabSearch('quotations', new URLSearchParams('?tab=password'))).toBe('');
  });

  it('names a non-default tab so the link can be shared', () => {
    expect(accountTabSearch('password', new URLSearchParams(''))).toBe('tab=password');
  });

  it('keeps every other parameter it was given', () => {
    expect(accountTabSearch('password', new URLSearchParams('?utm_source=email'))).toBe(
      'utm_source=email&tab=password',
    );
    expect(accountTabSearch('quotations', new URLSearchParams('?utm_source=email&tab=password'))).toBe(
      'utm_source=email',
    );
  });

  it('round-trips every tab through the URL', () => {
    for (const tab of ACCOUNT_TABS) {
      const query = accountTabSearch(tab, new URLSearchParams(''));
      expect(accountTabFromSearch(new URLSearchParams(query))).toBe(tab);
    }
  });
});

describe('the tabs are labelled from the catalogues', () => {
  it('gives every tab a key, and reuses the section titles', () => {
    for (const tab of ACCOUNT_TABS) {
      expect(ACCOUNT_TAB_LABEL_KEYS[tab]).toBeTypeOf('string');
    }
    // The two existing keys, not a second pair saying the same words. `catalogue.test.ts`
    // proves all eight locales define them.
    expect(ACCOUNT_TAB_LABEL_KEYS.quotations).toBe('account.myQuotations');
    expect(ACCOUNT_TAB_LABEL_KEYS.password).toBe('account.password.section');
  });
});

/**
 * ── The wiring, read from the source ─────────────────────────────────────────
 *
 * Everything above tests a function. None of it can tell whether `AccountScreen` still calls
 * it, and this app cannot render the component to find out — so the source is scanned for the
 * three things the browser pass verified and a later edit could silently drop.
 *
 * A scan is blunt, and it is the right instrument for the same reason `cache-policy.test.ts`
 * uses one: nothing goes wrong at the point the mistake is made. A tablist that lost
 * `aria-selected` looks identical on screen.
 *
 * ⚠️ Comments are stripped first. Every word this file greps for also appears in the prose
 * explaining it, and a scan that matched the explanation would pass a component that had lost
 * the code — which is exactly the false green `cache-policy.test.ts` documents.
 *
 * ⚠️⚠️ **And stripping the comments was not enough.** Mutation testing this block caught five
 * of ten breakages on the first pass, and every one of the five misses was the same shape: the
 * grep matched a *second, surviving* copy of the word rather than the code that was deleted.
 *
 *   - `accountTabFromSearch` and `SubmittedNotice` survive in the **import statement** when the
 *     call and the element are gone. So the scans below look for `accountTabFromSearch(search)`
 *     and `<SubmittedNotice`, not for the bare names.
 *   - `onKeyDown` survives as the **handler's own declaration** when the binding is unbound. So
 *     the scan looks for `onKeyDown={onKeyDown}`.
 *   - `role="tab"` survives inside `querySelectorAll('[role="tab"]')` when the attribute is
 *     gone from the element, and `focus-visible:outline-2` survives on the **panel** when it is
 *     stripped from the tabs.
 *
 * Those last two are why the element scans run against a slice of the JSX rather than the whole
 * file: `tabButton` is the one `<button …>` in this component, and an attribute asserted inside
 * it cannot be satisfied by a string literal three functions up.
 */
describe('AccountScreen is wired to this module', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'AccountScreen.tsx'),
    'utf8',
  );
  const code = source
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')
    .replaceAll(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replaceAll(/(^|[^:])\/\/.*$/gm, '$1');

  /** The single `<button …>` opening tag — the tab itself, with none of the file around it. */
  const tabButton = code.slice(code.indexOf('<button'), code.indexOf('>\n', code.indexOf('<button')));
  /** The `<section …>` opening tag that is the panel. */
  const panel = code.slice(code.indexOf('<section'), code.indexOf('>\n', code.indexOf('<section')));

  it('stripped the comments without stripping the component', () => {
    // Every scan below would pass or fail vacuously against an empty string.
    expect(code).toContain('export function AccountScreen');
    expect(code.length).toBeGreaterThan(400);
    expect(tabButton).toContain('<button');
    expect(tabButton.length).toBeGreaterThan(120);
    expect(panel).toContain('<section');
    expect(panel.length).toBeGreaterThan(80);
  });

  it('⭐ asks accountTabFromSearch which tab to show rather than hard-coding one', () => {
    // The call, not the import — see the header. This is the assertion that the URL, and so the
    // `?tab=` default that keeps the payment door open, actually reaches the component.
    expect(code).toContain('accountTabFromSearch(search)');
    expect(code).toContain('useUrlSearch()');
  });

  it('renders real tab semantics and not a row of buttons', () => {
    expect(code).toContain('role="tablist"');
    expect(code).toContain('role="tabpanel"');

    expect(tabButton).toContain('role="tab"');
    expect(tabButton).toContain('aria-selected');
    expect(tabButton).toContain('aria-controls');
    expect(tabButton).toContain('tabIndex');

    expect(panel).toContain('aria-labelledby');
  });

  it("keeps every tab's aria-controls pointing at a panel that exists", () => {
    /*
     * The browser found this one. Rendering only the selected panel left the *unselected* tab's
     * `aria-controls` aimed at nothing — a dangling IDREF, invisible on screen. The fix is a
     * panel per tab with `hidden` on the one not showing, so the scan is for both halves of it:
     * the panel is produced by mapping the tabs, and it takes `hidden`.
     */
    expect(panel).toContain('hidden=');
    expect(panel).toContain('id={panelId(candidate)}');
    expect(panel).toContain('aria-labelledby={tabId(candidate)}');
  });

  it('lets a keyboard reach the panel even when it holds no focusable content', () => {
    /*
     * `tabIndex={0}` on the panel. The quotations panel is a list of links when there are orders
     * and the bare sentence "ยังไม่มีใบเสนอราคา" when there are none, so without this a new
     * customer tabbing through the page skips from the tablist to the products link and never
     * hears why the account looked empty.
     *
     * ⚠️ Asserted on `panel` and not on `code`: the tabs carry their own roving
     * `tabIndex={isSelected ? 0 : -1}`, which satisfied a whole-file scan and let this be
     * deleted from the panel unnoticed.
     */
    expect(panel).toContain('tabIndex={0}');
  });

  it('moves between tabs with the arrow keys', () => {
    expect(code).toContain('ArrowRight');
    expect(code).toContain('ArrowLeft');
    // Home/End too: with the roving tabindex there is one Tab stop, so these are the only way
    // to reach the far tab in one press.
    expect(code).toContain("case 'Home'");
    expect(code).toContain("case 'End'");
    // The binding, not the handler's declaration.
    expect(code).toContain('onKeyDown={onKeyDown}');
  });

  it('keeps a visible focus ring on the tabs themselves', () => {
    expect(tabButton).toContain('focus-visible:outline-2');
    expect(tabButton).toContain('focus-visible:outline-sel-line');
  });

  it('writes the tab back without a history entry', () => {
    // `replaceState`, so Back leaves the account rather than walking through tabs, and no
    // router navigation asking the server for a page it already has.
    expect(code).toContain('accountTabSearch(');
    expect(code).toContain('window.history.replaceState');
    expect(code).not.toContain('pushState');
  });
});

/**
 * ── The cart no longer renders the quotation list ────────────────────────────
 *
 * The owner's actual complaint. Asserted here rather than trusted, because the section was in
 * `QuoteScreen` three times — once per cart state — and removing two of three is a change that
 * looks finished on the screen the author happened to be looking at.
 */
describe('the cart page does not render the account list', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'quote', 'QuoteScreen.tsx'),
    'utf8',
  );
  const code = source
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')
    .replaceAll(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replaceAll(/(^|[^:])\/\/.*$/gm, '$1');

  it('stripped the comments without stripping the component', () => {
    expect(code).toContain('export function QuoteScreen');
  });

  it('⭐ renders MyQuotations in none of its three cart states', () => {
    expect(code).not.toContain('MyQuotations');
  });

  it('⭐ still tells a customer who just submitted how to reach the quotation', () => {
    // The gap removing the list opens. `SubmittedNotice` carries the link to `?order=`, so the
    // customer who committed to a total is one press from the document — and from the payment
    // button on it. If this stops being rendered, the submit branch is a dead end.
    //
    // ⚠️ `<SubmittedNotice` and not `SubmittedNotice`: the bare name survives in the import
    // statement, so the loose spelling passed a mutation that replaced the element with `<p>`.
    expect(code).toContain('<SubmittedNotice');
    expect(code).toContain('justSubmitted.orderId');
  });
});
