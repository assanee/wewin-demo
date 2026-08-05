import { Injectable } from '@nestjs/common';
import { toPriceRequest, type PriceRequest, type PriceRequestWire } from '@wewin/contract/pricing';
import {
  addCatalogLineRequestSchema,
  addFreeformLineRequestSchema,
  presentLineRequestSchema,
  removeLineRequestSchema,
  reviseLineRequestSchema,
  revokeOverrideRequestSchema,
  setOverrideRequestSchema,
  type QuotePreconditionWire,
  type QuoteWire,
  type SetOverrideRequestWire,
  type StaleBaselineWire,
} from '@wewin/contract/quote';
import type { ZodType } from 'zod';

import { CatalogRepository, type PublishedProduct } from '../catalog/catalog.repository';
import { AppError } from '../common/errors/app-error';
import { DEFAULT_VAT_RULE } from '../orders/defaults';
/*
 * Type-only, and therefore erased: `order-document.ts` imports `applyOverrides` from
 * `./overrides` at runtime, so a value import in this direction would close a cycle.
 */
import type {
  QuoteDocumentCharge,
  QuoteDocumentLine,
  QuoteDocumentOverride,
} from '../orders/order-document';
import { ScopedOrderRepository, isOrderUuid, type ScopedOrder } from '../orders/scope';
import { scopeHolds, type Scope, type UserScope } from '../rbac';
import { ConcessionIntegrityError, measureMargin } from './authority/concession';
import { DEFAULT_LEAD_TIME_DAYS, MAX_LEAD_TIME_DAYS, MAX_QUOTE_LINES } from './defaults';
import { encodeQuote, type QuoteAudience } from './encode';
import { baselinesStale, catalogStale, quoteStale } from './errors';
import { EntryError, normaliseCharge, normaliseEntry } from './entry';
import {
  applyOverrides,
  type ChargeLine,
  type ComputedLine,
  type EffectiveQuote,
} from './overrides';
import { withTranslatedQuoteErrors, type QuoteOperation } from './pg-errors';
import { decodeStoredSelections, encodeStoredMeasures, priceLine } from './pricing';
import { quoteRevision } from './revision';
import {
  QuoteRepository,
  type QuoteLineRow,
  type QuoteOverrideRow,
  type Tx,
} from './quote.repository';
import { verifyBaselines } from './verification';

/**
 * The sales-editable quote — plan 7.9, and the answer to a question that no longer exists.
 *
 * ── What was given up, said out loud ─────────────────────────────────────────────
 *
 * Risk 1 was mitigated by *"the api recomputes and 409s on mismatch"*. That mitigation is
 * gone: once a human may set any number, **"is this total correct?" has no computable
 * answer**, because there is nothing left to compare a total against. Plan 7.9 replaces the
 * question with **"where did this number come from, and was that person allowed?"** — and
 * that one is answerable at every point, and enforceable here.
 *
 * This service owns the first half. *Where it came from* is a row in `quote_overrides` holding
 * both the machine's figure and the human's, written by name, append-only, and never accepting
 * a number a client computed.
 *
 * The second half — *were they allowed* — is `src/quotes/authority`, and it is deliberately
 * **not** re-implemented here. `AuthorityService.gate` reads the same rows, measures the same
 * concession and compares it against `authority_limits` at submit, which is where plan 7.13
 * says the evaluation belongs.
 *
 * ⚠️ The concession this service *reports* is `measureMargin`'s — the authority module's own
 * function, called directly. It was briefly a second measurement, produced by subtracting the
 * effective total from an untouched baseline, with a test asserting the two agreed. They did
 * not: netting one line up against another down, a stale document baseline, and the order of
 * two writes each made them differ, twice in the fail-open direction. A screen that shows a
 * different concession from the one the gate will refuse is worse than a screen that shows
 * none, so there is one function and this file calls it.
 *
 * ── The shape of every mutation, and why it is always this shape ─────────────────
 *
 *     transaction
 *       → lock the order, scoped by ownership       ← trap 2, and the lock trap 4 needs
 *       → read the live quote under that lock
 *       → *now* choose and parse the payload schema ← trap 4
 *       → compare the caller's precondition         ← 409 QUOTE_STALE / CATALOG_STALE
 *       → compute the baseline with `calcPrice`     ← never a number from the client
 *       → normalise what the human typed onto one anchor
 *       → write
 *       → recompute the whole document and refuse an incoherent one
 *
 * **The lock comes before the schema**, as it does in `orders.service.ts`. Today no quote
 * body's *shape* depends on the locked row, so it would be fair to ask what the discipline
 * buys — and there is a concrete answer: whether removing a line is a `DELETE` or a stamp
 * depends on `orders.submitted_at`, which is only knowable from the locked row, and a
 * controller that had already decided the shape of the request would be one refactor away
 * from deciding the shape of the write as well. Trap 4 punishes the habit, not the instance.
 *
 * **The document is recomputed after the write, not before it.** Two states are reachable that
 * no single row can see — a document total set below the untaxed charges, and a quote whose
 * total has gone negative — and both are refused by recomputing the whole quote inside the
 * transaction that would otherwise commit it. That is also why the concession this service
 * reports is one subtraction over the *whole* document: plan 7.13's *"ประเมินที่ระดับเอกสาร …
 * ไม่ใช่ต่อแถว"* — ten lines discounted 10% each pass individually and nothing is ever reviewed.
 *
 * ── What this service never does ─────────────────────────────────────────────────
 *
 * It never touches `calcPrice` (plan 7.9(ก): 219 tests stop being a safety net the moment
 * overrides are folded in). It never accepts a computed figure from a client. It never
 * derives baht back from a presentment currency (plan 7.13, second seam). It never writes an
 * approval — `approvals` already exists with its own decider ≠ requester rule, and plan 7.13
 * fails a test if a fifth two-person mechanism appears.
 */
@Injectable()
export class QuotesService {
  constructor(
    private readonly quotes: QuoteRepository,
    /**
     * Every load of an order goes through this and through nothing else — the same boundary
     * `OrdersService` draws. A quote line is a child of an order, so "may this caller touch
     * it?" is a question about the order, and the branded `ScopedOrder` is what makes it
     * impossible to answer it anywhere but in the query.
     */
    private readonly scoped: ScopedOrderRepository,
    private readonly catalog: CatalogRepository,
  ) {}

  /* ---------------------------------------------------------------- *
   * Reading
   * ---------------------------------------------------------------- */

