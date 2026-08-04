import { Suspense } from 'react';

import { SignInPanel } from '@/components/sign-in-panel';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Sign-in, outside the `(app)` route group.
 *
 * Outside it deliberately: `(app)/layout.tsx` sends signed-out browsers here, and a sign-in
 * page that inherited that layout would send itself here forever.
 *
 * `Suspense` is required rather than stylistic — `SignInPanel` reads `useSearchParams` (for
 * `?next=` and the `?error=` apps/api appends to `OAUTH_FAILURE_PATH`), and Next refuses to
 * prerender a page whose tree reads search params without a boundary.
 */
export default function LoginPage() {
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <Suspense fallback={<Skeleton className="h-96 w-full max-w-sm" />}>
        <SignInPanel />
      </Suspense>
    </main>
  );
}
