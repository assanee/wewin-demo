import { describeOwedFigures, type OwedLabelKey } from '@wewin/core/owed-figures';
import { formatMoney } from '@wewin/i18n/format';

import { SUPPORTED_LOCALES, type SupportedLocale } from '../../i18n';

/**
 * ⭐ The one template whose content is a **number**, named once so that the worker, the
 * suppression rule and the catalogue below cannot disagree about which key that is.
 */
export const BALANCE_REMINDER_TEMPLATE_KEY = 'order.balance_reminded.customer';

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
 * ── ⚠️ i18n: THIRTEEN MESSAGES IN THAI, ONE IN ALL EIGHT ─────────────────────
 *
 * Thai only, still, for everything that was here before `order.balance_reminded.customer`.
 * Plan 10.6 sizes the real job at ~12 events × 8 languages ≈ 96 messages and names it a
 * translator bottleneck shared with plan 13's content row; no amount of English written by
 * one round would be the translation that ships. The *seam* is exercised: a template is
 * keyed by locale, `resolveRenderLocale` asks **per template** whether a language exists,
 * and `notification_attempts.locale` records the language actually used.
 *
 * ⭐ The reminder is written in all eight, and that is not the bottleneck being ignored — it
 * is the one message whose content is a **number**, and a number is the thing a fallback
 * cannot carry gracefully. A customer who reads only Burmese can act on "฿5,529.60" beside a
 * label they recognise; the same customer receiving eleven lines of Thai about money they owe
 * is the message that gets deleted. The per-template resolution is exactly what lets this
 * ship on its own: an `en` recipient gets this message in English and everything else in Thai,
 * and `RenderLocale.degraded` records which was which, per message.
 *
 * ── Plain text, and money in exactly one place ───────────────────────────────
 *
 * No HTML. A notification here says what happened and where to look; the numbers live in
 * the quotation document, which is pinned (plan 7.13) and is the thing a customer is
 * entitled to rely on. Restating a total in an email is a second answer to "what do I owe"
 * that nobody pins and nobody reprints.
 *
 * ⭐ **The one exception, and it is the exception this file predicted.** An invoice reminder
 * that names no amount is not a reminder — so `order.balance_reminded.customer` states the
 * balance, and states it the way SEAM 5b below said a payment fact must arrive: as **a
 * context field, formatted by the locale's own formatter**, and never as a number written
 * into a translated string. The same arrangement `apps/web`'s `payment.outstandingAmount`
 * uses, where the figure is the *whole* catalogue entry and never a hole in a sentence: a
 * translator here writes the *label*, and the digits are `@wewin/i18n`'s. Eight translations
 * each carrying their own copy of a total is eight chances for one of them to round
 * differently, and nobody finds out until a customer asks.
 *
 * ⛔ And it is not computed here or anywhere in this process:
 * `order_outstanding_thb_minor()` answers it, in Postgres, in the claim query that fetched
 * the row — at **send** time, because the balance moves between the ask and the delivery.
 *
 * SEAM 5b: the *instalment* that is now payable and the slip-rejected notice are the payment
 * facts still owed. They arrive as new `notification_rules` rows with new template keys and
 * their own context fields, on the pattern `outstandingThbMinor` now sets.
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
  /**
   * ⭐ Where the customer can read the document this message is about.
   *
   * ⚠️ **Optional, and every renderer must survive its absence.** Two reasons, and the second
   * is the one that keeps a deployment out of trouble:
   *
   *   ⓵ not every message is about a document — a delivery notice is not;
   *   ⓶ `NOTIFY_WEB_BASE_URL` unset is a configuration mistake, and the right behaviour is
   *     still to tell the customer their order was received. A sentence with `undefined`
   *     interpolated into it is worse than a message with no link.
   *
   * Built by the worker from `notifications.order_id` and a token derived on the spot — see
   * `orders/document-link.ts` for why nothing is stored.
   */
  readonly documentUrl?: string | undefined;
  /**
   * ⭐ What the customer still owes — `order_outstanding_thb_minor()`, in satang.
   *
   * ⛔ **Minor units as a `bigint`, never a formatted string and never a `number`.** The whole
   * point of carrying it as a value is that the locale decides how it is written: Burmese
   * digits, German's trailing `฿`, Hindi's lakh grouping. A pre-formatted string handed to
   * eight catalogues is one locale's typography imposed on the other seven, and a `number` is
   * a rounding decision taken by JavaScript at 2^53.
   *
   * ⚠️ **Optional, and only one renderer reads it.** Thirteen of the fourteen messages here are
   * about a status and have no business naming a figure — see the "money in exactly one place"
   * note above. The one that does treats an absent amount as a **refusal to render** rather
   * than as a message with a gap in it: `renderTemplate` returns `undefined`, the worker fails
   * the row permanently, and it lands in the dead queue naming the notification. An email
   * reading *"you owe"* with nothing after it is worse than a row an engineer reads.
   *
   * ⚠️ It is deliberately not `outstandingThbMinor: bigint` (required). Making it required
   * would put a money field on every future template's context and invite somebody to satisfy
   * the type with `0n` — which is a *sentence about a customer's balance* assembled to make a
   * compiler stop complaining. Absent means "nobody told me", and that is a different fact
   * from ฿0.00.
   *
   * ⛔ **And ฿0.00 is not a figure this message may carry either.** `balanceReminder` refuses a
   * value that is not strictly positive, not merely an absent one — an order can be settled
   * between the ask and the send, and a "you still owe ฿0.00" (or, on an overpayment,
   * `-฿150.00`) is the single worst thing this feature can produce. The refusal is the last
   * line: the worker suppresses the row before rendering, and this catches anything that ever
   * reaches the renderer another way.
   */
  readonly outstandingThbMinor?: bigint | undefined;
  /**
   * ⭐ What the customer is being asked for **now** — `order_next_due_thb_minor()`, in satang.
   *
   * The remainder of the first unsettled instalment: the deposit on a 30/70, the whole amount
   * on a pay-in-full schedule, and equal to the outstanding once the deposit has been accepted.
   *
   * ── ⚠️ WHY THE MESSAGE CARRIES TWO FIGURES AND NOT ONE ──────────────────────
   *
   * Because the screen one click away asks for this one. The email used to name the outstanding
   * alone — "ยอดคงค้างทั้งหมด ฿14,791.68" — and then link to a payment page whose amount field
   * opened on ฿4,437.50, which is a customer reading two different answers to *"what do I owe"*
   * within one click and no way to tell which is right.
   *
   * ⛔ **This is not a new decision, and this file does not get to make one.** The owner already
   * answered it — *"ที่ต้องจ่ายตอนนี้ + ค้างทั้งหมด"* — and `@wewin/core/owed-figures` is that
   * answer: which figures, which labels, in which order, and when the two collapse to one line
   * because they are the same number. `MyQuotations` and `PaymentIsland` render it, and this
   * message is the third surface to *call the same function* rather than the fourth convention.
   *
   * ⚠️ Same shape as `outstandingThbMinor`: satang as a `bigint`, printed by the locale's own
   * formatter, never written into a translated sentence, and **absent is a refusal to render**
   * rather than a figure invented to fill a hole. A reminder that quietly fell back to one line
   * because a caller forgot this field is precisely the defect above, silently reintroduced.
   */
  readonly nextDueThbMinor?: bigint | undefined;
}

