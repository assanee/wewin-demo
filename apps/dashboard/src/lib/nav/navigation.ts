import type { Route } from 'next';
import {
  Building2,
  ClipboardList,
  Gavel,
  Inbox,
  MessageSquare,
  Receipt,
  RotateCcw,
  ShieldCheck,
  UserCog,
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
         * `orders.read` and not `orders.write`. The list and the spine are readable by
         * anybody who may see an order at all; every transition button on the detail screen
         * comes from `availableTransitions`, which the API computes per caller — so a reader
         * who may not move an order simply gets no buttons, decided server-side.
         */
        href: '/orders',
        labelTh: 'ออเดอร์',
        icon: ClipboardList,
        requires: ['orders.read'],
      },
      {
        /*
         * ⚠️ **`orders.read` beside `quotes.read`, and the missing one was the bug.**
         *
         * This entry asked for `quotes.read` alone for several rounds. There is no `GET /quotes`
         * — a quote is the editable face of an order — so `QuoteListScreen` lists
         * `GET /orders?status=draft,awaiting_payment,redesign`, and that route is
         * `@RequirePrincipal()` with the reach decided *in the query*: `orderReach` widens to every
         * order only for a caller holding `orders.read`, and otherwise returns the caller's **own**
         * orders, which for a member of staff is none. So a salesperson holding `quotes.read` and
         * not `orders.read` saw ใบเสนอราคา in the menu, opened it, and got an empty table with a
         * 200 — the failure mode that looks like "there is no work today" rather than like a
         * missing grant. Nothing 403s, so nothing said so.
         *
         * `quotes.read` stays because it is what makes the screen a *sales* screen: the editor's
         * sales block — the overrides, their reason codes, the concession and the ceiling — is
         * derived from that code inside `QuotesService.getQuote` and never from the request. A
         * reader with `orders.read` alone would reach a customer-shaped document, which is what
         * `/orders` is already for.
         *
         * Every editing control needs more still (`quotes.write` + `orders.read` + `orders.write`,
         * written once as `RequireQuoteWrite`) and is decided per action beside the thing it would
         * have done — the same rule the product screens follow.
         */
        href: '/quotes',
        labelTh: 'ใบเสนอราคา',
        icon: FileText,
        requires: ['orders.read', 'quotes.read'],
      },
      {
        /*
         * ⭐ The approver's inbox — **two codes, and both are what the queue asks for.**
         *
         * `GET /quotes/approvals/queue` is `@RequirePermissions('quotes.read', 'quotes.approve')`:
         * the first because it serves `approvals` rows, the second because the queue is *filtered
         * to what the caller may decide*, so a reader who may decide nothing would be handed a
         * list whose every row is a claim that is false. The menu asks for exactly that pair — the
         * same shape สลิปรอตรวจ has, for the same reason.
         *
         * ⚠️ `quotes.approve` is held by **nobody at boot** (plan 13: the code exists, the grant
         * does not, and the answer is a decision rather than a default). So this entry is invisible
         * until an administrator grants it — which is the intended state, not a wiring failure.
         */
        href: '/approvals',
        labelTh: 'คำขออนุมัติ',
        icon: Gavel,
        requires: ['quotes.read', 'quotes.approve'],
      },
    ],
  },
  {
    labelTh: 'การเงิน',
    items: [
      {
        /*
         * ⚠️ Two codes, matching `slip-review.controller.ts` exactly — and matching the
         * overview's `slips` card, which asks for the same pair for the same reason: a count
         * of this queue is a summary of this queue, and neither may be readable by somebody
         * the queue itself would refuse.
         */
        href: '/slips',
        labelTh: 'สลิปรอตรวจ',
        icon: Receipt,
        requires: ['payments.read', 'orders.read'],
      },
      {
        /*
         * `payments.read` alone, and that asymmetry with สลิปรอตรวจ above is deliberate: the
         * refunds endpoint asks for one code and the slip queue asks for two, so the menu
         * asks for exactly what each screen's API asks for. Copying the stricter pair here
         * would hide a screen from somebody entitled to it.
         */
        href: '/refunds',
        labelTh: 'คืนเงิน',
        icon: RotateCcw,
        requires: ['payments.read'],
      },
    ],
  },
  {
    labelTh: 'ลูกค้าสัมพันธ์',
    items: [
      {
        href: '/reviews',
        labelTh: 'รีวิวรอกลั่นกรอง',
        icon: MessageSquare,
        requires: ['reviews.moderate'],
      },
    ],
  },
  {
    labelTh: 'ระบบ',
    items: [
      {
        /*
         * ⚠️ `orders.read`, borrowed — the same borrow `notifications.controller.ts` makes
         * and documents. There is no `notifications.*` code and there should be; copying the
         * borrow keeps the menu and the endpoint in step, and inventing a different rule here
         * would put them out of it.
         */
        href: '/outbox',
        labelTh: 'แจ้งเตือน',
        icon: Inbox,
        requires: ['orders.read'],
      },
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
      {
        /*
         * ⭐ `groups.read` — **not** `users.read`, and that is the entry's whole reason to
         * exist.
         *
         * The ceiling table began life as a tab on `/users`, which requires `users.read`:
         * sight of the entire staff directory. So `groups.write` — the permission that owns
         * the table, held by nobody at boot — could not be delegated without a PDPA-relevant
         * disclosure, and the first person granted it had no route to the screen at all.
         * Both of the page's reads are `groups.read` (`GET /quotes/authority/limits` and
         * `/groups`), so this is the code the menu asks for.
         *
         * `groups.write` is decided per control inside the page, the same way `/users` decides
         * `users.write`: reading which role may concede how much, and the history of who moved
         * it, is exactly the thing that should not require the power to move it.
         */
        href: '/authority',
        labelTh: 'เพดานอำนาจอนุมัติ',
        icon: ShieldCheck,
        requires: ['groups.read'],
      },
      {
        /*
         * `organisation.read`, not `.write` — the same rule `/products` follows: the profile
         * and the bank-account list, including retired accounts, are readable by anyone who
         * may see the company's own settings at all. Every edit, add and deactivate control
         * on the screen itself is decided per action against `organisation.write`.
         */
        href: '/organisation',
        labelTh: 'ข้อมูลบริษัท',
        icon: Building2,
        requires: ['organisation.read'],
      },
      {
        /*
         * `requires: []` — everybody signed in has an account to manage, and gating a
         * person's own password behind a permission would be the wrong shape entirely. The
         * route still sits inside `(app)`, so an unauthenticated browser is redirected to
         * `/login` before it renders anything.
         */
        href: '/account',
        labelTh: 'บัญชีของฉัน',
        icon: UserCog,
        requires: [],
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
