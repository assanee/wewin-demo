import { Injectable } from '@nestjs/common';

// Through @wewin/db and not 'drizzle-orm' directly — see the note in packages/db/src/sql.ts.
import { eq, sql } from '@wewin/db/sql';
import { taxCountries, taxCountryChanges } from '@wewin/db/schema';
import type {
  DestinationTaxBasis,
  SettingChangeWire,
  TaxCountryCreateRequest,
  TaxCountryPatchRequest,
  TaxCountryWire,
} from '@wewin/contract/tax';
import type { TaxRule, TaxTreatment } from '@wewin/core/vat';

import { AppError } from '../common/errors/app-error';
import { message } from '../i18n';
import { DEFAULT_VAT_RULE } from '../orders/defaults';
import { withTranslatedOrganisationErrors } from './pg-errors';
import { TaxCountryRepository, type Tx } from './tax-country.repository';

/**
 * The fields the history records. Ordering and timestamps are not changes worth keeping.
 *
 * ⚠️ `updatedByUserId` is deliberately not here, for the same reason `organisation.service.ts`
 * leaves it out of `bankAccounts`' own `RECORDED`: erasure scrubs that column to `NULL`
 * directly, outside this service, and with no history row — there is nothing a history row
 * could have recorded that the erasure changes.
 */
const RECORDED = [
  'code',
  'nameTh',
  'rateBp',
  'treatment',
  'pricesIncludeTax',
  'isActive',
  'sortOrder',
] as const;

