import { thbPerUnitText } from '@wewin/core/fx';
import { fxRates } from '@wewin/db/schema';
import { afterAll, describe, expect, it } from 'vitest';

import { QuotationRateService } from '../../src/fx/quotation-rate.service';
import { TaxCountryService } from '../../src/organisation/tax-country.service';
import { createPgHarness } from '../support/pg-harness';

/**
 * `QuotationRateService.forDestination` — which observation counts as "the" rate for a
 * quotation, and what happens when there is not one.
 *
 * The arithmetic is core's and is proved exhaustively in `packages/core/tests/fx.test.ts`; this
 * file proves the two things that only a database can prove, because both are statements about
 * *rows* rather than about numbers:
 *
 *   1. **Which row.** The newest `fx_rates` row by `fetched_at`, and the deciding case is set up
 *      so that "newest" disagrees with insertion order *and* with `rate_timestamp` order —
 *      neither an `asc` nor an ordering on the wrong column can pass it.
 *   2. **THE RULE, end to end through the row that configures it.** A manual override is used
 *      exactly as typed and the spread is not applied on top (`packages/core/src/fx.ts`'s
 *      header). Both fixtures below carry a 200 bp spread, so the manual case and the
 *      mid-market case differ in whether it moved the answer and not in whether it was set.
 *
 * And the refusal, which is this service's own decision rather than core's: a destination
 * configured for a foreign currency with no usable rate behind it **fails the submit** instead
 * of quietly printing baht. `order_documents_freeze` blocks UPDATE forever, so a document that
 * contradicts its own configuration can never be corrected — while a refused submit is a
 * sentence on a screen and an administrator typing an override.
 *
 * ⚠️ A fresh database per test, via `createPgHarness`, and it is not ceremony here. `fx_rates`
 * is append-only (0033) so a test cannot take its own rows back, and three of the cases below
 * are *about* what is in that table — including one that is about it being empty. The same
 * trade `tax-country.pg.test.ts` and `destination-tax.pg.test.ts` name for their own singletons.
 *
 * ⚠️ `undefined` is spelled out at every call. `tx` is a *required* `Tx | undefined` on
 * `forDestination`, the same discipline `TaxCountryService.resolveDestination` adopted and for
 * the same reason: these cases genuinely have no transaction, `OrdersService.submit` genuinely
 * does, and neither may be the accident of a missing argument.
 *
 * Skipped, not failed, without a database.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

/**
 * The two observations, and the reason their timestamps are deliberately at odds.
 *
 * `NEWER` was fetched five months after `OLDER` and carries a rate struck a month *before* it —
 * an inversion a real provider produces every time it re-serves a stale `timestamp` after an
 * outage, which is exactly why `FxRatesRepository.latest` orders on `fetched_at`. It is also
 * inserted first, so row order cannot stand in for fetch order either.
 *
 * The rates are round numbers nobody would mistake for market data: 40 THB and 2 SGD to the USD
 * makes the cross-rate exactly 20 THB/SGD, so a spread or a rounding that went missing is
 * visible by reading rather than by recomputing.
 */
interface SnapshotFixture {
  readonly fetchedAt: Date;
  readonly rateTimestamp: Date;
  readonly base: string;
  readonly rates: Record<string, number>;
  readonly source: string;
}

const NEWER: SnapshotFixture = {
  fetchedAt: new Date('2026-06-01T00:00:00Z'),
  rateTimestamp: new Date('2025-12-01T00:00:00Z'),
  base: 'USD',
  rates: { THB: 40, SGD: 2 },
  source: 'openexchangerates',
};

const OLDER: SnapshotFixture = {
  fetchedAt: new Date('2026-01-01T00:00:00Z'),
  rateTimestamp: new Date('2026-01-01T00:00:00Z'),
  base: 'USD',
  rates: { THB: 36.5, SGD: 1.34 },
  source: 'openexchangerates',
};

