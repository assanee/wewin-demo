import 'client-only';

import { CATALOG_STALE } from '@wewin/contract/errors';
import type {
  OverrideAnchorWire,
  OverrideEntryModeWire,
  OverrideReasonWire,
  QuoteLineWire,
  QuotePreconditionWire,
  QuoteWire,
} from '@wewin/contract/quote';
import type { OrganisationProfileWire } from '@wewin/contract/organisation';
import type { LengthWire } from '@wewin/contract/measure';
import type { LengthUnit } from '@wewin/core/units';

import { apiJson } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { decodeProfile } from '@/components/organisation/organisation-api';

import { decodeQuote } from './quote-wire';

/**
 * Every call the quote screens make, in one file, decoded rather than cast.
 *
 * ── The client sends no money it did not have typed into it ──────────────────────
 *
 * Every write carries `expect: { quoteRevision }` and **nothing else about state**. No total,
 * no subtotal, no VAT, no baseline. The one thing that travels is the characters a person
 * typed, in `enteredValueText`, with the box they typed them into in `enteredAs` — and the
 * server parses that text against a baseline it computed itself.
 *
 * That is the shape of the mitigation this phase replaced. The old one was "the api
 * recomputes and 409s on mismatch", and it died the moment sales could set any figure, since
 * there is no longer a correct total to compare against. What survives is provenance: the
 * server knows what *it* computed, this client knows what a person typed, and the two never
 * swap jobs.
 *
 * ── Every route is a POST, and none of them is a PATCH ───────────────────────────
 *
 * apps/api's controller names them after the act rather than the row: `lines/:id/revision`
 * changes what a line *is*, `lines/:id/presentation` changes what the customer *reads*, and
 * `overrides/:id/revocation` withdraws a promise. The last one is deliberately not a DELETE —
 * the row is stamped, not removed, and a verb that says "delete" about an append-only table
 * is a verb somebody will eventually implement.
 *
 * ── Two 409s and a 500, because the recoveries are three different things ─────────
 *
 * See `conflictOf`. Collapsing them into "conflict, reload" is how a person ends up
 * re-confirming eleven prices they never needed to look at — or, worse, reloading past a
 * catalogue publish and carrying on quoting a discount that is now twice the one anybody
 * agreed to.
 */

export type { QuotePreconditionWire };

/** The handle a write echoes back. Opaque: produced by the server, never constructed here. */
export const preconditionOf = (quote: QuoteWire): QuotePreconditionWire => ({
  quoteRevision: quote.quoteRevision,
});

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

const quotePath = (orderId: string, suffix = ''): string =>
  `/orders/${encodeURIComponent(orderId)}/quote${suffix}`;

export const getQuote = (orderId: string): Promise<QuoteWire> =>
  apiJson(quotePath(orderId), decodeQuote);

/**
 * ⭐ Add a line by copying one that is already priced — `POST …/quote/lines`.
 *
 * The endpoint has existed since the quote editor did and nothing has ever called it, so every
 * line on every quotation in this system arrived through the storefront's configurator. See
 * `duplicate-line.ts` for why the copy is a copy and not a second configurator.
 *
 * ⚠️ `enteredUnits` is sent empty, deliberately. It records which unit a person *typed* in, and
 * nobody typed anything here — the measures came off a line the customer configured. The server
 * accepts it (checked against a running one) and falls back to each group's authored unit,
 * which is the same unit the source line was priced in.
 */
export const duplicateLine = (
  orderId: string,
  expect: QuotePreconditionWire,
  line: {
    readonly productVersionId: string;
    readonly documentHash: string;
    readonly productId: string;
    readonly selections: Readonly<Record<string, string>>;
    readonly measures: Readonly<Record<string, LengthWire>>;
    readonly qty: number;
  },
): Promise<QuoteWire> =>
  apiJson(
    quotePath(orderId, '/lines'),
    decodeQuote,
    post({ expect, line: { ...line, enteredUnits: {} } }),
  );

/* ------------------------------------------------------------------ *
 * Writes
 * ------------------------------------------------------------------ */

const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/**
 * ⭐ Set a figure a human decided.
 *
 * The body is the contract's discriminated union on the anchor, so an entry mode that does
 * not fit its anchor is a parse error with a path in it rather than a CHECK violation
 * translated into a shrug. Replacing a live promise is this same call again: the server
 * supersedes the old row and writes the new one in one transaction, in the order the partial
 * unique index forces.
 *
 * ⚠️ `enteredValueText` goes up **exactly as the person typed it**. `override-entry.ts`
 * previewed what it will become; nothing about that preview is sent.
 */