const snapshot = (row: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(RECORDED.map((key) => [key, row[key] ?? null]));

/**
 * A row as `taxCountries` actually returns it — `treatment` is `text` + CHECK rather than a
 * `pgEnum` (see the schema's own note on why), so the cast below is the one place that
 * narrows it back to the four values the CHECK already guarantees.
 */
interface TaxCountryRow {
  readonly code: string;
  readonly nameTh: string;
  readonly rateBp: number;
  readonly treatment: string;
  readonly pricesIncludeTax: boolean;
  readonly isActive: boolean;
  readonly sortOrder: number;
  readonly updatedAt: Date;
}

const wire = (row: TaxCountryRow): TaxCountryWire => ({
  code: row.code,
  nameTh: row.nameTh,
  rateBp: row.rateBp,
  treatment: row.treatment as TaxCountryWire['treatment'],
  pricesIncludeTax: row.pricesIncludeTax,
  isActive: row.isActive,
  sortOrder: row.sortOrder,
  updatedAt: row.updatedAt.toISOString(),
});

/**
 * A destination code, resolved to what it charges — the one place a code becomes a tax rule
 * (spec §3), returned by `resolveDestination` below.
 *
 * `basis` is deliberately not on `TaxRule`: see the amended header of `packages/core/src/
 * vat.ts`. `TaxRule` still carries exactly a rate and a treatment, so no code path can vary
 * the basis per line or per quotation — the caller reads `basis` off this envelope and picks
 * `fromNet` or `fromGrand` itself.
 */
export interface DestinationTax {
  /** `null` when the order names no destination. */
  readonly code: string | null;
  readonly rule: TaxRule;
  readonly basis: DestinationTaxBasis;
  /**
   * Whether `code` named a row in `tax_countries`.
   *
   * `true` for every destination that resolved, **including `code: null`** — naming no country
   * is a known state with a known answer (`DEFAULT_VAT_RULE`, `exclusive`). It is `false` only
   * for an envelope `resolveForEditing` built for a code the table has no row for, where `rule`
   * and `basis` are the default's and are **not** this country's.
   *
   * `resolveDestination` never returns `false`: it throws instead. So a `false` cannot reach
   * `priceOrderDocument` by any path, which is the property that keeps the pin honest while the
   * editor stays open.
   */
  readonly known: boolean;
}

const encodeChange = (row: {
  readonly id: string;
  readonly changedAt: Date;
  readonly changedByUserId: string | null;
  readonly before: unknown;
  readonly after: unknown;
}): SettingChangeWire => ({
  id: row.id,
  changedAt: row.changedAt.toISOString(),
  changedByUserId: row.changedByUserId,
  before: row.before ?? null,
  after: row.after,
});

/**
 * The destinations the company sells to, and what tax each one attracts.
 *
 * ⚠️ **The essential rule, same as `OrganisationService`: a tax-country write and its history
 * row are one transaction.** `tax_country_changes_append_only` (migration 0029) stops a
 * history row being edited or deleted after the fact; nothing in the database stops one
 * being *skipped*. That half of the invariant is this file's job, and every write below is a
 * single `transaction()` call whose last statement is the `INSERT` into `taxCountryChanges`.
 *
 * `patch` and `create` return `TaxCountryWire` directly rather than a raw row for the
 * controller to encode — the one deliberate difference from `OrganisationService`, which
 * this brief's interface list states outright rather than leaving to convention.
 *
 * ⚠️ Both writes are also wrapped in `withTranslatedOrganisationErrors` — see `pg-errors.ts`.
 * A body that validates cleanly against Task 2's zod schemas can still trip
 * `tax_countries_rate_matches_treatment`, `tax_countries_name_says_something` or the primary
 * key, and without translation each of those would reach the caller as a raw
 * `DrizzleQueryError`: a 500 plus a production alert for something a client did on purpose.
 */
@Injectable()
export class TaxCountryService {
  constructor(private readonly repository: TaxCountryRepository) {}

  async list(activeOnly: boolean): Promise<TaxCountryWire[]> {
    const rows = await this.repository.list(undefined, { activeOnly });
    return rows.map(wire);
  }

  async create(body: TaxCountryCreateRequest, userId: string): Promise<TaxCountryWire> {
    return withTranslatedOrganisationErrors(() =>
      this.repository.transaction(async (tx) => {
        const [created] = await tx
          .insert(taxCountries)
          .values({ ...body, updatedByUserId: userId })
          .returning();

        /*
         * ⚠️ Same transaction as the write, not a follow-up — see the class comment. A history
         * row that can be skipped is a history somebody skips.
         *
         * `changedAt: clock_timestamp()`, not the column's own `defaultNow()` — see the note on
         * `patch`'s insert below for why the default is the wrong clock for this table.
         */
        await tx.insert(taxCountryChanges).values({
          taxCountryCode: created!.code,
          changedByUserId: userId,
          changedAt: sql`clock_timestamp()`,
          before: null,
          after: snapshot(created!),
        });

        return wire(created!);
      }),
    );
  }

  async patch(code: string, body: TaxCountryPatchRequest, userId: string): Promise<TaxCountryWire> {
    return withTranslatedOrganisationErrors(() =>
      this.repository.transaction(async (tx) => {
        /*
         * ⚠️ Locked, not a plain read. Two PATCHes on the same country can otherwise race under
         * READ COMMITTED: each reads the pre-image before the other's write commits, so both
         * compute a `before` off the same stale row and the resulting history chain no longer
         * has entry N's `before` equal to entry N−1's `after` — see `lockCountry`.
         */
        const [before] = await this.repository.lockCountry(code, tx);
        if (before === undefined) throw AppError.notFound(message('error.tax_country.missing'));

        const [after] = await tx
          .update(taxCountries)
          .set({ ...body, updatedByUserId: userId, updatedAt: new Date() })
          .where(eq(taxCountries.code, code))
          .returning();

        /*
         * ⚠️ `changedAt: clock_timestamp()`, not the column's `defaultNow()`. `now()` — what
         * `defaultNow()` calls — is `transaction_timestamp()`: fixed at BEGIN and frozen for the
         * whole transaction (confirmed by experiment: `select now()` before and after a
         * `pg_sleep` inside one transaction returns the identical instant). Two concurrent
         * `patch()` calls both open their transaction before either reaches `lockCountry`, so the
         * one `FOR UPDATE` blocks can easily have the *earlier* `now()` despite committing
         * *second* — which reorders `changes()` (sorted by `changedAt` ASC) relative to actual
         * commit order and breaks exactly the contiguity this table exists to prove. Verified by
         * mutation-testing the other direction: with the lock restored and this column left on
         * its default, the concurrency test in `tax-country.pg.test.ts` failed at a *rate* rather
         * than a fixed count — anywhere from 1 to 5 of 8 runs across separate sessions, which is
         * the expected shape for a race that depends on exactly how the two transactions happen
         * to interleave, not a number to pin. `clock_timestamp()` reads the real wall clock at the
         * moment this INSERT executes — after `lockCountry` has already waited out any earlier
         * holder of the row — so it reflects commit order instead of BEGIN order.
         *
         * ⚠️ `clock_timestamp()` alone orders nothing — it is a value, not a lock. What actually
         * guarantees entry N's `before` equals entry N−1's `after` is that this `INSERT` runs
         * inside the *same transaction* as `lockCountry`'s row lock, after that lock has already
         * forced any earlier writer to commit first. A `clock_timestamp()` read outside that
         * transaction, or a lock that let go before this statement, would let two inserts land in
         * an order the wall clock cannot fix after the fact.
         */
        await tx.insert(taxCountryChanges).values({
          taxCountryCode: code,
          changedByUserId: userId,
          changedAt: sql`clock_timestamp()`,
          before: snapshot(before),
          after: snapshot(after!),
        });

        return wire(after!);
      }),
    );
  }

  /**
   * Withdraws or restores a destination by flag — never a delete; `tax_countries_block_delete`
   * would refuse one anyway.
   *
   * ⚠️ Reuses `patch` with a cast, deliberately: a copy of `organisation.service.ts`'s
   * `setAvailability`, which reuses `patchAccount` for the identical reason. A withdrawal
   * writes its history row through the exact same path as any other change, rather than a
   * second path that would need its own history-writing discipline proven separately.
   * `taxCountryPatchSchema` has no `isActive` field — it is `z.strictObject`, so a client that
   * sends one is refused at the body pipe — which is what makes the cast safe: nothing
   * reachable from a request body can reach this method except through `setAvailability`
   * itself.
   */
  async setAvailability(code: string, isActive: boolean, userId: string): Promise<TaxCountryWire> {
    return this.patch(code, { isActive } as TaxCountryPatchRequest, userId);
  }

  /** Oldest first — `TaxCountryRepository.changes` already orders by `changedAt` ascending. */
  async changes(code: string): Promise<SettingChangeWire[]> {
    const rows = await this.repository.changes(code);
    return rows.map(encodeChange);
  }

  /**
   * The one place a destination code becomes a tax rule (spec §3). Four cases (spec §5.1):
   *
   * | Order names | Row               | Result                          |
   * |-------------|-------------------|----------------------------------|
   * | `'SG'`      | exists, active    | that row                        |
   * | `'SG'`      | exists, inactive  | that row, resolved normally     |
   * | `'XX'`      | none              | refused, `unknown_destination_country` |
   * | `null`      | —                 | `DEFAULT_VAT_RULE`, `exclusive`, `code: null` |
   *
   * ⚠️ `isActive` is deliberately not read here — `byCode` carries no such filter. It governs
   * which destinations a *new* customer is offered (`list(true)`, the storefront's
   * destinations read), not whether an order that already named this one is still valid.
   * Refusing a withdrawn country would turn a routine withdrawal into a customer-facing
   * outage, and would make the missing foreign key on `orders.destination_country` (spec
   * §4.4) pointless — the constraint violation it would otherwise be would just have been
   * relabelled a validation error.
   *
   * A code that never had a row is a different failure, not the same one loosened.
   * `tax_countries_block_delete` means a row that once existed still exists, so an unknown
   * code is a client bug or a tampered request. Falling back to `DEFAULT_VAT_RULE` here would
   * compute Thai tax on a foreign sale and pin it to the document permanently, with nothing
   * recording that a fallback happened — so this refuses instead, with a `reason` a caller can
   * branch on in `details` (`AppError`'s first argument becomes `Error.message`, not this).
   *
   * ── ⚠️ `tx` is REQUIRED, and may be `undefined` — that is not the same thing ──────
   *
   * It was `tx?: Tx` until fix round 1 of Task 9, and the optionality was a hole nothing could
   * catch. `OrdersService.submit` has to resolve inside its own transaction, but dropping the
   * argument changes **nothing observable**: the pins are identical, the row read is the same,
   * and it was measured that a one-connection pool cannot tell the two apart either — the
   * submit's peak demand is two connections either way, because `catalogIndex()` takes a
   * second one regardless (`orders.service.ts`, `CatalogRepository.findAll()` has no `tx`
   * parameter at all). No runtime test can fail on it, so the compiler is made to instead:
   * `Tx | undefined` as a *required* parameter means a caller that drops it is
   * "Expected 2 arguments, but got 1", and a caller that means it says `undefined` out loud.
   *
   * Same discipline as `TaxCountryRepository.lockCountry(code, tx)`, which has always required
   * one. `list` and `changes` keep their optional `tx?`: a plain admin GET genuinely has no
   * transaction, and nothing about their correctness depends on which connection they use.
   */
  async resolveDestination(code: string | null, tx: Tx | undefined): Promise<DestinationTax> {
    const resolved = await this.lookup(code, tx);
    if (resolved.known) return resolved;

    throw AppError.validationFailed(message('error.tax_country.unknown_destination'), {
      reason: 'unknown_destination_country',
      destinationCountry: code,
    });
  }

  /**
   * ⭐ The same lookup for a path that **pins nothing** — and the reason the two are separate.
   *
   * `POST /orders` accepts any `/^[A-Z]{2}$/` and deliberately does not validate it (see
   * `OrdersService.createDraft`). That was harmless while resolution happened only at submit.
   * The moment the quote screen and every quote write began resolving too, a two-character
   * typo became terminal: `GET /orders/:id/quote` answered 422, so did every edit, and
   * `applySubmission` is the only writer of `orders.destination_country` — so the cart could
   * not be opened, could not be edited, and could not be corrected. Measured: create with
   * `'ZZ'`, then 422 on the read and 422 on adding a line, both of which were 200 before.
   *
   * The refusal above is right and stays exactly where it was: `resolveDestination`'s own note
   * says falling back to `DEFAULT_VAT_RULE` *"would compute Thai tax on a foreign sale and pin
   * it to the document permanently, with nothing recording that a fallback happened"* — and
   * every word of that is about **pinning**. A read freezes nothing. So a read degrades, keeps
   * the code the order actually names, and reports `known: false` so the answer records that a
   * fallback happened rather than passing off Thai money as Singapore's.
   *
   * The submit still refuses, in two places: here, for `OrdersService.submit`, and again in
   * `QuotesService.assertSubmittable`, so that `POST …/quote/verification` cannot green-light a
   * quote the submit will reject.
   */
  async resolveForEditing(code: string | null, tx: Tx | undefined): Promise<DestinationTax> {
    return this.lookup(code, tx);
  }

  /** One statement and one interpretation of the row, shared by both readings above. */
  private async lookup(code: string | null, tx: Tx | undefined): Promise<DestinationTax> {
    if (code === null) {
      return { code: null, rule: DEFAULT_VAT_RULE, basis: 'exclusive', known: true };
    }

    const [row] = await this.repository.byCode(code, tx);
    if (row === undefined) {
      /* The code is preserved, not blanked: it is what the customer chose and what has to be
       * shown back to them to be corrected. Only the arithmetic falls back. */
      return { code, rule: DEFAULT_VAT_RULE, basis: 'exclusive', known: false };
    }

    return {
      code: row.code,
      rule: { rateBp: row.rateBp, treatment: row.treatment as TaxTreatment },
      basis: row.pricesIncludeTax ? 'inclusive' : 'exclusive',
      known: true,
    };
  }
}
