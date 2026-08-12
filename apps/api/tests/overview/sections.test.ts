import { describe, expect, it } from 'vitest';

import { OVERVIEW_SECTIONS, visibleSections, type OverviewSection } from '../../src/overview/sections';
import type { PermissionCode } from '../../src/rbac/permissions';
import { PUBLIC_SCOPE, guestScope, systemScope, userScope } from '../../src/rbac/scope';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * A COUNT IS A DISCLOSURE.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The overview is the one screen that reads across every subsystem at once, which makes it
 * the one screen where a permission mistake leaks from a subsystem the reader was never
 * meant to know exists. "3 slips waiting" tells somebody with no payments permission that
 * the company takes payment by slip, that a review step exists, and roughly how busy it is.
 * None of those are in the number; all of them are in having been shown it.
 *
 * So the gate is per *card*, not per endpoint, and the rule it enforces is narrower than
 * "does this person have some payments permission":
 *
 *   ⭐ **Never show a count the reader could not have obtained by opening its queue.**
 *
 * That is why `slips` asks for two codes. `GET /payments/slips` — the screen the number is
 * about — is `@RequirePermissions('payments.read', 'orders.read')`, so a card summarising
 * it must ask for the same pair or it becomes a way to read past a permission by looking at
 * the total instead of the list.
 *
 * `absence-is-not-zero.pg.test.ts` proves the other half over HTTP: a card you may not see
 * is a **missing key**, never a zero. This file proves the table those two facts rest on.
 */

/** A signed-in person holding exactly these codes and nothing else. */
const holding = (...permissions: readonly PermissionCode[]) =>
  userScope({
    userId: '00000000-0000-4000-8000-000000000001',
    sessionId: '00000000-0000-4000-8000-000000000002',
    groupIds: [],
    permissions: new Set(permissions),
  });

describe('the section table', () => {
  it('asks, for every card, exactly what its own queue asks', () => {
    /*
     * Written out rather than derived. A derivation would restate the production table in
     * the test's own words and agree with it by construction — including when both are
     * wrong. These pairs were read off the controllers one at a time:
     *
     *   orders          orders.read                     (the order list)
     *   slips           payments.read + orders.read     slip-review.controller.ts
     *   refunds         payments.read                   refunds.controller.ts
     *   money           payments.read                   the ledger is a payments surface
     *   quotes          quotes.read + quotes.approve    approvals.controller.ts' queue route,
     *                                                   which is where the card now links
     *   reviews         reviews.moderate                reviews-admin.controller.ts
     *   notifications   orders.read                     notifications.controller.ts, borrowed
     *   catalog         catalog.read                    catalog-admin.controller.ts
     *   users           users.read                      users.controller.ts
     */
    expect(OVERVIEW_SECTIONS).toStrictEqual({
      orders: ['orders.read'],
      slips: ['payments.read', 'orders.read'],
      refunds: ['payments.read'],
      money: ['payments.read'],
      quotes: ['quotes.read', 'quotes.approve'],
      reviews: ['reviews.moderate'],
      notifications: ['orders.read'],
      catalog: ['catalog.read'],
      users: ['users.read'],
    });
  });
});

describe('⭐ which cards a person may see', () => {
  it('gives a catalogue editor the catalogue and nothing else', () => {
    /*
     * The case the whole file exists for. `catalog.read` is the narrowest useful staff
     * permission in the application, and the overview is the first screen its holder lands
     * on. Everything else on this list — that orders have statuses, that slips are
     * reviewed, that refunds are requested — is absent.
     */
    expect(visibleSections(holding('catalog.read'))).toStrictEqual(['catalog']);
  });

  it('⚠️ refuses the slip card to payments.read alone', () => {
    /*
     * The narrow case, and the one a single-code gate gets wrong. `payments.read` opens the
     * refunds queue and the ledger, and it does **not** open the slip queue — that needs
     * `orders.read` beside it. A slip count shown here would be the slip queue's contents,
     * summarised, handed to somebody the slip queue itself would refuse.
     */
    const sections = visibleSections(holding('payments.read'));

    expect(sections).not.toContain('slips');
    expect(sections).toStrictEqual(['refunds', 'money']);
  });

  it('adds the slip card once orders.read is beside it', () => {
    expect(visibleSections(holding('payments.read', 'orders.read'))).toStrictEqual([
      'orders',
      'slips',
      'refunds',
      'money',
      'notifications',
    ]);
  });

  it('gives an administrator holding every code every card', () => {
    const everything = visibleSections(holding(...Object.values(OVERVIEW_SECTIONS).flat()));

    expect(everything).toStrictEqual(Object.keys(OVERVIEW_SECTIONS));
  });

  it('gives a signed-in person with no permissions nothing at all', () => {
    /*
     * Not an error, and not an empty-looking page by accident: a real account can be in no
     * group, and what it should see is a screen that says so rather than a wall of zeros
     * implying the company has no work.
     */
    expect(visibleSections(holding())).toStrictEqual([]);
  });
});

describe('the scopes that are not people', () => {
  it('gives a guest and the public nothing', () => {
    /*
     * Unreachable through the route — `@Authenticated()` turns both away before the handler
     * — and asserted anyway, because the route's decorator is one edit away from being the
     * only thing standing between a crawler and the company's order counts.
     */
    expect(visibleSections(guestScope('00000000-0000-4000-8000-000000000003'))).toStrictEqual([]);
    expect(visibleSections(PUBLIC_SCOPE)).toStrictEqual([]);
  });

  it('gives the process itself everything', () => {
    // `scopeHolds` says system holds every code; the table must not invent a second answer.
    expect(visibleSections(systemScope('overview test'))).toStrictEqual(
      Object.keys(OVERVIEW_SECTIONS),
    );
  });
});

describe('the table stays in step with the wire type', () => {
  it('names every section the response can carry', () => {
    /*
     * The failure this catches is a card added to the response and left out of the table:
     * it would render for everybody, gated by nothing, and no other test would notice
     * because every *listed* section would still be correct.
     */
    const keys: readonly OverviewSection[] = Object.keys(OVERVIEW_SECTIONS) as OverviewSection[];

    expect(keys).toHaveLength(9);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
