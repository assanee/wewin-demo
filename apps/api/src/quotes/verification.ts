import type { PublishedProduct } from '../catalog/catalog.repository';
import { encodeThb } from '@wewin/contract/order';
import type { StaleBaselineWire } from '@wewin/contract/quote';

import { integrityAlarm } from './errors';
import { decodeStoredMeasures, decodeStoredSelections, repriceStoredLine } from './pricing';
import type { QuoteLineRow, QuoteOverrideRow } from './quote.repository';

/**
 * Re-verifying every promise against today's catalogue — plan 7.9(จ).
 *
 * > **ตอน pin ต้อง re-verify ทุก override ว่า baseline ยังตรง** — ถ้ามีการ publish แคตตาล็อกคั่น
 * > ให้บล็อกการ submit และบังคับยืนยันราคาใหม่ทีละบรรทัด
 * >
 * > ลดราคา ฿18,432 → ฿17,000 ตอนบ่าย · ทีมอื่น publish ราคาใหม่ ฿20,000 ตอนเย็น · ถ้าไม่
 * > re-verify ระบบยังโชว์ ฿17,000 โดยไม่มีใครรู้ว่าตอนนี้มันคือส่วนลด 15% ไม่ใช่ 7.8%
 *
 * ── The two outcomes are not the same kind of thing, and this is the whole file ──
 *
 * A stored baseline can stop matching for exactly two reasons, and telling them apart is the
 * point of this pass rather than a refinement of it:
 *
 *   **The catalogue moved.** The line is pinned to a product version that is no longer the
 *   published one. Somebody published a new price under the salesperson. This is a `409` and
 *   a human decision per line — re-promise, or let the new price stand.
 *
 *   **The catalogue did not move.** The pinned version is still the published one, its frozen
 *   document is the same document, and `calcPrice` returns a different number from it than
 *   the one stored on the line. Nothing in the data changed; the *code* did. Plan 7.9(จ) is
 *   explicit that this is an **integrity alarm and not a 409**, and the reason is the shape
 *   of the recovery: there is no client action, no retry and no reload that helps, and
 *   answering 409 would tell a salesperson to reload their way out of a pricing regression.
 *
 * The second case is the one worth being loud about. Every frozen `order_documents` row in
 * the system was produced by `calcPrice` from a frozen catalogue document; if that pair stops
 * being reproducible, every contract this company has signed becomes unverifiable at once,
 * and the way anybody would find out is a line in a log.
 */

export interface VerificationInput {
  readonly orderId: string;
  readonly lines: readonly QuoteLineRow[];
  readonly liveOverrides: readonly QuoteOverrideRow[];
  /**
   * The document total as it stands **now**, with the line overrides applied and the
   * `grand_total` override removed — `applyOverrides`' figure, computed by the caller.
   *
   * This is what a live `grand_total` override's stored baseline is compared against. It is
   * passed in rather than recomputed here because the arithmetic is `applyOverrides`' and this
   * module is the comparison; a second cascade in this file would be the same mechanism twice.
   */
  readonly documentBaselineThbMinor: bigint;
  /** What is published right now, by product version id. `CatalogRepository.findAll()`. */
  readonly publishedByVersionId: ReadonlyMap<string, PublishedProduct>;
  /** `product_version_id` → `product_id`, for the versions that are no longer published. */
  readonly productIdByVersionId: ReadonlyMap<string, string>;
  /** What is published right now, by product id — the successor of an archived version. */
  readonly publishedByProductId: ReadonlyMap<string, PublishedProduct>;
}

/**
 * Every line that stops this quote from going out, with enough on each one to act.
 *
 * Returns rather than throws, because the same computation feeds two callers with two
 * answers: the editor's `GET` renders the list as a warning strip, and the submit gate turns
 * a non-empty list into a 409. A function that threw could only serve the second.
 *
 * The integrity alarm *is* thrown, because it has no second reading.
 */
