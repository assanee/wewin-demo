import { createHash } from 'node:crypto';

import { calcPrice } from '@wewin/core/pricing';
import { buildSkuCode } from '@wewin/core/sku';
import { configHash } from '@wewin/core/hash';
import { hasBlockingError, validate } from '@wewin/core/validation';
import type { TaxRule } from '@wewin/core/vat';
import type { Product } from '@wewin/core';
import { canonicalJson } from '@wewin/db/hash';
import { encodeUm } from '@wewin/contract/measure';
import { encodePriceBreakdown, toPriceRequest } from '@wewin/contract/pricing';
import { toBigInt } from '@wewin/contract/exact';
import {
  ORDER_DOCUMENT_SCHEMA_VERSION,
  encodeThb,
  type OrderDocumentLineWire,
  type OrderDocumentOverrideWire,
  type OrderDocumentWire,
  type OrderLineRequestWire,
} from '@wewin/contract/order';
import { catalogStaleBody } from '@wewin/contract/errors';

import { AppError, type JsonValue } from '../common/errors/app-error';
import { encodeCoreMessage, message, pinnedLocaleOf } from '../i18n';
/*
 * The pure engine, imported from its own file rather than through `../quotes` — that barrel
 * re-exports `QuotesModule`, and pulling a Nest module into the pricing path would make an
 * import cycle out of what is only a function over numbers.
 */
import {
  applyOverrides,
  type ChargeLine,
  type ComputedLine,
  type LiveOverride,
} from '../quotes/overrides';
import { CATALOG_STALE_MESSAGE } from './pg-errors';

/**
 * Turning a cart into the document an order is contracted on — plan 7.4 trap 3.
 *
 * ── What is pinned, and why it is pinned here and not later ──────────────────────
 *
 * Sales opens the payment slip hours or days after the customer sent it. If a catalogue
 * version was published in between, a contract built at *acceptance* time is built from a
 * document the customer never saw. So everything the price depends on is frozen in one
 * transaction at **submit**, and this module is what produces the thing that gets frozen.
 *
 * Plan 7.13 lists seven pins. Five exist today and are all here or on `orders`: the
 * catalogue version (per line, plus a real foreign key in `order_document_product_versions`),
 * the VAT rate and treatment, the core build that produced the numbers, the document locale,
 * and the scheduled deposit. Two — the forfeit policy and the payment policy — belong to
 * tables 5b creates; `pin_schema_version` on the row is what stops a hash made under this
 * recipe being compared against one made under 5b's.
 *
 * The rate pin is deliberately absent rather than seamed: plan 13's default closes the
 * foreign-currency line entirely and every invoice is THB, so there is no rate to pin.
 *
 * ── Money never arrives from a client ────────────────────────────────────────────
 *
 * Every figure below is computed here by `calcPrice` from (product version, selections,
 * measures, qty). Plan 7.9(ก) puts that in the machine layer and keeps it there; 5c adds an
 * `override` layer *beside* it that records both the computed and the overridden number, and
 * `pricing.ts` is not touched by either. That is why the request type has no amount on it.
 */

/** A published product as the read path serves it: the document, materialised, plus its handle. */
export interface CatalogEntry {
  readonly productVersionId: string;
  readonly documentHash: string;
  readonly product: Product;
}

export interface PricedDocument {
  readonly document: OrderDocumentWire;
  readonly documentHash: string;
  readonly netThbMinor: bigint;
  readonly vatThbMinor: bigint;
  readonly grandTotalThbMinor: bigint;
  /** For `order_document_product_versions` — the half of trap 3 that is a foreign key. */
  readonly productVersionIds: readonly string[];
}

/**
 * One configured line of the quote, as the pin sees it.
 *
 * `request` is what the line *is* — the catalogue handle, the selections, the measures, the
 * quantity — and there is no money on it. Every figure is recomputed here by `calcPrice`, at
 * pin time, from a document verified to be the published one, which is the whole of plan
 * 7.9(ก)'s machine layer: **the pin never inherits a stored price**. A `quote_lines` row whose
 * `computed_total_thb_minor` disagrees with what comes out is `assertSubmittable`'s integrity
 * alarm and never reaches this function.
 */
