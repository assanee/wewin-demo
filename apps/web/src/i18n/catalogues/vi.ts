import type { PartialUiCatalogue } from '../keys';

/**
 * Vietnamese (Tiếng Việt) — complete.
 *
 * ⚠️ **This file used to say "empty on purpose".** That note argued a plausible sentence
 * nobody in the company can read back is worse than a visible fallback, and it still holds
 * for *content* — product names, rule messages, the catalogue — which is why `content.ts`
 * still routes those through `ContentRef`. What changed is that the UI shell, a closed set
 * of 346 keys, was translated on request and is treated as shipped.
 *
 * ── What this catalogue has to get right ─────────────────────────────────────
 *
 *   - **Classifiers, not plurals.** Like Thai and unlike German, nothing agrees in number:
 *     `2 mục` and `1 mục` are the same word. But the classifier is not free — `cái` for a
 *     piece, `mẫu` for a design, `đánh giá` counts itself. There is no `count` helper here
 *     and adding one would be importing a problem this language does not have.
 *   - **VAT stays VAT**, which is what Vietnamese commercial prose uses (`thuế GTGT` is the
 *     formal term and both are read; VAT is what appears on invoices).
 *   - **Diacritics are load-bearing.** `bao gồm` and `bao gồm` differ from `bao gôm` in
 *     meaning, not in style — this file is not safe to "clean up" by stripping marks.
 *
 * ⚠️ `f.entry` / `f.entryRange` stay ASCII here as everywhere: they label a field the
 * customer types back into, and `parseMeasure` accepts one separator.
 */
