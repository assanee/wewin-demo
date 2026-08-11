import { z } from 'zod';

/**
 * The one shape this module trusts out of `latest.json`. `disclaimer` and `license` are
 * accepted and dropped rather than named, so provider wording changes are not a schema
 * break here — only `timestamp`, `base` and `rates` are ever read.
 *
 * `timestamp` is UNIX UTC seconds and is the provider's own "when I last updated this",
 * not "when you asked" — `FxRatesService` converts it and stores it separately from
 * `fetchedAt` for exactly that reason.
 */
const latestRatesSchema = z.object({
  timestamp: z.number().int().positive(),
  base: z
    .string()
    .regex(/^[A-Z]{3}$/, 'base must be three upper-case letters'),
  rates: z.record(z.string(), z.number()),
});

export type LatestRates = z.infer<typeof latestRatesSchema>;

export type ParsedLatestRates = { readonly ok: true; readonly value: LatestRates } | { readonly ok: false; readonly reason: string };

/**
 * Never throws — a malformed body is a value this function returns, not an exception the
 * caller has to wire a try/catch around. `FxRatesService` treats `ok: false` exactly like
 * a non-200: logged, nothing stored, wait for the next tick.
 */
export function parseLatestRates(body: unknown): ParsedLatestRates {
  const result = latestRatesSchema.safeParse(body);
  if (result.success) return { ok: true, value: result.data };

  const reason = result.error.issues[0]?.message ?? 'did not match the expected shape';
  return { ok: false, reason };
}