  async getQuote(scope: Scope, orderId: string): Promise<QuoteWire> {
    const order = await this.scoped.findOrFail(scope, orderId, 'read');
    const audience = quoteAudience(scope);

    const [lines, overrides] = await Promise.all([
      this.quotes.listLines(order.id),
      this.quotes.listLiveOverrides(order.id),
    ]);

    const effective = this.effective(lines, overrides);
    const published = await this.publishedIndex();

    /*
     * The staleness sweep runs on a read as well as at submit, and it is the cheaper half of
     * plan 7.9(จ): the salesperson sees the strip the moment they open the quote, rather than
     * at the end of an afternoon's work when they press send. It is not shown to a customer,
     * for the same reason no other concession-shaped fact is.
     */
    const staleBaselines =
      audience === 'customer' ? [] : await this.staleBaselines(order.id, lines, overrides);

    return encodeQuote({
      orderId: order.id,
      quoteRevision: quoteRevision(lines, overrides),
      lines,
      liveOverrides: overrides,
      effective,
      marginConcessionThbMinor: this.marginConcession(lines, overrides),
      documentHashByVersionId: documentHashes(published),
      productIdByVersionId: productIdsByVersion(published),
      vat: DEFAULT_VAT_RULE,
      staleBaselines,
      audience,
    });
  }

  /**
   * ⭐ The submit gate — plan 7.9(จ), and the one method here that another module has to call.
   *
   * Refuses what a submit must not do, and returns **what the submit prices from**. A caller
   * that ignored the refusal would ship the failure this whole pass exists to prevent: ฿17,000
   * promised against ฿18,432 in the afternoon, ฿20,000 published in the evening, and a document
   * that still says ฿17,000 with nobody aware it is now a 15% discount instead of 7.8%.
   *
   * `OrdersService.submit` calls it, inside the transaction that pins, on the row it has already
   * locked. For one round it did not, and 5c was an editor whose output nothing consumed: submit
   * priced the cart in the request body and never read `quote_lines` at all.
   */
  async assertSubmittable(
    tx: Tx,
    order: ScopedOrder,
  ): Promise<{
    readonly effective: EffectiveQuote;
    readonly lines: readonly QuoteLineRow[];
    readonly document: QuoteDocumentInput;
  }> {
    const [lines, overrides] = await Promise.all([
      this.quotes.listLines(order.id, tx),
      this.quotes.listLiveOverrides(order.id, tx),
    ]);

    if (lines.length === 0) {
      /*
       * Zero lines would produce a contract for nothing at a total of zero, which every rule
       * downstream — the deposit, the forfeit ceiling, the instalment that has to foot — then
       * divides by. It was `submitOrderRequestSchema`'s `.min(1)` while the cart came in the
       * body; the cart is `quote_lines` now, so the rule moves with it.
       */
      throw AppError.validationFailed('ใบเสนอราคานี้ยังไม่มีรายการ จึงส่งให้ลูกค้าไม่ได้', {
        reason: 'empty_quote',
      });
    }

    const stale = await this.staleBaselines(order.id, lines, overrides, tx);
    if (stale.length > 0) throw baselinesStale(stale);

    const effective = this.effective(lines, overrides);
    this.assertCoherent(effective);

    return {
      effective,
      lines,
      document: this.documentInput(lines, overrides, await this.publishedIndex()),
    };
  }

  /**
   * Adopt a browser cart into the quote — the one way lines arrive without the editor.
   *
   * The storefront configurator keeps its cart in `localStorage` and has never heard of
   * `quote_lines`; it hands the cart over at submit. Each line is priced **here**, by
   * `calcPrice`, against the published document the request names — the same path
   * `addCatalogLine` takes, and for the same reason: a cart is a list of configurations, never
   * a list of prices.
   *
   * Refused when the order already has a quote. A stale browser cart silently overwriting a
   * quote sales negotiated is the failure the whole submit change exists to end, and merging the
   * two would be plan 7.9(ข)'s "which one wins" asked at the one endpoint where the answer is a
   * contract.
   */
  async adoptCart(
    tx: Tx,
    order: ScopedOrder,
    cart: readonly PriceRequestWire[],
  ): Promise<void> {
    if ((await this.quotes.countLines(tx, order.id)) > 0) {
      throw AppError.conflict(
        'ออร์เดอร์นี้มีใบเสนอราคาอยู่แล้ว — ส่งรายการซ้ำมาไม่ได้ กรุณาโหลดใบเสนอราคาใหม่',
        { reason: 'quote_already_exists' },
      );
    }

    const published = await this.publishedIndex();

    for (const wire of cart) {
      const request = toPriceRequest(wire);
      const entry = this.requirePublished(published.byProductId, request);
      const priced = priceLine(entry.product, request, `product ${request.productId}`);

      await this.quotes.insertCatalogLine(tx, {
        orderId: order.id,
        seq: await this.quotes.nextSeq(tx, order.id),
        productVersionId: entry.productVersionId,
        skuCode: priced.skuCode,
        selections: priced.selections,
        measures: priced.measures,
        configHash: priced.configHash,
        qty: request.qty,
        computedTotalThbMinor: priced.totalThbMinor,
        /* ⚠️ Plan 13's default and not a decision — whether delivery and installation are
         * taxable is on the owner's list, and a configured window is taxable either way. */
        isVatApplicable: true,
        customerDescriptionTh: null,
      });
    }
  }