export interface QuoteDocumentLine {
  readonly quoteLineId: string;
  readonly seq: number;
  readonly request: OrderLineRequestWire;
  readonly isVatApplicable: boolean;
  readonly customerDescriptionTh: string | null;
}

/** A free-form line: delivery, installation, a survey, a credit. May be negative. */
export interface QuoteDocumentCharge {
  readonly quoteLineId: string;
  readonly seq: number;
  readonly netMinor: bigint;
  readonly isVatApplicable: boolean;
  readonly customerDescriptionTh: string;
}

/** A live promise, with both the arithmetic half `applyOverrides` needs and the provenance half. */
export interface QuoteDocumentOverride extends LiveOverride {
  readonly enteredAs: string;
  readonly enteredValueText: string;
  readonly reasonCode: string;
  readonly setByUserId: string;
  readonly setByUserName: string | null;
}

export interface PriceOrderParams {
  readonly lines: readonly QuoteDocumentLine[];
  readonly charges: readonly QuoteDocumentCharge[];
  readonly overrides: readonly QuoteDocumentOverride[];
  readonly leadTimeDays: number;
  /** `productId` → what is published right now. */
  readonly catalog: ReadonlyMap<string, CatalogEntry>;
  readonly vat: TaxRule;
  /**
   * The language the customer was reading when they agreed to this — plan 10.6.
   *
   * A `string` and not a `SupportedLocale`, because the value arrives from a request body
   * (`z.string().min(2).max(16)`, which accepts `klingon`) or from `orders.contact_locale`,
   * a `text` column with rows older than this file. It is narrowed on the way into the
   * document by `pinnedLocaleOf`, which is the *only* place that narrowing happens.
   */
  readonly locale: string;
  readonly coreVersion: string;
  readonly revision: number;
}

/**
 * Price a cart and freeze it.
 *
 * Refusals, in the order they are checked, because the order is itself a decision:
 *
 *   1. **The product exists and is published.** A line naming something unpublished is 422,
 *      not 404: the request as a whole is well-formed and addressed to the order.
 *   2. **The catalogue handle is current** — 409 with the fresh document, plan 5 point 5.
 *      Checked before pricing, because pricing a line the customer is about to be shown a
 *      different price for is work whose only effect would be to make the refusal slower.
 *   3. **The configuration is manufacturable.** `validate` produces core's issues and a
 *      blocking one refuses the submit. Plan 4.7 found a rule that was silently false across
 *      a whole range — a window that cannot be made must not become a contract to make it.
 *
 * Warnings are carried, not refused: they travel with the quote so the sales team sees them
 * (they are in the frozen breakdown by way of the line's own price).
 */
