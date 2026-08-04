'use client';

import { ThemeProvider } from 'next-themes';

import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { SessionProvider } from '@/lib/auth/session';

/**
 * Every client-side provider the app needs, in one component, so the root layout stays a
 * Server Component.
 *
 * The order is not arbitrary: `SessionProvider` is outermost because it performs the
 * `/auth/refresh` handshake on mount and everything else is presentation that may read from
 * it. `Toaster` is a sibling rather than a wrapper — `sonner` renders into its own portal
 * and wrapping the tree in it would only add a node.
 *
 * `ThemeProvider` is here because the `.dark` block shadcn wrote into globals.css is
 * otherwise dead CSS: nothing else in the app ever puts that class on an element. It
 * follows the operating system by default rather than offering a switch, which is the right
 * default for a tool somebody has open next to everything else they use.
 */
export function Providers({ children }: { readonly children: React.ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <SessionProvider>
        <TooltipProvider delayDuration={200}>{children}</TooltipProvider>
        <Toaster position="top-center" richColors />
      </SessionProvider>
    </ThemeProvider>
  );
}
