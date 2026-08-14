import type { PartialUiCatalogue } from '../keys';

/**
 * Hindi (हिन्दी) — complete.
 *
 * ⚠️ **This file used to say "empty on purpose".** That note argued a plausible sentence
 * nobody in the company can read back is worse than a visible fallback, and it still holds
 * for *content* — product names, rule messages, the catalogue — which is why `content.ts`
 * still routes those through `ContentRef`. What changed is that the UI shell, a closed set
 * of 346 keys, was translated on request and is treated as shipped.
 *
 * ── What this catalogue has to get right ─────────────────────────────────────
 *
 *   - **Plural agreement, and it is not English's.** Feminine nouns in -ई take -इयाँ
 *     (श्रेणी → श्रेणियाँ), masculine in -आ take -ए (तारा → तारे), and many masculine
 *     nouns ending in a consonant do not change at all (उत्पाद, रंग). Three patterns, so
 *     the `count` helper below takes both forms rather than deriving one.
 *   - **आप, throughout.** तुम would be wrong on a commercial document.
 *   - **Devanagari has no separate numerals here.** The digits come from CLDR through
 *     `Formatters`; this file never writes one.
 *
 * ⚠️ `f.entry` / `f.entryRange` stay ASCII here as everywhere: they label a field the
 * customer types back into, and `parseMeasure` accepts one separator. A Devanagari numeral
 * in a helper line above a field that only reads ASCII is an instruction that field cannot
 * obey.
 */
const count = (value: number, singular: string, plural: string): string =>
  value === 1 ? singular : plural;

