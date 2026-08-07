/**
 * The injection token, apart from the class.
 *
 * `SignInThrottle`'s constructor takes a plain object of numbers, which Nest cannot resolve
 * — `Nest can't resolve dependencies … argument Object at index [0]` — so it is provided as
 * a `useFactory` value under this token rather than as a class provider. Splitting the
 * token into its own file keeps `password-sign-in.service.ts` from importing the module
 * that provides it, which would be a cycle.
 */
export const SIGN_IN_THROTTLE = Symbol('wewin.auth.signInThrottle');

/**
 * A *second* counter, for reset requests, and separate on purpose.
 *
 * Sharing one would make five wrong passwords also spend the reset allowance — so the
 * standard recovery from "I have forgotten my password and just proved it five times" would
 * be blocked by the very attempts that prove it is needed. The two limits also want
 * different numbers: guessing is per-attempt, mailing is per-message.
 */
export const RESET_THROTTLE = Symbol('wewin.auth.resetThrottle');

export type { SignInThrottle } from './sign-in-throttle';
