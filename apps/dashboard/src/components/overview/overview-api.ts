import "client-only";

import { apiJson } from "@/lib/api/client";

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

export interface MoneyOverview {
  /** Satang. Face value of slips accepted this Thai month — see the API's contract. */
  readonly receivedThisMonth: bigint;
  /** Satang. `order_outstanding_thb_minor()` folded over live orders. */
  readonly outstanding: bigint;
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
