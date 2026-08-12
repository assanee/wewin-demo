import 'client-only';

import type {
  FxConfiguredRateWire,
  FxManualSyncBudgetWire,
  FxManualSyncResultWire,
  FxProviderFiguresWire,
  FxRateHealthWire,
} from '@wewin/contract/organisation';

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
 * ⚠️ **There is now one write beside it, and it still sets nothing.** This used to say *"read-only,
 * and there is no write beside it on purpose"*; what has not changed is that the two thresholds
 * are constants in `apps/api/src/fx/staleness.ts`, and that the *rate* is settable only through
 * `patchTaxCountry` in `organisation-api.ts`, where it lands in `tax_country_changes` with an
 * actor and a before/after. `postFxManualSync` stores no value anybody chose — it asks the
 * provider for the number the 01:00 tick would have asked for. What it spends is quota, which is
 * why the budget it answers with is rendered rather than discarded.
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

/**
 * The plain, never-null numbers: `consecutiveFailures`, the two thresholds, and
 * `warningRecipients`.
 *
 * ⭐ **`warningRecipients` belongs here and not with `numOrNull`, and the reason is the mirror
 * image of `ageHours`'s.** For `ageHours` the *`null`* is the loud fact, so absence must not be
 * folded into it. For this field the loud fact is *zero* — "nobody active holds
 * `organisation.write` with a reachable address, so when the rate goes stale the people who could
 * end it are never told" — and `fxNoRecipientsTh` in `fx-health.tsx` puts a warning on the card
 * for it even while everything else there is green. A helper that read a missing key as `0` would
 * print that warning off a server build that merely renamed the field, and an administrator would
 * go granting a permission somebody already holds.
 *
 * The single `typeof` already covers it: an absent key reads as `undefined`, which is not a
 * number, so absence throws without needing the explicit `in` check `numOrNull` carries. Stated
 * because it is load-bearing here rather than incidental — this field has no legal `null` to
 * distinguish absence from.
 */
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
    warningRecipients: num(row, 'warningRecipients', what),
    configuredRates: decodeConfiguredRates(row['configuredRates']),
    base: strOrNull(row, 'base', what),
    manualSync: decodeManualSyncBudget(row['manualSync']),
  };
}

/**
 * The per-destination rates, or a `TypeError` naming what was wrong.
 *
 * ⚠️ **An empty array passes and a missing key does not**, which is the same distinction every
 * nullable field on this wire draws. Empty is a real and common state — no destination is
 * configured for a foreign currency yet — and it renders as a sentence saying so. A server build
 * that renamed or dropped the key would otherwise render that same reassuring sentence while the
 * card was in fact showing nothing it had been sent.
 */
function decodeConfiguredRates(input: unknown): readonly FxConfiguredRateWire[] {
  if (!Array.isArray(input)) throw new TypeError('fx rate health has no configuredRates');

  return input.map((entry, index) => {
    const what = `fx configured rate ${String(index)}`;
    const row = asObject(entry, what);

    return {
      countryCode: str(row, 'countryCode', what),
      countryNameTh: str(row, 'countryNameTh', what),
      currency: str(row, 'currency', what),
      isActive: bool(row, 'isActive', what),
      /*
       * ⚠️ Narrowed to the union here, unlike `status` on the health payload — and the asymmetry
       * is deliberate rather than an oversight. `status` is typed `string` in the contract
       * because an unknown fourth word is a version skew the card must survive and *word*
       * carefully. `source` is typed as the two-arm union in the contract itself, so a third
       * value is not skew, it is a payload that does not match the type the compiler is reading:
       * every branch below it (does the spread apply, is a mid-market figure meaningful) is
       * written against exactly two answers, and silently defaulting a third to `'mid_market'`
       * would print a mid-market rate for a destination quoting off an override.
       */
      source: source(row, what),
      effectiveThbPerUnit: strOrNull(row, 'effectiveThbPerUnit', what),
      midThbPerUnit: strOrNull(row, 'midThbPerUnit', what),
      spreadBp: num(row, 'spreadBp', what),
      spreadApplied: bool(row, 'spreadApplied', what),
      provider: decodeProviderFigures(row, what),
      problem: strOrNull(row, 'problem', what),
    };
  });
}