export function setOverride(
  orderId: string,
  expect: QuotePreconditionWire,
  request: {
    readonly anchor: OverrideAnchorWire;
    readonly quoteLineId: string | null;
    readonly enteredAs: OverrideEntryModeWire;
    readonly enteredValueText: string;
    readonly reasonCode: OverrideReasonWire;
    readonly noteTh: string | null;
  },
): Promise<QuoteWire> {
  const { anchor, quoteLineId, enteredAs, enteredValueText, reasonCode, noteTh } = request;

  return apiJson(
    quotePath(orderId, '/overrides'),
    decodeQuote,
    post({
      expect,
      anchor,
      enteredAs,
      enteredValueText,
      reasonCode,
      /*
       * Omitted rather than sent as null on both counts: the request schemas are
       * `strictObject`, so an unexpected key is a 400 and a `noteTh: null` is not the same
       * thing as an absent one. `quoteLineId` belongs to the line arm only — which is
       * `quote_overrides_scope_shape` said on the wire.
       */
      ...(anchor === 'line_total' && quoteLineId !== null ? { quoteLineId } : {}),
      ...(noteTh === null || noteTh === '' ? {} : { noteTh }),
    }),
  );
}

/**
 * Withdraw a promise so the computed figure applies again.
 *
 * Also the way sales *confirms* a price after the catalogue moved: an override equal to
 * today's computed figure is refused by `quote_overrides_value_differs`, and rightly —
 * agreeing with the machine is not a promise, it is the absence of one.
 */
export const revokeOverride = (
  orderId: string,
  overrideId: string,
  expect: QuotePreconditionWire,
  noteTh?: string,
): Promise<QuoteWire> =>
  apiJson(
    quotePath(orderId, `/overrides/${encodeURIComponent(overrideId)}/revocation`),
    decodeQuote,
    post({ expect, ...(noteTh === undefined || noteTh === '' ? {} : { noteTh }) }),
  );

/**
 * 📣 What the customer reads. Structurally inert, and that is the whole point.
 *
 * Plan 7.9(ค): sales can type "กระจกเทมเปอร์ 8 มม." on a line whose sku says 6 mm, and a works
 * order renders from the sku and the resolved options only. This route writes the field that
 * never reaches the factory; `revision` writes the fields that do, and they are two routes for
 * exactly that reason.
 *
 * `customerDescriptionTh: null` clears it and an absent key leaves it alone — two different
 * requests, so the two are spelled differently here.
 */
export const presentLine = (
  orderId: string,
  lineId: string,
  expect: QuotePreconditionWire,
  patch: {
    readonly customerDescriptionTh?: string | null;
    readonly isVatApplicable?: boolean;
  },
): Promise<QuoteWire> =>
  apiJson(
    quotePath(orderId, `/lines/${encodeURIComponent(lineId)}/presentation`),
    decodeQuote,
    post({ expect, ...patch }),
  );

/**
 * ⭐ Change what a line *is* — plan 7.9(ค)'s "แก้ได้แบบ input (recompute ต่อ)".
 *
 * Only the quantity moves from this screen, and the price does not travel with it: the server
 * re-runs `calcPrice` over the line's own selections and measures at the new count and writes
 * what *it* computed. That is the one route in this file where a number on screen changes
 * without a human having typed it, and it is the layer plan 7.9(ก) calls `computed`.
 *
 * ── Three fields a quote line does not obviously carry, and where each comes from ─
 *
 *   `documentHash`   the frozen catalogue document the line is pinned against, served on the
 *                    line. A hash from anywhere else would be a guess at the pinned document,
 *                    which is the staleness a `CatalogRef` exists to catch — so when it is
 *                    null there is no request to build and the caller must not offer one.
 *   `productId`      served on the line for the same reason. The server resolves it from the
 *                    line's version anyway and refuses a mismatch, so it is a value to echo.
 *   `enteredUnits`   nobody recorded it. It is the grid a *step* warning is judged on (plan
 *                    4.1), never a value that rewrites a measurement, and the grid this screen
 *                    displays is centimetres — so that is what it says, honestly, rather than
 *                    claiming to know what the customer originally typed.
 *
 * Returns `null` — rather than throwing or sending a half-formed body — when the line cannot
 * be revised at all: free-form lines have nothing to recompute, and a line whose pinned
 * version is no longer published has no current handle. The recovery for the second is the
 * one `staleBaselines` names, per line, and it is not "guess a hash".
 */
