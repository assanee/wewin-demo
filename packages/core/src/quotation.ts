/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ THE QUOTATION, AS IT WILL PRINT — AND AS IT WILL PRINT AGAIN.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Plan 10.6 states the requirement and the reason together: *"เอกสารที่พิมพ์ซ้ำแล้วได้คนละ
 * ภาษาคือเอกสารที่ใช้อ้างอิงไม่ได้"* — a document that reprints differently is one nobody can
 * cite. That is the whole reason `order_documents` exists: eight things are pinned at
 * `submit_for_payment`, and the locale is one of them.
 *
 * So this is a **pure function of the pinned document**. No clock, no environment, no
 * reader's language, no arithmetic of its own.
 *
 * ── ⚠️ The print date is not part of the document ────────────────────────────
 *
 * "พิมพ์เมื่อ 7 ส.ค. 2569" belongs on a reprint and must never be inside the thing
 * `documentHash` covers. Folding it in would make two prints of one quotation differ — which
 * is precisely the failure above, arriving through the most natural-looking line of code on
 * the page. The page renders it beside the document, never within it, and
 * `tests/quotation-print.test.ts` walks the view model looking for today's year.
 *
 * ── ⚠️ And no arithmetic ─────────────────────────────────────────────────────
 *
 * Every figure comes from the pinned document, which the API computed once and froze. A
 * renderer that recomputed a total would be a second opinion about a contract term, and the
 * two would disagree the first time a rounding rule changed.
 */

export interface PinnedLine {
  readonly lineNo: number;
  readonly nameTh: string;
  readonly skuCode: string;
  readonly qty: number;
  readonly customerDescriptionTh: string | null;
  /**
   * ⭐ The option labels **as they were pinned**, already in the document's language.
   *
   * Not the raw `selections` codes. The pinned document carries `price.lines[].label.params`
   * with `catalogText` values — `{ th: 'ลายไม้เข้ม', ref: { … } }` — frozen at submit
   * alongside everything else, which is exactly the text the customer was shown. Rendering
   * `DW` instead would put a warehouse code on a document a customer reads, *and* would
   * drift the day somebody renames the option, which is the whole thing plan 10.6 pins the
   * document to prevent.
   */
  readonly options: readonly { readonly groupTh: string; readonly valueTh: string }[];
  readonly measures: Readonly<Record<string, string>>;
  /** Satang. */
  readonly netMinor: bigint;
}

export interface PinnedCharge {
  readonly labelTh: string;
  readonly amountMinor: bigint;
}

export interface PinnedDocument {
  readonly revision: number;
  readonly documentHash: string;
  /** ⚠️ Frozen at submit. The reader's language is never consulted. */
  readonly pinnedLocale: string;
  readonly orderNo: string | null;
  readonly contactName: string | null;
  readonly submittedAt: string | null;
  readonly vatRateBp: number;
  readonly leadTimeDays: number;
  readonly netThbMinor: bigint;
  readonly vatThbMinor: bigint;
  readonly grandTotalThbMinor: bigint;
  readonly lines: readonly PinnedLine[];
  readonly charges: readonly PinnedCharge[];
}

export interface PrintableLine {
  readonly lineNo: number;
  readonly nameTh: string;
  readonly skuCode: string;
  readonly qtyText: string;
  readonly customerDescriptionTh: string | null;
  readonly detail: readonly string[];
  readonly netText: string;
}

export interface PrintableQuotation {
  readonly revisionText: string;
  readonly documentHash: string;
  readonly orderNoText: string;
  readonly contactName: string | null;
  readonly submittedAtText: string;
  readonly vatRateText: string;
  readonly leadTimeText: string;
  readonly netText: string;
  readonly vatText: string;
  readonly grandTotalText: string;
  readonly lines: readonly PrintableLine[];
  readonly charges: readonly { readonly labelTh: string; readonly amountText: string }[];
  /**
   * ⚠️ True when the pinned locale is one this build cannot render.
   *
   * A document pinned in a locale a later release removed still has to print, so it falls
   * back — and says so, because a reprint that is *not* faithful passing as one is worse
   * than a reprint that refuses.
   */
  readonly localeDegraded: boolean;
}

/** The eight the API renders. Anything else falls back and says so. */
const RENDERABLE = new Set(['th', 'en', 'zh', 'ja', 'de', 'hi', 'my', 'vi']);

const FALLBACK = 'th';

/**
 * Baht **and satang**, unlike `formatBaht`.
 *
 * `formatBaht` rounds to the whole baht, which is right in a table and wrong on a document:
 * ฿8,230 against a ฿8,230.44 total is a quotation whose own lines do not add up, and the
 * customer transfers the printed figure.
 *
 * Split as digits rather than divided as a number — the same rule `readSatang` follows on
 * the way in, for the same reason: a float in a money path is a rounding decision hiding
 * somewhere between the database and the page.
 */
