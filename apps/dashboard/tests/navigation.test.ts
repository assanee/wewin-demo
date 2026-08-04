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

    expect(hrefs).toEqual(['/']);
  });

  it('shows the catalogue once catalog.read arrives', () => {
    const sections = visibleNavigation(new Set(['catalog.read']));
    const hrefs = sections.flatMap((section) => section.items.map((item) => item.href));

    expect(hrefs).toContain('/products');
    expect(hrefs).toContain('/option-groups');
    expect(hrefs).toContain('/media');
  });

  it('drops a section whose every item was filtered out, heading included', () => {
    const withoutCatalogue = visibleNavigation(new Set(['orders.read']));

    expect(withoutCatalogue.map((section) => section.labelTh)).toEqual(['ทั่วไป']);
  });

  it('ignores permission codes it has never heard of instead of choking on them', () => {
    // What an API one release ahead of this bundle sends.
    const sections = visibleNavigation(new Set(['catalog.read', 'invoices.reconcile']));

    expect(sections).toHaveLength(2);
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
