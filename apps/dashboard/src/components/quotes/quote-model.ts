import {
  thbMinorOf,
  type OverrideAnchorWire,
  type QuoteLineWire,
  type QuoteOverrideWire,
  type QuoteWire,
  type StaleBaselineWire,
} from './quote-wire';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE FOLD. Where every figure on the screen came from — plan 7.9(ก).
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The safety property of this whole feature is that a person can **see** where a number came
 * from. Once a human may set any figure, "is this total correct?" has no computable answer,
 * and the replacement question — "where did this number come from, and was that person
 * allowed?" — is only answerable if the three layers stay apart on the screen as well as in
 * the database. This module is where they are kept apart.
 *
 * ### It joins and it compares. It does not price.
 *
 * Every figure below is either a number the server sent, or the difference between two
 * numbers the server sent. There is no VAT arithmetic here, no percentage of anything, no
 * re-derivation of a total: `money` comes off the wire and is rendered, and
 * `effectiveTotalThbMinor` is the server's answer for each line rather than this file's
 * substitution of an override into a baseline. The moment this module computed a total it
 * would be a second answer to a question the API owns, and plan 7.13's opening finding is
 * that the expensive failure in this design is one mechanism written several times with
 * several names, each answering the same question slightly differently.
 *
 * What it does instead is **disagree out loud**. Three cross-checks, all comparisons:
 *
 *   **the lines do not foot** — the effective line totals do not sum to the net the server
 *   sent. Plan 4.3(ข) is an entire section about a listing that does not foot, and a quote
 *   whose lines do not add up to its own subtotal is the one document nobody can sign.
 *
 *   **two live overrides on one anchor** — Postgres holds "at most one" in two partial unique
 *   indexes. If two arrive anyway, rendering whichever came first would be showing one
 *   promise while hiding another.
 *
 *   **a baseline moved with nothing to explain it** — an override froze the figure it was
 *   taken against. When today's computed figure differs *and the server has not listed the
 *   line as stale*, the catalogue did not move and the calculator did. Plan 7.9(จ) calls that
 *   an integrity alarm rather than a 409, and the API raises it as a 500 with a stack — this
 *   is the same condition seen from the other side of the wire, and the screen refuses to
 *   quote from it.
 */

/* ------------------------------------------------------------------ *
 * Provenance — the three states, and the third one is the one usually missed
 * ------------------------------------------------------------------ */

/**
 * Where a figure came from.
 *
 *   `computed`    `calcPrice` produced it from a product version, selections, measures and a
 *                 quantity. Nobody chose it.
 *   `overridden`  a named person set it, against a baseline frozen at that moment.
 *   `typed`       a free-form line's own amount: delivery, installation, a goodwill credit.
 *                 **There was never a computed figure to concede against.** It is not an
 *                 override — nothing was given away by the mere fact of it — and it is not
 *                 computed, because a human wrote it.
 *
 * The schema draws the same line with `computed_total_thb_minor` NULL and
 * `charge_total_thb_minor` NOT NULL on exactly those rows, and its comment says why: a typed
 * charge stored in a column called "computed" would make every "how much has been conceded on
 * this document?" query count a ฿2,000 delivery charge as a discount taken against ฿0. A
 * screen that painted the two the same way would put that same error into a person's head.
 */
export type Provenance =
  | { readonly kind: 'computed' }
  | { readonly kind: 'typed' }
  | { readonly kind: 'overridden'; readonly override: QuoteOverrideWire };

export interface LineView {
  readonly line: QuoteLineWire;
  /** What the figure would be with nobody's thumb on it: computed, or the typed charge. */
  readonly baselineThbMinor: bigint;
  /** What the customer is being asked to pay for this line. The **server's** figure. */
  readonly effectiveThbMinor: bigint;
  readonly provenance: Provenance;
  /**
   * The server's own note that a catalogue publish landed under this line, or `null`.
   *
   * Two kinds, and they are two different jobs: `promise_baseline_moved` needs a person to
   * re-promise or let the new price stand, `line_needs_repricing` needs the line re-sent
   * against the current catalogue handle and no decision at all.
   */
  readonly stale: StaleBaselineWire | null;
  /**
   * Whether qty, options and measures are refused on this line.
   *
   * Mirrors `quote_lines_guard_write()` and the contract's own note on `ReviseLineRequestWire`:
   * refused while a live `line_total` override exists, because ฿17,000 for two is not ฿17,000
   * for three and plan 7.9(ง)(2) is the finding that `quoteReducer.ts:68` drops that promise
   * silently. The control is disabled here so the person reads the reason instead of a
   * constraint violation.
   */
  readonly locked: boolean;
}

