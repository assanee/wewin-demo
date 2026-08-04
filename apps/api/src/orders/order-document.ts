import { createHash } from 'node:crypto';

import { calcPrice } from '@wewin/core/pricing';
import { buildSkuCode } from '@wewin/core/sku';
import { configHash } from '@wewin/core/hash';
import { hasBlockingError, validate } from '@wewin/core/validation';
import { fromNet, type TaxRule } from '@wewin/core/vat';
import type { Product } from '@wewin/core';
import { canonicalJson } from '@wewin/db/hash';
import { encodeUm } from '@wewin/contract/measure';
import { encodePriceBreakdown, toPriceRequest } from '@wewin/contract/pricing';
import { toBigInt } from '@wewin/contract/exact';
import {
  ORDER_DOCUMENT_SCHEMA_VERSION,
  encodeThb,
  type OrderDocumentLineWire,
  type OrderDocumentWire,
  type OrderLineRequestWire,
} from '@wewin/contract/order';
import { catalogStaleBody } from '@wewin/contract/errors';

import { AppError, type JsonValue } from '../common/errors/app-error';
import { CATALOG_STALE_MESSAGE_TH } from './pg-errors';

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

export interface PriceOrderParams {
  readonly lines: readonly OrderLineRequestWire[];
  /** `productId` → what is published right now. */
  readonly catalog: ReadonlyMap<string, CatalogEntry>;
  readonly vat: TaxRule;
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
  let netMinor = 0n;

  params.lines.forEach((wire, index) => {
    const lineNo = index + 1;
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
      throw AppError.conflict(CATALOG_STALE_MESSAGE_TH, {
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
      throw AppError.validationFailed('รายการนี้ผลิตไม่ได้ตามที่กำหนดไว้', {
        lineNo,
        issues: issues.map((issue) => ({
          ruleId: issue.ruleId,
          severity: issue.severity,
          messageTh: issue.messageTh,
        })),
      });
    }

    const price = calcPrice(entry.product, request.selections, request.measures, request.qty);
    const skuCode = buildSkuCode(entry.product, request.selections);

    netMinor += price.totalMinor;
    productVersionIds.add(entry.productVersionId);

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
      netMinor: encodeThb(price.totalMinor),
      price: encodePriceBreakdown(price),
    });
  });

  /*
   * VAT is computed once, over the sum of the line totals, and not per line. Plan 4.3(ข)'s
   * rule is one rounding point per layer: rounding the tax on each line and adding those up
   * gives a different figure from taxing the sum, and the invoice has to foot against the
   * single `grand_total` every instalment, forfeit and refund references.
   */
  const taxed = fromNet(netMinor, params.vat);

  const document = withHash({
    documentSchemaVersion: ORDER_DOCUMENT_SCHEMA_VERSION,
    revision: params.revision,
    documentHash: '',
    currency: 'THB',
    pinnedLocale: params.locale,
    pinnedCoreVersion: params.coreVersion,
    vat: { rateBp: params.vat.rateBp, treatment: params.vat.treatment },
    lines,
    netThbMinor: encodeThb(taxed.netMinor),
    vatThbMinor: encodeThb(taxed.vatMinor),
    grandTotalThbMinor: encodeThb(taxed.grandMinor),
  });

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