  /**
   * The live quote in the shape `priceOrderDocument` freezes — configurations, not prices.
   *
   * ⚠️ **No money crosses this boundary for a configured line.** The pin recomputes every one
   * with `calcPrice` from the published document, so a `computed_total_thb_minor` that had
   * drifted could not become a contract; `assertSubmittable` has already raised the integrity
   * alarm if one had. What does cross is what only a human could have decided: the typed amount
   * on a free-form line, the promises, and their provenance.
   */
  private documentInput(
    lines: readonly QuoteLineRow[],
    overrides: readonly QuoteOverrideRow[],
    published: PublishedIndex,
  ): QuoteDocumentInput {
    const catalogLines: QuoteDocumentLine[] = [];
    const charges: QuoteDocumentCharge[] = [];

    for (const line of lines) {
      if (
        line.kind === 'catalog' &&
        line.productVersionId !== null &&
        line.computedTotalThbMinor !== null
      ) {
        /*
         * The catalogue handle this line is pinned to, resolved from what is published *now*.
         *
         * `staleBaselines` has already refused every line whose pinned version is no longer
         * published, so this lookup cannot miss — and the `?? ''` is a type obligation rather
         * than a case, chosen to be a value `priceOrderDocument` refuses rather than one it
         * accepts. That refusal is not dead code either: this index and the one the pin builds
         * are two separate reads of the catalogue, so a publish committing between them is a
         * real, narrow race, and `CATALOG_STALE` is the right answer to it.
         */
        const entry = published.byVersionId.get(line.productVersionId);

        catalogLines.push({
          quoteLineId: line.id,
          seq: line.seq,
          request: {
            productId: entry?.product.id ?? '',
            productVersionId: line.productVersionId,
            documentHash: entry?.documentHash ?? '',
            selections: decodeStoredSelections(line.selections),
            measures: encodeStoredMeasures(line.measures),
            /*
             * ⚠️ Empty, and it is a known and bounded loss. `enteredUnits` is the record of the
             * grid the customer typed on, and `quote_lines` never stored it — not since 5c
             * created the table. `validate` falls back to `group.unit`, and the only thing that
             * changes is which *step warning* is judged and how a message formats; no blocking
             * error and no figure in the frozen document depends on it. Routed rather than
             * papered over: the fix is an `entered_units` column, filled by `addCatalogLine`
             * and `reviseLine`.
             */
            enteredUnits: {},
            qty: line.qty,
          },
          isVatApplicable: line.isVatApplicable,
          customerDescriptionTh: line.customerDescriptionTh,
        });
      } else if (line.chargeTotalThbMinor !== null) {
        charges.push({
          quoteLineId: line.id,
          seq: line.seq,
          netMinor: line.chargeTotalThbMinor,
          isVatApplicable: line.isVatApplicable,
          /* NOT NULL on a free-form line by `addFreeformLineRequestSchema`; the fallback is a
           * type obligation and not a case, and an empty string would be a row nobody can act on. */
          customerDescriptionTh: line.customerDescriptionTh ?? '—',
        });
      }
    }

    return {
      lines: catalogLines,
      charges,
      overrides: overrides.map((override) => ({
        id: override.id,
        anchor: override.anchor,
        quoteLineId: override.quoteLineId,
        computedThbMinor: override.computedThbMinor,
        overrideThbMinor: override.overrideThbMinor,
        computedDays: override.computedDays,
        overrideDays: override.overrideDays,
        enteredAs: override.enteredAs,
        enteredValueText: override.enteredValueText,
        reasonCode: override.reasonCode,
        setByUserId: override.setByUserId,
        setByUserName: override.setByUserName,
      })),
      leadTimeDays: DEFAULT_LEAD_TIME_DAYS,
    };
  }

  /** `product_version_id` → `product_id`, so the pin can name the product a line is of. */
  async productIdsFor(versionIds: readonly string[], tx: Tx): Promise<ReadonlyMap<string, string>> {
    return this.quotes.productIdsForVersions(versionIds, tx);
  }

  /** The same gate, as a request a person can make from the editor before they press send. */
  async verify(scope: Scope, orderId: string): Promise<QuoteWire> {
    return this.write(scope, orderId, {}, async ({ tx, order }) => {
      await this.assertSubmittable(tx, order);
    });
  }

  /* ---------------------------------------------------------------- *
   * Lines
   * ---------------------------------------------------------------- */

  /**
   * Add a configured line.
   *
   * The client sends the catalogue handle it was configuring against and no money at all; the
   * price is `calcPrice`'s and is computed here. A handle that no longer matches what is
   * published is `409 CATALOG_STALE` with the fresh document in the body — the same protocol
   * `/price` and `POST /orders` speak, because a staleness protocol that differs between
   * endpoints is one that is wrong on at least one of them.
   */
  async addCatalogLine(scope: Scope, orderId: string, rawBody: unknown): Promise<QuoteWire> {
    return this.write(scope, orderId, rawBody, async ({ tx, order, body, published, overrides }) => {
      const parsed = parse(addCatalogLineRequestSchema, body);
      this.assertNoDocumentPromise(overrides, 'add_line');
      const request = toPriceRequest(parsed.line);

      const entry = this.requirePublished(published.byProductId, request);
      const priced = priceLine(entry.product, request, `product ${request.productId}`);

      if ((await this.quotes.countLines(tx, order.id)) >= MAX_QUOTE_LINES) {
        throw AppError.validationFailed('ใบเสนอราคานี้มีรายการครบจำนวนสูงสุดแล้ว', {
          limit: MAX_QUOTE_LINES,
        });
      }

      await this.quotes.insertCatalogLine(tx, {
        orderId: order.id,
        seq: await this.quotes.nextSeq(tx, order.id),
        productVersionId: entry.productVersionId,
        skuCode: priced.skuCode,
        selections: priced.selections,
        measures: priced.measures,
        configHash: priced.configHash,
        qty: request.qty,
        computedTotalThbMinor: priced.totalThbMinor,
        isVatApplicable: parsed.isVatApplicable ?? true,
        customerDescriptionTh: parsed.customerDescriptionTh ?? null,
      });
    });
  }

  /**
   * Add a free-form line — plan 7.9(ค)'s "แถวใหม่": delivery, installation, a survey, a credit.
   *
   * The only place a human-typed amount is a *baseline* rather than an override against one,
   * which is why it lands in `charge_total_thb_minor` and never in a column called "computed".
   * `isVatApplicable` defaults to `true`, which is ⚠️ plan 13's default and not a decision:
   * whether delivery and installation are taxable is on the owner's list.
   */
  async addFreeformLine(scope: Scope, orderId: string, rawBody: unknown): Promise<QuoteWire> {
    return this.write(scope, orderId, rawBody, async ({ tx, order, body, overrides }) => {
      const parsed = parse(addFreeformLineRequestSchema, body);
      this.assertNoDocumentPromise(overrides, 'add_line');
      const charge = entered(() => normaliseCharge(parsed.amountText));

      if ((await this.quotes.countLines(tx, order.id)) >= MAX_QUOTE_LINES) {
        throw AppError.validationFailed('ใบเสนอราคานี้มีรายการครบจำนวนสูงสุดแล้ว', {
          limit: MAX_QUOTE_LINES,
        });
      }

      await this.quotes.insertFreeformLine(tx, {
        orderId: order.id,
        seq: await this.quotes.nextSeq(tx, order.id),
        chargeTotalThbMinor: charge,
        isVatApplicable: parsed.isVatApplicable ?? true,
        customerDescriptionTh: parsed.customerDescriptionTh,
      });
    });
  }

