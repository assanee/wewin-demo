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
        <div className="flex flex-col gap-0.5 px-2 py-1.5">
          <span className="truncate font-medium">WEWIN</span>
          <span className="text-muted-foreground truncate text-xs">ระบบจัดการภายใน</span>
        </div>
      </SidebarHeader>

      <SidebarContent>
        {state.status === 'loading' ? (
          /*
           * Skeletons rather than an empty sidebar. The permission list arrives one round
           * trip after the first paint, so an empty menu here would be indistinguishable
           * from "you may not do anything" for the second it takes.
           */
          <SidebarGroup>
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
            <SidebarGroup key={section.labelTh}>
              <SidebarGroupLabel>{section.labelTh}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {section.items.map((item) => (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton
                        asChild
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