export interface RenderedTemplate {
  readonly subject: string;
  readonly body: string;
}

/**
 * ⚠️ A renderer may **refuse**, and that is why this returns `RenderedTemplate | undefined`.
 *
 * It used to be total, which was honest while every message was assembled out of facts the
 * outbox row always carries (an order number, a name, a count — all nullable, all with a
 * written answer for the null). A message whose *content is a number* is the first one with a
 * precondition it cannot degrade around, so the type carries the possibility rather than
 * leaving one renderer to invent a figure.
 *
 * The two `undefined`s that reach `renderTemplate`'s caller are different facts and the worker
 * says which: **no template for this key in this locale** is a deployment mismatch (a migration
 * ahead of a deploy), while **a renderer that refused** is a caller that built a context
 * missing something. Both are permanent failures with a readable dead row; neither is a send.
 */
type Renderer = (context: TemplateContext) => RenderedTemplate | undefined;

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

/**
 * The link, as its own paragraph, or nothing at all.
 *
 * ⚠️ Nothing at all — not "(ไม่มีลิงก์)", not an empty line. A message that mentions a link it
 * does not have reads as a broken email, and the reader has no way to tell a misconfigured
 * deployment from a phishing attempt.
 */
const documentLink = (context: TemplateContext, invitation: string): string =>
  context.documentUrl === undefined || context.documentUrl === ''
    ? ''
    : `\n\n${invitation}\n${context.documentUrl}`;

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
      'ขั้นตอนถัดไปคือการชำระเงินและอัปโหลดสลิป ทีมงานจะตรวจสอบและยืนยันให้ท่านทราบอีกครั้ง' +
      documentLink(c, 'ดูใบเสนอราคาฉบับเต็มได้ที่ลิงก์นี้ (บันทึกหรือสั่งพิมพ์ได้)'),
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
      'ท่านมีสิทธิ์ตรวจสอบรายการที่เปลี่ยนแปลงและ **คัดค้าน** ได้ก่อนชำระเงิน หากมีข้อสงสัยโปรดติดต่อทีมขายก่อนโอน' +
      documentLink(c, 'ใบเสนอราคาฉบับที่แก้ไขแล้ว อยู่ที่ลิงก์นี้ — โปรดตรวจสอบก่อนโอนเงิน'),
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