function money(minor: bigint, locale: string): string {
  const negative = minor < 0n;
  const magnitude = negative ? -minor : minor;
  const baht = (magnitude / 100n).toLocaleString(locale === 'th' ? 'th-TH' : locale, {
    maximumFractionDigits: 0,
  });

  return `${negative ? '-' : ''}฿${baht}.${(magnitude % 100n).toString().padStart(2, '0')}`;
}

/**
 * The submission date, in the document's own calendar.
 *
 * ⚠️ `Asia/Bangkok`, not the reader's zone. A quotation submitted at 06:00 in Bangkok is
 * dated the day before if a browser in São Paulo renders it — the same reason
 * `BUSINESS_TIME_ZONE` exists, and the same reason the overview's month boundary is not UTC.
 *
 * `th` renders a Buddhist year through ICU. That is not decoration: 2569 and 2026 are two
 * different documents to somebody reading one.
 */
function dateIn(iso: string | null, locale: string): string {
  if (iso === null) return '—';

  return new Date(iso).toLocaleDateString(locale === 'th' ? 'th-TH-u-ca-buddhist' : locale, {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

export function printableQuotation(document: PinnedDocument): PrintableQuotation {
  const degraded = !RENDERABLE.has(document.pinnedLocale);
  const locale = degraded ? FALLBACK : document.pinnedLocale;

  return {
    revisionText: `#${String(document.revision)}`,
    documentHash: document.documentHash,
    /* A submitted order always has a number; the fallback is defensive, not expected. */
    orderNoText: document.orderNo ?? '—',
    contactName: document.contactName,
    submittedAtText: dateIn(document.submittedAt, locale),
    /* Basis points to percent, exactly — 700 is 7, and 725 would be 7.25. */
    vatRateText: `${String(document.vatRateBp / 100)}%`,
    leadTimeText: String(document.leadTimeDays),
    netText: money(document.netThbMinor, locale),
    vatText: money(document.vatThbMinor, locale),
    grandTotalText: money(document.grandTotalThbMinor, locale),
    lines: document.lines.map((line) => ({
      lineNo: line.lineNo,
      nameTh: line.nameTh,
      skuCode: line.skuCode,
      qtyText: String(line.qty),
      customerDescriptionTh: line.customerDescriptionTh,
      /*
       * ⚠️ `Object.entries` in insertion order, and the document's JSON preserves it. Sorting
       * here would be tidier and would make a reprint differ from the print — the order the
       * customer saw is part of what was pinned.
       */
      /*
       * ⚠️ Measures then options, in the order the document holds them. Sorting would be
       * tidier and would make a reprint differ from the print — the order the customer saw
       * is part of what was pinned.
       */
      detail: [
        ...Object.entries(line.measures).map(([name, value]) => `${name} ${value}`),
        ...line.options.map((option) => `${option.groupTh}: ${option.valueTh}`),
      ],
      netText: money(line.netMinor, locale),
    })),
    charges: document.charges.map((charge) => ({
      labelTh: charge.labelTh,
      amountText: money(charge.amountMinor, locale),
    })),
    localeDegraded: degraded,
  };
}

export interface QuotationCheck {
  readonly hasDocument: boolean;
  readonly status: string;
}

/**
 * ⭐ Whether there is a quotation to print at all.
 *
 * Before `submit_for_payment` there is no pinned document — no revision, no hash, no frozen
 * locale — and printing the editable cart as a "quotation" is how a customer ends up holding
 * a price the company never committed to. On paper the two are indistinguishable, which is
 * exactly why the refusal belongs here rather than in a reviewer's judgement.
 *
 * ⚠️ A **cancelled** order still prints. "What did we quote them in August?" is asked most
 * often about the ones that did not proceed, and the document outlives the order by design.
 */
export function quotationProblem(check: QuotationCheck): 'not-a-quotation-yet' | null {
  return check.hasDocument ? null : 'not-a-quotation-yet';
}

/* ------------------------------------------------------------------ *
 * Off the wire
 * ------------------------------------------------------------------ */

/**
 * ⭐ THE PINNED DOCUMENT, OUT OF THE JSON THE API SENDS.
 *
 * This lives here for the same reason `printableQuotation` does, and the reason is one step
 * earlier in the pipeline than it looks. Plan 10.6 is about a reprint being the *same*
 * document — and two apps that each decode the wire their own way have two documents before
 * either of them renders a character.
 *
 * It was written twice before it was written here: the dashboard had it, and the storefront's
 * first version was written from an *assumption* about the shape rather than from a captured
 * response. That version's unit tests passed against its own invented fixture and the page
 * failed on the first real payload — money arrives as `{unit, digits}`, not as digits, and
 * lines carry no `options` at all.
 */

/** Satang out of the tagged wire. The unit is **checked**, never assumed. */
const satang = (value: unknown, what: string): bigint => {
  if (typeof value !== 'object' || value === null) throw new TypeError(`${what}: ไม่ใช่จำนวนเงิน`);
  const money = value as { unit?: unknown; digits?: unknown };
  if (money.unit !== 'THB.satang') throw new TypeError(`${what}: หน่วยไม่ใช่ THB.satang`);
  return BigInt(String(money.digits));
};

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * The option labels a line was priced with, in the order the document holds them.
 *
 * `price.lines` is the breakdown: a `price.line.base` entry for the area, then one
 * `price.line.option` per selection **that changed the price**, each carrying `group` and
 * `option` as `catalogText`. Anything else — a rule surcharge, a rounding line — has no pair
 * of labels and is skipped rather than rendered as an empty row.
 *
 * ⚠️ **A known gap, and it belongs to the API.** A zero-delta option — clear glass, no insect
 * screen — produces no price line, so the pinned document carries no Thai for it:
 * `selections` has `glass_color: CLR` and nothing else. The quotation therefore lists the
 * options that cost something and omits the ones that did not.
 *
 * Falling back to `selections` for those is worse: `CLR` on a document a customer reads is a
 * warehouse code, not a specification. Incomplete beats unreadable. The real fix is upstream —
 * `submit_for_payment` should pin a label for **every** selection, not only the priced ones.
 */
function pinnedOptions(price: unknown): readonly { groupTh: string; valueTh: string }[] {
  const lines = (price as { lines?: unknown })?.lines;
  if (!Array.isArray(lines)) return [];

  return lines.flatMap((raw) => {
    const params = (raw as { label?: { params?: Record<string, unknown> } }).label?.params ?? {};
    const group = params['group'] as { th?: unknown } | undefined;
    const option = params['option'] as { th?: unknown } | undefined;

    return typeof group?.th === 'string' && typeof option?.th === 'string'
      ? [{ groupTh: group.th, valueTh: option.th }]
      : [];
  });
}

/** What the order row carries and the document does not. */
export interface DocumentContext {
  readonly orderNo: string | null;
  readonly contactName: string | null;
  readonly submittedAt: string | null;
}

/**
 * ⚠️ Throws rather than returning `null` on unreadable money, and the caller catches.
 *
 * A decoder that defaulted a missing total to `0n` would render a quotation for ฿0.00 that is
 * indistinguishable from a real one — in front of somebody who transfers the printed figure.
 * Presentation fields are lenient by contrast: a missing lead time is a worse page, not a
 * wrong one.
 */
export function pinnedDocumentFrom(
  document: Record<string, unknown>,
  context: DocumentContext,
): PinnedDocument {
  const vat = (document['vat'] ?? {}) as { rateBp?: unknown };
  const lines = Array.isArray(document['lines']) ? document['lines'] : [];
  const charges = Array.isArray(document['charges']) ? document['charges'] : [];

  return {
    revision: typeof document['revision'] === 'number' ? document['revision'] : 0,
    documentHash: text(document['documentHash']),
    /* ⚠️ From the document, never from the browser. This is the whole of plan 10.6. */
    pinnedLocale: text(document['pinnedLocale']) || 'th',
    orderNo: context.orderNo,
    contactName: context.contactName,
    submittedAt: context.submittedAt,
    vatRateBp: typeof vat.rateBp === 'number' ? vat.rateBp : 0,
    leadTimeDays: typeof document['leadTimeDays'] === 'number' ? document['leadTimeDays'] : 0,
    netThbMinor: satang(document['netThbMinor'], 'ยอดก่อนภาษี'),
    vatThbMinor: satang(document['vatThbMinor'], 'ภาษี'),
    grandTotalThbMinor: satang(document['grandTotalThbMinor'], 'ยอดรวม'),
    lines: lines.map((raw, index) => {
      const line = raw as Record<string, unknown>;
      const measures = (line['measures'] ?? {}) as Record<string, { unit?: string; digits?: string }>;

      return {
        lineNo: typeof line['lineNo'] === 'number' ? line['lineNo'] : index + 1,
        nameTh: text(line['nameTh']),
        skuCode: text(line['skuCode']),
        qty: typeof line['qty'] === 'number' ? line['qty'] : 1,
        customerDescriptionTh:
          typeof line['customerDescriptionTh'] === 'string' ? line['customerDescriptionTh'] : null,
        /* ⭐ The pinned labels, not the `selections` codes — see `pinnedOptions`. */
        options: pinnedOptions(line['price']),
        /*
         * Measures arrive as tagged lengths — micrometres. Rendered as millimetres, which is
         * what a workshop drawing uses and what the customer was shown.
         */
        measures: Object.fromEntries(
          Object.entries(measures).map(([name, value]) => [
            name,
            `${(Number(value.digits ?? 0) / 1000).toLocaleString('th-TH')} mm`,
          ]),
        ),
        netMinor: satang(line['netMinor'], `บรรทัด ${String(index + 1)}`),
      };
    }),
    charges: charges.map((raw) => {
      const charge = raw as Record<string, unknown>;
      return {
        labelTh: text(charge['labelTh']) || text(charge['kind']),
        amountMinor: satang(charge['amountThbMinor'] ?? charge['amountMinor'], 'ค่าใช้จ่าย'),
      };
    }),
  };
}