export function priceOrderDocument(params: PriceOrderParams): PricedDocument {
  const lines: OrderDocumentLineWire[] = [];
  const productVersionIds = new Set<string>();
  const computed: ComputedLine[] = [];

  params.lines.forEach((line) => {
    const wire = line.request;
    const lineNo = line.seq;
    const entry = params.catalog.get(wire.productId);

    if (!entry) {
      throw AppError.validationFailed('สินค้าในรายการนี้ไม่มีอยู่ในแคตตาล็อกที่เผยแพร่อยู่', {
        lineNo,
        productId: wire.productId,
      });
    }

    if (
      entry.productVersionId !== wire.productVersionId ||
      entry.documentHash !== wire.documentHash
    ) {
      /*
       * 409 and not 400: the client was not wrong to send this, the document moved under it.
       * The body carries the current document whole, because the alternative sends every
       * open configurator back for it at the moment a publish has just invalidated all of
       * them at once.
       */
      throw AppError.conflict(CATALOG_STALE_MESSAGE, {
        lineNo,
        /*
         * `Exact` is opaque on purpose (contract/exact.ts): it exposes no readable member,
         * so it is not structurally a `JsonValue` even though it serialises as one. This
         * assertion is the single place that opacity ends, and it ends on the way out.
         */
        stale: catalogStaleBody(
          { productVersionId: wire.productVersionId, documentHash: wire.documentHash },
          entry,
        ) as unknown as JsonValue,
      });
    }

    const request = toPriceRequest(wire);
    const issues = validate(entry.product, request.selections, request.measures, request.enteredUnits);

    if (hasBlockingError(issues)) {
      throw AppError.validationFailed(message('error.line.cannot_be_made'), {
        lineNo,
        /* Keys and params, not a Thai sentence — see the same map in `quotes/pricing.ts`. */
        issues: issues.map((issue) => ({
          ruleId: issue.ruleId,
          severity: issue.severity,
          message: encodeCoreMessage(issue.message) as unknown as JsonValue,
        })),
      });
    }

    const price = calcPrice(entry.product, request.selections, request.measures, request.qty);
    const skuCode = buildSkuCode(entry.product, request.selections);

    productVersionIds.add(entry.productVersionId);

    computed.push({
      lineId: line.quoteLineId,
      seq: lineNo,
      qty: request.qty,
      computedTotalThbMinor: price.totalMinor,
      isVatApplicable: line.isVatApplicable,
    });

    lines.push({
      lineNo,
      productId: wire.productId,
      productVersionId: entry.productVersionId,
      documentHash: entry.documentHash,
      skuCode,
      configHash: configHash(skuCode, request.measures),
      nameTh: entry.product.nameTh,
      selections: { ...request.selections },
      measures: Object.fromEntries(
        Object.entries(request.measures).map(([code, um]) => [code, encodeUm(um)]),
      ),
      qty: request.qty,
      /* Replaced below with the effective figure. Both halves are on the frozen line. */
      netMinor: encodeThb(price.totalMinor),
      computedNetMinor: encodeThb(price.totalMinor),
      override: null,
      isVatApplicable: line.isVatApplicable,
      customerDescriptionTh: line.customerDescriptionTh,
      price: encodePriceBreakdown(price),
    });
  });

  /*
   * ⭐ The effective money — `applyOverrides`, and not a second cascade written here.
   *
   * VAT is still computed once over the taxable subtotal and not per line (plan 4.3(ข)): that
   * rule lives inside `applyOverrides`, which is the *only* implementation of it, and this
   * function reaching for `fromNet` itself is how the invoice and the quote screen would come
   * to foot to two different figures. The inputs are the prices `calcPrice` produced a few
   * lines above — never the ones stored on `quote_lines` — so a pinned document is always
   * today's machine layer plus the promises made against it.
   */
  const charges: ChargeLine[] = params.charges.map((charge) => ({
    lineId: charge.quoteLineId,
    seq: charge.seq,
    chargeTotalThbMinor: charge.netMinor,
    isVatApplicable: charge.isVatApplicable,
  }));

  const effective = applyOverrides({
    computed,
    charges,
    overrides: params.overrides,
    vat: params.vat,
    computedLeadTimeDays: params.leadTimeDays,
  });

  /*
   * Reachable only if the write path let it through, and it must not become a contract:
   * `assertCoherent` refuses it on every quote write, so arriving here means somebody wrote
   * the rows another way.
   */
  if (effective.grandOverrideBelowExemptCharges) {
    throw AppError.validationFailed(
      'ยอดรวมที่กำหนดไว้ต่ำกว่าค่าบริการที่ไม่คิดภาษีรวมกัน — ต้องแก้ยอดรวมหรือค่าบริการก่อน',
      { reason: 'grand_total_below_exempt_charges' },
    );
  }

  const effectiveByLineId = new Map(effective.lines.map((line) => [line.lineId, line]));
  const provenanceByOverrideId = new Map(
    params.overrides.map((override) => [override.id, documentOverrideWire(override)]),
  );

  const frozenLines = lines.map((line, index) => {
    const source = params.lines[index];
    if (source === undefined) throw new Error('orders: priced line has no quote line behind it');
    const applied = effectiveByLineId.get(source.quoteLineId);
    if (applied === undefined) throw new Error('orders: priced line was not priced');

    return {
      ...line,
      netMinor: encodeThb(applied.effectiveTotalThbMinor),
      override:
        applied.overrideId === null
          ? null
          : provenanceByOverrideId.get(applied.overrideId) ?? null,
    };
  });

  const frozenCharges = params.charges.map((charge) => {
    const applied = effectiveByLineId.get(charge.quoteLineId);
    if (applied === undefined) throw new Error('orders: charge line was not priced');

    return {
      lineNo: charge.seq,
      customerDescriptionTh: charge.customerDescriptionTh,
      netMinor: encodeThb(applied.effectiveTotalThbMinor),
      isVatApplicable: charge.isVatApplicable,
      override:
        applied.overrideId === null
          ? null
          : provenanceByOverrideId.get(applied.overrideId) ?? null,
    };
  });

  const documentPromise = params.overrides.find((override) => override.anchor === 'grand_total');

  const document = withHash({
    documentSchemaVersion: ORDER_DOCUMENT_SCHEMA_VERSION,
    revision: params.revision,
    documentHash: '',
    currency: 'THB',
    /*
     * ⭐ PINNED, AND NARROWED HERE RATHER THAN NEGOTIATED LATER — plan 10.6 + 7.13.
     *
     * > เอกสาร ใช้ภาษาที่ตรึงตอน `submit_for_payment` … เอกสารที่พิมพ์ซ้ำแล้วได้คนละภาษา
     * > คือเอกสารที่ใช้อ้างอิงไม่ได้
     *
     * The locale joins the other seven things pinned in this transaction rather than
     * becoming an eighth mechanism — it is inside the document, so `documentHash` covers it
     * and a reprint in a different language would be a different hash, which is the property
     * that makes the pin worth anything.
     *
     * `pinnedLocaleOf` is what makes the stored value one of the eight. Before it, `locale`
     * was written through unchecked: a client sending `"locale":"klingon"` pinned `klingon`,
     * and the reprint two years later would have had to invent a rule for it on the spot.
     * Now the invention happens once, here, at the moment there is still a person to ask.
     */
    pinnedLocale: pinnedLocaleOf(params.locale),
    pinnedCoreVersion: params.coreVersion,
    vat: { rateBp: params.vat.rateBp, treatment: params.vat.treatment },
    lines: frozenLines,
    charges: frozenCharges,
    documentOverride:
      documentPromise === undefined ? null : documentOverrideWire(documentPromise),
    netThbMinor: encodeThb(effective.money.netThbMinor),
    vatThbMinor: encodeThb(effective.money.vatThbMinor),
    grandTotalThbMinor: encodeThb(effective.money.grandTotalThbMinor),
    leadTimeDays: effective.effectiveLeadTimeDays,
  });

  const taxed = {
    netMinor: effective.money.netThbMinor,
    vatMinor: effective.money.vatThbMinor,
    grandMinor: effective.money.grandTotalThbMinor,
  };

  return {
    document,
    documentHash: document.documentHash,
    netThbMinor: taxed.netMinor,
    vatThbMinor: taxed.vatMinor,
    grandTotalThbMinor: taxed.grandMinor,
    productVersionIds: [...productVersionIds],
  };
}

