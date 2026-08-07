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
