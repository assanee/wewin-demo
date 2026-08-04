import { describe, expect, it } from 'vitest';

import { AppError } from '../../src/common/errors/app-error';
import type { OrderActor } from '../../src/orders/transitions';
import {
  assertActorMayMove,
  faultFor,
  parseTransitionBody,
  payloadSchemaFor,
  type TransitionRow,
} from '../../src/orders/transitions';

/**
 * Plan 7.4 trap 4, and the two rules that decide money — with no database and no HTTP.
 *
 * Every assertion here is written so that **removing the fix makes it fail**, and each block
 * says which mutation it is aimed at. That is the discipline plan 4.7 records the hard way:
 * the first mutation tried on the pricing suite was too small to move the result, so it
 * proved nothing at all.
 *
 * What this file cannot prove, and where that is proved instead: that the payload kind is
 * read from the *loaded order* rather than guessed from the route. That is a property of the
 * call sequence in `orders.service.ts` and it is pinned end-to-end in `lifecycle.pg.test.ts`
 * — a post-freeze cancellation whose stored event carries `fault`, which the pre-freeze
 * schema has no field for and the database's `required_payload_keys` refuses to do without.
 */

const STAFF: OrderActor = {
  actorKind: 'staff',
  actorUserId: '3f1c2d4e-0000-4000-8000-0000000000a1',
  actorGuestId: null,
};

const CUSTOMER: OrderActor = {
  actorKind: 'customer',
  actorUserId: '3f1c2d4e-0000-4000-8000-0000000000c1',
  actorGuestId: null,
};

const GUEST: OrderActor = {
  actorKind: 'guest',
  actorUserId: null,
  actorGuestId: '0190bd3f-9e6a-7c2b-8f11-2a4b6c8d0e01',
};

const statusOf = (thrown: unknown): number | undefined =>
  thrown instanceof AppError ? thrown.status : undefined;

const caught = (run: () => unknown): unknown => {
  try {
    run();
    return undefined;
  } catch (error) {
    return error;
  }
};

describe('choosing the payload schema — trap 4', () => {
  it('gives the two cancellations different schemas, which is the whole of the trap', () => {
    /*
     * If these were the same object, every fix below would be decoration: the pre-freeze
     * body would be accepted for a post-freeze cancellation and `fault` would never be
     * derived. This is the assertion that fails first if somebody "simplifies" the switch.
     */
    expect(payloadSchemaFor('cancel_pre_freeze', 'staff')).not.toBe(
      payloadSchemaFor('cancel_post_freeze', 'staff'),
    );
  });

  it('refuses a staff post-freeze body under the pre-freeze schema, rather than stripping it', () => {
    /*
     * The mutation this is aimed at: choose the schema from the *destination status* alone.
     * Both cancel rows end at `cancelled`, so that choice always yields `cancel_pre_freeze`
     * — and with a non-strict schema zod would silently drop `attributeFaultToCompany` and
     * the call would succeed having quietly decided the refund in the customer's disfavour.
     *
     * `z.strictObject` turns that silence into a 400. It is the second of the three fixes,
     * and the only one a unit test can see.
     */
    const body = { reason: 'ผลิตไม่ได้ตามแบบ', attributeFaultToCompany: true };

    const wrong = caught(() => parseTransitionBody('cancel_pre_freeze', STAFF, body));
    expect(statusOf(wrong)).toBe(400);

    const right = parseTransitionBody('cancel_post_freeze', STAFF, body);
    expect(right).toStrictEqual({ payloadKind: 'cancel_post_freeze', body });
  });

  it('has no field for attributing fault when the actor is not staff', () => {
    /*
     * 🔒 Plan 7.8: `fault` decides how much money goes back, so a customer must not be able
     * to set it. The refusal is visible rather than silent on purpose — an attempt to grant
     * oneself a full refund should not look to the client like it worked.
     */
    const body = { reason: 'เปลี่ยนใจ', attributeFaultToCompany: true };

    for (const actor of [CUSTOMER, GUEST]) {
      expect(statusOf(caught(() => parseTransitionBody('cancel_post_freeze', actor, body)))).toBe(400);
    }

    expect(parseTransitionBody('cancel_post_freeze', CUSTOMER, { reason: 'เปลี่ยนใจ' })).toStrictEqual({
      payloadKind: 'cancel_post_freeze',
      body: { reason: 'เปลี่ยนใจ' },
    });
  });

  it('refuses a body on a transition that takes none, and accepts an absent one', () => {
    /*
     * `none` is `production_started`, `installation_scheduled`, `delivered` — the moves that
     * carry no decision. A body arriving on one of them is a caller who thinks they are
     * saying something that will be recorded, and they are not.
     */
    expect(parseTransitionBody('none', STAFF, undefined)).toStrictEqual({
      payloadKind: 'none',
      body: {},
    });
    expect(statusOf(caught(() => parseTransitionBody('none', STAFF, { reason: 'x' })))).toBe(400);
  });

  it('refuses a cancellation with no reason at all', () => {
    // The only account of why an order was cancelled that anybody will ever have.
    for (const body of [{}, { reason: '' }, { reason: '   ' }]) {
      expect(statusOf(caught(() => parseTransitionBody('cancel_pre_freeze', CUSTOMER, body)))).toBe(400);
    }
  });

  it('takes no money on any transition body', () => {
    /*
     * Plan 7.9(ก): the computed layer is the machine's. The two moves that most obviously
     * *involve* a number — approving a redesign, which records what the company absorbed, and
     * confirming a payment — have no amount field, because both figures are derived from rows
     * the server holds. A field that is not on the wire cannot be forged on the wire.
     */
    const amounts = [
      { absorbedDeltaThbMinor: '100000' },
      { absorbed_delta_thb_minor: '100000' },
      { amountMinor: '100000' },
      { grandTotalThbMinor: '100000' },
    ];

    for (const body of amounts) {
      expect(statusOf(caught(() => parseTransitionBody('approve_redesign', STAFF, body)))).toBe(400);
      expect(statusOf(caught(() => parseTransitionBody('confirm_payment', STAFF, body)))).toBe(400);
    }
  });
});