/**
 * The document's own digest, over everything except the digest.
 *
 * Canonicalised first, for the reason `packages/db/src/hash.ts` gives: `jsonb` stores a
 * parsed value, not a document, so hashing what comes back out of Postgres would disagree
 * with hashing what went in — and the mismatch would look exactly like the tampering the
 * hash exists to detect. `documentHash: ''` is excluded by being overwritten, not by being
 * deleted, so the field order of the object that is hashed cannot depend on how it was built.
 */
export function withHash(document: OrderDocumentWire): OrderDocumentWire {
  const { documentHash: _ignored, ...rest } = document;
  const hash = createHash('sha256').update(canonicalJson(rest)).digest('hex');
  return { ...document, documentHash: hash };
}

export const orderDocumentHash = (document: OrderDocumentWire): string =>
  withHash(document).documentHash;

/** The provenance half of a promise, frozen. `applyOverrides` reads the arithmetic half. */
const documentOverrideWire = (override: QuoteDocumentOverride): OrderDocumentOverrideWire => ({
  overrideId: override.id,
  enteredAs: override.enteredAs,
  enteredValueText: override.enteredValueText,
  reasonCode: override.reasonCode,
  setByUserId: override.setByUserId,
  setByUserName: override.setByUserName,
});

/* ------------------------------------------------------------------ *
 * The re-approval guard — plan 7.2
 * ------------------------------------------------------------------ */

export interface ScopeViolation {
  readonly lineNo: number;
  readonly field: string;
  readonly messageTh: string;
}

