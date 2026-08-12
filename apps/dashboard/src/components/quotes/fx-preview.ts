import { MINOR_EXPONENT, type Currency } from '@wewin/core/money';

import type { QuoteFxPreviewWire } from './quote-wire';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The indicative destination-currency figure, in words. An annotation, never a price.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `QuoteSalesViewWire.fxPreview` is the server's answer to *"roughly what will this cost the
 * customer in their own money?"*, and the contract's own note on it says the thing this file
 * exists to keep true:
 *
 *     On the pinned quotation the destination currency is the figure and baht is the
 *     settlement note. Here **baht is the figure** and this is the annotation.
 *
 * So every string below is written to be read *beside* a baht total that is still moving, and
 * none of them is allowed to read like the number somebody may repeat to a customer. The badge
 * borrows the customer preview's idiom — `ตัวอย่าง — ยังไม่ได้แช่แข็ง` in `customer-document.tsx`
 * — because it is the same claim about the same kind of screen: what is on it is not what was
 * issued, and the freeze happens at submit.
 *
 * ### Nothing here decides anything
 *
 * `stale` is **relayed, not derived** — the same discipline `quote-model.ts` states for
 * `unrecognisedDestination`. This file has no age threshold in it, no currency list of its own
 * and no opinion about whether a rate is usable: `FX_RATE_REFUSE_AFTER_HOURS` lives in apps/api
 * and a second copy here would disagree with it the first time either moved. What the screen
 * says is "the server told me the submit will refuse this", which cannot go out of step because
 * it does no deciding.
 *
 * ### ⚠️ The minor unit is the currency's, and it is not always 100
 *
 * `grandTotalMinor` is counted in the **destination** currency's minor unit. `MINOR_EXPONENT` in
 * `@wewin/core/money` calls itself *"a fact, not a policy"* and it is 0 for VND and LAK, so a
 * `/ 100` here renders ₫5,991,000 as "59,910.00" — a figure a hundred times too small under a
 * label a customer would transfer against. That is plan 4.3(c)'s named hazard and
 * `packages/core/src/quotation.ts`'s private `money()` already got it right for the pinned
 * document; this is the same arithmetic for the unpinned preview, derived from the exponent
 * rather than from a constant.
 *
 * There is deliberately **no `100n` and no `/ 100` in this file**. `amounts.ts`'s header claims
 * its two scaling constants — satang-per-baht and basis-points-per-percent — appear in that file
 * and nowhere else under `src/components/quotes`, and that a grep for them naming one file is
 * what makes the claim checkable rather than merely stated. So neither name is written here
 * either, and the scale comes from `10n ** BigInt(exponent)` — which is the more correct spelling
 * anyway: the exponent is the fact, and 100 is one of its two values.
 */

/** The label on the figure, in the register `customer-document.tsx` uses for its own preview. */
export const FX_PREVIEW_BADGE_TH = 'ประมาณการ — ยังไม่ได้แช่แข็งอัตรา';

/**
 * The polarity, said out loud beside the figure.
 *
 * Without it a salesperson has two totals in front of them and no statement of which one the
 * company is bound by. The pinned document says the mirror image of this sentence — there the
 * foreign figure is the quotation and baht is the settlement note — and getting the two
 * confused is the whole failure this line is spent on.
 */
export const FX_PREVIEW_NOT_BINDING_TH =
  'ยอดที่ผูกพันคือยอดบาทด้านบน — อัตราแลกเปลี่ยนจะถูกแช่แข็งตอนกดส่ง และยอดสกุลนี้จะคิดใหม่ ณ ตอนนั้น';

/**
 * A digit string, and nothing that merely looks like one.
 *
 * `BigInt('12.5')` and `BigInt('')`… the first throws and the second is `0n`, and this value
 * arrives from a service versioned separately from this bundle. Regex-first for the reason
 * `amounts.ts` gives at length: `BigInt` only ever runs on text already known to be digits, so
 * a malformed field becomes "no figure" rather than a thrown render or a silent zero.
 */
const DIGITS = /^\d+$/u;

/**
 * `'65383'` in SGD → `SGD 653.83`. `'5991000'` in VND → `VND 5,991,000`.
 *
 * `null` — meaning *render no figure* — for anything this function cannot state truthfully: no
 * amount, an amount that is not digits, or a currency this build has no exponent for. A wrong
 * figure beside a currency code is worse than an absent one, and the caller already has a
 * sentence for the absent case.
 *
 * ⚠️ `Object.hasOwn`, not `in`, and not a bare index. `'toString' in MINOR_EXPONENT` is true —
 * `in` walks the prototype chain — so a currency reading `toString` would pass a membership test,
 * index the table to a *function*, and `exponent === 0` being false for a function means every
 * figure would silently print divided by 100. `packages/core/src/quotation.ts` documents the
 * same trap on the pinned document's own currency guard.
 *
 * The ISO code and not a symbol, for that file's reason: `$` is shared by a dozen currencies and
 * the reader here is a Thai salesperson about to quote one of them out loud.
 */
