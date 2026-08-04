'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { Spinner } from '@/components/ui/spinner';
import { useSession } from '@/lib/auth/session';
import { signInPath } from '@/lib/auth/sign-in-url';

/**
 * Sends a signed-out browser to `/login`, and shows a spinner while we find out which it is.
 *
 * This is a redirect, not a guard, and the difference is not pedantry. The children below
 * have already been rendered by the time this component decides anything — a Server
 * Component's output is in the RSC payload whether or not it is displayed — so nothing here
 * should ever be the only thing standing between a person and data they may not see. It
 * cannot be: the data lives behind `RbacGuard` in apps/api, and this app has no way to
 * fetch any of it without an access token this browser does not have.
 *
 * What it buys is that a signed-out person lands on a sign-in page instead of a shell full
 * of failed requests, and that they land back where they were trying to go afterwards.
 */
export function RequireSession({ children }: { readonly children: React.ReactNode }) {
  const { state } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (state.status !== 'signed-out') return;

    /*
     * `window.location` and not `useSearchParams()`.
     *
     * Reading search params through the hook opts the whole subtree out of static
     * prerendering — Next refuses to build a page whose tree calls it without a Suspense
     * boundary, and this component wraps *every* page in the group, so the cost would land
     * on all of them. The effect only ever runs in a browser, where `window.location` is
     * both available and the more accurate answer: it is the URL the person actually has.
     */
    const here = `${window.location.pathname}${window.location.search}`;

    /*
     * `replace`, not `push`: the page they could not see should not be a Back button away,
     * because pressing Back would bounce them straight here again.
     */
    router.replace(signInPath(here));
  }, [state.status, router]);

  if (state.status === 'signed-in') return <>{children}</>;

  return (
    <div className="flex min-h-svh items-center justify-center gap-3 p-6" aria-busy>
      <Spinner />
      <span className="text-muted-foreground">
        {state.status === 'loading' ? 'กำลังตรวจสอบสิทธิ์…' : 'กำลังพาไปหน้าเข้าสู่ระบบ…'}
      </span>
    </div>
  );
}