/* ------------------------------------------------------------------ *
 * ⭐ แจ้งเตือนยอดค้างชำระ — the one message written in all eight languages
 * ------------------------------------------------------------------ */

/**
 * The words of the reminder, per language — **and not the number.**
 *
 * ⚠️⚠️ **THE FIGURE IS NOT A FIELD OF THIS TABLE AND MUST NEVER BECOME ONE.** There is no
 * entry here that takes an amount, because a translator who could write a sentence with a
 * baht figure in it could write one that rounds, or that puts the satang the other side of the
 * separator, or that spells `฿` as `THB` — and eight catalogues each doing that their own way
 * is eight answers to "what do I owe" and no way to tell which is right. `amountLabels` are
 * *labels*; the digits beside them come from `formatMoney`, which is `@wewin/i18n`'s and is the
 * same function that draws the price on the storefront. Identical arrangement to
 * `payment.outstandingAmount` in `apps/web`, whose whole catalogue entry is `f.bahtExact(...)`.
 *
 * The order number *is* interpolated, and that is a different thing: it is an identifier, not
 * a quantity, and it has no locale-dependent rendering to get wrong (`Formatters.code` exists
 * for exactly that distinction).
 *
 * ⚠️ Vocabulary is **borrowed, not invented**. `amountLabels` are `payment.outstanding` and
 * `payment.dueNow` from `apps/web`'s catalogue of the same locale, **verbatim** — so the two
 * figures a customer is chased for carry the same words, in the same distinction, as the two on
 * the payment page they are being sent to. The Thai subject is `payment.heading`
 * (`แจ้งชำระเงิน`) and the closing line is the storefront's own ติดต่อทีมขาย sentence. Two
 * surfaces, one wording; and `@wewin/core/owed-figures` decides which of the two labels appears.
 */
