import { afterAll, describe, expect, it } from 'vitest';

import { eq } from '@wewin/db/sql';
import { orderDocuments } from '@wewin/db/schema';
import { products } from '@wewin/core/fixtures';
import type { Product } from '@wewin/core';
import { encodeUm } from '@wewin/contract/measure';
import type {
  OrderDocumentResponseWire,
  OrderDocumentWire,
  OrderLineRequestWire,
  OrderWire,
} from '@wewin/contract/order';

import { DEFAULT_VAT_RULE } from '../../src/orders/defaults';
import { TaxCountryService } from '../../src/organisation/tax-country.service';
import { createPgHarness } from '../support/pg-harness';
import { client, makeActor } from './support/lifecycle-app';

/**
 * Task 9: the resolved destination reaches the pinned document — and its columns.
 *
 * This is the file that decides whether the feature exists at all. Everything before it
 * configures a number nobody reads: `orders.service.ts` passed `DEFAULT_VAT_RULE` into
 * `priceOrderDocument` and pinned `DEFAULT_VAT_RULE.rateBp` / `.treatment` onto the document
 * row, so a version of this feature that changed only the *formula* would compute and pin
 * **700 bp for every country** — and would look like it worked, because Thailand is 700.
 *
 * ── Why the first test asserts the column and the JSON together ───────────────────
 *
 * `orders_totals_match_document()` compares *totals*, never the rate: a document saying 900 bp
 * beside a `pinned_vat_rate_bp` of 700 foots perfectly and no constraint in the database
 * notices. Mutation-tested by reverting the pin to `DEFAULT_VAT_RULE.rateBp` and re-running —
 * the first test goes red on `pinned_vat_rate_bp` while `document.vat.rateBp` still reads 900,
 * which is exactly the divergence nothing else guards.
 *
 * ── Why the second test goes through the repository decoder ───────────────────────
 *
 * `order.repository.ts`'s `decodeDocumentRow` `safeParse`s every stored row against
 * `orderDocumentWireSchema` and returns `parsed.data` — zod strips what the schema does not
 * declare, silently, with no log, and unrepairably, because the document is frozen at submit.
 * A field written into `order_documents.document` but absent from the schema would pass the
 * first test and vanish on the way to the customer's printed page. So the read is `GET
 * /orders/:id/document`, not a second `select`.
 *
 * ── Why a fresh database per test ─────────────────────────────────────────────────
 *
 * `SG` is created here and `tax_countries_block_delete` means it can never be taken back;
 * `TH` is migration 0029's one seeded row. Same reasoning as
 * `tests/organisation/destination-tax.pg.test.ts`, which is why this file uses the same
 * `createPgHarness` rather than a shared `beforeAll`.
 *
 * Skipped, not failed, without a database.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

/** `order_documents` as Postgres holds it — the columns beside the JSON, unparsed by zod. */
interface DocumentRow {
  readonly pinnedVatRateBp: number;
  readonly pinnedVatTreatment: string;
  readonly document: OrderDocumentWire;
}

interface Harness {
  readonly submit: (body: {
    readonly contact: Record<string, unknown>;
  }) => Promise<{ readonly orderId: string }>;
  readonly admin: { readonly id: string };
  readonly taxCountries: TaxCountryService;
  /** Straight out of Postgres: the pinned columns and the stored JSON, side by side. */
  readonly documentRow: (orderId: string) => Promise<DocumentRow>;
  /** Through `GET /orders/:id/document`, and therefore through the repository's zod decoder. */
  readonly readDocument: (orderId: string) => Promise<OrderDocumentWire>;
}