/**
 * ⚠️ THE GUARD PLAN 7.2 SAYS THE DESIGNER NEARLY PUT IN BACKWARDS. ⚠️
 *
 * The rejected proposal was "the recomputed price must not exceed the original contract".
 * The reviewer's objection is the whole of this function's reason to exist:
 *
 * > A design that cannot be manufactured is usually fixed with something **more expensive** —
 * > a thicker profile, double glazing, another lock point. That guard would block exactly the
 * > case it was built for.
 *
 * So the guard is on **scope** and never on price. Three facts, and nothing else:
 *
 *   * the same product on each line — a different product is a different sale;
 *   * the opening no larger — a bigger hole in the customer's wall is not a repair;
 *   * no lines the customer did not ask for, and no larger quantity.
 *
 * Everything else may change, including every price, and the difference is recorded as
 * `absorbed_delta_thb_minor` so the cost of quality is visible rather than absorbed
 * invisibly. When the difference is too large to absorb, the answer is not this transition
 * at all: the order is superseded and the customer approves a new one (plan 7.2, and the
 * `redesign → superseded` row in the transition table).
 *
 * Measures are compared in canonical micrometres, which is the reason plan 4.1 made them
 * integers: comparing "3.2 m" with "320 cm" as display strings is a comparison that passes
 * for the wrong reason.
 */
export function scopeViolations(
  contracted: OrderDocumentWire,
  proposed: OrderDocumentWire,
): readonly ScopeViolation[] {
  const violations: ScopeViolation[] = [];
  const byLineNo = new Map(contracted.lines.map((line) => [line.lineNo, line]));

  for (const line of proposed.lines) {
    const before = byLineNo.get(line.lineNo);

    if (!before) {
      violations.push({
        lineNo: line.lineNo,
        field: 'lineNo',
        messageTh: 'มีรายการที่ลูกค้าไม่ได้สั่งเพิ่มเข้ามา',
      });
      continue;
    }

    if (before.productId !== line.productId) {
      violations.push({
        lineNo: line.lineNo,
        field: 'productId',
        messageTh: `สินค้าเปลี่ยนจาก ${before.productId} เป็น ${line.productId}`,
      });
    }

    if (line.qty > before.qty) {
      violations.push({
        lineNo: line.lineNo,
        field: 'qty',
        messageTh: `จำนวนเพิ่มจาก ${String(before.qty)} เป็น ${String(line.qty)}`,
      });
    }

    for (const [code, measure] of Object.entries(line.measures)) {
      const previous = before.measures[code];

      if (previous === undefined) {
        violations.push({
          lineNo: line.lineNo,
          field: `measures.${code}`,
          messageTh: `มีขนาด ${code} ที่ไม่ได้อยู่ในสัญญาเดิม`,
        });
        continue;
      }

      if (toBigInt(measure) > toBigInt(previous)) {
        violations.push({
          lineNo: line.lineNo,
          field: `measures.${code}`,
          messageTh: `ช่องเปิด ${code} ใหญ่ขึ้นจากที่ตกลงไว้`,
        });
      }
    }
  }

  return violations;
}

/** The same guard, as the refusal the transition takes. */
export function assertScopeUnchanged(
  contracted: OrderDocumentWire,
  proposed: OrderDocumentWire,
): void {
  const violations = scopeViolations(contracted, proposed);
  if (violations.length === 0) return;

  throw AppError.validationFailed(
    'แบบที่แก้แล้วเกินขอบเขตของสัญญาเดิม — ต้องออกใบใหม่ให้ลูกค้าอนุมัติแทน',
    { violations: violations.map((violation) => ({ ...violation })) },
  );
}

/**
 * What the company is absorbing, in satang — plan 7.2's `absorbed_delta`.
 *
 * Derived by subtraction and never entered by a human: it is the difference between two
 * documents the server already holds, and a typed figure would be a second answer to a
 * question arithmetic has settled. Negative is legal and means the fix was cheaper; recording
 * it as a signed number is what makes the cost-of-quality report add up over a year rather
 * than count only the expensive half.
 */
export function absorbedDeltaMinor(
  contracted: OrderDocumentWire,
  proposed: OrderDocumentWire,
): bigint {
  return toBigInt(proposed.grandTotalThbMinor) - toBigInt(contracted.grandTotalThbMinor);
}