export function fxAmountTh(currency: string, minor: string | null): string | null {
  if (minor === null || !DIGITS.test(minor)) return null;
  if (!Object.hasOwn(MINOR_EXPONENT, currency)) return null;

  const exponent = MINOR_EXPONENT[currency as Currency];
  const scale = 10n ** BigInt(exponent);
  const value = BigInt(minor);

  const whole = (value / scale).toLocaleString('th-TH');
  /* A currency with no minor unit has no decimal point either — ₫5,991,000, not ₫5,991,000.00. */
  const fraction = exponent === 0 ? '' : `.${(value % scale).toString().padStart(exponent, '0')}`;

  return `${currency} ${whole}${fraction}`;
}

/**
 * The rate the figure was produced at, and where it came from.
 *
 * Both halves are load-bearing and the vocabulary is `quotation-sheet.tsx`'s, verbatim, because
 * a salesperson reading the preview and then the printed quotation must not have to translate
 * between two ways of saying the same thing:
 *
 *   `manual`      `· อัตราที่บริษัทกำหนด` — a company-set rate. It has no observation time
 *                 because nobody observed it, and it never goes stale.
 *   `mid_market`  `· อ้างอิงอัตรา ณ <when>` — a provider's figure, with the moment it was seen.
 *
 * The age is appended rather than left to the warning below, because a rate two hours old and a
 * rate seventy hours old read identically otherwise, and only one of them is about to be
 * refused. `null` when there is no rate at all — the unavailable arm has its own sentence.
 *
 * An unrecognised `source` falls to the observed spelling rather than being asserted as manual:
 * claiming the company set a rate it did not set is the more expensive of the two mistakes.
 */
export function fxRateTh(preview: QuoteFxPreviewWire): string | null {
  if (preview.rateText === null) return null;

  const head = `1 ${preview.currency} = ${preview.rateText} บาท`;

  if (preview.source === 'manual') return `${head} · อัตราที่บริษัทกำหนด — ไม่มีเวลาสังเกตอัตรา`;
  if (preview.observedAt === null) return head;

  const age =
    preview.ageHours === null ? '' : ` (เก่า ${preview.ageHours.toLocaleString('th-TH')} ชั่วโมง)`;

  return `${head} · อ้างอิงอัตรา ณ ${fxObservedAtTh(preview.observedAt)}${age}`;
}

/**
 * The observation moment, in Bangkok's day.
 *
 * `Asia/Bangkok` and not the reader's zone, for the reason `packages/core/src/quotation.ts`
 * gives about the submission date: a rate observed at 06:00 Bangkok is dated the day before if a
 * browser in São Paulo renders it, and the reader is comparing it against a Thai working day.
 *
 * An unparseable timestamp comes back verbatim. `new Date('nonsense').toLocaleString(...)` is
 * the literal string `"Invalid Date"`, and a raw ISO string is something a person can carry to
 * whoever owns the feed; `"Invalid Date"` beside a rate is not.
 */
