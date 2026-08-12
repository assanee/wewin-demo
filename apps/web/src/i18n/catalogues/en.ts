import type { PartialUiCatalogue } from '../keys';

/**
 * English — the second complete catalogue, and the one that proves the mechanism.
 *
 * A single-language i18n layer proves nothing: every param could be in the wrong place
 * and every sentence would still read correctly. English is here because it disagrees
 * with Thai about things the scheme has to survive —
 *
 *   - **word order.** `ลด${group} ${step}` is one clause in Thai and needs the verb,
 *     the noun and the amount rearranged in English. A key that had baked the order in
 *     would show up here as an unwritable entry.
 *   - **units after numbers.** Thai puts `ตร.ม.` after the numeral with a space;
 *     English writes `m²` and puts `sq m` nowhere near where Thai does.
 *   - **the era.** Thai writes พ.ศ. 2569 for the year this page calls 2026. The year
 *     is the param and the era is the catalogue's business, which is only visible once
 *     a second catalogue disagrees.
 *   - **counted nouns.** Thai has no plural agreement, so `${n} รายการ` is one form
 *     and `1 item` / `2 items` is two. Entries that count pick their own form.
 *
 * Typed `PartialUiCatalogue` even though it happens to be complete: only Thai is
 * *required* to be complete, and typing this one as `UiCatalogue` would make adding a
 * Thai key a compile error in a file whose translator has not seen it yet.
 * `catalogue.test.ts` asserts the completeness this type does not.
 */
const count = (value: number, singular: string, plural: string): string =>
  value === 1 ? singular : plural;

