import type { LengthUnit } from '@wewin/core/units';
import type { Formatters } from './format';

/**
 * The storefront's own prose, as keys and the values each one interpolates.
 *
 * The same scheme `@wewin/core/message` established, applied to the half of the text
 * core never sees: headings, button labels, accessible names, the sentences on the
 * home page. `validation.ts` was not the only place building Thai out of a template
 * literal — `Configure.tsx` was writing `พื้นที่ ${formatSqm(...)} ตร.ม.` and
 * `PriceSummary.tsx` was writing `${formatSqm(...)} ตร.ม. · ราคายังไม่รวม VAT 7%`,
 * which is the same debt in a component.
 *
 * ## The rule, restated for this layer
 *
 * **A param is a value; the catalogue entry renders it.** An entry that needs a number
 * is a function of `(params, f)` where `f` is the locale's `Formatters` — so the entry
 * decides word order *and* where the number goes, and no locale is ever handed
 * `"฿8,791"` or `"5.12 ตร.ม."` as a substring to splice. Micrometres stay `bigint` the
 * whole way in; the first and only division happens inside `f`.
 *
 * A key that carries no values is a plain string, because making it a nullary function
 * would buy nothing and cost every catalogue a pair of parentheses on 90 entries.
 *
 * ## What is deliberately *not* here
 *
 * Product names, category labels, option labels, rule messages, the company's address.
 * Those are content, they are addressed by `ContentRef` in `content.ts`, and plan 13
 * says out loud that translating them is a person's job. Mixing them into this file
 * would turn a closed set of ~150 UI keys into an open-ended one that grows with the
 * catalogue.
 */

/** No values to interpolate — the entry is a plain string. */
type Plain = void;

export interface UiParamsByKey {
  /* ---- Shell and navigation ---------------------------------------- */
  'a11y.skipToContent': Plain;
  'nav.mainLabel': Plain;
  'nav.homeLabel': { wordmark: string };
  'nav.products': Plain;
  'nav.about': Plain;
  'nav.quote': Plain;
  'nav.allProducts': Plain;
  'nav.backToProducts': Plain;
  'nav.addMore': Plain;
  'quote.badge.filled': { count: number };
  'quote.badge.empty': Plain;

  /* ---- Money and measurement, shared across screens ----------------- */
  'price.vatExcluded': Plain;
  'price.vatExcludedShort': Plain;
  'price.perSqmSuffix': Plain;
  'price.from': Plain;
  'price.fromShort': Plain;
  'price.unit': Plain;
  'price.total': Plain;
  'price.grandTotal': Plain;
  'price.perPiece': { minor: bigint };
  'value.unknown': Plain;
  'unit.sqmSuffix': Plain;
  'count.pieces': { count: number };
  'count.items': { count: number };
  'count.designs': { count: number };
  'leadTime.range': { days: readonly [number, number] };
  'leadTime.produce': { days: readonly [number, number] };

  /* ---- Pickers ------------------------------------------------------ */
  'unit.pickerLabel': Plain;
  'unit.groupLabel': Plain;
  'unit.name.mm': Plain;
  'unit.name.cm': Plain;
  'unit.name.m': Plain;
  'unit.name.in': Plain;
  'unit.name.ft': Plain;
  'locale.pickerLabel': Plain;
  'locale.groupLabel': Plain;
  'locale.partial': Plain;

  /* ---- Home --------------------------------------------------------- */
  'home.hero.line1': Plain;
  'home.hero.line2': Plain;
  'home.hero.body': Plain;
  'home.hero.cta': Plain;
  'home.fact.designs': Plain;
  'home.fact.startingPrice': Plain;
  'home.fact.leadTime': Plain;
  'home.how.heading': Plain;
  'home.how.body': Plain;
  'home.step.measure.title': Plain;
  'home.step.measure.body': Plain;
  'home.step.price.title': Plain;
  'home.step.price.body': Plain;
  'home.step.request.title': Plain;
  'home.step.request.body': Plain;
  'home.step.survey.title': Plain;
  'home.step.survey.body': { days: readonly [number, number] | null };
  'home.estimate.note': Plain;
  'home.estimate.emphasis': Plain;
  'home.categories.heading': Plain;
  'home.category.empty': Plain;
  'home.pricing.heading': Plain;
  'home.pricing.body': Plain;
  'home.pricing.formula.title': Plain;
  'home.pricing.formula.body': Plain;
  'home.pricing.formula.note': Plain;
  'home.pricing.floor.title': Plain;
  'home.pricing.floor.body': Plain;
  'home.pricing.floor.range': { span: readonly [bigint, bigint] | null };
  'home.pricing.floor.note': Plain;
  'home.pricing.excluded.title': Plain;
  'home.pricing.excluded.vat': Plain;
  'home.pricing.excluded.install': Plain;
  'home.pricing.excluded.delivery': Plain;
  'home.pricing.excluded.removal': Plain;
  'home.pricing.excluded.note': Plain;