interface ReminderCopy {
  /** `Payment reminder — order no. 25-000123`. Never carries the amount; see above. */
  readonly subject: (orderRef: string) => string;
  /** ⚠️ Receives a name already trimmed to `null` when blank — see `named`. */
  readonly greeting: (contactName: string | null) => string;
  /** How this locale names the order — with a number when there is one, and without when not. */
  readonly orderRef: (orderNo: string | null) => string;
  readonly lead: (orderRef: string) => string;
  /**
   * The label each figure is printed under, on its own line — keyed by the catalogue key
   * `describeOwedFigures` names, so the mapping cannot pair a figure with the other one's words.
   *
   * ⚠️ Both entries are `apps/web`'s catalogue strings for this locale, character for character.
   * `payment.outstanding` deliberately says *the whole* ("ทั้งหมด", "in total", 总, कुल, Tổng,
   * Gesamt, ທັງໝົດ, စုစုပေါင်း) — beside `payment.dueNow` the qualifier is the only thing that
   * tells a customer whether the smaller figure sits *inside* the larger one or comes after it.
   */
  readonly amountLabels: Readonly<Record<OwedLabelKey, string>>;
  readonly linkInvitation: string;
  readonly contact: string;
  readonly signOff: string;
}

/** `null`/blank name → the neutral form. Never `Dear ,` and never the word "null". */
const named = (contactName: string | null): string | null => {
  const trimmed = contactName?.trim();
  return trimmed === undefined || trimmed.length === 0 ? null : trimmed;
};

