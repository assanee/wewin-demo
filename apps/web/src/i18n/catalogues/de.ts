import type { PartialUiCatalogue } from '../keys';

/**
 * German (Deutsch) — complete.
 *
 * ⚠️ **This file used to say "empty on purpose", and that note was right until it was not.**
 * It argued that a plausible-looking sentence nobody in the company can read back is worse
 * than a visible fallback. The argument still holds for *content* — product names, rule
 * messages, the catalogue — which is why `content.ts` still routes those through
 * `ContentRef` and why plan 13's bottleneck is unchanged. What changed is that the UI
 * shell, a closed set of 346 keys, was translated on request and is treated as shipped.
 *
 * ── What this catalogue has to get right that Thai does not ──────────────────
 *
 *   - **Plural agreement.** Thai has none: `${n} รายการ` is one form. German needs
 *     `1 Artikel` / `2 Artikel` (invariant) but `1 Produkt` / `2 Produkte`,
 *     `1 Farbe` / `2 Farben`, `1 Bewertung` / `2 Bewertungen`. The `count` helper below
 *     is the same shape English uses, for the same reason.
 *   - **Sie, throughout.** A quotation is a commercial document; `du` would be wrong on it.
 *   - **MwSt., not VAT.** 7 % with a non-breaking space before the sign, which is the German
 *     convention and is not what English does.
 *   - **The era.** `f.year` renders the Gregorian year here and พ.ศ. in Thai from the same
 *     param. Nothing in this file does arithmetic on a year.
 *   - **The decimal comma.** It is never written literally here — every number goes through
 *     `f`, which is what makes `1.234,56` appear without this file knowing it should.
 *
 * ⚠️ The exception is `f.entry` / `f.entryRange`, which stay ASCII with an ASCII point in
 * all eight languages. They label a field the customer types back into, and `parseMeasure`
 * accepts one separator. A German helper line reading `Schritte von 0,5` above a field that
 * silently discards `320,5` is the bug that distinction exists to prevent.
 */
const count = (value: number, singular: string, plural: string): string =>
  value === 1 ? singular : plural;

