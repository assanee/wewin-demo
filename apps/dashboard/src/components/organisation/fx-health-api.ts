import 'client-only';

import type { FxRateHealthWire } from '@wewin/contract/organisation';

import { apiJson } from '@/lib/api/client';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The one call behind the exchange-rate health card — `GET /admin/fx/health`.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Its own file rather than another export in `organisation-api.ts`, because the route is not
 * under `admin/organisation` and the reason is structural rather than cosmetic:
 * `FxController`'s own header records it — `FxModule` imports `OrganisationModule` for
 * `TaxCountryService`, so hanging the health read off `OrganisationController` would close a
 * cycle in Nest's graph. The card renders on `/organisation` anyway, beside the tax countries
 * whose `อัตราแลกเปลี่ยนกำหนดเอง` is the way out of a stale rate. Keeping the client split on the
 * same line the server is split on means the URL in this file matches the controller that
 * answers it, with no comment needed to explain the mismatch.
 *
 * Read-only, and there is no write beside it on purpose. The two thresholds are constants in
 * `apps/api/src/fx/staleness.ts` (which also records what making them settable would take), and
 * the *rate* is settable only through `patchTaxCountry` in `organisation-api.ts`, where it lands
 * in `tax_country_changes` with an actor and a before/after.
 *
 * Narrowed by hand for exactly the reason `organisation-api.ts` states at length:
 * `@wewin/contract/organisation` publishes request schemas because apps/api validates bodies
 * against them, but no schema for what a `GET` answers with — and `zod` is not a declared
 * dependency of `@wewin/dashboard`, so reaching for a sibling package's copy would be a phantom
 * import. The `TypeError` names the field so `apiJson` can turn it into a `MALFORMED` with the
 * path attached.
 */

function asObject(input: unknown, what: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError(`${what} is not an object`);
  }
  return input as Record<string, unknown>;
}

function str(row: Record<string, unknown>, key: string, what: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new TypeError(`${what} has no ${key}`);
  return value;
}

function num(row: Record<string, unknown>, key: string, what: string): number {
  const value = row[key];
  if (typeof value !== 'number') throw new TypeError(`${what} has no ${key}`);
  return value;
}

/**
 * ⚠️ **Deliberately not `organisation-api.ts`'s `nullableStr`, and named differently so nobody
 * "unifies" the two.** That helper folds an absent key into `null`, which is right for a
 * `changedByUserId` an erasure may have scrubbed. It is wrong for every nullable field on this
 * wire, because here a `null` is not an absence — it is a *loud fact* the card words separately:
 * `observedAt: null` is "there has never been a rate", `lastFailureAt: null` is "no failure has
 * ever been recorded". A server build that renamed or dropped one of these keys would then
 * render as the most alarming sentence this card can print, or the most reassuring one, off a
 * key that merely went missing.
 *
 * So absence throws and only an explicit `null` passes — the same distinction `fxCurrencyOf` in
 * `organisation-api.ts` draws for a settings field, in the same words: a server that stopped
 * sending the key must not read as "somebody cleared it".
 */
function strOrNull(row: Record<string, unknown>, key: string, what: string): string | null {
  if (!(key in row)) throw new TypeError(`${what} has no ${key}`);
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== 'string') throw new TypeError(`${what} has a non-string ${key}`);
  return value;
}

/**
 * `ageHours` is the one number on this wire that is legitimately `null`, and it is the single
 * most consequential field here: `null` means `fx_rates` has never held a row at all, which the
 * card words as "never", not "old". Absence therefore throws rather than reading as `null`, for
 * the reason `strOrNull` above spells out.
 */
function numOrNull(row: Record<string, unknown>, key: string, what: string): number | null {
  if (!(key in row)) throw new TypeError(`${what} has no ${key}`);
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== 'number') throw new TypeError(`${what} has a non-number ${key}`);
  return value;
}

/**
 * ⚠️ **`status` is kept as the string it arrived as, never narrowed to a union here.**
 *
 * `FxRateHealthWire.status` is typed `string` in the contract on purpose — the union
 * `FxRateHealthStatus` lives in `apps/api/src/fx/staleness.ts`, beside the comparison that
 * produces it. Narrowing it in this decoder would turn an unrecognised fourth word into a
 * `MALFORMED` error: the whole card replaced by a decode failure, at the exact moment somebody
 * most needs to see the two clocks and the failure count. A word this build has not been taught
 * is a version skew, not corruption, so it passes through and `fxHealthVerdict` in
 * `fx-health.tsx` decides what to *say* about it — which it resolves toward "unusable" rather
 * than toward green, because showing health over a submit that is being refused is the one
 * failure mode `staleness.ts` names explicitly.
 */
export function decodeFxRateHealth(input: unknown): FxRateHealthWire {
  const what = 'fx rate health';
  const row = asObject(input, what);

  return {
    status: str(row, 'status', what),
    ageHours: numOrNull(row, 'ageHours', what),
    observedAt: strOrNull(row, 'observedAt', what),
    fetchedAt: strOrNull(row, 'fetchedAt', what),
    consecutiveFailures: num(row, 'consecutiveFailures', what),
    lastFailureAt: strOrNull(row, 'lastFailureAt', what),
    warnAfterHours: num(row, 'warnAfterHours', what),
    refuseAfterHours: num(row, 'refuseAfterHours', what),
  };
}

/** `organisation.read` — the permission that already opens the screen this renders on. */
export const getFxRateHealth = (): Promise<FxRateHealthWire> =>
  apiJson('/admin/fx/health', decodeFxRateHealth);