describeWithPg('the destination, pinned into the document and its columns', () => {
  const base = createPgHarness(url ?? '');

  const harness = async (): Promise<Harness> => {
    const { app, actor, db } = await base.harness();
    const call = client(app.baseUrl);

    const customer = await makeActor(db, app, 'destination pinning customer', []);
    const line = await liveLine(call);

    return {
      admin: actor,
      taxCountries: app.app.get(TaxCountryService),

      submit: async (body) => {
        const created = await call('POST', '/orders', { token: customer.token, body: {} });
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        const draft = created.body as OrderWire;

        const submitted = await call(
          'POST',
          `/orders/${draft.id}/transitions/awaiting_payment`,
          { token: customer.token, body: { ...body, lines: [line] } },
        );
        expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);

        return { orderId: draft.id };
      },

      documentRow: async (orderId) => {
        const [row] = await db
          .select({
            pinnedVatRateBp: orderDocuments.pinnedVatRateBp,
            pinnedVatTreatment: orderDocuments.pinnedVatTreatment,
            document: orderDocuments.document,
          })
          .from(orderDocuments)
          .where(eq(orderDocuments.orderId, orderId));
        if (!row) throw new Error(`no pinned document for order ${orderId}`);

        return { ...row, document: row.document as OrderDocumentWire };
      },

      readDocument: async (orderId) => {
        const answer = await call('GET', `/orders/${orderId}/document`, { token: customer.token });
        expect(answer.status, JSON.stringify(answer.body)).toBe(200);
        return (answer.body as OrderDocumentResponseWire).document;
      },
    };
  };

  afterAll(base.closeOpened);

  it('pins the destination country and basis into the document JSON, and the rate into the columns', async () => {
    const { submit, admin, taxCountries, documentRow } = await harness();
    await taxCountries.create(
      { code: 'SG', nameTh: 'สิงคโปร์', rateBp: 900, treatment: 'standard', pricesIncludeTax: true },
      admin.id,
    );

    const { orderId } = await submit({ contact: { email: 'a@b.co', destinationCountry: 'SG' } });
    const row = await documentRow(orderId);

    expect(row.pinnedVatRateBp).toBe(900);
    expect(row.pinnedVatTreatment).toBe('standard');
    expect(row.document.destinationCountry).toBe('SG');
    expect(row.document.taxBasis).toBe('inclusive');
    expect(row.document.vat).toStrictEqual({ rateBp: 900, treatment: 'standard' });
  }, 60_000);

  it('survives the read path, which is where a missing schema declaration would eat it', async () => {
    const { submit, admin, taxCountries, readDocument } = await harness();
    await taxCountries.create(
      { code: 'SG', nameTh: 'สิงคโปร์', rateBp: 900, treatment: 'standard', pricesIncludeTax: true },
      admin.id,
    );

    const { orderId } = await submit({ contact: { email: 'a@b.co', destinationCountry: 'SG' } });

    /* Through the repository decoder, not straight out of Postgres. `decodeDocumentRow`
       returns `parsed.data`, and zod strips what the schema does not declare — silently, with
       no log, and unrepairable because the document is frozen. */
    const decoded = await readDocument(orderId);
    expect(decoded.destinationCountry).toBe('SG');
    expect(decoded.taxBasis).toBe('inclusive');
  }, 60_000);

  it('pins nothing new when the order names no destination, and still uses the default rule', async () => {
    const { submit, readDocument } = await harness();

    const { orderId } = await submit({ contact: { email: 'a@b.co' } });
    const decoded = await readDocument(orderId);

    /* Absent, not `null`. Both fields are optional in `orderDocumentWireSchema`, and writing an
       explicit null would make every legacy document distinguishable from a new destination-less
       one for no reason anybody needs. */
    expect(decoded.destinationCountry).toBeUndefined();
    expect(decoded.taxBasis).toBeUndefined();
    expect(decoded.vat).toStrictEqual(DEFAULT_VAT_RULE);
  }, 60_000);
});

/**
 * A line the *running* catalogue would accept, built from the published document it names.
 *
 * Copied from `destination-submit.pg.test.ts` / `lifecycle.pg.test.ts` rather than shared,
 * matching this suite directory's own convention of one self-contained helper per
 * `.pg.test.ts` file.
 */
async function liveLine(call: ReturnType<typeof client>): Promise<OrderLineRequestWire> {
  const listed = await call('GET', '/catalog/products', {});
  if (listed.status !== 200) throw new Error(`the catalogue is not being served: ${listed.status}`);

  const wire = listed.body as {
    products: readonly {
      productVersionId: string;
      documentHash: string;
      product: { id: string };
    }[];
  };

  for (const published of wire.products) {
    const product = products.find((candidate: Product) => candidate.id === published.product.id);
    if (!product || !product.groups.some((group) => group.kind === 'custom')) continue;

    const selections: Record<string, string> = {};
    const measures: Record<string, ReturnType<typeof encodeUm>> = {};
    const enteredUnits: Record<string, 'cm' | 'mm'> = {};

    for (const group of product.groups) {
      if (group.kind === 'sku') selections[group.code] = group.defaultValue;
      else {
        measures[group.code] = encodeUm(group.defaultUm);
        enteredUnits[group.code] = group.unit;
      }
    }

    return {
      productVersionId: published.productVersionId,
      documentHash: published.documentHash,
      productId: product.id,
      selections,
      measures,
      enteredUnits,
      qty: 2,
    };
  }

  throw new Error('no published product with a measurement to order');
}