export const hi: PartialUiCatalogue = {
  /* ---- Shell and navigation ---------------------------------------- */
  'a11y.skipToContent': 'मुख्य सामग्री पर जाएँ',
  'nav.mainLabel': 'मुख्य मेन्यू',
  'nav.homeLabel': (p) => `${p.wordmark} होम`,
  'nav.products': 'उत्पाद',
  'nav.about': 'हमारे बारे में',
  'nav.quote': 'कोटेशन सूची',
  'nav.allProducts': 'सभी उत्पाद देखें',
  'nav.backToProducts': 'सभी उत्पादों पर वापस',
  'nav.addMore': 'एक और उत्पाद जोड़ें',
  'quote.badge.filled': (p, f) => `आपकी कोटेशन सूची में ${f.integer(p.count)} वस्तुएँ`,
  'quote.badge.empty': 'कोटेशन सूची खाली है',

  /* ---- Money and measurement ---------------------------------------- */
  'price.perSqmSuffix': '/ m²',
  'price.from': 'से',
  'price.fromShort': 'से',
  'price.unit': 'प्रति नग मूल्य',
  'price.total': 'कुल',
  'price.grandTotal': 'सकल कुल',
  'price.perPiece': (p, f) => `${f.baht(p.minor)} प्रति नग`,
  'value.unknown': '—',
  'unit.sqmSuffix': 'm²',
  'count.pieces': (p, f) => `${f.integer(p.count)} नग`,
  'count.items': (p, f) => `${f.integer(p.count)} ${count(p.count, 'वस्तु', 'वस्तुएँ')}`,
  'count.designs': (p, f) => `${f.integer(p.count)} डिज़ाइन`,
  'leadTime.range': (p, f) => `${f.integer(p.days[0])}–${f.integer(p.days[1])} दिन`,
  'leadTime.produce': (p, f) =>
    `बनने में ${f.integer(p.days[0])}–${f.integer(p.days[1])} दिन`,

  /* ---- Pickers ------------------------------------------------------ */
  'unit.pickerLabel': 'इकाई',
  'unit.groupLabel': 'माप इस इकाई में दिखाए जाते हैं',
  'unit.name.mm': 'मिलीमीटर',
  'unit.name.cm': 'सेंटीमीटर',
  'unit.name.m': 'मीटर',
  'unit.name.in': 'इंच',
  'unit.name.ft': 'फुट',
  'locale.pickerLabel': 'भाषा',
  'locale.groupLabel': 'इस साइट की भाषा',
  'locale.partial': 'कुछ पाठ का अनुवाद अभी नहीं हुआ है और वह थाई में दिखाया जाएगा।',

  /* ---- Home --------------------------------------------------------- */
  'home.hero.line1': 'आपकी ओपनिंग के नाप पर बना',
  'home.hero.line2': 'फ़ोन करने से पहले मूल्य देखिए',
  'home.hero.body':
    'एल्युमिनियम की खिड़कियाँ, लूवर और दरवाज़े। अपनी ओपनिंग की असली चौड़ाई और ऊँचाई भरिए और पूरा मूल्य तुरंत देखिए — न लॉगिन, न पहले फ़ोन नंबर।',
  'home.hero.cta': 'उत्पाद देखें और मूल्य निकालें',
  'home.fact.designs': 'उपलब्ध डिज़ाइन',
  'home.fact.startingPrice': 'शुरुआती मूल्य',
  'home.fact.leadTime': 'बनने का समय',
  'home.how.heading': 'यह कैसे काम करता है',
  'home.how.body':
    'नाप पर बनने वाले काम में, संपर्क करने से पहले खुद मूल्य देख लेना अब भी असामान्य है। आगे यह होता है।',
  'home.step.measure.title': 'ओपनिंग नापिए और भरिए',
  'home.step.measure.body':
    'जो डिज़ाइन चाहिए वह चुनिए, फिर ओपनिंग की असली चौड़ाई × ऊँचाई भरिए।',
  'home.step.price.title': 'मूल्य तुरंत देखिए',
  'home.step.price.body':
    'पूरा मूल्य तत्काल दिखता है, और उसे बनाने वाली हर मद अलग से दिखाई जाती है।',
  'home.step.request.title': 'कोटेशन मँगाइए',
  'home.step.request.body':
    'जिन वस्तुओं में आपकी रुचि है उन्हें जमा कीजिए और हमें भेजिए। इस चरण पर कोई बाध्यता नहीं है।',
  'home.step.survey.title': 'उत्पादन से पहले साइट पर नाप',
  'home.step.survey.body': (p, f) =>
    `उत्पादन शुरू होने से पहले हमारी टीम साइट पर नापकर माप और मूल्य की पुष्टि करती है।${
      p.days === null
        ? ''
        : ` डिज़ाइन के अनुसार बनने में ${f.integer(p.days[0])}–${f.integer(p.days[1])} दिन लगते हैं।`
    }`,
  'home.estimate.note':
    'इस साइट का मूल्य आपके भरे हुए नापों से लगाया गया अनुमान है। अंतिम मूल्य हमारी टीम के साइट पर नापने के बाद तय होता है।',
  'home.estimate.emphasis': 'आपके भरे हुए नापों से लगाया गया अनुमान',
  'home.categories.heading': 'काम के प्रकार से चुनिए',
  'home.category.empty': 'इस श्रेणी में अभी कोई उत्पाद नहीं है',
  'home.pricing.heading': 'मूल्य कैसे निकाला जाता है',
  'home.pricing.body':
    'ये तीनों बातें यहाँ इसलिए हैं कि आपको नाप भरने से पहले इनका पता होना चाहिए — अंतिम आँकड़ा देखते समय नहीं।',
  'home.pricing.formula.title': 'सूत्र',
  'home.pricing.formula.body': 'मूल्य = प्रति m² दर × बिल योग्य क्षेत्रफल + विकल्प',
  'home.pricing.formula.note':
    'विकल्पों में प्रोफ़ाइल का रंग, फ़्रेम में जो भरा जाता है — काँच, लूवर पत्तियाँ या जाली — तथा आपके जोड़े गए हार्डवेयर आते हैं। इनमें से हर एक मूल्य पृष्ठ पर अलग से दिया गया है।',
  'home.pricing.floor.title': 'न्यूनतम बिल योग्य क्षेत्रफल',
  'home.pricing.floor.body':
    'न्यूनतम से छोटे पैनल का बिल न्यूनतम क्षेत्रफल पर बनता है।',
  'home.pricing.floor.range': (p, f) =>
    p.span === null ? '—' : `${f.area(p.span[0])}–${f.area(p.span[1])} m²`,
  'home.pricing.floor.note':
    'डिज़ाइन के अनुसार। मूल्य पृष्ठ पर आपके चुने डिज़ाइन का न्यूनतम हमेशा लिखा रहता है।',
  'home.pricing.excluded.title': 'इस मूल्य में शामिल नहीं',
  'home.pricing.excluded.install': 'फ़िटिंग',
  'home.pricing.excluded.delivery': 'ढुलाई',
  'home.pricing.excluded.removal': 'पुराना सेट निकालना',
  'home.pricing.excluded.note':
    'तीनों साइट पर निर्भर करते हैं, इसलिए केवल नाप से इनका अनुमान नहीं लगाया जा सकता। ये साइट पर नाप के बाद कोटेशन में आते हैं।',

  'meta.title': 'WEWIN180 — आपके नाप पर बना, पूछने से पहले मूल्य',
  'meta.description':
    'WEWIN180 — आपके अपने नापों पर बनी खिड़कियाँ, लूवर और दरवाज़े। कोटेशन मँगाने से पहले खुद मूल्य निकालिए।',

  /* ---- Catalogue ---------------------------------------------------- */
  'catalog.heading': 'सभी उत्पाद',
  'catalog.resultCount': (p, f) => `${f.integer(p.count)} उत्पाद`,
  'catalog.empty.title': 'इन फ़िल्टरों से अभी कुछ मेल नहीं खाता',
  'catalog.empty.body': 'एक-दो फ़िल्टर हटाकर सब कुछ दोबारा देखिए।',
  'filter.title': 'फ़िल्टर',
  'filter.clear': 'फ़िल्टर हटाएँ',
  'filter.showResults': (p, f) => `परिणाम दिखाएँ (${f.integer(p.count)} उत्पाद)`,
  'filter.section.category': 'श्रेणी',
  'filter.section.profileColor': 'प्रोफ़ाइल का रंग',
  'filter.section.pricePerSqm': 'प्रति m² मूल्य',
  'filter.priceTo': 'से',
  'filter.priceMax': 'इससे अधिक नहीं',
  'product.colorCount': (p, f) => `${f.integer(p.count)} प्रोफ़ाइल रंग`,
  'product.sizeRange': (p, f) => `नाप ${f.range(p.minUm, p.maxUm, p.unit)}`,

  /* ---- Configurator -------------------------------------------------- */
  'configure.loadingLine': 'यह वस्तु लोड हो रही है…',
  'configure.spec.note':
    'विस्तृत विनिर्देश, मानक और वारंटी की शर्तों के लिए नीचे दिए संपर्क से हमारी टीम से पूछिए।',
  'configure.view.front': 'सामने',
  'configure.view.halfPanel': 'आधा पैनल',
  'configure.view.transom': 'ऊपरी रोशनदान',
  'configure.size.heading': 'नाप',
  'configure.area.line': (p, f) =>
    `क्षेत्रफल ${f.area(p.areaSqUm)} m² · न्यूनतम बिल ${f.area(p.minBillableSqUm)} m²`,
  'configure.group.affectsSku': 'उत्पाद कोड बदलता है',
  'configure.quoteNext': 'इसे कोटेशन सूची में जोड़ें, फिर वहीं से कोटेशन मँगाएँ।',
  'configure.breakdown.title': 'मूल्य का विवरण',
  'configure.qty': 'मात्रा',
  'configure.qty.decrease': 'एक नग घटाएँ',
  'configure.qty.increase': 'एक नग बढ़ाएँ',
  // Thai says `ลด${group} ${step}` as one clause; Hindi puts the verb last, so the object
  // and the amount both precede it. The key carries the parts, so this is writable.
  'measure.decrease': (p, f) => `${p.group} ${f.entry(p.stepUm, p.unit)} घटाएँ`,
  'measure.increase': (p, f) => `${p.group} ${f.entry(p.stepUm, p.unit)} बढ़ाएँ`,
  'measure.helper': (p, f) =>
    `${f.entryRange(p.minUm, p.maxUm, p.unit)} · ${f.entry(p.gridUm, p.unit)} के चरणों में`,

  /* ---- Drawings ------------------------------------------------------- */
  'drawing.schematic': 'अनुपात रेखाचित्र',
  'drawing.schematic.sized': (p) => `अनुपात रेखाचित्र, ${p.size}`,
  'drawing.elevation': (p) =>
    `एलिवेशन ड्रॉइंग, ${p.width} × ${p.height} ${p.unit}${
      p.invalid ? ' — यह नाप बनने की सीमा से बाहर है' : ''
    }`,
  'drawing.unitNote': (p) => `इकाई: ${p.unit}`,

  /* ---- Toolbar, share, QR -------------------------------------------- */
  'toolbar.groupLabel': 'इस कॉन्फ़िगरेशन का प्रबंधन',
  'toolbar.undo': 'पूर्ववत',
  'toolbar.redo': 'फिर से',
  'toolbar.reset': 'डिफ़ॉल्ट पर वापस',
  'toolbar.share': 'इस कॉन्फ़िगरेशन का लिंक साझा करें',
  'toolbar.qr': 'इस लिंक का QR कोड बनाएँ',
  'share.sheet.title': 'लिंक साझा करें',
  'share.qr.title': 'इस लिंक का QR कोड',
  'share.body':
    'यह लिंक कॉन्फ़िगरेटर को उन्हीं नापों और विकल्पों के साथ खोलता है जो आप अभी देख रहे हैं। इसे अपने फ़िटर या घर पर किसी को भेजिए।',
  'share.copyLink': 'लिंक कॉपी करें',
  'share.copied': 'लिंक कॉपी हो गया',
  'share.showQr': 'QR कोड के रूप में दिखाएँ',
  'qr.alt': 'इस कॉन्फ़िगरेशन के लिंक का QR कोड',
  'qr.failed': 'QR कोड नहीं बन सका। इसके बजाय लिंक कॉपी करने वाला बटन इस्तेमाल कीजिए।',

  /* ---- Price summary and breakdown ------------------------------------ */
  'summary.label': 'मूल्य सारांश',
  'summary.skuCode': 'उत्पाद कोड',
  'summary.copySku': (p) => `उत्पाद कोड ${p.skuCode} कॉपी करें`,
  'summary.skuCopied': 'उत्पाद कोड कॉपी हो गया',
  'summary.add': 'कोटेशन सूची में जोड़ें',
  'summary.hasErrors': 'ऊपर अब भी कुछ ठीक करना है। क्या, यह देखने के लिए बटन दबाइए।',
  'summary.showBreakdown': 'मूल्य का विवरण देखें',
  'summary.area': (p, f) => `${f.area(p.areaSqUm)} m²`,
  'summary.stickyMeta': (p, f) =>
    `${f.area(p.areaSqUm)} m²${
      p.qty > 1 ? ` · ${f.integer(p.qty)} नग` : ''
    } · विवरण देखें`,
  'breakdown.minimumApplied': (p, f) =>
    `वास्तविक क्षेत्रफल ${f.area(p.areaSqUm)} m² · ${f.area(
      p.minBillableSqUm,
    )} m² न्यूनतम पर बिल`,

  /* ---- Quote ---------------------------------------------------------- */
  'quote.heading': 'कोटेशन सूची',
  'quote.empty.title': 'आपकी कोटेशन सूची अभी खाली है',
  'quote.empty.body':
    'कोई उत्पाद चुनिए, ओपनिंग का असली नाप भरिए, और उसे यहाँ जोड़ लीजिए।',
  'quote.empty.cta': 'उत्पाद चुनिए',
  'quote.summary.label': 'योग',
  'quote.summary.lineCount': 'वस्तुएँ',
  'quote.summary.lineCountValue': (p, f) =>
    `${f.integer(p.lines)} ${count(p.lines, 'वस्तु', 'वस्तुएँ')} · ${f.integer(p.pieces)} नग`,
  'quote.summary.leadTime': 'बनने का समय',
  'quote.tableCaption': 'आपकी कोटेशन सूची की वस्तुएँ',
  'quote.col.name': 'वस्तु',
  'quote.col.sku': 'उत्पाद कोड',
  'quote.col.size': 'नाप',
  'quote.col.qty': 'मात्रा',
  'quote.col.unitPrice': 'प्रति नग',
  'quote.col.total': 'कुल',
  'quote.col.actions': 'क्रियाएँ',
  'quote.action.edit': (p) => `${p.nickname} का कॉन्फ़िगरेशन बदलें`,
  'quote.action.duplicate': (p) => `${p.nickname} की नकल बनाएँ`,
  'quote.action.remove': (p) => `${p.nickname} हटाएँ`,
  'quote.qty.label': (p) => `${p.nickname} की मात्रा`,
  'quote.qty.decrease': (p) => `${p.nickname} का एक नग घटाएँ`,
  'quote.qty.increase': (p) => `${p.nickname} का एक नग बढ़ाएँ`,

  /* ---- Toasts and sheets ----------------------------------------------- */
  'toast.lineSaved': 'बदलाव सहेजे गए',
  'toast.lineAdded': 'कोटेशन सूची में जोड़ा गया',
  'toast.viewQuote': 'कोटेशन सूची देखें',
  'toast.dismiss': 'संदेश बंद करें',
  'sheet.close': 'बंद करें',
  'sheet.closeNamed': (p) => `${p.title} बंद करें`,

  /* ---- About ------------------------------------------------------------ */
  'about.heading': 'हमारे बारे में',
  'about.intro':
    'हम आपकी साइट के असली नापों पर एल्युमिनियम का काम बनाते हैं। हमारा कारख़ाना फ़िट्सनुलोक में है।',
  'about.tool':
    'यह साइट हमारा अपना मूल्य-निर्धारण उपकरण है। अपनी ओपनिंग की चौड़ाई और ऊँचाई भरिए और बिना किसी से संपर्क किए पूरा मूल्य तुरंत देखिए।',
  'about.stance.heading': 'हम अपने मूल्य क्यों प्रकाशित करते हैं',
  'about.stance.noPhone.title': 'मूल्य पूछने की क़ीमत आपका फ़ोन नंबर नहीं होनी चाहिए',
  'about.stance.noPhone.body':
    'नाप पर बनने वाले ज़्यादातर काम में आँकड़ा देने से पहले आपका नंबर माँगा जाता है, यानी जिसे सिर्फ़ मोटा बजट जानना है उसे बाद का फ़ोन भी झेलना पड़ता है। हमने वह चरण हटा दिया।',
  'about.stance.itemised.title': 'मूल्य को यह दिखाना चाहिए कि वह कहाँ से आया',
  'about.stance.itemised.body':
    'मूल्य पृष्ठ कुल बनाने वाली हर मद देता है — क्षेत्रफल, रंग, फ़्रेम में भरी सामग्री और हार्डवेयर। आँकड़ा बदले तो आप देख सकते हैं कि किससे बदला।',
  'about.stance.limits.title': 'सीमाएँ पहले बताई जाती हैं, बाद में नहीं',
  'about.stance.limits.body':
    'न्यूनतम बिल योग्य क्षेत्रफल, जो नाप हम नहीं बना सकते, और मूल्य में क्या शामिल नहीं है — ये सब आपके नाप भरने से पहले साइट पर हैं, बातचीत के बीच में सामने नहीं आते।',
  'about.range.heading': 'हम क्या बनाते हैं',
  'about.range.body':
    'यहाँ का हर आँकड़ा उसी कैटलॉग से पढ़ा गया है जो मूल्य निकालता है। इनमें से कुछ भी अलग से नहीं लिखा गया।',
  'about.fact.designs.note': (p, f) =>
    `${f.integer(p.categories)} ${count(p.categories, 'श्रेणी', 'श्रेणियों')} में`,
  'about.fact.leadTime.note': 'डिज़ाइन के अनुसार',
  'about.fact.floor': 'न्यूनतम बिल योग्य क्षेत्रफल',
  'about.fact.floor.note': 'छोटे पैनल का बिल न्यूनतम पर बनता है',
  'about.fact.legalName': 'पंजीकृत नाम',
  'about.fact.makes': 'हम क्या बनाते हैं',
  'about.fact.serviceArea': 'हम कहाँ पहुँचाते हैं',
  'about.contact.heading': 'हम कहाँ हैं और हम तक कैसे पहुँचें',
  'about.card.factory': 'कारख़ाना और कार्यालय',
  'about.card.delivery': 'ढुलाई और फ़िटिंग',
  'about.card.delivery.note':
    'इस साइट के मूल्यों में फ़िटिंग और ढुलाई शामिल नहीं है, क्योंकि ये साइट और दूरी पर निर्भर करती हैं। हमारी टीम कोटेशन में इनका अनुमान देती है।',
  'about.card.hours': 'खुलने का समय',
  'about.card.hours.note':
    'समय के बाहर LINE या ईमेल पर संदेश छोड़ दीजिए, हमारी टीम अगले कार्यदिवस पर उत्तर देगी।',

  /* ---- Footer ------------------------------------------------------------ */
  'footer.contact': 'संपर्क',
  'footer.hours': 'खुलने का समय',
  'footer.serviceArea': 'सेवा क्षेत्र',
  'footer.menu': 'मेन्यू',
  // Gregorian, from the same param Thai renders as พ.ศ. No arithmetic here.
  'footer.copyright': (p, f) => `© ${f.year(p.year)}`,

  /* ---- Contact channels and the spec sheet -------------------------------- */
  'contact.phone': 'फ़ोन',
  'contact.line': 'LINE',
  'contact.email': 'ईमेल',
  'spec.material': 'सामग्री',
  'spec.material.value': 'एक्सट्रूडेड एल्युमिनियम',
  'spec.profileThickness': 'प्रोफ़ाइल की मोटाई',
  'spec.standards': 'पूरे किए गए मानक',
  'spec.warranty': 'वारंटी',

  /* ---- Reviews ------------------------------------------------------------- */
  'review.heading': 'जिन ग्राहकों ने लगवाया, उनकी समीक्षाएँ',
  'review.summary': (p, f) =>
    `5 में से ${f.rating(p.ratingSum, p.ratingCount)} · ${f.integer(p.ratingCount)} ${count(
      Number(p.ratingCount),
      'समीक्षा',
      'समीक्षाएँ',
    )}`,
  'review.hiddenNote': (p, f) =>
    `समीक्षा नियमों के उल्लंघन के कारण ${f.integer(p.hidden)} ${count(
      Number(p.hidden),
      'समीक्षा छिपाई गई है',
      'समीक्षाएँ छिपाई गई हैं',
    )} — वे अंक ऊपर के औसत में अब भी गिने जाते हैं`,
  'review.publishedOn': (p, f) => `${f.date(p.at)} को लिखी गई`,
  'review.author.anonymous': 'ग्राहक',
  'review.size': (p, f) => `${f.dimensions(p.widthUm, p.heightUm, p.unit)} नाप पर मँगाई गई`,
  'review.erased':
    'इस समीक्षा का पाठ और नाम लिखने वाले के अनुरोध पर हटा दिए गए। अंक अब भी गिने जाते हैं।',
  'review.reply.heading': 'WEWIN180 का उत्तर',
  'review.reply.on': (p, f) => `${f.date(p.at)} को उत्तर दिया`,
  'review.photo.alt': (p, f) => `ग्राहक की तस्वीर ${f.integer(p.index)}`,
  'review.more': (p, f) =>
    `और ${f.integer(p.remaining)} ${count(
      Number(p.remaining),
      'समीक्षा',
      'समीक्षाएँ',
    )}`,

  'review.form.heading': 'समीक्षा लिखें',
  'review.form.for': (p) => `${p.name} की समीक्षा`,
  'review.form.intro':
    'नाप पर बना काम एक बरसात के बाद परखा जाता है, लगने के तीन दिन बाद नहीं — जब तैयार हों तब लिखिए। यह कभी बंद नहीं होता।',
  'review.form.rating.legend': 'कितने तारे',
  'review.form.rating.option': (p, f) =>
    `${f.integer(p.stars)} ${count(p.stars, 'तारा', 'तारे')}`,
  'review.form.rating.required': 'भेजने से पहले तारों की रेटिंग चुनिए',
  'review.form.body.label': 'हमें बताइए (वैकल्पिक)',
  'review.form.body.help':
    'कृपया पते, फ़ोन नंबर और दूसरों की जानकारी न लिखें — यह सार्वजनिक पृष्ठ है।',
  'review.form.name.label': 'दिखाने के लिए नाम (वैकल्पिक)',
  'review.form.name.help':
    'आपकी समीक्षा के साथ दिखेगा। आद्याक्षर भी चलेंगे, खाली छोड़ना भी ठीक है।',
  'review.form.submit': 'समीक्षा भेजें',
  'review.form.submitting': 'भेजी जा रही है…',
  'review.form.moderation':
    'हमारे पढ़ लेने पर आपकी समीक्षा उत्पाद पृष्ठ पर आ जाएगी, या समीक्षा अवधि बीतने पर अपने आप।',
  'review.form.loading': 'आपका निमंत्रण खुल रहा है…',
  'review.form.invalid.title': 'यह लिंक काम नहीं करता',
  'review.form.invalid.body':
    'हो सकता है यह पहले इस्तेमाल हो चुका हो, या अधूरा कॉपी हुआ हो। निमंत्रण ईमेल से इसे फिर खोलिए।',
  'review.form.failed.title': 'समीक्षा नहीं भेजी जा सकी',
  'review.form.failed.body':
    'फिर कोशिश कीजिए। तब भी न हो तो निमंत्रण ईमेल का उत्तर दे दीजिए।',
  'review.form.done.title': 'धन्यवाद — आपकी समीक्षा हमें मिल गई',
  'review.form.done.body':
    'पढ़ लिए जाने पर, या समीक्षा अवधि बीतने पर, यह उत्पाद पृष्ठ पर दिखेगी।',
  'review.meta.title': 'समीक्षा लिखें',

  'account.title': 'मेरा खाता',
  'account.password.section': 'पासवर्ड बदलें',
  'account.password.current': 'मौजूदा पासवर्ड',
  'account.password.new': 'नया पासवर्ड',
  'account.password.confirm': 'नए पासवर्ड की पुष्टि',
  'account.password.action': 'पासवर्ड बदलें',
  'account.password.saving': 'बदला जा रहा है…',
  'account.password.done': 'पासवर्ड बदल गया',
  'account.password.doneOthers':
    'पासवर्ड बदल गया — और आपके दूसरे उपकरणों से साइन आउट कर दिया गया।',
  'account.password.note':
    'बदलने पर वे सभी दूसरे उपकरण साइन आउट हो जाते हैं जिन पर आप साइन इन हैं। यह वाला बना रहता है।',
  'account.password.problem.currentMissing': 'कृपया अपना मौजूदा पासवर्ड दीजिए।',
  'account.password.problem.tooShort': 'नया पासवर्ड बहुत छोटा है — कम से कम 12 अक्षर।',
  'account.password.problem.sameAsCurrent':
    'नया पासवर्ड मौजूदा से अलग होना चाहिए।',
  'account.password.problem.mismatch': 'नया पासवर्ड और उसकी पुष्टि मेल नहीं खाते।',
  'account.checking': 'जाँचा जा रहा है…',
  'account.needAccount': 'कोटेशन मँगाने के लिए साइन इन कीजिए',
  'account.whyAccount':
    'ताकि कोटेशन आपके खाते का हो और किसी भी उपकरण पर खुले — पंजीकरण के लिए एक फ़ोन नंबर और एक पासवर्ड चाहिए।',
  'account.register': 'खाता बनाएँ',
  'account.signIn': 'साइन इन',
  'account.haveAccount': 'पहले से खाता है?',
  'account.noAccount': 'अभी खाता नहीं है?',
  'account.phone': 'फ़ोन',
  'account.username': 'फ़ोन या ईमेल',
  'account.usernameHint':
    'वह नंबर जिससे आपने पंजीकरण किया, या ईमेल यदि आपका खाता पहले से है।',
  'account.password': 'पासवर्ड',
  'account.passwordHint': 'कम से कम 12 अक्षर।',
  'account.signedInAs': 'साइन इन',
  'account.signOut': 'साइन आउट',
  'account.problem.badPhone':
    'यह फ़ोन नंबर पढ़ा नहीं जा सका — जैसे 081-234-5678।',
  'account.problem.passwordTooShort':
    'यह पासवर्ड बहुत छोटा है — कम से कम 12 अक्षर।',
  'account.problem.unreachable': 'जुड़ नहीं पा रहे। कृपया फिर कोशिश कीजिए।',
  'account.problem.unconfigured':
    'अभी उपलब्ध नहीं। कृपया बिक्री टीम से संपर्क कीजिए।',
  'account.myQuotations': 'मेरे कोटेशन',
  'account.noQuotations': 'अभी कोई कोटेशन नहीं',
  'account.tabs.label': 'खाता अनुभाग',

  'account.profile.section': 'आपकी जानकारी',
  'account.profile.name': 'नाम',
  'account.profile.nameUnset': 'कोई नाम दर्ज नहीं है',
  'account.profile.email': 'ईमेल',
  'account.profile.noEmail': 'कोई पुष्ट ईमेल पता नहीं है',
  'account.profile.noPhone': 'कोई टेलीफ़ोन नंबर नहीं है',
  'account.profile.verified': 'पुष्ट',
  'account.profile.verifiedByStaff': 'हमारे स्टाफ़ द्वारा पुष्ट',
  'account.profile.unverified': 'पुष्ट नहीं',
  'account.profile.unverifiedNote':
    'हमारा स्टाफ़ फ़ोन पर आपसे बात करते समय नंबर की पुष्टि कर देता है — आपको कुछ नहीं करना है।',
  'account.profile.readOnly':
    'यह पृष्ठ केवल हमारे रिकॉर्ड की जानकारी दिखाता है। इसमें बदलाव के लिए कृपया सेल्स टीम से संपर्क करें।',
  'account.profile.languageElsewhere': 'आपकी भाषा सेटिंग्स पृष्ठ पर तय होती है।',

  'submit.heading': 'कोटेशन मँगाएँ',
  'submit.intro':
    'हमें एक नाम और संपर्क का एक तरीक़ा दीजिए, हम कोटेशन तुरंत जारी कर देंगे — मूल्य और विवरण ठीक वैसे ही स्थिर कर दिए जाते हैं जैसे इस सूची में दिख रहे हैं।',
  'submit.name': 'संपर्क का नाम',
  'submit.namePlaceholder': 'पूरा नाम',
  'submit.email': 'ईमेल',
  'submit.phone': 'फ़ोन',
  'submit.channelHint': 'दोनों में से कम से कम एक — अकेला फ़ोन नंबर भी चलेगा।',
  'submit.destination': 'गंतव्य देश',
  'submit.action': 'कोटेशन मँगाएँ',
  'submit.sending': 'कोटेशन जारी हो रहा है…',
  'submit.problem.nameMissing': 'कृपया संपर्क का नाम दीजिए।',
  'submit.problem.noChannel': 'कृपया ईमेल पता या फ़ोन नंबर दीजिए।',
  'submit.problem.badPhone':
    'यह फ़ोन नंबर पढ़ा नहीं जा सका — जैसे 081-234-5678।',
  'submit.problem.badEmail': 'यह ईमेल पता पढ़ा नहीं जा सका।',
  'submit.problem.badDestination': 'कृपया गंतव्य फिर से चुनें — पिछला विकल्प अब सूची में नहीं है।',
  'submit.problem.unreachable': 'जुड़ नहीं पा रहे। कृपया फिर कोशिश कीजिए।',
  'submit.problem.unconfigured':
    'अभी अनुरोध नहीं लिए जा सकते। कृपया बिक्री टीम से संपर्क कीजिए।',
  'submit.problem.unavailable':
    'आपकी सूची में कुछ अब उपलब्ध नहीं है। वह पंक्ति हटाकर फिर कोशिश कीजिए।',
  'submit.done': 'आपका कोटेशन तैयार है',
  'submit.viewQuotation': 'कोटेशन खोलें',

  'quotation.meta.title': 'आपका कोटेशन',
  'quotation.loading': 'आपका कोटेशन खुल रहा है…',
  'quotation.heading': 'कोटेशन',
  'quotation.unavailable.title': 'यह कोटेशन नहीं खुल सकता',
  'quotation.unavailable.body':
    'लिंक की अवधि बीत चुकी हो सकती है, या वह अधूरा कॉपी हुआ हो। बिक्री टीम से नया लिंक माँगिए।',
  'quotation.unreachable.title': 'अभी जुड़ नहीं पा रहे',
  'quotation.unreachable.body':
    'कृपया फिर कोशिश कीजिए। बार-बार विफल हो तो बिक्री टीम से संपर्क कीजिए।',
  'quotation.retry': 'फिर कोशिश करें',
  'quotation.print': 'प्रिंट करें या PDF में सहेजें',
  'quotation.orderNo': 'सं.',
  'quotation.revision': 'संशोधन',
  'quotation.submittedAt': 'पुष्टि की तिथि',
  'quotation.leadTime': 'डिलीवरी समय (दिन)',
  'quotation.net': 'वैट से पहले',
  'quotation.vat': 'वैट',
  'quotation.vatIncluded': 'कीमत में शामिल',
  'quotation.total': 'कुल',
  'quotation.fx.rate': ({ currency, rateText }) => `विनिमय दर 1 ${currency} = ${rateText} THB`,
  'quotation.fx.observedAt': ({ observedAt }) => `दर की तिथि ${observedAt}`,
  'quotation.fx.manual': 'कंपनी द्वारा निर्धारित दर',
  'quotation.fx.settlementNote': ({ currency }) => `ऊपर दिए गए ${currency} अंक संदर्भ मूल्य हैं। भुगतान थाई बाट में, नीचे दी गई राशि में किया जाता है।`,
  'quotation.fx.payable': 'देय राशि',
  'quotation.fx.deposit': 'पहले देय अग्रिम',
  'quotation.lineNo': 'क्र.',
  'quotation.item': 'मद',
  'quotation.qty': 'मात्रा',
  'quotation.amount': 'राशि',
  'quotation.charges': 'अन्य शुल्क',
  'quotation.pinnedNotice':
    'यह दस्तावेज़ पुष्टि वाले दिन स्थिर कर दिया गया था — दोबारा खोलने पर इसके आँकड़े और इसकी भाषा नहीं बदलते।',
  'quotation.degraded':
    'स्थिर की गई भाषा इस संस्करण में उपलब्ध नहीं है, इसलिए इसे थाई में दिखाया जा रहा है।',
  'quotation.contact': 'प्रति',
  'quotation.seller.phone': 'फ़ोन',
  'quotation.seller.taxId': 'टैक्स आईडी',

  'orderActions.heading': 'इस ऑर्डर का प्रबंधन',
  'orderActions.object.title': 'बदलाव का अनुरोध करें',
  'orderActions.object.body':
    'यदि कुछ ठीक नहीं है, तो पहले बदलाव का अनुरोध भेजें। जब तक हमारा स्टाफ जवाब नहीं देता, ऑर्डर उत्पादन में नहीं जाएगा, और कोई राशि नहीं काटी जाएगी।',
  'orderActions.object.noteLabel': 'क्या बदलना है',
  'orderActions.object.notePlaceholder': 'उदाहरण: रंग काला कर दें, या चौड़ाई 10 सेमी कम कर दें।',
  'orderActions.object.submit': 'अनुरोध भेजें',
  'orderActions.object.sending': 'भेजा जा रहा है…',
  'orderActions.object.sent': 'आपका अनुरोध भेज दिया गया है। हमारी सेल्स टीम संपर्क करेगी।',
  'orderActions.object.open': ({ openedAt }) => `एक बदलाव अनुरोध जवाब की प्रतीक्षा में है, ${openedAt} को भेजा गया`,
  'orderActions.object.openBody':
    'जवाब मिलने तक यह ऑर्डर उत्पादन में नहीं जाएगा। यदि आपने गलती से भेजा है, तो आप उसे वापस ले सकते हैं।',
  'orderActions.object.withdraw': 'अनुरोध वापस लें',
  'orderActions.object.withdrawing': 'वापस लिया जा रहा है…',
  'orderActions.object.withdrawn': 'आपका बदलाव अनुरोध वापस ले लिया गया है।',
  'orderActions.cancel.title': 'यह ऑर्डर रद्द करें',
  'orderActions.cancel.body': 'रद्द करना वापस नहीं किया जा सकता। दोबारा ऑर्डर करने के लिए नया कोटेशन शुरू करना होगा।',
  'orderActions.cancel.start': 'ऑर्डर रद्द करने का अनुरोध',
  'orderActions.cancel.preFreezeNote': 'यह ऑर्डर उत्पादन में नहीं गया है। आपके डिज़ाइन के अनुसार अभी कुछ नहीं बनाया गया है।',
  'orderActions.cancel.postFreezeNote':
    '⚠️ यह ऑर्डर उत्पादन में जा चुका है — फ़ैक्ट्री ने आपके डिज़ाइन के अनुसार बनाना शुरू कर दिया है। अब रद्द करने पर, अनुबंध के समय तय नीति के अनुसार कुछ राशि रोक ली जाएगी।',
  'orderActions.cancel.pricing': 'राशि की गणना हो रही है…',
  'orderActions.cancel.held': ({ heldMinor }, f) => `हमारे पास जमा राशि ${f.bahtExact(heldMinor)}`,
  'orderActions.cancel.forfeit': ({ forfeitMinor }, f) => `${f.bahtExact(forfeitMinor)} रोक ली जाएगी`,
  'orderActions.cancel.refund': ({ refundMinor }, f) => `${f.bahtExact(refundMinor)} आपको वापस मिलेगी`,
  'orderActions.cancel.freeCancellation': 'आप बिना कोई राशि कटवाए रद्द कर सकते हैं — पूरी राशि वापस मिलेगी।',
  'orderActions.cancel.noMoney': 'कोई भुगतान प्राप्त नहीं हुआ है, इसलिए रोकने या वापस करने के लिए कुछ नहीं है।',
  'orderActions.cancel.reasonLabel': 'रद्द करने का कारण',
  'orderActions.cancel.reasonPlaceholder': 'उदाहरण: मन बदल गया, या परियोजना टल गई।',
  'orderActions.cancel.confirm': 'रद्द करने की पुष्टि करें',
  'orderActions.cancel.cancelling': 'रद्द किया जा रहा है…',
  'orderActions.cancel.keep': 'रद्द न करें',
  'orderActions.cancel.done': 'यह ऑर्डर रद्द कर दिया गया है।',
  'orderActions.problem.unconfigured': 'यह साइट पूरी तरह कॉन्फ़िगर नहीं है। कृपया हमारी सेल्स टीम से संपर्क करें।',
  'orderActions.problem.unreachable': 'सिस्टम से संपर्क नहीं हो सका। कृपया फिर कोशिश करें।',
  'orderActions.problem.unauthorized': 'आपका सत्र समाप्त हो गया है। कृपया दोबारा साइन इन करें।',
  'orderActions.problem.refused': 'यह काम नहीं हो सका।',
  'orderActions.problem.malformed': 'सिस्टम का जवाब पढ़ा नहीं जा सका। कृपया फिर कोशिश करें।',

  /* ---- Display settings ---------------------------------------------------- */
  'settings.nav': 'प्रदर्शन',
  'settings.heading': 'प्रदर्शन सेटिंग',
  'settings.intro':
    'चुनिए कि यह साइट आपके लिए कैसे लिखी जाए: भाषा और माप की इकाई। दोनों केवल प्रस्तुति हैं — आपके भरे नाप और हमारे निकाले मूल्य इनसे नहीं बदलते। मुद्रा इस पृष्ठ पर चुनी नहीं जा सकती; कारण नीचे दिया है।',
  'settings.meta.title': 'प्रदर्शन सेटिंग',

  'settings.language.legend': 'इस साइट के लिखे जाने की भाषा',
  'settings.language.accountDiffers': (p) => `आपका खाता ${p.language} पर सेट है।`,
  'settings.language.applyAccount': 'इस उपकरण पर खाते की भाषा इस्तेमाल करें',
  'settings.unit.legend': 'माप इस इकाई में दिखाए जाते हैं',
  'settings.currency.legend': 'मूल्य इस मुद्रा में दिखाए जाते हैं',
  'settings.currency.fixed': (p) => `हर भाषा में हमेशा ${p.currency}`,
  'settings.currency.why':
    'हर मूल्य थाई बाट में निकाला और रखा जाता है, और उत्पाद पृष्ठ एक बार बनकर हर आगंतुक में साझा होते हैं, इसलिए उन पर व्यक्ति-विशेष मुद्रा नहीं लगाई जा सकती। कोटेशन अलग है: जिस गंतव्य के लिए हमने दूसरी मुद्रा में भाव देना तय किया है, उसका कोटेशन उसी मुद्रा में जारी होता है — दर वही जो दस्तावेज़ पर जड़ी है — और भुगतान बाट में होता है।',

  'settings.storage.local': 'केवल इसी ब्राउज़र में रखा गया',
  'settings.storage.account': (p, f) => `${f.date(p.at)} को आपके खाते में सहेजा गया`,
  'settings.storage.signIn':
    'इन सेटिंग को अपने दूसरे उपकरणों पर ले जाने के लिए साइन इन कीजिए।',
  'settings.storage.saving': 'सहेजा जा रहा है',
  'settings.storage.failed':
    'खाते में सहेजा नहीं जा सका। चुनाव इस ब्राउज़र में फिर भी लागू है।',
  'settings.storage.forget': 'मेरे खाते में सहेजी गई सेटिंग हटाएँ',

  'settings.messages.heading': 'हम आपको जिस भाषा में लिखते हैं',
  'settings.messages.degraded': (p) =>
    `${p.chosen} का अनुवाद अभी नहीं हुआ है, इसलिए हमारे संदेश ${p.rendered} में पहुँचेंगे।`,
  'settings.messages.coverage': (p, f) =>
    `${f.plain(p.total)} में से ${f.plain(p.translated)} संदेश अनूदित`,

  'settings.effects.heading': 'ये सेटिंग क्या बदलती हैं',
  'settings.effects.intro':
    'यह सूची इस पृष्ठ से नहीं, सर्वर से आती है, और यह उन सेटिंग को भी बताती है जो अभी कुछ नहीं करतीं — ताकि आपको खुद पता न लगाना पड़े।',
  'settings.effect.locale.notification': 'हमारे भेजे ईमेल की भाषा',
  'settings.effect.locale.document': 'पहले जारी कोटेशन और चालान की भाषा',
  'settings.effect.locale.storefront': 'इस वेबसाइट की भाषा',
  'settings.effect.locale.dashboard': 'आंतरिक डैशबोर्ड की भाषा',
  'settings.effect.currency.notification': 'हमारे भेजे ईमेल की मुद्रा',
  'settings.effect.currency.document': 'पहले जारी दस्तावेज़ों की मुद्रा',
  'settings.effect.currency.storefront': 'इस वेबसाइट के मूल्यों की मुद्रा',
  'settings.effect.currency.dashboard': 'आंतरिक डैशबोर्ड की मुद्रा',
  'settings.effect.lengthUnit.notification': 'हमारे भेजे ईमेल की इकाई',
  'settings.effect.lengthUnit.document': 'पहले जारी दस्तावेज़ों की इकाई',
  'settings.effect.lengthUnit.storefront': 'इस वेबसाइट पर नाप दिखाने की इकाई',
  'settings.effect.lengthUnit.dashboard': 'आंतरिक डैशबोर्ड की इकाई',
  'settings.effect.yes': 'लागू है',
  'settings.effect.no': 'अभी लागू नहीं',

  /* ---- Not found ----------------------------------------------------------- */
  'notFound.title': 'पृष्ठ नहीं मिला',
  'notFound.body': 'लिंक बदल गया हो सकता है। उत्पाद सूची से शुरू कीजिए।',

  /* ---- Paying, and attaching a slip ---------------------------------- */
  'payment.action': 'भुगतान करें',
  'payment.meta.title': 'भुगतान की सूचना दें',
  'payment.heading': 'भुगतान की सूचना दें',
  'payment.loading': 'आपके भुगतान का विवरण खोला जा रहा है…',
  'payment.outstanding': 'कुल बकाया राशि',
  'payment.dueNow': 'अभी देय राशि',
  'payment.outstandingAmount': (p, f) => f.bahtExact(p.owedMinor),
  'payment.settled': 'यह ऑर्डर पूरी तरह भुगतान हो चुका है',
  'payment.closed':
    'यह ऑर्डर अब भुगतान स्वीकार नहीं करता। राशि के बारे में कोई सवाल हो तो कृपया सेल्स टीम से संपर्क कीजिए।',
  'payment.closedOwing':
    'कुछ राशि अब भी बकाया है, लेकिन यहाँ से भुगतान नहीं भेजा जा सकता। बाकी राशि चुकाने के लिए कृपया सेल्स टीम से संपर्क कीजिए।',
  'payment.account.legend': 'इनमें से किसी भी खाते में ट्रांसफर करें',
  'payment.account.copy': (p) => `खाता नंबर ${p.accountDigits} कॉपी करें`,
  'payment.account.copied': 'खाता नंबर कॉपी हो गया',
  'payment.account.qrAlt': 'भरी गई राशि के लिए प्रॉम्प्टपे क्यूआर कोड',
  'payment.account.qrHint': 'अपने बैंकिंग ऐप से स्कैन कीजिए — राशि खुद भर जाएगी',
  'payment.account.none':
    'अभी तक कोई प्राप्तकर्ता बैंक खाता सेट नहीं किया गया है। कृपया भुगतान विवरण के लिए सेल्स टीम से संपर्क कीजिए।',
  'payment.form.legend': 'स्लिप जोड़ें',
  'payment.form.image': 'स्लिप की फ़ोटो',
  'payment.form.imageChoose': 'स्लिप की फ़ोटो चुनें',
  'payment.form.imageChange': 'फ़ोटो बदलें',
  'payment.form.imageHint': 'अपने बैंकिंग ऐप का स्क्रीनशॉट भी चलेगा। अधिकतम 8 MB.',
  'payment.form.amount': 'ट्रांसफर की गई राशि',
  'payment.form.transferredAt': 'ट्रांसफर की तारीख और समय',
  'payment.form.reference': 'संदर्भ नंबर (वैकल्पिक)',
  'payment.form.submit': 'स्लिप भेजें',
  'payment.phase.uploading': 'फ़ोटो अपलोड हो रही है…',
  'payment.phase.creating': 'स्लिप सहेजी जा रही है…',
  'payment.done': 'आपकी स्लिप मिल गई है। हमारी टीम इसकी जाँच करके आपको सूचित करेगी।',
  'payment.history.heading': 'आपकी भेजी गई स्लिप',
  'payment.history.empty': 'अभी तक कोई स्लिप नहीं भेजी गई',
  'payment.history.submitted': (p, f) => `${f.bahtExact(p.slipMinor)} · ${f.date(p.sentAt)} को भेजी गई · जाँच जारी है`,
  'payment.history.accepted': (p, f) => `${f.bahtExact(p.slipMinor)} · ${f.date(p.sentAt)} को भेजी गई · स्वीकृत`,
  'payment.history.rejected': (p, f) => `${f.bahtExact(p.slipMinor)} · स्वीकृत नहीं — ${p.reason}`,
  'payment.problem.noImage': 'कृपया स्लिप की फ़ोटो जोड़ें।',
  'payment.problem.imageTooBig': (p, f) =>
    `यह फ़ोटो बहुत बड़ी है — अधिकतम ${f.plain(p.limitMib)} MB.`,
  'payment.problem.badAmount': 'राशि को अंकों में लिखें, दशमलव के बाद अधिकतम दो अंक।',
  'payment.problem.badTime': 'कृपया ट्रांसफर की तारीख और समय दीजिए।',
  'payment.problem.signInAgain':
    'आपका सेशन समाप्त हो गया। कृपया फिर से साइन इन कीजिए — आपकी भरी जानकारी अभी भी यहीं है।',
  'payment.problem.unreachable': 'कनेक्ट नहीं हो सका। कृपया फिर से कोशिश कीजिए।',
};