  /**
   * Change what a configured line *is* — the fields a works order renders from.
   *
   * `product_version_id` is not one of them and never moves. A request naming a different
   * version is refused with the sentence that says what to do instead, rather than with the
   * trigger's: a different product version is a different line, and the recovery is to remove
   * this one and add it again — which is also the only way a line whose version was archived
   * can be brought forward, because `quote_lines_guard_write()` would refuse the move.
   *
   * Refused outright while the line carries a live `line_total` override. The database
   * refuses it too; this is the message, not the guard. Plan 7.9(ง)(2).
   */
  async reviseLine(
    scope: Scope,
    orderId: string,
    lineId: string,
    rawBody: unknown,
  ): Promise<QuoteWire> {
    return this.write(scope, orderId, rawBody, async ({ tx, order, body, published, overrides }) => {
      const parsed = parse(reviseLineRequestSchema, body);
      this.assertNoDocumentPromise(overrides, 'revise_line');
      const line = await this.requireLine(order.id, lineId, tx);

      if (line.kind !== 'catalog' || line.productVersionId === null) {
        throw AppError.validationFailed('รายการนี้ไม่ได้ผูกกับสินค้าในแคตตาล็อก — แก้ไขคำอธิบายและจำนวนเงินแทน', {
          quoteLineId: line.id,
        });
      }

      const request = toPriceRequest(parsed.line);

      if (request.productVersionId !== line.productVersionId) {
        throw AppError.validationFailed(
          'เวอร์ชันสินค้าของรายการนี้เปลี่ยนไม่ได้ — ถ้าต้องการใช้เวอร์ชันใหม่ ให้ลบรายการนี้แล้วเพิ่มใหม่',
          { quoteLineId: line.id, pinned: line.productVersionId, sent: request.productVersionId },
        );
      }

      /*
       * The product id is resolved from the *line's* version rather than trusted from the
       * body. Without this, a request could name product A's id with product B's version and
       * the staleness comparison below would be made against the wrong entry entirely.
       */
      const productIds = await this.quotes.productIdsForVersions([line.productVersionId], tx);
      const productId = productIds.get(line.productVersionId);
      if (productId !== request.productId) {
        throw AppError.validationFailed('รายการนี้ไม่ใช่สินค้าที่ระบุ', { quoteLineId: line.id });
      }

      const entry = this.requirePublished(published.byProductId, request);
      const priced = priceLine(entry.product, request, `line ${String(line.seq)}`);

      await this.quotes.reviseLine(tx, {
        lineId: line.id,
        skuCode: priced.skuCode,
        selections: priced.selections,
        measures: priced.measures,
        configHash: priced.configHash,
        qty: request.qty,
        computedTotalThbMinor: priced.totalThbMinor,
      });
    }, 'reprice_line');
  }

  /**
   * Change what the customer *reads*.
   *
   * ⚠️ A separate route from the one above, and the separation is plan 7.9(ค)'s ⚠️ made
   * structural rather than remembered. Sales can write "กระจกเทมเปอร์ 8 มม." on a line whose
   * sku says T6, and that is allowed — it is their sentence to the customer. What it must
   * never do is reach the factory, which is `worksOrderLines`' job, and the fact that this
   * request cannot touch a single field that function reads is the second half of the rule.
   */
  async presentLine(
    scope: Scope,
    orderId: string,
    lineId: string,
    rawBody: unknown,
  ): Promise<QuoteWire> {
    return this.write(scope, orderId, rawBody, async ({ tx, order, body, overrides }) => {
      const parsed = parse(presentLineRequestSchema, body);
      const line = await this.requireLine(order.id, lineId, tx);

      /*
       * ⚠️ Taxability is not prose, and it was in the prose request.
       *
       * A red team flipped `isVatApplicable` through this route on a line carrying a live
       * promise and moved ฿897.68 of the customer's money — the largest one-click money move on
       * the screen — through the one endpoint whose whole purpose is text nobody prices from.
       * It stays on this request (plan 7.9(ค) makes per-line taxability editable and there is
       * no second sensible home for it), but it is now a *money* edit: refused under a document
       * promise, refused by `quote_lines_guard_write()` under a line promise, and counted by
       * `measureMargin` as a `vat_exemption` concession so that granting it enlarges what has
       * to be approved rather than shrinking it.
       *
       * The description half is untouched and stays freely editable, which is why the refusal
       * is conditional on the flag actually moving rather than on it being mentioned.
       */
      if (parsed.isVatApplicable !== undefined && parsed.isVatApplicable !== line.isVatApplicable) {
        this.assertNoDocumentPromise(overrides, 'present_line');
      }

      await this.quotes.presentLine(tx, {
        lineId: line.id,
        ...(parsed.customerDescriptionTh === undefined
          ? {}
          : { customerDescriptionTh: parsed.customerDescriptionTh }),
        ...(parsed.isVatApplicable === undefined ? {} : { isVatApplicable: parsed.isVatApplicable }),
      });
    });
  }