export function fxObservedAtTh(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;

  return at.toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

/**
 * ⭐ The refusal that has **not happened yet** — the same class of notice as
 * `UnrecognisedDestinationBanner`, and shown for the same reason.
 *
 * `stale: true` means the submit *will* refuse this quotation (`error.fx.rate_too_stale`). The
 * figure is still rendered, because withholding it would leave a salesperson unable to answer
 * "roughly how much?" while also not telling them the quote cannot go out — but it is rendered
 * under a heading that leads with the consequence, exactly as `unrecognisedDestinationTitleTh`
 * does: what changes the reader's next action goes first, the age is why.
 *
 * No threshold is named. The number of hours the system tolerates is apps/api's
 * (`FX_RATE_REFUSE_AFTER_HOURS`), and a copy of it here would be a second answer that could
 * disagree — so this says "past what the system will issue" and leaves the figure to the
 * refusal that owns it.
 */
export function fxStaleTitleTh(currency: string, ageHours: number | null): string {
  const age =
    ageHours === null
      ? `อัตราแลกเปลี่ยน ${currency} ที่ใช้อยู่เก่าเกินเพดานที่ระบบยอมออกเอกสาร`
      : `อัตราแลกเปลี่ยน ${currency} ที่ใช้อยู่เก่า ${ageHours.toLocaleString('th-TH')} ชั่วโมง เกินเพดานที่ระบบยอมออกเอกสาร`;

  return `ส่งใบเสนอราคานี้ไม่ได้ — ${age}`;
}

/**
 * The two sentences that follow it, in the order a reader needs them.
 *
 * The second one is the one worth the space. `error.fx.rate_too_stale` names the recovery in the
 * words the destination dialog uses for the field — *"อัตราแลกเปลี่ยนกำหนดเอง"* — and says
 * **an administrator**, not "you", because the tax-country row needs `organisation.write` and a
 * salesperson reading this may not hold it. Telling somebody to do something they cannot do is
 * how a fail-closed refusal becomes a support ticket.
 */
export const FX_STALE_POINTS_TH: readonly string[] = [
  'ยอดสกุลเงินปลายทางยังแสดงไว้ให้ดูคร่าว ๆ แต่ระบบจะปฏิเสธเมื่อกดส่งใบเสนอราคา — อย่ายืนยันวันส่งมอบหรือราคากับลูกค้าโดยอ้างใบนี้',
  'วิธีแก้: ให้ผู้ดูแลระบบกรอก “อัตราแลกเปลี่ยนกำหนดเอง” ที่ประเทศปลายทางนี้ในตั้งค่าบริษัท แล้วเปิดใบนี้ใหม่ — อัตราที่กรอกเองใช้ได้ทันทีและไม่ติดเงื่อนไขความเก่า',
];

/** What the screen says when there is a destination currency but no rate to reach it with. */
export interface FxUnavailableNote {
  readonly titleTh: string;
  readonly detailTh: string;
  /**
   * Whether this state stops the submit — i.e. whether the notice deserves the destructive
   * treatment.
   *
   * Decided here rather than in the component so that only one file knows what a reason code
   * means. A card that picked its own colour from `reason === 'same_currency'` would be a second
   * reading of the same field, and the two would part company the first time a reason was added.
   */
  readonly blocking: boolean;
}

/**
 * `available: false` — no figure, and why not.
 *
 * The title names **the currency** and not merely "no rate", because the wire carries the
 * currency on this arm precisely so the screen can: `encodeFxPreview`'s own comment says it is
 * what lets this say *"SGD, and we have no rate"* rather than the uselessly generic version. It
 * also leads with the submit refusal, which is real — `error.fx.rate_unavailable` is a 422 at
 * submit for exactly these states, so a salesperson who reads only the first line still learns
 * the thing that changes what they do next.
 *
 * `same_currency` is the one arm that is not a failure. It means the destination quotes in baht,
 * so there is nothing to convert and nothing to refuse; `tax_countries_fx_currency_not_thb`
 * makes it near-unreachable, and printing "no usable rate for THB" if it ever arrives would be
 * a false alarm about a correct configuration.
 *
 * An unknown `reason` is shown as itself, the way `vatLabelTh` renders a treatment this build
 * has not been taught: a reason code on screen is something a person can quote to whoever added
 * it, and silence is not.
 */
export function fxUnavailableNoteTh(currency: string, reason: string | null): FxUnavailableNote {
  if (reason === 'same_currency') {
    return {
      titleTh: 'ประเทศปลายทางนี้คิดราคาเป็นเงินบาทอยู่แล้ว',
      detailTh: 'ไม่มีการแปลงสกุลเงินสำหรับใบนี้ — ยอดบาทด้านบนคือยอดเดียวที่มี',
      blocking: false,
    };
  }

  return {
    titleTh: `ส่งใบเสนอราคานี้ไม่ได้จนกว่าจะมีอัตราแลกเปลี่ยน — ประเทศปลายทางกำหนดให้เสนอราคาเป็น ${currency}`,
    detailTh: unavailableDetailTh(currency, reason),
    blocking: true,
  };
}

const ADMIN_FIX_TH =
  'ให้ผู้ดูแลระบบกรอก “อัตราแลกเปลี่ยนกำหนดเอง” ที่ประเทศปลายทางนี้ หรือรอให้ระบบดึงอัตรารอบถัดไป';

function unavailableDetailTh(currency: string, reason: string | null): string {
  switch (reason) {
    case 'no_snapshot':
      return `ยังไม่เคยมีอัตราแลกเปลี่ยนเข้าระบบเลย จึงไม่มีอัตราบาทต่อ ${currency} ที่ใช้ได้ — ${ADMIN_FIX_TH}`;
    case 'destination_rate_missing':
      return `อัตราชุดล่าสุดที่ระบบดึงมาไม่มีสกุล ${currency} — ${ADMIN_FIX_TH}`;
    case 'baht_rate_missing':
      /*
       * The provider's snapshot is denominated in its own base currency, so reaching THB→the
       * destination needs *both* legs. Named separately from the missing-destination case
       * because this one is the feed being broken for every country at once, not this country
       * being unquotable — and the person reading it should be able to tell those apart.
       */
      return `อัตราชุดล่าสุดที่ระบบดึงมาไม่มีอัตราของเงินบาท จึงเทียบบาทกับ ${currency} ไม่ได้ — ${ADMIN_FIX_TH}`;
    case 'manual_rate_unreadable':
      return 'อัตราแลกเปลี่ยนกำหนดเองของประเทศปลายทางนี้อ่านเป็นตัวเลขไม่ได้ — ให้ผู้ดูแลระบบแก้ค่าในช่อง “อัตราแลกเปลี่ยนกำหนดเอง” ก่อน';
    default:
      return `ระบบแจ้งเหตุผลว่า “${reason ?? '—'}” ซึ่งหน้าจอนี้ยังไม่รู้จัก — ${ADMIN_FIX_TH} ถ้ายังไม่หายให้แจ้งทีมพัฒนา`;
  }
}
