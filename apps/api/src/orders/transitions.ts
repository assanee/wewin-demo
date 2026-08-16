import type { ZodType } from 'zod';
import {
  approveRedesignRequestSchema,
  bounceOrderRequestSchema,
  cancelOrderRequestSchema,
  authoriseUnpaidRequestSchema,
  confirmPaymentRequestSchema,
  emptyTransitionRequestSchema,
  staffCancelOrderRequestSchema,
  submitOrderRequestSchema,
  supersedeOrderRequestSchema,
  type ApproveRedesignRequestWire,
  type BounceOrderRequestWire,
  type CancelOrderRequestWire,
  type AuthoriseUnpaidRequestWire,
  type ConfirmPaymentRequestWire,
  type OrderActorKindWire,
  type OrderEventTypeWire,
  type OrderPayloadKindWire,
  type OrderStatusWire,
  type StaffCancelOrderRequestWire,
  type SubmitOrderRequestWire,
  type SupersedeOrderRequestWire,
} from '@wewin/contract/order';

import { AppError } from '../common/errors/app-error';
import type { orderActor } from './scope/order-actor';

/**
 * Who is acting, as `src/orders/scope` decides it.
 *
 * Derived from that function's return type rather than declared again here, and that is the
 * point: plan 7.4 trap 2 is about *one* definition of who a caller is and what they may
 * reach. A second interface with the same three fields would be a second place to add a
 * fourth actor kind, and the two would agree until the day they did not.
 */
export type OrderActor = NonNullable<ReturnType<typeof orderActor>>;

/**
 * ⚠️ PLAN 7.4 TRAP 4 LIVES IN THIS FILE, AND SO DOES ITS FIX. ⚠️
 *
 * The trap, in the plan's words: `cancel` has two rows — one before the freeze, one after —
 * and if the controller picks its zod schema *by the name of the action*, it gets the
 * pre-freeze one, and zod **strips** the fields the post-freeze one needs. The call then
 * succeeds having quietly dropped the field that decides how much of a customer's money is
 * returned to them.
 *
 * Three things stop it here, and they are three because any one of them can be removed by
 * somebody who does not know why it is there:
 *
 *   1. **Nothing in this file can be called without a `payloadKind`, and a `payloadKind`
 *      cannot be known without the order.** It is a column on `order_status_transitions`,
 *      whose primary key is `(from_status, to_status)` — so the row cannot be found without
 *      `from_status`, and `from_status` cannot be known without loading the order. The
 *      service loads it under `SELECT … FOR UPDATE` *first*; see `orders.service.ts`.
 *
 *   2. **The schemas are strict.** `z.strictObject` refuses an unknown key rather than
 *      dropping it, which converts the trap's silent strip into a 400 the caller can read.
 *      That is a real improvement on the plan's requirement and not a substitute for it:
 *      strictness catches "the wrong schema was chosen" only when the wrong schema is the
 *      *narrower* one.
 *
 *   3. **`required_payload_keys` is checked by the database on the insert.** If both of the
 *      above were somehow bypassed, the event carrying no `fault` fails to write. The
 *      cancellation does not happen at all, rather than happening in somebody's favour.
 *
 * And the field the trap is about never comes from the body in the first place — plan 7.8
 * marks `fault` 🔒. See `faultFor` below.
 */

/**
 * One row of `order_status_transitions`, typed with the *contract's* unions.
 *
 * Deliberately not the database's own: the two lists are separate declarations (a browser
 * cannot import `@wewin/db`), and typing this row from the wire side means the repository's
 * select — which produces the database's unions — only compiles while the two agree. Add a
 * status to one and not the other and `pnpm typecheck` fails before any test runs.
 */
export interface TransitionRow {
  readonly fromStatus: OrderStatusWire;
  readonly toStatus: OrderStatusWire;
  readonly eventType: OrderEventTypeWire;
  readonly payloadKind: OrderPayloadKindWire;
  readonly requiredPayloadKeys: readonly string[];
  readonly allowedActorKinds: readonly string[];
  readonly descriptionTh: string;
}

/** The parsed body, tagged with the kind it was parsed *as*, so nothing downstream re-guesses. */
export type TransitionBody =
  | { readonly payloadKind: 'none'; readonly body: Record<string, never> }
  | { readonly payloadKind: 'submit'; readonly body: SubmitOrderRequestWire }
  | { readonly payloadKind: 'confirm_payment'; readonly body: ConfirmPaymentRequestWire }
  | { readonly payloadKind: 'authorise_unpaid'; readonly body: AuthoriseUnpaidRequestWire }
  | { readonly payloadKind: 'cancel_pre_freeze'; readonly body: CancelOrderRequestWire }
  | { readonly payloadKind: 'cancel_post_freeze'; readonly body: StaffCancelOrderRequestWire }
  | { readonly payloadKind: 'bounce'; readonly body: BounceOrderRequestWire }
  | { readonly payloadKind: 'approve_redesign'; readonly body: ApproveRedesignRequestWire }
  | { readonly payloadKind: 'supersede'; readonly body: SupersedeOrderRequestWire };

