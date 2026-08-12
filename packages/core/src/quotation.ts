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

import { MINOR_EXPONENT, type Currency } from './money.js';

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
  /**
   * The same line in the presentment currency, or `null` on a baht quotation.
   *
   * Read from the document, never converted here — see `PinnedFx`. `null` and not `0n`: a
   * missing figure must not be printable as a free line.
   */
  readonly fxMinor: bigint | null;
}

export interface PinnedCharge {
  readonly labelTh: string;
  readonly amountMinor: bigint;
  /** As `PinnedLine.fxMinor`. */
  readonly fxMinor: bigint | null;
}

/**
 * ⭐ THE RATE THIS DOCUMENT WAS QUOTED AT, AND THE FIGURES IT PRODUCED.
 *
 * Present means **this quotation prints in `currency` and not in baht**. The baht figures on
 * `PinnedDocument` do not go away — they are the company's record and what the ledger posts —
 * but they are not what this page shows.
 *
 * Everything here is read out of the frozen document. Nothing on this type is derived, and in
 * particular no conversion happens in this module: `netMinor` and its neighbours were computed
 * once by the API at submit and frozen, for the reason this file's header gives about
 * arithmetic in a renderer being a second opinion about a contract term.
 */
export interface PinnedFx {
  readonly currency: Currency;
  readonly source: 'mid_market' | 'manual';
  /** Basis points actually applied — `0` on a manual override. */
  readonly spreadBp: number;
  /** ⚠️ For printing. The figures were produced by an exact ratio, not by this string. */
  readonly rateText: string;
  /** ISO 8601, or `null` for a manually-set rate, which has no market observation instant. */
  readonly observedAt: string | null;
  readonly netMinor: bigint;
  readonly vatMinor: bigint;
  readonly grandTotalMinor: bigint;
}

