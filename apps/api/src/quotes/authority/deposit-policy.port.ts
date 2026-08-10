import type { AuthorityTx } from './authority.repository';

/**
 * The company's deposit percentage, as the one thing this module needs to know about it.
 *
 * ── Why a port and not a parameter ───────────────────────────────────────────────
 *
 * The `cashflow` floor is consumed in exactly one place — `measureFor` — and `measureFor` has
 * three callers:
 *
 *     measureCashflow ← measureFor ← { measure, assess, request }
 *                                            ↑
 *                                        gate (via assess)
 *
 * `measure` and `request` arrive from HTTP controllers with no submit transaction and no deposit
 * anywhere in scope. Threading a required `floorBp` down from every entry point would put a
 * settings read into two controllers and change three signatures to carry a value only one of
 * them could ever have obtained. So `measureFor` reads it here instead, its own signature does
 * not change, and `gate` — which calls `assess`, not `measureFor` — needs no edit at all.
 *
 * ── Why the interface lives in this directory ────────────────────────────────────
 *
 * Because this is the module that needs it. `authority.module.ts` deliberately imports neither
 * `OrdersModule` nor `ScheduleModule`, on the grounds that a module able to reach `OrdersService`
 * is a module that will eventually move an order's status from an approval handler. A one-method
 * read-only interface declared *here* and implemented elsewhere is the shape that keeps that true
 * while still letting a company setting reach the measurement: the dependency points at this
 * file, not at a service with verbs on it.
 *
 * ⚠️ **An implementation must import this file directly, never through `./index.ts`.** The
 * barrel re-exports `AuthorityModule`, which imports the module that provides the adapter — so a
 * provider reaching the token through the barrel closes a CommonJS require cycle and gets
 * `undefined` at decorator-evaluation time. This file imports one type and nothing else, so a
 * direct import has no runtime edge at all.
 */
export const DEPOSIT_POLICY = Symbol('DEPOSIT_POLICY');

export interface DepositPolicyPort {
  /**
   * Basis points of the grand total that must be gated before production.
   *
   * `tx` is optional and the submit path passes one: the floor a gate measures against has to be
   * the value this transaction can see, for the same reason the gate measures the quote from
   * rows read inside it rather than from a figure handed to it.
   *
   * It resolves to a number in 1..10 000 or throws. **1 is the floor, not 0** — the CHECK on
   * `organisation_profile.deposit_bp` says so, and `depositPercentTerms(0)` is refused by
   * `planSchedule`, so "no deposit at all" is expressed by authoring terms with no gate rather
   * than by zeroing this setting.
   */
  depositBp(tx?: AuthorityTx): Promise<number>;
}
