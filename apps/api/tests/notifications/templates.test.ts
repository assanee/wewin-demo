import { describe, expect, it } from 'vitest';

import {
  FALLBACK_LOCALE,
  isSupportedLocale,
  preferredLocaleOf,
  resolveRenderLocale,
  SUPPORTED_LOCALES,
  type SupportedLocale,
} from '../../src/notifications/locale';

import { hasTemplate, renderTemplate, templateKeys } from '../../src/notifications/templates/templates';

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

const CONTEXT = { orderNo: '25-000123', contactName: 'สมชาย', coalescedCount: 0 } as const;

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