const REMINDER_COPY: Readonly<Record<SupportedLocale, ReminderCopy>> = {
  th: {
    subject: (ref) => `แจ้งชำระเงิน — ${ref}`,
    greeting: (name) => (name === null ? 'เรียน ลูกค้าผู้มีอุปการคุณ' : `เรียน คุณ${name}`),
    orderRef: (orderNo) => (orderNo === null ? 'ใบเสนอราคาของท่าน' : `ใบสั่งซื้อเลขที่ ${orderNo}`),
    lead: (ref) => `${ref} ยังมียอดค้างชำระอยู่`,
    amountLabels: {
      'payment.outstanding': 'ยอดคงค้างทั้งหมด',
      'payment.dueNow': 'ยอดที่ต้องชำระตอนนี้',
    },
    linkInvitation: 'ดูรายละเอียดและช่องทางชำระเงินได้ที่ลิงก์นี้',
    contact: 'หากท่านชำระเรียบร้อยแล้ว หรือมีข้อสงสัยเรื่องยอดเงิน กรุณาติดต่อทีมขาย',
    signOff: 'ขอแสดงความนับถือ\nWewin',
  },
  en: {
    subject: (ref) => `Payment reminder — ${ref}`,
    greeting: (name) => (name === null ? 'Dear customer,' : `Dear ${name},`),
    orderRef: (orderNo) => (orderNo === null ? 'your quotation' : `order no. ${orderNo}`),
    lead: (ref) => `There is still an amount outstanding on ${ref}.`,
    amountLabels: {
      'payment.outstanding': 'Still owing in total',
      'payment.dueNow': 'To pay now',
    },
    linkInvitation: 'You can see the details and how to pay here:',
    contact:
      'If you have already paid, or if you have a question about the amount, please contact our sales team.',
    signOff: 'Kind regards,\nWewin',
  },
  de: {
    subject: (ref) => `Zahlungserinnerung — ${ref}`,
    greeting: (name) =>
      name === null ? 'Sehr geehrte Kundin, sehr geehrter Kunde,' : `Guten Tag ${name},`,
    orderRef: (orderNo) => (orderNo === null ? 'Ihr Angebot' : `Bestellung Nr. ${orderNo}`),
    lead: (ref) => `Für ${ref} ist noch ein Betrag offen.`,
    amountLabels: {
      'payment.outstanding': 'Noch offener Gesamtbetrag',
      'payment.dueNow': 'Jetzt zu zahlen',
    },
    linkInvitation: 'Details und Zahlungsmöglichkeiten finden Sie hier:',
    contact:
      'Wenn Sie bereits bezahlt haben oder Fragen zum Betrag haben, wenden Sie sich bitte an unser Vertriebsteam.',
    signOff: 'Mit freundlichen Grüßen\nWewin',
  },
  hi: {
    subject: (ref) => `भुगतान अनुस्मारक — ${ref}`,
    greeting: (name) => (name === null ? 'प्रिय ग्राहक,' : `प्रिय ${name} जी,`),
    orderRef: (orderNo) => (orderNo === null ? 'आपका कोटेशन' : `ऑर्डर सं. ${orderNo}`),
    lead: (ref) => `${ref} पर अभी भी राशि बकाया है।`,
    amountLabels: {
      'payment.outstanding': 'कुल बकाया राशि',
      'payment.dueNow': 'अभी देय राशि',
    },
    linkInvitation: 'विवरण और भुगतान का तरीका यहाँ देखिए:',
    contact:
      'यदि आपने भुगतान कर दिया है, या राशि के बारे में कोई सवाल हो, तो कृपया सेल्स टीम से संपर्क कीजिए।',
    signOff: 'सादर,\nWewin',
  },
  la: {
    subject: (ref) => `ແຈ້ງການຊຳລະເງິນ — ${ref}`,
    greeting: (name) => (name === null ? 'ຮຽນ ລູກຄ້າທີ່ນັບຖື,' : `ຮຽນ ທ່ານ${name},`),
    orderRef: (orderNo) => (orderNo === null ? 'ໃບສະເໜີລາຄາຂອງທ່ານ' : `ອໍເດີເລກທີ ${orderNo}`),
    lead: (ref) => `${ref} ຍັງມີຍອດຄ້າງຈ່າຍຢູ່.`,
    amountLabels: {
      'payment.outstanding': 'ຍອດຄ້າງຈ່າຍທັງໝົດ',
      'payment.dueNow': 'ຍອດທີ່ຕ້ອງຈ່າຍຕອນນີ້',
    },
    linkInvitation: 'ເບິ່ງລາຍລະອຽດ ແລະ ຊ່ອງທາງຊຳລະເງິນໄດ້ທີ່ລິ້ງນີ້:',
    contact: 'ຫາກທ່ານຊຳລະແລ້ວ ຫຼື ມີຂໍ້ສົງໄສກ່ຽວກັບຍອດເງິນ ກະລຸນາຕິດຕໍ່ທີມຂາຍ.',
    signOff: 'ດ້ວຍຄວາມນັບຖື,\nWewin',
  },
  my: {
    subject: (ref) => `ငွေပေးချေမှု သတိပေးချက် — ${ref}`,
    greeting: (name) => (name === null ? 'လေးစားရပါသော ဖောက်သည်,' : `လေးစားရပါသော ${name},`),
    orderRef: (orderNo) => (orderNo === null ? 'သင်၏ စျေးနှုန်းကမ်းလှမ်းချက်' : `အော်ဒါ အမှတ် ${orderNo}`),
    lead: (ref) => `${ref} တွင် ပေးရန်ကျန်ရှိနေသေးသော ပမာဏ ရှိပါသည်။`,
    amountLabels: {
      'payment.outstanding': 'ကျန်ရှိနေသေးသော စုစုပေါင်းပမာဏ',
      'payment.dueNow': 'ယခုပေးရမည့်ပမာဏ',
    },
    linkInvitation: 'အသေးစိတ်နှင့် ငွေပေးချေနည်းကို ဤလင့်ခ်တွင် ကြည့်ပါ:',
    contact:
      'ငွေပေးချေပြီးပါက သို့မဟုတ် ပမာဏနှင့်ပတ်သက်၍ မေးစရာရှိပါက အရောင်းအဖွဲ့ကို ဆက်သွယ်ပါ။',
    signOff: 'လေးစားစွာဖြင့်,\nWewin',
  },
  vi: {
    subject: (ref) => `Nhắc thanh toán — ${ref}`,
    greeting: (name) => (name === null ? 'Kính gửi Quý khách,' : `Kính gửi ${name},`),
    orderRef: (orderNo) => (orderNo === null ? 'báo giá của Quý khách' : `đơn hàng số ${orderNo}`),
    lead: (ref) => `${ref} vẫn còn số tiền chưa thanh toán.`,
    amountLabels: {
      'payment.outstanding': 'Tổng số tiền còn thiếu',
      'payment.dueNow': 'Cần thanh toán bây giờ',
    },
    linkInvitation: 'Xem chi tiết và cách thanh toán tại đây:',
    contact:
      'Nếu Quý khách đã thanh toán, hoặc có thắc mắc về số tiền, vui lòng liên hệ bộ phận kinh doanh.',
    signOff: 'Trân trọng,\nWewin',
  },
  zh: {
    subject: (ref) => `付款提醒 — ${ref}`,
    greeting: (name) => (name === null ? '尊敬的客户：' : `${name} 您好：`),
    orderRef: (orderNo) => (orderNo === null ? '您的报价单' : `订单编号 ${orderNo}`),
    lead: (ref) => `${ref} 仍有款项尚未结清。`,
    amountLabels: {
      'payment.outstanding': '尚欠总额',
      'payment.dueNow': '现在应付',
    },
    linkInvitation: '可在此查看明细与付款方式：',
    contact: '如您已付款，或对金额有疑问，请联系销售团队。',
    signOff: '此致\nWewin',
  },
};

