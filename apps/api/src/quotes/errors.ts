import { catalogStaleBody } from '@wewin/contract/errors';
import type { CatalogRef, ProductDocument } from '@wewin/contract';
import type { StaleBaselineWire } from '@wewin/contract/quote';

import { AppError, type JsonValue } from '../common/errors/app-error';

/**
 * The refusals — plan 7.9(จ), where the 409 changes shape.
 *
 * ── What the 409 used to be, and why it could not stay ───────────────────────────
 *
 * Risk 1 was mitigated by *"the api recomputes and 409s on mismatch"*. Once a human may set
 * any number that mitigation is gone: there is no computable answer to "is this total
 * correct?", so there is nothing for a recomputation to disagree with. Plan 7.9 replaces the
 * question with **"where did this number come from, and was that person allowed?"**, and this
 * file is the small part of that which is a refusal.
 *
 * ── Two 409s, because a client can only recover from one of them ─────────────────
 *
 *   `CATALOG_STALE`  a version was published under the salesperson while they typed. The
 *                    client re-renders from the document in the body and asks again. This is
 *                    the same protocol `/price` and `POST /orders` already speak, and it uses
 *                    the same body shape rather than a second one — plan 5 point 5, and
 *                    `errors.ts`'s own note that a staleness protocol which differs between
 *                    endpoints is a staleness protocol that is wrong on one of them.
 *
 *   `QUOTE_STALE`    somebody else edited this quote. The client reloads the quote. There is
 *                    no document to hand back that would help, because what changed is not
 *                    the catalogue.
 *
 * Collapsing them into one code would leave a client with one recovery for two situations,
 * and it would pick the wrong one half the time: re-fetching the product document does
 * nothing about a colleague who just discounted line 3, and reloading the quote does nothing
 * about a version that was archived.
 *
 * ── And one thing that is deliberately NOT a 409 ─────────────────────────────────
 *
 * A stored `computed_thb_minor` that no longer matches what `calcPrice` produces **from the
 * same pinned product version** is an integrity alarm. Plan 7.9(จ): it means `core` changed
 * behaviour underneath a pinned document, which no client can recover from and no retry can
 * fix. It is raised as an ordinary `Error` so that `AllExceptionsFilter` logs it with a stack
 * and answers 500 — the caller did nothing wrong and there is nothing for them to do.
 */

export const QUOTE_STALE = 'quote_stale';
export const QUOTE_BASELINES_STALE = 'quote_baselines_stale';

export const CATALOG_STALE_MESSAGE_TH =
  'แคตตาล็อกมีการเผยแพร่เวอร์ชันใหม่ระหว่างที่คุณกำลังแก้ไข — กรุณาตรวจสอบราคาปัจจุบันอีกครั้ง';

/**
 * The quote moved under this request.
 *
 * Carries the token the server holds so a client can tell "I am behind" from "my request was
 * malformed", and carries no quote: the recovery is a `GET`, and inlining the whole document
 * into every conflict body would make the losing half of a two-editor race the most expensive
 * response in the API.
 */
export function quoteStale(sent: string, current: string): AppError {
  return AppError.conflict('ใบเสนอราคานี้ถูกแก้ไขโดยคนอื่นระหว่างที่คุณกำลังทำรายการ — กรุณาโหลดใหม่', {
    reason: QUOTE_STALE,
    sent,
    current,
  });
}

/** A published version moved under the line being edited. The same body every other endpoint sends. */
export function catalogStale(sent: CatalogRef, current: ProductDocument): AppError {
  return AppError.conflict(CATALOG_STALE_MESSAGE_TH, {
    /*
     * `Exact` is opaque on purpose (contract/exact.ts): it exposes no readable member, so it
     * is not structurally a `JsonValue` even though it serialises as one. The assertion is
     * the same one `order-document.ts` performs, in the same place — on the way out.
     */
    stale: catalogStaleBody(sent, current) as unknown as JsonValue,
  });
}

/**
 * ⭐ The submit gate — plan 7.9(จ)'s *"ตอน pin ต้อง re-verify ทุก override ว่า baseline ยังตรง"*.
 *
 * > ลดราคา ฿18,432 → ฿17,000 ตอนบ่าย · ทีมอื่น publish ราคาใหม่ ฿20,000 ตอนเย็น · ถ้าไม่
 * > re-verify ระบบยังโชว์ ฿17,000 โดยไม่มีใครรู้ว่าตอนนี้มันคือส่วนลด 15% ไม่ใช่ 7.8%
 *
 * Every affected line travels in the body with the promise, the baseline it was made against
 * and today's figure, because the recovery is *per line* and a person has to look at each one:
 * revoke the override and let the new price stand, or promise the same money again against
 * the new baseline. A single "something is stale" would send them to a screen with no idea
 * which of eleven lines to read.
 */
export function baselinesStale(stale: readonly StaleBaselineWire[]): AppError {
  return AppError.conflict(
    'แคตตาล็อกเปลี่ยนหลังจากที่ตกลงราคาไว้ — ต้องยืนยันราคาที่ตกลงใหม่ทีละรายการก่อนส่งใบเสนอราคา',
    {
      reason: QUOTE_BASELINES_STALE,
      /* `Exact` again: opaque in TypeScript, an object on the wire. */
      lines: stale as unknown as JsonValue,
    },
  );
}

/**
 * `core` changed underneath a pinned document. Not a 409 — see the note at the top.
 *
 * A plain `Error` and not an `AppError`, deliberately: an `AppError` is a sentence for the
 * caller, and this one has no audience but the on-call engineer. `AllExceptionsFilter` logs
 * it with its stack and answers the client a request id.
 */
export function integrityAlarm(detail: {
  readonly orderId: string;
  readonly quoteLineId: string;
  readonly productVersionId: string;
  readonly stored: bigint;
  readonly recomputed: bigint;
}): Error {
  return new Error(
    `quotes: INTEGRITY — order ${detail.orderId} line ${detail.quoteLineId} was priced at ` +
      `${detail.stored.toString()} against product version ${detail.productVersionId}, and calcPrice ` +
      `now returns ${detail.recomputed.toString()} from that same frozen document. The catalogue did ` +
      `not move; the pricing code did. Do not resolve this by rewriting the row.`,
  );
}
