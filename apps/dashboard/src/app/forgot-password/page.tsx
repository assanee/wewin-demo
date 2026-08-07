import { ForgotPasswordForm } from '@/components/forgot-password-form';

/**
 * Outside `(app)`, for the reason `/login` is: somebody who cannot sign in must not be
 * redirected to the sign-in page by the shell that wraps signed-in screens.
 */
export default function ForgotPasswordPage() {
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <ForgotPasswordForm />
    </main>
  );
}
