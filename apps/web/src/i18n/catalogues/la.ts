import type { PartialUiCatalogue } from '../keys';

/**
 * Lao (ລາວ) — complete.
 *
 * ⚠️ **This file used to say "empty on purpose".** That note argued a plausible sentence
 * nobody in the company can read back is worse than a visible fallback, and it still holds
 * for *content* — product names, rule messages, the catalogue — which is why `content.ts`
 * still routes those through `ContentRef`. What changed is that the UI shell, a closed set
 * of 346 keys, was translated on request and is treated as shipped.
 *
 * ── The risk here is the opposite of German's ────────────────────────────────
 *
 * Lao and Thai are close enough that word order and grammar transfer almost unchanged —
 * there is no plural agreement to add and no clause to rearrange. What does *not* transfer
 * is vocabulary, and the failure mode is the false friend rather than the broken sentence:
 *
 *   - Thai ตะกร้า is a physical basket; the list on this site is ລາຍການ (a list).
 *   - Thai ใบเສนอราคา is ໃບສະເໜີລາຄາ, close, but ລາຄາ takes ໜ not ນ.
 *   - Thai ห้อง / Lao ຫ້ອງ agree, but Thai กระจก (glass) is ແກ້ວ here, which in Thai
 *     (แก้ว) means a drinking glass.
 *
 * Because the two scripts look alike, a wrong word here is far less visible than a wrong
 * word in German would be. Nothing in this file was transliterated from Thai.
 *
 * ⚠️ `f.entry` / `f.entryRange` stay ASCII here as everywhere: they label a field the
 * customer types back into, and `parseMeasure` accepts one separator. Lao digits in a
 * helper line above an ASCII-only field would be an instruction that field cannot obey.
 */
