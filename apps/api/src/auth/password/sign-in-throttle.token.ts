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

export type { SignInThrottle } from './sign-in-throttle';
