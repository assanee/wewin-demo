import type { SupportedLocale } from '../locale';

/**
 * The messages, one per `notification_rules.template_key`.
 *
 * ── Where the list comes from ────────────────────────────────────────────────
 *
 * Not from this file. `notification_rules` in `drizzle/0007_order_guards.sql` decides who
 * hears about what (plan 10.3); this is only the prose. That direction matters: a rule with
 * no template here is a message the database will queue and this process cannot render —
 * which would fail at send time, five attempts later, in a dead row nobody expected. So
 * `tests/notifications/rules-coverage.pg.test.ts` reads the live rules table and fails if
 * any enabled rule names a key that is missing here, in every supported locale.
 *
 * ── ⚠️ WHAT IS DELIBERATELY NOT HERE: i18n ───────────────────────────────────
 *
 * Thai only. Plan 10.6 sizes the real job at ~12 events × 8 languages ≈ 96 messages and
 * names it a translator bottleneck shared with plan 13's content row — it is phase 6 work
 * and no amount of English written by this round would be the translation that ships. The
 * *seam* is here and is exercised: a template is keyed by locale, `resolveRenderLocale`
 * decides which one is reachable, and `notification_attempts.locale` records the language
 * actually used, so the day English arrives nothing else has to move.
 *
 * ── Plain text, and no money ─────────────────────────────────────────────────
 *
 * No HTML. A notification here says what happened and where to look; the numbers live in
 * the quotation document, which is pinned (plan 7.13) and is the thing a customer is
 * entitled to rely on. Restating a total in an email is a second answer to "what do I owe"
 * that nobody pins and nobody reprints.
 *
 * SEAM 5b: the amount due, the instalment that is now payable, and the slip-rejected notice
 * are payment facts. They arrive as new `notification_rules` rows with new template keys and
 * a context field for the amount — not as a number formatted into one of the strings below,
 * which would need a rounding decision this phase has no right to make.
 *
 * SEAM 5c: `order.quote_revised.customer` is plan 10.4's red line — a quote the customer
 * already agreed to has changed, and the message must carry **the diff and a way to object**,
 * including a change of *scope* and not only of total. The rule, the coalescing and the
 * delivery are built; the diff itself needs the sales-editable quote to exist. Until then
 * the message says what changed *is not shown here* rather than implying nothing changed.
 */

export interface TemplateContext {
  /** `orders.order_no`, minted at submit. Null on a draft, which is why the greeting has two shapes. */
  readonly orderNo: string | null;
  readonly contactName: string | null;
  /**
   * How many further events folded into this one message — plan 10.5(2).
   *
   * Rendered, not hidden. "แก้ไขใบเสนอราคา 5 ครั้ง" is the honest description of what
   * happened, and a customer who received one message about five edits should be told it
   * was five, or the next phone call is about the four they never heard of.
   */
  readonly coalescedCount: number;
}

export interface RenderedTemplate {
  readonly subject: string;
  readonly body: string;
}

type Renderer = (context: TemplateContext) => RenderedTemplate;

/** `คุณสมชาย` when we know the name, a neutral form when we do not. Never an empty greeting. */
const greeting = (context: TemplateContext): string =>
  context.contactName === null || context.contactName.trim().length === 0
    ? 'เรียน ลูกค้าผู้มีอุปการคุณ'
    : `เรียน คุณ${context.contactName.trim()}`;

/** `เลขที่ 25-000123` where there is a number; a draft has none, and saying so beats printing `null`. */
const orderLabel = (context: TemplateContext): string =>
  context.orderNo === null ? 'ใบเสนอราคาของท่าน' : `ใบสั่งซื้อเลขที่ ${context.orderNo}`;

const foldNote = (context: TemplateContext): string =>
  context.coalescedCount > 0
    ? `\n\n(ข้อความนี้รวมการเปลี่ยนแปลง ${context.coalescedCount + 1} ครั้งที่เกิดขึ้นในช่วงเวลาใกล้เคียงกัน)`
    : '';

const SIGN_OFF = '\n\nขอแสดงความนับถือ\nWewin';

const customer = (subject: (context: TemplateContext) => string, body: (context: TemplateContext) => string): Renderer =>
  (context) => ({
    subject: subject(context),
    body: `${greeting(context)}\n\n${body(context)}${foldNote(context)}${SIGN_OFF}`,
  });