/**
 * ⭐ The reminder, in one language, assembled so that no amount is ever inside a sentence.
 *
 * The body is a list of paragraphs joined by a blank line, and **each** amount is its own
 * paragraph: a label the translator wrote, then the digits `formatMoney` wrote, on the next
 * line. That layout is not a style preference — it is what makes the promise above mechanical.
 * A sentence with a hole in it invites the hole to be moved, pluralised or agreed with; a line
 * under a label cannot be.
 *
 * `'exact'` and not `'whole'`: this is the figure a customer is going to type into a banking
 * app, and `formatBaht`'s whole-baht rounding would ask them for a different number from the
 * one the payment page shows. Same call `apps/web`'s `bahtExact` makes.
 *
 * ── ⚠️ WHICH FIGURES, AND IT IS NOT THIS FILE THAT DECIDES ──────────────────
 *
 * `describeOwedFigures` does — `@wewin/core/owed-figures`, the same call `MyQuotations` and
 * `PaymentIsland` make. It answers with the figures **in reading order**, so the one being
 * asked for now leads and the whole debt supports it, and it collapses to a single line when
 * the two are the same number (a pay-in-full order, or a 30/70 whose deposit has been
 * accepted) — because two labels side by side assert a distinction, and a reader who sees the
 * same amount under both concludes they misread one of them.
 *
 * ⛔ Called, not restated. The email is the third surface to state these two figures and it
 * must not be the fourth convention: the whole defect it exists to close is a customer reading
 * ฿14,791.68 in an inbox and ฿4,437.50 in the field of the page that email linked to.
 *
 * ⚠️ `emphasis` is deliberately ignored. It is a *role*, and this medium has no typography to
 * spend on it — plain text, no HTML (see the top of this file). Reading order is the whole of
 * the emphasis available here, and it is the part `describeOwedFigures` already decided.
 *
 * ── The two refusals ────────────────────────────────────────────────────────
 *
 * ⚠️ **No figure → no message.** Either amount absent means a caller built a context the claim
 * query is supposed to fill, and the worker turns that into a permanent dead row an engineer
 * reads rather than an email with a hole where the money should be.
 *
 * ⛔ **Nothing owed → no message**, and this one is about a customer rather than an engineer.
 * An order can be settled — by a slip, or by an approved write-off — between the button being
 * pressed and the worker draining, and "ยอดคงค้างทั้งหมด ฿0.00" (or `-฿150.00` on an
 * overpayment) chases somebody who has already paid, which is the worst thing this feature can
 * do. In the ordinary run nothing reaches this line: `sendSuppression` below takes the row out
 * of the queue before it is rendered, because a customer who paid promptly is not a delivery
 * failure. This is the backstop for every other path into the renderer, and it is why the test
 * for it asserts `undefined` and not a string.
 *
 * ⚠️ Survives `documentUrl` being absent, like every other renderer here: an unset
 * `NOTIFY_WEB_BASE_URL` is a configuration mistake and is not a reason to withhold the message,
 * so the link paragraph is dropped whole rather than rendered empty or as a broken invitation.
 */
