import "client-only";

import { apiJson } from "@/lib/api/client";
import type { OrderStatus } from "@/components/orders/order-language";

/**
 * `GET /overview`, decoded.
 *
 * ⚠️ The shapes are restated from `apps/api/src/overview/overview.contract.ts` — `turbo
 * boundaries` stops the dashboard importing from apps/api, and rightly. Same debt as
 * `user-api.ts` and `media-api.ts`, same mitigation: the decoders check at runtime, so a
 * rename becomes a message naming the field rather than `NaN` in a card.
 *
 * ── ⭐ EVERY CARD IS OPTIONAL, AND THAT IS THE CONTRACT ──────────────────────
 *
 * A card the signed-in person may not see is a **key that is not in the response**. Not a
 * zero, not a null. So every field here is `?`, and the screen renders a card only when its
 * key arrived — which means the permission logic lives entirely in the API and this file
 * has no copy of it to get out of step.
 *
 * The decoder is deliberately lenient about *which* cards arrive and strict about their
 * *contents*: an unknown card is ignored, a card whose count is a string is an error. The
 * first is a newer API talking to an older dashboard, which should degrade quietly; the
 * second is the `db.execute` bug this codebase has hit before, which should not.
 */

export interface OrdersOverview {
  readonly draft: number;
  readonly awaitingPayment: number;
  readonly productionConfirmed: number;
  readonly inProduction: number;
  readonly awaitingInstallation: number;
  readonly redesign: number;
}

/**
 * One order that owes money — the aggregate below, itemised so somebody can telephone about it.
 *
 * ⚠️ **Inside the money card, not beside it.** The API puts it there so that `payments.read`
 * gates the breakdown by exactly the same key it gates the total with: an itemised debt is more
 * disclosive than its total, never less. This file therefore decodes it inside `card(body,
 * 'money', …)` and nowhere else — a top-level key would be a second place for that gate to be
 * got right, on the side of the wire that cannot enforce it.
 */
export interface OutstandingOrder {
  readonly id: string;
  /** Unreachable-null; typed as the wire types it rather than claiming a non-null the column does not give. */
  readonly orderNo: string | null;
  readonly status: OrderStatus;
  /** Satang, and never null — only orders that owe are in this list. */
  readonly outstandingThbMinor: bigint;
}

export interface MoneyOverview {
  /** Satang. Face value of slips accepted this Thai month — see the API's contract. */
  readonly receivedThisMonth: bigint;
  /** Satang. `order_outstanding_thb_minor()` folded over live orders. */
  readonly outstanding: bigint;
  /**
   * The biggest debts making up `outstanding` — **capped by the API, so this does not add up to
   * it.** `outstanding-breakdown.ts` is where that is said out loud on the screen.
   *
   * ⚠️ Defaults to `[]` when the key is absent, which is this file's standing bargain: lenient
   * about which fields an older API sends, strict about what is in the ones that arrive. An
   * older API sending the total and no rows is a real deployment, and the breakdown module has
   * a branch for exactly that pairing rather than printing "nothing is owed" under a figure.
   */
  readonly outstandingOrders: readonly OutstandingOrder[];
}

export interface Overview {
  readonly orders?: OrdersOverview;
  readonly slips?: { readonly awaitingReview: number };
  readonly refunds?: { readonly requested: number };
  readonly money?: MoneyOverview;
  readonly quotes?: { readonly approvalsPending: number };
  readonly reviews?: { readonly awaitingModeration: number };
  readonly notifications?: {
    readonly dead: number;
    readonly suppressed: number;
  };
  readonly catalog?: {
    readonly products: number;
    readonly unpublishedDrafts: number;
    readonly optionGroups: number;
  };
  readonly users?: { readonly active: number; readonly suspended: number };
}