  /**
   * Take a line off the quote.
   *
   * Before submit it is a cart item and is deleted; afterwards it is history and is stamped.
   * The branch is decided from `orders.submitted_at` on the row this transaction locked —
   * which is the one place in this feature where the shape of the write really does depend on
   * the locked row, and therefore the reason the lock precedes everything.
   */
  async removeLine(
    scope: Scope,
    orderId: string,
    lineId: string,
    rawBody: unknown,
  ): Promise<QuoteWire> {
    return this.write(scope, orderId, rawBody, async ({ tx, order, body, user, overrides }) => {
      parse(removeLineRequestSchema, body);
      this.assertNoDocumentPromise(overrides, 'remove_line');
      const line = await this.requireLine(order.id, lineId, tx);

      /*
       * ⚠️ THIS GUARD IS THE API'S ALONE ON A DRAFT, AND THAT IS A FINDING.
       *
       * `quote_lines_guard_write()` refuses to move `removed_at` while a live `line_total`
       * override hangs off the line — which covers a *submitted* quote. Before submit the line
       * is deleted rather than stamped, `DELETE` reaches only the trigger's first branch (which
       * asks about `submitted_at` and nothing else), and `quote_overrides_line_fk` is
       * `ON DELETE CASCADE`. So on a draft the promise goes with the line, silently: exactly
       * the disappearance plan 7.9(ง)(2) is about, arriving through the one door the schema
       * leaves open.
       *
       * Refused here in every status rather than only after submit, because "sales agreed
       * ฿17,000 for this window" is a fact about a conversation and not about whether the PDF
       * has been sent yet, and because a recovery that changes shape at the submit boundary is
       * one nobody will remember. The uniform answer is: withdraw the promise, with a name and
       * a reason on it, then remove the line.
       */
      const promised = overrides.find(
        (override) => override.anchor === 'line_total' && override.quoteLineId === line.id,
      );
      if (promised !== undefined) {
        throw AppError.conflict(
          'รายการนี้มีราคาที่ตกลงกับลูกค้าไว้แล้ว — ต้องยกเลิกราคาที่ตกลงไว้ก่อนจึงจะลบรายการได้',
          { reason: 'quote_guard', operation: 'remove_line', overrideId: promised.id },
        );
      }

      if (order.submittedAt === null) await this.quotes.deleteLine(tx, line.id);
      else await this.quotes.removeLine(tx, line.id, user.userId);
    }, 'remove_line');
  }

  /* ---------------------------------------------------------------- *
   * Overrides
   * ---------------------------------------------------------------- */

  /**
   * ⭐ Set a figure a human decided — the write this whole round is about.
   *
   * The client sends what was typed and the box it was typed into. This method computes the
   * baseline itself, normalises the entry onto the anchor, stores **both** figures, and
   * throws the percentage away — plan 7.9(ก): a delta becomes ฿9,209 the day the catalogue
   * moves to ฿9,500, having promised ฿8,500. `entered_value_text` keeps `'-15%'` so the
   * conversation is still reconstructable.
   *
   * Replacing a live promise is the same request again, and it goes through
   * `replaceOverride`, which performs the stamp-then-insert that the partial unique index
   * forces (see `0016_quote_guards.sql`).
   */
  async setOverride(scope: Scope, orderId: string, rawBody: unknown): Promise<QuoteWire> {
    return this.write(scope, orderId, rawBody, async ({ tx, order, body, user, lines, overrides }) => {
      const parsed = parse(setOverrideRequestSchema, body);

      /*
       * A line-level promise underneath a live document promise is what made
       * `concession.ts`'s ordering invariant false — the grand total's stored baseline is the
       * figure the document showed *after* the line overrides, and writing one afterwards makes
       * that sentence a lie in the over-counting direction. Refused; the recovery is to withdraw
       * the document promise, set the line, and set the document total again.
       */
      if (parsed.anchor === 'line_total') this.assertNoDocumentPromise(overrides, 'line_override');

      const baseline = await this.baselineFor(tx, order, parsed, lines, overrides);

      const normalised = entered(() =>
        normaliseEntry({
          anchor: parsed.anchor,
          enteredAs: parsed.enteredAs,
          enteredValueText: parsed.enteredValueText,
          computedThbMinor: baseline.computedThbMinor,
          computedDays: baseline.computedDays,
          qty: baseline.qty,
        }),
      );

      if (normalised.kind === 'days' && normalised.overrideDays > MAX_LEAD_TIME_DAYS) {
        throw AppError.validationFailed('ระยะเวลาส่งมอบที่กรอกยาวเกินกว่าที่ระบบรับได้', {
          maxDays: MAX_LEAD_TIME_DAYS,
        });
      }

      /*
       * `quote_overrides_value_differs` refuses this too, and it is refused here for the
       * message: agreeing with the machine is not a promise, it is the *absence* of one, and
       * the way to say "this price is fine after all" is to revoke the override that exists.
       */
      const unchanged =
        normalised.kind === 'money'
          ? normalised.overrideThbMinor === baseline.computedThbMinor
          : normalised.overrideDays === baseline.computedDays;

      if (unchanged) {
        throw AppError.validationFailed(
          'ค่าที่กรอกเท่ากับค่าที่ระบบคำนวณอยู่แล้ว — ถ้าต้องการยืนยันตามระบบ ให้ยกเลิกราคาที่ตกลงไว้เดิมแทน',
          { anchor: parsed.anchor },
        );
      }

      const row = {
        orderId: order.id,
        quoteLineId: parsed.anchor === 'line_total' ? parsed.quoteLineId : null,
        anchor: parsed.anchor,
        computedThbMinor: normalised.kind === 'money' ? baseline.computedThbMinor : null,
        overrideThbMinor: normalised.kind === 'money' ? normalised.overrideThbMinor : null,
        computedDays: normalised.kind === 'days' ? baseline.computedDays : null,
        overrideDays: normalised.kind === 'days' ? normalised.overrideDays : null,
        enteredAs: parsed.enteredAs,
        /* Verbatim. Whatever the keyboard produced, minus the whitespace zod trimmed. */
        enteredValueText: parsed.enteredValueText,
        reasonCode: parsed.reasonCode,
        noteTh: parsed.noteTh ?? null,
        setByUserId: user.userId,
      };

      const live = overrides.find(
        (candidate) =>
          candidate.anchor === parsed.anchor &&
          candidate.quoteLineId === row.quoteLineId,
      );

      if (live === undefined) await this.quotes.insertOverride(tx, row);
      else {
        await this.quotes.replaceOverride(tx, {
          predecessorId: live.id,
          supersededByUserId: user.userId,
          successor: row,
        });
      }
    }, 'write_override');
  }

  /**
   * Withdraw a promise, leaving no successor.
   *
   * Also the way sales *confirms* a price the catalogue has moved under: there is no override
   * to write, because an override equal to today's computed figure is not a promise.
   */
  async revokeOverride(
    scope: Scope,
    orderId: string,
    overrideId: string,
    rawBody: unknown,
  ): Promise<QuoteWire> {
    return this.write(scope, orderId, rawBody, async ({ tx, order, body, user, overrides }) => {
      parse(revokeOverrideRequestSchema, body);

      if (!isOrderUuid(overrideId)) throw AppError.notFound('ไม่พบราคาที่ตกลงไว้รายการนี้');

      const live = await this.quotes.findLiveOverride(order.id, overrideId, tx);
      if (!live) throw AppError.notFound('ไม่พบราคาที่ตกลงไว้รายการนี้');

      /*
       * The other direction of the same ordering problem, and the one that fails **open**:
       * withdrawing a line promise from under a document promise leaves the document's stored
       * baseline a figure that includes a concession no longer being made, so `measureMargin`
       * under-counts. The red team measured ฿500 for a ฿1,570 concession this way — on the
       * number `AuthorityService.gate` reads.
       *
       * Withdrawing the *document* promise is always allowed. It is the recovery, and a promise
       * nobody could withdraw would be a quote nobody could edit again.
       */
      if (live.anchor === 'line_total') {
        this.assertNoDocumentPromise(overrides, 'line_override');
      }

      await this.quotes.revokeOverride(tx, live.id, user.userId);
    }, 'supersede_override');
  }