const balanceReminder = (locale: SupportedLocale): Renderer => {
  const copy = REMINDER_COPY[locale];

  return (context) => {
    const outstanding = context.outstandingThbMinor;
    const nextDue = context.nextDueThbMinor;
    if (outstanding === undefined || nextDue === undefined) return undefined;
    if (outstanding <= 0n) return undefined;

    const reference = copy.orderRef(context.orderNo);
    const link =
      context.documentUrl === undefined || context.documentUrl === ''
        ? null
        : `${copy.linkInvitation}\n${context.documentUrl}`;

    const paragraphs = [
      copy.greeting(named(context.contactName)),
      copy.lead(reference),
      /* ⛔ Label, newline, digits — per figure. Words and amount never share a line. */
      ...describeOwedFigures(outstanding, nextDue).map(
        (figure) =>
          `${copy.amountLabels[figure.labelKey]}\n${formatMoney(locale, figure.amountMinor, 'THB', 'exact')}`,
      ),
      link,
      copy.contact,
      copy.signOff,
    ];

    return {
      subject: copy.subject(reference),
      body: paragraphs.filter((paragraph) => paragraph !== null).join('\n\n'),
    };
  };
};

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ WHY A QUEUED MESSAGE MUST NOT BE SENT — and why that is not a failure.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Answers a suppression reason (`notifications.suppressed_reason`) or `undefined` for "send it".
 * The worker asks this **before** rendering, on the context it is about to render with.
 *
 * ── The one case, today ──────────────────────────────────────────────────────
 *
 * The balance reminder on an order that no longer owes anything. The window is real and not
 * contrived: the outbox retries five times with backoff, a worker can be down, a queue can be
 * backlogged — and an accepted slip or an approved write-off moves a balance to zero in one
 * statement. The figure is read at send time precisely because it moves; this is what happens
 * when it has moved all the way.
 *
 * ── ⚠️ WHY `suppressed` AND NOT `dead` ───────────────────────────────────────
 *
 * The renderer refuses either way, and a refusal alone would produce a **dead** row. That is
 * the wrong record, and the wrongness is operational rather than cosmetic:
 *
 *   ⓵ `dead` is the queue plan 10.5(3) built the whole outbox around — *"the company believes
 *     the customer was told and they were not"*. The worker logs it at `error` with "Nobody has
 *     been told", which is the line an alert keys on. A customer who paid before we got round
 *     to chasing them is not that. Filing it there teaches whoever reads that queue that some
 *     of it is noise, and a dead queue nobody trusts is the failure the plan names.
 *   ⓶ the dead queue has a ส่งซ้ำ button, and pressing it here re-renders, re-refuses and
 *     re-deads. A row whose only offered action cannot work should not be in that list.
 *   ⓷ `suppressed` already means exactly this: terminal, undelivered, **not** a failure, and
 *     nothing anybody presses will change it. `suppressed_reason` is what says which kind, and
 *     `balance_settled` is a fact a person can act on — or, far more often, be satisfied by.
 *
 * ⚠️ The cost, stated rather than hidden: `notifications_addressed_unless_suppressed` requires
 * a suppressed row to have no `recipient_key`, so suppressing drops the address off the row.
 * That is the same trade `0009_user_erasure.sql` makes and it is acceptable for the same
 * reason — the address was never used, the order still has it, and the next ask writes a new
 * event and a new outbox row.
 *
 * ⛔ An **absent** amount is deliberately not suppressed. That is a caller that failed to build
 * the context, it is a bug, and it belongs in the dead queue where bugs are read. Only a figure
 * that is present and settled is a non-event.
 */