  /* ---- Document head --------------------------------------------------
   * The browser tab, the bookmark, the share card and the search snippet. Hard-coded
   * Thai in `index.html` until phase 6a, which meant every locale's tab said the same
   * Thai sentence and nothing in `<head>` can carry a `lang` to say so. */
  'meta.title': Plain;
  'meta.description': Plain;

  /* ---- Catalogue ---------------------------------------------------- */
  'catalog.heading': Plain;
  'catalog.resultCount': { count: number };
  'catalog.empty.title': Plain;
  'catalog.empty.body': Plain;
  'filter.title': Plain;
  'filter.clear': Plain;
  'filter.showResults': { count: number };
  'filter.section.category': Plain;
  'filter.section.profileColor': Plain;
  'filter.section.pricePerSqm': Plain;
  'filter.priceTo': Plain;
  'filter.priceMax': Plain;
  'product.colorCount': { count: number };
  'product.sizeRange': { minUm: bigint; maxUm: bigint; unit: LengthUnit };

  /* ---- Configurator -------------------------------------------------- */
  'configure.loadingLine': Plain;
  'configure.spec.note': Plain;
  'configure.view.front': Plain;
  'configure.view.halfPanel': Plain;
  'configure.view.transom': Plain;
  'configure.size.heading': Plain;
  'configure.area.line': { areaSqUm: bigint; minBillableSqUm: bigint };
  'configure.group.affectsSku': Plain;
  'configure.futureQuote': Plain;
  'configure.breakdown.title': Plain;
  'configure.qty': Plain;
  'configure.qty.decrease': Plain;
  'configure.qty.increase': Plain;
  'measure.decrease': { group: string; stepUm: bigint; unit: LengthUnit };
  'measure.increase': { group: string; stepUm: bigint; unit: LengthUnit };
  'measure.helper': { minUm: bigint; maxUm: bigint; gridUm: bigint; unit: LengthUnit };

  /* ---- Drawings ------------------------------------------------------- */
  'drawing.schematic': Plain;
  'drawing.schematic.sized': { size: string };
  'drawing.elevation': { width: string; height: string; unit: LengthUnit; invalid: boolean };
  'drawing.unitNote': { unit: LengthUnit };

  /* ---- Toolbar, share, QR -------------------------------------------- */
  'toolbar.groupLabel': Plain;
  'toolbar.undo': Plain;
  'toolbar.redo': Plain;
  'toolbar.reset': Plain;
  'toolbar.share': Plain;
  'toolbar.qr': Plain;
  'share.sheet.title': Plain;
  'share.qr.title': Plain;
  'share.body': Plain;
  'share.copyLink': Plain;
  'share.copied': Plain;
  'share.showQr': Plain;
  'qr.alt': Plain;
  'qr.failed': Plain;

  /* ---- Price summary and breakdown ------------------------------------ */
  'summary.label': Plain;
  'summary.skuCode': Plain;
  'summary.copySku': { skuCode: string };
  'summary.skuCopied': Plain;
  'summary.add': Plain;
  'summary.hasErrors': Plain;
  'summary.showBreakdown': Plain;
  'summary.areaAndVat': { areaSqUm: bigint };
  'summary.stickyMeta': { areaSqUm: bigint; qty: number };
  'breakdown.minimumApplied': { areaSqUm: bigint; minBillableSqUm: bigint };