export function verifyBaselines(input: VerificationInput): readonly StaleBaselineWire[] {
  const overrideByLineId = new Map<string, QuoteOverrideRow>();
  for (const override of input.liveOverrides) {
    if (override.anchor === 'line_total' && override.quoteLineId !== null) {
      overrideByLineId.set(override.quoteLineId, override);
    }
  }

  const stale: StaleBaselineWire[] = [];

  for (const line of input.lines) {
    /* A free-form line has no catalogue behind it and cannot go stale. */
    if (line.kind !== 'catalog') continue;
    if (line.productVersionId === null || line.computedTotalThbMinor === null) continue;

    const selections = decodeStoredSelections(line.selections);
    const measures = decodeStoredMeasures(line.measures);
    const published = input.publishedByVersionId.get(line.productVersionId);

    if (published !== undefined) {
      /*
       * The pinned version is still the published one, so the document this line was priced
       * from is byte-for-byte the document in front of us. Anything but agreement here is the
       * alarm — and it is checked on every line, not only the ones carrying a promise,
       * because a pricing regression does not care whether anybody negotiated.
       */
      const recomputed = repriceStoredLine(published.product, selections, measures, line.qty);

      if (recomputed !== null && recomputed !== line.computedTotalThbMinor) {
        throw integrityAlarm({
          orderId: input.orderId,
          quoteLineId: line.id,
          productVersionId: line.productVersionId,
          stored: line.computedTotalThbMinor,
          recomputed,
        });
      }
      continue;
    }

    /* ── the catalogue moved under this line ──────────────────────────── */

    const productId = input.productIdByVersionId.get(line.productVersionId);
    const successor = productId === undefined ? undefined : input.publishedByProductId.get(productId);
    const currentComputed =
      successor === undefined
        ? null
        : repriceStoredLine(successor.product, selections, measures, line.qty);

    const override = overrideByLineId.get(line.id);

    stale.push({
      kind: override === undefined ? 'line_needs_repricing' : 'promise_baseline_moved',
      quoteLineId: line.id,
      seq: line.seq,
      overrideId: override?.id ?? null,
      pinnedProductVersionId: line.productVersionId,
      publishedProductVersionId: successor?.productVersionId ?? null,
      promisedThbMinor:
        override?.overrideThbMinor === undefined || override.overrideThbMinor === null
          ? null
          : encodeThb(override.overrideThbMinor),
      baselineThbMinor: encodeThb(line.computedTotalThbMinor),
      currentComputedThbMinor: currentComputed === null ? null : encodeThb(currentComputed),
    });
  }

  /* ── ⭐ and the anchor this pass did not check for a whole round ────── */

  stale.push(...documentBaseline(input));

  return stale;
}

/**
 * ⭐ The `grand_total` promise, re-verified against the document it was made over.
 *
 * This loop iterated **lines** and nothing else, so a document-level promise was never checked
 * at all — and its stored baseline is by definition a figure about every line at once. Two red
 * teams walked through the gap from opposite ends, and `POST …/quote/verification` returned 200
 * on both exploited quotes:
 *
 *   add a line under a ฿7,495.84 document promise and the customer is billed ฿7,495.84 against
 *   a ฿66,562.56 document — 88.7% off, measured by the gate as ฿0.00, approvals required: none.
 *
 *   remove the only line under one and the quote is an invoice for ฿14,291.68 with nothing on
 *   it, carrying ฿934.97 of VAT on ฿0.00 of goods.
 *
 * `0018_quote_document_freeze.sql` now refuses the writes that produce those states, which is
 * the primary defence — a state that cannot be written does not need to be detected. This is the
 * second one, and it is not redundant: the trigger enforces *structure* (the inputs do not move)
 * while this enforces *arithmetic* (the figure still means what it said), and the arithmetic can
 * drift for a reason no trigger can see. A catalogue publish moves a line's computed total
 * without any write to `quote_lines` at all — which is precisely plan 7.9(จ)'s afternoon-and-
 * evening story, one level up from the line it tells it about.
 *
 * ── Why this is a 409 and not the integrity alarm ────────────────────────────────
 *
 * The line loop above already separated the two: a line whose pinned version is still published
 * and whose price moved anyway is `core` changing under a frozen document, and it throws. By the
 * time control reaches here, every line has passed that test — so a document baseline that has
 * moved has moved for a reason in the *data*, and a person can act on it: re-promise the total,
 * or withdraw it. That is the 409's whole definition.
 */
function documentBaseline(input: VerificationInput): readonly StaleBaselineWire[] {
  const promise = input.liveOverrides.find((override) => override.anchor === 'grand_total');
  if (promise === undefined || promise.computedThbMinor === null) return [];
  if (promise.computedThbMinor === input.documentBaselineThbMinor) return [];

  return [
    {
      kind: 'document_baseline_moved',
      /*
       * A document promise hangs off no line, and the wire says so rather than naming one at
       * random. The UI's recovery for this row is the whole-document one — confirm the total
       * again or withdraw it — and a `quoteLineId` would send somebody to the wrong screen.
       */
      quoteLineId: null,
      seq: null,
      overrideId: promise.id,
      pinnedProductVersionId: null,
      publishedProductVersionId: null,
      promisedThbMinor:
        promise.overrideThbMinor === null ? null : encodeThb(promise.overrideThbMinor),
      baselineThbMinor: encodeThb(promise.computedThbMinor),
      currentComputedThbMinor: encodeThb(input.documentBaselineThbMinor),
    },
  ];
}
