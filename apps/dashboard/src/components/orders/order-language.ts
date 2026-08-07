/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The two tables the order screens keep about the API's vocabulary.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠️ Restated from `packages/contract/src/order.ts`, not imported — `turbo boundaries`
 * stops apps/dashboard reaching into apps/api, and the contract package's runtime exports
 * are for the API's own clients. Same debt as `user-api.ts` and `media-api.ts`, recorded in
 * plan 12.1, mitigated the same way: `tests/order-transitions.test.ts` walks both tables and
 * fails when one is short.
 *
 * No React in this file on purpose. Both tables are decisions about *what the API accepts*
 * rather than about layout, and a decision like that should be testable without rendering
 * anything.
 */

export const ORDER_STATUSES = [
  'draft',
  'awaiting_payment',
  'production_confirmed',
  'in_production',
  'awaiting_installation',
  'delivered',
  'redesign',
  'cancelled',
  'superseded',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

const STATUS_TH: Record<OrderStatus, string> = {
  draft: 'ตะกร้า',
  awaiting_payment: 'รอชำระเงิน',
  production_confirmed: 'ยืนยันผลิตแล้ว',
  in_production: 'กำลังผลิต',
  awaiting_installation: 'รอติดตั้ง',
  delivered: 'ส่งมอบแล้ว',
  redesign: 'ขอแก้แบบ',
  cancelled: 'ยกเลิก',
  superseded: 'ถูกแทนที่',
};

/**
 * ⚠️ Falls back to the code itself, never to an empty string.
 *
 * The API is versioned separately from this bundle, so a status this build has never heard
 * of is a real possibility rather than a hypothetical. Rendering the raw code is ugly and
 * reportable; rendering nothing reads as "this order has no status", which is the more
 * expensive confusion and the one somebody acts on.
 */
export function statusLabel(status: OrderStatus): string {
  return STATUS_TH[status] ?? status;
}

/** How loud a status should be. `attention` is for the ones somebody is waiting on. */
export function statusTone(status: OrderStatus): 'attention' | 'live' | 'done' | 'over' {
  switch (status) {
    case 'awaiting_payment':
    case 'redesign':
      return 'attention';
    case 'production_confirmed':
    case 'in_production':
    case 'awaiting_installation':
      return 'live';
    case 'delivered':
      return 'done';
    case 'draft':
    case 'cancelled':
    case 'superseded':
      return 'over';
    default:
      return 'over';
  }
}

export const PAYLOAD_KINDS = [
  'none',
  'submit',
  'confirm_payment',
  'cancel_pre_freeze',
  'cancel_post_freeze',
  'bounce',
  'approve_redesign',
  'supersede',
] as const;

export type PayloadKind = (typeof PAYLOAD_KINDS)[number];

export interface TransitionField {
  readonly name: 'reason' | 'noteTh' | 'attributeFaultToCompany';
  readonly kind: 'text' | 'checkbox';
  readonly labelTh: string;
  readonly required: boolean;
  readonly helpTh?: string;
}

export interface TransitionForm {
  /**
   * Whether this screen renders a button at all.
   *
   * `false` is not "you may not" — the API said the transition is available. It is "this
   * screen cannot build a body for it", which is a different sentence and needs `whyNotTh`.
   */
  readonly offered: boolean;
  readonly whyNotTh: string;
  readonly fields: readonly TransitionField[];
  /** What to POST. Trims, and drops an optional field left blank. */
  readonly body: (values: Values) => Record<string, unknown>;
}

interface Values {
  readonly reason?: string;
  readonly noteTh?: string;
  readonly attributeFaultToCompany?: boolean;
}

const reason: TransitionField = {
  name: 'reason',
  kind: 'text',
  labelTh: 'เหตุผล',
  required: true,
  helpTh: 'บันทึกลงสันประวัติของออเดอร์ และลูกค้าอ่านได้',
};

const note: TransitionField = {
  name: 'noteTh',
  kind: 'text',
  labelTh: 'บันทึกเพิ่มเติม',
  required: false,
};

const fault: TransitionField = {
  name: 'attributeFaultToCompany',
  kind: 'checkbox',
  labelTh: 'เป็นความผิดของบริษัท',
  required: false,
  helpTh: 'ติ๊กแล้วบริษัทรับภาระเอง ไม่ริบเงินลูกค้า',
};

/**
 * ⚠️ Trimmed, and a blank optional field is *absent* rather than empty.
 *
 * `reasonSchema` and `noteSchema` are both `.trim().min(1)`, so three spaces is a 422 and
 * not an empty note. And `attributeFaultToCompany: false` is not the same as omitting it —
 * both mean the customer bears the forfeit, and only one of them records a decision
 * somebody took. The default should be the absence of a claim, not a claim of absence.
 */
const compose =
  (names: readonly TransitionField['name'][]) =>
  (values: Values): Record<string, unknown> => {
    const body: Record<string, unknown> = {};

    for (const name of names) {
      if (name === 'attributeFaultToCompany') {
        if (values.attributeFaultToCompany === true) body[name] = true;
        continue;
      }
      const typed = (values[name] ?? '').trim();
      if (typed !== '') body[name] = typed;
    }

    return body;
  };

const form = (
  fields: readonly TransitionField[],
  options: { readonly offered?: boolean; readonly whyNotTh?: string } = {},
): TransitionForm => ({
  offered: options.offered ?? true,
  whyNotTh: options.whyNotTh ?? '',
  fields,
  body: compose(fields.map((field) => field.name)),
});

/**
 * ⭐ THE TABLE. One entry per `payloadKind` the API can put on an available transition.
 *
 * The buttons on the order screen come from `availableTransitions`, which the API derives
 * from `order_status_transitions` — the dashboard has no map of which move is legal from
 * which status and must not grow one. What it needs, and all it needs, is *what body each
 * move takes*, which is this.
 *
 * ⚠️ `cancel` is two entries. It is two rows in the transition table, split at the freeze,
 * with two different schemas, and plan 7.4 trap 4 is exactly the mistake of treating the
 * verb as one thing: before the freeze nothing has been cut, so there is no forfeit to
 * attribute and `cancelOrderRequestSchema` is a `strictObject` that 422s on the extra field.
 */
const FORMS: Record<PayloadKind, TransitionForm> = {
  none: form([]),

  /*
   * The one move this screen refuses to render.
   *
   * `submit` takes `{ contact, lines }` — a delivery address and a priced cart, neither of
   * which a staff order screen holds. A button posting `{}` would 422 every time, and a
   * button that filled the gap in would be submitting somebody's order with invented
   * contents. The customer's own cart is where this belongs.
   */
  submit: form([], {
    offered: false,
    whyNotTh: 'ลูกค้าเป็นคนส่งออเดอร์เอง — ต้องมีที่อยู่และรายการสินค้าที่ตั้งราคาแล้ว',
  }),

  confirm_payment: form([note]),
  cancel_pre_freeze: form([reason]),
  cancel_post_freeze: form([reason, fault]),
  bounce: form([reason]),
  approve_redesign: form([note]),
  supersede: form([reason]),
};

export function transitionForm(kind: PayloadKind): TransitionForm {
  return (
    FORMS[kind] ??
    /*
     * A payload kind from a newer API. Refused rather than guessed: an unknown body shape
     * posted as `{}` is a 422 at best, and at worst a transition that lands without the
     * field that was the whole point of adding the kind.
     */
    form([], {
      offered: false,
      whyNotTh: 'แดชบอร์ดรุ่นนี้ยังไม่รู้จักการเปลี่ยนสถานะแบบนี้ — ต้องอัปเดตก่อน',
    })
  );
}