  /* ---- Quote ---------------------------------------------------------- */
  'quote.heading': Plain;
  'quote.empty.title': Plain;
  'quote.empty.body': Plain;
  'quote.empty.cta': Plain;
  'quote.summary.label': Plain;
  'quote.summary.lineCount': Plain;
  'quote.summary.lineCountValue': { lines: number; pieces: number };
  'quote.summary.leadTime': Plain;
  'quote.tableCaption': Plain;
  'quote.col.name': Plain;
  'quote.col.sku': Plain;
  'quote.col.size': Plain;
  'quote.col.qty': Plain;
  'quote.col.unitPrice': Plain;
  'quote.col.total': Plain;
  'quote.col.actions': Plain;
  'quote.action.edit': { nickname: string };
  'quote.action.duplicate': { nickname: string };
  'quote.action.remove': { nickname: string };
  'quote.qty.label': { nickname: string };
  'quote.qty.decrease': { nickname: string };
  'quote.qty.increase': { nickname: string };

  /* ---- Toasts and sheets ----------------------------------------------- */
  'toast.lineSaved': Plain;
  'toast.lineAdded': Plain;
  'toast.viewQuote': Plain;
  'toast.dismiss': Plain;
  'sheet.close': Plain;
  'sheet.closeNamed': { title: string };

  /* ---- About ------------------------------------------------------------ */
  'about.heading': Plain;
  'about.intro': Plain;
  /** Labels for the two Thai company facts the intro no longer splices into itself. */
  'about.fact.legalName': Plain;
  'about.fact.makes': Plain;
  'about.fact.serviceArea': Plain;
  'about.tool': Plain;
  'about.stance.heading': Plain;
  'about.stance.noPhone.title': Plain;
  'about.stance.noPhone.body': Plain;
  'about.stance.itemised.title': Plain;
  'about.stance.itemised.body': Plain;
  'about.stance.limits.title': Plain;
  'about.stance.limits.body': Plain;
  'about.range.heading': Plain;
  'about.range.body': Plain;
  'about.fact.designs.note': { categories: number };
  'about.fact.startingPrice.note': Plain;
  'about.fact.leadTime.note': Plain;
  'about.fact.floor': Plain;
  'about.fact.floor.note': Plain;
  'about.contact.heading': Plain;
  'about.card.factory': Plain;
  'about.card.delivery': Plain;
  'about.card.delivery.note': Plain;
  'about.card.hours': Plain;
  'about.card.hours.note': Plain;

  /* ---- Footer ------------------------------------------------------------ */
  'footer.contact': Plain;
  'footer.hours': Plain;
  'footer.serviceArea': Plain;
  'footer.menu': Plain;
  'footer.copyright': { year: number };

  /* ---- Contact channels and the spec sheet -------------------------------- */
  'contact.phone': Plain;
  'contact.line': Plain;
  'contact.email': Plain;
  'spec.material': Plain;
  'spec.material.value': Plain;
  'spec.profileThickness': Plain;
  'spec.standards': Plain;
  'spec.warranty': Plain;

  /* ---- Reviews — plan section 9 ---------------------------------------------
   *
   * Two screens' worth of prose: the block on a product page, and the form a customer
   * reaches from their invitation.
   *
   * ⭐ **`review.summary` is one key on purpose, and it is the load-bearing one.** Plan 9.5
   * forbids showing an average without its count, and the enforcement is not a code review
   * — it is that the average and the count live in the *same catalogue entry*, rendered
   * from the same pair of integers by `f.rating(sum, count)` and `f.integer(count)`. A
   * translator cannot write one without the other because there is no second key to put
   * the other one in, and a component cannot render "5.0 ★" alone because no key produces
   * it. The database made the same move by having no average column; this is that decision
   * arriving at the last layer.
   */
  'review.heading': Plain;
  'review.summary': { ratingSum: bigint; ratingCount: bigint };
  /** Shown only when some ratings are hidden — plan 9.3: they still count, and we say so. */
  'review.hiddenNote': { hidden: bigint };
  'review.publishedOn': { at: Date };
  'review.author.anonymous': Plain;
  'review.size': { widthUm: bigint; heightUm: bigint; unit: LengthUnit };
  'review.erased': Plain;
  'review.reply.heading': Plain;
  'review.reply.on': { at: Date };
  'review.photo.alt': { index: number };
  'review.more': { remaining: bigint };