export interface PinnedDocument {
  readonly revision: number;
  readonly documentHash: string;
  /** ⚠️ Frozen at submit. The reader's language is never consulted. */
  readonly pinnedLocale: string;
  /** Frozen at submit; `null` on documents issued before the field existed. */
  readonly destinationCountry: string | null;
  /**
   * ⚠️ From the document, never from `tax_countries` — the same rule `pinnedLocale` follows
   * two fields above. That table is mutable; a quotation prints what was quoted.
   */
  readonly taxBasis: 'inclusive' | 'exclusive';
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
  /** `null` on a baht quotation, which is every domestic one and every one issued before 5c. */
  readonly fx: PinnedFx | null;
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

/** The rate, split into the parts a page renders — never re-derived from the figures. */
export interface PrintableFxRate {
  readonly currency: Currency;
  /** `'27.238806'` — baht per one whole unit of `currency`. */
  readonly rateText: string;
  /** The date the market was observed, in the document's calendar. `'—'` for a manual rate. */
  readonly observedAtText: string;
  /** True when a human set this rate rather than it coming from the market feed. */
  readonly isManual: boolean;
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
  /**
   * Whether the three money figures above are a breakdown of a price the customer already
   * saw, rather than tax added on top. It computes nothing new — every figure on this page
   * is already correct in the document — it only tells the renderer which sentence to put
   * beside the VAT line.
   */
  readonly vatIsIncluded: boolean;
  readonly lines: readonly PrintableLine[];
  readonly charges: readonly { readonly labelTh: string; readonly amountText: string }[];
  /**
   * ⭐ What every figure above is denominated in — `'THB'` unless the document pinned a rate.
   *
   * Every `*Text` on this type is already in this currency; a renderer that wanted to say so
   * in a heading reads it here rather than re-deriving it from a figure.
   */
  readonly currency: Currency;
  /**
   * ⭐ The rate, as a sentence's worth of parts, or `null` on a baht quotation.
   *
   * Present so the page can print *how* baht became this currency. Deliberately **not** the
   * baht figures beside the foreign ones: the owner's requirement is that the destination's
   * currency replaces baht, not that it sits next to it. What a reader needs in order to trust
   * the number is the rate it was struck at and when — not a second column to reconcile.
   */
  readonly fxRate: PrintableFxRate | null;
  /**
   * ⚠️ True when the pinned locale is one this build cannot render.
   *
   * A document pinned in a locale a later release removed still has to print, so it falls
   * back — and says so, because a reprint that is *not* faithful passing as one is worse
   * than a reprint that refuses.
   */
  readonly localeDegraded: boolean;
}

/**
 * The eight the API renders. Anything else falls back and says so.
 *
 * ⚠️ Hand-written, and pinned against drift from outside this package rather than
 * inside it: this is the storefront's locale list, but `@wewin/i18n` — which owns the
 * real one, `LOCALES` in `@wewin/i18n/locales` — depends on `@wewin/core`, so importing
 * it here would be a cycle. `packages/i18n/tests/quotation-locales.test.ts` is the one
 * place both lists are visible at once; it renders a pinned document in every locale
 * `@wewin/i18n` offers and fails if any of them comes back `localeDegraded`. Change
 * this set and that test is what will notice if the two have drifted again.
 */
const RENDERABLE = new Set(['th', 'en', 'zh', 'de', 'hi', 'my', 'vi', 'la']);

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
/*
 * ⚠️ Not `satangField` from `./money`, and not a duplicate of it either.
 *
 * `satangField` renders into a *text box*: no currency mark, no grouping, so the value it
 * writes is the value `readSatang` reads back. This one renders onto a *document*: it has
 * the ฿ and it groups thousands in the reader's locale, neither of which a field may carry.
 * They split digits the same way for the same reason, and merging them would break whichever
 * caller lost its half.
 */
/**
 * ⚠️ **The minor unit is a property of the currency, not the constant 100.**
 *
 * `MINOR_EXPONENT` calls itself "a fact, not a policy", and it is 0 for VND and LAK. Dividing
 * by a hardcoded `100n` — which is what this function did while baht was the only currency it
 * could be handed — renders ₫1,234,567 as "12,345.67", a figure a hundred times too small on
 * a document somebody transfers against. That is plan 4.3(c)'s named hazard, and the reason
 * the wire tags amounts `VND.dong` rather than `VND.minor`.
 *
 * ── The symbol ───────────────────────────────────────────────────────────────
 *
 * `฿` for baht, unchanged. The **ISO code** for everything else — `SGD 4,050.12`, not
 * `S$4,050.12` — because `$` is shared by a dozen currencies and a customer in Singapore
 * reading a Thai company's export quotation is exactly the reader who cannot afford to guess
 * which one is meant. The code is the disambiguation, and it is what a bank's transfer form
 * asks for.
 */
function money(minor: bigint, locale: string, currency: Currency): string {
  const negative = minor < 0n;
  const magnitude = negative ? -minor : minor;
  const exponent = MINOR_EXPONENT[currency];
  const per = exponent === 0 ? 1n : 100n;
  const symbol = currency === 'THB' ? '฿' : `${currency} `;

  const whole = (magnitude / per).toLocaleString(locale === 'th' ? 'th-TH' : locale, {
    maximumFractionDigits: 0,
  });

  /* A currency with no minor unit has no decimal point either — ₫1,234,567, not ₫1,234,567.00. */
  const fraction =
    exponent === 0 ? '' : `.${(magnitude % per).toString().padStart(exponent, '0')}`;

  return `${negative ? '-' : ''}${symbol}${whole}${fraction}`;
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

  /*
   * ⭐ ONE DECISION, MADE ONCE: which currency this page is in.
   *
   * `fx` present means the document was quoted for a destination that converts, and every
   * figure below prints from the pinned foreign amount instead of the baht one. Choosing per
   * figure — a foreign total over baht lines, say — is how a page ends up with two currencies
   * and no label, which is the failure this whole seam exists to avoid.
   *
   * ⚠️ Still no arithmetic. `pick` selects between two figures the document already holds; it
   * does not convert one into the other. The conversion happened once, at submit, and is
   * frozen. See this file's header.
   */
  /*
   * `?? null` and not a bare read, here and in `pick` below. The type says these are required,
   * but this function is reached from two apps and from fixtures that predate the field, and
   * the difference between `undefined` and `null` is invisible until `undefined !== null`
   * quietly takes the foreign branch and dereferences nothing. A renderer whose failure mode
   * is a blank page for every customer is worth two characters of paranoia.
   */
  const fx = document.fx ?? null;
  const currency: Currency = fx?.currency ?? 'THB';

  /*
   * A foreign document whose *line* has no pinned foreign figure falls back to the baht one
   * rather than printing nothing. That combination is not reachable from `priceOrderDocument`,
   * which writes `fxMinor` on every line whenever it writes `fx` — but a decoder is the wrong
   * place to assume an invariant it cannot check, and a visibly wrong currency on one line is
   * a page somebody questions, where a blank is a page somebody signs.
   */
  const pick = (thbMinor: bigint, minor: bigint | null | undefined): string =>
    fx !== null && minor !== null && minor !== undefined
      ? money(minor, locale, fx.currency)
      : money(thbMinor, locale, 'THB');

  return {
    currency,
    fxRate:
      fx === null
        ? null
        : {
            currency: fx.currency,
            rateText: fx.rateText,
            observedAtText: dateIn(fx.observedAt, locale),
            isManual: fx.source === 'manual',
          },
    revisionText: `#${String(document.revision)}`,
    documentHash: document.documentHash,
    /* A submitted order always has a number; the fallback is defensive, not expected. */
    orderNoText: document.orderNo ?? '—',
    contactName: document.contactName,
    submittedAtText: dateIn(document.submittedAt, locale),
    /* Basis points to percent, exactly — 700 is 7, and 725 would be 7.25. */
    vatRateText: `${String(document.vatRateBp / 100)}%`,
    leadTimeText: String(document.leadTimeDays),
    netText: pick(document.netThbMinor, fx?.netMinor ?? null),
    vatText: pick(document.vatThbMinor, fx?.vatMinor ?? null),
    grandTotalText: pick(document.grandTotalThbMinor, fx?.grandTotalMinor ?? null),
    vatIsIncluded: document.taxBasis === 'inclusive',
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
      netText: pick(line.netMinor, line.fxMinor),
    })),
    charges: document.charges.map((charge) => ({
      labelTh: charge.labelTh,
      amountText: pick(charge.amountMinor, charge.fxMinor),
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

/**
 * Minor units of the **presentment** currency, whose tag is `SGD.cent` / `VND.dong` — not
 * `THB.satang`, which is exactly what `satang` above refuses.
 *
 * ⚠️ Lenient where `satang` throws, and the asymmetry is deliberate. A missing baht total is a
 * document that cannot be printed at all. A missing or malformed foreign figure is a document
 * that can still be printed **in baht**, which is a worse page but a truthful one — `pick`
 * above falls back per figure. Throwing here would take a whole quotation off the air over a
 * presentation field.
 */
const foreignMinor = (value: unknown, currency: Currency): bigint | null => {
  if (typeof value !== 'object' || value === null) return null;
  const money = value as { unit?: unknown; digits?: unknown };
  if (typeof money.unit !== 'string' || !money.unit.startsWith(`${currency}.`)) return null;
  if (money.unit.includes('/')) return null; /* a rate tag, not an amount — `THB.satang/m2` */
  try {
    return BigInt(String(money.digits));
  } catch {
    return null;
  }
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
  const fx = pinnedFxFrom(document['fx']);

  return {
    revision: typeof document['revision'] === 'number' ? document['revision'] : 0,
    documentHash: text(document['documentHash']),
    /* ⚠️ From the document, never from the browser. This is the whole of plan 10.6. */
    pinnedLocale: text(document['pinnedLocale']) || 'th',
    /* Lenient, like its neighbours: a document older than the field is not a broken document. */
    destinationCountry: text(document['destinationCountry']) || null,
    taxBasis: document['taxBasis'] === 'inclusive' ? 'inclusive' : 'exclusive',
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
        fxMinor: fx === null ? null : foreignMinor(line['fxMinor'], fx.currency),
      };
    }),
    /*
     * ⚠️ `customerDescriptionTh` and `netMinor` — the field names `OrderDocumentChargeWire`
     * actually uses.
     *
     * This read used to be `charge['labelTh'] || charge['kind']` and
     * `charge['amountThbMinor'] ?? charge['amountMinor']`, none of which is a field the API
     * has ever written. The consequence was not a blank label: `satang(undefined)` throws, so
     * **every quotation carrying a delivery or installation charge failed to render for the
     * customer entirely** — the whole page, not the charge row.
     *
     * It survived because the fixture that tested it was written from an assumption about the
     * payload rather than from a captured one, which is the exact mistake this file's own
     * header records happening the first time round: *"that version's unit tests passed
     * against its own invented fixture and the page failed on the first real payload"*. The
     * fixture in `apps/web/tests/quotation/inclusive-layout.test.ts` is corrected alongside
     * this, and a charge is now priced through a real submit in the API's walkthrough test.
     */
    charges: charges.map((raw) => {
      const charge = raw as Record<string, unknown>;
      return {
        labelTh: text(charge['customerDescriptionTh']),
        amountMinor: satang(charge['netMinor'], 'ค่าใช้จ่าย'),
        fxMinor: fx === null ? null : foreignMinor(charge['fxMinor'], fx.currency),
      };
    }),
    fx,
  };
}

