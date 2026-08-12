import 'client-only';

import { apiJson } from '@/lib/api/client';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Authority — a different resource, a different endpoint, and a hand-narrowed shape.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ### Why these shapes are narrowed here and not imported
 *
 * The assessment lives at `GET /quotes/authority/orders/:orderId` and its types live in
 * `apps/api/src/quotes/authority/authority.contract.ts`, whose own header says why they are
 * not in `@wewin/contract` yet: *"these shapes move there when somebody builds the approver's
 * screen, and the move is a copy"*. Reaching into apps/api from an app is exactly what
 * `turbo boundaries` exists to keep from becoming normal, so the narrowing is done here — the
 * same trade `products/catalog-api.ts` makes for the option-catalogue response, written the
 * same way: narrow, never cast, and throw with the field name so `apiJson` turns it into a
 * MALFORMED with a path attached.
 *
 * **When these land in `@wewin/contract`, delete every decoder below and import the schemas.**
 *
 * ### ⚠️ Money here is a bare digit string, and that is not this folder's convention
 *
 * `@wewin/contract` sends `{"unit":"THB.satang","digits":"879100"}` precisely so a reader on
 * the far side cannot mistake satang for baht — `exact.ts` spends a page on why. These
 * endpoints send `"879100"`, which the API's own header defends as "the client widens as it
 * chooses". It is a narrower guarantee than the rest of this system gives, the difference is
 * invisible in a payload, and it is reported rather than smoothed over. `minorOf` below is the
 * one place it is widened, and it refuses anything that is not canonical digits so that a
 * malformed amount is a decode failure rather than a `NaN` in a ceiling.
 *
 * ### Why the panel fetches this instead of reading it off the quote
 *
 * `QuoteSalesViewWire.marginConcessionThbMinor` is *a figure to render* and the contract says
 * so in as many words: whether a concession is **allowed** is `approvals` and
 * `authority_limits`, and a client that decided for itself from the rendered figure would be
 * a second mechanism answering a question that already has an owner — plan 7.13's opening
 * finding, arriving one more time.
 */

export const APPROVAL_DIMENSIONS_WIRE = ['margin', 'cashflow'] as const;
export type ApprovalDimensionWire = (typeof APPROVAL_DIMENSIONS_WIRE)[number];

/**
 * The five things a measurement can conclude.
 *
 *   `nothing_conceded`     nobody gave anything away, so no authority is in play.
 *   `within_authority`     under this role's ceiling. Send it.
 *   `covered_by_approval`  over the ceiling and somebody else already said yes.
 *   `needs_approval`       over the ceiling with nobody's yes — including the fail-closed
 *                          case where the ceiling is absent because no row exists.
 *   `unassessed`           **a measurement with nobody's authority applied to it.**
 *
 * ⚠️ `unassessed` was missing from this list for as long as the list existed, and the browser is
 * what found it: `GET /quotes/approvals/:id` serves `liveConcession` through the API's
 * `bareMeasurementWire`, which is `measurementWire(measurement, undefined)` and spells the absent
 * outcome exactly that way — so the approver's detail read decoded as MALFORMED and the dialog
 * showed *"เนื้อหาไม่ตรงกับที่แดชบอร์ดรู้จัก"* instead of the request.
 *
 * It was never reachable from *this* module's own endpoint (`/quotes/authority/orders/:orderId`
 * always assesses, so every dimension carries a real outcome), which is why nothing noticed. The
 * decoder refusing rather than rendering is the behaviour this file argues for — a strict list
 * turned a silently-wrong screen into a named failure — and the fix is the value, not the
 * strictness.
 */
export const ASSESSMENT_OUTCOMES_WIRE = [
  'nothing_conceded',
  'within_authority',
  'covered_by_approval',
  'needs_approval',
  'unassessed',
] as const;
export type AssessmentOutcomeWire = (typeof ASSESSMENT_OUTCOMES_WIRE)[number];

/** Where one part of a concession came from. The audit trail, per row, behind one document figure. */
export interface ConcessionSourceView {
  readonly kind: string;
  readonly amountThbMinor: bigint;
  readonly quoteLineId: string | null;
  readonly overrideId: string | null;
  readonly reasonCode: string | null;
}