/**
 * Which schema a payload kind takes, for an actor of this kind.
 *
 * The actor is part of the choice for exactly one kind, and it is the one that matters:
 * `cancel_post_freeze` accepts `attributeFaultToCompany` from staff and from nobody else.
 * A customer's body carrying that key is *rejected* (strict), not ignored — an attempt to
 * decide one's own refund should not look to the client like it worked.
 */
export function payloadSchemaFor(
  payloadKind: OrderPayloadKindWire,
  actorKind: OrderActorKindWire,
): ZodType<unknown> {
  switch (payloadKind) {
    case 'none':
      return emptyTransitionRequestSchema;
    case 'submit':
      return submitOrderRequestSchema;
    case 'confirm_payment':
      return confirmPaymentRequestSchema;
    case 'authorise_unpaid':
      return authoriseUnpaidRequestSchema;
    case 'cancel_pre_freeze':
      return cancelOrderRequestSchema;
    case 'cancel_post_freeze':
      return actorKind === 'staff' ? staffCancelOrderRequestSchema : cancelOrderRequestSchema;
    case 'bounce':
      return bounceOrderRequestSchema;
    case 'approve_redesign':
      return approveRedesignRequestSchema;
    case 'supersede':
      return supersedeOrderRequestSchema;
  }
}

/**
 * Parse a raw body as the kind the *loaded order* says this move takes.
 *
 * Returns the tagged union so a caller cannot mislay which kind it got. The cast is confined
 * to this function: `payloadSchemaFor` returns `ZodType<unknown>` because its result type
 * depends on a value, and re-deriving that as a conditional type would buy nothing that the
 * discriminated union below does not already give every caller.
 */
export function parseTransitionBody(
  payloadKind: OrderPayloadKindWire,
  actor: OrderActor,
  raw: unknown,
): TransitionBody {
  const parsed = payloadSchemaFor(payloadKind, actor.actorKind).safeParse(raw ?? {});

  if (!parsed.success) {
    throw AppError.badRequest('รูปแบบข้อมูลที่ส่งมาไม่ถูกต้องสำหรับการเปลี่ยนสถานะนี้', {
      payloadKind,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.map((segment) => String(segment)).join('.'),
        message: issue.message,
      })),
    });
  }

  return { payloadKind, body: parsed.data } as TransitionBody;
}

/** Who is to blame, which is the same question as how much money goes back. */
export type OrderFault = 'customer' | 'company';

export interface FaultInput {
  readonly actor: OrderActor;
  /** Staff asked for it in the body. A *claim*, never a value that is stored as given. */
  readonly requestedCompanyFault: boolean;
  /** Whether the spine actually carries a `bounced_to_redesign` event for this order. */
  readonly hasBounceOnSpine: boolean;
}

/**
 * 🔒 `fault` is derived, never accepted — plan 7.8.
 *
 * It decides how much of the money already received is returned, so a customer who could set
 * it would be setting their own refund. Two rules, and the second is the one that is easy to
 * leave out:
 *
 *   * a customer or guest cancelling their own order is always `fault = 'customer'`. Not
 *     because they are always at fault, but because "I changed my mind" and "the company
 *     could not make it" are not the same claim and only the second one has evidence.
 *   * staff may attribute fault to the company **only on an order with a real bounce on
 *     record**. The evidence is a `bounced_to_redesign` event on the append-only spine,
 *     which is a fact neither party can write after the argument starts.
 *
 * A refused claim is a 422 and not a silent downgrade to `customer`: a member of staff who
 * believes they have just granted a full refund and has not is the failure this is about.
 */
export function faultFor(input: FaultInput): OrderFault {
  if (input.actor.actorKind !== 'staff') return 'customer';
  if (!input.requestedCompanyFault) return 'customer';

  if (!input.hasBounceOnSpine) {
    throw AppError.validationFailed(
      'ระบุความผิดเป็นฝ่ายบริษัทได้เฉพาะออร์เดอร์ที่มีบันทึกการตีกลับจากฝ่ายผลิตจริงเท่านั้น',
      { reason: 'no_bounce_on_record' },
    );
  }

  return 'company';
}

/**
 * A necessary condition, checked before the write so the caller gets a sentence.
 *
 * The database checks it too (`order_events_guard_insert`), and neither check is redundant:
 * this one produces 403 with the actor kind and the move in it, that one produces a failed
 * INSERT for the day somebody writes a second code path. What neither of them is, is
 * *sufficient* — see the note at the top of `actor.ts`.
 */
export function assertActorMayMove(row: TransitionRow, actor: OrderActor): void {
  if (row.allowedActorKinds.includes(actor.actorKind)) return;

  throw new AppError(
    'FORBIDDEN',
    403,
    'บทบาทของคุณไม่มีสิทธิ์เปลี่ยนสถานะนี้',
    { from: row.fromStatus, to: row.toStatus, actorKind: actor.actorKind },
  );
}