export const en: PartialUiCatalogue = {
  /* ---- Shell and navigation ---------------------------------------- */
  'a11y.skipToContent': 'Skip to main content',
  'nav.mainLabel': 'Main menu',
  'nav.homeLabel': (p) => `${p.wordmark} home`,
  'nav.products': 'Products',
  'nav.about': 'About us',
  'nav.quote': 'Quote list',
  'nav.allProducts': 'See all products',
  'nav.backToProducts': 'Back to all products',
  'nav.addMore': 'Add another product',
  'quote.badge.filled': (p, f) =>
    `${f.integer(p.count)} ${count(p.count, 'item', 'items')} in your quote list`,
  'quote.badge.empty': 'Quote list is empty',

  /* ---- Money and measurement ---------------------------------------- */
  'price.perSqmSuffix': '/ m²',
  'price.from': 'From',
  'price.fromShort': 'From',
  'price.unit': 'Price each',
  'price.total': 'Total',
  'price.grandTotal': 'Grand total',
  'price.perPiece': (p, f) => `${f.baht(p.minor)} each`,
  'value.unknown': '—',
  'unit.sqmSuffix': 'm²',
  'count.pieces': (p, f) => `${f.integer(p.count)} ${count(p.count, 'piece', 'pieces')}`,
  'count.items': (p, f) => `${f.integer(p.count)} ${count(p.count, 'item', 'items')}`,
  'count.designs': (p, f) => `${f.integer(p.count)} ${count(p.count, 'design', 'designs')}`,
  'leadTime.range': (p, f) => `${f.integer(p.days[0])}–${f.integer(p.days[1])} days`,
  'leadTime.produce': (p, f) => `${f.integer(p.days[0])}–${f.integer(p.days[1])} days to make`,

  /* ---- Pickers ------------------------------------------------------ */
  'unit.pickerLabel': 'Unit',
  'unit.groupLabel': 'Unit sizes are shown in',
  'unit.name.mm': 'millimetres',
  'unit.name.cm': 'centimetres',
  'unit.name.m': 'metres',
  'unit.name.in': 'inches',
  'unit.name.ft': 'feet',
  'locale.pickerLabel': 'Language',
  'locale.groupLabel': 'Language this site is shown in',
  'locale.partial': 'Some text has not been translated yet and is shown in Thai.',

  /* ---- Home --------------------------------------------------------- */
  'home.hero.line1': 'Made to your opening',
  'home.hero.line2': 'See the price before you call',
  'home.hero.body':
    'Aluminium windows, louvres and doors. Enter the real width and height of your opening and see the full price straight away — no login, no phone number first.',
  'home.hero.cta': 'Browse products and price them',
  'home.fact.designs': 'Designs available',
  'home.fact.startingPrice': 'Starting price',
  'home.fact.leadTime': 'Production time',
  'home.how.heading': 'How this works',
  'home.how.body':
    'Seeing the price yourself before making contact is still unusual for made-to-order work. Here is what happens next.',
  'home.step.measure.title': 'Measure the opening and enter it',
  'home.step.measure.body':
    'Pick the design you want, then enter the real width × height of the opening.',
  'home.step.price.title': 'See the price at once',
  'home.step.price.body':
    'The full price appears immediately, with every line that makes it up shown separately.',
  'home.step.request.title': 'Request a quotation',
  'home.step.request.body':
    'Collect the items you are interested in and send them over. Nothing is committed at this stage.',
  'home.step.survey.title': 'Site survey before production',
  'home.step.survey.body': (p, f) =>
    `Our team measures on site to confirm the size and the price before production begins.${
      p.days === null
        ? ''
        : ` Production takes ${f.integer(p.days[0])}–${f.integer(p.days[1])} days depending on the design.`
    }`,
  'home.estimate.note':
    'The price on this site is an estimate from the figures you entered. The final price is confirmed after our team measures on site.',
  'home.estimate.emphasis': 'an estimate from the figures you entered',
  'home.categories.heading': 'Choose by type of work',
  'home.category.empty': 'No products in this category yet',
  'home.pricing.heading': 'How the price is worked out',
  'home.pricing.body':
    'All three of these are here because you should know them before entering a size, not when you see the final figure.',
  'home.pricing.formula.title': 'The formula',
  'home.pricing.formula.body': 'Price = price per m² × billable area + options',
  'home.pricing.formula.note':
    'Options are the profile colour, the glass colour and thickness, and any hardware you add. Every one of them is listed separately on the pricing page.',
  'home.pricing.floor.title': 'Minimum billable area',
  'home.pricing.floor.body': 'A panel smaller than the minimum is charged at the minimum area.',
  'home.pricing.floor.range': (p, f) =>
    p.span === null ? '—' : `${f.area(p.span[0])}–${f.area(p.span[1])} m²`,
  'home.pricing.floor.note':
    'depending on the design. The pricing page always states the minimum for the design you chose.',
  'home.pricing.excluded.title': 'Not included in this price',
  'home.pricing.excluded.install': 'Installation',
  'home.pricing.excluded.delivery': 'Delivery',
  'home.pricing.excluded.removal': 'Removing the old unit',
  'home.pricing.excluded.note':
    'All three depend on the site, so they cannot be estimated from a size alone. They appear in the quotation after the survey.',

  'meta.title': 'WEWIN180 — made to your measurements, priced before you ask',
  'meta.description':
    'WEWIN180 — windows, louvres and doors made to your own dimensions. Work out the price yourself before requesting a quotation.',

  /* ---- Catalogue ---------------------------------------------------- */
  'catalog.heading': 'All products',
  'catalog.resultCount': (p, f) =>
    `${f.integer(p.count)} ${count(p.count, 'product', 'products')}`,
  'catalog.empty.title': 'Nothing matches these filters yet',
  'catalog.empty.body': 'Try removing a filter or two and looking at everything again.',
  'filter.title': 'Filters',
  'filter.clear': 'Clear filters',
  'filter.showResults': (p, f) =>
    `Show results (${f.integer(p.count)} ${count(p.count, 'product', 'products')})`,
  'filter.section.category': 'Category',
  'filter.section.profileColor': 'Profile colour',
  'filter.section.pricePerSqm': 'Price per m²',
  'filter.priceTo': 'to',
  'filter.priceMax': 'No more than',
  'product.colorCount': (p, f) =>
    `${f.integer(p.count)} profile ${count(p.count, 'colour', 'colours')}`,
  'product.sizeRange': (p, f) => `Sizes ${f.range(p.minUm, p.maxUm, p.unit)}`,

  /* ---- Configurator -------------------------------------------------- */
  'configure.loadingLine': 'Loading this item…',
  'configure.spec.note':
    'For detailed specifications, standards and warranty terms, ask our team through the contact details below.',
  'configure.view.front': 'Front',
  'configure.view.halfPanel': 'Half panel',
  'configure.view.transom': 'Transom',
  'configure.size.heading': 'Size',
  'configure.area.line': (p, f) =>
    `Area ${f.area(p.areaSqUm)} m² · minimum charged ${f.area(p.minBillableSqUm)} m²`,
  'configure.group.affectsSku': 'affects the product code',
  'configure.futureQuote': 'Requesting a quotation will be added in the next version.',
  'configure.breakdown.title': 'Price breakdown',
  'configure.qty': 'Quantity',
  'configure.qty.decrease': 'Remove one piece',
  'configure.qty.increase': 'Add one piece',
  // Thai says `ลด${group} ${step}` as one clause; English needs the noun after the
  // verb and the amount after that. This is the entry that would be unwritable if the
  // key had shipped a pre-joined sentence.
  'measure.decrease': (p, f) => `Reduce ${p.group} by ${f.entry(p.stepUm, p.unit)}`,
  'measure.increase': (p, f) => `Increase ${p.group} by ${f.entry(p.stepUm, p.unit)}`,
  'measure.helper': (p, f) =>
    `${f.entryRange(p.minUm, p.maxUm, p.unit)} · steps of ${f.entry(p.gridUm, p.unit)}`,

  /* ---- Drawings ------------------------------------------------------- */
  'drawing.schematic': 'Proportion sketch',
  'drawing.schematic.sized': (p) => `Proportion sketch, ${p.size}`,
  'drawing.elevation': (p) =>
    `Elevation drawing, ${p.width} × ${p.height} ${p.unit}${
      p.invalid ? ' — this size is outside what can be made' : ''
    }`,
  'drawing.unitNote': (p) => `Unit: ${p.unit}`,

  /* ---- Toolbar, share, QR -------------------------------------------- */
  'toolbar.groupLabel': 'Manage this configuration',
  'toolbar.undo': 'Undo',
  'toolbar.redo': 'Redo',
  'toolbar.reset': 'Back to defaults',
  'toolbar.share': 'Share a link to this configuration',
  'toolbar.qr': 'Make a QR code for this link',
  'share.sheet.title': 'Share link',
  'share.qr.title': 'QR code for this link',
  'share.body':
    'This link opens the configurator with the same size and options you are looking at. Send it to your installer or to someone at home.',
  'share.copyLink': 'Copy link',
  'share.copied': 'Link copied',
  'share.showQr': 'Show as a QR code',
  'qr.alt': 'QR code for a link to this configuration',
  'qr.failed': 'The QR code could not be generated. Use the copy-link button instead.',

  /* ---- Price summary and breakdown ------------------------------------ */
  'summary.label': 'Price summary',
  'summary.skuCode': 'Product code',
  'summary.copySku': (p) => `Copy product code ${p.skuCode}`,
  'summary.skuCopied': 'Product code copied',
  'summary.add': 'Add to quote list',
  'summary.hasErrors': 'There is still something to fix above. Press the button to see what.',
  'summary.showBreakdown': 'See the price breakdown',
  'summary.area': (p, f) => `${f.area(p.areaSqUm)} m²`,
  'summary.stickyMeta': (p, f) =>
    `${f.area(p.areaSqUm)} m²${
      p.qty > 1 ? ` · ${f.integer(p.qty)} pieces` : ''
    } · see the breakdown`,
  'breakdown.minimumApplied': (p, f) =>
    `Actual area ${f.area(p.areaSqUm)} m² · charged at the ${f.area(p.minBillableSqUm)} m² minimum`,

  /* ---- Quote ---------------------------------------------------------- */
  'quote.heading': 'Quote list',
  'quote.empty.title': 'Nothing in your quote list yet',
  'quote.empty.body':
    'Pick a product, enter the real size of the opening, and add it here.',
  'quote.empty.cta': 'Pick a product',
  'quote.summary.label': 'Totals',
  'quote.summary.lineCount': 'Items',
  'quote.summary.lineCountValue': (p, f) =>
    `${f.integer(p.lines)} ${count(p.lines, 'item', 'items')} · ${f.integer(p.pieces)} ${count(
      p.pieces,
      'piece',
      'pieces',
    )}`,
  'quote.summary.leadTime': 'Production time',
  'quote.tableCaption': 'Items in your quote list',
  'quote.col.name': 'Item',
  'quote.col.sku': 'Product code',
  'quote.col.size': 'Size',
  'quote.col.qty': 'Qty',
  'quote.col.unitPrice': 'Price each',
  'quote.col.total': 'Total',
  'quote.col.actions': 'Actions',
  'quote.action.edit': (p) => `Edit the configuration of ${p.nickname}`,
  'quote.action.duplicate': (p) => `Duplicate ${p.nickname}`,
  'quote.action.remove': (p) => `Remove ${p.nickname}`,
  'quote.qty.label': (p) => `Quantity of ${p.nickname}`,
  'quote.qty.decrease': (p) => `Remove one piece of ${p.nickname}`,
  'quote.qty.increase': (p) => `Add one piece of ${p.nickname}`,

  /* ---- Toasts and sheets ----------------------------------------------- */
  'toast.lineSaved': 'Changes saved',
  'toast.lineAdded': 'Added to your quote list',
  'toast.viewQuote': 'View quote list',
  'toast.dismiss': 'Dismiss message',
  'sheet.close': 'Close',
  'sheet.closeNamed': (p) => `Close ${p.title}`,

  /* ---- About ------------------------------------------------------------ */
  'about.heading': 'About us',
  'about.intro':
    'We make aluminium joinery to the real dimensions of your site. Our factory is in Phitsanulok.',
  'about.tool':
    'This site is our own pricing tool. Enter the width and height of your opening and see the full price straight away, without contacting anyone first.',
  'about.stance.heading': 'Why we publish our prices',
  'about.stance.noPhone.title': 'Asking a price should not cost you your phone number',
  'about.stance.noPhone.body':
    'Most made-to-order work asks for your number before it gives you a figure, which means anyone who just wants a rough budget has to accept the call that follows. We removed that step.',
  'about.stance.itemised.title': 'A price should show where it came from',
  'about.stance.itemised.body':
    'The pricing page lists every line that makes up the total — area, colour, glass and hardware. When the figure changes, you can see what changed it.',
  'about.stance.limits.title': 'Limits stated up front, not afterwards',
  'about.stance.limits.body':
    'The minimum billable area, the sizes we cannot make, and what the price excludes are all on the site before you enter a size, rather than appearing during a conversation.',
  'about.range.heading': 'What we make',
  'about.range.body':
    'Every figure here is read from the same catalogue that calculates the prices. None of it is written down separately.',
  'about.fact.designs.note': (p, f) =>
    `across ${f.integer(p.categories)} ${count(p.categories, 'category', 'categories')}`,
  'about.fact.leadTime.note': 'depending on the design',
  'about.fact.floor': 'Minimum billable area',
  'about.fact.floor.note': 'smaller panels are charged at the minimum',
  'about.fact.legalName': 'Registered name',
  'about.fact.makes': 'What we make',
  'about.fact.serviceArea': 'Where we deliver',
  'about.contact.heading': 'Where we are and how to reach us',
  'about.card.factory': 'Factory and office',
  'about.card.delivery': 'Delivery and installation',
  'about.card.delivery.note':
    'Installation and delivery are not included in the prices on this site, because they depend on the site and the distance. Our team estimates them in the quotation.',
  'about.card.hours': 'Opening hours',
  'about.card.hours.note':
    'Outside opening hours, leave a message on LINE or by email and our team will reply on the next working day.',

  /* ---- Footer ------------------------------------------------------------ */
  'footer.contact': 'Contact us',
  'footer.hours': 'Opening hours',
  'footer.serviceArea': 'Service area',
  'footer.menu': 'Menu',
  // Gregorian, where Thai writes the Buddhist era from the same param.
  'footer.copyright': (p, f) => `© ${f.year(p.year)}`,

  /* ---- Contact channels and the spec sheet -------------------------------- */
  'contact.phone': 'Telephone',
  'contact.line': 'LINE',
  'contact.email': 'Email',
  'spec.material': 'Material',
  'spec.material.value': 'Extruded aluminium',
  'spec.profileThickness': 'Profile thickness',
  'spec.standards': 'Standards met',
  'spec.warranty': 'Warranty',

  /* ---- Reviews — plan section 9 --------------------------------------------- */
  'review.heading': 'Reviews from customers who had these installed',
  // The count is a counted noun here and one word in Thai — the asymmetry this catalogue
  // exists to prove. What neither language may do is drop it: plan 9.5.
  'review.summary': (p, f) =>
    `${f.rating(p.ratingSum, p.ratingCount)} out of 5 · ${f.integer(p.ratingCount)} ${count(Number(p.ratingCount), 'review', 'reviews')}`,
  'review.hiddenNote': (p, f) =>
    `${f.integer(p.hidden)} ${count(Number(p.hidden), 'review is', 'reviews are')} hidden for breaking the review policy — those ratings still count towards the average above`,
  'review.publishedOn': (p, f) => `Written ${f.date(p.at)}`,
  'review.author.anonymous': 'Customer',
  'review.size': (p, f) => `Ordered at ${f.dimensions(p.widthUm, p.heightUm, p.unit)}`,
  'review.erased':
    'The text and name on this review were removed at the author’s request. The rating still counts.',
  'review.reply.heading': 'Reply from WEWIN180',
  'review.reply.on': (p, f) => `Replied ${f.date(p.at)}`,
  'review.photo.alt': (p, f) => `Customer photo ${f.integer(p.index)}`,
  'review.more': (p, f) =>
    `and ${f.integer(p.remaining)} more ${count(Number(p.remaining), 'review', 'reviews')}`,

  'review.form.heading': 'Write a review',
  'review.form.for': (p) => `Reviewing ${p.name}`,
  'review.form.intro':
    'Aluminium is judged after a rainy season, not three days after installation — write whenever you are ready. This never closes.',
  'review.form.rating.legend': 'How many stars',
  'review.form.rating.option': (p, f) =>
    `${f.integer(p.stars)} ${count(p.stars, 'star', 'stars')}`,
  'review.form.rating.required': 'Choose a star rating before sending',
  'review.form.body.label': 'Tell us about it (optional)',
  'review.form.body.help':
    'Please leave out addresses, phone numbers and other people’s details — this is a public page.',
  'review.form.name.label': 'Name to show (optional)',
  'review.form.name.help': 'Shown beside your review. Initials are fine, so is leaving it blank.',
  'review.form.submit': 'Send review',
  'review.form.submitting': 'Sending…',
  'review.form.moderation':
    'Your review appears on the product page once we have read it, or on its own when the review window elapses.',
  'review.form.loading': 'Opening your invitation…',
  'review.form.invalid.title': 'This link does not work',
  'review.form.invalid.body':
    'It may already have been used, or copied incompletely. Try opening it from the invitation email again.',
  'review.form.failed.title': 'The review was not sent',
  'review.form.failed.body': 'Try again. If it still fails, reply to the invitation email.',
  'review.form.done.title': 'Thank you — we have your review',
  'review.form.done.body':
    'It will appear on the product page once it has been read, or when the review window elapses.',
  'review.meta.title': 'Write a review',

  'account.title': 'My account',
  'account.password.section': 'Change password',
  'account.password.current': 'Current password',
  'account.password.new': 'New password',
  'account.password.confirm': 'Confirm new password',
  'account.password.action': 'Change password',
  'account.password.saving': 'Changing…',
  'account.password.done': 'Password changed',
  'account.password.doneOthers': 'Password changed — and your other devices were signed out.',
  'account.password.note': 'Changing it signs out every other device you are signed in on. This one stays.',
  'account.password.problem.currentMissing': 'Please give your current password.',
  'account.password.problem.tooShort': 'The new password is too short — at least 12 characters.',
  'account.password.problem.sameAsCurrent': 'The new password must differ from the current one.',
  'account.password.problem.mismatch': 'The new password and its confirmation do not match.',
  'account.checking': 'Checking…',
  'account.needAccount': 'Sign in to request a quotation',
  'account.whyAccount':
    'So the quotation belongs to your account and opens on any device — registering takes a telephone number and a password.',
  'account.register': 'Create an account',
  'account.signIn': 'Sign in',
  'account.haveAccount': 'Already have an account?',
  'account.noAccount': 'No account yet?',
  'account.phone': 'Telephone',
  'account.username': 'Telephone or email',
  'account.usernameHint': 'The number you registered with, or your email if you already have an account.',
  'account.password': 'Password',
  'account.passwordHint': 'At least 12 characters.',
  'account.signedInAs': 'Signed in',
  'account.signOut': 'Sign out',
  'account.problem.badPhone': 'That telephone number cannot be read — e.g. 081-234-5678.',
  'account.problem.passwordTooShort': 'That password is too short — at least 12 characters.',
  'account.problem.unreachable': 'Cannot connect. Please try again.',
  'account.problem.unconfigured': 'Not available right now. Please contact the sales team.',
  'account.myQuotations': 'My quotations',
  'account.noQuotations': 'No quotations yet',

  'submit.heading': 'Request a quotation',
  'submit.intro':
    'Give us a name and one way to reach you, and we will issue the quotation immediately — the prices and details are frozen exactly as they appear in this cart.',
  'submit.name': 'Contact name',
  'submit.namePlaceholder': 'Full name',
  'submit.email': 'Email',
  'submit.phone': 'Telephone',
  'submit.channelHint': 'At least one of the two — a telephone number on its own is fine.',
  'submit.destination': 'Destination',
  'submit.action': 'Request a quotation',
  'submit.sending': 'Issuing the quotation…',
  'submit.problem.nameMissing': 'Please give a contact name.',
  'submit.problem.noChannel': 'Please give an email address or a telephone number.',
  'submit.problem.badPhone': 'That telephone number cannot be read — e.g. 081-234-5678.',
  'submit.problem.badEmail': 'That email address cannot be read.',
  'submit.problem.badDestination': 'Please choose a destination again — the previous choice is no longer on the list.',
  'submit.problem.unreachable': 'Cannot connect. Please try again.',
  'submit.problem.unconfigured': 'Requests cannot be taken right now. Please contact the sales team.',
  'submit.problem.unavailable':
    'Something in your cart is no longer available. Remove that line and try again.',
  'submit.done': 'Your quotation is ready',
  'submit.viewQuotation': 'Open the quotation',

  'quotation.meta.title': 'Your quotation',
  'quotation.loading': 'Opening your quotation…',
  'quotation.heading': 'Quotation',
  'quotation.unavailable.title': 'This quotation cannot be opened',
  'quotation.unavailable.body':
    'The link may have expired, or it may have been copied incompletely. Ask the sales team for a fresh one.',
  'quotation.unreachable.title': 'Cannot connect right now',
  'quotation.unreachable.body': 'Please try again. If it keeps failing, contact the sales team.',
  'quotation.retry': 'Try again',
  'quotation.print': 'Print or save as PDF',
  'quotation.orderNo': 'No.',
  'quotation.revision': 'Revision',
  'quotation.submittedAt': 'Confirmed on',
  'quotation.leadTime': 'Lead time (days)',
  'quotation.net': 'Before VAT',
  'quotation.vat': 'VAT',
  'quotation.vatIncluded': 'included in the price',
  'quotation.total': 'Total',
  'quotation.fx.rate': ({ currency, rateText }) => `Exchange rate 1 ${currency} = ${rateText} THB`,
  'quotation.fx.observedAt': ({ observedAt }) => `Rate observed ${observedAt}`,
  'quotation.fx.manual': 'Company-set rate',
  'quotation.fx.settlementNote': ({ currency }) => `The ${currency} figures above are the reference price. Payment is made in Thai baht, in the amount below.`,
  'quotation.fx.payable': 'Amount payable',
  'quotation.fx.deposit': 'Deposit due first',
  'quotation.lineNo': '#',
  'quotation.item': 'Item',
  'quotation.qty': 'Qty',
  'quotation.amount': 'Amount',
  'quotation.charges': 'Other charges',
  'quotation.pinnedNotice':
    'This document was pinned on the day it was confirmed — its figures and its language do not change when it is reopened.',
  'quotation.degraded': 'The pinned language is not available in this release, so it is shown in Thai.',
  'quotation.contact': 'To',
  'quotation.seller.phone': 'Telephone',
  'quotation.seller.taxId': 'Tax ID',

  /* ---- Display settings ------------------------------------------------------
   *
   * Translated here as well as in Thai because this is the one screen whose whole subject is
   * the reader's own language: a settings page that is only legible to somebody who already
   * reads Thai cannot be used by the person most likely to need it. The other six catalogues
   * stay empty, which is plan 13's state and not a placeholder.
   */
  'settings.nav': 'Display',
  'settings.heading': 'Display settings',
  'settings.intro':
    'Choose how this site is written for you: language, measurement unit and currency. All three are presentation only — the sizes you enter and the prices we calculate do not change with them.',
  'settings.meta.title': 'Display settings',

  'settings.language.legend': 'Language this site is written in',
  'settings.language.accountDiffers': (p) => `Your account is set to ${p.language}.`,
  'settings.language.applyAccount': 'Use my account language on this device',
  'settings.unit.legend': 'Unit sizes are shown in',
  'settings.currency.legend': 'Currency prices are shown in',
  'settings.currency.fixed': (p) => `Always ${p.currency}, in every language`,
  'settings.currency.why':
    'Every price is calculated and stored in Thai baht, and product pages are built once and shared by every visitor, so a per-person currency cannot be applied to them. Quoting an overseas customer in their own currency is a separate matter and is not switched on yet.',

  'settings.storage.local': 'Kept in this browser only',
  'settings.storage.account': (p, f) => `Saved to your account on ${f.date(p.at)}`,
  'settings.storage.signIn': 'Sign in to carry these settings to your other devices.',
  'settings.storage.saving': 'Saving',
  'settings.storage.failed': 'Could not save to your account. The choice still applies in this browser.',
  'settings.storage.forget': 'Delete the settings saved to my account',

  'settings.messages.heading': 'The language we write to you in',
  'settings.messages.degraded': (p) =>
    `${p.chosen} has not been translated yet, so messages from us will arrive in ${p.rendered}.`,
  'settings.messages.coverage': (p, f) =>
    `${f.plain(p.translated)} of ${f.plain(p.total)} messages translated`,

  'settings.effects.heading': 'What these settings change',
  'settings.effects.intro':
    'This list comes from the server rather than from this page, and it names the settings that do nothing yet instead of leaving you to find out.',
  'settings.effect.locale.notification': 'The language of emails we send you',
  'settings.effect.locale.document': 'The language of quotations and invoices already issued',
  'settings.effect.locale.storefront': 'The language of this website',
  'settings.effect.locale.dashboard': 'The language of the internal dashboard',
  'settings.effect.currency.notification': 'The currency in emails we send you',
  'settings.effect.currency.document': 'The currency on documents already issued',
  'settings.effect.currency.storefront': 'The currency of prices on this website',
  'settings.effect.currency.dashboard': 'The currency in the internal dashboard',
  'settings.effect.lengthUnit.notification': 'The unit in emails we send you',
  'settings.effect.lengthUnit.document': 'The unit on documents already issued',
  'settings.effect.lengthUnit.storefront': 'The unit sizes are shown in on this website',
  'settings.effect.lengthUnit.dashboard': 'The unit in the internal dashboard',
  'settings.effect.yes': 'Applies',
  'settings.effect.no': 'Does not apply yet',

  /* ---- Not found ----------------------------------------------------------- */
  'notFound.title': 'Page not found',
  'notFound.body': 'The link may have changed. Try starting from the product list.',

  /* ---- Paying, and attaching a slip ---------------------------------- */
  'payment.action': 'Make a payment',
  'payment.meta.title': 'Notify us of a payment',
  'payment.heading': 'Notify us of a payment',
  'payment.loading': 'Opening your payment details…',
  'payment.outstanding': 'Still owing',
  'payment.outstandingAmount': (p, f) => {
    const negative = p.owedMinor < 0n;
    const magnitude = negative ? -p.owedMinor : p.owedMinor;
    return `${negative ? '-' : ''}฿${f.plain(magnitude / 100n)}.${String(magnitude % 100n).padStart(2, '0')}`;
  },
  'payment.settled': 'This order is paid in full',
  'payment.account.legend': 'Transfer to any one of these accounts',
  'payment.account.copy': (p) => `Copy account number ${p.accountDigits}`,
  'payment.account.copied': 'Account number copied',
  'payment.account.qrAlt': 'PromptPay QR code for the amount entered',
  'payment.account.qrHint': 'Scan with your banking app — the amount is filled in for you',
  'payment.account.none':
    'No receiving account has been set up yet. Please contact the sales team for payment details.',
  'payment.form.legend': 'Attach the slip',
  'payment.form.image': 'Photo of the slip',
  'payment.form.imageHint': 'A screenshot from your banking app is fine. Up to 8 MB.',
  'payment.form.amount': 'Amount transferred',
  'payment.form.transferredAt': 'Date and time of the transfer',
  'payment.form.reference': 'Reference number (optional)',
  'payment.form.submit': 'Send the slip',
  'payment.phase.uploading': 'Uploading the photo…',
  'payment.phase.creating': 'Saving the slip…',
  'payment.done': 'We have your slip. Our team will check it and get back to you.',
  'payment.history.heading': 'Slips you have sent',
  'payment.history.empty': 'No slips sent yet',
  'payment.history.submitted': (p, f) => {
    const negative = p.slipMinor < 0n;
    const magnitude = negative ? -p.slipMinor : p.slipMinor;
    return `${negative ? '-' : ''}฿${f.plain(magnitude / 100n)}.${String(magnitude % 100n).padStart(2, '0')} · sent ${f.date(p.sentAt)} · being checked`;
  },
  'payment.history.accepted': (p, f) => {
    const negative = p.slipMinor < 0n;
    const magnitude = negative ? -p.slipMinor : p.slipMinor;
    return `${negative ? '-' : ''}฿${f.plain(magnitude / 100n)}.${String(magnitude % 100n).padStart(2, '0')} · sent ${f.date(p.sentAt)} · accepted`;
  },
  'payment.history.rejected': (p, f) => {
    const negative = p.slipMinor < 0n;
    const magnitude = negative ? -p.slipMinor : p.slipMinor;
    return `${negative ? '-' : ''}฿${f.plain(magnitude / 100n)}.${String(magnitude % 100n).padStart(2, '0')} · not accepted — ${p.reason}`;
  },
  'payment.problem.noImage': 'Please attach a photo of the slip.',
  'payment.problem.imageTooBig': (p, f) => `That photo is too large — up to ${f.plain(p.limitMib)} MB.`,
  'payment.problem.badAmount': 'Enter the amount as a number with at most two decimal places.',
  'payment.problem.badTime': 'Please give the date and time of the transfer.',
  'payment.problem.signInAgain': 'Your session expired. Please sign in again — what you typed is still here.',
  'payment.problem.unreachable': 'Cannot connect. Please try again.',
};