function source(row: Record<string, unknown>, what: string): 'manual' | 'mid_market' {
  const value = row['source'];
  if (value !== 'manual' && value !== 'mid_market') {
    throw new TypeError(`${what} has an unknown source`);
  }
  return value;
}

/**
 * The provider's own two figures, or `null`.
 *
 * `null` is the loud value here in the same way it is elsewhere on this wire — it means the
 * observation does not carry this currency at all — so absence throws rather than folding in.
 */
function decodeProviderFigures(
  row: Record<string, unknown>,
  what: string,
): FxProviderFiguresWire | null {
  if (!('provider' in row)) throw new TypeError(`${what} has no provider`);
  const value = row['provider'];
  if (value === null) return null;

  const figures = asObject(value, `${what} provider`);
  return {
    unitPerBase: num(figures, 'unitPerBase', `${what} provider`),
    thbPerBase: num(figures, 'thbPerBase', `${what} provider`),
  };
}

/**
 * ⭐ The manual-sync budget.
 *
 * Every number here is `num` and not a tolerant read, for the reason that runs through this whole
 * file: this object is what decides whether the button is offered. A helper that read a missing
 * `remainingToday` as `0` would grey the button out off a server build that merely renamed a
 * field, and a helper that read it as the limit would offer a press the server is about to 429.
 * Both are worse than a decode failure, which at least says which key.
 */
function decodeManualSyncBudget(input: unknown): FxManualSyncBudgetWire {
  const what = 'fx manual sync budget';
  const row = asObject(input, what);

  return {
    dailyLimit: num(row, 'dailyLimit', what),
    usedToday: num(row, 'usedToday', what),
    remainingToday: num(row, 'remainingToday', what),
    minIntervalSeconds: num(row, 'minIntervalSeconds', what),
    nextAllowedAt: strOrNull(row, 'nextAllowedAt', what),
  };
}

function bool(row: Record<string, unknown>, key: string, what: string): boolean {
  const value = row[key];
  if (typeof value !== 'boolean') throw new TypeError(`${what} has no ${key}`);
  return value;
}

export function decodeFxManualSyncResult(input: unknown): FxManualSyncResultWire {
  const what = 'fx manual sync result';
  const row = asObject(input, what);
  const outcome = row['outcome'];
  if (
    outcome !== 'stored' &&
    outcome !== 'unchanged' &&
    outcome !== 'failed' &&
    outcome !== 'disabled'
  ) {
    throw new TypeError(`${what} has an unknown outcome`);
  }

  return {
    outcome,
    observedAt: strOrNull(row, 'observedAt', what),
    previousObservedAt: strOrNull(row, 'previousObservedAt', what),
    failureStage: strOrNull(row, 'failureStage', what),
    manualSync: decodeManualSyncBudget(row['manualSync']),
  };
}

/** `organisation.read` — the permission that already opens the screen this renders on. */
export const getFxRateHealth = (): Promise<FxRateHealthWire> =>
  apiJson('/admin/fx/health', decodeFxRateHealth);

/**
 * ⭐ Fetch the rates now — `organisation.write`, and no body.
 *
 * No `Content-Type` and no `body`, because there is nothing to send: the route takes no
 * parameters on purpose, so that nothing about *what* gets fetched is reachable from a client.
 * `beginEnrolment` in `mfa-api.ts` is the same bodyless POST for the same reason.
 *
 * A refusal by the quota guard arrives as an ordinary `ApiError` with `code: 'TOO_MANY_REQUESTS'`
 * and the Thai sentence already rendered by the server, so the caller needs no special branch —
 * `failureMessage` handles it exactly as it handles every other refusal on this page.
 */
export const postFxManualSync = (): Promise<FxManualSyncResultWire> =>
  apiJson('/admin/fx/sync', decodeFxManualSyncResult, { method: 'POST' });
