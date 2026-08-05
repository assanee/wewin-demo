import { encodeThb } from '@wewin/contract/order';
import type {
  QuoteLineWire,
  QuoteMoneyWire,
  QuoteOverrideWire,
  QuoteWire,
  StaleBaselineWire,
} from '@wewin/contract/quote';
import type { TaxRule } from '@wewin/core/vat';

import type { EffectiveMoney, EffectiveQuote } from './overrides';
import { decodeStoredSelections, encodeStoredMeasures } from './pricing';
import type { QuoteLineRow, QuoteOverrideRow } from './quote.repository';

/**
 * The quote, on the wire — and the one decision in this file is who may see what.
 *
 * ── Two audiences, one nested block, and why not optional fields ─────────────────
 *
 * `encodeEvent` in the orders module already splits staff from customer, and its reasoning
 * carries: the audience is derived from a permission the caller demonstrably holds, never
 * from a flag on the request, so there is no way to ask for the staff view without holding
 * it. What is different here is what gets hidden, and it is worth naming.
 *
 * A concession is a record of a negotiation. `reasonCode`, `noteTh` and `computedThbMinor`
 * together say *"we were willing to go to ฿17,000, and here is what we thought it was worth"*,
 * which is the company's position in a negotiation that may not be over. The
 * customer's entitlement is the price and the frozen document; it is not the internal record
 * of how the price was arrived at. That is the mirror image of plan 7.9(ค)'s ⚠️ — sales prose
 * must not reach the factory, and sales' reasoning must not reach the customer — and of the
 * open question `orders.controller.ts` records about `reason` on a cancellation being visible.
 *
 * It is one nested object rather than a handful of optional fields so that "did I remember to
 * strip this?" is one question with one answer. A field added to `QuoteSalesViewWire` is
 * hidden by construction; a field added beside `lines` is exposed by construction, and the
 * difference is which mistake is the easy one.
 */

export type QuoteAudience = 'sales' | 'customer';

export interface EncodeQuoteInput {
  readonly orderId: string;
  readonly quoteRevision: string;
  readonly lines: readonly QuoteLineRow[];
  readonly liveOverrides: readonly QuoteOverrideRow[];
  readonly effective: EffectiveQuote;
  /**
   * `measureMargin`'s figure, and **only** ever that one.
   *
   * `applyOverrides` used to produce a second one by subtraction and this encoder read it. The
   * two disagreed in three ways — see the header of `overrides.ts` — and the disagreement was
   * invisible on screen, because the number the editor rendered was not the number the submit
   * gate would compare against a ceiling. There is one measurement now, it is the authority
   * module's, and it arrives here already computed rather than being derived a second time.
   */
  readonly marginConcessionThbMinor: bigint;
  /** Where the caller's `documentHash` for each line comes from — see `QuoteLineWire`. */
  readonly documentHashByVersionId: ReadonlyMap<string, string>;
  /**
   * …and its other half. Both maps are keyed by product version and both are built from the
   * *published* index, so a line whose version has been archived gets `null` for each — one
   * state, not two, and the pair is either usable together or not at all.
   */
  readonly productIdByVersionId: ReadonlyMap<string, string>;
  readonly vat: TaxRule;
  readonly staleBaselines: readonly StaleBaselineWire[];
  readonly audience: QuoteAudience;
}

export function encodeQuote(input: EncodeQuoteInput): QuoteWire {
  const effectiveByLineId = new Map(
    input.effective.lines.map((line) => [line.lineId, line.effectiveTotalThbMinor]),
  );

  return {
    orderId: input.orderId,
    quoteRevision: input.quoteRevision,
    currency: 'THB',
    lines: input.lines.map((line) =>
      encodeLine(line, {
        effectiveByLineId,
        documentHashByVersionId: input.documentHashByVersionId,
        productIdByVersionId: input.productIdByVersionId,
        audience: input.audience,
      }),
    ),
    money: encodeMoney(input.effective.money, input.vat),
    computedLeadTimeDays: input.effective.computedLeadTimeDays,
    effectiveLeadTimeDays: input.effective.effectiveLeadTimeDays,
    sales:
      input.audience === 'customer'
        ? null
        : {
            overrides: input.liveOverrides.map(encodeOverride),
            marginConcessionThbMinor: encodeThb(input.marginConcessionThbMinor),
            baselineGrandTotalThbMinor: encodeThb(input.effective.baseline.grandTotalThbMinor),
            staleBaselines: input.staleBaselines,
          },
  };
}