/**
 * ⭐ What the response says about **your** ceiling — and on most outcomes it says nothing.
 *
 * Mirrors `CeilingWire` (`authority.contract.ts`) field for field, and the three-way shape is
 * the point. It used to be a bare `ceilingThbMinor: bigint | null` whose `null` meant *"you
 * have no ceiling"* on one outcome and *"this outcome never looked"* on the other three —
 * a distinction this client had to rebuild from `outcome`, which it originally got wrong and
 * printed "ยังไม่มีการกำหนดเพดานอำนาจสำหรับบทบาทของคุณ" on every quote with no discount on it.
 *
 *     { known: false }                  say nothing about a ceiling
 *     { known: true, thbMinor: 500000n } your roles may concede up to ฿5,000
 *     { known: true, thbMinor: null }    your roles hold no live ceiling — fail-closed
 *
 * ⚠️ `thbMinor: 0n` is a real grant, not the absence of one.
 */
export type CeilingView =
  | { readonly known: false }
  | { readonly known: true; readonly thbMinor: bigint | null };

export interface DimensionAssessmentView {
  readonly dimension: ApprovalDimensionWire;
  readonly concessionThbMinor: bigint;
  readonly sources: readonly ConcessionSourceView[];
  readonly outcome: AssessmentOutcomeWire;
  readonly ceiling: CeilingView;
  readonly approvalId: string | null;
}

export interface AuthorityAssessmentView {
  readonly orderId: string;
  readonly orderNo: string | null;
  readonly margin: DimensionAssessmentView;
  readonly cashflow: DimensionAssessmentView;
  /** The one field this screen branches on: may this go to the customer as it stands? */
  readonly allowed: boolean;
}

/* ------------------------------------------------------------------ *
 * Decoding
 * ------------------------------------------------------------------ */

const object = (input: unknown, what: string): Record<string, unknown> => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError(`${what} is not an object`);
  }
  return input as Record<string, unknown>;
};

const str = (row: Record<string, unknown>, key: string, what: string): string => {
  const value = row[key];
  if (typeof value !== 'string') throw new TypeError(`${what}.${key} is not a string`);
  return value;
};

const nullableStr = (row: Record<string, unknown>, key: string, what: string): string | null =>
  row[key] === null ? null : str(row, key, what);

/**
 * Digits into satang.
 *
 * Canonical spelling only — the same `/^(?:0|-?[1-9][0-9]*)$/` rule `@wewin/contract/exact`
 * enforces, and for the same reason: `BigInt(' 12 ')` throws and `BigInt('012')` does not, so
 * two spellings of one amount would be one amount that compares two ways.
 */
const DIGITS = /^(?:0|-?[1-9][0-9]*)$/;

const minorOf = (row: Record<string, unknown>, key: string, what: string): bigint => {
  const value = row[key];
  if (typeof value !== 'string' || !DIGITS.test(value)) {
    throw new TypeError(`${what}.${key} is not an amount in THB minor units`);
  }
  return BigInt(value);
};

const nullableMinorOf = (
  row: Record<string, unknown>,
  key: string,
  what: string,
): bigint | null => (row[key] === null ? null : minorOf(row, key, what));

const oneOf = <T extends string>(
  values: readonly T[],
  row: Record<string, unknown>,
  key: string,
  what: string,
): T => {
  const value = row[key];
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) {
    throw new TypeError(`${what}.${key} is not one of ${values.join(', ')} (got ${String(value)})`);
  }
  return value as T;
};

/**
 * ⚠️ `known` is read, never inferred — including from the presence of `thbMinor`.
 *
 * A decoder that treated a missing `known` as `false`, or that keyed off whether `thbMinor` was
 * there, would put the two-meaning `null` straight back: it is precisely the "absent means the
 * safe-looking thing" fold that made `revokedAt` fail open one screen away. The server sends
 * this discriminator deliberately, so a response without it is malformed, not permissive.
 */