/**
 * The pinned rate off the wire, or `null` for the baht quotation that every document issued
 * before this field existed is.
 *
 * Lenient in the same shape as its neighbours, and for the sharper version of the same reason:
 * a document whose `fx` block is malformed still has correct baht figures, and printing those
 * is strictly better than refusing to print. It is `null` unless **all three** totals and the
 * currency read cleanly, so there is no half-converted page — either this document prints in
 * its foreign currency or it prints in baht, never a row of each.
 */
function pinnedFxFrom(raw: unknown): PinnedFx | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const block = raw as Record<string, unknown>;

  /*
   * ⚠️ `Object.hasOwn`, not `in`. `'toString' in MINOR_EXPONENT` is true — `in` walks the
   * prototype chain — so a document whose currency read `constructor` or `toString` would pass
   * the guard, be asserted to `Currency`, and index the table to a *function*. Nothing crashes;
   * `exponent === 0` is false for a function, so the page would quietly print every figure
   * divided by 100 under a currency label of `toString`. This is `redteam5f-proto`'s family of
   * bug arriving through a membership test rather than through an assignment.
   */
  const currency = text(block['currency']);
  if (!Object.hasOwn(MINOR_EXPONENT, currency) || currency === 'THB') return null;
  const known = currency as Currency;

  const netMinor = foreignMinor(block['netMinor'], known);
  const vatMinor = foreignMinor(block['vatMinor'], known);
  const grandTotalMinor = foreignMinor(block['grandTotalMinor'], known);
  if (netMinor === null || vatMinor === null || grandTotalMinor === null) return null;

  return {
    currency: known,
    source: block['source'] === 'manual' ? 'manual' : 'mid_market',
    spreadBp: typeof block['spreadBp'] === 'number' ? block['spreadBp'] : 0,
    rateText: text(block['rateText']),
    observedAt: typeof block['observedAt'] === 'string' ? block['observedAt'] : null,
    netMinor,
    vatMinor,
    grandTotalMinor,
  };
}