export const de: PartialUiCatalogue = {
  /* ---- Shell and navigation ---------------------------------------- */
  'a11y.skipToContent': 'Zum Hauptinhalt springen',
  'nav.mainLabel': 'Hauptmenü',
  'nav.homeLabel': (p) => `${p.wordmark} Startseite`,
  'nav.products': 'Produkte',
  'nav.about': 'Über uns',
  'nav.quote': 'Angebotsliste',
  'nav.allProducts': 'Alle Produkte ansehen',
  'nav.backToProducts': 'Zurück zu allen Produkten',
  'nav.addMore': 'Weiteres Produkt hinzufügen',
  'quote.badge.filled': (p, f) =>
    `${f.integer(p.count)} ${count(p.count, 'Artikel', 'Artikel')} in Ihrer Angebotsliste`,
  'quote.badge.empty': 'Angebotsliste ist leer',

  /* ---- Money and measurement ---------------------------------------- */
  'price.perSqmSuffix': '/ m²',
  'price.from': 'Ab',
  'price.fromShort': 'Ab',
  'price.unit': 'Stückpreis',
  'price.total': 'Summe',
  'price.grandTotal': 'Gesamtsumme',
  'price.perPiece': (p, f) => `${f.baht(p.minor)} pro Stück`,
  'value.unknown': '—',
  'unit.sqmSuffix': 'm²',
  'count.pieces': (p, f) => `${f.integer(p.count)} ${count(p.count, 'Stück', 'Stück')}`,
  'count.items': (p, f) => `${f.integer(p.count)} ${count(p.count, 'Artikel', 'Artikel')}`,
  'count.designs': (p, f) => `${f.integer(p.count)} ${count(p.count, 'Ausführung', 'Ausführungen')}`,
  'leadTime.range': (p, f) => `${f.integer(p.days[0])}–${f.integer(p.days[1])} Tage`,
  'leadTime.produce': (p, f) =>
    `${f.integer(p.days[0])}–${f.integer(p.days[1])} Tage Fertigungszeit`,

  /* ---- Pickers ------------------------------------------------------ */
  'unit.pickerLabel': 'Einheit',
  'unit.groupLabel': 'Maße werden angezeigt in',
  'unit.name.mm': 'Millimeter',
  'unit.name.cm': 'Zentimeter',
  'unit.name.m': 'Meter',
  'unit.name.in': 'Zoll',
  'unit.name.ft': 'Fuß',
  'locale.pickerLabel': 'Sprache',
  'locale.groupLabel': 'Sprache dieser Website',
  'locale.partial': 'Ein Teil des Textes ist noch nicht übersetzt und wird auf Thai angezeigt.',

  /* ---- Home --------------------------------------------------------- */
  'home.hero.line1': 'Gefertigt nach Ihrer Öffnung',
  'home.hero.line2': 'Den Preis sehen, bevor Sie anrufen',
  'home.hero.body':
    'Fenster, Lamellenfenster und Türen aus Aluminium. Geben Sie die tatsächliche Breite und Höhe Ihrer Öffnung ein und sehen Sie sofort den vollständigen Preis — ohne Anmeldung, ohne vorher eine Telefonnummer zu hinterlassen.',
  'home.hero.cta': 'Produkte ansehen und Preis berechnen',
  'home.fact.designs': 'Verfügbare Ausführungen',
  'home.fact.startingPrice': 'Ab-Preis',
  'home.fact.leadTime': 'Fertigungszeit',
  'home.how.heading': 'So funktioniert es',
  'home.how.body':
    'Bei Maßanfertigungen ist es noch immer ungewöhnlich, den Preis selbst zu sehen, bevor man Kontakt aufnimmt. Das passiert als Nächstes.',
  'home.step.measure.title': 'Öffnung messen und eingeben',
  'home.step.measure.body':
    'Wählen Sie die gewünschte Ausführung und geben Sie die tatsächliche Breite × Höhe der Öffnung ein.',
  'home.step.price.title': 'Den Preis sofort sehen',
  'home.step.price.body':
    'Der vollständige Preis erscheint unmittelbar, mit jeder einzelnen Position getrennt ausgewiesen.',
  'home.step.request.title': 'Angebot anfordern',
  'home.step.request.body':
    'Sammeln Sie die Artikel, die Sie interessieren, und senden Sie sie uns. In diesem Schritt gehen Sie keine Verpflichtung ein.',
  'home.step.survey.title': 'Aufmaß vor Ort vor der Fertigung',
  'home.step.survey.body': (p, f) =>
    `Unser Team misst vor Ort nach und bestätigt Maß und Preis, bevor die Fertigung beginnt.${
      p.days === null
        ? ''
        : ` Die Fertigung dauert je nach Ausführung ${f.integer(p.days[0])}–${f.integer(p.days[1])} Tage.`
    }`,
  'home.estimate.note':
    'Der Preis auf dieser Website ist eine Schätzung auf Grundlage der von Ihnen eingegebenen Maße. Der endgültige Preis wird nach dem Aufmaß durch unser Team bestätigt.',
  'home.estimate.emphasis': 'eine Schätzung auf Grundlage der von Ihnen eingegebenen Maße',
  'home.categories.heading': 'Nach Art der Arbeit auswählen',
  'home.category.empty': 'In dieser Kategorie gibt es noch keine Produkte',
  'home.pricing.heading': 'Wie der Preis zustande kommt',
  'home.pricing.body':
    'Alle drei Punkte stehen hier, weil Sie sie kennen sollten, bevor Sie ein Maß eingeben — und nicht erst, wenn Sie die Endsumme sehen.',
  'home.pricing.formula.title': 'Die Formel',
  'home.pricing.formula.body': 'Preis = Preis pro m² × berechnete Fläche + Optionen',
  'home.pricing.formula.note':
    'Zu den Optionen gehören die Profilfarbe, Farbe und Stärke des Glases sowie zusätzliche Beschläge. Jede einzelne davon wird auf der Preisseite gesondert aufgeführt.',
  'home.pricing.floor.title': 'Mindestberechnungsfläche',
  'home.pricing.floor.body':
    'Ein Element unterhalb des Mindestmaßes wird mit der Mindestfläche berechnet.',
  'home.pricing.floor.range': (p, f) =>
    p.span === null ? '—' : `${f.area(p.span[0])}–${f.area(p.span[1])} m²`,
  'home.pricing.floor.note':
    'je nach Ausführung. Die Preisseite nennt stets die Mindestfläche der von Ihnen gewählten Ausführung.',
  'home.pricing.excluded.title': 'Nicht in diesem Preis enthalten',
  'home.pricing.excluded.install': 'Montage',
  'home.pricing.excluded.delivery': 'Lieferung',
  'home.pricing.excluded.removal': 'Ausbau des alten Elements',
  'home.pricing.excluded.note':
    'Alle drei hängen von den Gegebenheiten vor Ort ab und lassen sich daher nicht allein aus einem Maß schätzen. Sie erscheinen nach dem Aufmaß im Angebot.',

  'meta.title': 'WEWIN180 — nach Maß gefertigt, Preis vor der Anfrage',
  'meta.description':
    'WEWIN180 — Fenster, Lamellenfenster und Türen nach Ihren eigenen Maßen. Berechnen Sie den Preis selbst, bevor Sie ein Angebot anfordern.',

  /* ---- Catalogue ---------------------------------------------------- */
  'catalog.heading': 'Alle Produkte',
  'catalog.resultCount': (p, f) =>
    `${f.integer(p.count)} ${count(p.count, 'Produkt', 'Produkte')}`,
  'catalog.empty.title': 'Zu diesen Filtern passt noch nichts',
  'catalog.empty.body':
    'Entfernen Sie ein oder zwei Filter und sehen Sie sich wieder alles an.',
  'filter.title': 'Filter',
  'filter.clear': 'Filter zurücksetzen',
  'filter.showResults': (p, f) =>
    `Ergebnisse anzeigen (${f.integer(p.count)} ${count(p.count, 'Produkt', 'Produkte')})`,
  'filter.section.category': 'Kategorie',
  'filter.section.profileColor': 'Profilfarbe',
  'filter.section.pricePerSqm': 'Preis pro m²',
  'filter.priceTo': 'bis',
  'filter.priceMax': 'Höchstens',
  'product.colorCount': (p, f) =>
    `${f.integer(p.count)} ${count(p.count, 'Profilfarbe', 'Profilfarben')}`,
  'product.sizeRange': (p, f) => `Maße ${f.range(p.minUm, p.maxUm, p.unit)}`,

  /* ---- Configurator -------------------------------------------------- */
  'configure.loadingLine': 'Dieser Artikel wird geladen…',
  'configure.spec.note':
    'Ausführliche technische Daten, Normen und Garantiebedingungen erhalten Sie von unserem Team über die Kontaktdaten unten.',
  'configure.view.front': 'Ansicht',
  'configure.view.halfPanel': 'Halbes Element',
  'configure.view.transom': 'Oberlicht',
  'configure.size.heading': 'Maß',
  'configure.area.line': (p, f) =>
    `Fläche ${f.area(p.areaSqUm)} m² · mindestens berechnet ${f.area(p.minBillableSqUm)} m²`,
  'configure.group.affectsSku': 'wirkt sich auf die Artikelnummer aus',
  'configure.futureQuote': 'Die Angebotsanfrage folgt in der nächsten Version.',
  'configure.breakdown.title': 'Preisaufstellung',
  'configure.qty': 'Menge',
  'configure.qty.decrease': 'Ein Stück entfernen',
  'configure.qty.increase': 'Ein Stück hinzufügen',
  // Thai says `ลด${group} ${step}` as one clause; German puts the object after the verb
  // and the amount after `um`. The key carries the parts, so this is writable.
  'measure.decrease': (p, f) => `${p.group} um ${f.entry(p.stepUm, p.unit)} verringern`,
  'measure.increase': (p, f) => `${p.group} um ${f.entry(p.stepUm, p.unit)} vergrößern`,
  'measure.helper': (p, f) =>
    `${f.entryRange(p.minUm, p.maxUm, p.unit)} · Schritte von ${f.entry(p.gridUm, p.unit)}`,

  /* ---- Drawings ------------------------------------------------------- */
  'drawing.schematic': 'Proportionsskizze',
  'drawing.schematic.sized': (p) => `Proportionsskizze, ${p.size}`,
  'drawing.elevation': (p) =>
    `Ansichtszeichnung, ${p.width} × ${p.height} ${p.unit}${
      p.invalid ? ' — dieses Maß liegt außerhalb des Fertigbaren' : ''
    }`,
  'drawing.unitNote': (p) => `Einheit: ${p.unit}`,

  /* ---- Toolbar, share, QR -------------------------------------------- */
  'toolbar.groupLabel': 'Diese Konfiguration verwalten',
  'toolbar.undo': 'Rückgängig',
  'toolbar.redo': 'Wiederherstellen',
  'toolbar.reset': 'Zurück zu den Standardwerten',
  'toolbar.share': 'Link zu dieser Konfiguration teilen',
  'toolbar.qr': 'QR-Code für diesen Link erstellen',
  'share.sheet.title': 'Link teilen',
  'share.qr.title': 'QR-Code für diesen Link',
  'share.body':
    'Dieser Link öffnet den Konfigurator mit genau dem Maß und den Optionen, die Sie gerade sehen. Senden Sie ihn an Ihren Monteur oder nach Hause.',
  'share.copyLink': 'Link kopieren',
  'share.copied': 'Link kopiert',
  'share.showQr': 'Als QR-Code anzeigen',
  'qr.alt': 'QR-Code für einen Link zu dieser Konfiguration',
  'qr.failed':
    'Der QR-Code konnte nicht erzeugt werden. Verwenden Sie stattdessen die Schaltfläche zum Kopieren des Links.',

  /* ---- Price summary and breakdown ------------------------------------ */
  'summary.label': 'Preisübersicht',
  'summary.skuCode': 'Artikelnummer',
  'summary.copySku': (p) => `Artikelnummer ${p.skuCode} kopieren`,
  'summary.skuCopied': 'Artikelnummer kopiert',
  'summary.add': 'Zur Angebotsliste hinzufügen',
  'summary.hasErrors':
    'Oben ist noch etwas zu korrigieren. Drücken Sie die Schaltfläche, um zu sehen, was.',
  'summary.showBreakdown': 'Preisaufstellung ansehen',
  'summary.area': (p, f) => `${f.area(p.areaSqUm)} m²`,
  'summary.stickyMeta': (p, f) =>
    `${f.area(p.areaSqUm)} m²${
      p.qty > 1 ? ` · ${f.integer(p.qty)} Stück` : ''
    } · Aufstellung ansehen`,
  'breakdown.minimumApplied': (p, f) =>
    `Tatsächliche Fläche ${f.area(p.areaSqUm)} m² · berechnet mit der Mindestfläche von ${f.area(
      p.minBillableSqUm,
    )} m²`,

  /* ---- Quote ---------------------------------------------------------- */
  'quote.heading': 'Angebotsliste',
  'quote.empty.title': 'Ihre Angebotsliste ist noch leer',
  'quote.empty.body':
    'Wählen Sie ein Produkt, geben Sie das tatsächliche Maß der Öffnung ein und fügen Sie es hier hinzu.',
  'quote.empty.cta': 'Produkt auswählen',
  'quote.summary.label': 'Summen',
  'quote.summary.lineCount': 'Artikel',
  'quote.summary.lineCountValue': (p, f) =>
    `${f.integer(p.lines)} ${count(p.lines, 'Artikel', 'Artikel')} · ${f.integer(p.pieces)} ${count(
      p.pieces,
      'Stück',
      'Stück',
    )}`,
  'quote.summary.leadTime': 'Fertigungszeit',
  'quote.tableCaption': 'Artikel in Ihrer Angebotsliste',
  'quote.col.name': 'Artikel',
  'quote.col.sku': 'Artikelnummer',
  'quote.col.size': 'Maß',
  'quote.col.qty': 'Menge',
  'quote.col.unitPrice': 'Stückpreis',
  'quote.col.total': 'Summe',
  'quote.col.actions': 'Aktionen',
  'quote.action.edit': (p) => `Konfiguration von ${p.nickname} bearbeiten`,
  'quote.action.duplicate': (p) => `${p.nickname} duplizieren`,
  'quote.action.remove': (p) => `${p.nickname} entfernen`,
  'quote.qty.label': (p) => `Menge von ${p.nickname}`,
  'quote.qty.decrease': (p) => `Ein Stück von ${p.nickname} entfernen`,
  'quote.qty.increase': (p) => `Ein Stück von ${p.nickname} hinzufügen`,

  /* ---- Toasts and sheets ----------------------------------------------- */
  'toast.lineSaved': 'Änderungen gespeichert',
  'toast.lineAdded': 'Zur Angebotsliste hinzugefügt',
  'toast.viewQuote': 'Angebotsliste ansehen',
  'toast.dismiss': 'Meldung schließen',
  'sheet.close': 'Schließen',
  'sheet.closeNamed': (p) => `${p.title} schließen`,

  /* ---- About ------------------------------------------------------------ */
  'about.heading': 'Über uns',
  'about.intro':
    'Wir fertigen Aluminiumbauteile nach den tatsächlichen Maßen Ihres Objekts. Unsere Fertigung befindet sich in Phitsanulok.',
  'about.tool':
    'Diese Website ist unser eigenes Kalkulationswerkzeug. Geben Sie Breite und Höhe Ihrer Öffnung ein und sehen Sie sofort den vollständigen Preis, ohne vorher jemanden kontaktieren zu müssen.',
  'about.stance.heading': 'Warum wir unsere Preise veröffentlichen',
  'about.stance.noPhone.title':
    'Eine Preisauskunft sollte Sie nicht Ihre Telefonnummer kosten',
  'about.stance.noPhone.body':
    'Bei Maßanfertigungen wird meist die Telefonnummer verlangt, bevor eine Zahl genannt wird — wer nur ein grobes Budget sucht, muss den Anruf danach in Kauf nehmen. Diesen Schritt haben wir gestrichen.',
  'about.stance.itemised.title': 'Ein Preis sollte zeigen, woher er kommt',
  'about.stance.itemised.body':
    'Die Preisseite führt jede Position auf, aus der sich die Summe zusammensetzt — Fläche, Farbe, Glas und Beschläge. Ändert sich die Zahl, sehen Sie, wodurch.',
  'about.stance.limits.title': 'Grenzen vorher nennen, nicht hinterher',
  'about.stance.limits.body':
    'Die Mindestberechnungsfläche, die Maße, die wir nicht fertigen können, und das, was der Preis nicht enthält, stehen auf der Website, bevor Sie ein Maß eingeben — statt im Gespräch aufzutauchen.',
  'about.range.heading': 'Was wir fertigen',
  'about.range.body':
    'Jede Zahl hier stammt aus demselben Katalog, der auch die Preise berechnet. Nichts davon ist separat gepflegt.',
  'about.fact.designs.note': (p, f) =>
    `in ${f.integer(p.categories)} ${count(p.categories, 'Kategorie', 'Kategorien')}`,
  'about.fact.leadTime.note': 'je nach Ausführung',
  'about.fact.floor': 'Mindestberechnungsfläche',
  'about.fact.floor.note': 'kleinere Elemente werden mit der Mindestfläche berechnet',
  'about.fact.legalName': 'Eingetragener Name',
  'about.fact.makes': 'Was wir fertigen',
  'about.fact.serviceArea': 'Wohin wir liefern',
  'about.contact.heading': 'Wo Sie uns finden und wie Sie uns erreichen',
  'about.card.factory': 'Fertigung und Büro',
  'about.card.delivery': 'Lieferung und Montage',
  'about.card.delivery.note':
    'Montage und Lieferung sind in den Preisen auf dieser Website nicht enthalten, da sie von Objekt und Entfernung abhängen. Unser Team kalkuliert sie im Angebot.',
  'about.card.hours': 'Öffnungszeiten',
  'about.card.hours.note':
    'Außerhalb der Öffnungszeiten hinterlassen Sie eine Nachricht über LINE oder per E-Mail; unser Team antwortet am nächsten Werktag.',

  /* ---- Footer ------------------------------------------------------------ */
  'footer.contact': 'Kontakt',
  'footer.hours': 'Öffnungszeiten',
  'footer.serviceArea': 'Liefergebiet',
  'footer.menu': 'Menü',
  // Gregorian, from the same param Thai renders as พ.ศ. No arithmetic here.
  'footer.copyright': (p, f) => `© ${f.year(p.year)}`,

  /* ---- Contact channels and the spec sheet -------------------------------- */
  'contact.phone': 'Telefon',
  'contact.line': 'LINE',
  'contact.email': 'E-Mail',
  'spec.material': 'Material',
  'spec.material.value': 'Stranggepresstes Aluminium',
  'spec.profileThickness': 'Profilstärke',
  'spec.standards': 'Erfüllte Normen',
  'spec.warranty': 'Garantie',

  /* ---- Reviews ------------------------------------------------------------- */
  'review.heading': 'Bewertungen von Kundinnen und Kunden mit eingebauten Elementen',
  'review.summary': (p, f) =>
    `${f.rating(p.ratingSum, p.ratingCount)} von 5 · ${f.integer(p.ratingCount)} ${count(
      Number(p.ratingCount),
      'Bewertung',
      'Bewertungen',
    )}`,
  'review.hiddenNote': (p, f) =>
    `${f.integer(p.hidden)} ${count(
      Number(p.hidden),
      'Bewertung wurde',
      'Bewertungen wurden',
    )} wegen Verstoßes gegen die Bewertungsregeln ausgeblendet — diese Wertungen zählen weiterhin für den Durchschnitt oben`,
  'review.publishedOn': (p, f) => `Verfasst am ${f.date(p.at)}`,
  'review.author.anonymous': 'Kunde',
  'review.size': (p, f) => `Bestellt in ${f.dimensions(p.widthUm, p.heightUm, p.unit)}`,
  'review.erased':
    'Text und Name dieser Bewertung wurden auf Wunsch der verfassenden Person entfernt. Die Wertung zählt weiterhin.',
  'review.reply.heading': 'Antwort von WEWIN180',
  'review.reply.on': (p, f) => `Beantwortet am ${f.date(p.at)}`,
  'review.photo.alt': (p, f) => `Kundenfoto ${f.integer(p.index)}`,
  'review.more': (p, f) =>
    `und ${f.integer(p.remaining)} weitere ${count(
      Number(p.remaining),
      'Bewertung',
      'Bewertungen',
    )}`,

  'review.form.heading': 'Bewertung schreiben',
  'review.form.for': (p) => `Bewertung zu ${p.name}`,
  'review.form.intro':
    'Aluminium beurteilt man nach einer Regenzeit, nicht drei Tage nach dem Einbau — schreiben Sie, wann immer Sie so weit sind. Diese Möglichkeit läuft nicht ab.',
  'review.form.rating.legend': 'Wie viele Sterne',
  'review.form.rating.option': (p, f) =>
    `${f.integer(p.stars)} ${count(p.stars, 'Stern', 'Sterne')}`,
  'review.form.rating.required': 'Bitte wählen Sie vor dem Senden eine Sternebewertung',
  'review.form.body.label': 'Erzählen Sie uns davon (optional)',
  'review.form.body.help':
    'Bitte lassen Sie Adressen, Telefonnummern und Angaben zu anderen Personen weg — dies ist eine öffentliche Seite.',
  'review.form.name.label': 'Anzuzeigender Name (optional)',
  'review.form.name.help':
    'Wird neben Ihrer Bewertung angezeigt. Initialen genügen, leer lassen ist ebenfalls in Ordnung.',
  'review.form.submit': 'Bewertung senden',
  'review.form.submitting': 'Wird gesendet…',
  'review.form.moderation':
    'Ihre Bewertung erscheint auf der Produktseite, sobald wir sie gelesen haben — oder von selbst, wenn die Prüffrist abgelaufen ist.',
  'review.form.loading': 'Ihre Einladung wird geöffnet…',
  'review.form.invalid.title': 'Dieser Link funktioniert nicht',
  'review.form.invalid.body':
    'Möglicherweise wurde er bereits verwendet oder unvollständig kopiert. Öffnen Sie ihn erneut aus der Einladungs-E-Mail.',
  'review.form.failed.title': 'Die Bewertung wurde nicht gesendet',
  'review.form.failed.body':
    'Versuchen Sie es erneut. Wenn es weiterhin fehlschlägt, antworten Sie auf die Einladungs-E-Mail.',
  'review.form.done.title': 'Vielen Dank — Ihre Bewertung ist bei uns',
  'review.form.done.body':
    'Sie erscheint auf der Produktseite, sobald sie gelesen wurde, oder wenn die Prüffrist abgelaufen ist.',
  'review.meta.title': 'Bewertung schreiben',

  'account.title': 'Mein Konto',
  'account.password.section': 'Passwort ändern',
  'account.password.current': 'Aktuelles Passwort',
  'account.password.new': 'Neues Passwort',
  'account.password.confirm': 'Neues Passwort bestätigen',
  'account.password.action': 'Passwort ändern',
  'account.password.saving': 'Wird geändert…',
  'account.password.done': 'Passwort geändert',
  'account.password.doneOthers':
    'Passwort geändert — Ihre anderen Geräte wurden abgemeldet.',
  'account.password.note':
    'Beim Ändern werden alle anderen Geräte abgemeldet, auf denen Sie angemeldet sind. Dieses bleibt angemeldet.',
  'account.password.problem.currentMissing': 'Bitte geben Sie Ihr aktuelles Passwort ein.',
  'account.password.problem.tooShort':
    'Das neue Passwort ist zu kurz — mindestens 12 Zeichen.',
  'account.password.problem.sameAsCurrent':
    'Das neue Passwort muss sich vom aktuellen unterscheiden.',
  'account.password.problem.mismatch':
    'Das neue Passwort und die Bestätigung stimmen nicht überein.',
  'account.checking': 'Wird geprüft…',
  'account.needAccount': 'Melden Sie sich an, um ein Angebot anzufordern',
  'account.whyAccount':
    'Damit das Angebot zu Ihrem Konto gehört und sich auf jedem Gerät öffnen lässt — für die Registrierung genügen eine Telefonnummer und ein Passwort.',
  'account.register': 'Konto erstellen',
  'account.signIn': 'Anmelden',
  'account.haveAccount': 'Sie haben bereits ein Konto?',
  'account.noAccount': 'Noch kein Konto?',
  'account.phone': 'Telefon',
  'account.username': 'Telefonnummer oder E-Mail',
  'account.usernameHint':
    'Die Nummer, mit der Sie sich registriert haben — oder Ihre E-Mail-Adresse, wenn Sie bereits ein Konto besitzen.',
  'account.password': 'Passwort',
  'account.passwordHint': 'Mindestens 12 Zeichen.',
  'account.signedInAs': 'Angemeldet',
  'account.signOut': 'Abmelden',
  'account.problem.badPhone':
    'Diese Telefonnummer ist nicht lesbar — z. B. 081-234-5678.',
  'account.problem.passwordTooShort':
    'Dieses Passwort ist zu kurz — mindestens 12 Zeichen.',
  'account.problem.unreachable': 'Keine Verbindung. Bitte versuchen Sie es erneut.',
  'account.problem.unconfigured':
    'Derzeit nicht verfügbar. Bitte wenden Sie sich an den Vertrieb.',
  'account.myQuotations': 'Meine Angebote',
  'account.noQuotations': 'Noch keine Angebote',

  'submit.heading': 'Angebot anfordern',
  'submit.intro':
    'Nennen Sie uns einen Namen und einen Weg, Sie zu erreichen — wir erstellen das Angebot sofort. Preise und Angaben werden genau so festgeschrieben, wie sie in diesem Warenkorb stehen.',
  'submit.name': 'Ansprechpartner',
  'submit.namePlaceholder': 'Vollständiger Name',
  'submit.email': 'E-Mail',
  'submit.phone': 'Telefon',
  'submit.channelHint':
    'Mindestens eines von beiden — eine Telefonnummer allein genügt.',
  'submit.destination': 'Zielland',
  'submit.action': 'Angebot anfordern',
  'submit.sending': 'Angebot wird erstellt…',
  'submit.problem.nameMissing': 'Bitte geben Sie einen Ansprechpartner an.',
  'submit.problem.noChannel':
    'Bitte geben Sie eine E-Mail-Adresse oder eine Telefonnummer an.',
  'submit.problem.badPhone':
    'Diese Telefonnummer ist nicht lesbar — z. B. 081-234-5678.',
  'submit.problem.badEmail': 'Diese E-Mail-Adresse ist nicht lesbar.',
  'submit.problem.badDestination':
    'Bitte wählen Sie das Zielland erneut aus — die vorherige Wahl steht nicht mehr zur Verfügung.',
  'submit.problem.unreachable': 'Keine Verbindung. Bitte versuchen Sie es erneut.',
  'submit.problem.unconfigured':
    'Anfragen können derzeit nicht entgegengenommen werden. Bitte wenden Sie sich an den Vertrieb.',
  'submit.problem.unavailable':
    'Etwas in Ihrem Warenkorb ist nicht mehr verfügbar. Entfernen Sie diese Position und versuchen Sie es erneut.',
  'submit.done': 'Ihr Angebot ist fertig',
  'submit.viewQuotation': 'Angebot öffnen',

  'quotation.meta.title': 'Ihr Angebot',
  'quotation.loading': 'Ihr Angebot wird geöffnet…',
  'quotation.heading': 'Angebot',
  'quotation.unavailable.title': 'Dieses Angebot lässt sich nicht öffnen',
  'quotation.unavailable.body':
    'Der Link ist möglicherweise abgelaufen oder wurde unvollständig kopiert. Bitten Sie den Vertrieb um einen neuen.',
  'quotation.unreachable.title': 'Derzeit keine Verbindung',
  'quotation.unreachable.body':
    'Bitte versuchen Sie es erneut. Wenn es weiterhin fehlschlägt, wenden Sie sich an den Vertrieb.',
  'quotation.retry': 'Erneut versuchen',
  'quotation.print': 'Drucken oder als PDF speichern',
  'quotation.orderNo': 'Nr.',
  'quotation.revision': 'Fassung',
  'quotation.submittedAt': 'Bestätigt am',
  'quotation.leadTime': 'Lieferzeit (Tage)',
  'quotation.net': 'Netto',
  'quotation.vat': 'MwSt.',
  'quotation.vatIncluded': 'im Preis enthalten',
  'quotation.total': 'Gesamt',
  'quotation.fx.rate': ({ currency, rateText }) => `Wechselkurs 1 ${currency} = ${rateText} THB`,
  'quotation.fx.observedAt': ({ observedAt }) => `Kurs vom ${observedAt}`,
  'quotation.fx.manual': 'Vom Unternehmen festgelegter Kurs',
  'quotation.fx.settlementNote': ({ currency }) => `Die ${currency}-Beträge oben sind der Referenzpreis. Die Zahlung erfolgt in Thai-Baht in der unten genannten Höhe.`,
  'quotation.fx.payable': 'Zahlbetrag',
  'quotation.fx.deposit': 'Zuerst fällige Anzahlung',
  'quotation.lineNo': 'Nr.',
  'quotation.item': 'Position',
  'quotation.qty': 'Menge',
  'quotation.amount': 'Betrag',
  'quotation.charges': 'Weitere Posten',
  'quotation.pinnedNotice':
    'Dieses Dokument wurde am Tag der Bestätigung festgeschrieben — seine Zahlen und seine Sprache ändern sich beim erneuten Öffnen nicht.',
  'quotation.degraded':
    'Die festgeschriebene Sprache ist in dieser Version nicht verfügbar, daher wird das Dokument auf Thai angezeigt.',
  'quotation.contact': 'An',
  'quotation.seller.phone': 'Telefon',
  'quotation.seller.taxId': 'Steuernummer',

  /* ---- Display settings ---------------------------------------------------- */
  'settings.nav': 'Darstellung',
  'settings.heading': 'Darstellungseinstellungen',
  'settings.intro':
    'Wählen Sie, wie diese Website für Sie geschrieben wird: Sprache, Maßeinheit und Währung. Alle drei betreffen nur die Darstellung — die Maße, die Sie eingeben, und die Preise, die wir berechnen, ändern sich dadurch nicht.',
  'settings.meta.title': 'Darstellungseinstellungen',

  'settings.language.legend': 'Sprache, in der diese Website geschrieben ist',
  'settings.language.accountDiffers': (p) => `Ihr Konto ist auf ${p.language} eingestellt.`,
  'settings.language.applyAccount': 'Kontosprache auf diesem Gerät verwenden',
  'settings.unit.legend': 'Maße werden angezeigt in',
  'settings.currency.legend': 'Währung, in der Preise angezeigt werden',
  'settings.currency.fixed': (p) => `Immer ${p.currency}, in jeder Sprache`,
  'settings.currency.why':
    'Jeder Preis wird in Thai-Baht berechnet und gespeichert, und Produktseiten werden einmal erzeugt und von allen Besuchenden geteilt — eine personenbezogene Währung lässt sich darauf nicht anwenden. Ein Angebot für Kundschaft im Ausland in deren eigener Währung ist eine eigene Sache und noch nicht freigeschaltet.',

  'settings.storage.local': 'Nur in diesem Browser gespeichert',
  'settings.storage.account': (p, f) => `Am ${f.date(p.at)} in Ihrem Konto gespeichert`,
  'settings.storage.signIn':
    'Melden Sie sich an, um diese Einstellungen auf Ihre anderen Geräte zu übernehmen.',
  'settings.storage.saving': 'Wird gespeichert',
  'settings.storage.failed':
    'Speichern im Konto nicht möglich. Die Auswahl gilt weiterhin in diesem Browser.',
  'settings.storage.forget': 'In meinem Konto gespeicherte Einstellungen löschen',

  'settings.messages.heading': 'Die Sprache, in der wir Ihnen schreiben',
  'settings.messages.degraded': (p) =>
    `${p.chosen} ist noch nicht übersetzt, daher erreichen Sie Nachrichten von uns auf ${p.rendered}.`,
  'settings.messages.coverage': (p, f) =>
    `${f.plain(p.translated)} von ${f.plain(p.total)} Nachrichten übersetzt`,

  'settings.effects.heading': 'Was diese Einstellungen bewirken',
  'settings.effects.intro':
    'Diese Liste stammt vom Server und nicht von dieser Seite, und sie benennt auch die Einstellungen, die noch nichts bewirken — statt Sie das selbst herausfinden zu lassen.',
  'settings.effect.locale.notification': 'Die Sprache der E-Mails, die wir Ihnen senden',
  'settings.effect.locale.document':
    'Die Sprache bereits ausgestellter Angebote und Rechnungen',
  'settings.effect.locale.storefront': 'Die Sprache dieser Website',
  'settings.effect.locale.dashboard': 'Die Sprache des internen Dashboards',
  'settings.effect.currency.notification': 'Die Währung in E-Mails, die wir Ihnen senden',
  'settings.effect.currency.document': 'Die Währung auf bereits ausgestellten Dokumenten',
  'settings.effect.currency.storefront': 'Die Währung der Preise auf dieser Website',
  'settings.effect.currency.dashboard': 'Die Währung im internen Dashboard',
  'settings.effect.lengthUnit.notification': 'Die Einheit in E-Mails, die wir Ihnen senden',
  'settings.effect.lengthUnit.document': 'Die Einheit auf bereits ausgestellten Dokumenten',
  'settings.effect.lengthUnit.storefront':
    'Die Einheit, in der Maße auf dieser Website angezeigt werden',
  'settings.effect.lengthUnit.dashboard': 'Die Einheit im internen Dashboard',
  'settings.effect.yes': 'Wirkt',
  'settings.effect.no': 'Wirkt noch nicht',

  /* ---- Not found ----------------------------------------------------------- */
  'notFound.title': 'Seite nicht gefunden',
  'notFound.body':
    'Der Link hat sich möglicherweise geändert. Beginnen Sie bei der Produktliste.',

  /* ---- Paying, and attaching a slip ---------------------------------- */
  'payment.action': 'Jetzt bezahlen',
  'payment.meta.title': 'Zahlung mitteilen',
  'payment.heading': 'Zahlung mitteilen',
  'payment.loading': 'Ihre Zahlungsdetails werden geöffnet…',
  'payment.outstanding': 'Noch offener Betrag',
  'payment.outstandingAmount': (p, f) => {
    const negative = p.owedMinor < 0n;
    const magnitude = negative ? -p.owedMinor : p.owedMinor;
    return `${negative ? '-' : ''}฿${f.plain(magnitude / 100n)}.${String(magnitude % 100n).padStart(2, '0')}`;
  },
  'payment.settled': 'Diese Bestellung ist vollständig bezahlt',
  'payment.account.legend': 'Überweisen Sie auf eines dieser Konten',
  'payment.account.copy': (p) => `Kontonummer ${p.accountDigits} kopieren`,
  'payment.account.copied': 'Kontonummer kopiert',
  'payment.account.qrAlt': 'PromptPay-QR-Code für den eingegebenen Betrag',
  'payment.account.qrHint':
    'Mit Ihrer Banking-App scannen — der Betrag wird automatisch eingetragen',
  'payment.account.none':
    'Es wurde noch kein Empfangskonto eingerichtet. Bitte wenden Sie sich für die Zahlungsdetails an unser Vertriebsteam.',
  'payment.form.legend': 'Beleg anhängen',
  'payment.form.image': 'Foto des Belegs',
  'payment.form.imageHint': 'Ein Screenshot aus Ihrer Banking-App reicht. Bis zu 8 MB.',
  'payment.form.amount': 'Überwiesener Betrag',
  'payment.form.transferredAt': 'Datum und Uhrzeit der Überweisung',
  'payment.form.reference': 'Referenznummer (optional)',
  'payment.form.submit': 'Beleg senden',
  'payment.phase.uploading': 'Foto wird hochgeladen…',
  'payment.phase.creating': 'Beleg wird gespeichert…',
  'payment.done':
    'Wir haben Ihren Beleg erhalten. Unser Team prüft ihn und meldet sich bei Ihnen.',
  'payment.history.heading': 'Von Ihnen gesendete Belege',
  'payment.history.empty': 'Noch keine Belege gesendet',
  'payment.history.submitted': (p, f) => {
    const negative = p.slipMinor < 0n;
    const magnitude = negative ? -p.slipMinor : p.slipMinor;
    return `${negative ? '-' : ''}฿${f.plain(magnitude / 100n)}.${String(magnitude % 100n).padStart(2, '0')} · gesendet am ${f.date(p.sentAt)} · wird geprüft`;
  },
  'payment.history.accepted': (p, f) => {
    const negative = p.slipMinor < 0n;
    const magnitude = negative ? -p.slipMinor : p.slipMinor;
    return `${negative ? '-' : ''}฿${f.plain(magnitude / 100n)}.${String(magnitude % 100n).padStart(2, '0')} · gesendet am ${f.date(p.sentAt)} · akzeptiert`;
  },
  'payment.history.rejected': (p, f) => {
    const negative = p.slipMinor < 0n;
    const magnitude = negative ? -p.slipMinor : p.slipMinor;
    return `${negative ? '-' : ''}฿${f.plain(magnitude / 100n)}.${String(magnitude % 100n).padStart(2, '0')} · nicht akzeptiert — ${p.reason}`;
  },
  'payment.problem.noImage': 'Bitte fügen Sie ein Foto des Belegs hinzu.',
  'payment.problem.imageTooBig': (p, f) =>
    `Dieses Foto ist zu groß — bis zu ${f.plain(p.limitMib)} MB.`,
  'payment.problem.badAmount':
    'Geben Sie den Betrag als Zahl mit höchstens zwei Dezimalstellen ein.',
  'payment.problem.badTime': 'Bitte geben Sie Datum und Uhrzeit der Überweisung an.',
  'payment.problem.signInAgain':
    'Ihre Sitzung ist abgelaufen. Bitte melden Sie sich erneut an — Ihre Eingaben sind noch da.',
  'payment.problem.unreachable': 'Keine Verbindung. Bitte versuchen Sie es erneut.',
};