export const la: PartialUiCatalogue = {
  /* ---- Shell and navigation ---------------------------------------- */
  'a11y.skipToContent': 'ຂ້າມໄປຫາເນື້ອໃນຫຼັກ',
  'nav.mainLabel': 'ເມນູຫຼັກ',
  'nav.homeLabel': (p) => `ໜ້າຫຼັກ ${p.wordmark}`,
  'nav.products': 'ສິນຄ້າ',
  'nav.about': 'ກ່ຽວກັບພວກເຮົາ',
  'nav.quote': 'ລາຍການສະເໜີລາຄາ',
  'nav.allProducts': 'ເບິ່ງສິນຄ້າທັງໝົດ',
  'nav.backToProducts': 'ກັບໄປສິນຄ້າທັງໝົດ',
  'nav.addMore': 'ເພີ່ມສິນຄ້າອີກ',
  'quote.badge.filled': (p, f) => `ມີ ${f.integer(p.count)} ລາຍການໃນລາຍການສະເໜີລາຄາ`,
  'quote.badge.empty': 'ລາຍການສະເໜີລາຄາຫວ່າງເປົ່າ',

  /* ---- Money and measurement ---------------------------------------- */
  'price.perSqmSuffix': '/ m²',
  'price.from': 'ເລີ່ມຕົ້ນ',
  'price.fromShort': 'ເລີ່ມ',
  'price.unit': 'ລາຄາຕໍ່ອັນ',
  'price.total': 'ລວມ',
  'price.grandTotal': 'ລວມທັງໝົດ',
  'price.perPiece': (p, f) => `${f.baht(p.minor)} ຕໍ່ອັນ`,
  'value.unknown': '—',
  'unit.sqmSuffix': 'm²',
  'count.pieces': (p, f) => `${f.integer(p.count)} ອັນ`,
  'count.items': (p, f) => `${f.integer(p.count)} ລາຍການ`,
  'count.designs': (p, f) => `${f.integer(p.count)} ແບບ`,
  'leadTime.range': (p, f) => `${f.integer(p.days[0])}–${f.integer(p.days[1])} ວັນ`,
  'leadTime.produce': (p, f) => `ຜະລິດ ${f.integer(p.days[0])}–${f.integer(p.days[1])} ວັນ`,

  /* ---- Pickers ------------------------------------------------------ */
  'unit.pickerLabel': 'ຫົວໜ່ວຍ',
  'unit.groupLabel': 'ຂະໜາດສະແດງເປັນ',
  'unit.name.mm': 'ມິນລິແມັດ',
  'unit.name.cm': 'ເຊັນຕີແມັດ',
  'unit.name.m': 'ແມັດ',
  'unit.name.in': 'ນິ້ວ',
  'unit.name.ft': 'ຟຸດ',
  'locale.pickerLabel': 'ພາສາ',
  'locale.groupLabel': 'ພາສາທີ່ເວັບໄຊນີ້ສະແດງ',
  'locale.partial': 'ບາງຂໍ້ຄວາມຍັງບໍ່ໄດ້ແປ ແລະ ຈະສະແດງເປັນພາສາໄທ.',

  /* ---- Home --------------------------------------------------------- */
  'home.hero.line1': 'ຜະລິດຕາມຊ່ອງເປີດຂອງທ່ານ',
  'home.hero.line2': 'ເຫັນລາຄາກ່ອນໂທ',
  'home.hero.body':
    'ປ່ອງຢ້ຽມ ບານເກັດ ແລະ ປະຕູອາລູມິນຽມ. ປ້ອນຄວາມກວ້າງ ແລະ ຄວາມສູງຈິງຂອງຊ່ອງເປີດ ແລ້ວເຫັນລາຄາເຕັມທັນທີ — ບໍ່ຕ້ອງເຂົ້າລະບົບ ບໍ່ຕ້ອງໃຫ້ເບີໂທກ່ອນ.',
  'home.hero.cta': 'ເບິ່ງສິນຄ້າ ແລະ ຄິດໄລ່ລາຄາ',
  'home.fact.designs': 'ແບບທີ່ມີ',
  'home.fact.startingPrice': 'ລາຄາເລີ່ມຕົ້ນ',
  'home.fact.leadTime': 'ໄລຍະເວລາຜະລິດ',
  'home.how.heading': 'ຂັ້ນຕອນເປັນແນວໃດ',
  'home.how.body':
    'ວຽກສັ່ງຕັດຕາມຂະໜາດ ການໄດ້ເຫັນລາຄາເອງກ່ອນຕິດຕໍ່ຍັງເປັນເລື່ອງບໍ່ທັນທົ່ວໄປ. ຕໍ່ໄປນີ້ຄືສິ່ງທີ່ຈະເກີດຂຶ້ນ.',
  'home.step.measure.title': 'ວັດຊ່ອງເປີດ ແລ້ວປ້ອນຂະໜາດ',
  'home.step.measure.body': 'ເລືອກແບບທີ່ຕ້ອງການ ແລ້ວປ້ອນຄວາມກວ້າງ × ຄວາມສູງຈິງຂອງຊ່ອງເປີດ.',
  'home.step.price.title': 'ເຫັນລາຄາທັນທີ',
  'home.step.price.body': 'ລາຄາເຕັມປາກົດຂຶ້ນທັນທີ ພ້ອມທຸກລາຍການທີ່ປະກອບເປັນລາຄານັ້ນແຍກໃຫ້ເຫັນ.',
  'home.step.request.title': 'ຂໍໃບສະເໜີລາຄາ',
  'home.step.request.body':
    'ເກັບລວມສິນຄ້າທີ່ທ່ານສົນໃຈ ແລ້ວສົ່ງມາໃຫ້ພວກເຮົາ. ຂັ້ນຕອນນີ້ຍັງບໍ່ມີຂໍ້ຜູກພັນໃດໆ.',
  'home.step.survey.title': 'ວັດແທກໜ້າງານກ່ອນຜະລິດ',
  'home.step.survey.body': (p, f) =>
    `ທີມງານຂອງພວກເຮົາຈະໄປວັດແທກໜ້າງານ ເພື່ອຢືນຢັນຂະໜາດ ແລະ ລາຄາກ່ອນເລີ່ມຜະລິດ.${
      p.days === null
        ? ''
        : ` ການຜະລິດໃຊ້ເວລາ ${f.integer(p.days[0])}–${f.integer(p.days[1])} ວັນ ຂຶ້ນກັບແບບ.`
    }`,
  'home.estimate.note':
    'ລາຄາໃນເວັບໄຊນີ້ແມ່ນການປະເມີນຈາກຂະໜາດທີ່ທ່ານປ້ອນ. ລາຄາສຸດທ້າຍຈະຢືນຢັນຫຼັງທີມງານໄປວັດແທກໜ້າງານ.',
  'home.estimate.emphasis': 'ການປະເມີນຈາກຂະໜາດທີ່ທ່ານປ້ອນ',
  'home.categories.heading': 'ເລືອກຕາມປະເພດວຽກ',
  'home.category.empty': 'ຍັງບໍ່ມີສິນຄ້າໃນໝວດນີ້',
  'home.pricing.heading': 'ລາຄາຄິດໄລ່ແນວໃດ',
  'home.pricing.body':
    'ສາມຂໍ້ນີ້ຢູ່ບ່ອນນີ້ ເພາະທ່ານຄວນຮູ້ກ່ອນປ້ອນຂະໜາດ ບໍ່ແມ່ນຕອນເຫັນຕົວເລກສຸດທ້າຍ.',
  'home.pricing.formula.title': 'ສູດຄິດໄລ່',
  'home.pricing.formula.body': 'ລາຄາ = ລາຄາຕໍ່ m² × ເນື້ອທີ່ທີ່ຄິດເງິນ + ຕົວເລືອກ',
  'home.pricing.formula.note':
    'ຕົວເລືອກລວມມີສີເຟຣມ ສິ່ງທີ່ໃສ່ໃນບານ — ແກ້ວ ໃບລະແນງ ຫຼື ມຸ້ງ — ພ້ອມອຸປະກອນທີ່ທ່ານເພີ່ມ. ແຕ່ລະຢ່າງລະບຸແຍກໄວ້ໃນໜ້າລາຄາ.',
  'home.pricing.floor.title': 'ເນື້ອທີ່ຄິດເງິນຂັ້ນຕ່ຳ',
  'home.pricing.floor.body': 'ບານທີ່ນ້ອຍກວ່າຂັ້ນຕ່ຳ ຈະຄິດເງິນຕາມເນື້ອທີ່ຂັ້ນຕ່ຳ.',
  'home.pricing.floor.range': (p, f) =>
    p.span === null ? '—' : `${f.area(p.span[0])}–${f.area(p.span[1])} m²`,
  'home.pricing.floor.note': 'ຂຶ້ນກັບແບບ. ໜ້າລາຄາລະບຸຂັ້ນຕ່ຳຂອງແບບທີ່ທ່ານເລືອກສະເໝີ.',
  'home.pricing.excluded.title': 'ລາຄານີ້ຍັງບໍ່ລວມ',
  'home.pricing.excluded.install': 'ການຕິດຕັ້ງ',
  'home.pricing.excluded.delivery': 'ການຂົນສົ່ງ',
  'home.pricing.excluded.removal': 'ການຮື້ຂອງເກົ່າ',
  'home.pricing.excluded.note':
    'ທັງສາມຢ່າງຂຶ້ນກັບໜ້າງານ ຈຶ່ງບໍ່ສາມາດປະເມີນຈາກຂະໜາດຢ່າງດຽວໄດ້. ພວກມັນຈະປາກົດໃນໃບສະເໜີລາຄາຫຼັງການວັດແທກ.',

  'meta.title': 'WEWIN180 — ຜະລິດຕາມຂະໜາດຂອງທ່ານ ຮູ້ລາຄາກ່ອນຖາມ',
  'meta.description':
    'WEWIN180 — ປ່ອງຢ້ຽມ ບານເກັດ ແລະ ປະຕູ ຜະລິດຕາມຂະໜາດຂອງທ່ານເອງ. ຄິດໄລ່ລາຄາເອງກ່ອນຂໍໃບສະເໜີລາຄາ.',

  /* ---- Catalogue ---------------------------------------------------- */
  'catalog.heading': 'ສິນຄ້າທັງໝົດ',
  'catalog.resultCount': (p, f) => `${f.integer(p.count)} ລາຍການ`,
  'catalog.empty.title': 'ຍັງບໍ່ມີສິນຄ້າທີ່ກົງກັບຕົວກັ່ນຕອງເຫຼົ່ານີ້',
  'catalog.empty.body': 'ລອງເອົາຕົວກັ່ນຕອງອອກໜຶ່ງສອງອັນ ແລ້ວເບິ່ງທັງໝົດອີກເທື່ອໜຶ່ງ.',
  'filter.title': 'ຕົວກັ່ນຕອງ',
  'filter.clear': 'ລ້າງຕົວກັ່ນຕອງ',
  'filter.showResults': (p, f) => `ສະແດງຜົນ (${f.integer(p.count)} ລາຍການ)`,
  'filter.section.category': 'ໝວດ',
  'filter.section.profileColor': 'ສີເຟຣມ',
  'filter.section.pricePerSqm': 'ລາຄາຕໍ່ m²',
  'filter.priceTo': 'ຫາ',
  'filter.priceMax': 'ບໍ່ເກີນ',
  'product.colorCount': (p, f) => `${f.integer(p.count)} ສີເຟຣມ`,
  'product.sizeRange': (p, f) => `ຂະໜາດ ${f.range(p.minUm, p.maxUm, p.unit)}`,

  /* ---- Configurator -------------------------------------------------- */
  'configure.loadingLine': 'ກຳລັງໂຫຼດລາຍການນີ້…',
  'configure.spec.note':
    'ສຳລັບຂໍ້ມູນດ້ານເຕັກນິກ ມາດຕະຖານ ແລະ ເງື່ອນໄຂການຮັບປະກັນ ກະລຸນາຕິດຕໍ່ທີມງານຕາມຂໍ້ມູນຂ້າງລຸ່ມ.',
  'configure.view.front': 'ດ້ານໜ້າ',
  'configure.view.halfPanel': 'ເຄິ່ງບານ',
  'configure.view.transom': 'ຊ່ອງແສງເທິງ',
  'configure.size.heading': 'ຂະໜາດ',
  'configure.area.line': (p, f) =>
    `ເນື້ອທີ່ ${f.area(p.areaSqUm)} m² · ຄິດເງິນຂັ້ນຕ່ຳ ${f.area(p.minBillableSqUm)} m²`,
  'configure.group.affectsSku': 'ມີຜົນຕໍ່ລະຫັດສິນຄ້າ',
  'configure.quoteNext': 'ເພີ່ມເຂົ້າລາຍການສະເໜີລາຄາ ແລ້ວຂໍໃບສະເໜີລາຄາໄດ້ຈາກໜ້ານັ້ນ.',
  'configure.breakdown.title': 'ລາຍລະອຽດລາຄາ',
  'configure.qty': 'ຈຳນວນ',
  'configure.qty.decrease': 'ຫຼຸດໜຶ່ງອັນ',
  'configure.qty.increase': 'ເພີ່ມໜຶ່ງອັນ',
  // Lao follows Thai's clause order closely here, which is the one place the two agree
  // cleanly — the key still carries the parts, because English and German do not.
  'measure.decrease': (p, f) => `ຫຼຸດ${p.group} ${f.entry(p.stepUm, p.unit)}`,
  'measure.increase': (p, f) => `ເພີ່ມ${p.group} ${f.entry(p.stepUm, p.unit)}`,
  'measure.helper': (p, f) =>
    `${f.entryRange(p.minUm, p.maxUm, p.unit)} · ເທື່ອລະ ${f.entry(p.gridUm, p.unit)}`,

  /* ---- Drawings ------------------------------------------------------- */
  'drawing.schematic': 'ຮູບແປນສັດສ່ວນ',
  'drawing.schematic.sized': (p) => `ຮູບແປນສັດສ່ວນ, ${p.size}`,
  'drawing.elevation': (p) =>
    `ຮູບດ້ານ, ${p.width} × ${p.height} ${p.unit}${
      p.invalid ? ' — ຂະໜາດນີ້ຢູ່ນອກຂອບເຂດທີ່ຜະລິດໄດ້' : ''
    }`,
  'drawing.unitNote': (p) => `ຫົວໜ່ວຍ: ${p.unit}`,

  /* ---- Toolbar, share, QR -------------------------------------------- */
  'toolbar.groupLabel': 'ຈັດການການຕັ້ງຄ່ານີ້',
  'toolbar.undo': 'ຍົກເລີກ',
  'toolbar.redo': 'ເຮັດຄືນ',
  'toolbar.reset': 'ກັບໄປຄ່າເລີ່ມຕົ້ນ',
  'toolbar.share': 'ແບ່ງປັນລິ້ງຂອງການຕັ້ງຄ່ານີ້',
  'toolbar.qr': 'ສ້າງ QR ໂຄດສຳລັບລິ້ງນີ້',
  'share.sheet.title': 'ແບ່ງປັນລິ້ງ',
  'share.qr.title': 'QR ໂຄດຂອງລິ້ງນີ້',
  'share.body':
    'ລິ້ງນີ້ຈະເປີດໜ້າຕັ້ງຄ່າ ດ້ວຍຂະໜາດ ແລະ ຕົວເລືອກດຽວກັນກັບທີ່ທ່ານກຳລັງເບິ່ງ. ສົ່ງໃຫ້ຊ່າງຕິດຕັ້ງ ຫຼື ຄົນຢູ່ເຮືອນໄດ້.',
  'share.copyLink': 'ສຳເນົາລິ້ງ',
  'share.copied': 'ສຳເນົາລິ້ງແລ້ວ',
  'share.showQr': 'ສະແດງເປັນ QR ໂຄດ',
  'qr.alt': 'QR ໂຄດຂອງລິ້ງໄປຫາການຕັ້ງຄ່ານີ້',
  'qr.failed': 'ສ້າງ QR ໂຄດບໍ່ໄດ້. ກະລຸນາໃຊ້ປຸ່ມສຳເນົາລິ້ງແທນ.',

  /* ---- Price summary and breakdown ------------------------------------ */
  'summary.label': 'ສະຫຼຸບລາຄາ',
  'summary.skuCode': 'ລະຫັດສິນຄ້າ',
  'summary.copySku': (p) => `ສຳເນົາລະຫັດສິນຄ້າ ${p.skuCode}`,
  'summary.skuCopied': 'ສຳເນົາລະຫັດສິນຄ້າແລ້ວ',
  'summary.add': 'ເພີ່ມເຂົ້າລາຍການສະເໜີລາຄາ',
  'summary.hasErrors': 'ຍັງມີບາງຢ່າງຕ້ອງແກ້ຢູ່ຂ້າງເທິງ. ກົດປຸ່ມເພື່ອເບິ່ງວ່າແມ່ນຫຍັງ.',
  'summary.showBreakdown': 'ເບິ່ງລາຍລະອຽດລາຄາ',
  'summary.area': (p, f) => `${f.area(p.areaSqUm)} m²`,
  'summary.stickyMeta': (p, f) =>
    `${f.area(p.areaSqUm)} m²${
      p.qty > 1 ? ` · ${f.integer(p.qty)} ອັນ` : ''
    } · ເບິ່ງລາຍລະອຽດ`,
  'breakdown.minimumApplied': (p, f) =>
    `ເນື້ອທີ່ຈິງ ${f.area(p.areaSqUm)} m² · ຄິດເງິນຕາມຂັ້ນຕ່ຳ ${f.area(p.minBillableSqUm)} m²`,

  /* ---- Quote ---------------------------------------------------------- */
  'quote.heading': 'ລາຍການສະເໜີລາຄາ',
  'quote.empty.title': 'ຍັງບໍ່ມີຫຍັງໃນລາຍການສະເໜີລາຄາ',
  'quote.empty.body': 'ເລືອກສິນຄ້າ ປ້ອນຂະໜາດຈິງຂອງຊ່ອງເປີດ ແລ້ວເພີ່ມເຂົ້າມາບ່ອນນີ້.',
  'quote.empty.cta': 'ເລືອກສິນຄ້າ',
  'quote.summary.label': 'ຍອດລວມ',
  'quote.summary.lineCount': 'ລາຍການ',
  'quote.summary.lineCountValue': (p, f) =>
    `${f.integer(p.lines)} ລາຍການ · ${f.integer(p.pieces)} ອັນ`,
  'quote.summary.leadTime': 'ໄລຍະເວລາຜະລິດ',
  'quote.tableCaption': 'ລາຍການໃນລາຍການສະເໜີລາຄາ',
  'quote.col.name': 'ລາຍການ',
  'quote.col.sku': 'ລະຫັດສິນຄ້າ',
  'quote.col.size': 'ຂະໜາດ',
  'quote.col.qty': 'ຈຳນວນ',
  'quote.col.unitPrice': 'ລາຄາຕໍ່ອັນ',
  'quote.col.total': 'ລວມ',
  'quote.col.actions': 'ຄຳສັ່ງ',
  'quote.action.edit': (p) => `ແກ້ໄຂການຕັ້ງຄ່າຂອງ ${p.nickname}`,
  'quote.action.duplicate': (p) => `ສຳເນົາ ${p.nickname}`,
  'quote.action.remove': (p) => `ລຶບ ${p.nickname}`,
  'quote.qty.label': (p) => `ຈຳນວນຂອງ ${p.nickname}`,
  'quote.qty.decrease': (p) => `ຫຼຸດ ${p.nickname} ໜຶ່ງອັນ`,
  'quote.qty.increase': (p) => `ເພີ່ມ ${p.nickname} ໜຶ່ງອັນ`,

  /* ---- Toasts and sheets ----------------------------------------------- */
  'toast.lineSaved': 'ບັນທຶກການປ່ຽນແປງແລ້ວ',
  'toast.lineAdded': 'ເພີ່ມເຂົ້າລາຍການສະເໜີລາຄາແລ້ວ',
  'toast.viewQuote': 'ເບິ່ງລາຍການສະເໜີລາຄາ',
  'toast.dismiss': 'ປິດຂໍ້ຄວາມ',
  'sheet.close': 'ປິດ',
  'sheet.closeNamed': (p) => `ປິດ ${p.title}`,

  /* ---- About ------------------------------------------------------------ */
  'about.heading': 'ກ່ຽວກັບພວກເຮົາ',
  'about.intro':
    'ພວກເຮົາຜະລິດງານອາລູມິນຽມຕາມຂະໜາດຈິງໜ້າງານຂອງທ່ານ. ໂຮງງານຂອງພວກເຮົາຢູ່ພິດສະນຸໂລກ.',
  'about.tool':
    'ເວັບໄຊນີ້ແມ່ນເຄື່ອງມືຄິດໄລ່ລາຄາຂອງພວກເຮົາເອງ. ປ້ອນຄວາມກວ້າງ ແລະ ຄວາມສູງຂອງຊ່ອງເປີດ ແລ້ວເຫັນລາຄາເຕັມທັນທີ ໂດຍບໍ່ຕ້ອງຕິດຕໍ່ໃຜກ່ອນ.',
  'about.stance.heading': 'ເປັນຫຍັງພວກເຮົາຈຶ່ງເປີດເຜີຍລາຄາ',
  'about.stance.noPhone.title': 'ການຖາມລາຄາບໍ່ຄວນຕ້ອງແລກດ້ວຍເບີໂທຂອງທ່ານ',
  'about.stance.noPhone.body':
    'ວຽກສັ່ງຕັດສ່ວນຫຼາຍຈະຂໍເບີໂທກ່ອນຈຶ່ງບອກຕົວເລກ ໝາຍຄວາມວ່າຄົນທີ່ພຽງຢາກຮູ້ງົບປະມານຄ່າວໆ ກໍຕ້ອງຮັບສາຍທີ່ຕາມມາ. ພວກເຮົາຕັດຂັ້ນຕອນນັ້ນອອກ.',
  'about.stance.itemised.title': 'ລາຄາຄວນບອກໄດ້ວ່າມາຈາກໃສ',
  'about.stance.itemised.body':
    'ໜ້າລາຄາລະບຸທຸກລາຍການທີ່ປະກອບເປັນຍອດລວມ — ເນື້ອທີ່ ສີ ສິ່ງທີ່ໃສ່ໃນບານ ແລະ ອຸປະກອນ. ເມື່ອຕົວເລກປ່ຽນ ທ່ານເຫັນວ່າຫຍັງເປັນຕົວປ່ຽນ.',
  'about.stance.limits.title': 'ບອກຂໍ້ຈຳກັດແຕ່ຕົ້ນ ບໍ່ແມ່ນຕອນທ້າຍ',
  'about.stance.limits.body':
    'ເນື້ອທີ່ຄິດເງິນຂັ້ນຕ່ຳ ຂະໜາດທີ່ພວກເຮົາຜະລິດບໍ່ໄດ້ ແລະ ສິ່ງທີ່ລາຄາບໍ່ລວມ ລ້ວນຢູ່ໃນເວັບກ່ອນທ່ານປ້ອນຂະໜາດ ບໍ່ແມ່ນຄ່ອຍໂຜ່ຂຶ້ນລະຫວ່າງການສົນທະນາ.',
  'about.range.heading': 'ພວກເຮົາຜະລິດຫຍັງ',
  'about.range.body':
    'ທຸກຕົວເລກໃນນີ້ອ່ານມາຈາກລາຍການສິນຄ້າຊຸດດຽວກັນກັບທີ່ຄິດໄລ່ລາຄາ. ບໍ່ມີອັນໃດຂຽນແຍກໄວ້ຕ່າງຫາກ.',
  'about.fact.designs.note': (p, f) => `ໃນ ${f.integer(p.categories)} ໝວດ`,
  'about.fact.leadTime.note': 'ຂຶ້ນກັບແບບ',
  'about.fact.floor': 'ເນື້ອທີ່ຄິດເງິນຂັ້ນຕ່ຳ',
  'about.fact.floor.note': 'ບານທີ່ນ້ອຍກວ່ານີ້ຄິດເງິນຕາມຂັ້ນຕ່ຳ',
  'about.fact.legalName': 'ຊື່ຈົດທະບຽນ',
  'about.fact.makes': 'ພວກເຮົາຜະລິດຫຍັງ',
  'about.fact.serviceArea': 'ພວກເຮົາສົ່ງໄປໃສ',
  'about.contact.heading': 'ພວກເຮົາຢູ່ໃສ ແລະ ຕິດຕໍ່ແນວໃດ',
  'about.card.factory': 'ໂຮງງານ ແລະ ຫ້ອງການ',
  'about.card.delivery': 'ການຂົນສົ່ງ ແລະ ຕິດຕັ້ງ',
  'about.card.delivery.note':
    'ລາຄາໃນເວັບໄຊນີ້ຍັງບໍ່ລວມການຕິດຕັ້ງ ແລະ ຂົນສົ່ງ ເພາະຂຶ້ນກັບໜ້າງານ ແລະ ໄລຍະທາງ. ທີມງານຈະປະເມີນໃຫ້ໃນໃບສະເໜີລາຄາ.',
  'about.card.hours': 'ເວລາເປີດ',
  'about.card.hours.note':
    'ນອກເວລາເປີດ ກະລຸນາຝາກຂໍ້ຄວາມທາງ LINE ຫຼື ອີເມວ ທີມງານຈະຕອບໃນວັນເຮັດວຽກຖັດໄປ.',

  /* ---- Footer ------------------------------------------------------------ */
  'footer.contact': 'ຕິດຕໍ່ພວກເຮົາ',
  'footer.hours': 'ເວລາເປີດ',
  'footer.serviceArea': 'ເຂດໃຫ້ບໍລິການ',
  'footer.menu': 'ເມນູ',
  // The era is the formatter's business. Nothing here does arithmetic on a year.
  'footer.copyright': (p, f) => `© ${f.year(p.year)}`,

  /* ---- Contact channels and the spec sheet -------------------------------- */
  'contact.phone': 'ໂທລະສັບ',
  'contact.line': 'LINE',
  'contact.email': 'ອີເມວ',
  'spec.material': 'ວັດສະດຸ',
  'spec.material.value': 'ອາລູມິນຽມອັດຮີດ',
  'spec.profileThickness': 'ຄວາມໜາຂອງເຟຣມ',
  'spec.standards': 'ມາດຕະຖານທີ່ໄດ້ຮັບ',
  'spec.warranty': 'ການຮັບປະກັນ',

  /* ---- Reviews ------------------------------------------------------------- */
  'review.heading': 'ຄຳຕິຊົມຈາກລູກຄ້າທີ່ຕິດຕັ້ງແລ້ວ',
  'review.summary': (p, f) =>
    `${f.rating(p.ratingSum, p.ratingCount)} ຈາກ 5 · ${f.integer(p.ratingCount)} ຄຳຕິຊົມ`,
  'review.hiddenNote': (p, f) =>
    `ມີ ${f.integer(
      p.hidden,
    )} ຄຳຕິຊົມຖືກເຊື່ອງເນື່ອງຈາກຜິດກົດການຕິຊົມ — ຄະແນນເຫຼົ່ານັ້ນຍັງນັບເຂົ້າຄ່າສະເລ່ຍຂ້າງເທິງ`,
  'review.publishedOn': (p, f) => `ຂຽນເມື່ອ ${f.date(p.at)}`,
  'review.author.anonymous': 'ລູກຄ້າ',
  'review.size': (p, f) => `ສັ່ງທີ່ຂະໜາດ ${f.dimensions(p.widthUm, p.heightUm, p.unit)}`,
  'review.erased':
    'ຂໍ້ຄວາມ ແລະ ຊື່ໃນຄຳຕິຊົມນີ້ຖືກລຶບຕາມການຮ້ອງຂໍຂອງຜູ້ຂຽນ. ຄະແນນຍັງນັບຢູ່.',
  'review.reply.heading': 'ຄຳຕອບຈາກ WEWIN180',
  'review.reply.on': (p, f) => `ຕອບເມື່ອ ${f.date(p.at)}`,
  'review.photo.alt': (p, f) => `ຮູບຈາກລູກຄ້າ ${f.integer(p.index)}`,
  'review.more': (p, f) => `ແລະ ອີກ ${f.integer(p.remaining)} ຄຳຕິຊົມ`,

  'review.form.heading': 'ຂຽນຄຳຕິຊົມ',
  'review.form.for': (p) => `ຕິຊົມ ${p.name}`,
  'review.form.intro':
    'ງານສັ່ງເຮັດຕັດສິນກັນຫຼັງຜ່ານລະດູຝົນ ບໍ່ແມ່ນສາມມື້ຫຼັງຕິດຕັ້ງ — ຂຽນເມື່ອທ່ານພ້ອມ. ບ່ອນນີ້ບໍ່ມີວັນປິດ.',
  'review.form.rating.legend': 'ໃຫ້ຈັກດາວ',
  'review.form.rating.option': (p, f) => `${f.integer(p.stars)} ດາວ`,
  'review.form.rating.required': 'ກະລຸນາເລືອກຈຳນວນດາວກ່ອນສົ່ງ',
  'review.form.body.label': 'ເລົ່າໃຫ້ພວກເຮົາຟັງ (ບໍ່ບັງຄັບ)',
  'review.form.body.help':
    'ກະລຸນາຢ່າໃສ່ທີ່ຢູ່ ເບີໂທ ຫຼື ຂໍ້ມູນຂອງຄົນອື່ນ — ໜ້ານີ້ເປັນໜ້າສາທາລະນະ.',
  'review.form.name.label': 'ຊື່ທີ່ຈະສະແດງ (ບໍ່ບັງຄັບ)',
  'review.form.name.help': 'ຈະສະແດງຂ້າງຄຳຕິຊົມຂອງທ່ານ. ໃສ່ຕົວຫຍໍ້ກໍໄດ້ ຫວ່າງໄວ້ກໍໄດ້.',
  'review.form.submit': 'ສົ່ງຄຳຕິຊົມ',
  'review.form.submitting': 'ກຳລັງສົ່ງ…',
  'review.form.moderation':
    'ຄຳຕິຊົມຂອງທ່ານຈະປາກົດໃນໜ້າສິນຄ້າຫຼັງພວກເຮົາອ່ານແລ້ວ ຫຼື ປາກົດເອງເມື່ອໝົດໄລຍະກວດ.',
  'review.form.loading': 'ກຳລັງເປີດຄຳເຊີນຂອງທ່ານ…',
  'review.form.invalid.title': 'ລິ້ງນີ້ໃຊ້ບໍ່ໄດ້',
  'review.form.invalid.body':
    'ອາດຖືກໃຊ້ໄປແລ້ວ ຫຼື ສຳເນົາມາບໍ່ຄົບ. ລອງເປີດຈາກອີເມວຄຳເຊີນອີກເທື່ອໜຶ່ງ.',
  'review.form.failed.title': 'ຄຳຕິຊົມສົ່ງບໍ່ສຳເລັດ',
  'review.form.failed.body': 'ລອງໃໝ່ອີກເທື່ອ. ຖ້າຍັງບໍ່ໄດ້ ກະລຸນາຕອບກັບອີເມວຄຳເຊີນ.',
  'review.form.done.title': 'ຂອບໃຈ — ພວກເຮົາໄດ້ຮັບຄຳຕິຊົມແລ້ວ',
  'review.form.done.body':
    'ມັນຈະປາກົດໃນໜ້າສິນຄ້າຫຼັງຖືກອ່ານ ຫຼື ເມື່ອໝົດໄລຍະກວດ.',
  'review.meta.title': 'ຂຽນຄຳຕິຊົມ',

  'account.title': 'ບັນຊີຂອງຂ້ອຍ',
  'account.password.section': 'ປ່ຽນລະຫັດຜ່ານ',
  'account.password.current': 'ລະຫັດຜ່ານປັດຈຸບັນ',
  'account.password.new': 'ລະຫັດຜ່ານໃໝ່',
  'account.password.confirm': 'ຢືນຢັນລະຫັດຜ່ານໃໝ່',
  'account.password.action': 'ປ່ຽນລະຫັດຜ່ານ',
  'account.password.saving': 'ກຳລັງປ່ຽນ…',
  'account.password.done': 'ປ່ຽນລະຫັດຜ່ານແລ້ວ',
  'account.password.doneOthers':
    'ປ່ຽນລະຫັດຜ່ານແລ້ວ — ແລະ ອຸປະກອນອື່ນຂອງທ່ານຖືກອອກຈາກລະບົບ.',
  'account.password.note':
    'ການປ່ຽນຈະເຮັດໃຫ້ອຸປະກອນອື່ນທັງໝົດທີ່ທ່ານເຂົ້າລະບົບຢູ່ອອກຈາກລະບົບ. ເຄື່ອງນີ້ຍັງຢູ່.',
  'account.password.problem.currentMissing': 'ກະລຸນາໃສ່ລະຫັດຜ່ານປັດຈຸບັນຂອງທ່ານ.',
  'account.password.problem.tooShort': 'ລະຫັດຜ່ານໃໝ່ສັ້ນເກີນໄປ — ຢ່າງໜ້ອຍ 12 ຕົວອັກສອນ.',
  'account.password.problem.sameAsCurrent': 'ລະຫັດຜ່ານໃໝ່ຕ້ອງຕ່າງຈາກອັນປັດຈຸບັນ.',
  'account.password.problem.mismatch': 'ລະຫັດຜ່ານໃໝ່ ແລະ ການຢືນຢັນບໍ່ກົງກັນ.',
  'product.gallery.label': 'ຮູບ ແລະ ວິດີໂອສິນຄ້າ',
  'product.gallery.show': (p, f) => `ເບິ່ງຮູບທີ ${f.integer(p.position)}`,
  'product.gallery.video.link': 'ເບິ່ງວິດີໂອ (ເປີດແທັບໃໝ່)',
  'product.gallery.video.title': 'ວິດີໂອສິນຄ້າ',
  'account.checking': 'ກຳລັງກວດ…',
  'account.needAccount': 'ເຂົ້າລະບົບເພື່ອຂໍໃບສະເໜີລາຄາ',
  'account.whyAccount':
    'ເພື່ອໃຫ້ໃບສະເໜີລາຄາເປັນຂອງບັນຊີທ່ານ ແລະ ເປີດໄດ້ທຸກອຸປະກອນ — ການລົງທະບຽນໃຊ້ພຽງເບີໂທ ແລະ ລະຫັດຜ່ານ.',
  'account.register': 'ສ້າງບັນຊີ',
  'account.signIn': 'ເຂົ້າລະບົບ',
  'account.haveAccount': 'ມີບັນຊີຢູ່ແລ້ວບໍ?',
  'account.noAccount': 'ຍັງບໍ່ມີບັນຊີບໍ?',
  'account.phone': 'ໂທລະສັບ',
  'account.username': 'ເບີໂທ ຫຼື ອີເມວ',
  'account.usernameHint':
    'ເບີທີ່ທ່ານໃຊ້ລົງທະບຽນ ຫຼື ອີເມວ ຖ້າທ່ານມີບັນຊີຢູ່ແລ້ວ.',
  'account.password': 'ລະຫັດຜ່ານ',
  'account.passwordHint': 'ຢ່າງໜ້ອຍ 12 ຕົວອັກສອນ.',
  'account.signedInAs': 'ເຂົ້າລະບົບແລ້ວ',
  'account.signOut': 'ອອກຈາກລະບົບ',
  'account.problem.badPhone': 'ອ່ານເບີໂທນີ້ບໍ່ໄດ້ — ຕົວຢ່າງ 081-234-5678.',
  'account.problem.passwordTooShort': 'ລະຫັດຜ່ານນີ້ສັ້ນເກີນໄປ — ຢ່າງໜ້ອຍ 12 ຕົວອັກສອນ.',
  'account.problem.unreachable': 'ເຊື່ອມຕໍ່ບໍ່ໄດ້. ກະລຸນາລອງໃໝ່.',
  'account.problem.unconfigured': 'ຍັງໃຊ້ບໍ່ໄດ້ຕອນນີ້. ກະລຸນາຕິດຕໍ່ທີມຂາຍ.',
  'account.myQuotations': 'ໃບສະເໜີລາຄາຂອງຂ້ອຍ',
  'account.myReviews': 'ຣີວິວຂອງຂ້ອຍ',
  'account.reviews.none': 'ຍັງບໍ່ມີສິນຄ້າທີ່ຣີວິວໄດ້ — ຂຽນຣີວິວໄດ້ຫຼັງຈາກຕິດຕັ້ງແລ້ວ',
  'account.reviews.written': 'ຣີວິວແລ້ວ',
  'account.noQuotations': 'ຍັງບໍ່ມີໃບສະເໜີລາຄາ',
  'account.tabs.label': 'ພາກສ່ວນຂອງບັນຊີ',

  'account.profile.section': 'ຂໍ້ມູນຜູ້ໃຊ້',
  'account.profile.name': 'ຊື່',
  'account.profile.nameUnset': 'ຍັງບໍ່ໄດ້ລະບຸຊື່',
  'account.profile.email': 'ອີເມວ',
  'account.profile.noEmail': 'ຍັງບໍ່ມີອີເມວທີ່ຢືນຢັນແລ້ວ',
  'account.profile.noPhone': 'ຍັງບໍ່ມີເບີໂທ',
  'account.profile.verified': 'ຢືນຢັນແລ້ວ',
  'account.profile.verifiedByStaff': 'ພະນັກງານຢືນຢັນແລ້ວ',
  'account.profile.unverified': 'ຍັງບໍ່ໄດ້ຢືນຢັນ',
  'account.profile.unverifiedNote':
    'ພະນັກງານຂອງພວກເຮົາຈະຢືນຢັນເບີໃຫ້ເມື່ອໄດ້ລົມກັນທາງໂທລະສັບ — ທ່ານບໍ່ຕ້ອງເຮັດຫຍັງເພີ່ມ.',
  'account.profile.readOnly':
    'ໜ້ານີ້ສະແດງພຽງຂໍ້ມູນທີ່ພວກເຮົາມີຢູ່. ຫາກຕ້ອງການແກ້ໄຂ ກະລຸນາຕິດຕໍ່ທີມຂາຍ.',
  'account.profile.languageElsewhere': 'ຕັ້ງຄ່າພາສາໄດ້ທີ່ໜ້າຕັ້ງຄ່າ.',

  'submit.heading': 'ຂໍໃບສະເໜີລາຄາ',
  'submit.intro':
    'ບອກຊື່ ແລະ ຊ່ອງທາງຕິດຕໍ່ໜຶ່ງຢ່າງ ພວກເຮົາຈະອອກໃບສະເໜີລາຄາທັນທີ — ລາຄາ ແລະ ລາຍລະອຽດຈະຖືກຕຶງໄວ້ຕາມທີ່ປາກົດໃນລາຍການນີ້ທຸກປະການ.',
  'submit.name': 'ຊື່ຜູ້ຕິດຕໍ່',
  'submit.namePlaceholder': 'ຊື່ ແລະ ນາມສະກຸນ',
  'submit.email': 'ອີເມວ',
  'submit.phone': 'ໂທລະສັບ',
  'submit.channelHint': 'ຢ່າງໜ້ອຍໜຶ່ງໃນສອງ — ໃສ່ພຽງເບີໂທກໍໄດ້.',
  'submit.destination': 'ປາຍທາງສິນຄ້າ',
  'submit.action': 'ຂໍໃບສະເໜີລາຄາ',
  'submit.sending': 'ກຳລັງອອກໃບສະເໜີລາຄາ…',
  'submit.problem.nameMissing': 'ກະລຸນາໃສ່ຊື່ຜູ້ຕິດຕໍ່.',
  'submit.problem.noChannel': 'ກະລຸນາໃສ່ອີເມວ ຫຼື ເບີໂທ.',
  'submit.problem.badPhone': 'ອ່ານເບີໂທນີ້ບໍ່ໄດ້ — ຕົວຢ່າງ 081-234-5678.',
  'submit.problem.badEmail': 'ອ່ານທີ່ຢູ່ອີເມວນີ້ບໍ່ໄດ້.',
  'submit.problem.badDestination': 'ກະລຸນາເລືອກປາຍທາງໃໝ່ — ຕົວເລືອກເກົ່າບໍ່ມີໃນລາຍການແລ້ວ.',
  'submit.problem.unreachable': 'ເຊື່ອມຕໍ່ບໍ່ໄດ້. ກະລຸນາລອງໃໝ່.',
  'submit.problem.unconfigured': 'ຮັບຄຳຂໍບໍ່ໄດ້ຕອນນີ້. ກະລຸນາຕິດຕໍ່ທີມຂາຍ.',
  'submit.problem.unavailable':
    'ມີບາງລາຍການໃນລາຍການຂອງທ່ານທີ່ບໍ່ມີໃຫ້ບໍລິການແລ້ວ. ກະລຸນາລຶບແຖວນັ້ນ ແລ້ວລອງໃໝ່.',
  'submit.done': 'ໃບສະເໜີລາຄາຂອງທ່ານພ້ອມແລ້ວ',
  'submit.viewQuotation': 'ເປີດໃບສະເໜີລາຄາ',

  'quotation.meta.title': 'ໃບສະເໜີລາຄາຂອງທ່ານ',
  'quotation.loading': 'ກຳລັງເປີດໃບສະເໜີລາຄາຂອງທ່ານ…',
  'quotation.heading': 'ໃບສະເໜີລາຄາ',
  'quotation.unavailable.title': 'ເປີດໃບສະເໜີລາຄານີ້ບໍ່ໄດ້',
  'quotation.unavailable.body':
    'ລິ້ງອາດໝົດອາຍຸ ຫຼື ສຳເນົາມາບໍ່ຄົບ. ກະລຸນາຂໍລິ້ງໃໝ່ຈາກທີມຂາຍ.',
  'quotation.unreachable.title': 'ເຊື່ອມຕໍ່ບໍ່ໄດ້ຕອນນີ້',
  'quotation.unreachable.body': 'ກະລຸນາລອງໃໝ່. ຖ້າຍັງບໍ່ໄດ້ ກະລຸນາຕິດຕໍ່ທີມຂາຍ.',
  'quotation.retry': 'ລອງໃໝ່',
  'quotation.print': 'ພິມ ຫຼື ບັນທຶກເປັນ PDF',
  'quotation.orderNo': 'ເລກທີ',
  'quotation.revision': 'ສະບັບແກ້ໄຂ',
  'quotation.submittedAt': 'ວັນທີຢືນຢັນ',
  'quotation.leadTime': 'ໄລຍະເວລາຜະລິດ (ວັນ)',
  'quotation.net': 'ກ່ອນ VAT',
  'quotation.vat': 'VAT',
  'quotation.vatIncluded': 'ລວມຢູ່ໃນລາຄາແລ້ວ',
  'quotation.total': 'ລວມທັງໝົດ',
  'quotation.fx.rate': ({ currency, rateText }) => `ອັດຕາແລກປ່ຽນ 1 ${currency} = ${rateText} THB`,
  'quotation.fx.observedAt': ({ observedAt }) => `ອັດຕາ ວັນທີ ${observedAt}`,
  'quotation.fx.manual': 'ອັດຕາທີ່ບໍລິສັດກຳນົດ',
  'quotation.fx.settlementNote': ({ currency }) => `ຕົວເລກ ${currency} ຂ້າງເທິງເປັນລາຄາອ້າງອີງ ການຊຳລະເງິນເປັນເງິນບາດຕາມຈຳນວນຂ້າງລຸ່ມ`,
  'quotation.fx.payable': 'ຈຳນວນທີ່ຕ້ອງຊຳລະ',
  'quotation.fx.deposit': 'ເງິນມັດຈຳທີ່ຕ້ອງຊຳລະກ່ອນ',
  'quotation.lineNo': 'ລຳດັບ',
  'quotation.item': 'ລາຍການ',
  'quotation.qty': 'ຈຳນວນ',
  'quotation.amount': 'ຈຳນວນເງິນ',
  'quotation.charges': 'ຄ່າໃຊ້ຈ່າຍອື່ນ',
  'quotation.pinnedNotice':
    'ເອກະສານນີ້ຖືກຕຶງໄວ້ຕັ້ງແຕ່ວັນທີຢືນຢັນ — ຕົວເລກ ແລະ ພາສາຈະບໍ່ປ່ຽນເມື່ອເປີດຄືນ.',
  'quotation.degraded': 'ພາສາທີ່ຕຶງໄວ້ບໍ່ມີໃນລຸ້ນນີ້ ຈຶ່ງສະແດງເປັນພາສາໄທ.',
  'quotation.contact': 'ຮຽນ',
  'quotation.seller.phone': 'ໂທລະສັບ',
  'quotation.seller.taxId': 'ເລກອາກອນ',

  'orderActions.heading': 'ຈັດການໃບສັ່ງຊື້ນີ້',
  'orderActions.object.title': 'ຂໍແກ້ໄຂ',
  'orderActions.object.body':
    'ຖ້າມີສິ່ງໃດບໍ່ຖືກຕ້ອງ ສາມາດຂໍແກ້ໄຂກ່ອນໄດ້. ໃບສັ່ງຊື້ຈະຍັງບໍ່ເຂົ້າສາຍການຜະລິດຈົນກວ່າພະນັກງານຈະຕອບກັບ ແລະ ບໍ່ມີການຫັກເງິນໃດໆ.',
  'orderActions.object.noteLabel': 'ສິ່ງທີ່ຕ້ອງການໃຫ້ແກ້',
  'orderActions.object.notePlaceholder': 'ຕົວຢ່າງ: ຂໍປ່ຽນເປັນສີດຳ ຫຼື ຂໍຫຼຸດຄວາມກວ້າງລົງ 10 ຊມ.',
  'orderActions.object.submit': 'ສົ່ງຄຳຂໍແກ້ໄຂ',
  'orderActions.object.sending': 'ກຳລັງສົ່ງ…',
  'orderActions.object.sent': 'ສົ່ງຄຳຂໍແກ້ໄຂແລ້ວ. ທີມຂາຍຈະຕິດຕໍ່ກັບຄືນ.',
  'orderActions.object.open': ({ openedAt }) => `ມີຄຳຂໍແກ້ໄຂທີ່ຍັງລໍຖ້າຄຳຕອບ ສົ່ງເມື່ອ ${openedAt}`,
  'orderActions.object.openBody':
    'ໃບສັ່ງຊື້ນີ້ຈະຍັງບໍ່ເຂົ້າສາຍການຜະລິດຈົນກວ່າຈະມີຄຳຕອບ. ຖ້າສົ່ງຜິດ ສາມາດຖອນຄຳຂໍໄດ້.',
  'orderActions.object.withdraw': 'ຖອນຄຳຂໍແກ້ໄຂ',
  'orderActions.object.withdrawing': 'ກຳລັງຖອນ…',
  'orderActions.object.withdrawn': 'ຖອນຄຳຂໍແກ້ໄຂແລ້ວ.',
  'orderActions.cancel.title': 'ຍົກເລີກໃບສັ່ງຊື້ນີ້',
  'orderActions.cancel.body': 'ຍົກເລີກແລ້ວຄືນບໍ່ໄດ້. ຖ້າຕ້ອງການສັ່ງໃໝ່ ຕ້ອງເລີ່ມໃບເສນີລາຄາໃໝ່.',
  'orderActions.cancel.start': 'ຂໍຍົກເລີກໃບສັ່ງຊື້',
  'orderActions.cancel.preFreezeNote': 'ໃບສັ່ງຊື້ນີ້ຍັງບໍ່ເຂົ້າສາຍການຜະລິດ. ຍັງບໍ່ມີການຂຶ້ນງານຕາມແບບຂອງທ່ານ.',
  'orderActions.cancel.postFreezeNote':
    '⚠️ ໃບສັ່ງຊື້ນີ້ເຂົ້າສາຍການຜະລິດແລ້ວ — ໂຮງງານເລີ່ມຜະລິດຕາມແບບຂອງທ່ານແລ້ວ. ການຍົກເລີກຕອນນີ້ຈະມີການຫັກເງິນຕາມນະໂຍບາຍທີ່ຕົກລົງກັນເມື່ອເຮັດສັນຍາ.',
  'orderActions.cancel.pricing': 'ກຳລັງຄິດຈຳນວນເງິນ…',
  'orderActions.cancel.held': ({ heldMinor }, f) => `ເງິນທີ່ບໍລິສັດຖືໄວ້ ${f.bahtExact(heldMinor)}`,
  'orderActions.cancel.forfeit': ({ forfeitMinor }, f) => `ຈະຖືກຫັກໄວ້ ${f.bahtExact(forfeitMinor)}`,
  'orderActions.cancel.refund': ({ refundMinor }, f) => `ຈະໄດ້ຄືນ ${f.bahtExact(refundMinor)}`,
  'orderActions.cancel.freeCancellation': 'ຍົກເລີກໄດ້ໂດຍບໍ່ມີການຫັກເງິນ ຄືນເຕັມຈຳນວນ.',
  'orderActions.cancel.noMoney': 'ຍັງບໍ່ມີການຊຳລະເງິນເຂົ້າມາ ຈຶ່ງບໍ່ມີເງິນທີ່ຕ້ອງຄືນ ຫຼື ຖືກຫັກ.',
  'orderActions.cancel.reasonLabel': 'ເຫດຜົນທີ່ຍົກເລີກ',
  'orderActions.cancel.reasonPlaceholder': 'ຕົວຢ່າງ: ປ່ຽນໃຈ ຫຼື ເລື່ອນໂຄງການອອກໄປ.',
  'orderActions.cancel.confirm': 'ຢືນຢັນການຍົກເລີກ',
  'orderActions.cancel.cancelling': 'ກຳລັງຍົກເລີກ…',
  'orderActions.cancel.keep': 'ບໍ່ຍົກເລີກ',
  'orderActions.cancel.done': 'ຍົກເລີກໃບສັ່ງຊື້ນີ້ແລ້ວ.',
  'orderActions.problem.unconfigured': 'ລະບົບຕັ້ງຄ່າຍັງບໍ່ຄົບ. ຕິດຕໍ່ທີມຂາຍໄດ້ເລີຍ.',
  'orderActions.problem.unreachable': 'ຕິດຕໍ່ລະບົບບໍ່ໄດ້. ລອງອີກຄັ້ງ.',
  'orderActions.problem.unauthorized': 'ເຊສຊັນໝົດອາຍຸ. ກະລຸນາເຂົ້າສູ່ລະບົບອີກຄັ້ງ.',
  'orderActions.problem.refused': 'ເຮັດລາຍການນີ້ບໍ່ໄດ້.',
  'orderActions.problem.malformed': 'ອ່ານຄຳຕອບຈາກລະບົບບໍ່ໄດ້. ລອງອີກຄັ້ງ.',

  /* ---- Display settings ---------------------------------------------------- */
  'settings.nav': 'ການສະແດງຜົນ',
  'settings.heading': 'ຕັ້ງຄ່າການສະແດງຜົນ',
  'settings.intro':
    'ເລືອກວ່າເວັບໄຊນີ້ຈະສະແດງໃຫ້ທ່ານແນວໃດ: ພາສາ ແລະ ຫົວໜ່ວຍວັດ. ທັງສອງຢ່າງເປັນພຽງການສະແດງຜົນ — ຂະໜາດທີ່ທ່ານປ້ອນ ແລະ ລາຄາທີ່ພວກເຮົາຄິດໄລ່ຈະບໍ່ປ່ຽນຕາມ. ສະກຸນເງິນເລືອກໃນໜ້ານີ້ບໍ່ໄດ້ ເຫດຜົນຢູ່ດ້ານລຸ່ມ.',
  'settings.meta.title': 'ຕັ້ງຄ່າການສະແດງຜົນ',

  'settings.language.legend': 'ພາສາທີ່ໃຊ້ຂຽນເວັບໄຊນີ້',
  'settings.language.accountDiffers': (p) => `ບັນຊີຂອງທ່ານຕັ້ງເປັນ ${p.language}.`,
  'settings.language.applyAccount': 'ໃຊ້ພາສາຂອງບັນຊີໃນອຸປະກອນນີ້',
  'settings.unit.legend': 'ຂະໜາດສະແດງເປັນ',
  'settings.currency.legend': 'ສະກຸນເງິນທີ່ສະແດງລາຄາ',
  'settings.currency.fixed': (p) => `ເປັນ ${p.currency} ສະເໝີ ໃນທຸກພາສາ`,
  'settings.currency.why':
    'ທຸກລາຄາຄິດໄລ່ ແລະ ເກັບເປັນເງິນບາດໄທ ແລະ ໜ້າສິນຄ້າຖືກສ້າງເທື່ອດຽວແລ້ວໃຊ້ຮ່ວມກັນທຸກຄົນ ຈຶ່ງບໍ່ສາມາດໃຊ້ສະກຸນເງິນສະເພາະບຸກຄົນໄດ້. ໃບສະເໜີລາຄາເປັນອີກເລື່ອງໜຶ່ງ: ຖ້າປະເທດປາຍທາງຖືກຕັ້ງໃຫ້ສະເໜີລາຄາເປັນສະກຸນເງິນອື່ນ ໃບສະເໜີລາຄາຈະອອກເປັນສະກຸນເງິນນັ້ນຕາມອັດຕາແລກປ່ຽນທີ່ຕຶງໄວ້ໃນເອກະສານ ແລະ ຊຳລະເປັນເງິນບາດ.',

  'settings.storage.local': 'ເກັບໄວ້ໃນເບຣົາເຊີນີ້ເທົ່ານັ້ນ',
  'settings.storage.account': (p, f) => `ບັນທຶກເຂົ້າບັນຊີຂອງທ່ານເມື່ອ ${f.date(p.at)}`,
  'settings.storage.signIn': 'ເຂົ້າລະບົບເພື່ອນຳການຕັ້ງຄ່າເຫຼົ່ານີ້ໄປໃຊ້ໃນອຸປະກອນອື່ນ.',
  'settings.storage.saving': 'ກຳລັງບັນທຶກ',
  'settings.storage.failed':
    'ບັນທຶກເຂົ້າບັນຊີບໍ່ໄດ້. ການເລືອກຍັງມີຜົນໃນເບຣົາເຊີນີ້.',
  'settings.storage.forget': 'ລຶບການຕັ້ງຄ່າທີ່ບັນທຶກໄວ້ໃນບັນຊີຂອງຂ້ອຍ',

  'settings.messages.heading': 'ພາສາທີ່ພວກເຮົາໃຊ້ຂຽນຫາທ່ານ',
  'settings.messages.degraded': (p) =>
    `${p.chosen} ຍັງບໍ່ໄດ້ແປ ຂໍ້ຄວາມຈາກພວກເຮົາຈຶ່ງຈະມາເປັນ ${p.rendered}.`,
  'settings.messages.coverage': (p, f) =>
    `ແປແລ້ວ ${f.plain(p.translated)} ຈາກ ${f.plain(p.total)} ຂໍ້ຄວາມ`,

  'settings.effects.heading': 'ການຕັ້ງຄ່າເຫຼົ່ານີ້ປ່ຽນຫຍັງແດ່',
  'settings.effects.intro':
    'ລາຍການນີ້ມາຈາກເຊີບເວີ ບໍ່ແມ່ນຈາກໜ້ານີ້ ແລະ ມັນລະບຸແມ້ແຕ່ການຕັ້ງຄ່າທີ່ຍັງບໍ່ມີຜົນ ແທນທີ່ຈະປ່ອຍໃຫ້ທ່ານໄປຄົ້ນເອງ.',
  'settings.effect.locale.notification': 'ພາສາຂອງອີເມວທີ່ພວກເຮົາສົ່ງຫາທ່ານ',
  'settings.effect.locale.document': 'ພາສາຂອງໃບສະເໜີລາຄາ ແລະ ໃບເກັບເງິນທີ່ອອກໄປແລ້ວ',
  'settings.effect.locale.storefront': 'ພາສາຂອງເວັບໄຊນີ້',
  'settings.effect.locale.dashboard': 'ພາສາຂອງລະບົບຫຼັງບ້ານ',
  'settings.effect.currency.notification': 'ສະກຸນເງິນໃນອີເມວທີ່ພວກເຮົາສົ່ງຫາທ່ານ',
  'settings.effect.currency.document': 'ສະກຸນເງິນໃນເອກະສານທີ່ອອກໄປແລ້ວ',
  'settings.effect.currency.storefront': 'ສະກຸນເງິນຂອງລາຄາໃນເວັບໄຊນີ້',
  'settings.effect.currency.dashboard': 'ສະກຸນເງິນໃນລະບົບຫຼັງບ້ານ',
  'settings.effect.lengthUnit.notification': 'ຫົວໜ່ວຍໃນອີເມວທີ່ພວກເຮົາສົ່ງຫາທ່ານ',
  'settings.effect.lengthUnit.document': 'ຫົວໜ່ວຍໃນເອກະສານທີ່ອອກໄປແລ້ວ',
  'settings.effect.lengthUnit.storefront': 'ຫົວໜ່ວຍທີ່ໃຊ້ສະແດງຂະໜາດໃນເວັບໄຊນີ້',
  'settings.effect.lengthUnit.dashboard': 'ຫົວໜ່ວຍໃນລະບົບຫຼັງບ້ານ',
  'settings.effect.yes': 'ມີຜົນ',
  'settings.effect.no': 'ຍັງບໍ່ມີຜົນ',

  /* ---- Not found ----------------------------------------------------------- */
  'notFound.title': 'ບໍ່ພົບໜ້ານີ້',
  'notFound.body': 'ລິ້ງອາດປ່ຽນໄປແລ້ວ. ລອງເລີ່ມຈາກລາຍການສິນຄ້າ.',

  /* ---- Paying, and attaching a slip ---------------------------------- */
  'payment.action': 'ຊຳລະເງິນ',
  'payment.meta.title': 'ແຈ້ງການຊຳລະເງິນ',
  'payment.heading': 'ແຈ້ງການຊຳລະເງິນ',
  'payment.loading': 'ກຳລັງເປີດຂໍ້ມູນການຊຳລະເງິນ…',
  'payment.outstanding': 'ຍອດຄ້າງຈ່າຍທັງໝົດ',
  'payment.dueNow': 'ຍອດທີ່ຕ້ອງຈ່າຍຕອນນີ້',
  'payment.outstandingAmount': (p, f) => f.bahtExact(p.owedMinor),
  'payment.settled': 'ອໍເດີນີ້ຊຳລະຄົບແລ້ວ',
  'payment.writtenOff': 'ຍອດຄົງເຫຼືອຂອງອໍເດີນີ້ໄດ້ຮັບການອະນຸມັດໃຫ້ຕັດບັນຊີແລ້ວ — ບໍ່ມີສິ່ງທີ່ຕ້ອງຊຳລະເພີ່ມ',
  'payment.closed':
    'ອໍເດີນີ້ປິດຮັບການແຈ້ງຊຳລະເງິນແລ້ວ. ຫາກມີຂໍ້ສົງໄສກ່ຽວກັບຍອດເງິນ ກະລຸນາຕິດຕໍ່ທີມຂາຍ.',
  'payment.account.legend': 'ໂອນເຂົ້າບັນຊີໃດບັນຊີໜຶ່ງ',
  'payment.account.copy': (p) => `ສຳເນົາເລກບັນຊີ ${p.accountDigits}`,
  'payment.account.copied': 'ສຳເນົາເລກບັນຊີແລ້ວ',
  'payment.account.qrAlt': 'QR ໂຄດ PromptPay ສຳລັບຍອດທີ່ປ້ອນໄວ້',
  'payment.account.qrHint': 'ສະແກນດ້ວຍແອັບທະນາຄານ — ຍອດຈະຖືກປ້ອນໃຫ້ອັດຕະໂນມັດ',
  'payment.account.none':
    'ຍັງບໍ່ໄດ້ຕັ້ງຄ່າບັນຊີຮັບເງິນ. ກະລຸນາຕິດຕໍ່ທີມຂາຍເພື່ອຂໍຂໍ້ມູນການຊຳລະເງິນ.',
  'payment.form.legend': 'ແນບສະລິບ',
  'payment.form.image': 'ຮູບສະລິບ',
  'payment.form.imageChoose': 'ເລືອກຮູບສະລິບ',
  'payment.form.imageChange': 'ປ່ຽນຮູບ',
  'payment.form.imageHint': 'ຖ່າຍຈາກແອັບທະນາຄານກໍ່ໄດ້. ຂະໜາດຮູບບໍ່ເກີນ 8 MB.',
  'payment.form.amount': 'ຈຳນວນເງິນທີ່ໂອນ',
  'payment.form.transferredAt': 'ວັນ ແລະ ເວລາທີ່ໂອນ',
  'payment.form.reference': 'ເລກອ້າງອີງ (ຖ້າມີ)',
  'payment.form.submit': 'ສົ່ງສະລິບ',
  'payment.phase.uploading': 'ກຳລັງອັບໂຫລດຮູບ…',
  'payment.phase.creating': 'ກຳລັງບັນທຶກສະລິບ…',
  'payment.done': 'ໄດ້ຮັບສະລິບແລ້ວ. ທີມງານຈະກວດສອບ ແລະ ແຈ້ງກັບຄືນ.',
  'payment.history.heading': 'ສະລິບທີ່ສົ່ງໄປແລ້ວ',
  'payment.history.empty': 'ຍັງບໍ່ໄດ້ສົ່ງສະລິບ',
  'payment.history.submitted': (p, f) => `${f.bahtExact(p.slipMinor)} · ສົ່ງເມື່ອ ${f.date(p.sentAt)} · ລໍຖ້າກວດສອບ`,
  'payment.history.accepted': (p, f) => `${f.bahtExact(p.slipMinor)} · ສົ່ງເມື່ອ ${f.date(p.sentAt)} · ຮັບແລ້ວ`,
  'payment.history.rejected': (p, f) => `${f.bahtExact(p.slipMinor)} · ບໍ່ຜ່ານ — ${p.reason}`,
  'payment.problem.noImage': 'ກະລຸນາແນບຮູບສະລິບ.',
  'payment.problem.imageTooBig': (p, f) =>
    `ຮູບໃຫຍ່ເກີນໄປ — ບໍ່ເກີນ ${f.plain(p.limitMib)} MB.`,
  'payment.problem.badAmount': 'ປ້ອນຈຳນວນເງິນເປັນຕົວເລກ ທົດສະນິຍົມບໍ່ເກີນສອງຕຳແໜ່ງ.',
  'payment.problem.badTime': 'ກະລຸນາເລືອກວັນ ແລະ ເວລາທີ່ໂອນ.',
  'payment.problem.signInAgain':
    'ເຊດຊັນຂອງທ່ານໝົດອາຍຸແລ້ວ. ກະລຸນາເຂົ້າລະບົບອີກເທື່ອ. ຂໍ້ມູນທີ່ປ້ອນໄວ້ຍັງຢູ່.',
  'payment.problem.unreachable': 'ເຊື່ອມຕໍ່ບໍ່ໄດ້. ກະລຸນາລອງໃໝ່.',
};