  /* ---------------------------------------------------------------- *
   * The shape every mutation shares
   * ---------------------------------------------------------------- */

  /**
   * Lock, read, parse, write, re-read, assess — once, so no route can leave a step out.
   *
   * The callback receives the locked order, the live quote as it was *before* its write, and
   * the raw body; everything after it returns is this method's, including the two checks that
   * decide whether the transaction may commit at all.
   */
  private async write(
    scope: Scope,
    orderId: string,
    body: unknown,
    apply: (context: {
      readonly tx: Tx;
      readonly order: ScopedOrder;
      readonly user: UserScope;
      readonly body: unknown;
      readonly lines: readonly QuoteLineRow[];
      readonly overrides: readonly QuoteOverrideRow[];
      readonly published: PublishedIndex;
    }) => Promise<void>,
    operation: QuoteOperation = 'write_line',
  ): Promise<QuoteWire> {
    const user = requireUser(scope);

    return withTranslatedQuoteErrors(async () => this.quotes.transaction(async (tx) => {
      /* ① The lock, scoped by ownership. Nothing below reads an order any other way. */
      const order = await this.scoped.lockOrFail(tx, scope, orderId, 'act');

      const [lines, overrides] = await Promise.all([
        this.quotes.listLines(order.id, tx),
        this.quotes.listLiveOverrides(order.id, tx),
      ]);

      /*
       * ② The precondition, compared before anything is written and after the row is locked.
       *
       * Read structurally rather than by parsing the whole body twice: every write carries
       * `expect` and the comparison has to happen regardless of which request this is. A body
       * with no readable `expect` is left alone here and refused by the request schema inside
       * `apply`, with a path in the message.
       */
      const precondition = readPrecondition(body);
      const current = quoteRevision(lines, overrides);
      if (precondition !== undefined && precondition.quoteRevision !== current) {
        throw quoteStale(precondition.quoteRevision, current);
      }

      const published = await this.publishedIndex();

      /* ③ …and only now is the body's own schema chosen and run. Trap 4 — see the file note. */
      await apply({ tx, order, user, body, lines, overrides, published });

      /* ④ The whole document, as this write left it. */
      const [after, afterOverrides] = await Promise.all([
        this.quotes.listLines(order.id, tx),
        this.quotes.listLiveOverrides(order.id, tx),
      ]);

      const effective = this.effective(after, afterOverrides);
      this.assertCoherent(effective);

      const staleBaselines = await this.staleBaselines(order.id, after, afterOverrides, tx);

      return encodeQuote({
        orderId: order.id,
        quoteRevision: quoteRevision(after, afterOverrides),
        lines: after,
        liveOverrides: afterOverrides,
        effective,
        marginConcessionThbMinor: this.marginConcession(after, afterOverrides),
        documentHashByVersionId: documentHashes(published),
        productIdByVersionId: productIdsByVersion(published),
        vat: DEFAULT_VAT_RULE,
        staleBaselines,
        audience: 'sales',
      });
    }), operation);
  }

  /* ---------------------------------------------------------------- *
   * Helpers
   * ---------------------------------------------------------------- */

  /** `applyOverrides`, fed from rows. The one place the engine is called. */
  private effective(
    lines: readonly QuoteLineRow[],
    overrides: readonly QuoteOverrideRow[],
  ): EffectiveQuote {
    const computed: ComputedLine[] = [];
    const charges: ChargeLine[] = [];

    for (const line of lines) {
      if (line.computedTotalThbMinor !== null) {
        computed.push({
          lineId: line.id,
          seq: line.seq,
          qty: line.qty,
          computedTotalThbMinor: line.computedTotalThbMinor,
          isVatApplicable: line.isVatApplicable,
        });
      } else if (line.chargeTotalThbMinor !== null) {
        charges.push({
          lineId: line.id,
          seq: line.seq,
          chargeTotalThbMinor: line.chargeTotalThbMinor,
          isVatApplicable: line.isVatApplicable,
        });
      }
    }

    return applyOverrides({
      computed,
      charges,
      overrides,
      vat: DEFAULT_VAT_RULE,
      computedLeadTimeDays: DEFAULT_LEAD_TIME_DAYS,
    });
  }

  /**
   * How much this quote concedes — `measureMargin`'s number, not a second one.
   *
   * The rows are the same rows `AuthorityService.gate` will read at submit, and the function is
   * the same function, so the figure on the screen and the figure compared against a ceiling
   * cannot be different numbers. That was not true for one round, and the ways it was untrue
   * are listed in the header of `overrides.ts`.
   *
   * The integrity alarm is translated rather than propagated for the same reason the authority
   * module translates it: an override anchored to a line that is not live is a state the
   * guards say cannot exist, so it is a 500 with a stack and not a 409 a client would retry.
   */
  private marginConcession(
    lines: readonly QuoteLineRow[],
    overrides: readonly QuoteOverrideRow[],
  ): bigint {
    try {
      return measureMargin({ vat: DEFAULT_VAT_RULE, lines, overrides }).concessionThbMinor;
    } catch (error) {
      if (error instanceof ConcessionIntegrityError) {
        throw new AppError(
          'INTERNAL',
          500,
          'ข้อมูลส่วนลดของใบเสนอราคานี้ไม่สอดคล้องกัน กรุณาติดต่อผู้ดูแลระบบ',
          { overrideId: error.overrideId, quoteLineId: error.quoteLineId },
        );
      }
      throw error;
    }
  }

