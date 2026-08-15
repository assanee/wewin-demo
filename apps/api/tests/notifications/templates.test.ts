import { describe, expect, it } from 'vitest';

import {
  FALLBACK_LOCALE,
  isSupportedLocale,
  preferredLocaleOf,
  resolveRenderLocale,
  SUPPORTED_LOCALES,
  type SupportedLocale,
} from '../../src/notifications/locale';

import { formatMoney } from '@wewin/i18n/format';

import {
  BALANCE_REMINDER_TEMPLATE_KEY,
  hasTemplate,
  renderTemplate,
  sendSuppression,
  templateKeys,
} from '../../src/notifications/templates/templates';

/** Any key that exists in Thai. The resolution is per template, so it needs a real one. */
const KEY = 'order.delivered.customer';

/**
 * The prose, and the locale seam in front of it.
 *
 * `rules-coverage.pg.test.ts` is the one that matters for completeness — it reads the live
 * `notification_rules` table and fails if a rule names a template this build cannot render.
 * This file is the part that needs no database: that the renderers produce something a
 * person can read, and that the locale resolution records what it actually did rather than
 * what it was asked for.
 */

/**
 * ⚠️ Carries `outstandingThbMinor`, and that is not decoration.
 *
 * `order.balance_reminded.customer` **refuses to render** without it — see `TemplateContext` —
 * so a shared context that omitted it would make the first test below fail for the right
 * reason in the wrong place. Every other renderer ignores the field entirely, which is the
 * point of it being optional.
 *
 * ฿5,529.60 rather than a round number: a figure whose satang are non-zero is the only one that
 * can catch a formatter that dropped them, and it is the amount every other money test in this
 * repository uses for exactly that reason.
 */
const CONTEXT = {
  orderNo: '25-000123',
  contactName: 'สมชาย',
  coalescedCount: 0,
  outstandingThbMinor: 552_960n,
  /*
   * ⚠️ And `nextDueThbMinor`, for the same reason and with the same consequence: the reminder
   * states **both** figures — what is payable now and what is owed in total — because the screen
   * it links to opens its amount field on the first of them. A context carrying only the total
   * is refused, exactly like one carrying no money at all.
   *
   * Equal to the outstanding here on purpose. That is the commonest real shape — a pay-in-full
   * order, or a 30/70 whose deposit has already been accepted — and `describeOwedFigures`
   * collapses it to a single line, so every assertion below that expects one amount still
   * describes the message a customer actually receives. The 30/70 case has its own block.
   */
  nextDueThbMinor: 552_960n,
} as const;