export function decodeCeiling(input: unknown, what: string): CeilingView {
  const row = object(input, what);
  const known = row['known'];
  if (typeof known !== 'boolean') throw new TypeError(`${what}.known is not a boolean`);
  if (!known) return { known: false };

  return { known: true, thbMinor: nullableMinorOf(row, 'thbMinor', what) };
}

/**
 * Exported for `components/approvals/approvals-api.ts`, which reads the same shape.
 *
 * `GET /quotes/approvals/:id` serves `DimensionAssessmentWire` for the concession as it stands
 * *now*, which is the same wire type this endpoint serves — so the approver's screen decodes it
 * with this function rather than a second one. The `outcome` enum and the three-way ceiling above
 * are rules, not boilerplate, and two copies of a rule is what the module's own header complains
 * about having already.
 */
export function decodeDimension(input: unknown, what: string): DimensionAssessmentView {
  const row = object(input, what);
  const sources = row['sources'];
  if (!Array.isArray(sources)) throw new TypeError(`${what}.sources is not an array`);

  return {
    dimension: oneOf(APPROVAL_DIMENSIONS_WIRE, row, 'dimension', what),
    concessionThbMinor: minorOf(row, 'concessionThbMinor', what),
    outcome: oneOf(ASSESSMENT_OUTCOMES_WIRE, row, 'outcome', what),
    ceiling: decodeCeiling(row['ceiling'], `${what}.ceiling`),
    approvalId: nullableStr(row, 'approvalId', what),
    sources: sources.map((entry: unknown): ConcessionSourceView => {
      const source = object(entry, `${what}.sources[]`);
      return {
        kind: str(source, 'kind', `${what}.sources[]`),
        amountThbMinor: minorOf(source, 'amountThbMinor', `${what}.sources[]`),
        quoteLineId: nullableStr(source, 'quoteLineId', `${what}.sources[]`),
        overrideId: nullableStr(source, 'overrideId', `${what}.sources[]`),
        reasonCode: nullableStr(source, 'reasonCode', `${what}.sources[]`),
      };
    }),
  };
}

export function decodeAssessment(input: unknown): AuthorityAssessmentView {
  const row = object(input, 'assessment');
  const allowed = row['allowed'];
  if (typeof allowed !== 'boolean') throw new TypeError('assessment.allowed is not a boolean');

  return {
    orderId: str(row, 'orderId', 'assessment'),
    orderNo: nullableStr(row, 'orderNo', 'assessment'),
    margin: decodeDimension(row['margin'], 'assessment.margin'),
    cashflow: decodeDimension(row['cashflow'], 'assessment.cashflow'),
    allowed,
  };
}

/* ------------------------------------------------------------------ *
 * Calls
 * ------------------------------------------------------------------ */

export const getAssessment = (orderId: string): Promise<AuthorityAssessmentView> =>
  apiJson(`/quotes/authority/orders/${encodeURIComponent(orderId)}`, decodeAssessment);

/**
 * Ask for a concession to be approved.
 *
 * ⚠️ The body carries **no amount**, deliberately, and the API's contract says why: the size
 * of the concession is measured from the quote in the transaction that records the request,
 * because a body that could name it is a body that asks for approval of ฿100 and receives
 * approval of ฿100,000. The requester is the scope and never a field, or the two-person rule
 * is one person and a text box.
 *
 * There is no decide call in this folder. The approver is a different person on a different
 * screen — that is what the rule means, and plan 7.13 warns that multiplying approval gates
 * is the surest way to kill the one control in this system that means anything.
 */
export async function requestApproval(request: {
  readonly orderId: string;
  readonly dimension: ApprovalDimensionWire;
  readonly reasonTh: string;
}): Promise<void> {
  await apiJson(
    '/quotes/approvals',
    /*
     * The created approval is not read: this screen's next act is to re-assess, and the
     * assessment is the thing that decides what the person may do. Checking the body is
     * enough — a 2xx with a shape nobody reads is still a 2xx that means "recorded".
     */
    (body) => object(body, 'approval'),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    },
  );
}
