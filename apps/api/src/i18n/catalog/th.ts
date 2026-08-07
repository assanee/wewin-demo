import type { Catalogue } from './types';

/**
 * Thai — the source language, and the only complete catalogue.
 *
 * ── Every sentence here was moved, not written ───────────────────────────────────
 *
 * These are the exact strings that lived in `admin/pg-errors.ts`, `orders/pg-errors.ts`,
 * `quotes/pg-errors.ts`, `payments/ledger/pg-errors.ts`, `payments/slips/slip-errors.ts`,
 * `payments/slips/allocations.ts`, `quotes/errors.ts` and `all-exceptions.filter.ts`,
 * character for character. That is deliberate and it is what makes this round *checkable*:
 * `tests/i18n/parity.test.ts` pins a sample against the literals as they were, and the
 * 1,819 existing tests — many of which assert on these sentences — are the rest of the
 * proof. A round that also improved the wording would have had no way to tell an
 * improvement from a mistranslation.
 *
 * ── What the catalogue may and may not do ────────────────────────────────────────
 *
 * A parametric entry receives `fmt`, and `fmt` is the only way to turn a value into text.
 * There is no `String()`, no `toLocaleString`, no `฿` concatenation — those all belong to
 * `../format.ts`, one per locale. The point is not tidiness: it is that whoever writes the
 * Burmese catalogue works in this same shape and *cannot* emit Western digits by accident,
 * because nothing in scope would give them any.
 *
 * ── ⚠️ Do not machine-translate the other seven ──────────────────────────────────
 *
 * Plan 13 names translation as a human bottleneck. A wrong Thai-to-Burmese sentence that
 * nobody in the building can read is worse than a visible fallback, and `catalog/index.ts`
 * is built so that a visible fallback is a supported state rather than a bug.
 */
