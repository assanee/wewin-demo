import type { PartialUiCatalogue } from '../keys';

/**
 * Burmese (မြန်မာ) — complete.
 *
 * ⚠️ **This file used to say "empty on purpose".** That note argued a plausible sentence
 * nobody in the company can read back is worse than a visible fallback, and it still holds
 * for *content* — product names, rule messages, the catalogue — which is why `content.ts`
 * still routes those through `ContentRef`. What changed is that the UI shell, a closed set
 * of 346 keys, was translated on request and is treated as shipped.
 *
 * ── What this catalogue has to get right ─────────────────────────────────────
 *
 *   - **Numerative particles, not plurals.** Nothing agrees in number, but a counted noun
 *     takes a classifier *after* the numeral: ခု for a general item, ခါ for occasions.
 *     `f.integer(n) + ' ခု'` is the shape, and there is deliberately no `count` helper.
 *   - **Verb-final order.** Burmese puts the verb last, so `Reduce X by Y` becomes
 *     `X ကို Y လျှော့ရန်`. This is the entry that would be unwritable if the key had
 *     shipped a pre-joined sentence — the same argument English makes, from the far side.
 *   - **Text is Unicode, not Zawgyi.** The two encodings share a codepoint range and render
 *     as mojibake in each other's font. `fonts.ts` names a Unicode face; a Zawgyi paste into
 *     this file would look correct to whoever pasted it and broken to everyone else.
 *
 * ⚠️ `f.entry` / `f.entryRange` stay ASCII here as everywhere: they label a field the
 * customer types back into, and `parseMeasure` accepts one separator. Burmese digits (၀-၉)
 * in a helper line above an ASCII-only field would be an instruction that field cannot obey.
 */