  'review.form.heading': Plain;
  'review.form.for': { name: string };
  'review.form.intro': Plain;
  'review.form.rating.legend': Plain;
  'review.form.rating.option': { stars: number };
  'review.form.rating.required': Plain;
  'review.form.body.label': Plain;
  'review.form.body.help': Plain;
  'review.form.name.label': Plain;
  'review.form.name.help': Plain;
  'review.form.submit': Plain;
  'review.form.submitting': Plain;
  'review.form.moderation': Plain;
  'review.form.loading': Plain;
  'review.form.invalid.title': Plain;
  'review.form.invalid.body': Plain;
  'review.form.failed.title': Plain;
  'review.form.failed.body': Plain;
  'review.form.done.title': Plain;
  'review.form.done.body': Plain;
  'review.meta.title': Plain;

  'account.title': Plain;
  'account.checking': Plain;
  'account.needAccount': Plain;
  'account.whyAccount': Plain;
  'account.register': Plain;
  'account.signIn': Plain;
  'account.haveAccount': Plain;
  'account.noAccount': Plain;
  'account.phone': Plain;
  'account.username': Plain;
  'account.usernameHint': Plain;
  'account.password': Plain;
  'account.passwordHint': Plain;
  'account.signedInAs': Plain;
  'account.signOut': Plain;
  'account.problem.badPhone': Plain;
  'account.problem.passwordTooShort': Plain;
  'account.problem.unreachable': Plain;
  'account.problem.unconfigured': Plain;
  'account.myQuotations': Plain;
  'account.noQuotations': Plain;

  'submit.heading': Plain;
  'submit.intro': Plain;
  'submit.name': Plain;
  'submit.namePlaceholder': Plain;
  'submit.email': Plain;
  'submit.phone': Plain;
  'submit.channelHint': Plain;
  'submit.action': Plain;
  'submit.sending': Plain;
  'submit.problem.nameMissing': Plain;
  'submit.problem.noChannel': Plain;
  'submit.problem.badPhone': Plain;
  'submit.problem.badEmail': Plain;
  'submit.problem.unreachable': Plain;
  'submit.problem.unconfigured': Plain;
  'submit.problem.unavailable': Plain;
  'submit.done': Plain;
  'submit.viewQuotation': Plain;

  'quotation.meta.title': Plain;
  'quotation.loading': Plain;
  'quotation.heading': Plain;
  'quotation.unavailable.title': Plain;
  'quotation.unavailable.body': Plain;
  'quotation.unreachable.title': Plain;
  'quotation.unreachable.body': Plain;
  'quotation.retry': Plain;
  'quotation.print': Plain;
  'quotation.orderNo': Plain;
  'quotation.revision': Plain;
  'quotation.submittedAt': Plain;
  'quotation.leadTime': Plain;
  'quotation.net': Plain;
  'quotation.vat': Plain;
  'quotation.total': Plain;
  'quotation.lineNo': Plain;
  'quotation.item': Plain;
  'quotation.qty': Plain;
  'quotation.amount': Plain;
  'quotation.charges': Plain;
  'quotation.pinnedNotice': Plain;
  'quotation.degraded': Plain;
  'quotation.contact': Plain;

  /* ---- Display settings — plan 4.1/4.2, 8.2 trap 3 and 10.6 -------------------
   *
   * The screen where a reader states how they want the site written, and — the half that
   * matters more — where the site states what each choice actually changes.
   *
   * ⭐ **`settings.effect.*` is one key per statement the API sends, and that is the whole
   * mechanism.** `GET /me/preferences` answers with twelve `{preference, surface, honoured}`
   * rows, eight of which are `false` today for four separate and individually correct reasons
   * (a document is pinned at submit, the storefront is prerendered, the ledger is in baht, and
   * plan 13 keeps the foreign-currency line closed). A screen that decided locally which
   * settings "work" would be a second opinion that goes stale the day one of them changes; a
   * screen with no such sentences at all would be a form that saves a currency nobody will
   * ever render and says "saved".
   *
   * So the component renders the API's list and looks each row's sentence up here. There is no
   * key that says a preference is honoured in general, because no such fact exists.
   */
  'settings.nav': Plain;
  'settings.heading': Plain;
  'settings.intro': Plain;
  'settings.meta.title': Plain;

