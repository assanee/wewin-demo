import { AppSidebar } from '@/components/app-sidebar';
import { RequireSession } from '@/components/require-session';
import { ThemeChoice } from '@/components/theme-choice';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { Separator } from '@/components/ui/separator';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SEAM. Everything signed-in mounts inside this route group.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `(app)` is a route group, so it contributes no URL segment: a page at
 * `src/app/(app)/products/page.tsx` is served at `/products`. What it contributes is this
 * layout — the sidebar, the header bar, and the redirect to `/login` — to everything
 * underneath it, and to nothing else. `/login` sits outside the group for that reason: a
 * sign-in page inside a shell that redirects unauthenticated browsers to the sign-in page
 * is a loop.
 *
 * **For whoever is adding the product screens.** The contract is three things and no more:
 *
 *   1. Put the page at `src/app/(app)/<section>/page.tsx`. It inherits the shell; do not
 *      render a second sidebar or repeat the header.
 *   2. Add the section to `src/lib/nav/navigation.ts` with the permission it corresponds
 *      to. That file is the only list of links in the app — the sidebar reads it and has no
 *      links of its own. `typedRoutes` means an entry naming a route that does not exist
 *      fails `pnpm typecheck`.
 *   3. Fetch through `@/lib/api/client`. It attaches the access token, retries once behind a
 *      401, and refreshes per call rather than through a shared promise — read the header
 *      of that file before changing any of it.
 *
 * `Table`, `Dialog`, `Command` and `Field` are already in `@/components/ui` — the four the
 * plan chose shadcn *for* (8.5), installed with the shell so that adding a screen is not
 * also a `package.json` and lockfile change. `Field` is where `Form` went: the registry's
 * `form` item is empty now, because shadcn dropped the react-hook-form wrapper. Anything
 * else, `npx shadcn@latest add <name> -c apps/dashboard`.
 *
 * The header below is deliberately thin. Page titles, breadcrumbs and the buttons that act
 * on a record belong to the page, because only the page knows whether the primary action is
 * "publish" or "add an option value" — and a header that tries to know becomes a registry
 * every screen has to be added to.
 */
export default function AppLayout({ children }: { readonly children: React.ReactNode }) {
  return (
    <RequireSession>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset>
          {/*
            ⚠️ `print:hidden`, and it is a fix rather than a precaution.

            `/quotes/[orderId]/print` is inside this route group and has no layout of its own,
            so it inherits this header. globals.css's `@media print` block hides the sidebar
            and the `sidebar-trigger` *by slot* — it never hid the bar they sit in, so every
            quotation printed since that route landed has carried an empty 14px strip with a
            `border-b` across the top of page one. Invisible on screen, which is why it
            survived: the only way to see it is to print.

            Found while adding the theme control below, which would have printed a sun icon
            onto a document going to a customer. Hiding the header here rather than adding a
            third selector to globals.css follows what that file already asks for — "`print:hidden`
            on the controls plus this block on the shell" — and keeps the rule next to the
            element, where somebody restructuring the shell will see it.
          */}
          <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4 print:hidden">
            <SidebarTrigger />
            <Separator orientation="vertical" className="h-4" />
            {/*
              The page owns its own title. This slot stays empty rather than holding a
              breadcrumb the shell would have to be taught about every new route.
            */}

            {/*
              ⭐ The theme control, and `ml-auto` is the whole of its layout.

              It is in the shell rather than on `/account`, and the argument is about *what
              kind of setting it is* rather than about convention. The sidebar was the wrong
              home for the obvious reason — a personal display preference is not a section of
              the business, and the ระบบ group is a list of screens. But `/account` was the
              wrong home too, for a less obvious one: everything on that page is a fact the
              **API** holds about you (your password, your linked providers, your live
              sessions, your MFA secret), and every control there is a round trip that can
              fail. The theme is none of those. It is a `localStorage` key belonging to this
              browser, it applies before the session even resolves, and it would be the only
              thing on that page that keeps working while the API is down.

              It also has to be reachable from the screen you are complaining about. The
              reason somebody wants this is that a table of quotations is hard to read in the
              light they are sitting in, and a control two clicks away in a menu they have to
              already know about does not answer that. It is kept off paper by the
              `print:hidden` on the header above — see the note there.
            */}
            <div className="ml-auto">
              <ThemeChoice />
            </div>
          </header>
          <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">{children}</div>
        </SidebarInset>
      </SidebarProvider>
    </RequireSession>
  );
}