export type IntegrityAlarm =
  | {
      readonly kind: 'duplicate_live_override';
      readonly anchor: OverrideAnchorWire;
      readonly subjectId: string | null;
      readonly count: number;
    }
  | {
      readonly kind: 'lines_do_not_foot';
      readonly serverThbMinor: bigint;
      readonly foldedThbMinor: bigint;
    }
  | {
      readonly kind: 'baseline_moved_under_core';
      readonly lineId: string;
      readonly frozenThbMinor: bigint;
      readonly currentThbMinor: bigint;
    };

/**
 * The concession as a figure to **render**, and deliberately nothing more.
 *
 * ⚠️ The contract says this in as many words on `marginConcessionThbMinor`: whether the
 * concession is *allowed* is `approvals` and `authority_limits`, answered by the authority
 * endpoints, and a client that decided for itself from this number would be a second
 * mechanism — plan 7.13's opening finding. So there is no ceiling and no verdict in this
 * type, and `authority-panel.tsx` fetches both from the endpoint that owns them.
 */
export interface ConcessionView {
  readonly concessionThbMinor: bigint;
  readonly baselineGrandTotalThbMinor: bigint;
}

export interface QuoteView {
  readonly wire: QuoteWire;
  readonly lines: readonly LineView[];
  readonly grandTotalOverride: QuoteOverrideWire | null;
  readonly leadTimeOverride: QuoteOverrideWire | null;
  /** Lines a catalogue publish landed under, in the order they appear on the quote. */
  readonly staleLines: readonly LineView[];
  /**
   * The document promise's baseline no longer matches the document — the server said so.
   *
   * Rendered on its own, because it names no line: the recovery is to confirm the total again
   * or withdraw it, and sending somebody to a line would be sending them to the wrong screen.
   */
  readonly documentStale: StaleBaselineWire | null;
  readonly alarms: readonly IntegrityAlarm[];
  /** `null` for a caller without `quotes.read` — the customer's own view of their quote. */
  readonly concession: ConcessionView | null;
  /** Whether this screen may show provenance at all. False is a customer, not a failure. */
  readonly showsProvenance: boolean;
  /**
   * Whether a catalogue publish landed under a promise on this quote.
   *
   * The **only** send-blocker this module knows about, and deliberately so: whether the
   * concession is within somebody's authority is the authority endpoint's answer, and a
   * second gate computed here would disagree with it the first time either changed.
   */
  readonly hasStaleBaselines: boolean;
}

/* ------------------------------------------------------------------ *
 * The fold
 * ------------------------------------------------------------------ */

/** Computed on a catalogue line, the typed charge on a free-form one. Exactly one is present. */
function baselineOf(line: QuoteLineWire): bigint {
  if (line.computedTotalThbMinor !== null) return thbMinorOf(line.computedTotalThbMinor);
  if (line.chargeTotalThbMinor !== null) return thbMinorOf(line.chargeTotalThbMinor);
  /*
   * `quote_lines_kind_shape` makes this unreachable from a well-formed row — every line has
   * exactly one of the two — and the contract's schema would have refused the response
   * before it got here. Zero rather than a throw because a malformed line should render as a
   * line worth ฿0 beside an alarm, not blank the screen somebody was about to quote from.
   */
  return 0n;
}

/**
 * Index the live overrides by what they are about, counting collisions rather than losing them.
 *
 * `Map<key, list>` and not `Map<key, one>`: the second shape makes a duplicate invisible by
 * construction, which is the failure this function exists to detect.
 */
function indexOverrides(
  overrides: readonly QuoteOverrideWire[],
): ReadonlyMap<string, readonly QuoteOverrideWire[]> {
  const index = new Map<string, QuoteOverrideWire[]>();

  for (const override of overrides) {
    const key = `${override.anchor}:${override.quoteLineId ?? ''}`;
    const bucket = index.get(key);
    if (bucket === undefined) index.set(key, [override]);
    else bucket.push(override);
  }

  return index;
}

const first = (bucket: readonly QuoteOverrideWire[] | undefined): QuoteOverrideWire | null =>
  bucket === undefined ? null : (bucket[0] ?? null);

