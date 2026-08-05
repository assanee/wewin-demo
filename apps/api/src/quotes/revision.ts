import { createHash } from 'node:crypto';

import { canonicalJson } from '@wewin/db/hash';

/**
 * `quoteRevision` — what a client echoes back so the server can say "no, it moved".
 *
 * ── Why a token over the content and not a counter ───────────────────────────────
 *
 * Plan 7.9(จ) calls it a revision, which sounds like a column: `quote_revision integer`,
 * bumped on every write. It is not one here, and the reason is the same one plan 7.13 opens
 * with — six mechanisms pretending to be one. A counter needs a writer, and *every* path that
 * writes a quote is a writer of it: adding a line, revising a line, removing a line, setting
 * an override, revoking one. Five writers of one number is five chances for the number to be
 * right about a change that did not happen or silent about one that did, and the failure is
 * invisible because the happy path is identical.
 *
 * A digest of the live content has exactly one writer — this function — and it is derived
 * from the thing it describes. It cannot run backwards, it cannot be forged into agreement,
 * and it changes if and only if the quote is different. Two states that hash the same are
 * two states that *are* the same, which is precisely when the write should be allowed to
 * proceed.
 *
 * The cost, stated: it is not ordered, so a client cannot tell whether the version it holds
 * is older or newer than the server's — only that it differs. Nothing in this feature needs
 * the ordering, and a 409 that says "reload" is the only recovery either way.
 *
 * ── What goes into it ────────────────────────────────────────────────────────────
 *
 * Everything a write may collide with, and nothing else. The live lines with the fields that
 * change what the quote *says*, and the live overrides with the promise and the baseline it
 * was made against. Not `updated_at` — a timestamp makes the token change when nothing did,
 * which turns the 409 into noise and teaches the UI to retry blindly.
 *
 * Canonicalised first, for the reason `packages/db/src/hash.ts` gives: `jsonb` stores a
 * parsed value rather than a document, so key order is not a property of what came back out
 * of Postgres and a digest that depended on it would disagree with itself.
 */

export interface RevisionLine {
  readonly id: string;
  readonly seq: number;
  readonly kind: string;
  readonly productVersionId: string | null;
  readonly skuCode: string | null;
  readonly selections: unknown;
  readonly measures: unknown;
  readonly qty: number;
  readonly computedTotalThbMinor: bigint | null;
  readonly chargeTotalThbMinor: bigint | null;
  readonly isVatApplicable: boolean;
  readonly customerDescriptionTh: string | null;
}

export interface RevisionOverride {
  readonly id: string;
  readonly anchor: string;
  readonly quoteLineId: string | null;
  readonly computedThbMinor: bigint | null;
  readonly overrideThbMinor: bigint | null;
  readonly computedDays: number | null;
  readonly overrideDays: number | null;
}

/**
 * 16 lowercase hex digits, matching `configHash`'s width for the same reason it chose one:
 * this is a collision-detection token between two consecutive states of one small document,
 * not a signature, and a 64-character string in every request body buys nothing a person can
 * use. `QUOTE_REVISION_PATTERN` in the contract is the same width.
 */
const TOKEN_LENGTH = 16;

export function quoteRevision(
  lines: readonly RevisionLine[],
  overrides: readonly RevisionOverride[],
): string {
  const subject = {
    lines: [...lines]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((line) => ({
        id: line.id,
        seq: line.seq,
        kind: line.kind,
        productVersionId: line.productVersionId,
        skuCode: line.skuCode,
        selections: line.selections,
        measures: line.measures,
        qty: line.qty,
        /* Digits, never a JSON number: `JSON.parse` on a large integer is where a satang
         * goes missing, and the token would then be stable across a change that mattered. */
        computedTotalThbMinor: line.computedTotalThbMinor?.toString() ?? null,
        chargeTotalThbMinor: line.chargeTotalThbMinor?.toString() ?? null,
        isVatApplicable: line.isVatApplicable,
        customerDescriptionTh: line.customerDescriptionTh,
      })),
    overrides: [...overrides]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((override) => ({
        id: override.id,
        anchor: override.anchor,
        quoteLineId: override.quoteLineId,
        computedThbMinor: override.computedThbMinor?.toString() ?? null,
        overrideThbMinor: override.overrideThbMinor?.toString() ?? null,
        computedDays: override.computedDays,
        overrideDays: override.overrideDays,
      })),
  };

  return createHash('sha256').update(canonicalJson(subject)).digest('hex').slice(0, TOKEN_LENGTH);
}
