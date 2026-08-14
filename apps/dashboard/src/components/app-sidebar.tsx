'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LogOut } from 'lucide-react';

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarRail,
} from '@/components/ui/sidebar';
import { useSession } from '@/lib/auth/session';
import { isCurrent, visibleNavigation } from '@/lib/nav/navigation';

/**
 * The menu, derived from the permissions the API just told us about.
 *
 * There is no list of links in this file. It renders `visibleNavigation(permissions)` and
 * nothing else, so a section is added by adding it to `src/lib/nav/navigation.ts` — which is
 * also where its permission is stated, which is what keeps the two from drifting apart in
 * the way that produces a menu item leading to a 403.
 *
 * Worth repeating where somebody editing a sidebar will read it: this is presentation. An
 * item that is not rendered is an item the person is not being *offered*, not one they are
 * being prevented from reaching — `RbacGuard` on apps/api is what prevents.
 *
 * ── ⚠️ Why this file overrides the sidebar's own spacing ─────────────────────
 *
 * **Measured, not tuned to taste.** At stock spacing the nav's `scrollHeight` is **768px**, and
 * with the 72px header and 48px footer the sidebar needs **888px of viewport height to show
 * itself whole**. A 1440×900 laptop gives about 800px of *inner* height and a 13" 1280×800
 * about 700px, so on both of the machines staff actually use, the bottom of the menu was cut
 * off — `คืนเงิน` and `รีวิวรอกลั่นกรอง` sliced mid-row.
 *
 * ⚠️ It was never *overlapping* the sign-out button, which is what a `--full` screenshot made
 * it look like and what an earlier report of mine claimed. The DOM was always correct:
 * `SidebarContent` is `min-h-0 flex-1 overflow-auto` and `SidebarFooter` is a sibling below it.
 * The real defect is subtler and worse — **`SidebarContent` also carries `no-scrollbar`**, so
 * the one signal that would have told somebody the list continues was suppressed. A menu that
 * scrolls silently and ends mid-word reads as a rendering bug, not as a scroll.
 *
 * Two changes, and they are different in kind:
 *
 *   ⓵ **Density.** `py-1` groups, `h-6` labels, `h-7` rows. This is the house's own
 *      "denser where density helps" applied to the one list every screen carries: a 32px row
 *      for a one-line link was airy, and the compression buys back ~150px, which is the
 *      difference between fitting and not on a 900px screen.
 *   ⓶ **An honest scrollbar.** `[scrollbar-width:thin]` overrides `no-scrollbar` so that when
 *      the menu *does* still overflow — a 13" screen, or the day a sixteenth section is added —
 *      it says so. Density alone would have been a fix that silently expires.
 *
 * Both are applied here rather than in `ui/sidebar.tsx`, so `shadcn add --diff` stays readable.
 */
export function AppSidebar() {
  const pathname = usePathname();
  const { state, signOut } = useSession();

  const permissions =
    state.status === 'signed-in' ? new Set(state.principal.permissions) : new Set<string>();
  const sections = visibleNavigation(permissions);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <div className="flex flex-col gap-0.5 px-2 py-1">
          <span className="truncate font-medium">WEWIN</span>
          <span className="text-muted-foreground truncate text-xs">ระบบจัดการภายใน</span>
        </div>
      </SidebarHeader>

      <SidebarContent className="[scrollbar-width:thin]">
        {state.status === 'loading' ? (
          /*
           * Skeletons rather than an empty sidebar. The permission list arrives one round
           * trip after the first paint, so an empty menu here would be indistinguishable
           * from "you may not do anything" for the second it takes.
           */
          <SidebarGroup className="py-1">
            <SidebarGroupContent>
              <SidebarMenu>
                {[0, 1, 2].map((row) => (
                  <SidebarMenuItem key={row}>
                    <SidebarMenuSkeleton showIcon />
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ) : (
          sections.map((section) => (
            <SidebarGroup key={section.labelTh} className="py-1">
              <SidebarGroupLabel className="h-6">{section.labelTh}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {section.items.map((item) => (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton
                        asChild
                        className="h-7"
                        isActive={isCurrent(item, pathname)}
                        tooltip={item.labelTh}
                      >
                        <Link href={item.href}>
                          <item.icon />
                          <span>{item.labelTh}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))
        )}
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={() => {
                void signOut();
              }}
              disabled={state.status !== 'signed-in'}
              tooltip="ออกจากระบบ"
            >
              <LogOut />
              <span>ออกจากระบบ</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}
