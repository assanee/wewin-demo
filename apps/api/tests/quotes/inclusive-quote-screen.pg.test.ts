import { afterAll, describe, expect, it } from 'vitest';

import { products } from '@wewin/core/fixtures';
import type { Product } from '@wewin/core';
import { encodeUm } from '@wewin/contract/measure';
import { toBigInt } from '@wewin/contract/exact';
import type {
  OrderDocumentResponseWire,
  OrderDocumentWire,
  OrderWire,
  PriceRequestWire,
} from '@wewin/contract';
import type { QuoteWire } from '@wewin/contract/quote';

import { TaxCountryService } from '../../src/organisation/tax-country.service';
import { createPgHarness } from '../support/pg-harness';
import { client, makeActor, type Json } from '../orders/support/lifecycle-app';

/**
 * ⭐ Tasks 10 + 11: the money the staff screen shows is the money the customer is quoted.
 *
 * ── What was measured here before this pair of tasks, on this exact fixture ───────
 *
 * One configured line, qty 2, catalogue sum **฿13,824.00** (1 382 400 satang), destination `SG`
 * at 900 bp with `pricesIncludeTax: true`:
 *
 *   the quote screen   ฿14,791.68  — `DEFAULT_VAT_RULE`, 700 bp, added on top
 *   the pinned document ฿15,068.16 — 900 bp, still added on top, under `taxBasis: 'inclusive'`
 *
 * Two separate defects in one order. The screen and the document disagreed by ฿276.48 because
 * `effective()` hardcoded the Thai rate; and *both* were exclusive arithmetic under a document
 * that said `inclusive`, so the label Task 9 pinned was not merely unproven, it was **false**.
 * The right answer is ฿13,824.00 on both, with the VAT divided back out of it.
 *
 * ── Why the assertions are absolute figures and not only relationships ────────────
 *
 * `destination-pinning.pg.test.ts` passes today with the wrong totals, because it asserts only
 * what was *pinned* — the rate, the country, the basis label — and never what the arithmetic
 * did with them. A relationship (`screen == document`) would likewise have passed while both
 * were 700 bp exclusive. So every figure below is a number somebody can check by hand.
 *
 * ── Why a fresh database per test ─────────────────────────────────────────────────
 *
 * `SG` and `MY` are created here and `tax_countries_block_delete` means neither can be taken
 * back. Same reasoning, and the same `createPgHarness`, as `destination-pinning.pg.test.ts`.
 *
 * Skipped, not failed, without a database.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

/** The catalogue sum of the fixture line at qty 2 — the figure every case below starts from. */
const CATALOGUE_SUM = 1_382_400n;

const minor = (wire: unknown): bigint => toBigInt(wire as never);

interface Harness {
  readonly admin: { readonly id: string };
  readonly taxCountries: TaxCountryService;
  /** A draft owned by the sales actor, carrying this destination from the moment it exists. */
  readonly draftFor: (destinationCountry?: string) => Promise<string>;
  /** Add the fixture line through the quote editor, so the cart is `quote_lines` and not a body. */
  readonly addLine: (orderId: string) => Promise<QuoteWire>;
  /** `GET /orders/:id/quote` — what a salesperson is looking at. */
  readonly quoteScreen: (orderId: string) => Promise<QuoteWire>;
  /** Submit naming no lines: the quote is already there, and the document must come from it. */
  readonly submit: (orderId: string, destinationCountry?: string) => Promise<void>;
  /** The same submit, unwrapped, for the cases that are about the refusal rather than the money. */
  readonly trySubmit: (orderId: string, destinationCountry?: string) => Promise<Json>;
  /** `GET /orders/:id/quote` without asserting 200 — for the paths that used to 422. */
  readonly tryQuoteScreen: (orderId: string) => Promise<Json>;
  /** `POST /orders/:id/quote/lines` without asserting 201, same reason. */
  readonly tryAddLine: (orderId: string) => Promise<Json>;
  /** `POST /orders/:id/quote/verification` — `assertSubmittable` without the submit. */
  readonly tryVerification: (orderId: string) => Promise<Json>;
  /** Promise a whole-document total, so a `grand_total` baseline exists to go stale. */
  readonly promiseTotal: (orderId: string, amountText: string) => Promise<QuoteWire>;
  /** Promise one line's total — the `line_total` anchor `measureMargin` grosses up. */
  readonly promiseLine: (orderId: string, amountText: string) => Promise<QuoteWire>;
  readonly documentOf: (orderId: string) => Promise<OrderDocumentWire>;
}

