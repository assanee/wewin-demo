import type { PartialUiCatalogue } from '../keys';

/**
 * Chinese, simplified (简体中文) — complete.
 *
 * ⚠️ **This file used to say "empty on purpose".** That note argued a plausible sentence
 * nobody in the company can read back is worse than a visible fallback, and it still holds
 * for *content* — product names, rule messages, the catalogue — which is why `content.ts`
 * still routes those through `ContentRef`. What changed is that the UI shell, a closed set
 * of 346 keys, was translated on request and is treated as shipped.
 *
 * ── What this catalogue gets right that German cannot ────────────────────────
 *
 *   - **No plural agreement, but measure words instead.** There is no `count` helper here
 *     and there must not be one: 件 for items, 款 for designs, 张 for photos, 条 for
 *     reviews. The classifier is not optional and it is not the same word each time, which
 *     is a distinction neither Thai nor English forces a key to expose.
 *   - **No space around the interpunct.** `·` sits tight against Han text; the Latin
 *     catalogues space it. Same character, different typesetting.
 *   - **增值税, not VAT**, and it follows the number: `7% 增值税`.
 *   - **Units stay Latin.** `m²`, `mm`, `cm` are written as-is in Chinese technical prose —
 *     translating them to 平方米 in a table column would be wrong, though the prose uses it.
 *
 * ⚠️ `f.entry` / `f.entryRange` stay ASCII here as everywhere: they label a field the
 * customer types back into, and `parseMeasure` accepts one separator. A helper line the
 * field beneath it cannot obey is worse than none.
 */
