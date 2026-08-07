import { normalisePhone } from '@wewin/core/phone';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ ONE FIELD, TWO NAMESPACES, AND NO ORACLE BETWEEN THEM.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A customer signs in with an email address or a telephone number. Which one they typed is
 * decided here, once, and the answer feeds both the lookup and the throttle key — the
 * property `password-sign-in.service.ts` depends on, because two normalisations mean two
 * buckets and a limit worth however many spellings an input has.
 *
 * ── ⚠️ Unparseable is an address, deliberately ───────────────────────────────
 *
 * There is no `kind: 'unknown'` and no refusal. `password.contract.ts` explains why the
 * schema does not validate the shape of this field: "that is not a valid address" answers a
 * question the sign-in path is required to be silent about. A third branch here would
 * reinstate exactly that, and would say more than the original — it would tell an attacker
 * which namespace their guess failed to be in.
 *
 * So anything that is not recognisably a number is treated as an address, matches nothing,
 * and is refused at the same cost as a wrong password. The address path is the right
 * fall-through rather than the phone path because addresses are matched as opaque strings
 * and numbers are not: a stored value obeys `user_phones_number_e164`, so a non-canonical
 * argument to the phone lookup could never match anyway.
 */

export interface Username {
  readonly kind: 'email' | 'phone';
  /** What to look up, and what to count against. Canonical for its kind. */
  readonly key: string;
}

/**
 * A number is tried first, and the order is **defensive rather than load-bearing**.
 *
 * `normalisePhone` already refuses anything containing an `@`, so an address cannot be read
 * as a number whichever branch runs first — a mutation reversing this order changes no
 * behaviour, which is how that was established rather than assumed.
 *
 * ⚠️ It is written most-specific-first anyway. The `@` refusal is a property of a function in
 * another package, and the day somebody widens `normalisePhone` to accept a shape it does not
 * today, this order is what stops addresses quietly becoming telephone lookups.
 */
export function normaliseUsername(typed: string): Username {
  const number = normalisePhone(typed);
  if (number !== null) return { kind: 'phone', key: number };

  return { kind: 'email', key: typed.trim().toLowerCase() };
}