export const my: PartialUiCatalogue = {
  /* ---- Shell and navigation ---------------------------------------- */
  'a11y.skipToContent': 'ပင်မအကြောင်းအရာသို့ ကျော်သွားရန်',
  'nav.mainLabel': 'ပင်မမီနူး',
  'nav.homeLabel': (p) => `${p.wordmark} ပင်မစာမျက်နှာ`,
  'nav.products': 'ကုန်ပစ္စည်းများ',
  'nav.about': 'ကျွန်ုပ်တို့အကြောင်း',
  'nav.quote': 'စျေးနှုန်းစာရင်း',
  'nav.allProducts': 'ကုန်ပစ္စည်းအားလုံးကြည့်ရန်',
  'nav.backToProducts': 'ကုန်ပစ္စည်းအားလုံးသို့ ပြန်သွားရန်',
  'nav.addMore': 'နောက်ထပ်ကုန်ပစ္စည်းထည့်ရန်',
  'quote.badge.filled': (p, f) => `စျေးနှုန်းစာရင်းတွင် ${f.integer(p.count)} ခု`,
  'quote.badge.empty': 'စျေးနှုန်းစာရင်း ဗလာဖြစ်နေသည်',

  /* ---- Money and measurement ---------------------------------------- */
  'price.perSqmSuffix': '/ m²',
  'price.from': 'စတင်',
  'price.fromShort': 'စ',
  'price.unit': 'တစ်ခုချင်းစျေး',
  'price.total': 'စုစုပေါင်း',
  'price.grandTotal': 'အားလုံးပေါင်း',
  'price.perPiece': (p, f) => `တစ်ခုလျှင် ${f.baht(p.minor)}`,
  'value.unknown': '—',
  'unit.sqmSuffix': 'm²',
  'count.pieces': (p, f) => `${f.integer(p.count)} ခု`,
  'count.items': (p, f) => `${f.integer(p.count)} မျိုး`,
  'count.designs': (p, f) => `ဒီဇိုင်း ${f.integer(p.count)} မျိုး`,
  'leadTime.range': (p, f) => `${f.integer(p.days[0])}–${f.integer(p.days[1])} ရက်`,
  'leadTime.produce': (p, f) =>
    `ထုတ်လုပ်ရန် ${f.integer(p.days[0])}–${f.integer(p.days[1])} ရက်`,

  /* ---- Pickers ------------------------------------------------------ */
  'unit.pickerLabel': 'ယူနစ်',
  'unit.groupLabel': 'အတိုင်းအတာပြသမည့်ယူနစ်',
  'unit.name.mm': 'မီလီမီတာ',
  'unit.name.cm': 'စင်တီမီတာ',
  'unit.name.m': 'မီတာ',
  'unit.name.in': 'လက်မ',
  'unit.name.ft': 'ပေ',
  'locale.pickerLabel': 'ဘာသာစကား',
  'locale.groupLabel': 'ဤဝဘ်ဆိုက်ပြသမည့်ဘာသာစကား',
  'locale.partial': 'အချို့စာသားများကို မဘာသာပြန်ရသေးသဖြင့် ထိုင်းဘာသာဖြင့် ပြသပါမည်။',

  /* ---- Home --------------------------------------------------------- */
  'home.hero.line1': 'သင့်အပေါက်အတိုင်း ပြုလုပ်သည်',
  'home.hero.line2': 'မဖုန်းဆက်မီ စျေးနှုန်းကို ကြည့်လိုက်ပါ',
  'home.hero.body':
    'အလူမီနီယမ် ပြတင်းပေါက်၊ လူဗာနှင့် တံခါးများ။ သင့်အပေါက်၏ အမှန်တကယ်အလျားနှင့် အမြင့်ကို ထည့်ပြီး စျေးနှုန်းအပြည့်ကို ချက်ချင်းကြည့်ပါ — အကောင့်ဝင်စရာမလို၊ ဖုန်းနံပါတ်ကြိုပေးစရာမလို။',
  'home.hero.cta': 'ကုန်ပစ္စည်းများကြည့်၍ စျေးနှုန်းတွက်ရန်',
  'home.fact.designs': 'ရရှိနိုင်သောဒီဇိုင်းများ',
  'home.fact.startingPrice': 'စတင်စျေးနှုန်း',
  'home.fact.leadTime': 'ထုတ်လုပ်ချိန်',
  'home.how.heading': 'ဘယ်လိုလုပ်ဆောင်သလဲ',
  'home.how.body':
    'အတိုင်းအတာအလိုက် မှာယူသည့်လုပ်ငန်းတွင် မဆက်သွယ်မီ စျေးနှုန်းကို ကိုယ်တိုင်ကြည့်ရခြင်းမှာ ယခုထိ ရှားပါးဆဲဖြစ်သည်။ ဆက်လက်၍ ဤသို့ဖြစ်ပါမည်။',
  'home.step.measure.title': 'အပေါက်ကိုတိုင်းပြီး ထည့်ပါ',
  'home.step.measure.body':
    'လိုချင်သောဒီဇိုင်းကို ရွေးပြီး အပေါက်၏ အမှန်တကယ် အလျား × အမြင့်ကို ထည့်ပါ။',
  'home.step.price.title': 'စျေးနှုန်းကို ချက်ချင်းမြင်ရမည်',
  'home.step.price.body':
    'စျေးနှုန်းအပြည့်သည် ချက်ချင်းပေါ်လာပြီး ၎င်းကိုဖွဲ့စည်းသည့် အချက်တိုင်းကို သီးခြားစီ ပြသထားသည်။',
  'home.step.request.title': 'စျေးနှုန်းစာရွက် တောင်းခံရန်',
  'home.step.request.body':
    'စိတ်ဝင်စားသောပစ္စည်းများကို စုစည်းပြီး ကျွန်ုပ်တို့ထံ ပို့ပါ။ ဤအဆင့်တွင် မည်သည့်ကတိကဝတ်မျှ မရှိပါ။',
  'home.step.survey.title': 'မထုတ်လုပ်မီ နေရာတွင် တိုင်းတာခြင်း',
  'home.step.survey.body': (p, f) =>
    `ထုတ်လုပ်မှုမစတင်မီ ကျွန်ုပ်တို့အဖွဲ့သည် နေရာတွင်တိုင်းတာ၍ အတိုင်းအတာနှင့် စျေးနှုန်းကို အတည်ပြုပါသည်။${
      p.days === null
        ? ''
        : ` ဒီဇိုင်းပေါ်မူတည်၍ ထုတ်လုပ်ရန် ${f.integer(p.days[0])}–${f.integer(p.days[1])} ရက် ကြာပါသည်။`
    }`,
  'home.estimate.note':
    'ဤဆိုက်ရှိစျေးနှုန်းသည် သင်ထည့်သွင်းသောအတိုင်းအတာများမှ ခန့်မှန်းချက်ဖြစ်သည်။ နောက်ဆုံးစျေးနှုန်းကို ကျွန်ုပ်တို့အဖွဲ့ နေရာတွင်တိုင်းတာပြီးမှ အတည်ပြုပါသည်။',
  'home.estimate.emphasis': 'သင်ထည့်သွင်းသောအတိုင်းအတာများမှ ခန့်မှန်းချက်',
  'home.categories.heading': 'လုပ်ငန်းအမျိုးအစားအလိုက် ရွေးရန်',
  'home.category.empty': 'ဤအမျိုးအစားတွင် ကုန်ပစ္စည်းမရှိသေးပါ',
  'home.pricing.heading': 'စျေးနှုန်းကို မည်သို့တွက်ချက်သနည်း',
  'home.pricing.body':
    'ဤသုံးချက်လုံးကို ဤနေရာတွင်ဖော်ပြရသည်မှာ နောက်ဆုံးဂဏန်းကိုမြင်မှမဟုတ်ဘဲ အတိုင်းအတာမထည့်မီ သိထားသင့်သောကြောင့်ဖြစ်သည်။',
  'home.pricing.formula.title': 'ပုံသေနည်း',
  'home.pricing.formula.body': 'စျေးနှုန်း = m² တစ်ခုလျှင်နှုန်း × ငွေတောင်းဧရိယာ + ရွေးချယ်စရာများ',
  'home.pricing.formula.note':
    'ရွေးချယ်စရာများတွင် ဘောင်အရောင်၊ မှန်၏အရောင်နှင့်အထူ၊ ထပ်ထည့်သောပစ္စည်းများ ပါဝင်သည်။ တစ်ခုစီကို စျေးနှုန်းစာမျက်နှာတွင် သီးခြားစီ ဖော်ပြထားသည်။',
  'home.pricing.floor.title': 'အနည်းဆုံး ငွေတောင်းဧရိယာ',
  'home.pricing.floor.body':
    'အနည်းဆုံးထက်သေးငယ်သောပြားကို အနည်းဆုံးဧရိယာဖြင့် ငွေတောင်းပါသည်။',
  'home.pricing.floor.range': (p, f) =>
    p.span === null ? '—' : `${f.area(p.span[0])}–${f.area(p.span[1])} m²`,
  'home.pricing.floor.note':
    'ဒီဇိုင်းပေါ်မူတည်သည်။ စျေးနှုန်းစာမျက်နှာတွင် သင်ရွေးထားသောဒီဇိုင်း၏ အနည်းဆုံးကို အမြဲဖော်ပြထားသည်။',
  'home.pricing.excluded.title': 'ဤစျေးနှုန်းတွင် မပါဝင်သည်များ',
  'home.pricing.excluded.install': 'တပ်ဆင်ခြင်း',
  'home.pricing.excluded.delivery': 'ပို့ဆောင်ခြင်း',
  'home.pricing.excluded.removal': 'အဟောင်းဖြုတ်ခြင်း',
  'home.pricing.excluded.note':
    'သုံးခုလုံးသည် နေရာအပေါ်မူတည်သဖြင့် အတိုင်းအတာတစ်ခုတည်းဖြင့် ခန့်မှန်း၍မရပါ။ တိုင်းတာပြီးနောက် စျေးနှုန်းစာရွက်တွင် ပေါ်လာပါမည်။',

  'meta.title': 'WEWIN180 — သင့်အတိုင်းအတာအတိုင်း၊ မမေးမီ စျေးနှုန်းသိပြီး',
  'meta.description':
    'WEWIN180 — သင့်ကိုယ်ပိုင်အတိုင်းအတာဖြင့် ပြုလုပ်သော ပြတင်းပေါက်၊ လူဗာနှင့် တံခါးများ။ စျေးနှုန်းစာရွက်မတောင်းမီ ကိုယ်တိုင်စျေးနှုန်းတွက်ကြည့်ပါ။',

  /* ---- Catalogue ---------------------------------------------------- */
  'catalog.heading': 'ကုန်ပစ္စည်းအားလုံး',
  'catalog.resultCount': (p, f) => `ကုန်ပစ္စည်း ${f.integer(p.count)} မျိုး`,
  'catalog.empty.title': 'ဤစစ်ထုတ်မှုများနှင့် ကိုက်ညီသည့်အရာ မရှိသေးပါ',
  'catalog.empty.body':
    'စစ်ထုတ်မှုတစ်ခုနှစ်ခုကို ဖယ်ပြီး အားလုံးကို ပြန်ကြည့်ကြည့်ပါ။',
  'filter.title': 'စစ်ထုတ်ရန်',
  'filter.clear': 'စစ်ထုတ်မှုများ ဖယ်ရှားရန်',
  'filter.showResults': (p, f) => `ရလဒ်များပြရန် (${f.integer(p.count)} မျိုး)`,
  'filter.section.category': 'အမျိုးအစား',
  'filter.section.profileColor': 'ဘောင်အရောင်',
  'filter.section.pricePerSqm': 'm² တစ်ခုလျှင်စျေးနှုန်း',
  'filter.priceTo': 'မှ',
  'filter.priceMax': 'အများဆုံး',
  'product.colorCount': (p, f) => `ဘောင်အရောင် ${f.integer(p.count)} မျိုး`,
  'product.sizeRange': (p, f) => `အတိုင်းအတာ ${f.range(p.minUm, p.maxUm, p.unit)}`,

  /* ---- Configurator -------------------------------------------------- */
  'configure.loadingLine': 'ဤအရာကို ဖွင့်နေသည်…',
  'configure.spec.note':
    'အသေးစိတ်စံချိန်စံညွှန်း၊ စံနှုန်းများနှင့် အာမခံစည်းကမ်းများအတွက် အောက်ပါဆက်သွယ်ရန်အချက်များမှတစ်ဆင့် ကျွန်ုပ်တို့အဖွဲ့ကို မေးမြန်းပါ။',
  'configure.view.front': 'အရှေ့မျက်နှာ',
  'configure.view.halfPanel': 'တစ်ဝက်ပြား',
  'configure.view.transom': 'အထက်မှန်ပြတင်း',
  'configure.size.heading': 'အတိုင်းအတာ',
  'configure.area.line': (p, f) =>
    `ဧရိယာ ${f.area(p.areaSqUm)} m² · အနည်းဆုံးငွေတောင်း ${f.area(p.minBillableSqUm)} m²`,
  'configure.group.affectsSku': 'ကုန်ပစ္စည်းကုဒ်ကို ပြောင်းလဲစေသည်',
  'configure.futureQuote': 'စျေးနှုန်းစာရွက်တောင်းခံခြင်းကို နောက်ဗားရှင်းတွင် ထည့်ပါမည်။',
  'configure.breakdown.title': 'စျေးနှုန်းအသေးစိတ်',
  'configure.qty': 'အရေအတွက်',
  'configure.qty.decrease': 'တစ်ခု လျှော့ရန်',
  'configure.qty.increase': 'တစ်ခု ထပ်ထည့်ရန်',
  // Burmese is verb-final: the object takes ကို, the amount follows, the verb closes. This
  // is the entry that could not be written if the key had shipped a joined sentence.
  'measure.decrease': (p, f) => `${p.group}ကို ${f.entry(p.stepUm, p.unit)} လျှော့ရန်`,
  'measure.increase': (p, f) => `${p.group}ကို ${f.entry(p.stepUm, p.unit)} တိုးရန်`,
  'measure.helper': (p, f) =>
    `${f.entryRange(p.minUm, p.maxUm, p.unit)} · ${f.entry(p.gridUm, p.unit)} စီ`,

  /* ---- Drawings ------------------------------------------------------- */
  'drawing.schematic': 'အချိုးအစားပုံကြမ်း',
  'drawing.schematic.sized': (p) => `အချိုးအစားပုံကြမ်း၊ ${p.size}`,
  'drawing.elevation': (p) =>
    `မျက်နှာစာပုံ၊ ${p.width} × ${p.height} ${p.unit}${
      p.invalid ? ' — ဤအတိုင်းအတာသည် ပြုလုပ်နိုင်သည့်အတိုင်းအတာပြင်ပတွင် ရှိသည်' : ''
    }`,
  'drawing.unitNote': (p) => `ယူနစ် — ${p.unit}`,

  /* ---- Toolbar, share, QR -------------------------------------------- */
  'toolbar.groupLabel': 'ဤပြင်ဆင်မှုကို စီမံရန်',
  'toolbar.undo': 'နောက်ပြန်',
  'toolbar.redo': 'ပြန်လုပ်',
  'toolbar.reset': 'မူလအတိုင်းပြန်ထား',
  'toolbar.share': 'ဤပြင်ဆင်မှု၏လင့်ခ်ကို မျှဝေရန်',
  'toolbar.qr': 'ဤလင့်ခ်အတွက် QR ကုဒ်ပြုလုပ်ရန်',
  'share.sheet.title': 'လင့်ခ်မျှဝေရန်',
  'share.qr.title': 'ဤလင့်ခ်၏ QR ကုဒ်',
  'share.body':
    'ဤလင့်ခ်သည် သင်ယခုကြည့်နေသည့် အတိုင်းအတာနှင့် ရွေးချယ်မှုများအတိုင်း ပြင်ဆင်စာမျက်နှာကို ဖွင့်ပေးသည်။ တပ်ဆင်သူ သို့မဟုတ် အိမ်ကလူထံ ပို့နိုင်သည်။',
  'share.copyLink': 'လင့်ခ်ကူးရန်',
  'share.copied': 'လင့်ခ်ကူးပြီးပါပြီ',
  'share.showQr': 'QR ကုဒ်အဖြစ်ပြရန်',
  'qr.alt': 'ဤပြင်ဆင်မှုသို့ လင့်ခ်၏ QR ကုဒ်',
  'qr.failed': 'QR ကုဒ်မပြုလုပ်နိုင်ပါ။ လင့်ခ်ကူးသည့်ခလုတ်ကို အသုံးပြုပါ။',

  /* ---- Price summary and breakdown ------------------------------------ */
  'summary.label': 'စျေးနှုန်းအကျဉ်းချုပ်',
  'summary.skuCode': 'ကုန်ပစ္စည်းကုဒ်',
  'summary.copySku': (p) => `ကုန်ပစ္စည်းကုဒ် ${p.skuCode} ကို ကူးရန်`,
  'summary.skuCopied': 'ကုန်ပစ္စည်းကုဒ် ကူးပြီးပါပြီ',
  'summary.add': 'စျေးနှုန်းစာရင်းသို့ ထည့်ရန်',
  'summary.hasErrors': 'အထက်တွင် ပြင်ရန်ကျန်နေသေးသည်။ မည်သည့်အရာလဲ ကြည့်ရန် ခလုတ်ကိုနှိပ်ပါ။',
  'summary.showBreakdown': 'စျေးနှုန်းအသေးစိတ်ကြည့်ရန်',
  'summary.area': (p, f) => `${f.area(p.areaSqUm)} m²`,
  'summary.stickyMeta': (p, f) =>
    `${f.area(p.areaSqUm)} m²${
      p.qty > 1 ? ` · ${f.integer(p.qty)} ခု` : ''
    } · အသေးစိတ်ကြည့်ရန်`,
  'breakdown.minimumApplied': (p, f) =>
    `အမှန်ဧရိယာ ${f.area(p.areaSqUm)} m² · အနည်းဆုံး ${f.area(p.minBillableSqUm)} m² ဖြင့် ငွေတောင်း`,

  /* ---- Quote ---------------------------------------------------------- */
  'quote.heading': 'စျေးနှုန်းစာရင်း',
  'quote.empty.title': 'သင့်စျေးနှုန်းစာရင်းတွင် ဘာမျှမရှိသေးပါ',
  'quote.empty.body':
    'ကုန်ပစ္စည်းတစ်ခုရွေးပါ၊ အပေါက်၏အမှန်တကယ်အတိုင်းအတာကို ထည့်ပါ၊ ပြီးလျှင် ဤနေရာသို့ ထည့်လိုက်ပါ။',
  'quote.empty.cta': 'ကုန်ပစ္စည်းရွေးရန်',
  'quote.summary.label': 'စုစုပေါင်းများ',
  'quote.summary.lineCount': 'ပစ္စည်းများ',
  'quote.summary.lineCountValue': (p, f) =>
    `${f.integer(p.lines)} မျိုး · ${f.integer(p.pieces)} ခု`,
  'quote.summary.leadTime': 'ထုတ်လုပ်ချိန်',
  'quote.tableCaption': 'သင့်စျေးနှုန်းစာရင်းရှိ ပစ္စည်းများ',
  'quote.col.name': 'ပစ္စည်း',
  'quote.col.sku': 'ကုန်ပစ္စည်းကုဒ်',
  'quote.col.size': 'အတိုင်းအတာ',
  'quote.col.qty': 'အရေအတွက်',
  'quote.col.unitPrice': 'တစ်ခုချင်းစျေး',
  'quote.col.total': 'စုစုပေါင်း',
  'quote.col.actions': 'လုပ်ဆောင်ချက်များ',
  'quote.action.edit': (p) => `${p.nickname} ၏ ပြင်ဆင်မှုကို တည်းဖြတ်ရန်`,
  'quote.action.duplicate': (p) => `${p.nickname} ကို ပွားရန်`,
  'quote.action.remove': (p) => `${p.nickname} ကို ဖယ်ရှားရန်`,
  'quote.qty.label': (p) => `${p.nickname} ၏ အရေအတွက်`,
  'quote.qty.decrease': (p) => `${p.nickname} ကို တစ်ခုလျှော့ရန်`,
  'quote.qty.increase': (p) => `${p.nickname} ကို တစ်ခုတိုးရန်`,

  /* ---- Toasts and sheets ----------------------------------------------- */
  'toast.lineSaved': 'ပြောင်းလဲမှုများ သိမ်းပြီးပါပြီ',
  'toast.lineAdded': 'စျေးနှုန်းစာရင်းသို့ ထည့်ပြီးပါပြီ',
  'toast.viewQuote': 'စျေးနှုန်းစာရင်းကြည့်ရန်',
  'toast.dismiss': 'မက်ဆေ့ချ်ပိတ်ရန်',
  'sheet.close': 'ပိတ်ရန်',
  'sheet.closeNamed': (p) => `${p.title} ကို ပိတ်ရန်`,

  /* ---- About ------------------------------------------------------------ */
  'about.heading': 'ကျွန်ုပ်တို့အကြောင်း',
  'about.intro':
    'ကျွန်ုပ်တို့သည် သင့်နေရာ၏အမှန်တကယ်အတိုင်းအတာအတိုင်း အလူမီနီယမ်လုပ်ငန်းများကို ပြုလုပ်ပေးသည်။ ကျွန်ုပ်တို့စက်ရုံသည် ဖစ်ဆနူးလုတ်တွင် ရှိသည်။',
  'about.tool':
    'ဤဆိုက်သည် ကျွန်ုပ်တို့၏ကိုယ်ပိုင် စျေးနှုန်းတွက်ချက်ကိရိယာဖြစ်သည်။ အပေါက်၏အလျားနှင့်အမြင့်ကို ထည့်လိုက်လျှင် မည်သူ့ကိုမျှ ကြိုဆက်သွယ်စရာမလိုဘဲ စျေးနှုန်းအပြည့်ကို ချက်ချင်းမြင်ရမည်။',
  'about.stance.heading': 'ကျွန်ုပ်တို့ စျေးနှုန်းများကို အဘယ်ကြောင့် ထုတ်ပြန်သနည်း',
  'about.stance.noPhone.title':
    'စျေးနှုန်းမေးရန်အတွက် သင့်ဖုန်းနံပါတ်ကို ပေးဆပ်စရာမလိုသင့်ပါ',
  'about.stance.noPhone.body':
    'အတိုင်းအတာအလိုက်မှာယူသည့်လုပ်ငန်းအများစုသည် ဂဏန်းမပြောမီ ဖုန်းနံပါတ်တောင်းသည်။ ဆိုလိုသည်မှာ ခန့်မှန်းခြေဘတ်ဂျက်လောက်သာ သိလိုသူသည်လည်း နောက်ဆက်တွဲဖုန်းကို ခံရမည်ဖြစ်သည်။ ထိုအဆင့်ကို ကျွန်ုပ်တို့ ဖယ်ရှားလိုက်သည်။',
  'about.stance.itemised.title': 'စျေးနှုန်းသည် ဘယ်ကလာသည်ကို ပြသင့်သည်',
  'about.stance.itemised.body':
    'စျေးနှုန်းစာမျက်နှာသည် စုစုပေါင်းကိုဖွဲ့စည်းသည့် အချက်တိုင်းကို ဖော်ပြသည် — ဧရိယာ၊ အရောင်၊ မှန်နှင့် ပစ္စည်းများ။ ဂဏန်းပြောင်းလျှင် ဘာကြောင့်ပြောင်းသည်ကို သင်မြင်နိုင်သည်။',
  'about.stance.limits.title': 'ကန့်သတ်ချက်များကို ကြိုတင်ပြောသည်၊ နောက်မှမဟုတ်',
  'about.stance.limits.body':
    'အနည်းဆုံးငွေတောင်းဧရိယာ၊ ကျွန်ုပ်တို့မပြုလုပ်နိုင်သောအတိုင်းအတာများနှင့် စျေးနှုန်းတွင်မပါဝင်သည်များအားလုံးကို သင်အတိုင်းအတာမထည့်မီ ဆိုက်ပေါ်တွင် ဖော်ပြထားသည်။ စကားပြောနေရင်း ပေါ်လာသည်မဟုတ်ပါ။',
  'about.range.heading': 'ကျွန်ုပ်တို့ ဘာလုပ်သလဲ',
  'about.range.body':
    'ဤနေရာရှိ ဂဏန်းတိုင်းသည် စျေးနှုန်းတွက်ချက်သည့် တူညီသောစာရင်းမှပင် ဖတ်ယူထားခြင်းဖြစ်သည်။ မည်သည့်အရာမျှ သီးခြားရေးမှတ်ထားခြင်းမဟုတ်ပါ။',
  'about.fact.designs.note': (p, f) => `အမျိုးအစား ${f.integer(p.categories)} ခုအတွင်း`,
  'about.fact.leadTime.note': 'ဒီဇိုင်းပေါ်မူတည်သည်',
  'about.fact.floor': 'အနည်းဆုံး ငွေတောင်းဧရိယာ',
  'about.fact.floor.note': 'ထိုထက်သေးငယ်သောပြားများကို အနည်းဆုံးဖြင့် ငွေတောင်းသည်',
  'about.fact.legalName': 'မှတ်ပုံတင်အမည်',
  'about.fact.makes': 'ကျွန်ုပ်တို့ ဘာလုပ်သလဲ',
  'about.fact.serviceArea': 'ကျွန်ုပ်တို့ ဘယ်ကိုပို့သလဲ',
  'about.contact.heading': 'ကျွန်ုပ်တို့ ဘယ်မှာရှိပြီး ဘယ်လိုဆက်သွယ်မလဲ',
  'about.card.factory': 'စက်ရုံနှင့် ရုံးခန်း',
  'about.card.delivery': 'ပို့ဆောင်ခြင်းနှင့် တပ်ဆင်ခြင်း',
  'about.card.delivery.note':
    'တပ်ဆင်ခြင်းနှင့် ပို့ဆောင်ခြင်းသည် နေရာနှင့် အကွာအဝေးပေါ်မူတည်သဖြင့် ဤဆိုက်ရှိစျေးနှုန်းများတွင် မပါဝင်ပါ။ ကျွန်ုပ်တို့အဖွဲ့သည် စျေးနှုန်းစာရွက်တွင် ခန့်မှန်းပေးပါမည်။',
  'about.card.hours': 'ဖွင့်ချိန်',
  'about.card.hours.note':
    'ဖွင့်ချိန်ပြင်ပတွင် LINE သို့မဟုတ် အီးမေးလ်ဖြင့် စာထားခဲ့ပါ။ ကျွန်ုပ်တို့အဖွဲ့သည် နောက်လုပ်ငန်းရက်တွင် ပြန်ကြားပါမည်။',

  /* ---- Footer ------------------------------------------------------------ */
  'footer.contact': 'ဆက်သွယ်ရန်',
  'footer.hours': 'ဖွင့်ချိန်',
  'footer.serviceArea': 'ဝန်ဆောင်မှုဧရိယာ',
  'footer.menu': 'မီနူး',
  // The era is the formatter's business. Nothing here does arithmetic on a year.
  'footer.copyright': (p, f) => `© ${f.year(p.year)}`,

  /* ---- Contact channels and the spec sheet -------------------------------- */
  'contact.phone': 'ဖုန်း',
  'contact.line': 'LINE',
  'contact.email': 'အီးမေးလ်',
  'spec.material': 'ပစ္စည်း',
  'spec.material.value': 'ထုတ်လုပ်ပြီး အလူမီနီယမ်ဘောင်',
  'spec.profileThickness': 'ဘောင်အထူ',
  'spec.standards': 'ပြည့်မီသောစံနှုန်းများ',
  'spec.warranty': 'အာမခံ',

  /* ---- Reviews ------------------------------------------------------------- */
  'review.heading': 'တပ်ဆင်ပြီးသော ဖောက်သည်များ၏ သုံးသပ်ချက်များ',
  'review.summary': (p, f) =>
    `၅ တွင် ${f.rating(p.ratingSum, p.ratingCount)} · သုံးသပ်ချက် ${f.integer(p.ratingCount)} ခု`,
  'review.hiddenNote': (p, f) =>
    `သုံးသပ်ချက်စည်းမျဉ်းချိုးဖောက်မှုကြောင့် သုံးသပ်ချက် ${f.integer(
      p.hidden,
    )} ခုကို ဖျောက်ထားသည် — ထိုအမှတ်များသည် အထက်ပါပျမ်းမျှတွင် ဆက်လက်ပါဝင်သည်`,
  'review.publishedOn': (p, f) => `${f.date(p.at)} တွင် ရေးသားသည်`,
  'review.author.anonymous': 'ဖောက်သည်',
  'review.size': (p, f) => `${f.dimensions(p.widthUm, p.heightUm, p.unit)} အတိုင်းအတာဖြင့် မှာယူသည်`,
  'review.erased':
    'ဤသုံးသပ်ချက်၏ စာသားနှင့် အမည်ကို ရေးသားသူ၏တောင်းဆိုချက်အရ ဖယ်ရှားလိုက်သည်။ အမှတ်မှာ ဆက်လက်ပါဝင်သည်။',
  'review.reply.heading': 'WEWIN180 ၏ ပြန်ကြားချက်',
  'review.reply.on': (p, f) => `${f.date(p.at)} တွင် ပြန်ကြားသည်`,
  'review.photo.alt': (p, f) => `ဖောက်သည်ဓာတ်ပုံ ${f.integer(p.index)}`,
  'review.more': (p, f) => `နောက်ထပ် သုံးသပ်ချက် ${f.integer(p.remaining)} ခု`,

  'review.form.heading': 'သုံးသပ်ချက်ရေးရန်',
  'review.form.for': (p) => `${p.name} ကို သုံးသပ်ခြင်း`,
  'review.form.intro':
    'အလူမီနီယမ်ကို တပ်ပြီး သုံးရက်အကြာမဟုတ်ဘဲ မိုးရာသီတစ်ခုပြီးမှ ဆုံးဖြတ်သည် — အဆင်သင့်ဖြစ်သည့်အခါ ရေးပါ။ ဤနေရာ ဘယ်တော့မှမပိတ်ပါ။',
  'review.form.rating.legend': 'ကြယ်ဘယ်နှစ်ပွင့်',
  'review.form.rating.option': (p, f) => `ကြယ် ${f.integer(p.stars)} ပွင့်`,
  'review.form.rating.required': 'မပို့မီ ကြယ်အဆင့်ကို ရွေးပါ',
  'review.form.body.label': 'ကျွန်ုပ်တို့ကို ပြောပြပါ (ရွေးချယ်နိုင်သည်)',
  'review.form.body.help':
    'လိပ်စာ၊ ဖုန်းနံပါတ်နှင့် အခြားသူများ၏အချက်အလက်များကို မထည့်ပါနှင့် — ဤစာမျက်နှာမှာ အများမြင်ရသည့်စာမျက်နှာဖြစ်သည်။',
  'review.form.name.label': 'ပြသမည့်အမည် (ရွေးချယ်နိုင်သည်)',
  'review.form.name.help':
    'သင့်သုံးသပ်ချက်ဘေးတွင် ပြပါမည်။ အတိုကောက်လည်းရသည်၊ ဗလာထားလည်းရသည်။',
  'review.form.submit': 'သုံးသပ်ချက်ပို့ရန်',
  'review.form.submitting': 'ပို့နေသည်…',
  'review.form.moderation':
    'ကျွန်ုပ်တို့ဖတ်ပြီးသည်နှင့် သင့်သုံးသပ်ချက်သည် ကုန်ပစ္စည်းစာမျက်နှာတွင် ပေါ်လာမည်။ သို့မဟုတ် သုံးသပ်ချိန်ကုန်ဆုံးလျှင် အလိုအလျောက် ပေါ်လာမည်။',
  'review.form.loading': 'သင့်ဖိတ်ကြားချက်ကို ဖွင့်နေသည်…',
  'review.form.invalid.title': 'ဤလင့်ခ် အလုပ်မလုပ်ပါ',
  'review.form.invalid.body':
    'အသုံးပြုပြီးဖြစ်နိုင်သည် သို့မဟုတ် မပြည့်စုံစွာ ကူးယူထားနိုင်သည်။ ဖိတ်ကြားချက်အီးမေးလ်မှ ထပ်မံဖွင့်ကြည့်ပါ။',
  'review.form.failed.title': 'သုံးသပ်ချက် မပို့နိုင်ခဲ့ပါ',
  'review.form.failed.body':
    'ထပ်ကြိုးစားပါ။ ဆက်၍မရသေးလျှင် ဖိတ်ကြားချက်အီးမေးလ်ကို ပြန်စာပို့ပါ။',
  'review.form.done.title': 'ကျေးဇူးတင်ပါသည် — သင့်သုံးသပ်ချက် ရရှိပါပြီ',
  'review.form.done.body':
    'ဖတ်ပြီးသည်နှင့် သို့မဟုတ် သုံးသပ်ချိန်ကုန်ဆုံးသည်နှင့် ကုန်ပစ္စည်းစာမျက်နှာတွင် ပေါ်လာပါမည်။',
  'review.meta.title': 'သုံးသပ်ချက်ရေးရန်',

  'account.title': 'ကျွန်ုပ်၏အကောင့်',
  'account.password.section': 'စကားဝှက်ပြောင်းရန်',
  'account.password.current': 'လက်ရှိစကားဝှက်',
  'account.password.new': 'စကားဝှက်အသစ်',
  'account.password.confirm': 'စကားဝှက်အသစ်ကို အတည်ပြုရန်',
  'account.password.action': 'စကားဝှက်ပြောင်းရန်',
  'account.password.saving': 'ပြောင်းနေသည်…',
  'account.password.done': 'စကားဝှက်ပြောင်းပြီးပါပြီ',
  'account.password.doneOthers':
    'စကားဝှက်ပြောင်းပြီးပါပြီ — သင့်အခြားစက်များမှလည်း ထွက်ပြီးပါပြီ။',
  'account.password.note':
    'ပြောင်းလိုက်လျှင် သင်ဝင်ထားသည့် အခြားစက်အားလုံးမှ ထွက်သွားပါမည်။ ဤစက်မှာ ဆက်ရှိနေမည်။',
  'account.password.problem.currentMissing': 'သင့်လက်ရှိစကားဝှက်ကို ထည့်ပါ။',
  'account.password.problem.tooShort':
    'စကားဝှက်အသစ် တိုလွန်းသည် — အနည်းဆုံး ၁၂ လုံး။',
  'account.password.problem.sameAsCurrent':
    'စကားဝှက်အသစ်သည် လက်ရှိစကားဝှက်နှင့် ကွဲပြားရမည်။',
  'account.password.problem.mismatch': 'စကားဝှက်အသစ်နှင့် အတည်ပြုချက် မကိုက်ညီပါ။',
  'account.checking': 'စစ်ဆေးနေသည်…',
  'account.needAccount': 'စျေးနှုန်းစာရွက်တောင်းရန် အကောင့်ဝင်ပါ',
  'account.whyAccount':
    'စျေးနှုန်းစာရွက်သည် သင့်အကောင့်နှင့်သက်ဆိုင်ပြီး မည်သည့်စက်တွင်မဆို ဖွင့်နိုင်စေရန် — မှတ်ပုံတင်ရန် ဖုန်းနံပါတ်တစ်ခုနှင့် စကားဝှက်တစ်ခုသာ လိုသည်။',
  'account.register': 'အကောင့်ဖွင့်ရန်',
  'account.signIn': 'အကောင့်ဝင်ရန်',
  'account.haveAccount': 'အကောင့်ရှိပြီးသားလား?',
  'account.noAccount': 'အကောင့်မရှိသေးဘူးလား?',
  'account.phone': 'ဖုန်း',
  'account.username': 'ဖုန်းနံပါတ် သို့မဟုတ် အီးမေးလ်',
  'account.usernameHint':
    'သင်မှတ်ပုံတင်ခဲ့သည့်နံပါတ် သို့မဟုတ် အကောင့်ရှိပြီးသားဖြစ်ပါက အီးမေးလ်။',
  'account.password': 'စကားဝှက်',
  'account.passwordHint': 'အနည်းဆုံး ၁၂ လုံး။',
  'account.signedInAs': 'ဝင်ရောက်ထားသည်',
  'account.signOut': 'ထွက်ရန်',
  'account.problem.badPhone': 'ဤဖုန်းနံပါတ်ကို မဖတ်နိုင်ပါ — ဥပမာ 081-234-5678။',
  'account.problem.passwordTooShort': 'ဤစကားဝှက် တိုလွန်းသည် — အနည်းဆုံး ၁၂ လုံး။',
  'account.problem.unreachable': 'ချိတ်ဆက်၍မရပါ။ ထပ်ကြိုးစားပါ။',
  'account.problem.unconfigured': 'ယခုအသုံးမပြုနိုင်ပါ။ အရောင်းအဖွဲ့ကို ဆက်သွယ်ပါ။',
  'account.myQuotations': 'ကျွန်ုပ်၏ စျေးနှုန်းစာရွက်များ',
  'account.noQuotations': 'စျေးနှုန်းစာရွက် မရှိသေးပါ',

  'submit.heading': 'စျေးနှုန်းစာရွက် တောင်းခံရန်',
  'submit.intro':
    'အမည်တစ်ခုနှင့် ဆက်သွယ်နိုင်သည့်နည်းလမ်းတစ်ခုပေးပါ၊ ကျွန်ုပ်တို့ စျေးနှုန်းစာရွက်ကို ချက်ချင်းထုတ်ပေးပါမည် — စျေးနှုန်းများနှင့် အသေးစိတ်များကို ဤစာရင်းတွင်ပေါ်နေသည့်အတိုင်း အတိအကျ ပုံသေထားပါမည်။',
  'submit.name': 'ဆက်သွယ်ရန်အမည်',
  'submit.namePlaceholder': 'အမည်အပြည့်အစုံ',
  'submit.email': 'အီးမေးလ်',
  'submit.phone': 'ဖုန်း',
  'submit.channelHint': 'နှစ်ခုအနက် အနည်းဆုံးတစ်ခု — ဖုန်းနံပါတ်တစ်ခုတည်းလည်း ရပါသည်။',
  'submit.destination': 'ပန်းတိုင်နိုင်ငံ',
  'submit.action': 'စျေးနှုန်းစာရွက် တောင်းခံရန်',
  'submit.sending': 'စျေးနှုန်းစာရွက် ထုတ်နေသည်…',
  'submit.problem.nameMissing': 'ဆက်သွယ်ရန်အမည်ကို ထည့်ပါ။',
  'submit.problem.noChannel': 'အီးမေးလ်လိပ်စာ သို့မဟုတ် ဖုန်းနံပါတ်ကို ထည့်ပါ။',
  'submit.problem.badPhone': 'ဤဖုန်းနံပါတ်ကို မဖတ်နိုင်ပါ — ဥပမာ 081-234-5678။',
  'submit.problem.badEmail': 'ဤအီးမေးလ်လိပ်စာကို မဖတ်နိုင်ပါ။',
  'submit.problem.badDestination':
    'ကျေးဇူးပြု၍ ပန်းတိုင်ကို ပြန်ရွေးပါ — ယခင်ရွေးချယ်မှုသည် စာရင်းတွင် မရှိတော့ပါ။',
  'submit.problem.unreachable': 'ချိတ်ဆက်၍မရပါ။ ထပ်ကြိုးစားပါ။',
  'submit.problem.unconfigured':
    'ယခု တောင်းဆိုချက်များ လက်မခံနိုင်ပါ။ အရောင်းအဖွဲ့ကို ဆက်သွယ်ပါ။',
  'submit.problem.unavailable':
    'သင့်စာရင်းထဲရှိ တစ်ခုခုသည် မရရှိနိုင်တော့ပါ။ ထိုစာကြောင်းကို ဖယ်ပြီး ထပ်ကြိုးစားပါ။',
  'submit.done': 'သင့်စျေးနှုန်းစာရွက် အဆင်သင့်ဖြစ်ပါပြီ',
  'submit.viewQuotation': 'စျေးနှုန်းစာရွက်ဖွင့်ရန်',

  'quotation.meta.title': 'သင့်စျေးနှုန်းစာရွက်',
  'quotation.loading': 'သင့်စျေးနှုန်းစာရွက်ကို ဖွင့်နေသည်…',
  'quotation.heading': 'စျေးနှုန်းစာရွက်',
  'quotation.unavailable.title': 'ဤစျေးနှုန်းစာရွက်ကို မဖွင့်နိုင်ပါ',
  'quotation.unavailable.body':
    'လင့်ခ်သက်တမ်းကုန်နေနိုင်သည် သို့မဟုတ် မပြည့်စုံစွာ ကူးယူထားနိုင်သည်။ အရောင်းအဖွဲ့ထံ လင့်ခ်အသစ်တောင်းပါ။',
  'quotation.unreachable.title': 'ယခု ချိတ်ဆက်၍မရပါ',
  'quotation.unreachable.body':
    'ထပ်ကြိုးစားပါ။ ဆက်၍မရသေးလျှင် အရောင်းအဖွဲ့ကို ဆက်သွယ်ပါ။',
  'quotation.retry': 'ထပ်ကြိုးစားရန်',
  'quotation.print': 'ပရင့်ထုတ်ရန် သို့မဟုတ် PDF အဖြစ်သိမ်းရန်',
  'quotation.orderNo': 'အမှတ်',
  'quotation.revision': 'တည်းဖြတ်ချက်',
  'quotation.submittedAt': 'အတည်ပြုသည့်ရက်',
  'quotation.leadTime': 'ပို့ဆောင်ချိန် (ရက်)',
  'quotation.net': 'VAT မတိုင်မီ',
  'quotation.vat': 'VAT',
  'quotation.vatIncluded': 'ဈေးနှုန်းတွင် ထည့်သွင်းပြီးဖြစ်သည်',
  'quotation.total': 'စုစုပေါင်း',
  'quotation.fx.rate': ({ currency, rateText }) => `ငွေလဲနှုန်း ၁ ${currency} = ${rateText} THB`,
  'quotation.fx.observedAt': ({ observedAt }) => `နှုန်းထား ${observedAt}`,
  'quotation.fx.manual': 'ကုမ္ပဏီသတ်မှတ်နှုန်း',
  'quotation.fx.settlementNote': ({ currency }) => `အထက်ပါ ${currency} ပမာဏများသည် ကိုးကားဈေးနှုန်းဖြစ်သည်။ ငွေပေးချေမှုကို ထိုင်းဘတ်ဖြင့် အောက်ပါပမာဏအတိုင်း ပြုလုပ်ပါသည်။`,
  'quotation.fx.payable': 'ပေးချေရမည့်ပမာဏ',
  'quotation.fx.deposit': 'ဦးစွာပေးရမည့် စရန်ငွေ',
  'quotation.lineNo': 'စဉ်',
  'quotation.item': 'အမျိုးအမည်',
  'quotation.qty': 'အရေအတွက်',
  'quotation.amount': 'ငွေပမာဏ',
  'quotation.charges': 'အခြားကုန်ကျစရိတ်',
  'quotation.pinnedNotice':
    'ဤစာရွက်စာတမ်းကို အတည်ပြုသည့်နေ့တွင် ပုံသေထားပြီးဖြစ်သည် — ပြန်ဖွင့်သည့်အခါ ဂဏန်းများနှင့် ဘာသာစကား ပြောင်းလဲမည်မဟုတ်ပါ။',
  'quotation.degraded':
    'ပုံသေထားသောဘာသာစကားသည် ဤဗားရှင်းတွင် မရရှိနိုင်သဖြင့် ထိုင်းဘာသာဖြင့် ပြသထားသည်။',
  'quotation.contact': 'သို့',
  'quotation.seller.phone': 'ဖုန်း',
  'quotation.seller.taxId': 'အခွန် ID',

  /* ---- Display settings ---------------------------------------------------- */
  'settings.nav': 'ပြသမှု',
  'settings.heading': 'ပြသမှုဆက်တင်များ',
  'settings.intro':
    'ဤဆိုက်ကို သင့်အတွက် မည်သို့ရေးသားမည်ကို ရွေးပါ — ဘာသာစကား၊ တိုင်းတာမှုယူနစ်နှင့် ငွေကြေး။ သုံးခုလုံးသည် ပြသမှုသက်သက်ဖြစ်သည် — သင်ထည့်သောအတိုင်းအတာများနှင့် ကျွန်ုပ်တို့တွက်ချက်သောစျေးနှုန်းများ ပြောင်းလဲမည်မဟုတ်ပါ။',
  'settings.meta.title': 'ပြသမှုဆက်တင်များ',

  'settings.language.legend': 'ဤဆိုက်ကို ရေးသားသည့်ဘာသာစကား',
  'settings.language.accountDiffers': (p) => `သင့်အကောင့်ကို ${p.language} အဖြစ် သတ်မှတ်ထားသည်။`,
  'settings.language.applyAccount': 'ဤစက်တွင် အကောင့်၏ဘာသာစကားကို သုံးရန်',
  'settings.unit.legend': 'အတိုင်းအတာပြသမည့်ယူနစ်',
  'settings.currency.legend': 'စျေးနှုန်းပြသမည့်ငွေကြေး',
  'settings.currency.fixed': (p) => `ဘာသာစကားတိုင်းတွင် အမြဲ ${p.currency}`,
  'settings.currency.why':
    'စျေးနှုန်းတိုင်းကို ထိုင်းဘတ်ဖြင့် တွက်ချက်၍ သိမ်းဆည်းထားပြီး ကုန်ပစ္စည်းစာမျက်နှာများကို တစ်ကြိမ်တည်းတည်ဆောက်၍ လာရောက်သူတိုင်း မျှဝေသုံးသဖြင့် လူတစ်ဦးချင်းအလိုက် ငွေကြေးကို အသုံးမပြုနိုင်ပါ။ နိုင်ငံခြားဖောက်သည်ကို ၎င်းတို့၏ငွေကြေးဖြင့် စျေးနှုန်းပေးခြင်းမှာ သီးခြားကိစ္စဖြစ်ပြီး ယခုအထိ ဖွင့်မထားပါ။',

  'settings.storage.local': 'ဤဘရောက်ဇာတွင်သာ သိမ်းထားသည်',
  'settings.storage.account': (p, f) => `${f.date(p.at)} တွင် သင့်အကောင့်သို့ သိမ်းထားသည်`,
  'settings.storage.signIn':
    'ဤဆက်တင်များကို သင့်အခြားစက်များသို့ ယူဆောင်ရန် အကောင့်ဝင်ပါ။',
  'settings.storage.saving': 'သိမ်းနေသည်',
  'settings.storage.failed':
    'အကောင့်သို့ မသိမ်းနိုင်ပါ။ ရွေးချယ်မှုမှာ ဤဘရောက်ဇာတွင် ဆက်လက်အကျုံးဝင်သည်။',
  'settings.storage.forget': 'ကျွန်ုပ်အကောင့်တွင် သိမ်းထားသောဆက်တင်များကို ဖျက်ရန်',

  'settings.messages.heading': 'ကျွန်ုပ်တို့ သင့်ထံရေးသားသည့် ဘာသာစကား',
  'settings.messages.degraded': (p) =>
    `${p.chosen} ကို မဘာသာပြန်ရသေးသဖြင့် ကျွန်ုပ်တို့ထံမှ မက်ဆေ့ချ်များသည် ${p.rendered} ဖြင့် ရောက်ရှိပါမည်။`,
  'settings.messages.coverage': (p, f) =>
    `မက်ဆေ့ချ် ${f.plain(p.total)} ခုအနက် ${f.plain(p.translated)} ခု ဘာသာပြန်ပြီး`,

  'settings.effects.heading': 'ဤဆက်တင်များ ဘာကိုပြောင်းလဲစေသလဲ',
  'settings.effects.intro':
    'ဤစာရင်းသည် ဤစာမျက်နှာမှမဟုတ်ဘဲ ဆာဗာမှလာသည်။ သင်ကိုယ်တိုင် ရှာဖွေရန်ချန်ထားမည့်အစား ယခုအထိအလုပ်မလုပ်သေးသည့် ဆက်တင်များကိုပါ ဖော်ပြထားသည်။',
  'settings.effect.locale.notification': 'ကျွန်ုပ်တို့ပို့သော အီးမေးလ်များ၏ဘာသာစကား',
  'settings.effect.locale.document': 'ထုတ်ပြီးသော စျေးနှုန်းစာရွက်နှင့် ငွေတောင်းခံလွှာများ၏ဘာသာစကား',
  'settings.effect.locale.storefront': 'ဤဝဘ်ဆိုက်၏ဘာသာစကား',
  'settings.effect.locale.dashboard': 'အတွင်းပိုင်းဒက်ရှ်ဘုတ်၏ဘာသာစကား',
  'settings.effect.currency.notification': 'ကျွန်ုပ်တို့ပို့သော အီးမေးလ်များရှိ ငွေကြေး',
  'settings.effect.currency.document': 'ထုတ်ပြီးသော စာရွက်စာတမ်းများရှိ ငွေကြေး',
  'settings.effect.currency.storefront': 'ဤဝဘ်ဆိုက်ရှိ စျေးနှုန်းများ၏ငွေကြေး',
  'settings.effect.currency.dashboard': 'အတွင်းပိုင်းဒက်ရှ်ဘုတ်ရှိ ငွေကြေး',
  'settings.effect.lengthUnit.notification': 'ကျွန်ုပ်တို့ပို့သော အီးမေးလ်များရှိ ယူနစ်',
  'settings.effect.lengthUnit.document': 'ထုတ်ပြီးသော စာရွက်စာတမ်းများရှိ ယူနစ်',
  'settings.effect.lengthUnit.storefront': 'ဤဝဘ်ဆိုက်တွင် အတိုင်းအတာပြသသည့်ယူနစ်',
  'settings.effect.lengthUnit.dashboard': 'အတွင်းပိုင်းဒက်ရှ်ဘုတ်ရှိ ယူနစ်',
  'settings.effect.yes': 'အကျုံးဝင်သည်',
  'settings.effect.no': 'ယခုအထိ မအကျုံးဝင်သေးပါ',

  /* ---- Not found ----------------------------------------------------------- */
  'notFound.title': 'ဤစာမျက်နှာ မတွေ့ပါ',
  'notFound.body': 'လင့်ခ် ပြောင်းလဲသွားနိုင်သည်။ ကုန်ပစ္စည်းစာရင်းမှ စတင်ကြည့်ပါ။',

  /* ---- Paying, and attaching a slip ---------------------------------- */
  'payment.action': 'ငွေပေးချေရန်',
  'payment.meta.title': 'ငွေပေးချေမှု အသိပေးရန်',
  'payment.heading': 'ငွေပေးချေမှု အသိပေးရန်',
  'payment.loading': 'သင့်ငွေပေးချေမှုအချက်အလက်များ ဖွင့်နေသည်…',
  'payment.outstanding': 'ကျန်ရှိနေသေးသောပမာဏ',
  'payment.outstandingAmount': (p, f) => f.bahtExact(p.owedMinor),
  'payment.settled': 'ဤအော်ဒါအတွက် ငွေပေးချေမှု ပြီးပါပြီ',
  'payment.account.legend': 'အောက်ပါဘဏ်အကောင့်များထဲမှ တစ်ခုသို့ လွှဲပါ',
  'payment.account.copy': (p) => `ဘဏ်အကောင့်နံပါတ် ${p.accountDigits} ကို ကူးရန်`,
  'payment.account.copied': 'ဘဏ်အကောင့်နံပါတ် ကူးပြီးပါပြီ',
  'payment.account.qrAlt': 'ထည့်ထားသောပမာဏအတွက် PromptPay QR ကုဒ်',
  'payment.account.qrHint': 'သင့်ဘဏ်အက်ပ်ဖြင့် စကင်ဖတ်ပါ — ပမာဏကို အလိုအလျောက် ဖြည့်ပေးပါမည်',
  'payment.account.none':
    'ငွေလက်ခံရန် ဘဏ်အကောင့် မသတ်မှတ်ရသေးပါ။ ငွေပေးချေမှုအချက်အလက်များအတွက် အရောင်းအဖွဲ့ကို ဆက်သွယ်ပါ။',
  'payment.form.legend': 'ငွေလွှဲပြေစာ တွဲပို့ရန်',
  'payment.form.image': 'ငွေလွှဲပြေစာဓာတ်ပုံ',
  'payment.form.imageChoose': 'ပြေစာပုံ ရွေးရန်',
  'payment.form.imageChange': 'ပုံ ပြောင်းရန်',
  'payment.form.imageHint': 'သင့်ဘဏ်အက်ပ်မှ စကရင်ရှော့လည်း ရပါသည်။ 8 MB အထိ။',
  'payment.form.amount': 'လွှဲထားသောပမာဏ',
  'payment.form.transferredAt': 'လွှဲသည့် ရက်စွဲနှင့် အချိန်',
  'payment.form.reference': 'ကိုးကားနံပါတ် (ရွေးချယ်နိုင်)',
  'payment.form.submit': 'ငွေလွှဲပြေစာ ပို့ရန်',
  'payment.phase.uploading': 'ဓာတ်ပုံ တင်နေသည်…',
  'payment.phase.creating': 'ငွေလွှဲပြေစာ သိမ်းနေသည်…',
  'payment.done':
    'သင့်ငွေလွှဲပြေစာ ရရှိပါပြီ။ ကျွန်ုပ်တို့အဖွဲ့က စစ်ဆေးပြီး ပြန်လည်အကြောင်းကြားပါမည်။',
  'payment.history.heading': 'သင်ပို့ခဲ့သော ငွေလွှဲပြေစာများ',
  'payment.history.empty': 'ငွေလွှဲပြေစာ မပို့ရသေးပါ',
  'payment.history.submitted': (p, f) => `${f.bahtExact(p.slipMinor)} · ${f.date(p.sentAt)} တွင် ပို့ · စစ်ဆေးဆဲ`,
  'payment.history.accepted': (p, f) => `${f.bahtExact(p.slipMinor)} · ${f.date(p.sentAt)} တွင် ပို့ · လက်ခံပြီး`,
  'payment.history.rejected': (p, f) => `${f.bahtExact(p.slipMinor)} · လက်မခံပါ — ${p.reason}`,
  'payment.problem.noImage': 'ငွေလွှဲပြေစာဓာတ်ပုံ တွဲပို့ပေးပါ။',
  'payment.problem.imageTooBig': (p, f) =>
    `ဓာတ်ပုံ ကြီးလွန်းသည် — ${f.plain(p.limitMib)} MB အထိသာ ခွင့်ပြုသည်။`,
  'payment.problem.badAmount': 'ပမာဏကို ဂဏန်းဖြင့် ဒဿမနှစ်လုံးအထိသာ ရေးပါ။',
  'payment.problem.badTime': 'လွှဲသည့် ရက်စွဲနှင့် အချိန်ကို ရွေးပေးပါ။',
  'payment.problem.signInAgain':
    'သင့်စက်ရှင် သက်တမ်းကုန်သွားပါပြီ။ ထပ်မံ အကောင့်ဝင်ပေးပါ — ဖြည့်ထားသော အချက်အလက်များ ရှိနေပါသေးသည်။',
  'payment.problem.unreachable': 'ချိတ်ဆက်၍ မရပါ။ ထပ်စမ်းကြည့်ပါ။',
};