  /**
   * ⭐ A live document promise freezes the document — plan 7.9(ก), one subject up.
   *
   * `0018_quote_document_freeze.sql` refuses these writes and this is the sentence, exactly as
   * the line-level guard's refusal is the database's and its message is here. It is repeated in
   * the API rather than left to the trigger because a salesperson needs to be told *what to do*
   * — withdraw the document promise, then edit — and a translated `restrict_violation` cannot
   * say that.
   *
   * What it closes, in the numbers two red teams printed: a ฿7,495.84 document promise with two
   * more lines added under it invoiced ฿7,495.84 against a ฿66,562.56 document and measured a
   * ฿0.00 concession; the same promise with its only line removed invoiced ฿14,291.68 for
   * nothing at all, with ฿934.97 of VAT on ฿0.00 of goods.
   */
  private assertNoDocumentPromise(
    overrides: readonly QuoteOverrideRow[],
    operation: 'add_line' | 'revise_line' | 'present_line' | 'remove_line' | 'line_override',
  ): void {
    const promise = overrides.find((override) => override.anchor === 'grand_total');
    if (promise === undefined) return;

    throw AppError.conflict(
      'ใบเสนอราคานี้กำหนดยอดรวมไว้แล้ว — ต้องยกเลิกยอดรวมที่ตกลงไว้ก่อนจึงจะแก้ไขรายการได้',
      { reason: 'quote_document_promise', operation, overrideId: promise.id },
    );
  }

  /**
   * States a write may not leave behind.
   *
   * Both are reachable and neither is a database constraint's business: the first is the
   * interaction of a document-level override with a VAT-exempt charge, which no single row
   * can see, and the second is what a negative charge does on its own.
   */
  private assertCoherent(effective: EffectiveQuote): void {
    if (effective.grandOverrideBelowExemptCharges) {
      throw AppError.validationFailed(
        'ยอดรวมที่กำหนดไว้ต่ำกว่าค่าบริการที่ไม่คิดภาษีรวมกัน — ต้องแก้ยอดรวมหรือค่าบริการก่อน',
        { reason: 'grand_total_below_exempt_charges' },
      );
    }

    if (effective.money.grandTotalThbMinor < 0n) {
      throw AppError.validationFailed(
        'ยอดรวมของใบเสนอราคาติดลบ — เงินที่ต้องจ่ายคืนลูกค้าเป็นกระบวนการคืนเงิน ไม่ใช่ใบเสนอราคา',
        { reason: 'negative_grand_total' },
      );
    }
  }

  /**
   * The figure this promise is being made against — computed here, never sent.
   *
   * For a `grand_total` the baseline is the document *after* the line overrides and before
   * this one, which is what `quote_overrides`' own note says it means and what makes the
   * re-verification at submit well-defined: the cascade runs lines, then document, and never
   * back up.
   */
  private async baselineFor(
    tx: Tx,
    order: ScopedOrder,
    parsed: SetOverrideRequestWire,
    lines: readonly QuoteLineRow[],
    overrides: readonly QuoteOverrideRow[],
  ): Promise<{
    readonly computedThbMinor: bigint | null;
    readonly computedDays: number | null;
    readonly qty: number;
  }> {
    if (parsed.anchor === 'lead_time_days') {
      return { computedThbMinor: null, computedDays: DEFAULT_LEAD_TIME_DAYS, qty: 1 };
    }

    if (parsed.anchor === 'grand_total') {
      const withoutGrand = this.effective(
        lines,
        overrides.filter((override) => override.anchor !== 'grand_total'),
      );
      return {
        computedThbMinor: withoutGrand.money.grandTotalThbMinor,
        computedDays: null,
        qty: 1,
      };
    }

    const line = await this.requireLine(order.id, parsed.quoteLineId, tx);

    /*
     * A promise cannot be made against a baseline that is already stale. Letting it through
     * would record ฿17,000 against ฿18,432 at a moment when the published price is ฿20,000,
     * which is the exact number plan 7.9(จ) uses to explain why the pass exists — and it
     * would do so with a fresh timestamp on it, which makes the record look reliable.
     *
     * ⚠️ THIS `if` SHIPPED WITH NO INDEPENDENT EVIDENCE FOR ONE ROUND. IT HAS SOME NOW.
     *
     * Mutation testing neutralised it and the whole suite stayed green: `verifyBaselines` was
     * well covered, but nothing proved that *this write* consulted it. The obstacle was real —
     * producing a stale baseline means publishing a second version of a catalogue product
     * inside the suite, which archives the first, and `vitest.config.ts` records that
     * publishing a *seeded* product is what made `catalog-fidelity.pg.test.ts` pass or fail by
     * file order.
     *
     * The way through was not to publish something seeded but to create a product, publish it,
     * reprice it and publish it again — all inside the test, so nothing shared is disturbed.
     * `tests/quotes/submit-seam.pg.test.ts` and the ⑥ step of `walkthrough.pg.test.ts` both do
     * that and both now fail when this `if` is removed.
     */
    if (line.kind === 'catalog') {
      const stale = await this.staleBaselines(order.id, [line], overrides, tx);
      if (stale.length > 0) throw baselinesStale(stale);
    }

    const baseline = line.computedTotalThbMinor ?? line.chargeTotalThbMinor;
    if (baseline === null) {
      throw new Error(`quotes: line ${line.id} carries neither a computed total nor a charge`);
    }

    return { computedThbMinor: baseline, computedDays: null, qty: line.qty };
  }

  private async requireLine(orderId: string, lineId: string, tx: Tx): Promise<QuoteLineRow> {
    /*
     * A path segment reaches a `uuid` column, and one that is not a uuid is SQLSTATE 22P02 —
     * neither an `AppError` nor an `HttpException`, so it falls through the filter as a 500
     * with a logged stack. The same check `resolveChangeRequest` learned to make.
     */
    if (!isOrderUuid(lineId)) throw AppError.notFound('ไม่พบรายการนี้ในใบเสนอราคา');

    const line = await this.quotes.findLine(orderId, lineId, tx);
    if (!line) throw AppError.notFound('ไม่พบรายการนี้ในใบเสนอราคา');
    return line;
  }

  private requirePublished(
    byProductId: ReadonlyMap<string, PublishedProduct>,
    request: PriceRequest,
  ): PublishedProduct {
    const entry = byProductId.get(request.productId);

    if (!entry) {
      /* 422 and not 404: the request is well-formed and addressed to the order. */
      throw AppError.validationFailed('สินค้าในรายการนี้ไม่มีอยู่ในแคตตาล็อกที่เผยแพร่อยู่', {
        productId: request.productId,
      });
    }

    if (
      entry.productVersionId !== request.productVersionId ||
      entry.documentHash !== request.documentHash
    ) {
      throw catalogStale(
        { productVersionId: request.productVersionId, documentHash: request.documentHash },
        entry,
      );
    }

    return entry;
  }

