import { describe, expect, it } from 'vitest';

import { FALLBACK_LOCALE, resolveRenderLocale, preferredLocaleOf } from '../../src/notifications/locale';
import { hasTemplate, renderTemplate, templateKeys } from '../../src/notifications/templates/templates';

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
    expect(resolveRenderLocale('th-TH').rendered).toBe('th');
    expect(resolveRenderLocale('TH').rendered).toBe('th');
    expect(resolveRenderLocale('th_TH').rendered).toBe('th');
  });

  it('records the requested language even when it cannot be honoured', () => {
    // This is the whole point of returning a pair. `notification_attempts.locale` stores the
    // *rendered* value, so "we sent them Thai because we have no English yet" is a fact in
    // the evidence table rather than something reconstructed during a dispute.
    const resolved = resolveRenderLocale('en-GB');

    expect(resolved.requested).toBe('en-GB');
    expect(resolved.rendered).toBe('th');
  });
});
