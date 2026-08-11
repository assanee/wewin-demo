import { afterAll, describe, expect, it } from 'vitest';

import { DEFAULT_VAT_RULE } from '../../src/orders/defaults';
import { TaxCountryService } from '../../src/organisation/tax-country.service';
import { createPgHarness } from '../support/pg-harness';

/**
 * `TaxCountryService.resolveDestination` — the one place an order's destination code becomes
 * a tax rule (Task 7, spec §3/§5.1).
 *
 * Four cases, and the second is the one worth a database rather than a mock: `'TH'`
 * withdrawn (`isActive: false`) must still resolve to its own rule. `isActive` governs which
 * destinations a *new* customer is offered, not whether an order that already named this one
 * is still valid — refusing here would turn a routine withdrawal into a customer-facing
 * outage, and would make the missing foreign key on `orders.destination_country` (spec §4.4)
 * pointless, since the constraint violation it would otherwise be would just have been
 * relabelled a validation error. `'XX'`, a code that never had a row, is refused instead:
 * `tax_countries_block_delete` means a row that once existed still exists, so an unknown code
 * is a client bug or a tampered request, and a silent fallback to Thai VAT would compute a
 * foreign sale's tax wrong and pin it to a document with nothing recording that a fallback
 * happened.
 *
 * `createPgHarness` (`tests/support/pg-harness.ts`) does the actual provisioning — see its own
 * header and `tax-country.pg.test.ts`'s for why a fresh database per call rather than a shared
 * `beforeAll`: `TH` is migration 0029's one seeded, undeletable row, and `service.create`
 * below adds a second (`SG`) that has to start from a known, empty slate too.
 *
 * ⚠️ `undefined` is spelled out at every call below rather than omitted. `tx` became a
 * *required* `Tx | undefined` in fix round 1 of Task 9 — see that method's own note. These four
 * cases genuinely have no transaction; `OrdersService.submit` genuinely does, and the point of
 * the change is that neither can be the accident of a missing argument.
 *
 * Skipped, not failed, without a database.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

interface Harness {
  readonly service: TaxCountryService;
  readonly actor: { readonly id: string };
}

describeWithPg('resolveDestination against Postgres', () => {
  const base = createPgHarness(url ?? '');

  const harness = async (): Promise<Harness> => {
    const { app, actor } = await base.harness();
    return { service: app.app.get(TaxCountryService), actor };
  };

  afterAll(base.closeOpened);

  it('resolves an active country to its own rule and basis', async () => {
    const { service, actor } = await harness();
    await service.create(
      { code: 'SG', nameTh: 'สิงคโปร์', rateBp: 900, treatment: 'standard', pricesIncludeTax: true },
      actor.id,
    );

    expect(await service.resolveDestination('SG', undefined)).toStrictEqual({
      code: 'SG',
      rule: { rateBp: 900, treatment: 'standard' },
      basis: 'inclusive',
      known: true,
    });
  });

  it('still resolves a WITHDRAWN country, because a cart already carrying it must not brick', async () => {
    const { service, actor } = await harness();
    await service.setAvailability('TH', false, actor.id);

    /* is_active governs what new customers are offered, not whether an existing cart is valid.
       Refusing here would turn a routine withdrawal into a customer-facing outage — and would
       make omitting the foreign key (spec §4.4) pointless, since the constraint violation would
       just have been relabelled a validation error. */
    expect(await service.resolveDestination('TH', undefined)).toStrictEqual({
      code: 'TH',
      rule: { rateBp: 700, treatment: 'standard' },
      basis: 'exclusive',
      known: true,
    });
  });

  it('refuses a code that never existed rather than falling back to Thai VAT', async () => {
    const { service } = await harness();

    /* tax_countries_block_delete means a row that once existed still exists, so an unknown code
       is a client bug or a tampered request. A silent fallback would compute Thai tax on a
       foreign sale and pin it, permanently, with nothing recording that a fallback happened. */
    /* `toMatchObject`, not `toThrow`. `AppError` sets `Error.message` from its first argument only;
       a `{ reason }` object goes to `details`, which a message regex never sees. */
    await expect(service.resolveDestination('XX', undefined)).rejects.toMatchObject({
      details: { reason: 'unknown_destination_country' },
    });
  });

  /**
   * ⭐ The same code, for a caller that pins nothing — and the reason the two readings differ.
   *
   * The refusal above is about the **pin**: falling back would compute Thai tax on a foreign
   * sale and freeze it. A read freezes nothing, and once `GET /orders/:id/quote` and every
   * quote write started resolving, that refusal made a two-character typo terminal — the cart
   * could not be opened, edited, or corrected, because `applySubmission` is the only writer of
   * `orders.destination_country`.
   *
   * So this returns rather than throws, keeps the code the order actually names, and reports
   * `known: false` — which is what stops it being the silent fallback the refusal exists to
   * prevent. The arithmetic is the default's; the answer says so.
   */
  it('degrades an unknown code for an editing caller, and preserves the code so it can be fixed', async () => {
    const { service } = await harness();

    expect(await service.resolveForEditing('XX', undefined)).toStrictEqual({
      code: 'XX',
      rule: DEFAULT_VAT_RULE,
      basis: 'exclusive',
      known: false,
    });
  });

  /** A code that *does* resolve is identical either way — the two readings differ on one case. */
  it('is the same answer as resolveDestination for every code that resolves', async () => {
    const { service, actor } = await harness();
    await service.create(
      { code: 'SG', nameTh: 'สิงคโปร์', rateBp: 900, treatment: 'standard', pricesIncludeTax: true },
      actor.id,
    );

    for (const code of ['SG', 'TH', null]) {
      expect(await service.resolveForEditing(code, undefined), code ?? 'null').toStrictEqual(
        await service.resolveDestination(code, undefined),
      );
    }
  });

  it('falls back to the default rule when the order names no destination', async () => {
    const { service } = await harness();

    expect(await service.resolveDestination(null, undefined)).toStrictEqual({
      code: null,
      rule: DEFAULT_VAT_RULE,
      basis: 'exclusive',
      known: true,
    });
  });
});