export const vi: PartialUiCatalogue = {
  /* ---- Shell and navigation ---------------------------------------- */
  'a11y.skipToContent': 'Chuyển tới nội dung chính',
  'nav.mainLabel': 'Menu chính',
  'nav.homeLabel': (p) => `Trang chủ ${p.wordmark}`,
  'nav.products': 'Sản phẩm',
  'nav.about': 'Về chúng tôi',
  'nav.quote': 'Danh sách báo giá',
  'nav.allProducts': 'Xem tất cả sản phẩm',
  'nav.backToProducts': 'Quay lại tất cả sản phẩm',
  'nav.addMore': 'Thêm sản phẩm khác',
  'quote.badge.filled': (p, f) => `${f.integer(p.count)} mục trong danh sách báo giá`,
  'quote.badge.empty': 'Danh sách báo giá đang trống',

  /* ---- Money and measurement ---------------------------------------- */
  'price.perSqmSuffix': '/ m²',
  'price.from': 'Từ',
  'price.fromShort': 'Từ',
  'price.unit': 'Đơn giá',
  'price.total': 'Thành tiền',
  'price.grandTotal': 'Tổng cộng',
  'price.perPiece': (p, f) => `${f.baht(p.minor)} mỗi cái`,
  'value.unknown': '—',
  'unit.sqmSuffix': 'm²',
  'count.pieces': (p, f) => `${f.integer(p.count)} cái`,
  'count.items': (p, f) => `${f.integer(p.count)} mục`,
  'count.designs': (p, f) => `${f.integer(p.count)} mẫu`,
  'leadTime.range': (p, f) => `${f.integer(p.days[0])}–${f.integer(p.days[1])} ngày`,
  'leadTime.produce': (p, f) =>
    `sản xuất trong ${f.integer(p.days[0])}–${f.integer(p.days[1])} ngày`,

  /* ---- Pickers ------------------------------------------------------ */
  'unit.pickerLabel': 'Đơn vị',
  'unit.groupLabel': 'Kích thước hiển thị theo',
  'unit.name.mm': 'milimét',
  'unit.name.cm': 'xentimét',
  'unit.name.m': 'mét',
  'unit.name.in': 'inch',
  'unit.name.ft': 'foot',
  'locale.pickerLabel': 'Ngôn ngữ',
  'locale.groupLabel': 'Ngôn ngữ hiển thị của trang này',
  'locale.partial': 'Một phần nội dung chưa được dịch và sẽ hiển thị bằng tiếng Thái.',

  /* ---- Home --------------------------------------------------------- */
  'home.hero.line1': 'Làm theo đúng ô chờ của bạn',
  'home.hero.line2': 'Xem giá trước khi gọi',
  'home.hero.body':
    'Cửa sổ, cửa chớp và cửa đi bằng nhôm. Nhập chiều rộng và chiều cao thực tế của ô chờ để thấy ngay giá đầy đủ — không cần đăng nhập, không cần để lại số điện thoại trước.',
  'home.hero.cta': 'Xem sản phẩm và tính giá',
  'home.fact.designs': 'Mẫu hiện có',
  'home.fact.startingPrice': 'Giá khởi điểm',
  'home.fact.leadTime': 'Thời gian sản xuất',
  'home.how.heading': 'Cách thức hoạt động',
  'home.how.body':
    'Với hàng đặt theo kích thước, việc tự xem giá trước khi liên hệ vẫn còn hiếm. Đây là những gì sẽ diễn ra tiếp theo.',
  'home.step.measure.title': 'Đo ô chờ và nhập số đo',
  'home.step.measure.body':
    'Chọn mẫu bạn muốn, rồi nhập chiều rộng × chiều cao thực tế của ô chờ.',
  'home.step.price.title': 'Thấy giá ngay lập tức',
  'home.step.price.body':
    'Giá đầy đủ hiện ra ngay, với từng khoản cấu thành được liệt kê riêng.',
  'home.step.request.title': 'Yêu cầu báo giá',
  'home.step.request.body':
    'Gom những sản phẩm bạn quan tâm rồi gửi cho chúng tôi. Ở bước này bạn chưa cam kết điều gì.',
  'home.step.survey.title': 'Khảo sát tại công trình trước khi sản xuất',
  'home.step.survey.body': (p, f) =>
    `Đội ngũ của chúng tôi sẽ đo tại công trình để xác nhận kích thước và giá trước khi bắt đầu sản xuất.${
      p.days === null
        ? ''
        : ` Thời gian sản xuất từ ${f.integer(p.days[0])}–${f.integer(p.days[1])} ngày tuỳ theo mẫu.`
    }`,
  'home.estimate.note':
    'Giá trên trang này là ước tính dựa trên số đo bạn nhập. Giá cuối cùng được xác nhận sau khi đội ngũ của chúng tôi đo tại công trình.',
  'home.estimate.emphasis': 'ước tính dựa trên số đo bạn nhập',
  'home.categories.heading': 'Chọn theo loại công việc',
  'home.category.empty': 'Chưa có sản phẩm nào trong hạng mục này',
  'home.pricing.heading': 'Giá được tính như thế nào',
  'home.pricing.body':
    'Cả ba điều này có mặt ở đây vì bạn nên biết trước khi nhập kích thước, chứ không phải khi đã thấy con số cuối cùng.',
  'home.pricing.formula.title': 'Công thức',
  'home.pricing.formula.body': 'Giá = đơn giá mỗi m² × diện tích tính tiền + tuỳ chọn',
  'home.pricing.formula.note':
    'Tuỳ chọn gồm màu nhôm, phần lấp trong khung — kính, lá chớp hoặc lưới — cùng phụ kiện bạn thêm vào. Từng khoản đều được liệt kê riêng trên trang giá.',
  'home.pricing.floor.title': 'Diện tích tính tiền tối thiểu',
  'home.pricing.floor.body':
    'Cánh nhỏ hơn mức tối thiểu sẽ được tính theo diện tích tối thiểu.',
  'home.pricing.floor.range': (p, f) =>
    p.span === null ? '—' : `${f.area(p.span[0])}–${f.area(p.span[1])} m²`,
  'home.pricing.floor.note':
    'tuỳ theo mẫu. Trang giá luôn nêu rõ mức tối thiểu của mẫu bạn đã chọn.',
  'home.pricing.excluded.title': 'Giá này chưa bao gồm',
  'home.pricing.excluded.install': 'Lắp đặt',
  'home.pricing.excluded.delivery': 'Vận chuyển',
  'home.pricing.excluded.removal': 'Tháo dỡ bộ cũ',
  'home.pricing.excluded.note':
    'Cả ba khoản đều phụ thuộc vào công trình nên không thể ước tính chỉ từ kích thước. Chúng sẽ xuất hiện trong báo giá sau khi khảo sát.',

  'meta.title': 'WEWIN180 — làm theo số đo của bạn, có giá trước khi hỏi',
  'meta.description':
    'WEWIN180 — cửa sổ, cửa chớp và cửa đi làm theo số đo của riêng bạn. Tự tính giá trước khi yêu cầu báo giá.',

  /* ---- Catalogue ---------------------------------------------------- */
  'catalog.heading': 'Tất cả sản phẩm',
  'catalog.resultCount': (p, f) => `${f.integer(p.count)} sản phẩm`,
  'catalog.empty.title': 'Chưa có gì khớp với các bộ lọc này',
  'catalog.empty.body': 'Thử bỏ bớt một hai bộ lọc rồi xem lại toàn bộ.',
  'filter.title': 'Bộ lọc',
  'filter.clear': 'Xoá bộ lọc',
  'filter.showResults': (p, f) => `Xem kết quả (${f.integer(p.count)} sản phẩm)`,
  'filter.section.category': 'Hạng mục',
  'filter.section.profileColor': 'Màu nhôm',
  'filter.section.pricePerSqm': 'Đơn giá mỗi m²',
  'filter.priceTo': 'đến',
  'filter.priceMax': 'Không quá',
  'product.colorCount': (p, f) => `${f.integer(p.count)} màu nhôm`,
  'product.sizeRange': (p, f) => `Kích thước ${f.range(p.minUm, p.maxUm, p.unit)}`,

  /* ---- Configurator -------------------------------------------------- */
  'configure.loadingLine': 'Đang tải mục này…',
  'configure.spec.note':
    'Về thông số kỹ thuật chi tiết, tiêu chuẩn và điều kiện bảo hành, xin liên hệ đội ngũ của chúng tôi theo thông tin bên dưới.',
  'configure.view.front': 'Mặt trước',
  'configure.view.halfPanel': 'Nửa cánh',
  'configure.view.transom': 'Ô thoáng trên',
  'configure.size.heading': 'Kích thước',
  'configure.area.line': (p, f) =>
    `Diện tích ${f.area(p.areaSqUm)} m² · tính tối thiểu ${f.area(p.minBillableSqUm)} m²`,
  'configure.group.affectsSku': 'ảnh hưởng tới mã sản phẩm',
  'configure.quoteNext': 'Thêm vào danh sách báo giá, rồi yêu cầu báo giá ngay ở đó.',
  'configure.breakdown.title': 'Chi tiết giá',
  'configure.qty': 'Số lượng',
  'configure.qty.decrease': 'Bớt một cái',
  'configure.qty.increase': 'Thêm một cái',
  // Thai says `ลด${group} ${step}` as one clause; Vietnamese needs the object between the
  // verb and the amount, which is why the key carries the parts.
  'measure.decrease': (p, f) => `Giảm ${p.group} ${f.entry(p.stepUm, p.unit)}`,
  'measure.increase': (p, f) => `Tăng ${p.group} ${f.entry(p.stepUm, p.unit)}`,
  'measure.helper': (p, f) =>
    `${f.entryRange(p.minUm, p.maxUm, p.unit)} · bước ${f.entry(p.gridUm, p.unit)}`,

  /* ---- Drawings ------------------------------------------------------- */
  'drawing.schematic': 'Phác hoạ tỉ lệ',
  'drawing.schematic.sized': (p) => `Phác hoạ tỉ lệ, ${p.size}`,
  'drawing.elevation': (p) =>
    `Bản vẽ mặt đứng, ${p.width} × ${p.height} ${p.unit}${
      p.invalid ? ' — kích thước này nằm ngoài khả năng sản xuất' : ''
    }`,
  'drawing.unitNote': (p) => `Đơn vị: ${p.unit}`,

  /* ---- Toolbar, share, QR -------------------------------------------- */
  'toolbar.groupLabel': 'Quản lý cấu hình này',
  'toolbar.undo': 'Hoàn tác',
  'toolbar.redo': 'Làm lại',
  'toolbar.reset': 'Trở về mặc định',
  'toolbar.share': 'Chia sẻ liên kết tới cấu hình này',
  'toolbar.qr': 'Tạo mã QR cho liên kết này',
  'share.sheet.title': 'Chia sẻ liên kết',
  'share.qr.title': 'Mã QR cho liên kết này',
  'share.body':
    'Liên kết này mở trình cấu hình với đúng kích thước và tuỳ chọn bạn đang xem. Hãy gửi cho thợ lắp đặt hoặc người nhà.',
  'share.copyLink': 'Sao chép liên kết',
  'share.copied': 'Đã sao chép liên kết',
  'share.showQr': 'Hiển thị dạng mã QR',
  'qr.alt': 'Mã QR cho liên kết tới cấu hình này',
  'qr.failed': 'Không tạo được mã QR. Hãy dùng nút sao chép liên kết.',

  /* ---- Price summary and breakdown ------------------------------------ */
  'summary.label': 'Tóm tắt giá',
  'summary.skuCode': 'Mã sản phẩm',
  'summary.copySku': (p) => `Sao chép mã sản phẩm ${p.skuCode}`,
  'summary.skuCopied': 'Đã sao chép mã sản phẩm',
  'summary.add': 'Thêm vào danh sách báo giá',
  'summary.hasErrors': 'Còn điều cần sửa ở phía trên. Bấm nút để xem đó là gì.',
  'summary.showBreakdown': 'Xem chi tiết giá',
  'summary.area': (p, f) => `${f.area(p.areaSqUm)} m²`,
  'summary.stickyMeta': (p, f) =>
    `${f.area(p.areaSqUm)} m²${
      p.qty > 1 ? ` · ${f.integer(p.qty)} cái` : ''
    } · xem chi tiết`,
  'breakdown.minimumApplied': (p, f) =>
    `Diện tích thực ${f.area(p.areaSqUm)} m² · tính theo mức tối thiểu ${f.area(
      p.minBillableSqUm,
    )} m²`,

  /* ---- Quote ---------------------------------------------------------- */
  'quote.heading': 'Danh sách báo giá',
  'quote.empty.title': 'Danh sách báo giá của bạn còn trống',
  'quote.empty.body':
    'Chọn một sản phẩm, nhập kích thước thực tế của ô chờ, rồi thêm vào đây.',
  'quote.empty.cta': 'Chọn sản phẩm',
  'quote.summary.label': 'Tổng',
  'quote.summary.lineCount': 'Mục',
  'quote.summary.lineCountValue': (p, f) =>
    `${f.integer(p.lines)} mục · ${f.integer(p.pieces)} cái`,
  'quote.summary.leadTime': 'Thời gian sản xuất',
  'quote.tableCaption': 'Các mục trong danh sách báo giá',
  'quote.col.name': 'Mục',
  'quote.col.sku': 'Mã sản phẩm',
  'quote.col.size': 'Kích thước',
  'quote.col.qty': 'SL',
  'quote.col.unitPrice': 'Đơn giá',
  'quote.col.total': 'Thành tiền',
  'quote.col.actions': 'Thao tác',
  'quote.action.edit': (p) => `Sửa cấu hình của ${p.nickname}`,
  'quote.action.duplicate': (p) => `Nhân bản ${p.nickname}`,
  'quote.action.remove': (p) => `Xoá ${p.nickname}`,
  'quote.qty.label': (p) => `Số lượng của ${p.nickname}`,
  'quote.qty.decrease': (p) => `Bớt một cái của ${p.nickname}`,
  'quote.qty.increase': (p) => `Thêm một cái của ${p.nickname}`,

  /* ---- Toasts and sheets ----------------------------------------------- */
  'toast.lineSaved': 'Đã lưu thay đổi',
  'toast.lineAdded': 'Đã thêm vào danh sách báo giá',
  'toast.viewQuote': 'Xem danh sách báo giá',
  'toast.dismiss': 'Đóng thông báo',
  'sheet.close': 'Đóng',
  'sheet.closeNamed': (p) => `Đóng ${p.title}`,

  /* ---- About ------------------------------------------------------------ */
  'about.heading': 'Về chúng tôi',
  'about.intro':
    'Chúng tôi gia công nhôm theo đúng số đo thực tế tại công trình của bạn. Xưởng của chúng tôi đặt tại Phitsanulok.',
  'about.tool':
    'Trang này là công cụ tính giá của chính chúng tôi. Nhập chiều rộng và chiều cao ô chờ để thấy ngay giá đầy đủ, không cần liên hệ ai trước.',
  'about.stance.heading': 'Vì sao chúng tôi công khai giá',
  'about.stance.noPhone.title': 'Hỏi giá không nên phải trả bằng số điện thoại của bạn',
  'about.stance.noPhone.body':
    'Phần lớn hàng đặt theo kích thước đòi số điện thoại trước khi đưa ra con số, nghĩa là ai chỉ muốn biết ngân sách sơ bộ cũng phải chấp nhận cuộc gọi sau đó. Chúng tôi đã bỏ bước ấy.',
  'about.stance.itemised.title': 'Một mức giá nên cho thấy nó từ đâu ra',
  'about.stance.itemised.body':
    'Trang giá liệt kê từng khoản cấu thành tổng — diện tích, màu, phần lấp trong khung và phụ kiện. Khi con số thay đổi, bạn thấy được điều gì đã làm nó thay đổi.',
  'about.stance.limits.title': 'Nêu giới hạn từ đầu, không phải về sau',
  'about.stance.limits.body':
    'Diện tích tính tiền tối thiểu, những kích thước chúng tôi không làm được, và những gì giá chưa bao gồm đều nằm trên trang trước khi bạn nhập kích thước, thay vì xuất hiện giữa cuộc trò chuyện.',
  'about.range.heading': 'Chúng tôi làm gì',
  'about.range.body':
    'Mọi con số ở đây đều đọc từ cùng bộ danh mục dùng để tính giá. Không con số nào được ghi lại riêng.',
  'about.fact.designs.note': (p, f) => `thuộc ${f.integer(p.categories)} hạng mục`,
  'about.fact.leadTime.note': 'tuỳ theo mẫu',
  'about.fact.floor': 'Diện tích tính tiền tối thiểu',
  'about.fact.floor.note': 'cánh nhỏ hơn được tính theo mức tối thiểu',
  'about.fact.legalName': 'Tên đăng ký',
  'about.fact.makes': 'Chúng tôi làm gì',
  'about.fact.serviceArea': 'Chúng tôi giao tới đâu',
  'about.contact.heading': 'Chúng tôi ở đâu và liên hệ thế nào',
  'about.card.factory': 'Xưởng và văn phòng',
  'about.card.delivery': 'Vận chuyển và lắp đặt',
  'about.card.delivery.note':
    'Giá trên trang này chưa bao gồm lắp đặt và vận chuyển, vì hai khoản đó phụ thuộc vào công trình và quãng đường. Đội ngũ của chúng tôi sẽ ước tính trong báo giá.',
  'about.card.hours': 'Giờ làm việc',
  'about.card.hours.note':
    'Ngoài giờ làm việc, xin để lại tin nhắn qua LINE hoặc email; đội ngũ của chúng tôi sẽ trả lời vào ngày làm việc kế tiếp.',

  /* ---- Footer ------------------------------------------------------------ */
  'footer.contact': 'Liên hệ',
  'footer.hours': 'Giờ làm việc',
  'footer.serviceArea': 'Khu vực phục vụ',
  'footer.menu': 'Menu',
  // Gregorian, from the same param Thai renders as พ.ศ. No arithmetic here.
  'footer.copyright': (p, f) => `© ${f.year(p.year)}`,

  /* ---- Contact channels and the spec sheet -------------------------------- */
  'contact.phone': 'Điện thoại',
  'contact.line': 'LINE',
  'contact.email': 'Email',
  'spec.material': 'Vật liệu',
  'spec.material.value': 'Nhôm định hình đùn ép',
  'spec.profileThickness': 'Độ dày nhôm',
  'spec.standards': 'Tiêu chuẩn đáp ứng',
  'spec.warranty': 'Bảo hành',

  /* ---- Reviews ------------------------------------------------------------- */
  'review.heading': 'Đánh giá từ khách hàng đã lắp đặt',
  'review.summary': (p, f) =>
    `${f.rating(p.ratingSum, p.ratingCount)} trên 5 · ${f.integer(p.ratingCount)} đánh giá`,
  'review.hiddenNote': (p, f) =>
    `${f.integer(
      p.hidden,
    )} đánh giá bị ẩn do vi phạm quy định đánh giá — điểm số đó vẫn được tính vào trung bình ở trên`,
  'review.publishedOn': (p, f) => `Viết ngày ${f.date(p.at)}`,
  'review.author.anonymous': 'Khách hàng',
  'review.size': (p, f) => `Đặt ở kích thước ${f.dimensions(p.widthUm, p.heightUm, p.unit)}`,
  'review.erased':
    'Nội dung và tên trong đánh giá này đã được gỡ theo yêu cầu của người viết. Điểm số vẫn được tính.',
  'review.reply.heading': 'Phản hồi từ WEWIN180',
  'review.reply.on': (p, f) => `Phản hồi ngày ${f.date(p.at)}`,
  'review.photo.alt': (p, f) => `Ảnh của khách hàng ${f.integer(p.index)}`,
  'review.more': (p, f) => `và ${f.integer(p.remaining)} đánh giá nữa`,

  'review.form.heading': 'Viết đánh giá',
  'review.form.for': (p) => `Đánh giá ${p.name}`,
  'review.form.intro':
    'Hàng đặt làm riêng được đánh giá sau một mùa mưa, chứ không phải ba ngày sau khi lắp — bạn viết lúc nào cũng được. Mục này không đóng lại.',
  'review.form.rating.legend': 'Mấy sao',
  'review.form.rating.option': (p, f) => `${f.integer(p.stars)} sao`,
  'review.form.rating.required': 'Hãy chọn số sao trước khi gửi',
  'review.form.body.label': 'Kể cho chúng tôi nghe (không bắt buộc)',
  'review.form.body.help':
    'Xin đừng ghi địa chỉ, số điện thoại hay thông tin của người khác — đây là trang công khai.',
  'review.form.name.label': 'Tên hiển thị (không bắt buộc)',
  'review.form.name.help':
    'Hiển thị bên cạnh đánh giá của bạn. Viết tắt cũng được, để trống cũng được.',
  'review.form.submit': 'Gửi đánh giá',
  'review.form.submitting': 'Đang gửi…',
  'review.form.moderation':
    'Đánh giá của bạn sẽ xuất hiện trên trang sản phẩm sau khi chúng tôi đọc, hoặc tự động khi hết thời hạn xét duyệt.',
  'review.form.loading': 'Đang mở lời mời của bạn…',
  'review.form.invalid.title': 'Liên kết này không dùng được',
  'review.form.invalid.body':
    'Có thể nó đã được dùng, hoặc sao chép chưa đủ. Hãy mở lại từ email lời mời.',
  'review.form.failed.title': 'Đánh giá chưa được gửi',
  'review.form.failed.body':
    'Hãy thử lại. Nếu vẫn không được, xin trả lời email lời mời.',
  'review.form.done.title': 'Cảm ơn bạn — chúng tôi đã nhận được đánh giá',
  'review.form.done.body':
    'Đánh giá sẽ xuất hiện trên trang sản phẩm sau khi được đọc, hoặc khi hết thời hạn xét duyệt.',
  'review.meta.title': 'Viết đánh giá',

  'account.title': 'Tài khoản của tôi',
  'account.password.section': 'Đổi mật khẩu',
  'account.password.current': 'Mật khẩu hiện tại',
  'account.password.new': 'Mật khẩu mới',
  'account.password.confirm': 'Xác nhận mật khẩu mới',
  'account.password.action': 'Đổi mật khẩu',
  'account.password.saving': 'Đang đổi…',
  'account.password.done': 'Đã đổi mật khẩu',
  'account.password.doneOthers':
    'Đã đổi mật khẩu — và các thiết bị khác của bạn đã được đăng xuất.',
  'account.password.note':
    'Việc đổi mật khẩu sẽ đăng xuất mọi thiết bị khác bạn đang đăng nhập. Thiết bị này vẫn giữ nguyên.',
  'account.password.problem.currentMissing': 'Xin nhập mật khẩu hiện tại của bạn.',
  'account.password.problem.tooShort': 'Mật khẩu mới quá ngắn — ít nhất 12 ký tự.',
  'account.password.problem.sameAsCurrent':
    'Mật khẩu mới phải khác mật khẩu hiện tại.',
  'account.password.problem.mismatch': 'Mật khẩu mới và phần xác nhận không khớp.',
  'account.checking': 'Đang kiểm tra…',
  'account.needAccount': 'Đăng nhập để yêu cầu báo giá',
  'account.whyAccount':
    'Để báo giá thuộc về tài khoản của bạn và mở được trên mọi thiết bị — đăng ký chỉ cần một số điện thoại và một mật khẩu.',
  'account.register': 'Tạo tài khoản',
  'account.signIn': 'Đăng nhập',
  'account.haveAccount': 'Đã có tài khoản?',
  'account.noAccount': 'Chưa có tài khoản?',
  'account.phone': 'Điện thoại',
  'account.username': 'Số điện thoại hoặc email',
  'account.usernameHint':
    'Số bạn đã dùng để đăng ký, hoặc email nếu bạn đã có tài khoản.',
  'account.password': 'Mật khẩu',
  'account.passwordHint': 'Ít nhất 12 ký tự.',
  'account.signedInAs': 'Đã đăng nhập',
  'account.signOut': 'Đăng xuất',
  'account.problem.badPhone':
    'Không đọc được số điện thoại này — ví dụ 081-234-5678.',
  'account.problem.passwordTooShort': 'Mật khẩu này quá ngắn — ít nhất 12 ký tự.',
  'account.problem.unreachable': 'Không kết nối được. Xin thử lại.',
  'account.problem.unconfigured':
    'Hiện chưa dùng được. Xin liên hệ bộ phận kinh doanh.',
  'account.myQuotations': 'Báo giá của tôi',
  'account.noQuotations': 'Chưa có báo giá nào',
  'account.tabs.label': 'Các mục tài khoản',

  'account.profile.section': 'Thông tin người dùng',
  'account.profile.name': 'Tên',
  'account.profile.nameUnset': 'Chưa có tên',
  'account.profile.email': 'Email',
  'account.profile.noEmail': 'Chưa có địa chỉ email đã xác nhận',
  'account.profile.noPhone': 'Chưa có số điện thoại',
  'account.profile.verified': 'Đã xác nhận',
  'account.profile.verifiedByStaff': 'Đã được nhân viên xác nhận',
  'account.profile.unverified': 'Chưa xác nhận',
  'account.profile.unverifiedNote':
    'Nhân viên của chúng tôi sẽ xác nhận số khi trao đổi với bạn qua điện thoại — bạn không cần làm gì thêm.',
  'account.profile.readOnly':
    'Trang này chỉ hiển thị thông tin chúng tôi đang lưu. Để thay đổi, vui lòng liên hệ bộ phận bán hàng.',
  'account.profile.languageElsewhere': 'Ngôn ngữ được đặt ở trang cài đặt.',

  'submit.heading': 'Yêu cầu báo giá',
  'submit.intro':
    'Cho chúng tôi biết tên và một cách liên hệ, chúng tôi sẽ phát hành báo giá ngay — giá và các chi tiết được chốt đúng như đang hiển thị trong danh sách này.',
  'submit.name': 'Người liên hệ',
  'submit.namePlaceholder': 'Họ và tên',
  'submit.email': 'Email',
  'submit.phone': 'Điện thoại',
  'submit.channelHint': 'Ít nhất một trong hai — chỉ số điện thoại cũng được.',
  'submit.destination': 'Điểm đến',
  'submit.action': 'Yêu cầu báo giá',
  'submit.sending': 'Đang phát hành báo giá…',
  'submit.problem.nameMissing': 'Xin cho biết tên người liên hệ.',
  'submit.problem.noChannel': 'Xin cho biết email hoặc số điện thoại.',
  'submit.problem.badPhone':
    'Không đọc được số điện thoại này — ví dụ 081-234-5678.',
  'submit.problem.badEmail': 'Không đọc được địa chỉ email này.',
  'submit.problem.badDestination': 'Xin chọn lại điểm đến — lựa chọn trước đó không còn trong danh sách.',
  'submit.problem.unreachable': 'Không kết nối được. Xin thử lại.',
  'submit.problem.unconfigured':
    'Hiện chưa tiếp nhận yêu cầu. Xin liên hệ bộ phận kinh doanh.',
  'submit.problem.unavailable':
    'Có mục trong danh sách không còn khả dụng. Hãy xoá dòng đó rồi thử lại.',
  'submit.done': 'Báo giá của bạn đã sẵn sàng',
  'submit.viewQuotation': 'Mở báo giá',

  'quotation.meta.title': 'Báo giá của bạn',
  'quotation.loading': 'Đang mở báo giá của bạn…',
  'quotation.heading': 'Báo giá',
  'quotation.unavailable.title': 'Không mở được báo giá này',
  'quotation.unavailable.body':
    'Liên kết có thể đã hết hạn, hoặc sao chép chưa đủ. Xin hỏi bộ phận kinh doanh để lấy liên kết mới.',
  'quotation.unreachable.title': 'Hiện không kết nối được',
  'quotation.unreachable.body':
    'Xin thử lại. Nếu vẫn không được, hãy liên hệ bộ phận kinh doanh.',
  'quotation.retry': 'Thử lại',
  'quotation.print': 'In hoặc lưu thành PDF',
  'quotation.orderNo': 'Số',
  'quotation.revision': 'Bản',
  'quotation.submittedAt': 'Xác nhận ngày',
  'quotation.leadTime': 'Thời gian giao (ngày)',
  'quotation.net': 'Trước VAT',
  'quotation.vat': 'VAT',
  'quotation.vatIncluded': 'đã bao gồm trong giá',
  'quotation.total': 'Tổng cộng',
  'quotation.fx.rate': ({ currency, rateText }) => `Tỷ giá 1 ${currency} = ${rateText} THB`,
  'quotation.fx.observedAt': ({ observedAt }) => `Tỷ giá ngày ${observedAt}`,
  'quotation.fx.manual': 'Tỷ giá do công ty ấn định',
  'quotation.fx.settlementNote': ({ currency }) => `Số tiền ${currency} ở trên là giá tham chiếu. Thanh toán được thực hiện bằng baht Thái, theo số tiền dưới đây.`,
  'quotation.fx.payable': 'Số tiền phải trả',
  'quotation.fx.deposit': 'Tiền đặt cọc trả trước',
  'quotation.lineNo': 'STT',
  'quotation.item': 'Hạng mục',
  'quotation.qty': 'SL',
  'quotation.amount': 'Thành tiền',
  'quotation.charges': 'Chi phí khác',
  'quotation.pinnedNotice':
    'Tài liệu này đã được chốt vào ngày xác nhận — các con số và ngôn ngữ của nó không đổi khi mở lại.',
  'quotation.degraded':
    'Ngôn ngữ đã chốt không có trong phiên bản này, nên tài liệu hiển thị bằng tiếng Thái.',
  'quotation.contact': 'Kính gửi',
  'quotation.seller.phone': 'Điện thoại',
  'quotation.seller.taxId': 'Mã số thuế',

  'orderActions.heading': 'Quản lý đơn hàng này',
  'orderActions.object.title': 'Yêu cầu thay đổi',
  'orderActions.object.body':
    'Nếu có gì chưa đúng, hãy gửi yêu cầu thay đổi trước. Đơn hàng sẽ chưa vào sản xuất cho đến khi nhân viên của chúng tôi phản hồi, và không khoản nào bị trừ.',
  'orderActions.object.noteLabel': 'Nội dung cần thay đổi',
  'orderActions.object.notePlaceholder': 'Ví dụ: đổi sang màu đen, hoặc giảm chiều rộng 10 cm.',
  'orderActions.object.submit': 'Gửi yêu cầu',
  'orderActions.object.sending': 'Đang gửi…',
  'orderActions.object.sent': 'Đã gửi yêu cầu thay đổi. Bộ phận bán hàng sẽ liên hệ với bạn.',
  'orderActions.object.open': ({ openedAt }) => `Một yêu cầu thay đổi đang chờ phản hồi, gửi ngày ${openedAt}`,
  'orderActions.object.openBody':
    'Đơn hàng này sẽ chưa vào sản xuất cho đến khi có phản hồi. Nếu bạn gửi nhầm, bạn có thể rút lại.',
  'orderActions.object.withdraw': 'Rút lại yêu cầu',
  'orderActions.object.withdrawing': 'Đang rút lại…',
  'orderActions.object.withdrawn': 'Đã rút lại yêu cầu thay đổi.',
  'orderActions.cancel.title': 'Huỷ đơn hàng này',
  'orderActions.cancel.body': 'Việc huỷ không thể hoàn tác. Muốn đặt lại thì phải mở một báo giá mới.',
  'orderActions.cancel.start': 'Yêu cầu huỷ đơn hàng',
  'orderActions.cancel.preFreezeNote': 'Đơn hàng này chưa vào sản xuất. Chưa có gì được làm theo thiết kế của bạn.',
  'orderActions.cancel.postFreezeNote':
    '⚠️ Đơn hàng này đã vào sản xuất — xưởng đã bắt đầu làm theo thiết kế của bạn. Huỷ lúc này sẽ bị giữ lại một khoản, theo chính sách đã thống nhất khi ký hợp đồng.',
  'orderActions.cancel.pricing': 'Đang tính số tiền…',
  'orderActions.cancel.held': ({ heldMinor }, f) => `Chúng tôi đang giữ ${f.bahtExact(heldMinor)}`,
  'orderActions.cancel.forfeit': ({ forfeitMinor }, f) => `Sẽ bị giữ lại ${f.bahtExact(forfeitMinor)}`,
  'orderActions.cancel.refund': ({ refundMinor }, f) => `Sẽ được hoàn lại ${f.bahtExact(refundMinor)}`,
  'orderActions.cancel.freeCancellation': 'Bạn có thể huỷ mà không bị giữ lại khoản nào — hoàn lại toàn bộ.',
  'orderActions.cancel.noMoney': 'Chưa nhận được khoản thanh toán nào, nên không có gì để giữ lại hay hoàn lại.',
  'orderActions.cancel.reasonLabel': 'Lý do huỷ',
  'orderActions.cancel.reasonPlaceholder': 'Ví dụ: đổi ý, hoặc dự án bị hoãn.',
  'orderActions.cancel.confirm': 'Xác nhận huỷ',
  'orderActions.cancel.cancelling': 'Đang huỷ…',
  'orderActions.cancel.keep': 'Không huỷ',
  'orderActions.cancel.done': 'Đơn hàng này đã được huỷ.',
  'orderActions.problem.unconfigured': 'Trang web chưa được cấu hình đầy đủ. Vui lòng liên hệ bộ phận bán hàng.',
  'orderActions.problem.unreachable': 'Không kết nối được với hệ thống. Vui lòng thử lại.',
  'orderActions.problem.unauthorized': 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.',
  'orderActions.problem.refused': 'Không thể thực hiện điều đó.',
  'orderActions.problem.malformed': 'Không đọc được phản hồi từ hệ thống. Vui lòng thử lại.',

  /* ---- Display settings ---------------------------------------------------- */
  'settings.nav': 'Hiển thị',
  'settings.heading': 'Cài đặt hiển thị',
  'settings.intro':
    'Chọn cách trang này hiển thị với bạn: ngôn ngữ và đơn vị đo. Cả hai chỉ liên quan tới cách trình bày — số đo bạn nhập và giá chúng tôi tính không thay đổi theo chúng. Tiền tệ không chọn được ở trang này; lý do ở bên dưới.',
  'settings.meta.title': 'Cài đặt hiển thị',

  'settings.language.legend': 'Ngôn ngữ của trang này',
  'settings.language.accountDiffers': (p) =>
    `Tài khoản của bạn đang đặt là ${p.language}.`,
  'settings.language.applyAccount': 'Dùng ngôn ngữ tài khoản trên thiết bị này',
  'settings.unit.legend': 'Kích thước hiển thị theo',
  'settings.currency.legend': 'Tiền tệ hiển thị giá',
  'settings.currency.fixed': (p) => `Luôn là ${p.currency}, ở mọi ngôn ngữ`,
  'settings.currency.why':
    'Mọi mức giá đều được tính và lưu bằng baht Thái, và các trang sản phẩm được dựng một lần rồi dùng chung cho mọi khách truy cập, nên không thể áp tiền tệ riêng cho từng người. Báo giá thì khác: với điểm đến mà chúng tôi đã đặt báo giá bằng tiền tệ khác, báo giá được phát hành bằng tiền tệ đó theo tỷ giá ghim trên chứng từ, và thanh toán bằng baht.',

  'settings.storage.local': 'Chỉ lưu trong trình duyệt này',
  'settings.storage.account': (p, f) => `Đã lưu vào tài khoản của bạn ngày ${f.date(p.at)}`,
  'settings.storage.signIn':
    'Đăng nhập để mang các cài đặt này sang những thiết bị khác của bạn.',
  'settings.storage.saving': 'Đang lưu',
  'settings.storage.failed':
    'Không lưu được vào tài khoản. Lựa chọn vẫn có hiệu lực trong trình duyệt này.',
  'settings.storage.forget': 'Xoá các cài đặt đã lưu vào tài khoản của tôi',

  'settings.messages.heading': 'Ngôn ngữ chúng tôi dùng khi viết cho bạn',
  'settings.messages.degraded': (p) =>
    `${p.chosen} chưa được dịch, nên tin nhắn từ chúng tôi sẽ đến bằng ${p.rendered}.`,
  'settings.messages.coverage': (p, f) =>
    `Đã dịch ${f.plain(p.translated)} trên ${f.plain(p.total)} thông điệp`,

  'settings.effects.heading': 'Những cài đặt này thay đổi điều gì',
  'settings.effects.intro':
    'Danh sách này đến từ máy chủ chứ không phải từ trang này, và nó nêu rõ cả những cài đặt chưa có tác dụng thay vì để bạn tự phát hiện.',
  'settings.effect.locale.notification': 'Ngôn ngữ của email chúng tôi gửi bạn',
  'settings.effect.locale.document': 'Ngôn ngữ của báo giá và hoá đơn đã phát hành',
  'settings.effect.locale.storefront': 'Ngôn ngữ của trang này',
  'settings.effect.locale.dashboard': 'Ngôn ngữ của bảng điều khiển nội bộ',
  'settings.effect.currency.notification': 'Tiền tệ trong email chúng tôi gửi bạn',
  'settings.effect.currency.document': 'Tiền tệ trên các chứng từ đã phát hành',
  'settings.effect.currency.storefront': 'Tiền tệ của giá trên trang này',
  'settings.effect.currency.dashboard': 'Tiền tệ trong bảng điều khiển nội bộ',
  'settings.effect.lengthUnit.notification': 'Đơn vị trong email chúng tôi gửi bạn',
  'settings.effect.lengthUnit.document': 'Đơn vị trên các chứng từ đã phát hành',
  'settings.effect.lengthUnit.storefront': 'Đơn vị hiển thị kích thước trên trang này',
  'settings.effect.lengthUnit.dashboard': 'Đơn vị trong bảng điều khiển nội bộ',
  'settings.effect.yes': 'Có hiệu lực',
  'settings.effect.no': 'Chưa có hiệu lực',

  /* ---- Not found ----------------------------------------------------------- */
  'notFound.title': 'Không tìm thấy trang',
  'notFound.body':
    'Liên kết có thể đã thay đổi. Hãy bắt đầu lại từ danh sách sản phẩm.',

  /* ---- Paying, and attaching a slip ---------------------------------- */
  'payment.action': 'Thanh toán',
  'payment.meta.title': 'Báo cho chúng tôi biết bạn đã thanh toán',
  'payment.heading': 'Báo cho chúng tôi biết bạn đã thanh toán',
  'payment.loading': 'Đang mở thông tin thanh toán của bạn…',
  'payment.outstanding': 'Tổng số tiền còn thiếu',
  'payment.dueNow': 'Cần thanh toán bây giờ',
  'payment.outstandingAmount': (p, f) => f.bahtExact(p.owedMinor),
  'payment.settled': 'Đơn hàng này đã thanh toán đủ',
  'payment.closed':
    'Đơn hàng này không còn nhận thanh toán nữa. Nếu bạn có thắc mắc về số tiền, vui lòng liên hệ bộ phận kinh doanh.',
  'payment.closedOwing':
    'Vẫn còn số tiền chưa thanh toán, nhưng bạn không thể gửi thanh toán tại đây nữa. Vui lòng liên hệ bộ phận kinh doanh để thanh toán phần còn lại.',
  'payment.account.legend': 'Chuyển vào một trong các tài khoản sau',
  'payment.account.copy': (p) => `Sao chép số tài khoản ${p.accountDigits}`,
  'payment.account.copied': 'Đã sao chép số tài khoản',
  'payment.account.qrAlt': 'Mã QR PromptPay cho số tiền đã nhập',
  'payment.account.qrHint': 'Quét bằng ứng dụng ngân hàng của bạn — số tiền sẽ được điền sẵn',
  'payment.account.none':
    'Chưa có tài khoản nhận tiền nào được thiết lập. Vui lòng liên hệ bộ phận kinh doanh để biết thông tin thanh toán.',
  'payment.form.legend': 'Đính kèm biên nhận chuyển khoản',
  'payment.form.image': 'Ảnh biên nhận',
  'payment.form.imageChoose': 'Chọn ảnh biên nhận',
  'payment.form.imageChange': 'Đổi ảnh',
  'payment.form.imageHint': 'Ảnh chụp màn hình từ ứng dụng ngân hàng cũng được. Tối đa 8 MB.',
  'payment.form.amount': 'Số tiền đã chuyển',
  'payment.form.transferredAt': 'Ngày và giờ chuyển khoản',
  'payment.form.reference': 'Số tham chiếu (không bắt buộc)',
  'payment.form.submit': 'Gửi biên nhận',
  'payment.phase.uploading': 'Đang tải ảnh lên…',
  'payment.phase.creating': 'Đang lưu biên nhận…',
  'payment.done':
    'Chúng tôi đã nhận được biên nhận của bạn. Đội ngũ sẽ kiểm tra và phản hồi lại bạn.',
  'payment.history.heading': 'Các biên nhận bạn đã gửi',
  'payment.history.empty': 'Chưa gửi biên nhận nào',
  'payment.history.submitted': (p, f) => `${f.bahtExact(p.slipMinor)} · gửi ${f.date(p.sentAt)} · đang được kiểm tra`,
  'payment.history.accepted': (p, f) => `${f.bahtExact(p.slipMinor)} · gửi ${f.date(p.sentAt)} · đã được chấp nhận`,
  'payment.history.rejected': (p, f) => `${f.bahtExact(p.slipMinor)} · không được chấp nhận — ${p.reason}`,
  'payment.problem.noImage': 'Vui lòng đính kèm một tấm ảnh biên nhận.',
  'payment.problem.imageTooBig': (p, f) =>
    `Tấm ảnh này quá lớn — tối đa ${f.plain(p.limitMib)} MB.`,
  'payment.problem.badAmount': 'Nhập số tiền dưới dạng số, tối đa hai chữ số thập phân.',
  'payment.problem.badTime': 'Vui lòng cho biết ngày và giờ chuyển khoản.',
  'payment.problem.signInAgain':
    'Phiên đăng nhập của bạn đã hết hạn. Vui lòng đăng nhập lại — thông tin bạn đã nhập vẫn còn ở đây.',
  'payment.problem.unreachable': 'Không thể kết nối. Vui lòng thử lại.',
};