export function sendSuppression(templateKey: string, context: TemplateContext): string | undefined {
  if (templateKey !== BALANCE_REMINDER_TEMPLATE_KEY) return undefined;

  const outstanding = context.outstandingThbMinor;
  if (outstanding === undefined) return undefined;

  /* `<= 0n` and not `=== 0n`: an overpayment is a modelled state and has nothing to chase. */
  return outstanding <= 0n ? 'balance_settled' : undefined;
}

/**
 * One catalogue per language: thirteen messages in Thai, and the reminder in all eight.
 *
 * A `Record` over all eight and not `{ th: TH }`, because 6a widened `SUPPORTED_LOCALES`
 * from one to eight and a lookup of `CATALOGUE['my']` on the old shape was `undefined` —
 * which would have thrown inside `renderTemplate` rather than returning `undefined`, and a
 * throw in the worker is a retried delivery rather than a dead row somebody reads.
 *
 * ⚠️ **The seven non-Thai catalogues are no longer one shared `EMPTY` object.** They were, and
 * that was safe only while they stayed empty: `hasTemplate` reads them with `Object.hasOwn`, so
 * a single shared object would have made `order.balance_reminded.customer` appear to exist in a
 * language it had not been written in the moment anything wrote to it. Each locale now builds
 * its own object from its own `REMINDER_COPY` entry, which is also what makes the next
 * translation an entry rather than a refactor.
 *
 * The rest stays untranslated on purpose. Plan 10.6 sizes it at ~12 events × 8 languages ≈ 96
 * messages and names the same translator bottleneck as plan 13's product content;
 * `resolveRenderLocale` asks per template, so an `en` customer already receives this message in
 * English and the other thirteen in Thai — which is the arrangement that lets a translation ship
 * the day it is written instead of the day the last of the 96 is.
 */
const CATALOGUE: Readonly<Record<SupportedLocale, Readonly<Record<string, Renderer>>>> =
  Object.fromEntries(
    SUPPORTED_LOCALES.map((locale): [SupportedLocale, Readonly<Record<string, Renderer>>] => [
      locale,
      {
        ...(locale === 'th' ? TH : {}),
        [BALANCE_REMINDER_TEMPLATE_KEY]: balanceReminder(locale),
      },
    ]),
  ) as Record<SupportedLocale, Readonly<Record<string, Renderer>>>;

/** Every key this build can render. Sorted, so a diff of the coverage test reads cleanly. */
export function templateKeys(locale: SupportedLocale): readonly string[] {
  return Object.keys(CATALOGUE[locale]).sort();
}

/**
 * The one lookup, and the reason it is a function rather than an index.
 *
 * `CATALOGUE[locale][templateKey]` reaches `Object.prototype` for `templateKey` values that
 * are not templates at all. Measured, on the real object:
 *
 *     'toString'       → a function; renders the string "[object Undefined]"
 *     'constructor'    → a function; returns an object with no subject and no body,
 *                        so the email goes out with `undefined` in both
 *     'valueOf'        → throws, and a throw in the worker is a **retried** delivery
 *                        rather than a dead row somebody reads
 *
 * `hasTemplate` already used `Object.hasOwn` and answered `false` for all three, so the two
 * functions disagreed about what a template is — and `renderTemplate`'s own doc comment
 * ("never a placeholder") was false for the first of them. Reachable only through a
 * `notification_rules.template_key` row, which `rules-coverage.pg.test.ts` checks; but that
 * test checks `hasTemplate`, which is precisely the predicate the renderer was not using.
 * One lookup means they cannot disagree again.
 */
function templateFor(locale: SupportedLocale, templateKey: string): Renderer | undefined {
  const catalogue = CATALOGUE[locale];
  return Object.hasOwn(catalogue, templateKey) ? catalogue[templateKey] : undefined;
}

export function hasTemplate(locale: SupportedLocale, templateKey: string): boolean {
  return templateFor(locale, templateKey) !== undefined;
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
  const renderer = templateFor(locale, templateKey);
  return renderer === undefined ? undefined : renderer(context);
}
