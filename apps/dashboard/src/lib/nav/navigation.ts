import type { Route } from 'next';
import {
  Users,
  Boxes,
  FileText,
  Images,
  LayoutDashboard,
  SlidersHorizontal,
  type LucideIcon,
} from 'lucide-react';

import type { PermissionCode } from '@/lib/auth/permissions';
import { holdsAll } from '@/lib/auth/permissions';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SEAM. The product screens mount on the routes named in this file.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * This table is the agreement between the shell (layout, session, sidebar) and the screens
 * that fill it. It is the only place that knows all three of a section's path, its Thai
 * label and the permission it corresponds to, so adding a screen is one entry here plus the
 * route it names — and *not* an edit to the sidebar, which reads this and nothing else.
 *
 * Two things make the agreement hold rather than merely be described:
 *
 *   `href: Route` — `typedRoutes` is on in next.config.ts, so an entry naming a route that
 *   does not exist is a type error at `pnpm typecheck`, not a 404 somebody finds by
 *   clicking. Adding an entry before adding its `page.tsx` will not compile.
 *
 *   `requires` is checked against the permission list `GET /me` returned, never against
 *   anything local. See permissions.ts for why the copy of the code list is safe and which
 *   way it fails.
 *
 * Sections nest one level and no more. A dashboard that needs a third level of menu has
 * usually grown a page that should have been a tab.
 *
 * **Scope.** Phase 4 is products, options and images; phase 5c adds quotations. Orders,
 * payments, users and groups all have permission codes already (they are in apps/api's
 * catalogue) and no routes, so they are deliberately absent: an entry here without a page will
 * not compile, which is the property that keeps this table honest as later phases land.
 *
 * ⚠️ `/quotes` shipped for one round with no entry here, so the whole quote editor was
 * reachable by typing a URL and by nothing else. A screen that is in the build and not in the
 * menu is a screen nobody uses, which is the softer version of the wiring failure that left two
 * API modules out of `AppModule` in the same round.
 */

export interface NavItem {
  readonly href: Route;
  readonly labelTh: string;
  readonly icon: LucideIcon;
  /** Every code, not any — the same rule `@RequirePermissions` enforces server-side. */
  readonly requires: readonly PermissionCode[];
  /**
   * `/products` must not stay highlighted while the user is on `/products/abc/edit`'s
   * sibling section, but it must while they are on `/products/abc`. The overview lives at
   * `/`, which is a prefix of everything, so it opts out.
   */
  readonly matchExactly?: boolean;
}

export interface NavSection {
  readonly labelTh: string;
  readonly items: readonly NavItem[];
}

export const NAVIGATION: readonly NavSection[] = [
  {
    labelTh: 'ทั่วไป',
    items: [
      {
        href: '/',
        labelTh: 'ภาพรวม',
        icon: LayoutDashboard,
        requires: [],
        matchExactly: true,
      },
    ],
  },
  {
    labelTh: 'แคตตาล็อก',
    items: [
      {
        href: '/products',
        labelTh: 'สินค้า',
        icon: Boxes,
        /*
         * `catalog.read` and not `catalog.write`. The list is readable by anyone who may see
         * drafts; publishing and editing are decided per action inside the screen, where the
         * button can be disabled next to the thing it would have done.
         */
        requires: ['catalog.read'],
      },
      {
        href: '/option-groups',
        labelTh: 'ชุดตัวเลือก',
        icon: SlidersHorizontal,
        requires: ['catalog.read'],
      },
      {
        href: '/media',
        labelTh: 'คลังรูปภาพ',
        icon: Images,
        requires: ['catalog.read'],
      },
    ],
  },
  {
    labelTh: 'การขาย',
    items: [
      {
        /*
         * `quotes.read` and not `quotes.write`: the list and the customer-facing document are
         * readable by anyone who may see a quotation at all, and every editing control on the
         * screen is decided per action beside the thing it would have done — the same rule the
         * product screens follow.
         */
        href: '/quotes',
        labelTh: 'ใบเสนอราคา',
        icon: FileText,
        requires: ['quotes.read'],
      },
    ],
  },
  {
    labelTh: 'ระบบ',
    items: [
      {
        /*
         * `users.read` and not `users.write`: most of what this screen is for is *looking* —
         * who is in what group, who still has a live session, who was suspended and when —
         * and every control that changes something is decided per action inside the page.
         * A support lead answering "does Somchai still have access?" should not need the
         * ability to grant themselves `orders.refund` to find out.
         */
        href: '/users',
        labelTh: 'ผู้ใช้และสิทธิ์',
        icon: Users,
        requires: ['users.read'],
      },
    ],
  },
];

/**
 * The menu for one principal.
 *
 * Empty sections are dropped rather than rendered as a heading with nothing under it — a
 * heading is itself a disclosure that a section exists, and an empty one is a worse
 * disclosure because it says "and you may not see it".
 *
 * Takes the permission list as it arrived from the API. A caller that has no principal
 * passes an empty set and gets back only the entries that require nothing.
 */
export function visibleNavigation(permissions: ReadonlySet<string>): readonly NavSection[] {
  return NAVIGATION.map((section) => ({
    ...section,
    items: section.items.filter((item) => holdsAll(permissions, item.requires)),
  })).filter((section) => section.items.length > 0);
}

/** Whether `item` is the section the given pathname belongs to. */
export function isCurrent(item: NavItem, pathname: string): boolean {
  if (item.matchExactly === true) return pathname === item.href;
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}