export const zh: PartialUiCatalogue = {
  /* ---- Shell and navigation ---------------------------------------- */
  'a11y.skipToContent': '跳至主要内容',
  'nav.mainLabel': '主菜单',
  'nav.homeLabel': (p) => `${p.wordmark} 首页`,
  'nav.products': '产品',
  'nav.about': '关于我们',
  'nav.quote': '报价清单',
  'nav.allProducts': '查看全部产品',
  'nav.backToProducts': '返回全部产品',
  'nav.addMore': '再添加一件产品',
  'quote.badge.filled': (p, f) => `报价清单中有 ${f.integer(p.count)} 件`,
  'quote.badge.empty': '报价清单为空',

  /* ---- Money and measurement ---------------------------------------- */
  'price.perSqmSuffix': '/ m²',
  'price.from': '起价',
  'price.fromShort': '起',
  'price.unit': '单价',
  'price.total': '小计',
  'price.grandTotal': '总计',
  'price.perPiece': (p, f) => `每件 ${f.baht(p.minor)}`,
  'value.unknown': '—',
  'unit.sqmSuffix': 'm²',
  'count.pieces': (p, f) => `${f.integer(p.count)} 件`,
  'count.items': (p, f) => `${f.integer(p.count)} 项`,
  'count.designs': (p, f) => `${f.integer(p.count)} 款`,
  'leadTime.range': (p, f) => `${f.integer(p.days[0])}–${f.integer(p.days[1])} 天`,
  'leadTime.produce': (p, f) => `制作需 ${f.integer(p.days[0])}–${f.integer(p.days[1])} 天`,

  /* ---- Pickers ------------------------------------------------------ */
  'unit.pickerLabel': '单位',
  'unit.groupLabel': '尺寸显示单位',
  'unit.name.mm': '毫米',
  'unit.name.cm': '厘米',
  'unit.name.m': '米',
  'unit.name.in': '英寸',
  'unit.name.ft': '英尺',
  'locale.pickerLabel': '语言',
  'locale.groupLabel': '本网站显示的语言',
  'locale.partial': '部分文字尚未翻译，将以泰文显示。',

  /* ---- Home --------------------------------------------------------- */
  'home.hero.line1': '按您的洞口尺寸定制',
  'home.hero.line2': '打电话之前先看到价格',
  'home.hero.body':
    '铝合金门窗与百叶。输入洞口的实际宽度和高度，立即看到完整价格——无需注册，也不必先留电话。',
  'home.hero.cta': '浏览产品并计算价格',
  'home.fact.designs': '可选款式',
  'home.fact.startingPrice': '起价',
  'home.fact.leadTime': '制作周期',
  'home.how.heading': '流程说明',
  'home.how.body': '定制类工程中，先自行看到价格再联系厂家仍然少见。接下来会是这样。',
  'home.step.measure.title': '测量洞口并输入尺寸',
  'home.step.measure.body': '选择您需要的款式，然后输入洞口的实际宽 × 高。',
  'home.step.price.title': '立即看到价格',
  'home.step.price.body': '完整价格随即显示，构成价格的每一项都单独列出。',
  'home.step.request.title': '索取报价单',
  'home.step.request.body': '把您感兴趣的产品收集起来发给我们。此阶段不产生任何约束。',
  'home.step.survey.title': '生产前现场复尺',
  'home.step.survey.body': (p, f) =>
    `我们的团队会到现场复尺，在开工前确认尺寸与价格。${
      p.days === null
        ? ''
        : `视款式不同，生产需 ${f.integer(p.days[0])}–${f.integer(p.days[1])} 天。`
    }`,
  'home.estimate.note':
    '本网站的价格是根据您输入的尺寸估算的。最终价格以我们团队现场复尺后确认为准。',
  'home.estimate.emphasis': '根据您输入的尺寸估算的',
  'home.categories.heading': '按工程类型选择',
  'home.category.empty': '此分类下暂无产品',
  'home.pricing.heading': '价格是如何算出来的',
  'home.pricing.body': '这三点写在这里，是因为您应当在输入尺寸之前就知道，而不是看到总额时才知道。',
  'home.pricing.formula.title': '计算公式',
  'home.pricing.formula.body': '价格 = 每平方米单价 × 计费面积 + 选配项',
  'home.pricing.formula.note':
    '选配项包括型材颜色、玻璃颜色与厚度，以及您加装的五金件。每一项都在价格页面上单独列出。',
  'home.pricing.floor.title': '最低计费面积',
  'home.pricing.floor.body': '小于最低面积的扇，按最低面积计费。',
  'home.pricing.floor.range': (p, f) =>
    p.span === null ? '—' : `${f.area(p.span[0])}–${f.area(p.span[1])} m²`,
  'home.pricing.floor.note': '视款式而定。价格页面始终注明您所选款式的最低面积。',
  'home.pricing.excluded.title': '此价格不包含',
  'home.pricing.excluded.install': '安装',
  'home.pricing.excluded.delivery': '运输',
  'home.pricing.excluded.removal': '拆除旧件',
  'home.pricing.excluded.note':
    '这三项都取决于现场情况，无法仅凭尺寸估算。它们会在复尺之后出现在报价单上。',

  'meta.title': 'WEWIN180 — 按尺寸定制，询价前先看到价格',
  'meta.description':
    'WEWIN180 — 按您自己的尺寸定制门窗与百叶。在索取报价单之前，先自行算出价格。',

  /* ---- Catalogue ---------------------------------------------------- */
  'catalog.heading': '全部产品',
  'catalog.resultCount': (p, f) => `${f.integer(p.count)} 款产品`,
  'catalog.empty.title': '目前没有符合这些筛选条件的产品',
  'catalog.empty.body': '试着去掉一两个筛选条件，再看看全部产品。',
  'filter.title': '筛选',
  'filter.clear': '清除筛选',
  'filter.showResults': (p, f) => `显示结果（${f.integer(p.count)} 款）`,
  'filter.section.category': '分类',
  'filter.section.profileColor': '型材颜色',
  'filter.section.pricePerSqm': '每平方米单价',
  'filter.priceTo': '至',
  'filter.priceMax': '不超过',
  'product.colorCount': (p, f) => `${f.integer(p.count)} 种型材颜色`,
  'product.sizeRange': (p, f) => `尺寸 ${f.range(p.minUm, p.maxUm, p.unit)}`,

  /* ---- Configurator -------------------------------------------------- */
  'configure.loadingLine': '正在载入此项…',
  'configure.spec.note': '详细规格、执行标准与保修条款，请通过下方联系方式向我们的团队索取。',
  'configure.view.front': '正视图',
  'configure.view.halfPanel': '半扇',
  'configure.view.transom': '上亮',
  'configure.size.heading': '尺寸',
  'configure.area.line': (p, f) =>
    `面积 ${f.area(p.areaSqUm)} m² · 最低计费 ${f.area(p.minBillableSqUm)} m²`,
  'configure.group.affectsSku': '影响产品编号',
  'configure.futureQuote': '索取报价单的功能将在下一版本加入。',
  'configure.breakdown.title': '价格明细',
  'configure.qty': '数量',
  'configure.qty.decrease': '减少一件',
  'configure.qty.increase': '增加一件',
  // Thai says `ลด${group} ${step}` as one clause; Chinese puts the object first and the
  // verb last, which is why the key carries the parts rather than a joined sentence.
  'measure.decrease': (p, f) => `将${p.group}减少 ${f.entry(p.stepUm, p.unit)}`,
  'measure.increase': (p, f) => `将${p.group}增加 ${f.entry(p.stepUm, p.unit)}`,
  'measure.helper': (p, f) =>
    `${f.entryRange(p.minUm, p.maxUm, p.unit)} · 每级 ${f.entry(p.gridUm, p.unit)}`,

  /* ---- Drawings ------------------------------------------------------- */
  'drawing.schematic': '比例示意图',
  'drawing.schematic.sized': (p) => `比例示意图，${p.size}`,
  'drawing.elevation': (p) =>
    `立面图，${p.width} × ${p.height} ${p.unit}${p.invalid ? ' — 此尺寸超出可制作范围' : ''}`,
  'drawing.unitNote': (p) => `单位：${p.unit}`,

  /* ---- Toolbar, share, QR -------------------------------------------- */
  'toolbar.groupLabel': '管理此配置',
  'toolbar.undo': '撤销',
  'toolbar.redo': '重做',
  'toolbar.reset': '恢复默认',
  'toolbar.share': '分享此配置的链接',
  'toolbar.qr': '为此链接生成二维码',
  'share.sheet.title': '分享链接',
  'share.qr.title': '此链接的二维码',
  'share.body':
    '此链接会打开配置页，尺寸和选配项与您当前看到的完全一致。可以发给您的安装师傅或家里人。',
  'share.copyLink': '复制链接',
  'share.copied': '链接已复制',
  'share.showQr': '显示为二维码',
  'qr.alt': '此配置链接的二维码',
  'qr.failed': '二维码生成失败。请改用复制链接按钮。',

  /* ---- Price summary and breakdown ------------------------------------ */
  'summary.label': '价格汇总',
  'summary.skuCode': '产品编号',
  'summary.copySku': (p) => `复制产品编号 ${p.skuCode}`,
  'summary.skuCopied': '产品编号已复制',
  'summary.add': '加入报价清单',
  'summary.hasErrors': '上方还有需要修改的地方。点击按钮查看是哪一项。',
  'summary.showBreakdown': '查看价格明细',
  'summary.area': (p, f) => `${f.area(p.areaSqUm)} m²`,
  'summary.stickyMeta': (p, f) =>
    `${f.area(p.areaSqUm)} m²${p.qty > 1 ? ` · ${f.integer(p.qty)} 件` : ''} · 查看明细`,
  'breakdown.minimumApplied': (p, f) =>
    `实际面积 ${f.area(p.areaSqUm)} m² · 按最低面积 ${f.area(p.minBillableSqUm)} m² 计费`,

  /* ---- Quote ---------------------------------------------------------- */
  'quote.heading': '报价清单',
  'quote.empty.title': '报价清单中还没有内容',
  'quote.empty.body': '选择一款产品，输入洞口的实际尺寸，然后添加到这里。',
  'quote.empty.cta': '选择产品',
  'quote.summary.label': '合计',
  'quote.summary.lineCount': '项目',
  'quote.summary.lineCountValue': (p, f) =>
    `${f.integer(p.lines)} 项 · ${f.integer(p.pieces)} 件`,
  'quote.summary.leadTime': '制作周期',
  'quote.tableCaption': '报价清单中的项目',
  'quote.col.name': '项目',
  'quote.col.sku': '产品编号',
  'quote.col.size': '尺寸',
  'quote.col.qty': '数量',
  'quote.col.unitPrice': '单价',
  'quote.col.total': '小计',
  'quote.col.actions': '操作',
  'quote.action.edit': (p) => `修改${p.nickname}的配置`,
  'quote.action.duplicate': (p) => `复制${p.nickname}`,
  'quote.action.remove': (p) => `移除${p.nickname}`,
  'quote.qty.label': (p) => `${p.nickname}的数量`,
  'quote.qty.decrease': (p) => `${p.nickname}减少一件`,
  'quote.qty.increase': (p) => `${p.nickname}增加一件`,

  /* ---- Toasts and sheets ----------------------------------------------- */
  'toast.lineSaved': '修改已保存',
  'toast.lineAdded': '已加入报价清单',
  'toast.viewQuote': '查看报价清单',
  'toast.dismiss': '关闭提示',
  'sheet.close': '关闭',
  'sheet.closeNamed': (p) => `关闭${p.title}`,

  /* ---- About ------------------------------------------------------------ */
  'about.heading': '关于我们',
  'about.intro': '我们按现场实际尺寸制作铝合金门窗。工厂位于彭世洛府。',
  'about.tool':
    '本网站是我们自己的报价工具。输入洞口的宽度和高度，即可立即看到完整价格，无需先联系任何人。',
  'about.stance.heading': '我们为什么公开价格',
  'about.stance.noPhone.title': '问个价，不该以留下电话为代价',
  'about.stance.noPhone.body':
    '多数定制类工程会先要电话号码才肯报价，只想了解个大概预算的人也不得不接受随之而来的电话。这一步我们去掉了。',
  'about.stance.itemised.title': '价格应当说明它是怎么来的',
  'about.stance.itemised.body':
    '价格页面列出构成总额的每一项——面积、颜色、玻璃与五金。数字变了，您能看出是什么变了。',
  'about.stance.limits.title': '限制事先说明，而不是事后才提',
  'about.stance.limits.body':
    '最低计费面积、我们做不了的尺寸，以及价格不含哪些内容，都在您输入尺寸之前写在网站上，而不是在交谈过程中才冒出来。',
  'about.range.heading': '我们做什么',
  'about.range.body': '这里的每一个数字都来自计算价格所用的同一套目录，没有一项是另行维护的。',
  'about.fact.designs.note': (p, f) => `分属 ${f.integer(p.categories)} 个分类`,
  'about.fact.leadTime.note': '视款式而定',
  'about.fact.floor': '最低计费面积',
  'about.fact.floor.note': '小于此面积的扇按最低面积计费',
  'about.fact.legalName': '注册名称',
  'about.fact.makes': '我们做什么',
  'about.fact.serviceArea': '配送范围',
  'about.contact.heading': '我们在哪里，以及如何联系',
  'about.card.factory': '工厂与办公室',
  'about.card.delivery': '运输与安装',
  'about.card.delivery.note':
    '本网站的价格不含安装与运输，因为这取决于现场情况和距离。我们的团队会在报价单中估算。',
  'about.card.hours': '营业时间',
  'about.card.hours.note':
    '非营业时间，请通过 LINE 或电子邮件留言，我们的团队将在下一个工作日回复。',

  /* ---- Footer ------------------------------------------------------------ */
  'footer.contact': '联系我们',
  'footer.hours': '营业时间',
  'footer.serviceArea': '服务范围',
  'footer.menu': '菜单',
  // Gregorian, from the same param Thai renders as พ.ศ. No arithmetic here.
  'footer.copyright': (p, f) => `© ${f.year(p.year)}`,

  /* ---- Contact channels and the spec sheet -------------------------------- */
  'contact.phone': '电话',
  'contact.line': 'LINE',
  'contact.email': '电子邮件',
  'spec.material': '材质',
  'spec.material.value': '铝合金挤压型材',
  'spec.profileThickness': '型材壁厚',
  'spec.standards': '符合标准',
  'spec.warranty': '保修',

  /* ---- Reviews ------------------------------------------------------------- */
  'review.heading': '已安装客户的评价',
  'review.summary': (p, f) =>
    `${f.rating(p.ratingSum, p.ratingCount)} 分（满分 5 分）· ${f.integer(p.ratingCount)} 条评价`,
  'review.hiddenNote': (p, f) =>
    `有 ${f.integer(p.hidden)} 条评价因违反评价规则而被隐藏——这些评分仍计入上方的平均分`,
  'review.publishedOn': (p, f) => `发表于 ${f.date(p.at)}`,
  'review.author.anonymous': '客户',
  'review.size': (p, f) => `订购尺寸 ${f.dimensions(p.widthUm, p.heightUm, p.unit)}`,
  'review.erased': '这条评价的正文与姓名已应作者要求删除。评分仍然计入。',
  'review.reply.heading': 'WEWIN180 的回复',
  'review.reply.on': (p, f) => `回复于 ${f.date(p.at)}`,
  'review.photo.alt': (p, f) => `客户照片 ${f.integer(p.index)}`,
  'review.more': (p, f) => `还有 ${f.integer(p.remaining)} 条评价`,

  'review.form.heading': '写评价',
  'review.form.for': (p) => `评价 ${p.name}`,
  'review.form.intro':
    '铝合金要经过一个雨季才看得出好坏，而不是装完三天——您什么时候准备好都可以写。此入口不会关闭。',
  'review.form.rating.legend': '打几颗星',
  'review.form.rating.option': (p, f) => `${f.integer(p.stars)} 星`,
  'review.form.rating.required': '发送前请先选择星级',
  'review.form.body.label': '说说使用感受（选填）',
  'review.form.body.help': '请不要写入地址、电话号码或他人信息——这是一个公开页面。',
  'review.form.name.label': '显示的名字（选填）',
  'review.form.name.help': '会显示在您的评价旁边。写首字母可以，留空也可以。',
  'review.form.submit': '发送评价',
  'review.form.submitting': '正在发送…',
  'review.form.moderation': '您的评价将在我们阅读后显示在产品页面上，或在评价期结束后自动显示。',
  'review.form.loading': '正在打开您的邀请…',
  'review.form.invalid.title': '此链接无法使用',
  'review.form.invalid.body': '可能已被使用过，或复制得不完整。请再从邀请邮件中打开一次。',
  'review.form.failed.title': '评价未能发送',
  'review.form.failed.body': '请重试。如果仍然失败，请直接回复邀请邮件。',
  'review.form.done.title': '谢谢——我们已收到您的评价',
  'review.form.done.body': '待阅读后，或评价期结束时，它会显示在产品页面上。',
  'review.meta.title': '写评价',

  'account.title': '我的账户',
  'account.password.section': '修改密码',
  'account.password.current': '当前密码',
  'account.password.new': '新密码',
  'account.password.confirm': '确认新密码',
  'account.password.action': '修改密码',
  'account.password.saving': '正在修改…',
  'account.password.done': '密码已修改',
  'account.password.doneOthers': '密码已修改——您其他设备上的登录已退出。',
  'account.password.note': '修改后，您在其他设备上的登录都会退出。当前这台不受影响。',
  'account.password.problem.currentMissing': '请输入当前密码。',
  'account.password.problem.tooShort': '新密码太短——至少 12 个字符。',
  'account.password.problem.sameAsCurrent': '新密码必须与当前密码不同。',
  'account.password.problem.mismatch': '新密码与确认密码不一致。',
  'account.checking': '正在检查…',
  'account.needAccount': '登录后即可索取报价单',
  'account.whyAccount':
    '这样报价单就归属于您的账户，在任何设备上都能打开——注册只需一个电话号码和一个密码。',
  'account.register': '创建账户',
  'account.signIn': '登录',
  'account.haveAccount': '已经有账户了？',
  'account.noAccount': '还没有账户？',
  'account.phone': '电话',
  'account.username': '电话号码或电子邮件',
  'account.usernameHint': '您注册时使用的号码；如果您已有账户，也可以用电子邮件。',
  'account.password': '密码',
  'account.passwordHint': '至少 12 个字符。',
  'account.signedInAs': '已登录',
  'account.signOut': '退出登录',
  'account.problem.badPhone': '无法识别此电话号码——例如 081-234-5678。',
  'account.problem.passwordTooShort': '此密码太短——至少 12 个字符。',
  'account.problem.unreachable': '无法连接，请重试。',
  'account.problem.unconfigured': '暂时无法使用，请联系销售团队。',
  'account.myQuotations': '我的报价单',
  'account.noQuotations': '还没有报价单',

  'submit.heading': '索取报价单',
  'submit.intro':
    '留下称呼和一种联系方式，我们会立即出具报价单——价格与各项内容将完全按照此清单当前的状态固定下来。',
  'submit.name': '联系人',
  'submit.namePlaceholder': '姓名全称',
  'submit.email': '电子邮件',
  'submit.phone': '电话',
  'submit.channelHint': '两者至少填一项——只填电话号码也可以。',
  'submit.destination': '目的地',
  'submit.action': '索取报价单',
  'submit.sending': '正在出具报价单…',
  'submit.problem.nameMissing': '请填写联系人。',
  'submit.problem.noChannel': '请填写电子邮件或电话号码。',
  'submit.problem.badPhone': '无法识别此电话号码——例如 081-234-5678。',
  'submit.problem.badEmail': '无法识别此电子邮件地址。',
  'submit.problem.badDestination': '请重新选择目的地——之前的选项已不在列表中。',
  'submit.problem.unreachable': '无法连接，请重试。',
  'submit.problem.unconfigured': '暂时无法受理，请联系销售团队。',
  'submit.problem.unavailable': '清单中有产品已不再供应。请移除该项后重试。',
  'submit.done': '您的报价单已生成',
  'submit.viewQuotation': '打开报价单',

  'quotation.meta.title': '您的报价单',
  'quotation.loading': '正在打开您的报价单…',
  'quotation.heading': '报价单',
  'quotation.unavailable.title': '此报价单无法打开',
  'quotation.unavailable.body': '链接可能已过期，或复制得不完整。请向销售团队索取新的链接。',
  'quotation.unreachable.title': '当前无法连接',
  'quotation.unreachable.body': '请重试。如果持续失败，请联系销售团队。',
  'quotation.retry': '重试',
  'quotation.print': '打印或保存为 PDF',
  'quotation.orderNo': '编号',
  'quotation.revision': '版次',
  'quotation.submittedAt': '确认日期',
  'quotation.leadTime': '交期（天）',
  'quotation.net': '税前金额',
  'quotation.vat': '增值税',
  'quotation.vatIncluded': '已含在价格中',
  'quotation.total': '总计',
  'quotation.fx.rate': ({ currency, rateText }) => `汇率 1 ${currency} = ${rateText} 泰铢`,
  'quotation.fx.observedAt': ({ observedAt }) => `汇率日期 ${observedAt}`,
  'quotation.fx.manual': '公司指定汇率',
  'quotation.fx.settlementNote': ({ currency }) => `以上 ${currency} 金额为参考价格。实际付款以泰铢结算，金额如下。`,
  'quotation.fx.payable': '应付金额',
  'quotation.fx.deposit': '需先支付的订金',
  'quotation.lineNo': '序号',
  'quotation.item': '项目',
  'quotation.qty': '数量',
  'quotation.amount': '金额',
  'quotation.charges': '其他费用',
  'quotation.pinnedNotice': '本文件已于确认当日固定——重新打开时，其金额与语言都不会改变。',
  'quotation.degraded': '固定的语言在本版本中不可用，因此以泰文显示。',
  'quotation.contact': '致',
  'quotation.seller.phone': '电话',
  'quotation.seller.taxId': '税号',

  /* ---- Display settings ---------------------------------------------------- */
  'settings.nav': '显示',
  'settings.heading': '显示设置',
  'settings.intro':
    '选择本网站呈现给您的方式：语言、计量单位与货币。这三项只影响显示——您输入的尺寸和我们计算的价格不会因此改变。',
  'settings.meta.title': '显示设置',

  'settings.language.legend': '本网站使用的语言',
  'settings.language.accountDiffers': (p) => `您的账户设置为${p.language}。`,
  'settings.language.applyAccount': '在此设备上使用账户语言',
  'settings.unit.legend': '尺寸显示单位',
  'settings.currency.legend': '价格显示的货币',
  'settings.currency.fixed': (p) => `始终为${p.currency}，各语言一致`,
  'settings.currency.why':
    '所有价格均以泰铢计算和存储，产品页面只生成一次并由所有访客共用，因此无法按访客切换货币。以海外客户本国货币报价是另一回事，目前尚未开放。',

  'settings.storage.local': '仅保存在此浏览器中',
  'settings.storage.account': (p, f) => `已于 ${f.date(p.at)} 保存到您的账户`,
  'settings.storage.signIn': '登录后可将这些设置同步到您的其他设备。',
  'settings.storage.saving': '正在保存',
  'settings.storage.failed': '无法保存到账户。此选择在本浏览器中仍然有效。',
  'settings.storage.forget': '删除已保存到我账户的设置',

  'settings.messages.heading': '我们与您沟通所用的语言',
  'settings.messages.degraded': (p) =>
    `${p.chosen}尚未翻译，因此我们发出的消息将以${p.rendered}送达。`,
  'settings.messages.coverage': (p, f) =>
    `已翻译 ${f.plain(p.translated)} / ${f.plain(p.total)} 条消息`,

  'settings.effects.heading': '这些设置会影响什么',
  'settings.effects.intro':
    '此列表来自服务器而非本页面，其中也标明了目前尚不生效的设置，而不是让您自己去发现。',
  'settings.effect.locale.notification': '我们发给您的邮件所用的语言',
  'settings.effect.locale.document': '已出具的报价单与发票所用的语言',
  'settings.effect.locale.storefront': '本网站的语言',
  'settings.effect.locale.dashboard': '内部管理后台的语言',
  'settings.effect.currency.notification': '我们发给您的邮件中所用的货币',
  'settings.effect.currency.document': '已出具单据上的货币',
  'settings.effect.currency.storefront': '本网站价格所用的货币',
  'settings.effect.currency.dashboard': '内部管理后台所用的货币',
  'settings.effect.lengthUnit.notification': '我们发给您的邮件中所用的单位',
  'settings.effect.lengthUnit.document': '已出具单据上的单位',
  'settings.effect.lengthUnit.storefront': '本网站尺寸显示所用的单位',
  'settings.effect.lengthUnit.dashboard': '内部管理后台所用的单位',
  'settings.effect.yes': '生效',
  'settings.effect.no': '尚未生效',

  /* ---- Not found ----------------------------------------------------------- */
  'notFound.title': '未找到该页面',
  'notFound.body': '链接可能已更改。请从产品列表重新开始。',

  /* ---- Paying, and attaching a slip ---------------------------------- */
  'payment.action': '去付款',
  'payment.meta.title': '通知一笔付款',
  'payment.heading': '通知一笔付款',
  'payment.loading': '正在打开付款信息…',
  'payment.outstanding': '尚欠金额',
  'payment.outstandingAmount': (p, f) => f.bahtExact(p.owedMinor),
  'payment.settled': '此订单已付清',
  'payment.account.legend': '转账至以下任一账户',
  'payment.account.copy': (p) => `复制账号 ${p.accountDigits}`,
  'payment.account.copied': '账号已复制',
  'payment.account.qrAlt': '对应所填金额的 PromptPay 二维码',
  'payment.account.qrHint': '用银行 App 扫描——金额会自动填入',
  'payment.account.none': '尚未设置收款账户，请联系销售团队获取付款方式。',
  'payment.form.legend': '上传付款凭证',
  'payment.form.image': '凭证照片',
  'payment.form.imageChoose': '选择凭证图片',
  'payment.form.imageChange': '更换图片',
  'payment.form.imageHint': '银行 App 的截图即可，不超过 8 MB。',
  'payment.form.amount': '转账金额',
  'payment.form.transferredAt': '转账日期与时间',
  'payment.form.reference': '备注编号（选填）',
  'payment.form.submit': '提交凭证',
  'payment.phase.uploading': '正在上传照片…',
  'payment.phase.creating': '正在保存凭证…',
  'payment.done': '已收到您的付款凭证，我们的团队会核实后与您联系。',
  'payment.history.heading': '已提交的付款凭证',
  'payment.history.empty': '尚未提交过凭证',
  'payment.history.submitted': (p, f) => `${f.bahtExact(p.slipMinor)}·${f.date(p.sentAt)}提交·待审核`,
  'payment.history.accepted': (p, f) => `${f.bahtExact(p.slipMinor)}·${f.date(p.sentAt)}提交·已确认`,
  'payment.history.rejected': (p, f) => `${f.bahtExact(p.slipMinor)}·未通过——${p.reason}`,
  'payment.problem.noImage': '请上传一张凭证照片。',
  'payment.problem.imageTooBig': (p, f) =>
    `这张照片太大——请控制在 ${f.plain(p.limitMib)} MB 以内。`,
  'payment.problem.badAmount': '请输入数字金额，小数位不超过两位。',
  'payment.problem.badTime': '请填写转账日期与时间。',
  'payment.problem.signInAgain': '您的登录已过期，请重新登录——已填写的内容仍会保留。',
  'payment.problem.unreachable': '无法连接，请重试。',
};
