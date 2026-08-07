import { Suspense } from 'react';

import { ResetPasswordForm } from '@/components/reset-password-form';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Where the link in a reset email lands.
 *
 * `Suspense` is required rather than stylistic — the form reads `?token=` through
 * `useSearchParams`, and Next refuses to prerender a page whose tree reads search params
 * without a boundary. `/login` carries the same wrapper for the same reason.
 */
export default function ResetPasswordPage() {
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <Suspense fallback={<Skeleton className="h-96 w-full max-w-sm" />}>
        <ResetPasswordForm />
      </Suspense>
    </main>
  );
}