describe('fault — plan 7.8, 🔒 derived and never accepted', () => {
  it('is always the customer when the customer or the guest is cancelling', () => {
    for (const actor of [CUSTOMER, GUEST]) {
      expect(
        faultFor({ actor, requestedCompanyFault: true, hasBounceOnSpine: true }),
      ).toBe('customer');
    }
  });

  it('is the company only when staff ask for it AND the spine carries a real bounce', () => {
    expect(
      faultFor({ actor: STAFF, requestedCompanyFault: true, hasBounceOnSpine: true }),
    ).toBe('company');

    expect(
      faultFor({ actor: STAFF, requestedCompanyFault: false, hasBounceOnSpine: true }),
    ).toBe('customer');
  });

  it('refuses the claim rather than downgrading it, when there is no bounce on record', () => {
    /*
     * The failure mode this is about is not a wrong number, it is a *silent* one: a member of
     * staff who believes they have just granted a full refund and has not. 422 with a reason
     * beats `'customer'` returned quietly.
     */
    const thrown = caught(() =>
      faultFor({ actor: STAFF, requestedCompanyFault: true, hasBounceOnSpine: false }),
    );

    expect(statusOf(thrown)).toBe(422);
    expect(thrown).toBeInstanceOf(AppError);
  });
});

describe('the actor kind is necessary and never sufficient', () => {
  const row: TransitionRow = {
    fromStatus: 'production_confirmed',
    toStatus: 'in_production',
    eventType: 'production_started',
    payloadKind: 'none',
    requiredPayloadKeys: [],
    allowedActorKinds: ['staff'],
    descriptionTh: 'โรงงานเริ่มตัดอะลูมิเนียม',
  };

  it('refuses an actor the transition row does not list', () => {
    for (const actor of [CUSTOMER, GUEST]) {
      expect(statusOf(caught(() => assertActorMayMove(row, actor)))).toBe(403);
    }
    expect(caught(() => assertActorMayMove(row, STAFF))).toBeUndefined();
  });

  it('says nothing about *which* order — that is the query, and this is only the kind', () => {
    /*
     * Plan 7.4 trap 2, stated as a property of this function: it is handed no order at all.
     * It cannot be the ownership check, and a reader who mistakes it for one has to explain
     * where the order id would have come from. Ownership is `orderReach` and the WHERE clause
     * it compiles to — see `tests/orders/scope/`.
     */
    expect(assertActorMayMove.length).toBe(2);
    expect(caught(() => assertActorMayMove({ ...row, allowedActorKinds: ['customer'] }, CUSTOMER))).toBeUndefined();
  });
});
