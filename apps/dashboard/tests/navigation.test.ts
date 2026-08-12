import { describe, expect, it } from 'vitest';

import { holdsAll } from '@/lib/auth/permissions';
import { NAVIGATION, isCurrent, visibleNavigation } from '@/lib/nav/navigation';

/**
 * The menu is a function of the permission list the API sent, and nothing else.
 *
 * These assertions are about presentation, not authorisation — `RbacGuard` in apps/api is
 * the enforcement, and a person who types a URL for a hidden section reaches a page whose
 * every request 403s. What is worth pinning is the *direction* the derivation fails in: an
 * unknown or renamed permission must remove menu entries, never add them.
 */
describe('navigation derived from permissions', () => {
  it('shows nothing that requires a permission the principal does not hold', () => {
    const sections = visibleNavigation(new Set<string>());
    const hrefs = sections.flatMap((section) => section.items.map((item) => item.href));

    /*
     * The two entries that require nothing, and both are deliberate rather than
     * unclassified. `/` is the overview, which describes the account looking at it.
     * `/account` is *that person's own* password, linked providers and devices — gating
     * somebody's own credentials behind a permission would be the wrong shape entirely, and
     * `requires: []` is how that is said.
     *
     * ⚠️ This assertion is the reason to think about it. It failed when `/account` was added
     * and the right resolution was to widen it *deliberately* — a third `requires: []` entry
     * should have to come back here and argue for itself, which it cannot do if this reads
     * `.toContain('/')`.
     */
    expect(hrefs).toEqual(['/', '/account']);
  });

  it('shows the catalogue once catalog.read arrives', () => {
    const sections = visibleNavigation(new Set(['catalog.read']));
    const hrefs = sections.flatMap((section) => section.items.map((item) => item.href));

    expect(hrefs).toContain('/products');
    expect(hrefs).toContain('/option-groups');
    expect(hrefs).toContain('/media');
  });

  it('drops a section whose every item was filtered out, heading included', () => {
    /*
     * ⚠️ `quotes.approve`, and it has now moved **twice** — `orders.read`, then `groups.read`.
     *
     * The premise moves because the product does, and both moves were the same shape: the
     * permission this test borrows must open no menu entry, and each time one grew a screen
     * the borrow had to move rather than the assertion weaken to `.not.toContain(...)`.
     * `orders.read` now opens ออเดอร์ and แจ้งเตือน; `groups.read` now opens เพดานอำนาจอนุมัติ,
     * which is exactly the "if groups ever get their own screen" this comment predicted — it
     * had to, because reaching the ceiling table through ผู้ใช้และสิทธิ์ required `users.read`
     * and so the whole staff directory.
     *
     * `quotes.approve` is real, is held by approvers, and opens nothing: the approver's inbox
     * is on the list of screens nobody has built. The distinction being kept is the thing
     * worth keeping: a permission granting no *section* must still produce no *heading*,
     * because a heading is itself a disclosure that a section exists — the same rule the
     * overview's cards follow. When the inbox lands, re-point this again rather than delete it.
     */
    const withNoSectionOfItsOwn = visibleNavigation(new Set(['quotes.approve']));

    // "ระบบ" survives every permission set, because `/account` inside it requires none —
    // a person's own password is not a thing to hold a grant for.
    expect(withNoSectionOfItsOwn.map((section) => section.labelTh)).toEqual(['ทั่วไป', 'ระบบ']);
    expect(
      withNoSectionOfItsOwn.flatMap((section) => section.items.map((item) => item.href)),
    ).toEqual(['/', '/account']);
  });

  it('opens ออเดอร์ to orders.read', () => {
    const hrefs = visibleNavigation(new Set(['orders.read'])).flatMap((section) =>
      section.items.map((item) => item.href),
    );

    expect(hrefs).toContain('/orders');
  });

  /**
   * ⭐⭐ The permission that owns the ceiling table can reach the ceiling table.
   *
   * ⚠️ This is the assertion the previous shape could not make. `authority_limits` was a tab
   * inside ผู้ใช้และสิทธิ์, whose entry requires `users.read` — sight of the whole staff
   * directory, a PDPA-relevant disclosure here — so a person holding exactly `groups.read` +
   * `groups.write` saw no route to it at all and got a raw English `Missing permission:
   * users.read.` if they typed the URL. `groups.write` is held by nobody at boot, so that was
   * the state of the *first* person ever granted it.
   *
   * Both of the screen's reads are `groups.read`, so the nav asks for that and nothing else,
   * and `/users` must stay out of what these two codes open.
   */
  it('opens เพดานอำนาจอนุมัติ to groups.read, without users.read', () => {
    const hrefs = visibleNavigation(new Set(['groups.read', 'groups.write'])).flatMap((section) =>
      section.items.map((item) => item.href),
    );

    expect(hrefs).toContain('/authority');
    expect(hrefs).not.toContain('/users');
  });

  it('ignores permission codes it has never heard of instead of choking on them', () => {
    // What an API one release ahead of this bundle sends.
    const sections = visibleNavigation(new Set(['catalog.read', 'invoices.reconcile']));

    /* ทั่วไป, แคตตาล็อก, and ระบบ — the third being the one that needs no permission. */
    expect(sections).toHaveLength(3);
  });

  it('requires every listed code, not any of them — the same rule as @RequirePermissions', () => {
    // Real codes, because `PermissionCode` is a union and 'a'/'b' would not compile —
    // which is itself the point of typing the list rather than passing strings around.
    expect(holdsAll(new Set(['catalog.read']), ['catalog.read', 'catalog.publish'])).toBe(false);
    expect(holdsAll(new Set(['catalog.read', 'catalog.publish']), ['catalog.read', 'catalog.publish'])).toBe(true);
    expect(holdsAll(new Set<string>(), [])).toBe(true);
  });

  it('never mentions a route twice, which would put one page under two menu entries', () => {
    const hrefs = NAVIGATION.flatMap((section) => section.items.map((item) => item.href));

    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});

describe('which entry is highlighted', () => {
  const products = NAVIGATION.flatMap((section) => section.items).find(
    (item) => item.href === '/products',
  );
  const overview = NAVIGATION.flatMap((section) => section.items).find((item) => item.href === '/');

  it('keeps a section highlighted while inside it', () => {
    expect(products).toBeDefined();
    if (products === undefined) return;

    expect(isCurrent(products, '/products')).toBe(true);
    expect(isCurrent(products, '/products/abc/edit')).toBe(true);
    expect(isCurrent(products, '/media')).toBe(false);
  });

  it('does not let the overview claim every page just because "/" prefixes them all', () => {
    expect(overview).toBeDefined();
    if (overview === undefined) return;

    expect(isCurrent(overview, '/')).toBe(true);
    expect(isCurrent(overview, '/products')).toBe(false);
  });
});