export function foldQuote(wire: QuoteWire): QuoteView {
  const sales = wire.sales;
  const index = indexOverrides(sales?.overrides ?? []);
  /*
   * Line rows only. `document_baseline_moved` carries no `quoteLineId` — it is about the
   * document total, and its recovery is the whole-document one — so it is picked out separately
   * below rather than being keyed by a line it does not name.
   */
  const staleByLine = new Map<string, StaleBaselineWire>(
    (sales?.staleBaselines ?? [])
      .filter((entry): entry is StaleBaselineWire & { quoteLineId: string } =>
        entry.quoteLineId !== null,
      )
      .map((entry) => [entry.quoteLineId, entry]),
  );

  /*
   * ⭐ The document promise's own baseline, re-verified by the server.
   *
   * For one round nothing checked it — `verifyBaselines` iterated lines — and the footing check
   * below is switched **off** precisely when a `grand_total` override exists, which is the only
   * state in which the attack was possible. A salesperson looking at ฿27,648 of lines under a
   * ฿14,291.68 total saw no warning at all. The suppression is still right (a document override
   * *is* the reason the two differ), so what closes the gap is rendering the server's own row
   * for it, which is this.
   */
  const documentStale =
    (sales?.staleBaselines ?? []).find((entry) => entry.kind === 'document_baseline_moved') ?? null;
  const alarms: IntegrityAlarm[] = [];

  for (const [key, bucket] of index) {
    if (bucket.length <= 1) continue;
    const [anchor = '', subject = ''] = key.split(':');
    alarms.push({
      kind: 'duplicate_live_override',
      anchor: anchor as OverrideAnchorWire,
      subjectId: subject === '' ? null : subject,
      count: bucket.length,
    });
  }

  const lines = [...wire.lines]
    .sort((left, right) => left.seq - right.seq)
    .map((line): LineView => {
      const baseline = baselineOf(line);
      const effective = thbMinorOf(line.effectiveTotalThbMinor);
      const override = first(index.get(`line_total:${line.id}`));
      const stale = staleByLine.get(line.id) ?? null;

      if (override !== null && stale === null) {
        /*
         * The integrity case, seen from this side of the wire. The promise was made against a
         * figure the line no longer reports, and the server did **not** list the line as
         * stale — so no catalogue version moved and the pricing code did. Plan 7.9(จ): not a
         * 409, and not something a retry can fix.
         */
        const frozen = override.computedThbMinor === null ? null : thbMinorOf(override.computedThbMinor);
        if (frozen !== null && frozen !== baseline) {
          alarms.push({
            kind: 'baseline_moved_under_core',
            lineId: line.id,
            frozenThbMinor: frozen,
            currentThbMinor: baseline,
          });
        }
      }

      return {
        line,
        baselineThbMinor: baseline,
        effectiveThbMinor: effective,
        provenance:
          override !== null
            ? { kind: 'overridden', override }
            : { kind: line.kind === 'freeform' ? 'typed' : 'computed' },
        stale,
        locked: override !== null,
      };
    });

  const grandTotalOverride = first(index.get('grand_total:'));

  /*
   * The footing check compares like with like: `effectiveTotalThbMinor` is VAT-exclusive and
   * so is `netThbMinor`. It is skipped when a document-level override exists, because that
   * override *is* the reason the two differ — the contract's `marginConcessionThbMinor` is one
   * subtraction rather than a sum for the same reason, and asserting a sum here would report
   * the feature working as a fault.
   */
  const folded = lines.reduce((sum, view) => sum + view.effectiveThbMinor, 0n);
  const net = thbMinorOf(wire.money.netThbMinor);
  if (grandTotalOverride === null && folded !== net) {
    alarms.push({ kind: 'lines_do_not_foot', serverThbMinor: net, foldedThbMinor: folded });
  }

  const concession: ConcessionView | null =
    sales === null
      ? null
      : {
          concessionThbMinor: thbMinorOf(sales.marginConcessionThbMinor),
          baselineGrandTotalThbMinor: thbMinorOf(sales.baselineGrandTotalThbMinor),
        };

  return {
    wire,
    lines,
    grandTotalOverride,
    leadTimeOverride: first(index.get('lead_time_days:')),
    staleLines: lines.filter((view) => view.stale !== null),
    documentStale,
    alarms,
    concession,
    showsProvenance: sales !== null,
    /*
     * The server's own list, not a rule this module invented. An alarm is deliberately not
     * folded in beside it: an alarm does not block the API, and a screen that refused on top
     * of something only it can see would be a second gate nobody else knows about.
     */
    hasStaleBaselines: (sales?.staleBaselines.length ?? 0) > 0,
  };
}

/* ------------------------------------------------------------------ *
 * Reading a view
 * ------------------------------------------------------------------ */

export const isOverridden = (view: LineView): boolean => view.provenance.kind === 'overridden';

/** The override on a line, or `null` — narrowed once so a callback never re-narrows. */
export const liveOverrideOf = (view: LineView): QuoteOverrideWire | null =>
  view.provenance.kind === 'overridden' ? view.provenance.override : null;

/**
 * Whether any figure on this document was set by a person.
 *
 * A free-form charge counts: a human wrote it, even though it conceded nothing. Used for the
 * one-line summary at the top of the screen, which is the sentence that tells somebody
 * whether to read the provenance column at all.
 */
export const hasHumanFigures = (view: QuoteView): boolean =>
  view.grandTotalOverride !== null ||
  view.leadTimeOverride !== null ||
  view.lines.some((line) => line.provenance.kind !== 'computed');
