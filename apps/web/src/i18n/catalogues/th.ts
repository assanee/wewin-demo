import type { UiCatalogue } from '../keys';

/**
 * Thai — the source language, and the only catalogue required to be complete.
 *
 * Every string here was lifted from the component it used to live in, character for
 * character. That is deliberate and it is checkable: `catalogue.test.ts` pins the
 * sentences that used to be built by string concatenation, so a key scheme that lost a
 * word on the way through would be caught rather than admired.
 *
 * The type is `UiCatalogue`, not `PartialUiCatalogue`. A missing key here is a compile
 * error, because a missing key here is a string with no fallback anywhere — the one
 * failure the whole fallback chain cannot absorb.
 */
export const th: UiCatalogue = {
  /* ---- Shell and navigation ---------------------------------------- */
  'a11y.skipToContent': 'ข้ามไปเนื้อหาหลัก',
  'nav.mainLabel': 'เมนูหลัก',
  'nav.homeLabel': (p) => `${p.wordmark} หน้าหลัก`,
  'nav.products': 'สินค้า',
  'nav.about': 'เกี่ยวกับเรา',
  'nav.quote': 'ตะกร้า',
  'nav.allProducts': 'ดูสินค้าทั้งหมด',
  'nav.backToProducts': 'กลับไปดูสินค้าทั้งหมด',
  'nav.addMore': 'เพิ่มสินค้าอีก',
  'quote.badge.filled': (p, f) => `มี ${f.integer(p.count)} รายการในตะกร้า`,
  'quote.badge.empty': 'ตะกร้าว่าง',

  /* ---- Money and measurement ---------------------------------------- */
  'price.vatExcluded': 'ราคายังไม่รวม VAT 7%',
  'price.vatExcludedShort': 'ยังไม่รวม VAT',
  'price.perSqmSuffix': '/ ตร.ม.',
  'price.from': 'เริ่มต้น',
  'price.fromShort': 'เริ่ม',
  'price.unit': 'ราคาต่อชิ้น',
  'price.total': 'ราคารวม',
  'price.grandTotal': 'ยอดรวม',
  'price.perPiece': (p, f) => `${f.baht(p.minor)} / ชิ้น`,
  'value.unknown': '—',
  'unit.sqmSuffix': 'ตร.ม.',
  'count.pieces': (p, f) => `${f.integer(p.count)} ชิ้น`,
  'count.items': (p, f) => `${f.integer(p.count)} รายการ`,
  'count.designs': (p, f) => `${f.integer(p.count)} แบบ`,
  'leadTime.range': (p, f) => `${f.integer(p.days[0])}–${f.integer(p.days[1])} วัน`,
  'leadTime.produce': (p, f) => `ผลิต ${f.integer(p.days[0])}–${f.integer(p.days[1])} วัน`,

  /* ---- Pickers ------------------------------------------------------ */
  'unit.pickerLabel': 'หน่วย',
  'unit.groupLabel': 'หน่วยที่ใช้แสดงขนาด',
  'unit.name.mm': 'มิลลิเมตร',
  'unit.name.cm': 'เซนติเมตร',
  'unit.name.m': 'เมตร',
  'unit.name.in': 'นิ้ว',
  'unit.name.ft': 'ฟุต',
  'locale.pickerLabel': 'ภาษา',
  'locale.groupLabel': 'ภาษาที่ใช้แสดงหน้าเว็บ',
  'locale.partial': 'ข้อความบางส่วนยังไม่มีคำแปล จึงแสดงเป็นภาษาไทย',

  /* ---- Home --------------------------------------------------------- */
  'home.hero.line1': 'สั่งทำตามขนาดจริง',
  'home.hero.line2': 'เห็นราคาก่อนคุยกับเรา',
  'home.hero.body':
    'หน้าต่าง ระแนง และประตูอะลูมิเนียม กรอกความกว้างกับความสูงของช่องเปิดจริง แล้วดูราคาเต็มจำนวนทันที ไม่ต้องล็อกอิน ไม่ต้องทิ้งเบอร์ก่อน',
  'home.hero.cta': 'ดูสินค้าและคำนวณราคา',
  'home.fact.designs': 'แบบให้เลือก',
  'home.fact.startingPrice': 'ราคาเริ่มต้น',
  'home.fact.leadTime': 'ระยะเวลาผลิต',
  'home.how.heading': 'ขั้นตอนทำงาน',
  'home.how.body':
    'การดูราคาเองก่อนติดต่อยังไม่ใช่เรื่องปกติในงานสั่งทำ นี่คือสิ่งที่จะเกิดขึ้นหลังจากนี้',
  'home.step.measure.title': 'วัดช่องเปิดแล้วกรอกขนาด',
  'home.step.measure.body': 'เลือกแบบที่ต้องการ แล้วกรอกความกว้าง × ความสูงของช่องเปิดจริง',
  'home.step.price.title': 'เห็นราคาทันที',
  'home.step.price.body': 'ราคาเต็มขึ้นบนหน้าจอทันที พร้อมรายการที่ประกอบกันเป็นราคานั้นทุกบรรทัด',
  'home.step.request.title': 'ส่งขอใบเสนอราคา',
  'home.step.request.body': 'รวมรายการที่สนใจแล้วส่งมาขอใบเสนอราคา ยังไม่ผูกมัดในขั้นนี้',
  'home.step.survey.title': 'วัดหน้างานก่อนผลิต',
  'home.step.survey.body': (p, f) =>
    `ทีมงานเข้าวัดหน้างานจริงเพื่อยืนยันขนาดและราคาก่อนเริ่มผลิต${
      p.days === null
        ? ''
        : ` ใช้เวลาผลิต ${f.integer(p.days[0])}–${f.integer(p.days[1])} วัน แล้วแต่แบบ`
    }`,
  'home.estimate.note':
    'ราคาบนเว็บคือราคาประเมินจากตัวเลขที่คุณกรอก ราคาสุดท้ายยืนยันหลังทีมงานเข้าวัดหน้างานจริง',
  'home.estimate.emphasis': 'ราคาประเมินจากตัวเลขที่คุณกรอก',
  'home.categories.heading': 'เลือกตามประเภทงาน',
  'home.category.empty': 'ยังไม่มีสินค้าในหมวดนี้',
  'home.pricing.heading': 'ราคาคิดยังไง',
  'home.pricing.body':
    'ทั้งสามข้อนี้อยู่ตรงนี้เพราะเราอยากให้รู้ก่อนกรอกขนาด ไม่ใช่รู้ตอนเห็นตัวเลขสุดท้าย',
  'home.pricing.formula.title': 'สูตรคิดราคา',
  'home.pricing.formula.body': 'ราคา = ราคาต่อตารางเมตร × พื้นที่ที่คิดเงิน + ค่าออปชัน',
  'home.pricing.formula.note':
    'ค่าออปชันคือสีโปรไฟล์ สีและความหนากระจก และอุปกรณ์ที่เลือกเพิ่ม ทุกบรรทัดแสดงแยกให้เห็นในหน้าคำนวณราคา',
  'home.pricing.floor.title': 'พื้นที่คิดเงินขั้นต่ำ',
  'home.pricing.floor.body': 'บานที่เล็กกว่าขั้นต่ำจะถูกคิดที่พื้นที่ขั้นต่ำ',
  'home.pricing.floor.range': (p, f) =>
    p.span === null ? '—' : `${f.area(p.span[0])}–${f.area(p.span[1])} ตร.ม.`,
  'home.pricing.floor.note': 'แล้วแต่แบบ หน้าคำนวณราคาจะบอกทุกครั้งว่าแบบที่เลือกใช้ขั้นต่ำเท่าไร',
  'home.pricing.excluded.title': 'ราคานี้ยังไม่รวม',
  'home.pricing.excluded.vat': 'VAT 7%',
  'home.pricing.excluded.install': 'ค่าติดตั้ง',
  'home.pricing.excluded.delivery': 'ค่าขนส่ง',
  'home.pricing.excluded.removal': 'ค่ารื้อของเดิม',
  'home.pricing.excluded.note':
    'ทั้งสี่รายการขึ้นกับหน้างาน จึงประเมินจากขนาดอย่างเดียวไม่ได้ และจะอยู่ในใบเสนอราคาหลังเข้าวัด',

  'meta.title': 'WEWIN180 — สั่งทำตามขนาดจริง เห็นราคาก่อนคุยกับเรา',
  'meta.description':
    'WEWIN180 — หน้าต่าง ระแนง ประตู สั่งทำตามขนาดจริง คำนวณราคาเองได้ก่อนขอใบเสนอราคา',

  /* ---- Catalogue ---------------------------------------------------- */
  'catalog.heading': 'สินค้าทั้งหมด',
  'catalog.resultCount': (p, f) => `${f.integer(p.count)} รายการ`,
  'catalog.empty.title': 'ยังไม่มีสินค้าที่ตรงเงื่อนไขนี้',
  'catalog.empty.body': 'ลองเอาตัวกรองบางอย่างออก แล้วดูรายการทั้งหมดอีกครั้ง',
  'filter.title': 'ตัวกรอง',
  'filter.clear': 'ล้างตัวกรอง',
  'filter.showResults': (p, f) => `ดูผลลัพธ์ (${f.integer(p.count)} รายการ)`,
  'filter.section.category': 'หมวดหมู่',
  'filter.section.profileColor': 'สีโปรไฟล์',
  'filter.section.pricePerSqm': 'ราคาต่อ ตร.ม.',
  'filter.priceTo': 'ถึง',
  'filter.priceMax': 'ไม่เกิน',
  'product.colorCount': (p, f) => `${f.integer(p.count)} สีโปรไฟล์`,
  'product.sizeRange': (p, f) => `ปรับขนาดได้ ${f.range(p.minUm, p.maxUm, p.unit)}`,

  /* ---- Configurator -------------------------------------------------- */
  'configure.loadingLine': 'กำลังโหลดรายการ…',
  'configure.spec.note':
    'สเปกละเอียด มาตรฐาน และเงื่อนไขรับประกัน สอบถามทีมงานได้ที่ช่องทางติดต่อด้านล่าง',
  'configure.view.front': 'ด้านหน้า',
  'configure.view.halfPanel': 'ครึ่งบาน',
  'configure.view.transom': 'ช่องแสงบน',
  'configure.size.heading': 'ขนาด',
  'configure.area.line': (p, f) =>
    `พื้นที่ ${f.area(p.areaSqUm)} ตร.ม. · คิดขั้นต่ำ ${f.area(p.minBillableSqUm)} ตร.ม.`,
  'configure.group.affectsSku': 'มีผลกับรหัสสินค้า',
  'configure.futureQuote': 'ขั้นตอนขอใบเสนอราคาจะเพิ่มในเวอร์ชันถัดไป',
  'configure.breakdown.title': 'รายละเอียดราคา',
  'configure.qty': 'จำนวน',
  'configure.qty.decrease': 'ลดจำนวน 1 ชิ้น',
  'configure.qty.increase': 'เพิ่มจำนวน 1 ชิ้น',
  // `f.entry`, not `f.measure`: every number in these three is a number the customer is
  // being asked to type into the field beside them, and that field is ASCII in all eight
  // locales because `parseMeasure` reads it straight back. The German page used to say
  // `ทีละ 0,5` above a field that silently discards `320,5` and resets the window to its
  // default — an instruction the field it labels cannot obey.
  'measure.decrease': (p, f) => `ลด${p.group} ${f.entry(p.stepUm, p.unit)}`,
  'measure.increase': (p, f) => `เพิ่ม${p.group} ${f.entry(p.stepUm, p.unit)}`,
  'measure.helper': (p, f) =>
    `${f.entryRange(p.minUm, p.maxUm, p.unit)} · ทีละ ${f.entry(p.gridUm, p.unit)}`,

  /* ---- Drawings ------------------------------------------------------- */
  'drawing.schematic': 'ภาพร่างสัดส่วน',
  'drawing.schematic.sized': (p) => `ภาพร่างสัดส่วน ${p.size}`,
  'drawing.elevation': (p) =>
    `ภาพแบบ ${p.width} × ${p.height} ${p.unit}${p.invalid ? ' ขนาดยังอยู่นอกช่วงที่ผลิตได้' : ''}`,
  'drawing.unitNote': (p) => `หน่วย: ${p.unit}`,

  /* ---- Toolbar, share, QR -------------------------------------------- */
  'toolbar.groupLabel': 'จัดการการตั้งค่า',
  'toolbar.undo': 'ย้อนกลับ',
  'toolbar.redo': 'ทำซ้ำ',
  'toolbar.reset': 'กลับค่าเริ่มต้น',
  'toolbar.share': 'แชร์ลิงก์การตั้งค่านี้',
  'toolbar.qr': 'สร้าง QR ของลิงก์นี้',
  'share.sheet.title': 'แชร์ลิงก์',
  'share.qr.title': 'QR ของลิงก์นี้',
  'share.body':
    'ลิงก์นี้เปิดหน้าตั้งค่าพร้อมขนาดและตัวเลือกชุดเดียวกับที่เห็นอยู่ ส่งให้ช่างหรือคนที่บ้านดูต่อได้เลย',
  'share.copyLink': 'คัดลอกลิงก์',
  'share.copied': 'คัดลอกลิงก์แล้ว',
  'share.showQr': 'แสดงเป็น QR',
  'qr.alt': 'คิวอาร์โค้ดของลิงก์การตั้งค่านี้',
  'qr.failed': 'สร้าง QR ไม่สำเร็จ ใช้ปุ่มคัดลอกลิงก์แทนได้',

  /* ---- Price summary and breakdown ------------------------------------ */
  'summary.label': 'สรุปราคา',
  'summary.skuCode': 'รหัสสินค้า',
  'summary.copySku': (p) => `คัดลอกรหัสสินค้า ${p.skuCode}`,
  'summary.skuCopied': 'คัดลอกรหัสสินค้าแล้ว',
  'summary.add': 'เพิ่มลงรายการ',
  'summary.hasErrors': 'ยังมีข้อที่ต้องแก้ด้านบน กดปุ่มเพื่อดูว่าเหลืออะไรบ้าง',
  'summary.showBreakdown': 'ดูรายละเอียดราคา',
  'summary.areaAndVat': (p, f) => `${f.area(p.areaSqUm)} ตร.ม. · ราคายังไม่รวม VAT 7%`,
  'summary.stickyMeta': (p, f) =>
    `${f.area(p.areaSqUm)} ตร.ม.${p.qty > 1 ? ` · ${f.integer(p.qty)} ชิ้น` : ''} · ดูรายละเอียด`,
  'breakdown.minimumApplied': (p, f) =>
    `พื้นที่จริง ${f.area(p.areaSqUm)} ตร.ม. · คิดขั้นต่ำ ${f.area(p.minBillableSqUm)} ตร.ม.`,

  /* ---- Quote ---------------------------------------------------------- */
  'quote.heading': 'ตะกร้า',
  'quote.empty.title': 'ยังไม่มีรายการในตะกร้า',
  'quote.empty.body': 'เลือกสินค้า กรอกขนาดช่องเปิดจริง แล้วเพิ่มเข้ามาที่นี่ได้เลย',
  'quote.empty.cta': 'เลือกสินค้า',
  'quote.summary.label': 'สรุปยอด',
  'quote.summary.lineCount': 'จำนวนรายการ',
  'quote.summary.lineCountValue': (p, f) =>
    `${f.integer(p.lines)} รายการ · ${f.integer(p.pieces)} ชิ้น`,
  'quote.summary.leadTime': 'ระยะเวลาผลิต',
  'quote.tableCaption': 'รายการในตะกร้า',
  'quote.col.name': 'ชื่อรายการ',
  'quote.col.sku': 'รหัสสินค้า',
  'quote.col.size': 'ขนาด',
  'quote.col.qty': 'จำนวน',
  'quote.col.unitPrice': 'ราคาต่อชิ้น',
  'quote.col.total': 'ราคารวม',
  'quote.col.actions': 'การจัดการ',
  'quote.action.edit': (p) => `แก้ไขการตั้งค่า ${p.nickname}`,
  'quote.action.duplicate': (p) => `ทำซ้ำรายการ ${p.nickname}`,
  'quote.action.remove': (p) => `ลบรายการ ${p.nickname}`,
  'quote.qty.label': (p) => `จำนวน ${p.nickname}`,
  'quote.qty.decrease': (p) => `ลดจำนวน ${p.nickname} 1 ชิ้น`,
  'quote.qty.increase': (p) => `เพิ่มจำนวน ${p.nickname} 1 ชิ้น`,

  /* ---- Toasts and sheets ----------------------------------------------- */
  'toast.lineSaved': 'บันทึกการแก้ไขแล้ว',
  'toast.lineAdded': 'เพิ่มลงรายการแล้ว',
  'toast.viewQuote': 'ดูตะกร้า',
  'toast.dismiss': 'ปิดข้อความ',
  'sheet.close': 'ปิด',
  'sheet.closeNamed': (p) => `ปิด${p.title}`,

  /* ---- About ------------------------------------------------------------ */
  'about.heading': 'เกี่ยวกับเรา',
  // No Thai company copy is spliced into this sentence any more. `makes` and
  // `serviceArea` were Thai *clauses* dropped into a grammatical frame the catalogue
  // owns — which Thai tolerates, German declines and Hindi postpositions outright, and
  // which no `lang` attribute can mark because they sit mid-string. They are rendered
  // beside this paragraph as their own marked elements instead.
  'about.intro':
    'เราผลิตงานอะลูมิเนียมสั่งทำตามขนาดหน้างานจริง โรงงานอยู่ที่จังหวัดพิษณุโลก',
  'about.tool':
    'เว็บนี้คือเครื่องมือคำนวณราคาของเราเอง กรอกความกว้างกับความสูงของช่องเปิด แล้วเห็นราคาเต็มจำนวนได้ทันทีโดยไม่ต้องติดต่อใครก่อน',
  'about.stance.heading': 'ทำไมเราเปิดราคาให้เห็น',
  'about.stance.noPhone.title': 'ถามราคาไม่ควรต้องแลกกับเบอร์โทร',
  'about.stance.noPhone.body':
    'งานสั่งทำส่วนใหญ่ต้องทิ้งเบอร์ไว้ก่อนถึงจะได้ตัวเลข แปลว่าคนที่แค่อยากรู้งบคร่าวๆ ต้องยอมรับสายที่ตามมา เราตัดขั้นตอนนั้นออก',
  'about.stance.itemised.title': 'ราคาต้องแยกให้เห็นว่ามาจากอะไร',
  'about.stance.itemised.body':
    'หน้าคำนวณราคาแสดงทุกบรรทัดที่ประกอบกันเป็นยอด ทั้งค่าพื้นที่ ค่าสี ค่ากระจก และค่าอุปกรณ์ ถ้าตัวเลขเปลี่ยน จะเห็นว่าเปลี่ยนเพราะอะไร',
  'about.stance.limits.title': 'ข้อจำกัดบอกก่อน ไม่ใช่บอกทีหลัง',
  'about.stance.limits.body':
    'พื้นที่คิดเงินขั้นต่ำ ขนาดที่ผลิตไม่ได้ และสิ่งที่ราคายังไม่รวม อยู่บนหน้าเว็บตั้งแต่ก่อนกรอกขนาด ไม่ใช่ไปโผล่ตอนคุยกัน',
  'about.range.heading': 'สิ่งที่เราผลิต',
  'about.range.body':
    'ตัวเลขทั้งหมดนี้อ่านจากแคตตาล็อกจริงที่ใช้คำนวณราคา ไม่ได้เขียนแยกไว้ต่างหาก',
  'about.fact.designs.note': (p, f) => `ใน ${f.integer(p.categories)} หมวด`,
  'about.fact.startingPrice.note': 'ยังไม่รวม VAT 7%',
  'about.fact.leadTime.note': 'แล้วแต่แบบ',
  'about.fact.floor': 'พื้นที่คิดเงินขั้นต่ำ',
  'about.fact.floor.note': 'บานเล็กกว่านี้คิดที่ขั้นต่ำ',
  'about.fact.legalName': 'ชื่อจดทะเบียน',
  'about.fact.makes': 'สิ่งที่เราผลิต',
  'about.fact.serviceArea': 'พื้นที่ให้บริการ',
  'about.contact.heading': 'ที่ตั้งและการติดต่อ',
  'about.card.factory': 'โรงงานและสำนักงาน',
  'about.card.delivery': 'การจัดส่งและติดตั้ง',
  'about.card.delivery.note':
    'ค่าติดตั้งและค่าขนส่งไม่รวมอยู่ในราคาบนเว็บ เพราะขึ้นกับหน้างานและระยะทาง ทีมงานจะประเมินให้ในใบเสนอราคา',
  'about.card.hours': 'เวลาทำการ',
  'about.card.hours.note':
    'นอกเวลาทำการ ทิ้งข้อความไว้ทาง LINE หรืออีเมลได้ ทีมงานจะตอบกลับในวันทำการถัดไป',

  /* ---- Footer ------------------------------------------------------------ */
  'footer.contact': 'ติดต่อเรา',
  'footer.hours': 'เวลาทำการ',
  'footer.serviceArea': 'พื้นที่ให้บริการ',
  'footer.menu': 'เมนู',
  // The Buddhist era, which is what a Thai reader expects — but from ICU, not from
  // `p.year + 543`. Arithmetic in a catalogue is arithmetic a translator inherits: seven
  // locales fall back to this entry, so the `+ 543` put 2569 on the German page and the
  // year on screen moved by 543 when nothing but the language had changed.
  'footer.copyright': (p, f) => `© พ.ศ. ${f.year(p.year)}`,

  /* ---- Contact channels and the spec sheet -------------------------------- */
  'contact.phone': 'โทรศัพท์',
  'contact.line': 'LINE',
  'contact.email': 'อีเมล',
  'spec.material': 'วัสดุ',
  'spec.material.value': 'อะลูมิเนียมอัดรีด',
  'spec.profileThickness': 'ความหนาโปรไฟล์',
  'spec.standards': 'มาตรฐานที่ผ่าน',
  'spec.warranty': 'การรับประกัน',

  /* ---- Reviews — plan section 9 --------------------------------------------- */
  'review.heading': 'รีวิวจากลูกค้าที่ติดตั้งจริง',
  /*
   * ⭐ The average and its count, in one sentence, from one pair of integers. Plan 9.5 —
   * "5.0 ★" on its own reads as an advertisement; "5.0 จาก 5 · 1 รีวิว" reads as a fact.
   */
  'review.summary': (p, f) =>
    `${f.rating(p.ratingSum, p.ratingCount)} จาก 5 · ${f.integer(p.ratingCount)} รีวิว`,
  'review.hiddenNote': (p, f) =>
    `มีรีวิว ${f.integer(p.hidden)} รายการถูกซ่อนเพราะผิดนโยบายการรีวิว — คะแนนของรีวิวเหล่านั้นยังนับรวมในค่าเฉลี่ยข้างต้น`,
  'review.publishedOn': (p, f) => `เขียนเมื่อ ${f.date(p.at)}`,
  'review.author.anonymous': 'ลูกค้า',
  'review.size': (p, f) => `ขนาดที่สั่ง ${f.dimensions(p.widthUm, p.heightUm, p.unit)}`,
  'review.erased': 'ข้อความและชื่อของรีวิวนี้ถูกลบตามคำขอของเจ้าของข้อมูล คะแนนยังนับรวมอยู่',
  'review.reply.heading': 'คำตอบจากทางร้าน',
  'review.reply.on': (p, f) => `ตอบเมื่อ ${f.date(p.at)}`,
  'review.photo.alt': (p, f) => `รูปจากลูกค้า รูปที่ ${f.integer(p.index)}`,
  'review.more': (p, f) => `และอีก ${f.integer(p.remaining)} รีวิว`,

  'review.form.heading': 'เขียนรีวิว',
  'review.form.for': (p) => `รีวิวสำหรับ ${p.name}`,
  'review.form.intro':
    'งานอะลูมิเนียมตัดสินกันหลังผ่านฝนไปรอบหนึ่ง ไม่ใช่หลังติดตั้งสามวัน — เขียนได้ทุกเมื่อ ไม่มีวันหมดอายุ',
  'review.form.rating.legend': 'ให้กี่ดาว',
  'review.form.rating.option': (p, f) => `${f.integer(p.stars)} ดาว`,
  'review.form.rating.required': 'เลือกจำนวนดาวก่อนส่ง',
  'review.form.body.label': 'เล่าให้ฟังหน่อย (ไม่บังคับ)',
  /* The one instruction that is not politeness: a public page is a public page. */
  'review.form.body.help': 'อย่าใส่ที่อยู่ เบอร์โทร หรือข้อมูลของคนอื่น รีวิวนี้เป็นข้อความสาธารณะ',
  'review.form.name.label': 'ชื่อที่จะแสดง (ไม่บังคับ)',
  'review.form.name.help': 'จะแสดงคู่กับรีวิว ใส่ชื่อย่อหรือเว้นว่างก็ได้',
  'review.form.submit': 'ส่งรีวิว',
  'review.form.submitting': 'กำลังส่ง…',
  'review.form.moderation': 'รีวิวจะขึ้นหน้าสินค้าหลังทีมงานตรวจ หรือขึ้นเองเมื่อครบกำหนดโดยไม่ต้องรอใคร',
  'review.form.loading': 'กำลังเปิดคำเชิญ…',
  'review.form.invalid.title': 'ลิงก์นี้ใช้ไม่ได้',
  'review.form.invalid.body': 'ลิงก์อาจถูกใช้ไปแล้ว หรือคัดลอกมาไม่ครบ ลองเปิดจากอีเมลคำเชิญอีกครั้ง',
  'review.form.failed.title': 'ส่งรีวิวไม่สำเร็จ',
  'review.form.failed.body': 'ลองอีกครั้ง ถ้ายังไม่ได้ ให้ตอบกลับอีเมลคำเชิญมาได้เลย',
  'review.form.done.title': 'ได้รับรีวิวแล้ว ขอบคุณครับ',
  'review.form.done.body': 'รีวิวจะปรากฏบนหน้าสินค้าเมื่อผ่านการตรวจหรือครบกำหนด',
  'review.meta.title': 'เขียนรีวิว',

  'account.title': 'บัญชีของฉัน',
  'account.password.section': 'เปลี่ยนรหัสผ่าน',
  'account.password.current': 'รหัสผ่านปัจจุบัน',
  'account.password.new': 'รหัสผ่านใหม่',
  'account.password.confirm': 'ยืนยันรหัสผ่านใหม่',
  'account.password.action': 'เปลี่ยนรหัสผ่าน',
  'account.password.saving': 'กำลังเปลี่ยน…',
  'account.password.done': 'เปลี่ยนรหัสผ่านแล้ว',
  'account.password.doneOthers': 'เปลี่ยนรหัสผ่านแล้ว — และออกจากระบบอุปกรณ์อื่นทั้งหมดให้ด้วย',
  'account.password.note': 'เมื่อเปลี่ยนแล้ว อุปกรณ์อื่นที่เข้าระบบอยู่จะถูกออกจากระบบ — เครื่องนี้ยังอยู่',
  'account.password.problem.currentMissing': 'กรุณากรอกรหัสผ่านปัจจุบัน',
  'account.password.problem.tooShort': 'รหัสผ่านใหม่สั้นเกินไป ต้องมีอย่างน้อย 12 ตัวอักษร',
  'account.password.problem.sameAsCurrent': 'รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสผ่านเดิม',
  'account.password.problem.mismatch': 'รหัสผ่านใหม่กับการยืนยันไม่ตรงกัน',
  'account.checking': 'กำลังตรวจสอบ…',
  'account.needAccount': 'เข้าสู่ระบบก่อนขอใบเสนอราคา',
  'account.whyAccount':
    'เพื่อให้ใบเสนอราคาผูกกับบัญชีของท่าน และเปิดดูได้จากเครื่องไหนก็ได้ — สมัครใช้แค่เบอร์โทรกับรหัสผ่าน',
  'account.register': 'สมัครสมาชิก',
  'account.signIn': 'เข้าสู่ระบบ',
  'account.haveAccount': 'มีบัญชีอยู่แล้ว?',
  'account.noAccount': 'ยังไม่มีบัญชี?',
  'account.phone': 'เบอร์โทรศัพท์',
  'account.username': 'เบอร์โทรหรืออีเมล',
  'account.usernameHint': 'ใส่เบอร์โทรที่สมัครไว้ หรืออีเมลถ้ามีบัญชีอยู่แล้ว',
  'account.password': 'รหัสผ่าน',
  'account.passwordHint': 'อย่างน้อย 12 ตัวอักษร',
  'account.signedInAs': 'เข้าสู่ระบบแล้ว',
  'account.signOut': 'ออกจากระบบ',
  'account.problem.badPhone': 'เบอร์โทรไม่ถูกต้อง เช่น 081-234-5678',
  'account.problem.passwordTooShort': 'รหัสผ่านสั้นเกินไป ต้องมีอย่างน้อย 12 ตัวอักษร',
  'account.problem.unreachable': 'เชื่อมต่อไม่ได้ โปรดลองอีกครั้ง',
  'account.problem.unconfigured': 'ระบบยังไม่พร้อม โปรดติดต่อทีมขาย',
  'account.myQuotations': 'ใบเสนอราคาของฉัน',
  'account.noQuotations': 'ยังไม่มีใบเสนอราคา',

  'submit.heading': 'ขอใบเสนอราคา',
  'submit.intro':
    'กรอกชื่อและช่องทางติดต่อ แล้วเราจะออกใบเสนอราคาให้ทันที — ราคาและรายละเอียดจะถูกตรึงไว้ตามที่เห็นในตะกร้านี้',
  'submit.name': 'ชื่อผู้ติดต่อ',
  'submit.namePlaceholder': 'ชื่อ-นามสกุล',
  'submit.email': 'อีเมล',
  'submit.phone': 'เบอร์โทรศัพท์',
  'submit.channelHint': 'กรอกอย่างน้อยหนึ่งช่องทาง — มีเบอร์โทรอย่างเดียวก็ได้',
  'submit.action': 'ขอใบเสนอราคา',
  'submit.sending': 'กำลังออกใบเสนอราคา…',
  'submit.problem.nameMissing': 'กรุณากรอกชื่อผู้ติดต่อ',
  'submit.problem.noChannel': 'กรุณากรอกอีเมลหรือเบอร์โทรอย่างน้อยหนึ่งอย่าง',
  'submit.problem.badPhone': 'เบอร์โทรไม่ถูกต้อง เช่น 081-234-5678',
  'submit.problem.badEmail': 'อีเมลไม่ถูกต้อง',
  'submit.problem.unreachable': 'เชื่อมต่อไม่ได้ โปรดลองอีกครั้ง',
  'submit.problem.unconfigured': 'ระบบยังไม่พร้อมรับคำขอ โปรดติดต่อทีมขาย',
  'submit.problem.unavailable':
    'มีสินค้าในตะกร้าที่ไม่มีจำหน่ายแล้ว โปรดลบรายการนั้นออกก่อน แล้วลองอีกครั้ง',
  'submit.done': 'ออกใบเสนอราคาแล้ว',
  'submit.viewQuotation': 'เปิดใบเสนอราคา',

  'quotation.meta.title': 'ใบเสนอราคาของคุณ',
  'quotation.loading': 'กำลังเปิดใบเสนอราคา…',
  'quotation.heading': 'ใบเสนอราคา',
  'quotation.unavailable.title': 'เปิดใบเสนอราคานี้ไม่ได้',
  'quotation.unavailable.body':
    'ลิงก์อาจหมดอายุ หรือคัดลอกมาไม่ครบ โปรดติดต่อทีมขายเพื่อขอลิงก์ใหม่',
  'quotation.unreachable.title': 'ตอนนี้เชื่อมต่อไม่ได้',
  'quotation.unreachable.body': 'โปรดลองอีกครั้ง หากยังไม่ได้ให้ติดต่อทีมขาย',
  'quotation.retry': 'ลองอีกครั้ง',
  'quotation.print': 'พิมพ์หรือบันทึกเป็น PDF',
  'quotation.orderNo': 'เลขที่',
  'quotation.revision': 'ฉบับแก้ไข',
  'quotation.submittedAt': 'วันที่ยืนยัน',
  'quotation.leadTime': 'ระยะเวลาผลิต (วัน)',
  'quotation.net': 'ราคาก่อนภาษี',
  'quotation.vat': 'ภาษีมูลค่าเพิ่ม',
  'quotation.total': 'ยอดรวมทั้งสิ้น',
  'quotation.lineNo': 'ลำดับ',
  'quotation.item': 'รายการ',
  'quotation.qty': 'จำนวน',
  'quotation.amount': 'จำนวนเงิน',
  'quotation.charges': 'ค่าใช้จ่ายอื่น',
  'quotation.pinnedNotice':
    'เอกสารนี้ถูกตรึงไว้ตั้งแต่วันที่ยืนยัน — ตัวเลขและภาษาจะไม่เปลี่ยนเมื่อเปิดซ้ำ',
  'quotation.degraded': 'ภาษาที่ตรึงไว้ไม่รองรับในรุ่นนี้ จึงแสดงเป็นภาษาไทยแทน',
  'quotation.contact': 'เรียน',
  'quotation.seller.phone': 'โทรศัพท์',
  'quotation.seller.taxId': 'เลขผู้เสียภาษี',

  /* ---- Display settings ------------------------------------------------------ */
  'settings.nav': 'การแสดงผล',
  'settings.heading': 'ตั้งค่าการแสดงผล',
  'settings.intro':
    'ตั้งค่าว่าจะให้เว็บไซต์แสดงภาษา หน่วยวัด และสกุลเงินอย่างไร ทั้งหมดนี้เป็นเรื่องการแสดงผลเท่านั้น ขนาดที่คุณกรอกและราคาที่ระบบคิดไว้ไม่เปลี่ยนตาม',
  'settings.meta.title': 'ตั้งค่าการแสดงผล',

  'settings.language.legend': 'ภาษาที่ใช้แสดงหน้าเว็บ',
  'settings.language.accountDiffers': (p) => `บัญชีของคุณตั้งภาษาไว้เป็น ${p.language}`,
  'settings.language.applyAccount': 'ใช้ภาษาของบัญชีบนเครื่องนี้',
  'settings.unit.legend': 'หน่วยที่ใช้แสดงขนาด',
  'settings.currency.legend': 'สกุลเงินที่ใช้แสดงราคา',
  'settings.currency.fixed': (p) => `แสดงเป็น ${p.currency} ทุกภาษา`,
  'settings.currency.why':
    'ราคาทั้งหมดคิดและเก็บเป็นเงินบาท หน้าสินค้าถูกสร้างไว้ล่วงหน้าและใช้ร่วมกันทุกคน จึงเลือกสกุลเงินรายบุคคลไม่ได้ ใบเสนอราคาสำหรับลูกค้าต่างประเทศเป็นคนละเรื่องและยังไม่เปิดใช้',

  'settings.storage.local': 'ตอนนี้เก็บไว้ในเบราว์เซอร์นี้เครื่องเดียว',
  'settings.storage.account': (p, f) => `บันทึกไว้กับบัญชีแล้วเมื่อ ${f.date(p.at)}`,
  'settings.storage.signIn': 'เข้าสู่ระบบเพื่อให้ค่าที่ตั้งไว้ตามไปกับเครื่องอื่นด้วย',
  'settings.storage.saving': 'กำลังบันทึก',
  'settings.storage.failed': 'บันทึกลงบัญชีไม่สำเร็จ ค่าที่เลือกยังใช้ได้ในเบราว์เซอร์นี้',
  'settings.storage.forget': 'ลบค่าที่บันทึกไว้กับบัญชี',

  'settings.messages.heading': 'ภาษาของข้อความที่เราส่งถึงคุณ',
  'settings.messages.degraded': (p) =>
    `ยังไม่มีคำแปล${p.chosen} ข้อความจากระบบจะส่งเป็น${p.rendered}`,
  'settings.messages.coverage': (p, f) =>
    `แปลแล้ว ${f.plain(p.translated)} จาก ${f.plain(p.total)} ข้อความ`,

  'settings.effects.heading': 'ค่าที่ตั้งไว้มีผลกับอะไรบ้าง',
  'settings.effects.intro':
    'รายการนี้มาจากระบบหลังบ้านโดยตรง ไม่ใช่หน้านี้เดาเอง — ค่าที่ยังไม่มีผลจะบอกไว้ตรงนี้แทนที่จะปล่อยให้เข้าใจผิด',
  'settings.effect.locale.notification': 'ภาษาในอีเมลแจ้งเตือน',
  'settings.effect.locale.document': 'ภาษาในใบเสนอราคาและใบแจ้งหนี้ที่ออกไปแล้ว',
  'settings.effect.locale.storefront': 'ภาษาของหน้าเว็บ',
  'settings.effect.locale.dashboard': 'ภาษาในระบบจัดการภายใน',
  'settings.effect.currency.notification': 'สกุลเงินในอีเมลแจ้งเตือน',
  'settings.effect.currency.document': 'สกุลเงินในเอกสารที่ออกไปแล้ว',
  'settings.effect.currency.storefront': 'สกุลเงินของราคาบนหน้าเว็บ',
  'settings.effect.currency.dashboard': 'สกุลเงินในระบบจัดการภายใน',
  'settings.effect.lengthUnit.notification': 'หน่วยวัดในอีเมลแจ้งเตือน',
  'settings.effect.lengthUnit.document': 'หน่วยวัดในเอกสารที่ออกไปแล้ว',
  'settings.effect.lengthUnit.storefront': 'หน่วยวัดของขนาดบนหน้าเว็บ',
  'settings.effect.lengthUnit.dashboard': 'หน่วยวัดในระบบจัดการภายใน',
  'settings.effect.yes': 'มีผล',
  'settings.effect.no': 'ยังไม่มีผล',

  /* ---- Not found ----------------------------------------------------------- */
  'notFound.title': 'ไม่พบหน้าที่ต้องการ',
  'notFound.body': 'ลิงก์อาจเปลี่ยนไปแล้ว ลองเริ่มจากรายการสินค้า',

  /* ---- Paying, and attaching a slip ---------------------------------- */
  'payment.meta.title': 'แจ้งชำระเงิน',
  'payment.heading': 'แจ้งชำระเงิน',
  'payment.loading': 'กำลังเปิดข้อมูลการชำระเงิน…',
  'payment.outstanding': 'ยอดคงค้าง',
  'payment.outstandingAmount': (p, f) => {
    const negative = p.owedMinor < 0n;
    const magnitude = negative ? -p.owedMinor : p.owedMinor;
    return `${negative ? '-' : ''}฿${f.plain(magnitude / 100n)}.${String(magnitude % 100n).padStart(2, '0')}`;
  },
  'payment.settled': 'ออเดอร์นี้ชำระครบแล้ว',
  'payment.account.legend': 'โอนเข้าบัญชีใดบัญชีหนึ่ง',
  'payment.account.copy': (p) => `คัดลอกเลขบัญชี ${p.accountDigits}`,
  'payment.account.copied': 'คัดลอกเลขบัญชีแล้ว',
  'payment.account.qrAlt': 'คิวอาร์โค้ดพร้อมเพย์สำหรับยอดที่กรอกไว้',
  'payment.account.qrHint': 'สแกนด้วยแอปธนาคาร — จำนวนเงินจะถูกกรอกให้อัตโนมัติ',
  'payment.account.none': 'ยังไม่ได้ตั้งค่าบัญชีรับเงิน กรุณาติดต่อทีมขายเพื่อขอช่องทางชำระเงิน',
  'payment.form.legend': 'แนบสลิป',
  'payment.form.image': 'รูปสลิป',
  'payment.form.imageHint': 'ถ่ายจากแอปธนาคารได้เลย ไฟล์ไม่เกิน 8 MB',
  'payment.form.amount': 'จำนวนเงินที่โอน',
  'payment.form.transferredAt': 'วันและเวลาที่โอน',
  'payment.form.reference': 'เลขอ้างอิง (ถ้ามี)',
  'payment.form.submit': 'ส่งสลิป',
  'payment.phase.uploading': 'กำลังอัปโหลดรูป…',
  'payment.phase.creating': 'กำลังบันทึกสลิป…',
  'payment.done': 'ได้รับสลิปแล้ว ทีมงานจะตรวจสอบและแจ้งกลับ',
  'payment.history.heading': 'สลิปที่ส่งไปแล้ว',
  'payment.history.empty': 'ยังไม่ได้ส่งสลิป',
  // Baht and satang split inline here, the same way `payment.outstandingAmount` does —
  // and *not* `satangField` from `@wewin/core/money`. That helper is ASCII with no
  // grouping and no currency mark because it writes into a field `readSatang` reads back;
  // these three are display, not input, so the baht part goes through `f.plain` (a
  // Burmese reader sees Burmese digits) and only the two-digit fractional part stays
  // ASCII. The slip history is where a customer checks "did they receive what I sent?" —
  // rounding it to whole baht here is the exact failure this page exists to avoid.
  'payment.history.submitted': (p, f) => {
    const negative = p.slipMinor < 0n;
    const magnitude = negative ? -p.slipMinor : p.slipMinor;
    return `${negative ? '-' : ''}฿${f.plain(magnitude / 100n)}.${String(magnitude % 100n).padStart(2, '0')} · ส่งเมื่อ ${f.date(p.sentAt)} · รอตรวจสอบ`;
  },
  'payment.history.accepted': (p, f) => {
    const negative = p.slipMinor < 0n;
    const magnitude = negative ? -p.slipMinor : p.slipMinor;
    return `${negative ? '-' : ''}฿${f.plain(magnitude / 100n)}.${String(magnitude % 100n).padStart(2, '0')} · ส่งเมื่อ ${f.date(p.sentAt)} · รับแล้ว`;
  },
  'payment.history.rejected': (p, f) => {
    const negative = p.slipMinor < 0n;
    const magnitude = negative ? -p.slipMinor : p.slipMinor;
    return `${negative ? '-' : ''}฿${f.plain(magnitude / 100n)}.${String(magnitude % 100n).padStart(2, '0')} · ไม่ผ่าน — ${p.reason}`;
  },
  'payment.problem.noImage': 'กรุณาแนบรูปสลิป',
  'payment.problem.imageTooBig': (p, f) => `รูปใหญ่เกินไป — ไม่เกิน ${f.plain(p.limitMib)} MB`,
  'payment.problem.badAmount': 'กรอกจำนวนเงินเป็นตัวเลข ทศนิยมไม่เกินสองตำแหน่ง',
  'payment.problem.badTime': 'กรุณาเลือกวันและเวลาที่โอน',
  'payment.problem.signInAgain': 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง ข้อมูลที่กรอกไว้ยังอยู่',
  'payment.problem.unreachable': 'เชื่อมต่อไม่ได้ กรุณาลองใหม่',
};