describe('notification templates', () => {
  it('renders every key it claims to have, with a subject and a body', () => {
    for (const key of templateKeys(FALLBACK_LOCALE)) {
      const rendered = renderTemplate(FALLBACK_LOCALE, key, CONTEXT);

      expect(rendered, key).toBeDefined();
      expect(rendered?.subject.length, key).toBeGreaterThan(0);
      expect(rendered?.body.length, key).toBeGreaterThan(0);

      // The two ways a half-written template escapes review: a literal placeholder that
      // survived, and the raw template key used as the message.
      expect(rendered?.subject, key).not.toContain('undefined');
      expect(rendered?.body, key).not.toContain('undefined');
      expect(rendered?.body, key).not.toContain('${');
      expect(rendered?.subject, key).not.toBe(key);
    }
  });

  it('writes to the customer in Thai and names the order', () => {
    const rendered = renderTemplate(FALLBACK_LOCALE, 'order.payment_confirmed.customer', CONTEXT);

    expect(rendered?.subject).toContain('25-000123');
    expect(rendered?.body).toContain('เรียน คุณสมชาย');
    // House rule: user-facing copy is Thai. A message with no Thai character in it is a
    // template somebody wrote in English "to fix later".
    expect(rendered?.body).toMatch(/[฀-๿]/u);
  });

  it('greets a customer whose name we never got', () => {
    // A guest quote carries an email and often nothing else. "เรียน คุณ" with nothing after
    // it is the version of this bug that ships.
    const rendered = renderTemplate(FALLBACK_LOCALE, 'order.delivered.customer', {
      orderNo: null,
      contactName: null,
      coalescedCount: 0,
    });

    expect(rendered?.body).toContain('เรียน ลูกค้าผู้มีอุปการคุณ');
    expect(rendered?.body).not.toContain('null');
    // No order number yet — the message says so rather than printing an empty label.
    expect(rendered?.body).toContain('ใบเสนอราคาของท่าน');
  });

  it('tells the customer how many changes were folded into one message', () => {
    // Plan 10.5(2) coalesces five edits into one message. A customer who is told about one
    // edit when there were five phones in about the four they never heard of, so the count
    // is rendered rather than swallowed.
    const rendered = renderTemplate(FALLBACK_LOCALE, 'order.quote_revised.customer', {
      ...CONTEXT,
      coalescedCount: 4,
    });

    expect(rendered?.body).toContain('5 ครั้ง');
  });

  it('returns undefined for a key it cannot render, rather than a placeholder', () => {
    // The worker turns this into a permanent failure and a dead row naming the key. The
    // alternative — "order.delivered.customer" arriving in a customer's inbox — is the
    // failure this assertion exists to prevent.
    expect(renderTemplate(FALLBACK_LOCALE, 'order.nonexistent.customer', CONTEXT)).toBeUndefined();
    expect(hasTemplate(FALLBACK_LOCALE, 'order.nonexistent.customer')).toBe(false);
  });
});