  'settings.language.legend': Plain;
  /**
   * Shown when the account says one language and this device is on another.
   *
   * ⚠️ The divergence is **surfaced, never resolved silently**, and that is a decision. The
   * storefront does not check for a session on any other page — doing so would put a
   * `POST /auth/refresh` in front of every first paint on a site whose whole pitch is that you
   * can price a window without signing in — so the account preference reaches a device only by
   * being copied into the cookie and the storage key the anonymous mechanisms already read.
   * Copying the *language* half automatically would navigate a reader away from the page they
   * just opened, and would keep doing it every time they used the header's language picker,
   * which does not write to the account. So it is a line of text and a button.
   */
  'settings.language.accountDiffers': { language: string };
  'settings.language.applyAccount': Plain;
  'settings.unit.legend': Plain;
  'settings.currency.legend': Plain;
  /** ⚠️ Currency is a fact on this screen, not a control. See `settings.currency.fixed`. */
  'settings.currency.fixed': { currency: string };
  'settings.currency.why': Plain;

  /* Where the choice is kept, which is the entire product difference between the two states. */
  'settings.storage.local': Plain;
  'settings.storage.account': { at: Date };
  'settings.storage.signIn': Plain;
  'settings.storage.saving': Plain;
  'settings.storage.failed': Plain;
  'settings.storage.forget': Plain;

  /* Plan 10.6, live half: the language a message would actually arrive in. */
  'settings.messages.heading': Plain;
  'settings.messages.degraded': { chosen: string; rendered: string };
  'settings.messages.coverage': { translated: number; total: number };

  'settings.effects.heading': Plain;
  'settings.effects.intro': Plain;
  'settings.effect.locale.notification': Plain;
  'settings.effect.locale.document': Plain;
  'settings.effect.locale.storefront': Plain;
  'settings.effect.locale.dashboard': Plain;
  'settings.effect.currency.notification': Plain;
  'settings.effect.currency.document': Plain;
  'settings.effect.currency.storefront': Plain;
  'settings.effect.currency.dashboard': Plain;
  'settings.effect.lengthUnit.notification': Plain;
  'settings.effect.lengthUnit.document': Plain;
  'settings.effect.lengthUnit.storefront': Plain;
  'settings.effect.lengthUnit.dashboard': Plain;
  'settings.effect.yes': Plain;
  'settings.effect.no': Plain;

  /* ---- Not found ----------------------------------------------------------- */
  'notFound.title': Plain;
  'notFound.body': Plain;
}

export type UiKey = keyof UiParamsByKey;

/**
 * How one catalogue entry is written.
 *
 * `[P] extends [void]` rather than `P extends void`: the naked form distributes over a
 * union and would quietly turn an entry whose params are `A | void` into a union of a
 * string and a function. Wrapping both sides in a tuple stops the distribution.
 */
export type UiEntry<P> = [P] extends [void] ? string : (params: P, f: Formatters) => string;

/** A complete catalogue. Only Thai is required to be one — Thai is the source. */
export type UiCatalogue = { readonly [K in UiKey]: UiEntry<UiParamsByKey[K]> };

/**
 * An incomplete catalogue, which is what seven of the eight are entitled to be.
 *
 * Written as a mapped type rather than `Partial<UiCatalogue>` so that each optional
 * entry keeps its own param type: a German entry for `'catalog.resultCount'` still has
 * to be a function of `{ count: number }`, and writing it as a plain string is a
 * compile error rather than a number that vanishes from the page.
 */
export type PartialUiCatalogue = { readonly [K in UiKey]?: UiEntry<UiParamsByKey[K]> };

/** Keys that carry nothing, split out so `t` can take one argument for them. */
export type PlainKey = { [K in UiKey]: UiParamsByKey[K] extends void ? K : never }[UiKey];

/** Keys that carry values, and therefore require them at the call site. */
export type ParamKey = Exclude<UiKey, PlainKey>;