export function reviseQty(
  orderId: string,
  line: Pick<
    QuoteLineWire,
    'id' | 'productVersionId' | 'documentHash' | 'productId' | 'selections' | 'measures'
  >,
  qty: number,
  expect: QuotePreconditionWire,
): Promise<QuoteWire> | null {
  const { productVersionId, documentHash, productId, selections, measures } = line;
  if (
    productVersionId === null ||
    documentHash === null ||
    productId === null ||
    selections === null ||
    measures === null
  ) {
    return null;
  }

  const enteredUnits: Record<string, LengthUnit> = {};
  for (const code of Object.keys(measures)) enteredUnits[code] = DISPLAYED_UNIT;

  return apiJson(
    quotePath(orderId, `/lines/${encodeURIComponent(line.id)}/revision`),
    decodeQuote,
    post({
      expect,
      line: { productVersionId, documentHash, productId, selections, measures, enteredUnits, qty },
    }),
  );
}

/**
 * The unit `measureText` renders a measurement in, and therefore the only unit this screen can
 * honestly claim anything was read in. Imported nowhere else so the two cannot drift apart
 * without this constant moving too.
 */
const DISPLAYED_UNIT: LengthUnit = 'cm';

export const removeLine = (
  orderId: string,
  lineId: string,
  expect: QuotePreconditionWire,
  reasonTh?: string,
): Promise<QuoteWire> =>
  apiJson(
    quotePath(orderId, `/lines/${encodeURIComponent(lineId)}/removal`),
    decodeQuote,
    post({ expect, ...(reasonTh === undefined || reasonTh === '' ? {} : { reasonTh }) }),
  );

/** Delivery, installation, a survey, a goodwill credit — plan 7.9(ค)'s "แถวใหม่". */
export const addCharge = (
  orderId: string,
  expect: QuotePreconditionWire,
  charge: {
    readonly customerDescriptionTh: string;
    /** Verbatim, and it may be negative: a −฿1,000 line is a discount wearing a different hat. */
    readonly amountText: string;
    readonly isVatApplicable: boolean;
  },
): Promise<QuoteWire> =>
  apiJson(quotePath(orderId, '/charges'), decodeQuote, post({ expect, ...charge }));

/**
 * Re-verify every promise against today's catalogue — plan 7.9(จ), as a button.
 *
 * ⚠️ It is the *same* check the submit makes and is not a substitute for it: a publish can
 * land in the seconds between this call and the submit, and a gate a client can choose not to
 * call is not a gate. It exists so a salesperson can find out before they pick up the phone.
 */
export const verifyQuote = (orderId: string, expect: QuotePreconditionWire): Promise<QuoteWire> =>
  apiJson(quotePath(orderId, '/verification'), decodeQuote, post({ expect }));

/* ------------------------------------------------------------------ *
 * Reading a failure
 * ------------------------------------------------------------------ */

/** The reason strings apps/api/src/quotes/errors.ts sends. Restated; drift fails loudly below. */
export const QUOTE_STALE = 'quote_stale';
export const QUOTE_BASELINES_STALE = 'quote_baselines_stale';

/**
 * What kind of refusal a failure is.
 *
 *   `quote_stale`       somebody else edited this quote. The figures are still the machine's,
 *                       so nothing needs re-agreeing. **Reload and carry on.**
 *   `baselines_stale`   a catalogue version was published under one or more promises. The same
 *                       ฿17,000 was a 7.8% concession against ฿18,432 and is 15% against
 *                       ฿20,000, and nobody agreed to the second. **Every affected line has to
 *                       be looked at by a person** — the body lists them, and so does the
 *                       reloaded quote's `staleBaselines`.
 *   `catalogue_stale`   the product document moved under a line being added or revised. The
 *                       recovery is mechanical: re-render the configurator from the document
 *                       in the body. Same protocol `/price` and `POST /orders` already speak.
 *   `other`             a 409 with a reason this client has no recovery for, including one
 *                       from a proxy. Shown as itself rather than dressed up as one of the
 *                       three above.
 *
 * ⚠️ There is deliberately **no `integrity` arm**. apps/api raises that case as a plain
 * `Error`, which the exception filter answers as a 500 with a request id — because `core`
 * changed under a pinned document and there is nothing a caller can do. A client that
 * classified it as a conflict would offer a retry for the one failure a retry cannot touch.
 * The screen still detects the same condition for itself, out of the fold — see
 * `quote-model.ts`'s `baseline_moved_under_core`.
 *
 * Read off `details` and never off the message: the message is prose for a human and is
 * scheduled for translation, which is the whole reason `errors.ts` says clients branch on
 * `code`.
 */
export type ConflictKind = 'quote_stale' | 'baselines_stale' | 'catalogue_stale' | 'other';

