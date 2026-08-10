import { afterAll, describe, expect, it } from 'vitest';

import { eq } from '@wewin/db/sql';
import { orderDocuments, orders } from '@wewin/db/schema';
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
  /** `POST /orders`, so the create path's own handling of the field is the thing under test. */
  readonly createDraft: (body: unknown) => Promise<{ readonly orderId: string }>;
  /** Submit an order that already exists, rather than one this helper just made. */
  readonly submitExisting: (
    orderId: string,
    body: { readonly contact: Record<string, unknown> },
  ) => Promise<void>;
  /**
   * A destination on the cart, written the way Task 8's suite writes one — directly, because
   * before this round there was no supported write path ahead of submit. There is one now
   * (`POST /orders`), and `createDraft` above is how the tests that are about *that* get one;
   * this stays for the case that is only about what the pin reads.
   */
  readonly setDestination: (orderId: string, code: string) => Promise<void>;
  readonly destinationOf: (orderId: string) => Promise<string | null>;
  /** A staff transition — `production_confirmed`, `redesign`, `superseded`. Asserts 200. */
  readonly staffMove: (orderId: string, toStatus: string, body?: unknown) => Promise<OrderWire>;
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
    /* Only the supersede case needs one: `production_confirmed`, `redesign` and `superseded`
       are all staff moves, and a customer token gets 404 on every one of them. */
    const staff = await makeActor(db, app, 'destination pinning staff', [
      'orders.read',
      'orders.write',
    ]);
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

      createDraft: async (body) => {
        const created = await call('POST', '/orders', { token: customer.token, body });
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        return { orderId: (created.body as OrderWire).id };
      },

      submitExisting: async (orderId, body) => {
        const submitted = await call('POST', `/orders/${orderId}/transitions/awaiting_payment`, {
          token: customer.token,
          body: { ...body, lines: [line] },
        });
        expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
      },

      setDestination: async (orderId, code) => {
        await db.update(orders).set({ destinationCountry: code }).where(eq(orders.id, orderId));
      },

      staffMove: async (orderId, toStatus, body = {}) => {
        const moved = await call('POST', `/orders/${orderId}/transitions/${toStatus}`, {
          token: staff.token,
          body,
        });
        expect(moved.status, `${toStatus}: ${JSON.stringify(moved.body)}`).toBe(200);
        return moved.body as OrderWire;
      },

      destinationOf: async (orderId) => {
        const [row] = await db
          .select({ destinationCountry: orders.destinationCountry })
          .from(orders)
          .where(eq(orders.id, orderId));
        if (!row) throw new Error(`no order ${orderId}`);
        return row.destinationCountry;
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

  /**
   * ⭐ The other half of the `??`, and the half no test reached until fix round 1.
   *
   * `orders.service.ts` resolves `body.contact.destinationCountry ?? order.destinationCountry`.
   * The three tests above only ever exercise the left operand — so replacing the whole
   * expression with `?? null` left **137 files / 1563 tests green**, while a cart that already
   * carried `SG` priced and pinned at `DEFAULT_VAT_RULE`: no `destinationCountry` on the
   * document, 700 bp on the column, and `applySubmission` writing `'SG'` onto the order row
   * regardless. Row says Singapore, document says Thailand at 7%, and nothing compares them.
   *
   * Task 8 proved the *write* reads the cart. This proves the *pin* does.
   */
  it('prices from the destination the cart already carried, when the submit does not repeat it', async () => {
    const { admin, taxCountries, createDraft, submitExisting, documentRow, setDestination } =
      await harness();
    await taxCountries.create(
      { code: 'SG', nameTh: 'สิงคโปร์', rateBp: 900, treatment: 'standard', pricesIncludeTax: true },
      admin.id,
    );

    const { orderId } = await createDraft({});
    await setDestination(orderId, 'SG');

    /* No `destinationCountry` in the body — the country can only come off the order row. */
    await submitExisting(orderId, { contact: { email: 'a@b.co' } });
    const row = await documentRow(orderId);

    expect(row.pinnedVatRateBp).toBe(900);
    expect(row.document.destinationCountry).toBe('SG');
    expect(row.document.taxBasis).toBe('inclusive');
  }, 60_000);

  /**
   * ⭐ `POST /orders` accepted the field and threw it away.
   *
   * `createOrderRequestSchema` reuses `orderContactRequestSchema`, which declares
   * `destinationCountry`, so this body has always validated and answered 201 — and
   * `OrdersService.createDraft` never forwarded the value. Cosmetic while nothing read the
   * column; a wrong tax rate the moment the submit started pricing from it, because the
   * customer who chose their country on the first screen and did not repeat it on the last
   * got Thai VAT on a Singapore sale.
   */
  it('keeps a destination given at create, and prices from it without being told twice', async () => {
    const { admin, taxCountries, createDraft, submitExisting, destinationOf, documentRow } =
      await harness();
    await taxCountries.create(
      { code: 'SG', nameTh: 'สิงคโปร์', rateBp: 900, treatment: 'standard', pricesIncludeTax: true },
      admin.id,
    );

    const { orderId } = await createDraft({
      contact: { email: 'a@b.co', destinationCountry: 'SG' },
    });

    /* Persisted by `POST /orders` itself — before any submit has run. */
    expect(await destinationOf(orderId)).toBe('SG');

    await submitExisting(orderId, { contact: { email: 'a@b.co' } });

    expect((await documentRow(orderId)).pinnedVatRateBp).toBe(900);
  }, 60_000);

  /**
   * ⭐ A post-freeze re-quote is the *same sale*, so it is the same country.
   *
   * `OrdersService`'s `supersede` branch builds the successor with `createDraft`, copying the
   * five contact fields off the predecessor. The destination joins them — and until fix round 1
   * it did not, because `orders.destination_country` was written only at submit and the
   * successor is created before it has one. A successor that lost the country would resolve
   * `null`, price at Thai 7% and pin 700 bp, **on the one path whose entire purpose is to put a
   * new number in front of a customer for approval**.
   *
   * ── Why this asserts the pinned rate and not just the column ──────────────────────
   *
   * `traps.pg.test.ts`'s TRAP 7 already reads `contact_email` off the successor with raw SQL,
   * and extending it by one column would prove the copy *happened*. It would not prove the copy
   * *matters* — that a successor priced afterwards charges 900 rather than 700 — which is the
   * actual claim, and the one a reader of this file is entitled to see proved. `OrderWire` does
   * not expose `destinationCountry`, so the successor's own pinned document is the observation.
   *
   * ── Why here rather than in `traps.pg.test.ts` ────────────────────────────────────
   *
   * TRAP 7 is about the supersede *mechanism* — that a successor exists, points back, and is
   * not a cancellation. This is about what the pin reads, which is this file's subject and
   * where the tax-country fixtures and `documentRow` already live. The destination story is
   * split by *what is being proved*, one file each: `destination-tax` resolves a code,
   * `destination-submit` stores it, this one pins it.
   */
  it('carries the destination onto a supersede successor, so the re-quote prices the same country', async () => {
    const { admin, taxCountries, createDraft, submitExisting, documentRow, staffMove } =
      await harness();
    await taxCountries.create(
      { code: 'SG', nameTh: 'สิงคโปร์', rateBp: 900, treatment: 'standard', pricesIncludeTax: true },
      admin.id,
    );

    const { orderId } = await createDraft({
      contact: { email: 'a@b.co', destinationCountry: 'SG' },
    });
    await submitExisting(orderId, { contact: { email: 'a@b.co' } });
    expect((await documentRow(orderId)).pinnedVatRateBp, 'the predecessor').toBe(900);

    /* The only route to `superseded`: freeze it, redesign it, then replace it. */
    await staffMove(orderId, 'production_confirmed');
    await staffMove(orderId, 'redesign', { reason: 'ส่วนต่างสูงเกินกว่าจะรับไว้เอง' });
    const superseded = await staffMove(orderId, 'superseded', {
      reason: 'ออกใบใหม่ให้ลูกค้าอนุมัติ',
    });

    const successorId = superseded.supersededByOrderId;
    expect(successorId, 'no successor was created').not.toBeNull();

    /* Submitted naming no country, exactly as a customer approving a replacement would: the
       destination can only have come from the predecessor, through `createDraft`. */
    await submitExisting(successorId ?? '', { contact: { email: 'a@b.co' } });
    const successorDocument = await documentRow(successorId ?? '');

    expect(successorDocument.pinnedVatRateBp, 'the successor').toBe(900);
    expect(successorDocument.document.destinationCountry).toBe('SG');
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
