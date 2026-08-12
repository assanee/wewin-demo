import { describe, expect, it } from 'vitest';

import {
  FX_PREVIEW_BADGE_TH,
  FX_PREVIEW_NOT_BINDING_TH,
  FX_STALE_POINTS_TH,
  fxAmountTh,
  fxObservedAtTh,
  fxRateTh,
  fxStaleTitleTh,
  fxUnavailableNoteTh,
} from './fx-preview';
import type { QuoteFxPreviewWire } from './quote-wire';

/**
 * The destination-currency annotation, asserted as the pure functions that produce it.
 *
 * `vitest.config.ts` runs `environment: 'node'` and its note says why — *"a test that renders a
 * sidebar and asserts it contains three links is a test of `visibleNavigation`, spelled
 * expensively"* — so what is tested here is the **content**: the arithmetic that turns a
 * minor-unit digit string into a figure, and the sentences that decide what a salesperson does
 * next. Whether `TotalsCard` mounts it is wiring, checked by opening the screen.
 *
 * The first block is the one with money in it. The rest are the words.
 */

const preview = (over: Partial<QuoteFxPreviewWire> = {}): QuoteFxPreviewWire => ({
  available: true,
  currency: 'SGD',
  grandTotalMinor: '65383',
  rateText: '27.050000',
  source: 'mid_market',
  observedAt: '2026-08-09T07:30:00.000Z',
  stale: false,
  ageHours: 6,
  reason: null,
  ...over,
});

describe('fxAmountTh — the minor unit belongs to the currency, not to the number 100', () => {
  it('renders a two-decimal currency to its satang-equivalent', () => {
    expect(fxAmountTh('SGD', '65383')).toBe('SGD 653.83');
  });

  it('⭐ renders a zero-decimal currency with no decimal point and no shift', () => {
    /*
     * The assertion this file exists for. `MINOR_EXPONENT` is 0 for VND, so '5991000' is
     * ₫5,991,000 — the exact figure `packages/core/src/money.ts`'s header names as the one a
     * hardcoded `/ 100` renders as ₫59,910.00, a hundred times too small under a currency code a
     * customer would transfer against.
     */
    expect(fxAmountTh('VND', '5991000')).toBe('VND 5,991,000');
    expect(fxAmountTh('LAK', '1250000')).toBe('LAK 1,250,000');
  });

  it('groups thousands and keeps both decimal places, including a leading zero', () => {
    expect(fxAmountTh('USD', '1234567')).toBe('USD 12,345.67');
    /* `'5'` is five cents and not five dollars: the place a digit sits in decides its value. */
    expect(fxAmountTh('SGD', '5')).toBe('SGD 0.05');
    expect(fxAmountTh('SGD', '100')).toBe('SGD 1.00');
  });

  it('carries a figure no float could hold, because the parse is BigInt', () => {
    /* Past Number.MAX_SAFE_INTEGER. Absurd as a price, and exactly the case a `Number(...)`
     * parse would round into a different figure with no symptom. */
    expect(fxAmountTh('VND', '9007199254740993123')).toBe('VND 9,007,199,254,740,993,123');
  });

  it('renders nothing at all rather than a figure it cannot state truthfully', () => {
    expect(fxAmountTh('SGD', null)).toBeNull();
    /* Not digits — `BigInt('12.50')` throws and would take the whole card down with it. */
    expect(fxAmountTh('SGD', '12.50')).toBeNull();
    expect(fxAmountTh('SGD', '')).toBeNull();
    expect(fxAmountTh('SGD', '-65383')).toBeNull();
    /* A currency this build has no exponent for: the scale is unknown, so the figure is unknown. */
    expect(fxAmountTh('XYZ', '65383')).toBeNull();
  });

  it('does not mistake a prototype key for a currency', () => {
    /*
     * ⚠️ `'toString' in MINOR_EXPONENT` is true. A membership test that walked the prototype
     * chain would index the table to a *function*, `exponent === 0` would be false for it, and
     * every figure would print silently divided by 100 under the label "toString".
     */
    expect(fxAmountTh('toString', '65383')).toBeNull();
    expect(fxAmountTh('constructor', '65383')).toBeNull();
  });
});