const asRecord = (value: unknown, what: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${what}: expected an object`);
  }
  return value as Record<string, unknown>;
};

/**
 * A count, and only a count.
 *
 * `typeof value !== 'number'` rather than `Number(value)`: coercing would turn the `"3"` an
 * uncast `count(*)` produces into a 3 and hide the bug the API's own test exists to catch.
 * A dashboard that repairs its server's mistakes is a dashboard that stops reporting them.
 */
const asCount = (value: unknown, what: string): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new TypeError(
      `${what}: expected a whole count, got ${JSON.stringify(value)}`,
    );
  }
  return value;
};

/** `{ unit, digits }` as `MoneyWire` travels — the unit is checked, never assumed. */
const asSatang = (value: unknown, what: string): bigint => {
  const money = asRecord(value, what);
  if (money["unit"] !== "THB.satang") {
    throw new TypeError(
      `${what}: expected THB.satang, got ${JSON.stringify(money["unit"])}`,
    );
  }
  const digits = money["digits"];
  if (typeof digits !== "string")
    throw new TypeError(`${what}: digits is not a string`);
  return BigInt(digits);
};

const asText = (value: unknown, what: string): string => {
  if (typeof value !== "string") throw new TypeError(`${what}: expected a string`);
  return value;
};

/** `[]` for an absent key — see `MoneyOverview.outstandingOrders`. A present non-array is still an error. */
const asRows = (value: unknown, what: string): readonly unknown[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError(`${what}: expected an array`);
  return value;
};

/** Present only when the key is, so an absent card stays absent all the way to the screen. */
const card = <T>(
  body: Record<string, unknown>,
  key: string,
  decode: (raw: Record<string, unknown>) => T,
): { readonly [k: string]: T } | Record<string, never> =>
  body[key] === undefined ? {} : { [key]: decode(asRecord(body[key], key)) };

export const fetchOverview = (): Promise<Overview> =>
  apiJson("/overview", (payload) => {
    const body = asRecord(payload, "ภาพรวม");

    return {
      ...card(body, "orders", (raw) => ({
        draft: asCount(raw["draft"], "orders.draft"),
        awaitingPayment: asCount(
          raw["awaitingPayment"],
          "orders.awaitingPayment",
        ),
        productionConfirmed: asCount(
          raw["productionConfirmed"],
          "orders.productionConfirmed",
        ),
        inProduction: asCount(raw["inProduction"], "orders.inProduction"),
        awaitingInstallation: asCount(
          raw["awaitingInstallation"],
          "orders.awaitingInstallation",
        ),
        redesign: asCount(raw["redesign"], "orders.redesign"),
      })),
      ...card(body, "slips", (raw) => ({
        awaitingReview: asCount(raw["awaitingReview"], "slips.awaitingReview"),
      })),
      ...card(body, "refunds", (raw) => ({
        requested: asCount(raw["requested"], "refunds.requested"),
      })),
      ...card(body, "money", (raw) => ({
        receivedThisMonth: asSatang(
          raw["receivedThisMonth"],
          "money.receivedThisMonth",
        ),
        outstanding: asSatang(raw["outstanding"], "money.outstanding"),
        outstandingOrders: asRows(
          raw["outstandingOrders"],
          "money.outstandingOrders",
        ).map((entry, index) => {
          const order = asRecord(entry, `money.outstandingOrders[${String(index)}]`);
          return {
            id: asText(order["id"], "outstandingOrder.id"),
            orderNo:
              order["orderNo"] === null || order["orderNo"] === undefined
                ? null
                : asText(order["orderNo"], "outstandingOrder.orderNo"),
            /*
             * Cast, not validated, and deliberately: `statusLabel` renders an unrecognised code
             * as itself — "ugly, obviously wrong, reportable" — which is a better outcome on a
             * landing page than a `TypeError` that blanks a card because the API shipped a tenth
             * status first. The same bargain `order-api.ts`'s `decodeSummary` makes.
             */
            status: asText(order["status"], "outstandingOrder.status") as OrderStatus,
            outstandingThbMinor: asSatang(
              order["outstandingThbMinor"],
              "outstandingOrder.outstandingThbMinor",
            ),
          };
        }),
      })),
      ...card(body, "quotes", (raw) => ({
        approvalsPending: asCount(
          raw["approvalsPending"],
          "quotes.approvalsPending",
        ),
      })),
      ...card(body, "reviews", (raw) => ({
        awaitingModeration: asCount(
          raw["awaitingModeration"],
          "reviews.awaitingModeration",
        ),
      })),
      ...card(body, "notifications", (raw) => ({
        dead: asCount(raw["dead"], "notifications.dead"),
        suppressed: asCount(raw["suppressed"], "notifications.suppressed"),
      })),
      ...card(body, "catalog", (raw) => ({
        products: asCount(raw["products"], "catalog.products"),
        unpublishedDrafts: asCount(
          raw["unpublishedDrafts"],
          "catalog.unpublishedDrafts",
        ),
        optionGroups: asCount(raw["optionGroups"], "catalog.optionGroups"),
      })),
      ...card(body, "users", (raw) => ({
        active: asCount(raw["active"], "users.active"),
        suspended: asCount(raw["suspended"], "users.suspended"),
      })),
    } as Overview;
  });