/**
 * Internal messages get no greeting and no sign-off.
 *
 * They are a work queue, read in a hurry, and the first line has to be the thing to do.
 * Plan 10.3's reason for each of them is "otherwise nobody knows there is anything waiting".
 */
const staff = (subject: (context: TemplateContext) => string, body: (context: TemplateContext) => string): Renderer =>
  (context) => ({ subject: subject(context), body: `${body(context)}${foldNote(context)}` });

const TH: Readonly<Record<string, Renderer>> = {
  'order.submitted_for_payment.customer': customer(
    (c) => `ได้รับคำสั่งซื้อของท่านแล้ว — ${orderLabel(c)}`,
    (c) =>
      `เราได้รับคำสั่งซื้อของท่านเรียบร้อยแล้ว (${orderLabel(c)}) และได้บันทึกรายละเอียดสินค้า ราคา และภาษีมูลค่าเพิ่มไว้ตามที่ท่านเห็นในขณะยืนยัน\n` +
      'ขั้นตอนถัดไปคือการชำระเงินและอัปโหลดสลิป ทีมงานจะตรวจสอบและยืนยันให้ท่านทราบอีกครั้ง',
  ),
  'order.submitted_for_payment.sales': staff(
    (c) => `[ใหม่] รอชำระเงิน — ${orderLabel(c)}`,
    (c) => `มีคำสั่งซื้อใหม่เข้าสู่สถานะรอชำระเงิน: ${orderLabel(c)}\nโปรดติดตามการชำระเงินและตรวจสลิปเมื่อได้รับ`,
  ),

  /* 🔴 Plan 10.3's red line and plan 10.4. See the SEAM 5c note at the top of this file. */
  'order.quote_revised.customer': customer(
    (c) => `มีการแก้ไขใบเสนอราคาของท่าน — ${orderLabel(c)}`,
    (c) =>
      `ใบเสนอราคาที่ท่านตกลงไว้ (${orderLabel(c)}) ถูกแก้ไข\n` +
      'ท่านมีสิทธิ์ตรวจสอบรายการที่เปลี่ยนแปลงและ **คัดค้าน** ได้ก่อนชำระเงิน หากมีข้อสงสัยโปรดติดต่อทีมขายก่อนโอน\n' +
      '(รายละเอียดการเปลี่ยนแปลงแบบเทียบก่อน–หลัง จะแสดงในหน้าใบเสนอราคาเมื่อระบบส่วนนั้นเปิดใช้งาน)',
  ),

  'order.payment_confirmed.customer': customer(
    (c) => `ยืนยันการชำระเงินแล้ว — ${orderLabel(c)}`,
    (c) =>
      `เราตรวจสอบและยืนยันการชำระเงินของท่านแล้ว (${orderLabel(c)})\n` +
      'คำสั่งซื้อเข้าสู่ขั้นตอนเตรียมการผลิต และรายละเอียดของงานถูกตรึงไว้ตามที่ตกลงกัน',
  ),
  'order.production_started.customer': customer(
    (c) => `เริ่มการผลิตแล้ว — ${orderLabel(c)}`,
    (c) => `งานของท่าน (${orderLabel(c)}) เข้าสู่สายการผลิตแล้ว เราจะแจ้งอีกครั้งเมื่อพร้อมนัดหมายติดตั้ง`,
  ),
  'order.installation_scheduled.customer': customer(
    (c) => `พร้อมนัดหมายติดตั้ง — ${orderLabel(c)}`,
    (c) => `งานของท่าน (${orderLabel(c)}) ผลิตเสร็จแล้วและพร้อมนัดหมายติดตั้ง ทีมงานจะติดต่อเพื่อนัดวันและเวลา`,
  ),
  'order.delivered.customer': customer(
    (c) => `ส่งมอบงานเรียบร้อย — ${orderLabel(c)}`,
    (c) =>
      `เราส่งมอบงานตาม ${orderLabel(c)} เรียบร้อยแล้ว ขอบคุณที่ไว้วางใจ\n` +
      'หากพบปัญหาจากการติดตั้งหรือตัวสินค้า โปรดแจ้งทีมงานได้ทันที',
  ),

  'order.bounced_to_redesign.customer': customer(
    (c) => `ต้องปรับแบบก่อนดำเนินการต่อ — ${orderLabel(c)}`,
    (c) =>
      `ฝ่ายผลิตแจ้งว่างานตาม ${orderLabel(c)} ต้องปรับแบบก่อนจึงจะผลิตได้\n` +
      'ทีมขายจะติดต่อเพื่ออธิบายสิ่งที่ต้องเปลี่ยนและยืนยันกับท่านก่อนดำเนินการต่อ เงินที่ท่านชำระมาแล้วยังคงอยู่กับคำสั่งซื้อนี้',
  ),
  'order.bounced_to_redesign.sales': staff(
    (c) => `[ตีกลับ] ต้องปรับแบบ — ${orderLabel(c)}`,
    (c) => `ฝ่ายผลิตตีกลับ ${orderLabel(c)} เพื่อปรับแบบ\nโปรดติดต่อลูกค้าและยืนยันขอบเขตงานใหม่ก่อนส่งกลับเข้าผลิต`,
  ),
  'order.redesign_approved.customer': customer(
    (c) => `อนุมัติแบบที่ปรับแล้ว — ${orderLabel(c)}`,
    (c) => `แบบที่ปรับแก้ของ ${orderLabel(c)} ได้รับการอนุมัติแล้ว และงานจะกลับเข้าสู่ขั้นตอนการผลิตต่อไป`,
  ),

  'order.cancelled.customer': customer(
    (c) => `ยกเลิกคำสั่งซื้อแล้ว — ${orderLabel(c)}`,
    (c) =>
      `${orderLabel(c)} ถูกยกเลิกเรียบร้อยแล้ว\n` +
      'หากมีเงินที่ต้องคืน ทีมงานจะติดต่อเพื่อยืนยันบัญชีปลายทางและดำเนินการคืนเงินตามขั้นตอน',
  ),
  'order.cancelled.sales': staff(
    (c) => `[ยกเลิก] ${orderLabel(c)}`,
    (c) => `${orderLabel(c)} ถูกยกเลิก\nโปรดตรวจสอบว่ามีเงินที่รับมาแล้วและต้องเข้ากระบวนการคืนเงินหรือไม่`,
  ),
  'order.superseded.customer': customer(
    (c) => `ออกใบใหม่แทนใบเดิม — ${orderLabel(c)}`,
    (c) =>
      `${orderLabel(c)} ถูกแทนที่ด้วยคำสั่งซื้อฉบับใหม่ตามที่ตกลงกัน\n` +
      'เงินที่ท่านชำระมาแล้วจะถูกยกไปยังฉบับใหม่ ไม่ต้องชำระซ้ำ',
  ),

  'order.change_requested.sales': staff(
    (c) => `[คำขอจากลูกค้า] ${orderLabel(c)}`,
    (c) => `ลูกค้าส่งคำขอเปลี่ยนแปลง/คัดค้านสำหรับ ${orderLabel(c)}\nคำขอนี้ค้างอยู่จนกว่าจะมีการตอบกลับ โปรดดำเนินการ`,
  ),
  'order.change_resolved.customer': customer(
    (c) => `ตอบกลับคำขอของท่านแล้ว — ${orderLabel(c)}`,
    (c) => `ทีมงานได้พิจารณาคำขอเปลี่ยนแปลงของท่านสำหรับ ${orderLabel(c)} และบันทึกผลการพิจารณาไว้เรียบร้อยแล้ว`,
  ),
};

const CATALOGUE: Readonly<Record<SupportedLocale, Readonly<Record<string, Renderer>>>> = { th: TH };

/** Every key this build can render. Sorted, so a diff of the coverage test reads cleanly. */
export function templateKeys(locale: SupportedLocale): readonly string[] {
  return Object.keys(CATALOGUE[locale]).sort();
}

export function hasTemplate(locale: SupportedLocale, templateKey: string): boolean {
  return Object.hasOwn(CATALOGUE[locale], templateKey);
}

/**
 * Renders, or returns undefined — never a placeholder.
 *
 * A missing template must not become "Notification: order.delivered.customer" in a
 * customer's inbox. The worker turns `undefined` into a **permanent** failure, so the row
 * lands in the dead queue with the key that is missing, which is a bug report rather than
 * an embarrassment.
 */
export function renderTemplate(
  locale: SupportedLocale,
  templateKey: string,
  context: TemplateContext,
): RenderedTemplate | undefined {
  const renderer = CATALOGUE[locale][templateKey];
  return renderer === undefined ? undefined : renderer(context);
}