describe('fxRateTh — the rate, and where it came from', () => {
  it('says a company-set rate has no observation, in the printed document’s words', () => {
    const text = fxRateTh(preview({ source: 'manual', observedAt: null, ageHours: null }));

    expect(text).toContain('1 SGD = 27.050000 บาท');
    /* Verbatim from `quotation-sheet.tsx`, so the preview and the printed quotation do not use
     * two different phrases for one fact. */
    expect(text).toContain('อัตราที่บริษัทกำหนด');
    expect(text).toContain('ไม่มีเวลาสังเกตอัตรา');
    expect(text).not.toContain('อ้างอิงอัตรา');
  });

  it('says when a mid-market rate was observed, and how old it is', () => {
    const text = fxRateTh(preview());

    expect(text).toContain('อ้างอิงอัตรา ณ');
    expect(text).not.toContain('อัตราที่บริษัทกำหนด');
    /*
     * ⭐ The age is on the rate line and not only inside the stale warning: a two-hour-old rate
     * and a seventy-hour-old one read identically otherwise, and only one of them is about to be
     * refused at submit.
     */
    expect(text).toContain('เก่า 6 ชั่วโมง');
  });

  it('drops the observation clause rather than inventing one', () => {
    expect(fxRateTh(preview({ observedAt: null }))).toBe('1 SGD = 27.050000 บาท');
    expect(fxRateTh(preview({ ageHours: null }))).not.toContain('ชั่วโมง');
  });

  it('treats a source this build has not been taught as observed, not as company-set', () => {
    /* Claiming the company set a rate it did not set is the more expensive of the two mistakes. */
    expect(fxRateTh(preview({ source: 'ecb_reference' }))).toContain('อ้างอิงอัตรา ณ');
  });

  it('has nothing to say when there is no rate', () => {
    expect(fxRateTh(preview({ available: false, rateText: null }))).toBeNull();
  });
});

describe('fxObservedAtTh — Bangkok’s day, and never the string "Invalid Date"', () => {
  it('renders the observation in Bangkok time', () => {
    /*
     * 07:30Z is 14:30 in Bangkok, and the reader is comparing it against a Thai working day —
     * the reason `packages/core/src/quotation.ts` pins the document date to `Asia/Bangkok`
     * rather than to the browser's zone.
     */
    expect(fxObservedAtTh('2026-08-09T07:30:00.000Z')).toContain('14:30');
  });

  it('hands back an unparseable timestamp verbatim', () => {
    /* `new Date('nonsense').toLocaleString(...)` is literally "Invalid Date". An ISO string is
     * something a person can carry to whoever owns the feed; that is not. */
    expect(fxObservedAtTh('not-a-timestamp')).toBe('not-a-timestamp');
    expect(fxObservedAtTh('not-a-timestamp')).not.toContain('Invalid Date');
  });
});

describe('the badge marks the figure as approximate and unpinned', () => {
  it('says both halves — an estimate, and not yet frozen', () => {
    /* Mirrors `customer-document.tsx`'s `ตัวอย่าง — ยังไม่ได้แช่แข็ง`: same claim, same screen. */
    expect(FX_PREVIEW_BADGE_TH).toContain('ประมาณการ');
    expect(FX_PREVIEW_BADGE_TH).toContain('ยังไม่ได้แช่แข็ง');
  });

  it('states which of the two totals is the binding one', () => {
    /*
     * ⭐ The polarity, and it is the reverse of the pinned document's. Two totals on one screen
     * with no statement of which one the company is bound by is the failure this line prevents.
     */
    expect(FX_PREVIEW_NOT_BINDING_TH).toContain('ยอดที่ผูกพันคือยอดบาท');
    expect(FX_PREVIEW_NOT_BINDING_TH).toContain('แช่แข็งตอนกดส่ง');
  });
});

describe('a stale rate: the figure still shows, and the submit will refuse it', () => {
  it('leads with the consequence, not with the age', () => {
    const title = fxStaleTitleTh('SGD', 73);

    /* Same shape as `unrecognisedDestinationTitleTh`: what changes the reader's next action goes
     * first, and the cause follows it. */
    expect(title.startsWith('ส่งใบเสนอราคานี้ไม่ได้')).toBe(true);
    expect(title).toContain('SGD');
    expect(title).toContain('เก่า 73 ชั่วโมง');
  });

  it('names no threshold of its own', () => {
    /*
     * ⚠️ `FX_RATE_REFUSE_AFTER_HOURS` lives in apps/api. A copy of the number here would
     * disagree with it the first time either moved, so the sentence says "past what the system
     * will issue" and relays the server's `stale` flag instead of recomputing the verdict.
     */
    expect(fxStaleTitleTh('SGD', 73)).not.toMatch(/\d+\s*ชั่วโมง\s*$/u);
    expect(fxStaleTitleTh('SGD', 73)).toContain('เกินเพดานที่ระบบยอมออกเอกสาร');
  });

  it('still forms a sentence when the age is missing', () => {
    const title = fxStaleTitleTh('VND', null);

    /* A manual rate is never stale and carries no age, so this pairing should not arrive — but
     * "เก่า null ชั่วโมง" on a warning banner is worse than a sentence without the number. */
    expect(title).not.toContain('null');
    expect(title.startsWith('ส่งใบเสนอราคานี้ไม่ได้')).toBe(true);
  });

  it('says the figure is not to be quoted, and who can fix it', () => {
    const points = FX_STALE_POINTS_TH.join(' ');

    /* Somebody who reads only the heading may still repeat the figure to a customer — the card
     * looks like a finished total. */
    expect(points).toContain('ระบบจะปฏิเสธเมื่อกดส่ง');
    /*
     * ⭐ The recovery, in the words the destination dialog labels the field with, and addressed
     * to the person who actually holds `organisation.write`.
     */
    expect(points).toContain('อัตราแลกเปลี่ยนกำหนดเอง');
    expect(points).toContain('ผู้ดูแลระบบ');
  });
});