export const TH: Catalogue = {
  /* ── Password sign-in ─────────────────────────────────────────────────────────
   *
   * "อีเมลหรือรหัสผ่านไม่ถูกต้อง" and not "ไม่พบบัญชีนี้": the sentence has to be true of
   * five different situations at once, and naming any of them would tell a stranger which
   * addresses belong to customers.
   */
  'error.auth.credentials_rejected': 'อีเมลหรือรหัสผ่านไม่ถูกต้อง',
  'error.auth.second_factor_rejected': 'รหัสยืนยันไม่ถูกต้องหรือหมดอายุแล้ว — เข้าสู่ระบบใหม่อีกครั้ง',
  'error.mfa.already_enabled': 'บัญชีนี้เปิดการยืนยันสองขั้นอยู่แล้ว — ต้องปิดก่อนจึงจะตั้งใหม่ได้',
  'error.mfa.not_enrolling': 'ยังไม่ได้เริ่มตั้งค่าการยืนยันสองขั้น',
  'error.mfa.no_recovery_path': 'ต้องมีรหัสสำรองที่ยังไม่ได้ใช้อย่างน้อยสองชุดก่อนเปิดใช้งาน',
  'error.mfa.needs_a_password': 'บัญชีนี้ยังไม่มีรหัสผ่าน — ต้องให้ผู้ดูแลระบบปิดการยืนยันสองขั้นให้',
  'error.auth.too_many_attempts': (p, f) =>
    `พยายามเข้าสู่ระบบบ่อยเกินไป กรุณารออีก ${f.count(p.minutes)} นาทีแล้วลองใหม่`,
  'error.auth.password_too_short': (p, f) =>
    `รหัสผ่านต้องยาวอย่างน้อย ${f.count(p.minimum)} ตัวอักษร`,
  'error.auth.password_too_long': (p, f) =>
    `รหัสผ่านต้องไม่เกิน ${f.count(p.maximum)} ตัวอักษร`,
  /* One sentence for unknown, spent, expired and refused — the same reason as above. */
  'error.auth.reset_token_rejected':
    'ลิงก์ตั้งรหัสผ่านใหม่นี้ใช้ไม่ได้แล้ว อาจถูกใช้ไปแล้วหรือหมดอายุ กรุณาขอลิงก์ใหม่อีกครั้ง',

  /* ── Catalogue constraints ───────────────────────────────────────────────── */
  'error.catalog.slug_taken': 'มีสินค้าที่ใช้ slug นี้อยู่แล้ว',
  'error.catalog.sku_prefix_taken': 'มีสินค้าที่ใช้รหัสนำหน้า SKU นี้อยู่แล้ว',
  'error.catalog.product_id_taken': 'มีสินค้ารหัสนี้อยู่แล้ว',
  'error.catalog.price_whole_baht': 'ราคาต่อตารางเมตรต้องเป็นจำนวนบาทเต็ม',
  'error.catalog.price_positive': 'ราคาต่อตารางเมตรต้องมากกว่าศูนย์',
  'error.catalog.lead_time_ordered': 'ระยะเวลาผลิตขั้นต่ำต้องไม่มากกว่าขั้นสูง',
  'error.catalog.min_billable_positive': 'พื้นที่คิดเงินขั้นต่ำต้องมากกว่าศูนย์',
  'error.catalog.group_code_taken': 'มีกลุ่มตัวเลือกรหัสนี้อยู่แล้ว',
  'error.catalog.sku_group_shape':
    'กลุ่มแบบ sku ต้องใช้ input เป็น swatch, chip หรือ toggle และไม่มีหน่วยวัด',
  'error.catalog.custom_group_shape':
    'กลุ่มแบบวัดขนาดต้องใช้ input เป็น number และต้องระบุหน่วยที่ใช้เขียน',
  'error.catalog.value_code_taken': 'มีตัวเลือกรหัสนี้ในกลุ่มนี้อยู่แล้ว',
  'error.catalog.delta_shape': 'ค่าส่วนเพิ่มไม่ตรงกับชนิดที่เลือก',
  'error.catalog.delta_whole_units': 'ส่วนเพิ่มต้องเป็นจำนวนบาทเต็มหรือเปอร์เซ็นต์เต็ม',
  'error.catalog.swatch_hex_format': 'รหัสสีต้องอยู่ในรูปแบบ #RRGGBB',
  'error.catalog.size_grid':
    'ช่วงขนาดไม่ลงตัวกับสเต็ป — สเต็ปต้องเป็นจำนวนเท่าของ 25 µm และ min/max/default ต้องอยู่บนกริดเดียวกัน',
  'error.catalog.version_sku_shape': 'กลุ่มแบบ sku ต้องมีค่าเริ่มต้นและต้องไม่มีช่วงขนาด',
  'error.catalog.version_custom_shape':
    'กลุ่มแบบวัดขนาดต้องมีช่วงขนาดครบและต้องไม่มีค่าเริ่มต้นแบบ sku',
  'error.catalog.rule_code_taken': 'มีกฎรหัสนี้ในร่างนี้อยู่แล้ว',
  'error.catalog.already_published': 'สินค้านี้มีเวอร์ชันที่เผยแพร่อยู่แล้ว',
  'error.catalog.version_number_taken': 'เลขเวอร์ชันนี้ถูกใช้ไปแล้ว',
  'error.catalog.duplicate': 'ข้อมูลนี้ซ้ำกับที่มีอยู่แล้ว',
  'error.catalog.missing_reference': 'อ้างถึงข้อมูลที่ไม่มีอยู่',
  'error.catalog.check_failed': 'ข้อมูลไม่ผ่านเงื่อนไขของแคตตาล็อก',
  'error.catalog.frozen': 'เวอร์ชันนี้ถูกเผยแพร่แล้วและแก้ไขไม่ได้ — สร้างร่างใหม่แทน',
  /*
   * The quotation marks are the *locale's* typography, which is why they are here and not
   * around the value at the call site. German would want „…“ and this is the file that gets
   * to decide that.
   */
  'error.catalog.product_not_found': (params, fmt) =>
    `ไม่พบสินค้ารหัส "${fmt.code(params.productId)}"`,

  /* ── Order constraints ───────────────────────────────────────────────────── */
  'error.order.change_request_already_open':
    'มีคำขอแก้ไขที่ยังไม่ได้ตอบอยู่แล้ว — ต้องปิดคำขอเดิมก่อนจึงจะเปิดใหม่ได้',
  'error.order.already_superseded': 'ออร์เดอร์นี้ถูกออกใบใหม่แทนไปแล้ว',
  'error.order.concurrent_event': 'มีการเปลี่ยนแปลงออร์เดอร์นี้พร้อมกัน — กรุณาลองใหม่อีกครั้ง',
  'error.order.order_no_taken': 'เลขที่ออร์เดอร์นี้ถูกใช้ไปแล้ว',
  'error.order.needs_an_owner': 'ออร์เดอร์ต้องมีเจ้าของเสมอ',
  'error.order.needs_a_contact_channel': 'ต้องมีอีเมลสำหรับติดต่อก่อนจึงจะส่งใบเสนอราคาได้',
  'error.order.contact_email_shape': 'รูปแบบอีเมลไม่ถูกต้อง',
  'error.order.total_does_not_foot': 'ยอดรวมไม่ตรงกับผลบวกของยอดก่อนภาษีและภาษี',
  'error.order.deposit_exceeds_total': 'ยอดมัดจำต้องไม่เกินยอดรวมของสัญญา',
  'error.order.concurrent_document': 'มีการแก้ไขใบเสนอราคาพร้อมกัน — กรุณาโหลดใหม่',
  'error.order.cannot_return_to_awaiting_payment':
    'ออร์เดอร์ที่เข้าสู่การผลิตแล้วกลับไปสถานะรอชำระเงินไม่ได้',
  'error.order.duplicate': 'ข้อมูลนี้ซ้ำกับที่มีอยู่แล้ว',
  'error.order.missing_reference': 'อ้างถึงข้อมูลที่ไม่มีอยู่',
  'error.order.check_failed': 'ข้อมูลไม่ผ่านเงื่อนไขของออร์เดอร์',
  'error.order.state_changed':
    'สถานะของออร์เดอร์เปลี่ยนไปแล้วระหว่างที่ทำรายการ — กรุณาโหลดข้อมูลใหม่แล้วลองอีกครั้ง',
  'error.order.locked': 'ออร์เดอร์นี้กำลังถูกแก้ไขอยู่ — กรุณาลองใหม่อีกครั้ง',

  /* ── Quote constraints ───────────────────────────────────────────────────── */
  'error.quote.override_already_on_line':
    'รายการนี้มีราคาที่ตกลงไว้อยู่แล้ว — ระบบกำลังแทนที่ให้ กรุณาลองใหม่อีกครั้ง',
  'error.quote.override_already_on_document':
    'ใบเสนอราคานี้มียอดรวมที่ตกลงไว้อยู่แล้ว — ระบบกำลังแทนที่ให้ กรุณาลองใหม่อีกครั้ง',
  'error.quote.concurrent_line': 'มีการเพิ่มรายการพร้อมกัน — กรุณาลองใหม่อีกครั้ง',
  'error.quote.override_equals_computed':
    'ราคาที่กรอกเท่ากับราคาที่ระบบคำนวณอยู่แล้ว — ถ้าต้องการยืนยันราคานี้ ให้ยกเลิกราคาที่ตกลงไว้เดิมแทน',
  'error.quote.override_money_negative': 'ราคาติดลบไม่ได้',
  'error.quote.override_days_negative': 'ระยะเวลาส่งมอบติดลบไม่ได้',
  'error.quote.line_charge_zero': 'รายการที่เป็นศูนย์บาทไม่มีความหมาย',
  'error.quote.line_qty_positive': 'จำนวนต้องเป็นอย่างน้อย 1',
  'error.quote.override_other_needs_a_note': 'เหตุผล "อื่นๆ" ต้องเขียนคำอธิบายกำกับด้วย',
  'error.quote.override_entry_mode_mismatch': 'ช่องที่กรอกไม่ตรงกับสิ่งที่กำลังแก้ไข',
  'error.quote.duplicate': 'ข้อมูลนี้ซ้ำกับที่มีอยู่แล้ว',
  'error.quote.missing_reference': 'อ้างถึงข้อมูลที่ไม่มีอยู่',
  'error.quote.check_failed': 'ข้อมูลไม่ผ่านเงื่อนไขของใบเสนอราคา',
  'error.quote.locked': 'ใบเสนอราคานี้กำลังถูกแก้ไขอยู่ — กรุณาลองใหม่อีกครั้ง',
  'error.quote.frozen.write_line':
    'แก้ไขใบเสนอราคานี้ไม่ได้ในสถานะปัจจุบัน — กรุณาโหลดข้อมูลใหม่แล้วลองอีกครั้ง',
  /* ⭐ Plan 7.9(ง)(2). The recovery is one deliberate act, not a retry — see quotes/pg-errors.ts. */
  'error.quote.frozen.reprice_line':
    'รายการนี้มีราคาที่ตกลงกับลูกค้าไว้แล้ว — ต้องยกเลิกหรือแก้ราคาที่ตกลงไว้ก่อนจึงจะเปลี่ยนจำนวนหรือรายละเอียดได้',
  'error.quote.frozen.remove_line':
    'รายการนี้มีราคาที่ตกลงกับลูกค้าไว้แล้ว — ต้องยกเลิกราคาที่ตกลงไว้ก่อนจึงจะลบรายการได้',
  'error.quote.frozen.write_override':
    'แก้ไขราคาในใบเสนอราคานี้ไม่ได้ในสถานะปัจจุบัน — กรุณาโหลดข้อมูลใหม่',
  'error.quote.frozen.supersede_override':
    'ราคาที่ตกลงไว้รายการนี้ถูกแก้ไขไปแล้วโดยคนอื่น — กรุณาโหลดข้อมูลใหม่แล้วลองอีกครั้ง',

  /* ── Money constraints ───────────────────────────────────────────────────── */
  'error.money.accrual_already_refunded':
    'ยอดค้างจ่ายก้อนนี้มีคำขอคืนเงินอยู่แล้ว — เงินก้อนเดียวคืนได้ครั้งเดียว',
  'error.money.approver_is_requester': 'ผู้อนุมัติต้องไม่ใช่ผู้ยื่นคำขอคืนเงิน',
  'error.money.disburser_is_approver': 'ผู้กดโอนเงินคืนต้องไม่ใช่ผู้อนุมัติ',
  'error.money.refund_amount_positive': 'ยอดคืนเงินต้องมากกว่าศูนย์',
  'error.money.refund_currency_is_thb': 'ระบบคืนเงินเป็นเงินบาทเท่านั้น',
  'error.money.refund_status_shape': 'สถานะของคำขอคืนเงินกับข้อมูลผู้อนุมัติ/ผู้โอนไม่สอดคล้องกัน',
  'error.money.payee_last4_shape': 'เลขบัญชีสี่หลักท้ายต้องเป็นตัวเลขสี่หลัก',
  'error.money.posting_amount_nonzero': 'รายการบัญชีที่เป็นศูนย์ไม่มีความหมาย',
  'error.money.entry_needs_a_slip': 'รายการบัญชีประเภทนี้ต้องอ้างอิงสลิป',
  'error.money.variance_needs_a_kind': 'รายการส่วนต่างต้องระบุประเภทของส่วนต่าง',
  'error.money.duplicate': 'รายการนี้ซ้ำกับที่มีอยู่แล้ว',
  'error.money.missing_reference': 'อ้างถึงข้อมูลที่ไม่มีอยู่',
  'error.money.check_failed': 'ข้อมูลไม่ผ่านเงื่อนไขของระบบการเงิน',
  'error.money.state_changed':
    'สถานะทางการเงินของรายการนี้เปลี่ยนไปแล้วระหว่างที่ทำรายการ — กรุณาโหลดข้อมูลใหม่แล้วตรวจสอบอีกครั้ง',
  'error.money.locked': 'รายการนี้กำลังถูกดำเนินการอยู่ — กรุณาลองใหม่อีกครั้ง',

  /* ── Slip constraints ────────────────────────────────────────────────────── */
  'error.slip.reviewer_is_submitter':
    'ผู้ตรวจสลิปต้องไม่ใช่ผู้อัปโหลดสลิปใบเดียวกัน — การตรวจด้วยคนคือมาตรการควบคุมเดียวของระบบนี้',
  'error.slip.amount_positive': 'ยอดเงินบนสลิปต้องมากกว่าศูนย์',
  'error.slip.currency_is_thb': 'ระบบรับสลิปเป็นเงินบาทเท่านั้น',
  'error.slip.review_shape': 'สถานะของสลิปกับข้อมูลผู้ตรวจไม่สอดคล้องกัน',
  'error.slip.erasure_shape': 'รูปสลิปที่ถูกลบแล้วใส่กลับไม่ได้ — ลบได้อย่างเดียว',
  'error.slip.payer_last4_shape': 'เลขท้ายบัญชีต้องเป็นตัวเลขสี่หลัก',
  'error.slip.instalment_repeated_in_slip': 'ระบุงวดเดียวกันซ้ำในสลิปใบเดียว — ให้รวมเป็นบรรทัดเดียว',
  'error.slip.allocation_amount_positive': 'ยอดที่ตัดชำระแต่ละงวดต้องมากกว่าศูนย์',
  'error.slip.posting_amount_nonzero': 'รายการบัญชีที่เป็นศูนย์ไม่มีความหมาย',
  /*
   * Same constraint name as `error.money.accrual_already_refunded`, different sentence.
   * That is the reason the key space is namespaced by domain rather than by constraint:
   * a slip reviewer and an accountant are told the same fact in their own vocabulary, and
   * flattening the two would keep whichever was registered last.
   */
  'error.slip.accrual_already_refunded': 'รายการตั้งค้างนี้ถูกอ้างถึงโดยการคืนเงินอื่นแล้ว',
  'error.slip.duplicate': 'ข้อมูลนี้ซ้ำกับที่มีอยู่แล้ว',
  'error.slip.check_failed': 'ข้อมูลไม่ผ่านเงื่อนไขของการชำระเงิน',
  'error.slip.guard_refused':
    'รายการชำระเงินนี้ไม่ผ่านการตรวจสอบของฐานข้อมูล — ' +
    'ยอดที่ตัดชำระต้องเท่ากับยอดบนสลิปพอดี และตารางงวดอาจถูกแก้ไขระหว่างที่คุณกำลังตรวจ กรุณาโหลดใหม่แล้วตรวจอีกครั้ง',

  /* ── Allocation arithmetic ───────────────────────────────────────────────── */
  'error.slip.no_allocations':
    'ต้องระบุว่าสลิปนี้ตัดชำระงวดใดบ้าง — การรับสลิปโดยไม่ระบุงวดคือการกดยืนยันเฉยๆ',
  'error.slip.duplicate_instalment_line': 'ระบุงวดเดียวกันซ้ำสองบรรทัด — ให้รวมเป็นบรรทัดเดียว',
  'error.slip.instalment_not_on_this_order':
    'งวดที่ระบุไม่ได้อยู่ในตารางงวดของออร์เดอร์นี้ — เงินไม่ย้ายข้ามออร์เดอร์ผ่านหน้าตรวจสลิป',
  'error.slip.over_allocated': (params, fmt) =>
    `งวดที่ ${fmt.count(params.seq)} ค้างอยู่ ${fmt.money(params.remaining)} แต่ระบุตัดชำระ ${fmt.money(params.requested)} — ` +
    'ส่วนเกินเป็นของงวดถัดไป ไม่ใช่ของงวดนี้',
  'error.slip.foot_with_room_left': (params, fmt) =>
    `ยอดที่ตัดชำระรวม ${fmt.money(params.allocated)} แต่สลิปใบนี้เป็นเงิน ${fmt.money(params.slip)} ` +
    `และตารางงวดยังรับได้อีก ${fmt.money(params.roomLeft)} — เงินที่ยังมีงวดรองรับต้องตัดเข้างวด ไม่ใช่ค้างเป็นเงินรับล่วงหน้า`,
  'error.slip.overpayment_not_acknowledged': (params, fmt) =>
    `สลิปใบนี้เกินยอดที่ตารางงวดรองรับอยู่ ${fmt.money(params.excess)} — ` +
    'ถ้ายืนยันว่าเงินเข้าจริง ให้ระบุยอดส่วนเกินเพื่อรับไว้เป็นเงินรับล่วงหน้าที่ยังไม่ตัดงวดใด',
  'error.slip.overpayment_mismatch': (params, fmt) =>
    `ยอดส่วนเกินที่ยืนยันคือ ${fmt.money(params.acknowledged)} แต่ส่วนเกินจริงคือ ` +
    `${fmt.money(params.excess)} — ตัวเลขต้องตรงกัน`,
  'error.slip.foot_mismatch': (params, fmt) =>
    `ยอดที่ตัดชำระรวม ${fmt.money(params.allocated)} แต่สลิปใบนี้เป็นเงิน ${fmt.money(params.slip)} — ` +
    `ต่างกัน ${fmt.money(params.difference)} · สลิปที่รับแล้วต้องตัดชำระเท่ากับเงินที่เป็นหลักฐานพอดี`,

  /* ── Staleness ───────────────────────────────────────────────────────────── */
  /*
   * Two catalogue-stale sentences and not one. `…กำลังเลือก` is said to a customer in the
   * configurator; `…กำลังแก้ไข` is said to a salesperson editing a quote. They differed
   * before this change too — one constant per module — and collapsing them now would be a
   * behaviour change smuggled in under a refactor.
   */
  'error.stale.catalog_while_configuring':
    'แคตตาล็อกมีการเผยแพร่เวอร์ชันใหม่ระหว่างที่คุณกำลังเลือก — กรุณาตรวจสอบราคาปัจจุบันอีกครั้ง',
  'error.stale.catalog_while_editing_quote':
    'แคตตาล็อกมีการเผยแพร่เวอร์ชันใหม่ระหว่างที่คุณกำลังแก้ไข — กรุณาตรวจสอบราคาปัจจุบันอีกครั้ง',
  'error.stale.quote_edited_by_someone_else':
    'ใบเสนอราคานี้ถูกแก้ไขโดยคนอื่นระหว่างที่คุณกำลังทำรายการ — กรุณาโหลดใหม่',
  'error.stale.override_baselines':
    'แคตตาล็อกเปลี่ยนหลังจากที่ตกลงราคาไว้ — ต้องยืนยันราคาที่ตกลงใหม่ทีละรายการก่อนส่งใบเสนอราคา',

  /* ── Configuration ───────────────────────────────────────────────────────── */
  'error.line.cannot_be_made': 'รายการนี้ผลิตไม่ได้ตามที่กำหนดไว้',

  /* ── Infrastructure ──────────────────────────────────────────────────────── */
  'error.http.payload_too_large': 'ข้อมูลที่ส่งมามีขนาดใหญ่เกินกว่าที่ระบบรับได้',
  'error.http.busy': 'ระบบกำลังมีคำขอพร้อมกันจำนวนมาก กรุณาลองใหม่อีกครั้ง',
  'error.internal.unexpected': 'ระบบเกิดข้อผิดพลาดที่ไม่คาดคิด — กรุณาติดต่อเราพร้อมรหัสคำขอด้านล่าง',
};
