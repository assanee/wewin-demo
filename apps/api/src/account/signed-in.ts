import { AppError } from '../common/errors/app-error';
import { matchScope, type Scope } from '../rbac';

/**
 * The signed-in person, from a token this process verified. Never from a request.
 *
 * Lifted out of `account.controller.ts` when the second factor grew its own controller on
 * the same `/me/account` surface. Copying it would have been three more raw error literals
 * against the pin in `tests/i18n/envelope.test.ts` — and, worse, two places that could come
 * to disagree about what a guest sees, on a surface whose entire promise is that it points
 * at you and nobody else.
 */
export function signedIn(scope: Scope): { readonly userId: string; readonly sessionId: string } {
  return matchScope<{ userId: string; sessionId: string }>(scope, {
    user: (user) => ({ userId: user.userId, sessionId: user.sessionId }),
    guest: () => {
      throw AppError.unauthenticated('ต้องเข้าสู่ระบบก่อน');
    },
    public: () => {
      throw AppError.unauthenticated('ต้องเข้าสู่ระบบก่อน');
    },
    system: () => {
      throw AppError.conflict('งานเบื้องหลังไม่มีบัญชีให้จัดการ', { reason: 'system-scope' });
    },
  });
}