describe('fxUnavailableNoteTh — no figure, and a reason a person can act on', () => {
  it('names the currency the destination wants, on every failing reason', () => {
    for (const reason of [
      'no_snapshot',
      'destination_rate_missing',
      'baht_rate_missing',
      'manual_rate_unreadable',
    ]) {
      const note = fxUnavailableNoteTh('SGD', reason);
      /* `encodeFxPreview` keeps `currency` populated on this arm precisely so the screen can say
       * "SGD, and we have no rate" rather than the uselessly generic version. */
      expect(note.titleTh, reason).toContain('SGD');
      expect(note.titleTh, reason).toContain('ส่งใบเสนอราคานี้ไม่ได้');
      /* Every one of these four stops the submit (`error.fx.rate_unavailable`), so every one of
       * them earns the destructive treatment. The card reads this rather than the reason code. */
      expect(note.blocking, reason).toBe(true);
    }
  });

  it('tells the four failures apart, because they are four different next moves', () => {
    const details = [
      'no_snapshot',
      'destination_rate_missing',
      'baht_rate_missing',
      'manual_rate_unreadable',
    ].map((reason) => fxUnavailableNoteTh('SGD', reason).detailTh);

    expect(new Set(details).size).toBe(4);
    /* Never fetched anything at all. */
    expect(details[0]).toContain('ยังไม่เคยมีอัตราแลกเปลี่ยนเข้าระบบ');
    /* The feed has rates, just not this currency. */
    expect(details[1]).toContain('ไม่มีสกุล SGD');
    /* The feed is broken for every country at once — the baht leg is missing. */
    expect(details[2]).toContain('ไม่มีอัตราของเงินบาท');
    /* Somebody typed a manual rate that is not a number: the fix is that value, not the feed. */
    expect(details[3]).toContain('อ่านเป็นตัวเลขไม่ได้');
    expect(details[3]).not.toContain('รอให้ระบบดึงอัตรารอบถัดไป');
  });

  it('offers the administrator’s fix on the three the administrator can fix', () => {
    for (const reason of ['no_snapshot', 'destination_rate_missing', 'baht_rate_missing']) {
      expect(fxUnavailableNoteTh('SGD', reason).detailTh, reason).toContain(
        'อัตราแลกเปลี่ยนกำหนดเอง',
      );
    }
  });

  it('does not cry failure over a destination that quotes in baht', () => {
    /*
     * `same_currency` is a correct configuration, not a fault: `tax_countries_fx_currency_not_thb`
     * makes it near-unreachable, and "no usable rate for THB" would be a false alarm sending an
     * administrator to fix a row that is right.
     */
    const note = fxUnavailableNoteTh('THB', 'same_currency');

    expect(note.titleTh).not.toContain('ส่งใบเสนอราคานี้ไม่ได้');
    expect(note.titleTh).toContain('คิดราคาเป็นเงินบาทอยู่แล้ว');
    expect(note.detailTh).toContain('ไม่มีการแปลงสกุลเงิน');
    /* And it is not painted as a refusal, because nothing is being refused. */
    expect(note.blocking).toBe(false);
  });

  it('shows a reason this build has not been taught as itself', () => {
    /* Same treatment `vatLabelTh` gives an unknown treatment: a code on screen is something a
     * person can quote to whoever added it. Silence is not. */
    const note = fxUnavailableNoteTh('SGD', 'provider_quota_exhausted');

    expect(note.detailTh).toContain('provider_quota_exhausted');
    expect(fxUnavailableNoteTh('SGD', null).detailTh).not.toContain('null');
  });
});