export function conflictOf(error: unknown): ConflictKind | null {
  if (!(error instanceof ApiError) || error.code !== 'CONFLICT') return null;

  const details = asRecord(error.details);
  if (details === null) return 'other';

  const reason = details['reason'];
  if (reason === QUOTE_STALE) return 'quote_stale';
  if (reason === QUOTE_BASELINES_STALE) return 'baselines_stale';

  /*
   * The catalogue arm arrives nested: apps/api wraps `catalogStaleBody(...)` under a `stale`
   * key, and that body's own `error` field is the reason string. Two shapes for one refusal
   * is not this client's choice — it is what "the same body every other endpoint sends"
   * costs, and reading only the flat one would classify a catalogue publish as `other`.
   */
  const stale = asRecord(details['stale']);
  if (stale !== null && stale['error'] === CATALOG_STALE) return 'catalogue_stale';
  if (details['error'] === CATALOG_STALE) return 'catalogue_stale';

  return 'other';
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;

export const isForbidden = (error: unknown): boolean =>
  error instanceof ApiError && error.code === 'FORBIDDEN';

/**
 * The prose to show for any failure, without ever showing an empty string.
 *
 * Identical in shape to `products/catalog-api.ts`'s, and deliberately a copy rather than an
 * import: that one is the product screens' vocabulary and this one is the quote screens', and
 * the day either grows a domain-specific message the shared version would have to grow a flag
 * saying which caller it is for.
 */
/**
 * ⚠️ One of three copies that predate `@/lib/api/errors`, now delegating to it rather than
 * restating it. It stopped being a harmless duplicate the day the canonical one learned to
 * render `RbacGuard`'s English `Missing permission: …` in Thai: a copy that did not would put
 * that sentence on this screen and nowhere else, which is worse than either answer alone.
 */
export { failureMessage } from '@/lib/api/errors';

/* ------------------------------------------------------------------ *
 * The pinned document — what a quotation actually is
 * ------------------------------------------------------------------ */

/**
 * ⭐ `GET /orders/:id/document` — the frozen contract terms, and who is offering them.
 *
 * Not the editable quote. Eight things are pinned at `submit_for_payment` and the locale is
 * one of them, which is what makes a reprint citable (plan 10.6). The editor above reads the
 * *live* quote; this reads the document the customer was actually shown.
 *
 * ⚠️ 404 when the order has never been submitted, and that is the honest answer rather than
 * an empty document: before submit there is no quotation, there is a cart.
 *
 * ⚠️ `document` and `seller` are siblings on the response, and stay siblings here — task
 * 11b. `document` is the pinned half, passed through exactly as `apps/api` sent it;
 * `seller` is `organisation_profile`, read live on every call rather than pinned, decoded
 * with the same `decodeProfile` the organisation screen already trusts rather than a second
 * hand-rolled reader that could drift from it.
 */
export interface PinnedDocumentAndSeller {
  readonly document: Record<string, unknown>;
  readonly seller: OrganisationProfileWire;
}

export const getPinnedDocument = (orderId: string): Promise<PinnedDocumentAndSeller> =>
  apiJson(`/orders/${orderId}/document`, (body) => {
    if (typeof body !== 'object' || body === null) throw new TypeError('เอกสาร: ไม่ใช่วัตถุ');
    const wrapped = body as Record<string, unknown>;

    const document = wrapped['document'];
    if (typeof document !== 'object' || document === null) {
      throw new TypeError('เอกสาร: ไม่มี document');
    }

    return { document: document as Record<string, unknown>, seller: decodeProfile(wrapped['seller']) };
  });

/* ------------------------------------------------------------------ *
 * The link a customer opens
 * ------------------------------------------------------------------ */

export interface CustomerLink {
  readonly url: string;
  readonly expiresAt: string;
}

/**
 * ⭐ `GET /orders/:id/customer-link` — the quotation link, for sending by hand.
 *
 * ⚠️ **The URL comes from the API, whole.** Building it here from a token and a
 * `NEXT_PUBLIC_WEB_BASE_URL` would be a second opinion about where the storefront is, and
 * the two would disagree the first time somebody changed one — leaving a customer who was
 * emailed one origin and read the other over the telephone with a link that 404s.
 *
 * ⚠️ It is a **bearer credential**. Whoever holds it sees this quotation, which is exactly
 * why it exists: an order with a telephone number and no address receives nothing from the
 * outbox, and a member of staff pasting this into LINE is how that gap is survived.
 */
export const getCustomerLink = (orderId: string): Promise<CustomerLink> =>
  apiJson(`/orders/${orderId}/customer-link`, (body) => {
    if (typeof body !== 'object' || body === null) throw new TypeError('ลิงก์: ไม่ใช่วัตถุ');
    const raw = body as Record<string, unknown>;
    if (typeof raw['url'] !== 'string' || raw['url'] === '') {
      throw new TypeError('ลิงก์: ไม่มี url');
    }
    return {
      url: raw['url'],
      expiresAt: typeof raw['expiresAt'] === 'string' ? raw['expiresAt'] : '',
    };
  });
