import { describe, expect, it } from 'vitest';

import {
  unrecognisedDestinationPointsTh,
  unrecognisedDestinationTitleTh,
  vatLabelTh,
} from './quote-alerts';

/**
 * The words on the destination warning, asserted as the pure functions that produce them.
 *
 * `vitest.config.ts` here runs `environment: 'node'` on purpose and its note says why: *"a test
 * that renders a sidebar and asserts it contains three links is a test of `visibleNavigation`,
 * spelled expensively"*. So the banner's **content** — the thing that decides what a person does
 * next — is a function of the code and is tested as one, the same treatment
 * `tests/navigation.test.ts` gives `visibleNavigation`. Whether the component is mounted on the
 * editor is wiring, and wiring is checked by opening the screen.
 *
 * ⚠️ These are not string-equality tests dressed up. Each assertion below is one of the three
 * things a reader has to leave with, and the reason the notice exists at all is that they were
 * previously left with none of them until the submit refused.
 */

describe('the unrecognised-destination notice says what to do about it', () => {
  it('leads with the consequence, not the cause', () => {
    const title = unrecognisedDestinationTitleTh('ZZ');

    /* "cannot be sent" first: it is what changes the reader's next action. The code is why. */
    expect(title).toContain('ส่งใบเสนอราคานี้ไม่ได้');
    expect(title).toContain('ZZ');
  });

  it('warns that the figures on screen are the default rate and not this country’s', () => {
    const points = unrecognisedDestinationPointsTh('ZZ');

    /*
     * ⭐ The assertion worth having. Somebody who reads only the heading may still repeat the
     * total to a customer — the screen looks like a finished quote — and that total came back at
     * `DEFAULT_VAT_RULE`, not at the destination's rate.
     */
    const warning = points.find((point) => point.includes('อัตราเริ่มต้น'));
    expect(warning, 'no sentence says the rate is the default one').toBeDefined();
    expect(warning).toContain('อย่ายืนยันตัวเลขนี้กับลูกค้า');
  });

  it('names both ways out, because they belong to two different people', () => {
    const points = unrecognisedDestinationPointsTh('ZZ');
    const recovery = points.join(' ');

    /* The salesperson's: submit naming a country that resolves. */
    expect(recovery).toContain('ระบุประเทศปลายทางที่ถูกต้อง');
    /* The administrator's: add the country, then reopen. */
    expect(recovery).toContain('ตั้งค่าบริษัท');
  });

  it('renders a missing code as a dash rather than the word undefined', () => {
    /* `country` is nullable on the wire. It cannot be null *and* unrecognised today — a null
     * code resolves to the default and is `recognised: true` — but the type permits it, and
     * `"undefined"` printed inside quotation marks on a warning banner is worse than a dash. */
    expect(unrecognisedDestinationTitleTh(null)).toContain('"—"');
    expect(unrecognisedDestinationPointsTh(null).every((point) => !point.includes('undefined'))).toBe(
      true,
    );
  });
});

/**
 * Unchanged by this round, and asserted here because the destination warning deliberately did
 * **not** touch it: `vatLabelTh` is rendered on the customer's own document as well as the staff
 * totals card, so a staff-only warning must not be added to it. The totals card says it instead.
 */
describe('the VAT label stays a statement of the rate and nothing else', () => {
  it('reads the rate out for a standard treatment', () => {
    expect(vatLabelTh(700, 'standard')).toBe('VAT 7%');
    expect(vatLabelTh(900, 'standard')).toBe('VAT 9%');
  });

  it('carries no warning wording for any treatment', () => {
    for (const treatment of ['standard', 'zero_rated', 'exempt', 'out_of_scope']) {
      expect(vatLabelTh(700, treatment)).not.toContain('ไม่ใช่');
    }
  });
});
