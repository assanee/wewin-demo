import { afterAll, describe, expect, it } from 'vitest';

import type { Database } from '@wewin/db/client';

import { TaxCountryRepository } from '../../src/organisation/tax-country.repository';
import { TaxCountryService } from '../../src/organisation/tax-country.service';
import { createPgHarness } from '../support/pg-harness';

/**
 * `TaxCountryService` and `TaxCountryRepository` against a real Postgres.
 *
 * The property this file exists to prove lives *between* the tax-country write and the
 * history write: the service says both happen in one transaction with a locked pre-image,
 * and the only way to catch a version that quietly split them — or dropped the lock — is to
 * write real rows through real concurrent connections and count what landed. A mock has no
 * trigger to fail, no second statement to lose and no second connection to race against.
 *
 * ── Why `harness()` provisions a fresh database on every call ────────────────────────────
 *
 * `organisation.pg.test.ts`'s bank-account describe boots one app in `beforeAll` and shares it
 * across every test in that block, because each test there creates its *own* fresh bank
 * account — there is no singleton row to collide over. This file cannot do that: `TH` is the
 * one row migration 0029 seeds, `tax_countries_block_delete` refuses to let anything delete it,
 * and `tax_country_changes_append_only` refuses to let anything delete or edit a history row
 * either. Every test below asserts an *absolute* count of TH's history (0, 1, 2 rows), and
 * that assertion is only meaningful against a database nothing earlier in the run has touched.
 *
 * `createPgHarness` (`tests/support/pg-harness.ts`) does the actual provisioning — drop,
 * create, migrate, re-seed, boot a fresh app, pre-warm its pool — because Task 4's profile-
 * history suite in `organisation.pg.test.ts` needs the identical dance for `organisation_profile`'s
 * own singleton row and its own append-only history table, and the reasoning for every step of
 * it (why re-provision, why re-seed, why pre-warm) does not change between the two tables.
 * `harness()` below is a thin wrapper that resolves this module's own two services from the
 * generic `{ app, actor, db }` the shared handle returns — every existing call site keeps its
 * `{ service, repository, actor, db }` shape unchanged.
 *
 * Skipped, not failed, without a database.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

interface Harness {
  readonly service: TaxCountryService;
  readonly repository: TaxCountryRepository;
  readonly actor: { readonly id: string };
  readonly db: Database;
}

describeWithPg('the tax-country module against Postgres', () => {
  const base = createPgHarness(url ?? '');

  /**
   * Return shape is fixed on purpose: `{ service, repository, actor, db }`. Task 5 reuses this
   * function rather than writing a second one, so nothing about its signature is incidental —
   * `actor.id` (not `actor.userId`) is what every call site below passes as the acting user.
   */
  const harness = async (): Promise<Harness> => {
    const { app, actor, db } = await base.harness();
    return {
      service: app.app.get(TaxCountryService),
      repository: app.app.get(TaxCountryRepository),
      actor,
      db,
    };
  };

  afterAll(base.closeOpened);

  describe('tax country writes', () => {
    it('records a change with the previous values in `before`', async () => {
      const { service, actor } = await harness();

      await service.patch('TH', { rateBp: 800 }, actor.id);
      const [entry] = await service.changes('TH');

      expect(entry?.before).toMatchObject({ rateBp: 700, treatment: 'standard' });
      expect(entry?.after).toMatchObject({ rateBp: 800, treatment: 'standard' });
    });

    it('keeps history contiguous under concurrent patches', async () => {
      const { service, actor } = await harness();

      /* Both at once. Without the row lock in lockCountry, both read 700 and the chain breaks:
         entry[1].before would be 700 rather than entry[0].after. P1's final review found this
         exact defect on a lens that had already passed. */
      await Promise.all([
        service.patch('TH', { rateBp: 800 }, actor.id),
        service.patch('TH', { rateBp: 900 }, actor.id),
      ]);

      /* `changes()` orders by `changedAt` ASC — oldest first — so do NOT reverse it. Entry 1's
         `before` must equal entry 0's `after`; on a reversed array that comparison is backwards
         and passes for the wrong reason. */
      const entries = await service.changes('TH');
      expect(entries).toHaveLength(2);
      expect((entries[1]?.before as { rateBp: number }).rateBp).toBe(
        (entries[0]?.after as { rateBp: number }).rateBp,
      );
    });

    it('writes no history row when the write fails', async () => {
      const { service, actor } = await harness();

      await expect(service.patch('TH', { rateBp: 20_000 }, actor.id)).rejects.toThrow();
      expect(await service.changes('TH')).toHaveLength(0);
    });

    it('creates a country and records the creation with a null `before`', async () => {
      const { service, actor } = await harness();

      await service.create(
        { code: 'SG', nameTh: 'สิงคโปร์', rateBp: 900, treatment: 'standard', pricesIncludeTax: true },
        actor.id,
      );
      const [entry] = await service.changes('SG');

      expect(entry?.before).toBeNull();
      expect(entry?.after).toMatchObject({ code: 'SG', rateBp: 900, pricesIncludeTax: true });
    });

    /**
     * ⭐ A spread change on the audit chain — the property the FX settings were added to
     * `RECORDED` for.
     *
     * A spread moves what a customer pays without moving a single figure a VAT return would
     * print, so widening it for one deal and narrowing it back afterwards leaves no trace
     * anywhere else in the system. The attack is `tax_country_changes`' original one exactly,
     * one column across, and the only thing that makes it visible is that this snapshot
     * carries `fxSpreadBp` before and after. Drop it from `RECORDED` and this reddens.
     */
    it('records a spread change, before and after, on the same chain a rate change uses', async () => {
      const { service, actor } = await harness();

      await service.patch('TH', { fxCurrency: 'USD', fxSpreadBp: 200 }, actor.id);
      await service.patch('TH', { fxSpreadBp: 350 }, actor.id);
      await service.patch('TH', { fxSpreadBp: 200 }, actor.id);

      const entries = await service.changes('TH');
      expect(entries).toHaveLength(3);

      // The there-and-back that no other table would show: 2% → 3.5% → 2%.
      expect(entries.map((entry) => (entry.after as { fxSpreadBp: number }).fxSpreadBp)).toEqual([
        200, 350, 200,
      ]);
      expect(entries[1]?.before).toMatchObject({ fxSpreadBp: 200, fxCurrency: 'USD' });
      expect(entries[2]?.before).toMatchObject({ fxSpreadBp: 350 });
    });

    /**
     * The override is on the chain as digits, and the spread it silently stops applying is on
     * the same snapshot beside it — so a reviewer can see both the rate that ran and the
     * setting that did not. Neither is reconstructible from the other.
     */
    it('records an override as exact digits, with the spread it made inert still beside it', async () => {
      const { service, actor } = await harness();

      await service.patch('TH', { fxCurrency: 'USD', fxSpreadBp: 200 }, actor.id);
      const updated = await service.patch('TH', { fxManualRate: '35.90' }, actor.id);

      // `numeric`, so it comes back as exact digits padded to the column's scale — never a float.
      expect(updated.fxManualRate).toBe('35.9000000000');

      const [, second] = await service.changes('TH');
      expect(second?.before).toMatchObject({ fxSpreadBp: 200, fxManualRate: null });
      expect(second?.after).toMatchObject({ fxSpreadBp: 200, fxManualRate: '35.9000000000' });
    });

    it('clears an override back to the mid-market rate, and the chain shows the clearing', async () => {
      const { service, actor } = await harness();

      await service.patch('TH', { fxCurrency: 'USD', fxSpreadBp: 200, fxManualRate: '35.90' }, actor.id);
      const cleared = await service.patch('TH', { fxManualRate: null }, actor.id);

      expect(cleared.fxManualRate).toBeNull();
      // The spread survived the round trip — which is why clearing the override restores it.
      expect(cleared.fxSpreadBp).toBe(200);

      const [, second] = await service.changes('TH');
      expect(second?.after).toMatchObject({ fxManualRate: null, fxSpreadBp: 200 });
    });

    it('withdraws a country by flag, and the row survives', async () => {
      const { service, actor } = await harness();

      const withdrawn = await service.setAvailability('TH', false, actor.id);

      expect(withdrawn.isActive).toBe(false);
      expect(await service.list(false)).toHaveLength(1);
      expect(await service.list(true)).toHaveLength(0);
    });
  });

  /*
   * ── Constraint translation: fix round 1 ──────────────────────────────────────────────────
   *
   * The finding: a body that validates cleanly against Task 2's zod schemas can still trip a
   * database CHECK or the primary key, and without `pg-errors.ts` each of those reached the
   * caller as a raw `DrizzleQueryError` — a 500 for something a client did on purpose. Every
   * test below asserts the *translated* `AppError` — its `code` and `details`, never the raw
   * SQLSTATE — and that the write's own transaction rolled back with no history row, which is
   * as much the contract as the status code.
   */
  describe('constraint translation, not a raw 500', () => {
    it('patch on a code that does not exist is a 404, not a 500 — the one path to error.tax_country.missing', async () => {
      const { service, actor } = await harness();

      await expect(service.patch('ZZ', { rateBp: 800 }, actor.id)).rejects.toMatchObject({
        code: 'NOT_FOUND',
        status: 404,
        serverMessage: { key: 'error.tax_country.missing' },
      });
      expect(await service.changes('ZZ')).toHaveLength(0);
    });

    it('patching treatment on a nonzero-rate country is a 409 naming the constraint, not a 500', async () => {
      const { service, actor } = await harness();

      // TH seeds at rate_bp 700 — zero-rating it without clearing the rate is exactly the
      // reviewer's probe, and exactly the mistake a real admin will make.
      await expect(service.patch('TH', { treatment: 'zero_rated' }, actor.id)).rejects.toMatchObject({
        code: 'CONFLICT',
        status: 409,
        details: { constraint: 'tax_countries_rate_matches_treatment' },
        serverMessage: { key: 'error.tax_country.rate_treatment_conflict' },
      });
      expect(await service.changes('TH')).toHaveLength(0);
    });

    it('creating a country with a code already in use is a 409 naming the primary key, not a 500', async () => {
      const { service, actor } = await harness();

      await expect(
        service.create(
          { code: 'TH', nameTh: 'ไทย (ซ้ำ)', rateBp: 0, treatment: 'standard', pricesIncludeTax: true },
          actor.id,
        ),
      ).rejects.toMatchObject({
        code: 'CONFLICT',
        status: 409,
        details: { constraint: 'tax_countries_pkey' },
        serverMessage: { key: 'error.tax_country.code_taken' },
      });
      expect(await service.changes('TH')).toHaveLength(0);
    });

    /**
     * ⭐ The fourth entry in `pg-errors.ts`' `EXPLANATIONS`, and the second constraint on this
     * table with no zod equivalent at all. `{ fxManualRate: '35.90' }` is a perfectly
     * well-formed patch; whether it is legal depends on the `fx_currency` already committed on
     * the row, which is why it is answered as a 409 with a sentence naming the second field to
     * send rather than as a 500.
     */
    it('setting an override on a destination with no currency is a 409 naming the constraint', async () => {
      const { service, actor } = await harness();

      await expect(service.patch('TH', { fxManualRate: '35.90' }, actor.id)).rejects.toMatchObject({
        code: 'CONFLICT',
        status: 409,
        details: { constraint: 'tax_countries_fx_manual_rate_needs_currency' },
        serverMessage: { key: 'error.tax_country.fx_rate_needs_currency' },
      });
      expect(await service.changes('TH')).toHaveLength(0);
    });

    it('creating a country with a whitespace-only name is a 422 naming the constraint, not a 500', async () => {
      const { service, actor } = await harness();

      // zod's `nameTh: z.string().min(1)` counts the raw string — three spaces has length 3
      // and passes it — while the database's `length(btrim(name_th)) > 0` does not.
      await expect(
        service.create(
          { code: 'ZZ', nameTh: '   ', rateBp: 0, treatment: 'standard', pricesIncludeTax: true },
          actor.id,
        ),
      ).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
        status: 422,
        details: { constraint: 'tax_countries_name_says_something' },
        serverMessage: { key: 'error.tax_country.name_blank' },
      });
      expect(await service.changes('ZZ')).toHaveLength(0);
    });
  });
});