describe('locale resolution — plan 10.6', () => {
  it('prefers the account language, then the order’s contact language', () => {
    // The account column does not exist yet (phase 6). The seam takes it anyway, so adding
    // `users.preferred_locale` is a change to one query and not to this ordering.
    expect(preferredLocaleOf({ contactLocale: 'th' })).toBe('th');
    expect(preferredLocaleOf({ accountLocale: 'en', contactLocale: 'th' })).toBe('en');
    expect(preferredLocaleOf({ accountLocale: '   ', contactLocale: 'th' })).toBe('th');
    expect(preferredLocaleOf({ accountLocale: null, contactLocale: 'th' })).toBe('th');
  });

  it('matches a region subtag against the base language', () => {
    // A browser reports `th-TH`. Failing to match it against a `th` catalogue would send
    // Thai customers the fallback — which is also Thai today, which is exactly why the bug
    // would go unnoticed until the day it is not.
    expect(resolveRenderLocale('th-TH', KEY).rendered).toBe('th');
    expect(resolveRenderLocale('TH', KEY).rendered).toBe('th');
    expect(resolveRenderLocale('th_TH', KEY).rendered).toBe('th');
  });

  it('records the requested language even when it cannot be honoured', () => {
    // This is the whole point of returning a pair. `notification_attempts.locale` stores the
    // *rendered* value, so "we sent them Thai because we have no English yet" is a fact in
    // the evidence table rather than something reconstructed during a dispute.
    const resolved = resolveRenderLocale('en-GB', KEY);

    expect(resolved.requested).toBe('en-GB');
    expect(resolved.rendered).toBe('th');
    // 6a: and it is now marked as a degradation rather than left to be inferred from
    // `requested !== rendered`, which is also true of `th-TH` → `th` and is not one.
    expect(resolved.degraded).toBe(true);
    expect(resolveRenderLocale('th-TH', KEY).degraded).toBe(false);
  });

  it('falls back per template, not per language', () => {
    // ⭐ 6a widened SUPPORTED_LOCALES from one to eight. Had `resolveRenderLocale` stayed
    // "is this in the list?", `en` would now resolve to `en`, `renderTemplate` would return
    // undefined, and the worker treats undefined as a PERMANENT failure — every recipient
    // who ever set a preference would have stopped receiving mail, silently, into the dead
    // queue. The resolution is per template key for exactly that reason.
    expect(isSupportedLocale('en')).toBe(true);
    expect(hasTemplate('en', KEY)).toBe(false);
    expect(resolveRenderLocale('en', KEY).rendered).toBe('th');

    // And the day an English template for one event lands, that event resolves to `en`
    // while the others still resolve to `th`. Asserted through the same predicate the
    // resolver uses, so this cannot pass while the resolver asks a different question.
    const covered = (locale: SupportedLocale, key: string): boolean => hasTemplate(locale, key);
    expect(covered('th', KEY)).toBe(true);
    expect(covered('th', 'order.nonexistent.customer')).toBe(false);
  });

  it('a key that is only on Object.prototype is not a template', () => {
    // Reachable from `notification_rules.template_key`, which is a `text` column a migration
    // writes. `hasTemplate` used `Object.hasOwn` and answered `false` for all four below;
    // `renderTemplate` used a bare index and did not, so the two disagreed about what a
    // template is and the renderer's own doc comment ("never a placeholder") was false.
    //
    // Measured on the real object before the fix:
    //   'toString'       → rendered the string "[object Undefined]"
    //   'constructor'    → an email whose subject and body were both literally `undefined`
    //   'valueOf'        → threw, and a throw in the worker is a RETRIED delivery rather
    //                      than a dead row somebody reads
    for (const key of ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__']) {
      expect(hasTemplate('th', key), key).toBe(false);
      expect(renderTemplate('th', key, CONTEXT), key).toBeUndefined();
    }
  });

  it('supports the eight languages the plan names', () => {
    expect([...SUPPORTED_LOCALES]).toStrictEqual(['de', 'en', 'hi', 'la', 'my', 'th', 'vi', 'zh']);
    expect(FALLBACK_LOCALE).toBe('th');
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ A MESSAGE ABOUT A QUOTATION HAS TO CONTAIN THE QUOTATION.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Before this, `grep -n 'http' templates.ts` returned nothing. Every customer message
 * described something that had happened to a document the customer had no way to open — and
 * `order.quote_revised.customer` went further than that. It told them:
 *
 *   *"ท่านมีสิทธิ์ตรวจสอบรายการที่เปลี่ยนแปลงและ **คัดค้าน** ได้ก่อนชำระเงิน"*
 *
 * …and then, in brackets, that the screen for doing so did not exist yet. That is a message
 * promising a right the product does not implement, sent at the exact moment a customer's
 * agreed price has been changed by somebody else. Plan 10.3 marks it 🔴 for that reason.
 *
 * ── What is asserted, and what is deliberately not ───────────────────────────
 *
 * `documentUrl` is **optional** on the context, and the tests below cover both shapes. Not
 * every message is about a document — a delivery notice is not — and more importantly a
 * misconfigured deployment must still send. A template that interpolated `undefined` into a
 * sentence would put "โปรดดูที่ undefined" in a customer's inbox, which is worse than a
 * message with no link in it.
 */

const WITH_LINK = { ...CONTEXT, documentUrl: 'https://wewin.example/th/orders?t=abc.def.ghi' } as const;

describe('⭐ the quotation messages carry the quotation', () => {
  it.each(['order.submitted_for_payment.customer', 'order.quote_revised.customer'])(
    '%s links to the document',
    (key) => {
      const rendered = renderTemplate(FALLBACK_LOCALE, key, WITH_LINK);

      expect(rendered?.body).toContain(WITH_LINK.documentUrl);
    },
  );

  it('⚠️ says nothing about a link when there is none', () => {
    /*
     * The half that keeps a deployment safe. `NOTIFY_WEB_BASE_URL` unset is a configuration
     * mistake, not a reason to stop telling customers their order was received — and it must
     * not become a sentence with a hole in it either.
     */
    for (const key of ['order.submitted_for_payment.customer', 'order.quote_revised.customer']) {
      const rendered = renderTemplate(FALLBACK_LOCALE, key, CONTEXT);

      expect(rendered?.body, key).not.toContain('undefined');
      expect(rendered?.body, key).not.toContain('http');
      /* Still a message worth sending: the greeting, the substance and the sign-off. */
      expect(rendered?.body.length, key).toBeGreaterThan(80);
    }
  });

  it('⭐ no longer promises a screen that does not exist', () => {
    /*
     * The bracketed apology in `order.quote_revised.customer` was load-bearing prose: it was
     * the honest admission that the right the sentence above it granted had nowhere to be
     * exercised. Now that the customer can open the revised document, the apology is a lie in
     * the other direction and this is what stops it being copied forward.
     */
    const rendered = renderTemplate(FALLBACK_LOCALE, 'order.quote_revised.customer', WITH_LINK);

    expect(rendered?.body).not.toContain('เมื่อระบบส่วนนั้นเปิดใช้งาน');
  });

  it('⚠️ a staff message never carries a customer link', () => {
    /*
     * The internal queue is read by people who hold `orders.read` and can open the order
     * properly. A bearer link in an internal inbox is a bearer link one forward away from
     * being outside the company, for no benefit at all.
     */
    for (const key of templateKeys(FALLBACK_LOCALE).filter((k) => k.endsWith('.sales'))) {
      expect(renderTemplate(FALLBACK_LOCALE, key, WITH_LINK)?.body, key).not.toContain(
        WITH_LINK.documentUrl,
      );
    }
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ แจ้งเตือนยอดค้างชำระ — THE ONE MESSAGE WHOSE CONTENT IS A NUMBER.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Everything else in this catalogue describes something that happened. This one exists to say
 * *how much*, which makes it the first template with two properties nothing here had to check
 * before:
 *
 *   ⓵ it must **refuse** rather than render when it has no figure. An email that says "you owe"
 *     with nothing after it is worse than a dead row an engineer reads.
 *   ⓶ the figure must be the **locale's** rendering of the value and must never have been
 *     written into a translated string. Eight catalogues each carrying their own copy of a
 *     total is eight chances for one of them to round differently, and nobody finds out until
 *     a customer asks.
 *
 * `formatMoney` is imported here and used as the *expectation* deliberately: the assertion is
 * that the renderer called the same function `apps/web` draws prices with, not that it produced
 * one particular string — a string literal here would pass just as well against a template that
 * had hard-coded Thai digits into all eight languages, which is the failure being guarded.
 */

const REMINDER = 'order.balance_reminded.customer';
const OWED = 552_960n;

describe('⭐ the balance reminder', () => {
  it('renders in all eight languages, and names the amount in each', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const rendered = renderTemplate(locale, REMINDER, { ...CONTEXT, outstandingThbMinor: OWED });

      expect(rendered, locale).toBeDefined();
      expect(rendered?.subject.length, locale).toBeGreaterThan(0);
      /* The locale's own formatter — Burmese digits, German's trailing symbol, Hindi's lakhs. */
      expect(rendered?.body, locale).toContain(formatMoney(locale, OWED, 'THB', 'exact'));
      expect(rendered?.body, locale).not.toContain('undefined');
      expect(rendered?.body, locale).not.toContain('${');
      expect(rendered?.body, locale).toContain('25-000123');
    }
  });

  it('⚠️ states the satang, because that is the figure the customer will type into a bank app', () => {
    /*
     * `formatBaht`'s whole-baht rounding turns ฿5,529.60 into ฿5,530 — a different number from
     * the one the payment page shows, asked for by a company that then cannot reconcile the
     * transfer. `'exact'` is what `apps/web`'s `bahtExact` uses on the same figure.
     */
    const body = renderTemplate('th', REMINDER, { ...CONTEXT, outstandingThbMinor: OWED })?.body;

    expect(body).toContain(formatMoney('th', OWED, 'THB', 'exact'));
    expect(body).not.toContain(formatMoney('th', OWED, 'THB', 'whole'));
  });

  it('⭐ refuses to render at all when it was given no amount', () => {
    /*
     * The property this template's optionality rests on. The worker turns `undefined` into a
     * **permanent** failure with a sentence naming which of the two `undefined`s it was, so this
     * lands in the dead queue rather than in an inbox with a hole where the money should be.
     */
    for (const locale of SUPPORTED_LOCALES) {
      expect(
        renderTemplate(locale, REMINDER, { orderNo: '25-000123', contactName: null, coalescedCount: 0 }),
        locale,
      ).toBeUndefined();
    }

    /* And it is a refusal by the *renderer*, not a template that is missing: the key exists. */
    expect(hasTemplate('my', REMINDER)).toBe(true);
  });

  it('⚠️ keeps the amount out of every translated sentence, on its own line under a label', () => {
    /*
     * The mechanical half of the "no number in a translated string" rule. If the figure were
     * ever interpolated into prose, the line it lands on would carry words as well as digits.
     * Asserted in all eight, because the rule is about the seven a reviewer here cannot read.
     */
    for (const locale of SUPPORTED_LOCALES) {
      const rendered = renderTemplate(locale, REMINDER, { ...CONTEXT, outstandingThbMinor: OWED });
      const amount = formatMoney(locale, OWED, 'THB', 'exact');
      const line = (rendered?.body ?? '').split('\n').find((candidate) => candidate.includes(amount));

      expect(line, locale).toBe(amount);
      /* …and never in the subject, which is prose in every language. */
      expect(rendered?.subject, locale).not.toContain(amount);
    }
  });

  it('carries the link when there is one, and survives its absence', () => {
    const withLink = renderTemplate('th', REMINDER, {
      ...CONTEXT,
      outstandingThbMinor: OWED,
      documentUrl: WITH_LINK.documentUrl,
    });
    const without = renderTemplate('th', REMINDER, { ...CONTEXT, outstandingThbMinor: OWED });

    expect(withLink?.body).toContain(WITH_LINK.documentUrl);
    /* `NOTIFY_WEB_BASE_URL` unset is a configuration mistake and not a reason to withhold a bill. */
    expect(without?.body).not.toContain('http');
    expect(without?.body).not.toContain('undefined');
    expect(without?.body).toContain(formatMoney('th', OWED, 'THB', 'exact'));
  });

  it('⚠️ says it in words this application already uses', () => {
    /*
     * No new Thai for money. `ยอดคงค้าง` is what the API, the dashboard's filter heading and the
     * approval inbox call a balance; `แจ้งชำระเงิน` is `payment.heading` on the storefront the
     * link points at; `ติดต่อทีมขาย` is that same catalogue's closing sentence. A customer who
     * clicks through from this email should read the same words on the page they land on.
     */
    const rendered = renderTemplate('th', REMINDER, { ...CONTEXT, outstandingThbMinor: OWED });

    expect(rendered?.subject).toContain('แจ้งชำระเงิน');
    expect(rendered?.body).toContain('ยอดคงค้าง');
    expect(rendered?.body).toContain('ค้างชำระ');
    expect(rendered?.body).toContain('ติดต่อทีมขาย');
  });

  it('greets a customer whose name and order number we never got', () => {
    const rendered = renderTemplate('en', REMINDER, {
      orderNo: null,
      contactName: '   ',
      coalescedCount: 0,
      outstandingThbMinor: OWED,
      /* Both figures, or it refuses — and this test is about the greeting, not the money. */
      nextDueThbMinor: OWED,
    });

    expect(rendered?.body).toContain('Dear customer,');
    expect(rendered?.body).not.toContain('null');
    expect(rendered?.subject).toContain('your quotation');
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ ⓶ THE EMAIL AND THE SCREEN IT LINKS TO NAME THE SAME NUMBERS.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The defect these close, exactly as it was found: on a 30/70 order with nothing paid the
 * message said **"ยอดคงค้างทั้งหมด ฿14,791.68"** and the link under it opened a screen whose
 * amount field was prefilled with `nextDueThbMinor` — **฿4,437.50**. One customer, one click,
 * two answers to "what do I owe", and nothing on either surface to say which was which.
 *
 * ⚠️ **The convention is not invented here and must not be.** The owner already chose
 * *"ที่ต้องจ่ายตอนนี้ + ค้างทั้งหมด"*, and `@wewin/core/owed-figures` is that choice: the
 * actionable figure leads, the total supports it, and the two collapse to one line when they
 * are the same number. `MyQuotations` and `PaymentIsland` render it; this is the third surface
 * calling the same function, which is why these tests assert the *shape* — order, labels, one
 * line or two — rather than a sentence somebody could satisfy by writing a new one.
 */

/** WW-1002's 30/70: nothing paid, so the deposit is due and the whole debt sits behind it. */
const OWED_30_70 = 1_479_168n; // ฿14,791.68
const DUE_30_70 = 443_750n; // ฿4,437.50

/** The line a figure was printed on, and the label line directly above it. */
const figureLines = (body: string, amount: string): { index: number; label: string } => {
  const lines = body.split('\n');
  const index = lines.indexOf(amount);
  return { index, label: index <= 0 ? '' : (lines[index - 1] ?? '') };
};

describe('⭐ the reminder states both figures, in the order the payment screen does', () => {
  it('names what is payable now FIRST and the whole debt after it, in all eight', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const body =
        renderTemplate(locale, REMINDER, {
          ...CONTEXT,
          outstandingThbMinor: OWED_30_70,
          nextDueThbMinor: DUE_30_70,
        })?.body ?? '';

      const dueNow = figureLines(body, formatMoney(locale, DUE_30_70, 'THB', 'exact'));
      const outstanding = figureLines(body, formatMoney(locale, OWED_30_70, 'THB', 'exact'));

      /*
       * ⛔ THE ASSERTION THE DEFECT TURNS ON. Both figures present — an email naming only the
       * total is the bug as found, and one naming only the instalment is the mirror of it,
       * where a customer concludes the order costs ฿4,437.50.
       */
      expect(dueNow.index, `${locale}: the payable figure is missing`).toBeGreaterThanOrEqual(0);
      expect(outstanding.index, `${locale}: the outstanding is missing`).toBeGreaterThanOrEqual(0);

      /* Reading order is the whole of the emphasis available in plain text. */
      expect(dueNow.index, locale).toBeLessThan(outstanding.index);

      /*
       * Each under its own label, and the two labels are different words. Identical labels
       * would print two numbers as if they answered the same question, which is the confusion
       * being removed rather than a smaller version of it.
       */
      expect(dueNow.label.length, locale).toBeGreaterThan(0);
      expect(outstanding.label.length, locale).toBeGreaterThan(0);
      expect(dueNow.label, locale).not.toBe(outstanding.label);

      /* ⚠️ Still label-then-digits, never a sentence with a hole: the amount is the whole line. */
      expect(body.split('\n')[dueNow.index], locale).toBe(
        formatMoney(locale, DUE_30_70, 'THB', 'exact'),
      );
    }
  });

  it('⚠️ borrows the storefront’s own words, so the email and the page agree', () => {
    /*
     * Verbatim `payment.dueNow` and `payment.outstanding` from `apps/web`'s Thai catalogue. A
     * customer who clicks the link reads the same two labels on the page they land on, and the
     * qualifier "ทั้งหมด" is what tells them the smaller figure sits *inside* the larger one
     * rather than coming after it.
     */
    const body =
      renderTemplate('th', REMINDER, {
        ...CONTEXT,
        outstandingThbMinor: OWED_30_70,
        nextDueThbMinor: DUE_30_70,
      })?.body ?? '';

    expect(body).toContain('ยอดที่ต้องชำระตอนนี้\n฿4,437.50');
    expect(body).toContain('ยอดคงค้างทั้งหมด\n฿14,791.68');
  });

  it('⭐ prints the number ONCE when the two figures agree, and never the “pay now” label', () => {
    /*
     * A pay-in-full order, and a 30/70 whose deposit has been accepted: the balance is both the
     * whole remaining debt and the next instalment. Two labels side by side assert a
     * distinction, so printing one number under both manufactures the confusion this exists to
     * remove — `owedFigures.ts` states that reasoning and this is it, one surface further out.
     */
    for (const locale of SUPPORTED_LOCALES) {
      const body =
        renderTemplate(locale, REMINDER, {
          ...CONTEXT,
          outstandingThbMinor: OWED_30_70,
          nextDueThbMinor: OWED_30_70,
        })?.body ?? '';

      const amount = formatMoney(locale, OWED_30_70, 'THB', 'exact');
      const dueNowLabel = figureLines(
        renderTemplate(locale, REMINDER, {
          ...CONTEXT,
          outstandingThbMinor: OWED_30_70,
          nextDueThbMinor: DUE_30_70,
        })?.body ?? '',
        formatMoney(locale, DUE_30_70, 'THB', 'exact'),
      ).label;

      expect(body.split('\n').filter((line) => line === amount), locale).toHaveLength(1);
      expect(body, locale).not.toContain(dueNowLabel);
    }
  });

  it('refuses when it was told the total and not what is payable now', () => {
    /*
     * ⚠️ Not a silent fall back to one figure. A caller that stopped filling `nextDueThbMinor`
     * would otherwise reintroduce the original defect invisibly — an email naming the total,
     * linking to a screen asking for something else — and the whole point of a refusal is that
     * the failure is a row an engineer reads rather than a message a customer misreads.
     */
    for (const locale of SUPPORTED_LOCALES) {
      expect(
        renderTemplate(locale, REMINDER, {
          orderNo: '25-000123',
          contactName: null,
          coalescedCount: 0,
          outstandingThbMinor: OWED_30_70,
        }),
        locale,
      ).toBeUndefined();
    }
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ ⓵ IT MUST NOT CHASE SOMEBODY WHO HAS ALREADY PAID.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The service refuses `outstanding <= 0` **at the ask**, and then correctly re-reads the figure
 * at send time — where nothing tested it again. So an order settled between the button and the
 * drain produced *"ยอดคงค้างทั้งหมด / ฿0.00"* in a customer's inbox, and an overpaid one produced
 * `-฿150.00`. The window is not theoretical: five retries with backoff, a worker that can be
 * down, a queue that can be backlogged, and an approved write-off that moves a balance to zero
 * as readily as a slip does.
 *
 * Two mechanisms, and they answer different questions:
 *
 *   `sendSuppression`  — *should this queued message go out at all?* Answered before rendering,
 *     so the outbox row is closed as **suppressed**: terminal, undelivered, and not a failure.
 *   the renderer       — *may this message exist?* Answered last, so that any other path into
 *     it produces no message rather than a false one.
 */
describe('⭐ a settled balance is never chased', () => {
  it.each([
    ['settled exactly', 0n],
    ['overpaid', -15_000n],
  ])('refuses to render on an order that is %s, in all eight', (_name, owed) => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(
        renderTemplate(locale, REMINDER, {
          ...CONTEXT,
          outstandingThbMinor: owed,
          nextDueThbMinor: 0n,
        }),
        locale,
      ).toBeUndefined();
    }
  });

  it('⛔ takes the message out of the queue instead of failing it', () => {
    /*
     * `balance_settled`, not a dead row. A dead row is the queue whose sentence is "nobody has
     * been told" — it logs at `error`, it is what an alert keys on, and its one offered action
     * (ส่งซ้ำ) would re-render and re-refuse. A customer who paid promptly is not a delivery
     * failure and must not train anybody to ignore that list.
     */
    expect(sendSuppression(REMINDER, { ...CONTEXT, outstandingThbMinor: 0n })).toBe('balance_settled');
    expect(sendSuppression(REMINDER, { ...CONTEXT, outstandingThbMinor: -15_000n })).toBe(
      'balance_settled',
    );
  });

  it('lets a real balance through, and says nothing about any other message', () => {
    expect(sendSuppression(REMINDER, { ...CONTEXT, outstandingThbMinor: 1n })).toBeUndefined();

    /*
     * ⚠️ Thirteen other templates share this worker and none of them is about money. A
     * suppression rule that answered on template key alone — or on the amount alone — would
     * silently stop delivering order confirmations for settled orders, which is every order
     * that has been paid for.
     */
    expect(sendSuppression('order.delivered.customer', { ...CONTEXT, outstandingThbMinor: 0n })).toBeUndefined();
    expect(sendSuppression('order.payment_confirmed.customer', { ...CONTEXT, outstandingThbMinor: 0n })).toBeUndefined();

    /*
     * ⛔ And an **absent** figure is deliberately not suppressed. That is a caller that failed
     * to build the context — a bug — and it belongs in the dead queue where bugs are read. Only
     * a figure that is present and settled is a non-event.
     */
    expect(
      sendSuppression(REMINDER, { orderNo: null, contactName: null, coalescedCount: 0 }),
    ).toBeUndefined();
  });

  it('names the one template whose content is a number, once', () => {
    /* The worker, the suppression rule and the catalogue read the same constant. */
    expect(BALANCE_REMINDER_TEMPLATE_KEY).toBe(REMINDER);
    expect(hasTemplate('th', BALANCE_REMINDER_TEMPLATE_KEY)).toBe(true);
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ THE HONORIFIC THE CUSTOMER ALREADY WROTE.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `orders.contact_name` is free text the customer fills in on the quotation form, and a Thai
 * speaker writing their own name into a form very often writes `คุณทดสอบ แท็บ`. The greeting
 * prefixed `คุณ` unconditionally, so that customer received `เรียน คุณคุณทดสอบ แท็บ` on every
 * message we ever sent them.
 *
 * ⚠️ It survived a 1901-test suite because every fixture in this file supplies a bare name. It
 * was found by decoding a rendered .eml and reading it — which is the only instrument that was
 * ever going to find it, and the reason these cases are pinned now.
 */
describe('⭐ a name that already carries an honorific', () => {
  const openingOf = (contactName: string, key = 'order.payment_confirmed.customer'): string =>
    renderTemplate('th', key, { ...CONTEXT, contactName })?.body.split('\n')[0] ?? '';

  it('does not add a second คุณ', () => {
    expect(openingOf('คุณทดสอบ แท็บ')).toBe('เรียน คุณทดสอบ แท็บ');
    expect(openingOf('คุณทดสอบ แท็บ')).not.toContain('คุณคุณ');
  });

  it('still adds คุณ to a bare name', () => {
    /* The control. The fix must not have turned the greeting into a passthrough. */
    expect(openingOf('สมชาย')).toBe('เรียน คุณสมชาย');
  });

  it('leaves the other honorifics a customer types alone', () => {
    expect(openingOf('นายสมชาย ใจดี')).toBe('เรียน นายสมชาย ใจดี');
    expect(openingOf('นางสาวมาลี')).toBe('เรียน นางสาวมาลี');
    expect(openingOf('นางมาลี')).toBe('เรียน นางมาลี');
  });

  it('⚠️ applies to the reminder too, which had its own copy of the rule', () => {
    /*
     * The reminder's Thai copy is a separate catalogue entry with its own greeting builder, so
     * fixing only the shared one would have left the single message most likely to be read
     * carefully still doubling the honorific.
     */
    expect(openingOf('คุณทดสอบ แท็บ', BALANCE_REMINDER_TEMPLATE_KEY)).toBe('เรียน คุณทดสอบ แท็บ');
    expect(openingOf('สมชาย', BALANCE_REMINDER_TEMPLATE_KEY)).toBe('เรียน คุณสมชาย');
  });
});
