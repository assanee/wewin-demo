import { describe, expect, it } from 'vitest';

import {
  ORDER_STATUSES,
  PAYLOAD_KINDS,
  statusLabel,
  transitionForm,
  type PayloadKind,
} from '../src/components/orders/order-language';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Two tables the dashboard keeps about the API, and what happens when they slip.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `turbo boundaries` stops this app importing from apps/api, so every wire vocabulary it
 * renders is a local restatement. That debt is recorded in plan 12.1 and mitigated the same
 * way everywhere: decode at runtime, and test the tables. These two are the ones that hurt.
 *
 *   `statusLabel`     a status with no Thai label renders as `awaiting_installation` to a
 *                     person who reads Thai. Nothing throws, nothing 500s, and the screen is
 *                     simply wrong for one status out of nine — the rare one, because the
 *                     common ones get looked at.
 *
 *   `transitionForm`  a payload kind mapped to the wrong fields posts a body the API refuses.
 *                     `cancel` is the sharp case: it is **two rows** in
 *                     `order_status_transitions`, split at the freeze, with different bodies —
 *                     plan 7.4 trap 4 is a controller that chose its schema from the verb's
 *                     name and got the post-freeze one wrong.
 */

describe('every status a person can be shown has Thai', () => {
  it('labels all ten', () => {
    /*
     * Ten, written out. The API's `ORDER_STATUSES_WIRE` is the definition and this app may not
     * import it; asserting the count here is what makes an eleventh status arriving from a
     * newer API a failing test rather than a raw enum on a screen.
     *
     * ⚠️ It did exactly that for `awaiting_confirmation`: the API grew a tenth status and this
     * assertion is what said so, before anybody saw `awaiting_confirmation` rendered raw on the
     * orders list.
     */
    expect(ORDER_STATUSES).toHaveLength(10);

    for (const status of ORDER_STATUSES) {
      const label = statusLabel(status);

      expect(label, `${status} has no Thai label`).not.toBe('');
      expect(label, `${status} is being rendered as its own wire code`).not.toBe(status);
      // A Thai label, not a romanisation somebody left as a placeholder.
      expect(label, `${status} is labelled in ASCII`).toMatch(/[฀-๿]/);
    }
  });

  it('⚠️ shows an unknown status as itself rather than as nothing', () => {
    /*
     * The API is versioned separately from this bundle. A status this build has never heard
     * of should render as the code — ugly, obviously wrong, reportable — and not as an empty
     * cell, which reads as "this order has no status" and is the more expensive confusion.
     */
    expect(statusLabel('teleported' as (typeof ORDER_STATUSES)[number])).toBe('teleported');
  });
});

describe('⭐ each transition asks for exactly the body its endpoint demands', () => {
  it('covers every payload kind the API can send', () => {
    /*
     * Nine since 0054's `authorise_unpaid`. The count is what turns "the API grew a payload
     * kind this dashboard cannot build a body for" into a failing test rather than a greyed-out
     * button somebody reports weeks later — which is exactly how that kind was noticed.
     */
    expect(PAYLOAD_KINDS).toHaveLength(9);

    for (const kind of PAYLOAD_KINDS) {
      expect(transitionForm(kind), `${kind} has no form`).toBeDefined();
    }
  });

  it('asks for nothing when the endpoint takes an empty body', () => {
    const form = transitionForm('none');

    expect(form.fields).toStrictEqual([]);
    expect(form.offered).toBe(true);
  });

  it('⚠️ demands a reason for every cancellation, on both sides of the freeze', () => {
    /*
     * `reason` is `z.string().trim().min(1)`. An optional field here would let somebody
     * cancel an order with an empty box, get a 422, and have no idea which field was
     * missing — the request body would be `{}` and the message a schema error.
     */
    for (const kind of ['cancel_pre_freeze', 'cancel_post_freeze', 'bounce', 'supersede'] as const) {
      const reason = transitionForm(kind).fields.find((field) => field.name === 'reason');

      expect(reason, `${kind} does not ask for a reason`).toBeDefined();
      expect(reason?.required, `${kind}'s reason is optional`).toBe(true);
    }
  });

  it('⭐ offers fault attribution only after the freeze', () => {
    /*
     * The distinction plan 7.4 trap 4 is about. Before the freeze nothing has been cut, so
     * there is no forfeit to attribute and `cancelOrderRequestSchema` is `strictObject` —
     * sending `attributeFaultToCompany` is a 422, not an ignored field. After the freeze it
     * is the field that decides who bears the cost.
     */
    const fieldNames = (kind: PayloadKind) => transitionForm(kind).fields.map((f) => f.name);

    expect(fieldNames('cancel_pre_freeze')).toStrictEqual(['reason']);
    expect(fieldNames('cancel_post_freeze')).toStrictEqual(['reason', 'attributeFaultToCompany']);
  });

  it('takes an optional note where the endpoint takes one', () => {
    for (const kind of ['confirm_payment', 'approve_redesign'] as const) {
      const note = transitionForm(kind).fields.find((field) => field.name === 'noteTh');

      expect(note, `${kind} does not offer a note`).toBeDefined();
      expect(note?.required, `${kind}'s note should be optional`).toBe(false);
    }
  });

  it('⚠️ does not offer submit, because it is the customer’s move and needs their cart', () => {
    /*
     * `submit` appears in `availableTransitions` for a draft, and it is the one kind this
     * screen must refuse to render a button for: its body is `{ contact, lines }` — an
     * address and a priced cart, neither of which a staff order screen holds. A button that
     * posted `{}` would 422 every time; a button that guessed would submit somebody's order
     * with invented contents.
     */
    const form = transitionForm('submit');

    expect(form.offered).toBe(false);
    expect(form.whyNotTh, 'refusing a button without saying why is just a missing button').not.toBe(
      '',
    );
  });
});

describe('the body that actually gets posted', () => {
  it('sends an empty object for a payload-free transition', () => {
    expect(transitionForm('none').body({})).toStrictEqual({});
  });

  it('trims, and drops an optional field left blank', () => {
    /*
     * `noteSchema` is `.trim().min(1)`, so a note of three spaces is a 422 rather than an
     * empty note. Dropping the key is the difference between "no note" and "a note that is
     * whitespace".
     */
    expect(transitionForm('confirm_payment').body({ noteTh: '   ' })).toStrictEqual({});
    expect(transitionForm('confirm_payment').body({ noteTh: '  เงินเข้าแล้ว  ' })).toStrictEqual({
      noteTh: 'เงินเข้าแล้ว',
    });
  });

  it('⚠️ omits the fault checkbox when it is not ticked', () => {
    /*
     * `attributeFaultToCompany: false` and *absent* mean the same thing to the API, and they
     * do not mean the same thing in a log: the schema's field is `.optional()`, and sending
     * an explicit `false` records a decision somebody did not consciously take. The default
     * is the customer bearing the forfeit, and that should be the absence of a claim rather
     * than a claim of absence.
     */
    expect(
      transitionForm('cancel_post_freeze').body({ reason: 'ลูกค้าขอยกเลิก' }),
    ).toStrictEqual({ reason: 'ลูกค้าขอยกเลิก' });

    expect(
      transitionForm('cancel_post_freeze').body({
        reason: 'วัดขนาดผิด',
        attributeFaultToCompany: true,
      }),
    ).toStrictEqual({ reason: 'วัดขนาดผิด', attributeFaultToCompany: true });
  });
});