describeWithPg('QuotationRateService.forDestination against Postgres', () => {
  const base = createPgHarness(url ?? '');

  interface Harness {
    readonly fx: QuotationRateService;
    readonly countries: TaxCountryService;
    readonly actor: { readonly id: string };
    readonly snapshot: (row: SnapshotFixture) => Promise<void>;
  }

  const harness = async (): Promise<Harness> => {
    const { app, actor, db } = await base.harness();
    return {
      fx: app.app.get(QuotationRateService),
      countries: app.app.get(TaxCountryService),
      actor,
      snapshot: async (row) => {
        await db.insert(fxRates).values({ ...row, rates: { ...row.rates } });
      },
    };
  };

  afterAll(base.closeOpened);

  /**
   * A destination quoted in SGD, with a 200 bp spread on the row.
   *
   * The spread is set on *every* fixture on purpose — see the file header. Where a manual rate
   * is also set it must not move the answer, and where one is not it must.
   */
  const singapore = async (
    countries: TaxCountryService,
    actorId: string,
    fxManualRate?: string,
  ): Promise<void> => {
    await countries.create(
      {
        code: 'SG',
        nameTh: 'สิงคโปร์',
        rateBp: 900,
        treatment: 'standard',
        pricesIncludeTax: true,
        fxCurrency: 'SGD',
        fxSpreadBp: 200,
        ...(fxManualRate === undefined ? {} : { fxManualRate }),
      },
      actorId,
    );
  };

  it('uses a manual override exactly as typed, does not apply the spread on top, and reports no observation', async () => {
    const { fx, countries, actor, snapshot } = await harness();
    await singapore(countries, actor.id, '27.05');
    /* A perfectly good snapshot, present and ignored — that is the claim. */
    await snapshot(OLDER);

    const resolved = await fx.forDestination('SG', undefined);

    expect(resolved).not.toBeNull();
    expect(resolved?.rate.source).toBe('manual');
    /* THE RULE: 27.05 exactly, not 27.05 × 0.98 = 26.509 — a bank's quoted rate already carries
       the bank's margin, and applying the spread would charge it twice. */
    expect(thbPerUnitText(resolved!.rate)).toBe('27.050000');
    /* `spreadBp` reports what was *applied*, not what is on the row. The row says 200. */
    expect(resolved?.rate.spreadBp).toBe(0);
    /* Neither of these would be null had the snapshot been used, which is the other half of
       "ignored": 36.5/1.34 is a perfectly resolvable mid-market rate sitting right there. */
    expect(resolved?.rate.midThbPerUnit).toBeNull();
    expect(resolved?.rate.provider).toBeNull();
    /* ⭐ An override has no provider and no observation. Stamping the row's `updated_at` here
       would put a date on a document that reads like a market observation and is not one. */
    expect(resolved?.observedAt).toBeNull();
  });

  /**
   * ⭐ The load-bearing half of the claim `NO_SNAPSHOT_NEEDED` makes.
   *
   * `resolveFxRate`'s manual branch returns before touching the snapshot, so an override must
   * resolve against an empty `fx_rates` — a destination whose whole point is that somebody typed
   * the rate being unquotable on a day the provider was down would invert the reason for typing
   * one in. This is the test that fails the day core reorders those branches, which is the
   * failure the empty-and-not-plausible placeholder was chosen to produce.
   */
  it('resolves a manual override with fx_rates completely empty', async () => {
    const { fx, countries, actor } = await harness();
    await singapore(countries, actor.id, '27.05');

    const resolved = await fx.forDestination('SG', undefined);

    expect(thbPerUnitText(resolved!.rate)).toBe('27.050000');
    expect(resolved?.observedAt).toBeNull();
  });

  /**
   * ⭐ Which row, decided three ways at once.
   *
   * `NEWER` is inserted **first** and carries an **older** `rate_timestamp`, so the row that
   * wins can only have been chosen by `fetched_at DESC`. An `asc`, an ordering on
   * `rate_timestamp`, and a bare `limit 1` with no ordering at all each land on `OLDER`, whose
   * cross-rate is 36.5/1.34 ≈ 27.24 rather than 20 — nowhere near the expected figure.
   */
  it('prices against the newest snapshot by fetched_at, not by insertion order or rate_timestamp', async () => {
    const { fx, countries, actor, snapshot } = await harness();
    await singapore(countries, actor.id);
    await snapshot(NEWER);
    await snapshot(OLDER);

    const resolved = await fx.forDestination('SG', undefined);

    expect(resolved?.rate.source).toBe('mid_market');
    /* The cross-rate through USD is 40 ÷ 2 = 20 THB/SGD; the 200 bp spread marks the *rate*
       down, so 20 × 0.98 = 19.6. Both halves are visible in one figure. */
    expect(thbPerUnitText(resolved!.rate)).toBe('19.600000');
    expect(resolved?.rate.spreadBp).toBe(200);
    /* The provider figures, verbatim — this is what names which row was read, independently of
       any arithmetic that could coincide. */
    expect(resolved?.rate.provider).toStrictEqual({ base: 'USD', thbPerBase: 40, unitPerBase: 2 });
    /* `rate_timestamp` and not `fetched_at`: what a document can honestly claim is when the
       provider struck the rate. The two differ by five months in this fixture, on purpose. */
    expect(resolved?.observedAt).toBe(NEWER.rateTimestamp.toISOString());
  });

  /**
   * ⭐ Fail closed, and the reason this is the interesting test in the file.
   *
   * Nothing here is broken: the destination is configured, the sync simply has not run. The
   * tempting answer is to print baht, and it is the one answer that cannot be taken back —
   * `order_documents_freeze` blocks UPDATE forever, so the document would contradict its own
   * configuration in front of a customer, permanently. So the submit is refused instead, in a
   * sentence that names the two things staff can actually do about it.
   */
  it('refuses rather than quietly quoting baht when there is no snapshot and no manual rate', async () => {
    const { fx, countries, actor } = await harness();
    await singapore(countries, actor.id);

    /* `toMatchObject` on `details`, not `toThrow` on a message: `AppError` builds `Error.message`
       from its first argument only, and a regex over it never sees the structured half. */
    await expect(fx.forDestination('SG', undefined)).rejects.toMatchObject({
      status: 422,
      details: {
        reason: 'fx_rate_unavailable',
        cause: 'no_snapshot',
        destinationCountry: 'SG',
        currency: 'SGD',
      },
    });
  });

  /**
   * The same refusal for the other way a rate can be missing: a snapshot that exists and has no
   * SGD in it. One situation — we have no rate — reported with the finer cause kept for a log
   * rather than for control flow, because there is nothing different to do about it.
   */
  it('refuses when the newest snapshot has no rate for the destination currency', async () => {
    const { fx, countries, actor, snapshot } = await harness();
    await singapore(countries, actor.id);
    await snapshot({ ...OLDER, rates: { THB: 36.5 } });

    await expect(fx.forDestination('SG', undefined)).rejects.toMatchObject({
      details: { reason: 'fx_rate_unavailable', cause: 'destination_rate_missing' },
    });
  });

  it('returns null for an order that names no destination — a baht quotation, not a failure', async () => {
    const { fx } = await harness();

    expect(await fx.forDestination(null, undefined)).toBeNull();
  });

  /**
   * `TH` is migration 0029's seeded row and has no `fx_currency`, which is the ordinary state of
   * every domestic destination. `null` here means "quoted in baht" and is not degradation —
   * `tax_countries_fx_manual_rate_needs_currency` means there is no state where a rate is
   * configured and this still answers `null`.
   */
  it('returns null for a destination with no fx_currency, even with a snapshot available', async () => {
    const { fx, snapshot } = await harness();
    await snapshot(NEWER);

    expect(await fx.forDestination('TH', undefined)).toBeNull();
  });

  /**
   * ⭐ An unknown code throws rather than answering `null`, and the distinction is the whole
   * point: `null` means baht, so a tampered or mistyped country would print baht on a document
   * configured for something else. It is `resolveDestination`'s refusal, deliberately repeated,
   * so that the ordering of the two calls in `submit` is not load-bearing.
   */
  it('refuses a code that names no row rather than treating it as a baht quotation', async () => {
    const { fx } = await harness();

    await expect(fx.forDestination('XX', undefined)).rejects.toMatchObject({
      details: { reason: 'unknown_destination_country', destinationCountry: 'XX' },
    });
  });
});