function encodeLine(
  line: QuoteLineRow,
  context: {
    readonly effectiveByLineId: ReadonlyMap<string, bigint>;
    readonly documentHashByVersionId: ReadonlyMap<string, string>;
    readonly productIdByVersionId: ReadonlyMap<string, string>;
    readonly audience: QuoteAudience;
  },
): QuoteLineWire {
  const { effectiveByLineId, documentHashByVersionId, productIdByVersionId, audience } = context;
  /*
   * `?? 0n` is unreachable and is not a fallback: `applyOverrides` is handed exactly these
   * rows and returns one effective line per input line. It is written as a lookup rather than
   * a zip so that the two lists cannot silently pair up by position after a sort — which is
   * the bug this shape exists to make impossible, not the one `0n` would paper over.
   */
  const effective = effectiveByLineId.get(line.id) ?? 0n;

  /*
   * ⚠️ THE PER-LINE SPLIT IS A CONCESSION-SHAPED FACT AND IT WAS SERVED TO CUSTOMERS.
   *
   * This encoder was audience-independent, so a customer's own `GET` carried
   * `computedTotalThbMinor` *and* `effectiveTotalThbMinor` on every line. `sales` was stripped
   * and the per-line concession was one subtraction away — which contradicts this file's own
   * stated rule about not handing over the company's position in a negotiation that may not be
   * over. A customer sees what the line costs; that it once cost more is not their record.
   *
   * `null` and not "the same figure twice": a client that could not tell the two apart would
   * render "no discount" as confidently as it renders a real one.
   */
  const showsProvenance = audience === 'sales';

  return {
    id: line.id,
    seq: line.seq,
    kind: line.kind,
    productVersionId: line.productVersionId,
    /*
     * The frozen document this line is pinned against, so the editor can build a well-formed
     * `CatalogRef` from the quote it was served. Without it the dashboard could not construct a
     * `revision` request at all — qty and options were read-only on the screen for exactly this
     * reason — and any hash it supplied from elsewhere would be a guess at the pinned document,
     * which is the staleness `CatalogRef` exists to catch.
     *
     * Null when the pinned version is no longer published, which is precisely the case
     * `staleBaselines` reports: there is no current handle, and the recovery is per line.
     */
    documentHash:
      line.productVersionId === null
        ? null
        : documentHashByVersionId.get(line.productVersionId) ?? null,
    /*
     * The other half of the same handle. `reviseLine` compares this against the id it resolves
     * from the line's own version and refuses a mismatch, so publishing it hands a client the
     * value the server is going to insist on rather than an opportunity — the request cannot
     * name a different product by naming a different id here.
     */
    productId:
      line.productVersionId === null
        ? null
        : productIdByVersionId.get(line.productVersionId) ?? null,
    skuCode: line.skuCode,
    selections: line.selections === null ? null : decodeStoredSelections(line.selections),
    measures: line.measures === null ? null : encodeStoredMeasures(line.measures),
    qty: line.qty,
    customerDescriptionTh: line.customerDescriptionTh,
    isVatApplicable: line.isVatApplicable,
    computedTotalThbMinor:
      !showsProvenance || line.computedTotalThbMinor === null
        ? null
        : encodeThb(line.computedTotalThbMinor),
    chargeTotalThbMinor:
      !showsProvenance || line.chargeTotalThbMinor === null
        ? null
        : encodeThb(line.chargeTotalThbMinor),
    effectiveTotalThbMinor: encodeThb(effective),
  };
}

const encodeOverride = (override: QuoteOverrideRow): QuoteOverrideWire => ({
  id: override.id,
  /*
   * The name and not only the id. Plan 7.9 says the whole feature exists to answer "where did
   * this number come from, and was that person allowed?", and a truncated uuid answers the
   * first half in a way nobody can read. `ApprovalWire` already carries `requestedByName`;
   * this is the same fact on the other side of the same question.
   */
  setByUserName: override.setByUserName,
  anchor: override.anchor,
  quoteLineId: override.quoteLineId,
  computedThbMinor:
    override.computedThbMinor === null ? null : encodeThb(override.computedThbMinor),
  overrideThbMinor:
    override.overrideThbMinor === null ? null : encodeThb(override.overrideThbMinor),
  computedDays: override.computedDays,
  overrideDays: override.overrideDays,
  enteredAs: override.enteredAs,
  enteredValueText: override.enteredValueText,
  reasonCode: override.reasonCode,
  noteTh: override.noteTh,
  setByUserId: override.setByUserId,
  createdAt: override.createdAt.toISOString(),
});

const encodeMoney = (money: EffectiveMoney, vat: TaxRule): QuoteMoneyWire => ({
  netThbMinor: encodeThb(money.netThbMinor),
  taxableNetThbMinor: encodeThb(money.taxableNetThbMinor),
  exemptNetThbMinor: encodeThb(money.exemptNetThbMinor),
  vatThbMinor: encodeThb(money.vatThbMinor),
  grandTotalThbMinor: encodeThb(money.grandTotalThbMinor),
  vat: { rateBp: vat.rateBp, treatment: vat.treatment },
});