  private async staleBaselines(
    orderId: string,
    lines: readonly QuoteLineRow[],
    overrides: readonly QuoteOverrideRow[],
    tx?: Tx,
  ): Promise<readonly StaleBaselineWire[]> {
    const published = await this.publishedIndex();

    const archived = lines
      .filter(
        (line) =>
          line.productVersionId !== null && !published.byVersionId.has(line.productVersionId),
      )
      .map((line) => line.productVersionId as string);

    return verifyBaselines({
      orderId,
      lines,
      liveOverrides: overrides,
      /*
       * The document as it stands with the line promises applied and the document promise
       * removed — which is exactly what `baselineFor` computed when the promise was written, so
       * the comparison is between two figures produced by the same cascade. Recomputing it here
       * rather than storing it is the point: a stored copy is what went stale in the first place.
       */
      documentBaselineThbMinor: this.effective(
        lines,
        overrides.filter((override) => override.anchor !== 'grand_total'),
      ).money.grandTotalThbMinor,
      publishedByVersionId: published.byVersionId,
      publishedByProductId: published.byProductId,
      productIdByVersionId: await this.quotes.productIdsForVersions(archived, tx),
    });
  }

  /**
   * The published catalogue, indexed twice.
   *
   * One read of the whole catalogue per request, which is the same honest cost
   * `OrdersService.catalogIndex` accepts and for the same reason: `CatalogRepository` serves
   * the published set and finds one product by *slug*, and a quote line carries neither. The
   * fix, if order volume ever makes it matter, is a `findByIds` on the read repository — not a
   * second query path over `product_versions` in this module, which is the second reader plan
   * 5 warns about.
   */
  private async publishedIndex(): Promise<PublishedIndex> {
    const published = await this.catalog.findAll();
    return {
      byProductId: new Map(published.map((entry) => [entry.product.id, entry])),
      byVersionId: new Map(published.map((entry) => [entry.productVersionId, entry])),
    };
  }

}

/** Everything `priceOrderDocument` freezes, as the quote holds it. */
export interface QuoteDocumentInput {
  readonly lines: readonly QuoteDocumentLine[];
  readonly charges: readonly QuoteDocumentCharge[];
  readonly overrides: readonly QuoteDocumentOverride[];
  readonly leadTimeDays: number;
}

interface PublishedIndex {
  readonly byProductId: ReadonlyMap<string, PublishedProduct>;
  readonly byVersionId: ReadonlyMap<string, PublishedProduct>;
}

/**
 * `product_version_id` → the hash of the frozen document that version publishes.
 *
 * The other half of the `CatalogRef` a client needs to send a line back for repricing. A quote
 * carries the version but not the hash, so a dashboard holding a quote could not construct a
 * well-formed revision request at all — which is why qty and options shipped read-only on the
 * editor, and why supplying a hash from anywhere else would have been a guess at the pinned
 * document rather than a handle.
 */
const documentHashes = (published: PublishedIndex): ReadonlyMap<string, string> =>
  new Map([...published.byVersionId].map(([versionId, entry]) => [versionId, entry.documentHash]));

/**
 * `product_version_id` → `product_id`, from the same index and for the same request.
 *
 * `PriceRequestWire` carries three things a quote line does not: the hash above, this id, and
 * the units each measurement was typed in. The first two are facts about the catalogue that a
 * client cannot derive, so they are served; the third is a fact about a keyboard that nobody
 * recorded, and `ReviseLineRequestWire`'s caller states what it is showing (see the dashboard's
 * `reviseQty`). Publishing the id gives nothing away: the server resolves it from the line's
 * own version regardless and refuses a request that names another.
 */
const productIdsByVersion = (published: PublishedIndex): ReadonlyMap<string, string> =>
  new Map([...published.byVersionId].map(([versionId, entry]) => [versionId, entry.product.id]));

/* ------------------------------------------------------------------ *
 * Module-level helpers
 * ------------------------------------------------------------------ */

/**
 * Staff or customer, from a permission the caller demonstrably holds.
 *
 * `quotes.read` and not `orders.read`, because the two are different questions and this
 * repository already keeps them apart in `PERMISSIONS`: a clerk who may read orders is not
 * thereby entitled to the record of what the company was willing to concede.
 */
const quoteAudience = (scope: Scope): QuoteAudience =>
  scopeHolds(scope, 'quotes.read') ? 'sales' : 'customer';

/**
 * A signed-in person, or 401.
 *
 * `RequirePermissions` on the route means this cannot be reached without one, so it is the
 * second lock rather than the first — and it is a `throw` and not a non-null assertion because
 * "the guard would have stopped them" is a claim about a decorator in another file.
 * `quote_overrides.set_by_user_id` is NOT NULL and has no guest sibling: a customer cannot set
 * a price, so there is no principal here but a person with a name.
 */
function requireUser(scope: Scope): UserScope {
  if (scope.kind !== 'user') {
    throw AppError.unauthenticated('ต้องเข้าสู่ระบบด้วยบัญชีพนักงานจึงจะแก้ไขใบเสนอราคาได้');
  }
  return scope;
}

/** `ZodBodyPipe`'s parse, performed here instead — after the lock. Same error, same shape. */
function parse<T>(schema: ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;

  throw AppError.badRequest('รูปแบบข้อมูลที่ส่งมาไม่ถูกต้อง', {
    source: 'body',
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.map((segment) => String(segment)).join('.'),
      message: issue.message,
    })),
  });
}

/** The precondition, read structurally. See step ② of `write` for why it is not parsed. */
function readPrecondition(body: unknown): QuotePreconditionWire | undefined {
  if (typeof body !== 'object' || body === null || !('expect' in body)) return undefined;
  const expect = (body as { expect: unknown }).expect;

  if (typeof expect !== 'object' || expect === null || !('quoteRevision' in expect)) {
    return undefined;
  }
  const token = (expect as { quoteRevision: unknown }).quoteRevision;

  return typeof token === 'string' ? { quoteRevision: token } : undefined;
}

/** `EntryError` is prose for a salesperson; this is where it becomes a 422. */
function entered<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof EntryError) {
      throw AppError.validationFailed(error.messageTh, { reason: 'entry' });
    }
    throw error;
  }
}