describeWithPg('the quote screen and the pinned document, per destination', () => {
  const base = createPgHarness(url ?? '');

  const harness = async (): Promise<Harness> => {
    const { app, actor, db } = await base.harness();
    const call = client(app.baseUrl);

    const sales = await makeActor(db, app, 'inclusive screen sales', [
      'quotes.read',
      'quotes.write',
      'orders.read',
      'orders.write',
    ]);
    const line = await liveLine(call);

    const quoteScreen = async (orderId: string): Promise<QuoteWire> => {
      const read = await call('GET', `/orders/${orderId}/quote`, { token: sales.token });
      if (read.status !== 200) throw new Error(JSON.stringify(read.body));
      return read.body as QuoteWire;
    };

    const tryAddLine = async (orderId: string): Promise<Json> => {
      const current = await call('GET', `/orders/${orderId}/quote`, { token: sales.token });
      const revision = (current.body as QuoteWire | null)?.quoteRevision;
      return call('POST', `/orders/${orderId}/quote/lines`, {
        token: sales.token,
        /* When the read itself failed there is no revision to send; the write is expected to
           answer the same refusal, and `expect` is optional on the wire. */
        body: revision === undefined ? { line } : { expect: { quoteRevision: revision }, line },
      });
    };

    const trySubmit = async (orderId: string, destinationCountry?: string): Promise<Json> =>
      call('POST', `/orders/${orderId}/transitions/awaiting_payment`, {
        token: sales.token,
        body: {
          contact: {
            email: 'a@b.co',
            ...(destinationCountry === undefined ? {} : { destinationCountry }),
          },
        },
      });

    /** `POST …/quote/overrides` — the client sends what was typed, never a computed figure. */
    const promise = async (
      orderId: string,
      body: Record<string, unknown>,
    ): Promise<QuoteWire> => {
      const current = await quoteScreen(orderId);
      const written = await call('POST', `/orders/${orderId}/quote/overrides`, {
        token: sales.token,
        body: { expect: { quoteRevision: current.quoteRevision }, reasonCode: 'volume', ...body },
      });
      if (written.status !== 201) throw new Error(JSON.stringify(written.body));
      return written.body as QuoteWire;
    };

    return {
      admin: actor,
      taxCountries: app.app.get(TaxCountryService),
      quoteScreen,

      draftFor: async (destinationCountry) => {
        const created = await call('POST', '/orders', {
          token: sales.token,
          body:
            destinationCountry === undefined
              ? {}
              : { contact: { email: 'a@b.co', destinationCountry } },
        });
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        return (created.body as OrderWire).id;
      },

      addLine: async (orderId) => {
        const added = await tryAddLine(orderId);
        if (added.status !== 201) throw new Error(JSON.stringify(added.body));
        return added.body as QuoteWire;
      },

      tryAddLine,
      tryQuoteScreen: async (orderId) =>
        call('GET', `/orders/${orderId}/quote`, { token: sales.token }),
      tryVerification: async (orderId) =>
        call('POST', `/orders/${orderId}/quote/verification`, { token: sales.token, body: {} }),
      trySubmit,

      promiseTotal: async (orderId, amountText) =>
        promise(orderId, {
          anchor: 'grand_total',
          enteredAs: 'grand_total',
          enteredValueText: amountText,
        }),

      promiseLine: async (orderId, amountText) => {
        const current = await quoteScreen(orderId);
        const target = current.lines[0];
        if (target === undefined) throw new Error('no line to promise against');
        return promise(orderId, {
          anchor: 'line_total',
          enteredAs: 'line_total',
          enteredValueText: amountText,
          quoteLineId: target.id,
        });
      },

      submit: async (orderId, destinationCountry) => {
        const submitted = await trySubmit(orderId, destinationCountry);
        expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
      },

      documentOf: async (orderId) => {
        const read = await call('GET', `/orders/${orderId}/document`, { token: sales.token });
        if (read.status !== 200) throw new Error(JSON.stringify(read.body));
        return (read.body as OrderDocumentResponseWire).document;
      },
    };
  };

  afterAll(base.closeOpened);

  /**
   * ⭐ The whole unit, on one order: the basis, the rate, the screen, and the document.
   *
   * The `netThbMinor` assertion is the one that could not have passed before Task 10 — under
   * exclusive arithmetic the net *is* the catalogue sum and the grand total is above it. Here
   * the catalogue sum is the grand total and the net is what is left after the tax is divided
   * back out: 1 382 400 × 10 000 ÷ 10 900 = 1 268 257 (half away from zero), VAT the remainder.
   */
  it('quotes an inclusive destination at the catalogue sum, tax divided out, screen and document alike', async () => {
    const { admin, taxCountries, draftFor, addLine, quoteScreen, submit, documentOf } =
      await harness();
    await taxCountries.create(
      { code: 'SG', nameTh: 'สิงคโปร์', rateBp: 900, treatment: 'standard', pricesIncludeTax: true },
      admin.id,
    );

    const orderId = await draftFor('SG');
    const withLine = await addLine(orderId);
    /* The machine layer, untouched by any of this: what `calcPrice` said the line costs. */
    expect(minor(withLine.lines[0]?.computedTotalThbMinor)).toBe(CATALOGUE_SUM);

    const onScreen = await quoteScreen(orderId);

    /* ① The printed rate. Left at `DEFAULT_VAT_RULE` the screen says "VAT 7%" over money
       computed at 9% — the totals would agree and the sentence beside them would not. */
    expect(onScreen.money.vat).toStrictEqual({ rateBp: 900, treatment: 'standard' });

    /* ② The quoted gross *is* the catalogue sum — ฿13,824.00, not ฿15,068.16. */
    expect(minor(onScreen.money.grandTotalThbMinor)).toBe(CATALOGUE_SUM);
    expect(minor(onScreen.money.grandTotalThbMinor)).toBe(1_382_400n);

    /* ③ VAT backed *out* of the gross, not added on to it. */
    expect(minor(onScreen.money.netThbMinor)).toBe(1_268_257n);
    expect(minor(onScreen.money.vatThbMinor)).toBe(114_143n);
    expect(minor(onScreen.money.netThbMinor) + minor(onScreen.money.vatThbMinor)).toBe(
      minor(onScreen.money.grandTotalThbMinor),
    );
    expect(minor(onScreen.money.vatThbMinor)).toBe(
      divRoundHalfUp(minor(onScreen.money.grandTotalThbMinor) * 900n, 10_900n),
    );

    /*
     * ④ ⭐ The assertion that catches a missed `applyOverrides` baseline site.
     *
     * `baseline` is "what this quote would say with nothing negotiated", and nothing here has
     * been negotiated — so it must equal the effective money exactly. Left on `fromNet` it
     * lands ~9% above, and the dashboard shows staff a "before negotiation" figure higher than
     * what the customer is charged on *every* inclusive quote. The authority gate cannot catch
     * it: `measureMargin`'s input is `{ vat, lines, overrides }` and `measureFor` never calls
     * `applyOverrides`, so a gate assertion passes either way.
     */
    expect(onScreen.sales, 'the sales view is what carries the baseline').not.toBeNull();
    expect(minor(onScreen.sales?.baselineGrandTotalThbMinor)).toBe(
      minor(onScreen.money.grandTotalThbMinor),
    );

    await submit(orderId);
    const pinned = await documentOf(orderId);

    /* ⑤ The pinned label equals the branch that actually ran. This is what ties Task 9's pin
       to Task 10's formula: before this, the document said `inclusive` and the arithmetic was
       exclusive, and no constraint in the database compared them. */
    expect(pinned.taxBasis).toBe('inclusive');
    expect(pinned.vat).toStrictEqual({ rateBp: 900, treatment: 'standard' });

    expect(minor(pinned.grandTotalThbMinor)).toBe(minor(onScreen.money.grandTotalThbMinor));
    expect(minor(pinned.netThbMinor)).toBe(minor(onScreen.money.netThbMinor));
    expect(minor(pinned.vatThbMinor)).toBe(minor(onScreen.money.vatThbMinor));
  }, 60_000);

  /**
   * Exclusive is unchanged — at a rate this suite has never used before.
   *
   * 600 bp deliberately, and not 700: `DEFAULT_VAT_RULE` is 700, so an `effective()` that
   * ignored the destination entirely would still produce the right answer for a 700 bp country
   * and this test would pass for the wrong reason. At 600 the old behaviour is distinguishable
   * from the new one, which is the only way a passing exclusive test means anything.
   */
  it('leaves an exclusive destination adding the tax on top, at its own rate', async () => {
    const { admin, taxCountries, draftFor, addLine, quoteScreen, submit, documentOf } =
      await harness();
    await taxCountries.create(
      { code: 'MY', nameTh: 'มาเลเซีย', rateBp: 600, treatment: 'standard', pricesIncludeTax: false },
      admin.id,
    );

    const orderId = await draftFor('MY');
    await addLine(orderId);
    const onScreen = await quoteScreen(orderId);

    expect(onScreen.money.vat).toStrictEqual({ rateBp: 600, treatment: 'standard' });

    /* grand = net × 1.06, and the net is the catalogue sum. ฿13,824.00 → ฿14,653.44. */
    expect(minor(onScreen.money.netThbMinor)).toBe(CATALOGUE_SUM);
    expect(minor(onScreen.money.vatThbMinor)).toBe(82_944n);
    expect(minor(onScreen.money.grandTotalThbMinor)).toBe(1_465_344n);
    expect(minor(onScreen.money.grandTotalThbMinor)).toBe(
      minor(onScreen.money.netThbMinor) + divRoundHalfUp(CATALOGUE_SUM * 600n, 10_000n),
    );

    await submit(orderId);
    const pinned = await documentOf(orderId);

    expect(pinned.taxBasis).toBe('exclusive');
    expect(minor(pinned.grandTotalThbMinor)).toBe(minor(onScreen.money.grandTotalThbMinor));
    expect(minor(pinned.netThbMinor)).toBe(minor(onScreen.money.netThbMinor));
    expect(minor(pinned.vatThbMinor)).toBe(minor(onScreen.money.vatThbMinor));
  }, 60_000);

  /**
   * An order that names no destination at all — the path every legacy cart takes.
   *
   * `resolveDestination(null, …)` answers `DEFAULT_VAT_RULE` and `exclusive`, so this is the
   * behaviour that must not have moved a satang. It is the regression half of the pair.
   */
  it('is unchanged for an order that names no destination', async () => {
    const { draftFor, addLine, quoteScreen, submit, documentOf } = await harness();

    const orderId = await draftFor();
    await addLine(orderId);
    const onScreen = await quoteScreen(orderId);

    expect(onScreen.money.vat).toStrictEqual({ rateBp: 700, treatment: 'standard' });
    expect(minor(onScreen.money.netThbMinor)).toBe(CATALOGUE_SUM);
    expect(minor(onScreen.money.vatThbMinor)).toBe(96_768n);
    expect(minor(onScreen.money.grandTotalThbMinor)).toBe(1_479_168n);

    await submit(orderId);
    const pinned = await documentOf(orderId);

    /* Absent, not `null` — the document names no country, so it carries no basis either. */
    expect(pinned.taxBasis).toBeUndefined();
    expect(minor(pinned.grandTotalThbMinor)).toBe(minor(onScreen.money.grandTotalThbMinor));
  }, 60_000);

  /**
   * ⭐ THE BRICK: a two-character typo must not make a cart unopenable and unfixable.
   *
   * `POST /orders` accepts any `/^[A-Z]{2}$/` and deliberately does not validate it, because
   * `resolveDestination` used to run only at submit. Once the screen and every write began
   * resolving, that stopped being harmless — measured before this fix:
   *
   *     POST /orders {contact:{destinationCountry:'ZZ'}}   201
   *     GET  /orders/:id/quote                             422 unknown_destination_country
   *     POST /orders/:id/quote/lines                       422
   *
   * Both were 200 before, and `applySubmission` is the only writer of
   * `orders.destination_country`, so there was no endpoint — for staff *or* the customer — that
   * could change it back. The cart was dead.
   *
   * The refusal stays exactly where it pins. Everything before the pin degrades to the default
   * rule and **says so** on the wire, which is what separates this from the silent fallback
   * `resolveDestination` refuses to make.
   */
  it('keeps a cart with an unrecognised country openable, editable and correctable', async () => {
    const {
      admin, taxCountries, draftFor, tryQuoteScreen, tryAddLine, tryVerification,
      trySubmit, submit, documentOf,
    } = await harness();
    await taxCountries.create(
      { code: 'SG', nameTh: 'สิงคโปร์', rateBp: 900, treatment: 'standard', pricesIncludeTax: true },
      admin.id,
    );

    const orderId = await draftFor('ZZ');

    /* ① It opens. */
    const opened = await tryQuoteScreen(orderId);
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);

    /* …and says the money is not this country's, rather than passing the default off as it. */
    const empty = opened.body as QuoteWire;
    expect(empty.destination).toStrictEqual({ country: 'ZZ', recognised: false });
    expect(empty.money.vat).toStrictEqual({ rateBp: 700, treatment: 'standard' });

    /* ② It edits. */
    const added = await tryAddLine(orderId);
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect((added.body as QuoteWire).destination.recognised).toBe(false);

    /* ③ It still refuses to become a contract — the pin is where the refusal belongs, and
       `POST …/quote/verification` must not green-light what the submit will reject. */
    const refused = await trySubmit(orderId);
    expect(refused.status).toBe(422);
    expect(
      (refused.body as { error: { details: { reason: string } } }).error.details.reason,
    ).toBe('unknown_destination_country');

    const verification = await tryVerification(orderId);
    expect(verification.status).toBe(422);

    /* ④ And it is correctable through the ordinary path: the submit names a real country,
       `applySubmission` writes it onto the row, and the order goes out. */
    await submit(orderId, 'SG');
    const pinned = await documentOf(orderId);

    expect(pinned.destinationCountry).toBe('SG');
    expect(pinned.taxBasis).toBe('inclusive');
    expect(minor(pinned.grandTotalThbMinor)).toBe(CATALOGUE_SUM);

    /* The screen agrees with it afterwards, because the row now carries a code that resolves. */
    const after = (await tryQuoteScreen(orderId)).body as QuoteWire;
    expect(after.destination).toStrictEqual({ country: 'SG', recognised: true });
  }, 60_000);

  /**
   * ⭐ The 409 that blamed the catalogue for a country change.
   *
   * A `grand_total` promise's stored baseline is the document total under the arithmetic in
   * force when it was written. Submit under a different country and the tax is computed another
   * way, so the baseline moves and `verifyBaselines` correctly refuses — but the sentence was
   * *"แคตตาล็อกเปลี่ยนหลังจากที่ตกลงราคาไว้"*, with both product-version fields null and no country
   * anywhere in the body. The catalogue had not moved.
   *
   * The refusal is unchanged — same 409, same rows. Only the words and the two codes are new.
   */
  it('names the destination, not the catalogue, when a country change moves a promised total', async () => {
    const { admin, taxCountries, draftFor, addLine, promiseTotal, trySubmit } = await harness();
    await taxCountries.create(
      { code: 'SG', nameTh: 'สิงคโปร์', rateBp: 900, treatment: 'standard', pricesIncludeTax: true },
      admin.id,
    );

    /* Quoted, and the total agreed, for Thailand at 700 bp exclusive. */
    const orderId = await draftFor('TH');
    await addLine(orderId);
    const promised = await promiseTotal(orderId, '14000');
    expect(minor(promised.money.grandTotalThbMinor)).toBe(1_400_000n);

    /* Submitted for Singapore, where ฿13,824.00 of goods is a ฿13,824.00 gross rather than a
       ฿14,791.68 one — so the figure the promise was measured against is not today's. */
    const refused = await trySubmit(orderId, 'SG');
    expect(refused.status).toBe(409);

    const details = (
      refused.body as {
        error: {
          message: string;
          details: {
            reason: string;
            quotedFor: string | null;
            submittedFor: string | null;
            lines: readonly { kind: string }[];
          };
        };
      }
    ).error;

    expect(details.details.reason).toBe('quote_destination_changed');
    expect(details.details.quotedFor).toBe('TH');
    expect(details.details.submittedFor).toBe('SG');
    /* The rows are still there — the recovery list is unchanged, only the sentence over it. */
    expect(details.details.lines[0]?.kind).toBe('document_baseline_moved');
    /* And the message no longer sends anybody to look at a catalogue that did not move. */
    expect(details.message).not.toContain('แคตตาล็อก');
    expect(details.message).toContain('ประเทศปลายทาง');
  }, 60_000);

  /**
   * ⭐ The third `DEFAULT_VAT_RULE` site: the concession on screen is grossed up at the
   * destination's rate.
   *
   * `measureMargin` grosses a reduction up to what the customer does not transfer, so the rate
   * is part of the figure. Left at 700 bp this measured ฿1,951.68 where the submit gate — which
   * runs after `pinDocument` and reads the pinned rate — measures ฿1,988.16, and the screen
   * would show a number no ceiling is ever compared against. `overrides.ts`' header records
   * what that costs.
   *
   * ฿13,824.00 promised at ฿12,000.00 is a ฿1,824.00 reduction; at 900 bp the customer stops
   * transferring 182 400 × 1.09 = **198 816**. At 700 it would be 195 168.
   */
  it('grosses the concession up at the destination rate, not the default', async () => {
    const { admin, taxCountries, draftFor, addLine, promiseLine } = await harness();
    await taxCountries.create(
      { code: 'SG', nameTh: 'สิงคโปร์', rateBp: 900, treatment: 'standard', pricesIncludeTax: true },
      admin.id,
    );

    const orderId = await draftFor('SG');
    await addLine(orderId);
    const promised = await promiseLine(orderId, '12000');

    expect(promised.sales, 'the concession is a sales-only figure').not.toBeNull();
    expect(minor(promised.sales?.marginConcessionThbMinor)).toBe(198_816n);
    /* Stated as the arithmetic rather than only the constant, so the number is checkable. */
    expect(minor(promised.sales?.marginConcessionThbMinor)).toBe(
      182_400n + divRoundHalfUp(182_400n * 900n, 10_000n),
    );
  }, 60_000);
});

/** `divRoundHalfUp` restated in the test, so the expected figure is not the code's own answer. */
function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  const doubled = numerator * 2n;
  const quotient = doubled / denominator;
  const rounded = quotient % 2n === 0n ? quotient : quotient + 1n;
  return rounded / 2n;
}

/**
 * A line the *running* catalogue would accept, built from the published document it names.
 *
 * Copied from `submit-seam.pg.test.ts` rather than shared, matching this directory's
 * convention of one self-contained helper per `.pg.test.ts` file.
 */
async function liveLine(call: ReturnType<typeof client>): Promise<PriceRequestWire> {
  const listed = await call('GET', '/catalog/products', {});
  if (listed.status !== 200) throw new Error(`the catalogue is not being served: ${listed.status}`);

  const wire = listed.body as {
    products: readonly { productVersionId: string; documentHash: string; product: { id: string } }[];
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

  throw new Error('no published product with a measurement to quote');
}
