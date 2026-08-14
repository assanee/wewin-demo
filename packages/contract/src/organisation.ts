import { z } from 'zod';

import { isPromptPayId } from '@wewin/core/promptpay';

import type { MoneyWire } from './money.js';

/**
 * ⚠️ Every shape rule here mirrors a CHECK in `0027_organisation.sql`.
 *
 * The database is the authority — a request that passes zod and fails the CHECK becomes a
 * 500 rather than a sentence, so these exist to turn a refusal into something readable and
 * not to be the rule. When they disagree, the migration is right.
 */
const bankCode = z.string().regex(/^[A-Z]{3,8}$/u, 'รหัสธนาคารเป็นตัวพิมพ์ใหญ่ 3–8 ตัว');
const accountNumber = z.string().regex(/^[0-9]{10,15}$/u, 'เลขบัญชีเป็นตัวเลข 10–15 หลัก');
const accountName = z.string().trim().min(1).max(200);
/**
 * ⚠️ `isPromptPayId` from `@wewin/core/promptpay`, not a regex restated here.
 *
 * This was `^([0-9]{10}|[0-9]{13})$` — *any* ten digits — while `promptPayTarget`, which has
 * to turn the stored value into an actual QR, requires a leading `0` because every Thai
 * mobile number has one. So `1234567890` was accepted here, stored, and then refused at the
 * only point where it mattered: the customer's payment screen rendered the bank account with
 * no QR beside it, and nothing told the customer or the staff member who typed it why.
 *
 * The message names the leading zero now, because "10 digits" was true of the value that was
 * rejected and is what made the old rule look satisfied.
 *
 * ⚠️ **This is the one rule on this file that is deliberately stricter than its CHECK**, so
 * the header's "when they disagree, the migration is right" does not hold for it. The header's
 * worry is a rule *looser* than the database — that turns a refusal into a 500. Stricter is
 * safe in that direction: everything this accepts, `bank_accounts_promptpay_shape` accepts too.
 *
 * The migration is still the one that ought to move. `0027_organisation.sql` checks
 * `^([0-9]{10}|[0-9]{13})$`, so a direct INSERT can still store an id no QR can be built from,
 * and this schema only closes the HTTP door. Tightening the CHECK is a migration whose safety
 * depends on rows in environments this change cannot see, so it is written up rather than
 * shipped blind.
 */
const promptpayId = z
  .string()
  .refine(isPromptPayId, 'พร้อมเพย์เป็นเบอร์มือถือ 10 หลักขึ้นต้นด้วย 0 หรือเลขผู้เสียภาษี 13 หลัก');

export const bankAccountCreateSchema = z.strictObject({
  bankCode,
  accountNumber,
  accountName,
  promptpayId: promptpayId.nullable().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
});

export const bankAccountPatchSchema = z
  .strictObject({
    bankCode: bankCode.optional(),
    accountNumber: accountNumber.optional(),
    accountName: accountName.optional(),
    promptpayId: promptpayId.nullable().optional(),
    sortOrder: z.number().int().min(0).max(9999).optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, 'ไม่มีอะไรให้แก้ไข');

export const availabilitySchema = z.strictObject({ isActive: z.boolean() });

export const organisationProfilePutSchema = z.strictObject({
  legalNameTh: z.string().trim().min(1).max(300),
  legalNameEn: z.string().trim().min(1).max(300).nullable().optional(),
  addressTh: z.string().trim().min(1).max(1000),
  addressEn: z.string().trim().min(1).max(1000).nullable().optional(),
  taxId: z.string().regex(/^[0-9]{13}$/u, 'เลขผู้เสียภาษี 13 หลัก').nullable().optional(),
  phone: z.string().trim().min(1).max(60),
  email: z.string().email().max(320).nullable().optional(),
  /** Basis points of the grand total due before production may start. 10 000 is payment in full. */
  depositBp: z.int().min(1).max(10_000).optional(),
});

export type BankAccountCreateRequestWire = z.infer<typeof bankAccountCreateSchema>;
export type BankAccountPatchRequestWire = z.infer<typeof bankAccountPatchSchema>;
export type AvailabilityRequestWire = z.infer<typeof availabilitySchema>;
export type OrganisationProfilePutRequestWire = z.infer<typeof organisationProfilePutSchema>;

export interface BankAccountWire {
  readonly id: string;
  readonly bankCode: string;
  readonly accountNumber: string;
  readonly accountName: string;
  readonly promptpayId: string | null;
  readonly sortOrder: number;
  readonly isActive: boolean;
  readonly updatedAt: string;
}

export interface OrganisationProfileWire {
  readonly legalNameTh: string;
  readonly legalNameEn: string | null;
  readonly addressTh: string;
  readonly addressEn: string | null;
  readonly taxId: string | null;
  readonly phone: string;
  readonly email: string | null;
  readonly depositBp: number;
  readonly updatedAt: string;
}

export interface BankAccountChangeWire {
  readonly id: string;
  readonly changedAt: string;
  readonly changedByUserId: string | null;
  readonly before: Readonly<Record<string, unknown>> | null;
  readonly after: Readonly<Record<string, unknown>>;
}

/**
 * What a *customer* may see about an account. No `isActive`, no `sortOrder`, no `updatedAt`:
 * an inactive account is never returned at all, and the rest is internal ordering.
 */
export interface BankAccountPublicWire {
  readonly id: string;
  readonly bankCode: string;
  readonly accountNumber: string;
  readonly accountName: string;
  readonly promptpayId: string | null;
}

/**
 * ⚠️ Carries `promptpayId` and not a ready-made QR payload.
 *
 * The payload encodes the amount, and the page lets the customer transfer something other
 * than the outstanding figure — a partial payment, or a rounded one. A server-built payload
 * would freeze an amount the page then lets them change, so the page rebuilds it from
 * `@wewin/core/promptpay` whenever the amount field changes.
 */
export interface PaymentInstructionsWire {
  readonly grandTotalThbMinor: MoneyWire<'THB'>;
  readonly outstandingThbMinor: MoneyWire<'THB'>;
  /**
   * ⭐ What the customer is being asked for right now — the remainder of the first instalment
   * that is not yet settled. `฿0.00` when nothing is due.
   *
   * The owner's rule for the amount field: *"ถ้าเป็นเคสที่ระบุว่าต้องมัดจำ จึงจะมัดจำ ถ้าไม่ได้ระบุให้ใช้
   * ยอดเต็มเลย"* — a schedule with a deposit asks for the deposit, one without asks for the
   * whole amount.
   *
   * ⚠️ **Beside `outstandingThbMinor`, not instead of it, because they answer different
   * questions.** Outstanding is everything still owed on the order and is what the screen
   * *states*; this is the next obligation and is what the screen's amount field *opens on*.
   * They are equal on a pay-in-full schedule and differ by the balance on a 30/70 — and a
   * screen that opened on the first while the quotation promised the second is exactly the
   * mismatch this field was added to close.
   *
   * The deposit is deliberately not sent as such: "the deposit" stops being the right answer
   * the moment it has been paid, and a client choosing between two figures would be a second
   * implementation of a rule the server already applied.
   */
  readonly nextDueThbMinor: MoneyWire<'THB'>;
  /**
   * ─────────────────────────────────────────────────────────────────────────
   * ⭐ HOW MUCH OF THIS BALANCE THE COMPANY FORGAVE — and the reason this field exists is that
   * without it this screen tells a customer they paid in full when they did not.
   * ─────────────────────────────────────────────────────────────────────────
   *
   * `order_written_off_thb_minor()` (0048): the sum of every approved ตัดยอดค้างทิ้ง on this
   * order. Since 0048 `outstandingThbMinor` above is `grand_total − settled − written_off`, so a
   * write-off that covers the remainder drives it to ฿0.00 — and `describePaymentPanel` printed
   * `payment.settled`, *"ออเดอร์นี้ชำระครบแล้ว"*, on the strength of `outstanding <= 0`.
   *
   * That sentence would be a **falsehood told to the person it is about**. They did not pay; the
   * company wrote the rest off — after a refusal to pay, or a settlement at half, or a decision
   * that the remainder was not worth chasing. It is the same class of defect as the cancelled
   * order that was billed ฿10,354.18 (see `orderIsLive` below), and it is worse in one respect: a
   * customer who believes they are square is a customer who will dispute the company's own
   * ledger, in writing, months later — and the company's own screen will be the evidence.
   *
   * So the fact is sent and the screen says something else. `payment.writtenOff` states that the
   * remainder was written off, names the figure, and offers no form. ⚠️ It is deliberately not
   * worded as *paid*, *settled*, or *complete* in any of the eight catalogues.
   *
   * ⛔ Do not subtract it from `outstandingThbMinor` — that figure is already net of it, and
   * `outstanding + writtenOff` is what is left of `grandTotal − settled`.
   *
   * ⚠️ ฿0.00 on almost every order, and ฿0.00 is the real answer *nothing was forgiven* rather
   * than an absence. Unlike `OrderSummaryWire`'s field it is never null: this route states its
   * money figures on a cancelled order too (see `orderIsLive`), so all four travel together.
   */
  readonly writtenOffThbMinor: MoneyWire<'THB'>;
  /**
   * ⭐ Whether this order is still a live commitment, and therefore whether the screen may say
   * anything at all about the money — `false` only for cancelled and superseded.
   *
   * `false` means the residue above is **not a debt**. A cancelled order on which a deposit
   * was paid carries a real outstanding figure and the money may be owed *to* the customer;
   * a superseded order's residue was carried to the order that replaced it and is already
   * counted there. Naming a figure under a "ยอดคงค้าง" label in either case asks somebody for
   * money they do not owe, which is the defect this field was added to end.
   *
   * `true` means an ordinary live obligation, and the storefront may state the figures and
   * offer the upload form: `POST /orders/:id/payment-slips/image` will take the slip, and
   * `payment_slips_live_orders_only` will take the row underneath it.
   *
   * ── ⚠️ THERE USED TO BE TWO BOOLEANS HERE. THERE IS NOW ONE ─────────────────
   *
   * `acceptsPayment` shipped beside this field and said "no further slip can be attached". It
   * existed because the two disagreed about exactly one status: `delivered` was live — the
   * balance a real debt, chased by the staff money card — and closed to slips, so the customer
   * could read the amount on this screen and had no way to pay it. That is the owner's report
   * *"ถ้าส่งมอบไปก่อนเก็บครบ จะเก็บผ่านระบบไม่ได้อีก"*, and `0046_slips_after_delivery.sql` closed it by
   * opening `delivered` to slips.
   *
   * With the gap closed, `acceptsPayment` and `isLiveOrder` select the same six statuses —
   * `apps/api/tests/payments/slips/attachable.test.ts` enumerates all nine and asserts it — so
   * the pair was two names for one question, and a client would have had to decide which one
   * to believe. The field was removed rather than kept "in case they diverge again": a wire
   * field is a promise to every deployed bundle, and a boolean nobody can distinguish from its
   * neighbour is the sort a screen eventually reads the wrong one of. If the two questions
   * ever part again, the second field comes back with the disagreement written down.
   *
   * ⚠️ **A boolean, and deliberately not the order's status.** Two reasons, and the second
   * is the one that matters:
   *
   *   1. `order.ts` already imports `OrganisationProfileWire` from this module, so a status
   *      field here would need `ORDER_STATUSES_WIRE`'s runtime value across a cycle to be
   *      validated. A boolean needs nothing.
   *   2. It **removes** a duplicated definition rather than adding one. A client sent the
   *      status would have to hold its own copy of the live-order list to answer this —
   *      which is precisely how `apps/web/src/lib/payment/payable.ts` came to be a copy.
   *      Sending the *answer* leaves the screen nothing to get wrong.
   *
   * ⚠️ **Not "settled", and the two must never be conflated.** `outstandingThbMinor <= 0`
   * says *paid in full*; this says *there is a contract somebody still owes on*. They are
   * false in different directions, and "ชำระครบแล้ว" on a cancelled order whose deposit the
   * company is about to refund is the cruellest sentence available.
   *
   * Computed by `isLiveOrder()` (`apps/api/src/orders/live-order.ts`) — the same predicate the
   * order encoder and the overview aggregate read, so there is no fourth definition of "live".
   */
  readonly orderIsLive: boolean;
  readonly accounts: readonly BankAccountPublicWire[];
}

/* ------------------------------------------------------------------ *
 * The exchange-rate feed, as a screen sees it
 * ------------------------------------------------------------------ */

/**
 * ⭐ How old the newest exchange rate is, how many syncs have failed since it landed, and —
 * since this round — **what the numbers actually are**.
 *
 * The thresholds are constants in `apps/api/src/fx/staleness.ts` and are reported *down*
 * rather than configured up, so a screen never has to hold a second copy of them — the panel
 * that renders "36 ชั่วโมง" gets the 36 from the same constant the refusal compares against,
 * and the two cannot drift into a screen showing green over a submit that is being refused.
 *
 * ⚠️ It used to say *"read-only, and there is no request shape beside it on purpose: nothing
 * here is settable"*. Half of that is still true and the other half stopped being true: nothing
 * here is *settable*, and there is now one thing here that is *doable* — `POST /admin/fx/sync`,
 * which fetches on demand. It sets no value; it spends a request against the provider's monthly
 * budget, which is why `manualSync` below reports that budget on this same payload.
 *
 * ⚠️ **Both clocks travel, and the pair is the diagnosis.** `observedAt` is when the provider
 * struck the rate and `fetchedAt` is when we stored it; `ageHours` is measured on the *first*
 * (see `staleness.ts`). A `fetchedAt` of minutes ago beside an `observedAt` of three weeks ago
 * is a provider whose feed has frozen while its HTTP endpoint stays healthy — the failure that
 * is invisible to any check built on fetch time — and it is only legible when a reader can see
 * both. Neither is derivable from the other, so neither is redundant.
 */
export interface FxRateHealthWire {
  /** `'ok' | 'warn' | 'blocked'`, decided server-side by the same function the refusal uses. */
  readonly status: string;
  /**
   * Hours since `observedAt`, exact. `null` — and only — when `fx_rates` has never had a row,
   * which is a different fact from "an age of zero" and is reported as `status: 'blocked'`
   * because that is what a foreign-currency submit already does about it.
   */
  readonly ageHours: number | null;
  /** ISO 8601. `null` when there is no observation at all. */
  readonly observedAt: string | null;
  /** ISO 8601. `null` when there is no observation at all. */
  readonly fetchedAt: string | null;
  /**
   * Failed syncs recorded since the newest stored rate — so a landed retry resets it by
   * arithmetic rather than by anybody clearing a counter.
   *
   * ⚠️ A **lower bound**. A failure the database refused to record is a failure that is not
   * counted; see `FxRatesService.record` for why that path swallows rather than throws. Zero
   * beside a large `ageHours` is therefore its own signal: it means nothing is even trying,
   * which is a stopped scheduler rather than a struggling provider.
   */
  readonly consecutiveFailures: number;
  /** ISO 8601 of the newest recorded failure, or `null` when none has been recorded. */
  readonly lastFailureAt: string | null;
  /** The soft threshold, in hours — reported so a screen holds no copy of it. */
  readonly warnAfterHours: number;
  /** The hard threshold, in hours. Past this a foreign-currency submit is refused. */
  readonly refuseAfterHours: number;
  /**
   * ⭐ How many people could actually be told — holders of `organisation.write` with an active
   * account and a primary (therefore verified) email address.
   *
   * Here because **zero is a worse condition than a stale rate**, and until it was on this
   * payload it was only ever a line in a log. Nobody holding the permission means the staleness
   * warning has no destination that can act on it: the mail still goes to the sales queue, but
   * the people who could type `fxManualRate` are not reachable, and the next foreign-currency
   * submit is refused with nobody having been warned. That is the precise failure class this
   * whole phase exists to remove, so it is reported on the same card as the staleness itself.
   *
   * It deliberately counts *reachability*, not authority: somebody who holds the permission but
   * whose account is suspended, or who has no primary address, is not counted, because they
   * cannot be told. See `PermissionRepository.addressesHolding`.
   */
  readonly warningRecipients: number;
  /**
   * ⭐ What the feed is actually holding, per destination that has a currency configured.
   *
   * Empty when `fx_rates` has never had a row, and empty when no destination is configured for
   * a foreign currency — two different reasons for the same empty array, and the screen tells
   * them apart from `observedAt` rather than from the length.
   *
   * ⚠️ **One entry per destination, not per currency.** The spread and the override are columns
   * on `tax_countries`, so two destinations sharing a currency can resolve to different rates
   * off the same observation. A payload keyed by currency could not express that, and would
   * have to pick one of the two to print.
   */
  readonly configuredRates: readonly FxConfiguredRateWire[];
  /** What the provider's `rates` object is denominated in — `'USD'` on the free plan. */
  readonly base: string | null;
  /** How much of the manual-sync budget is left, so the button can say so before it is pressed. */
  readonly manualSync: FxManualSyncBudgetWire;
}

/**
 * ⭐ One destination's rate, as staff need to read it — which is not as the provider sends it.
 *
 * The provider publishes USD-based mid-market figures: `rates['SGD'] = 1.35` means 1.35 SGD per
 * USD. This business prices in baht, so **the number staff need is baht per one unit of the
 * destination currency**, derived through the provider's base and marked down by the
 * destination's spread. Those are different numbers by two orders of magnitude and a reciprocal,
 * and the whole point of this shape is that a screen cannot accidentally print one where the
 * other belongs: the useful figure is `effectiveThbPerUnit`, and every raw provider figure is
 * nested under `provider` with the base it is denominated against.
 *
 * Every rate is a **string**, never a number. `packages/core/src/fx.ts` carries rates as exact
 * bigint ratios precisely so nothing rounds twice, and JSON has one numeric type: a float. A
 * decimal string is what survives the wire intact, the same reason `tax_countries.fx_manual_rate`
 * is `numeric` and reads back as a string.
 */
export interface FxConfiguredRateWire {
  readonly countryCode: string;
  readonly countryNameTh: string;
  /** Never `'THB'` — `tax_countries_fx_currency_not_thb` refuses to store it. */
  readonly currency: string;
  /**
   * `false` when the destination is withdrawn. It is still listed, because `is_active` governs
   * which destinations a *new* order may name and not whether an order that already names this
   * one resolves — `TaxCountryRepository.byCode` has no `is_active` filter, deliberately. A rate
   * that can still be pinned is a rate that belongs on this card.
   */
  readonly isActive: boolean;
  /**
   * ⭐ `'manual'` when the destination carries an `fxManualRate`, `'mid_market'` otherwise.
   *
   * This is the field a reader has to see first, because it decides whether the rest of the row
   * is describing something the system uses. See `effectiveThbPerUnit`.
   */
  readonly source: 'manual' | 'mid_market';
  /**
   * ⭐ **Baht per one whole unit of `currency` — the rate the system would actually quote with.**
   *
   * For `'manual'` this is the typed override, verbatim. For `'mid_market'` it is the cross-rate
   * through the provider's base, marked down by `spreadBp`. Either way it is the one figure that
   * answers "what will a ฿36,500 product come out at", and it is the only figure on this row a
   * staff member should compare against a bank's screen.
   *
   * `null` when no rate could be resolved at all — see `problem`.
   *
   * ⚠️ **A rendering, not the divisor.** `convertFromBaht` divides by an exact ratio and this is
   * that ratio rounded for display; reproducing a converted figure from this string will differ
   * in the last minor unit. `thbPerUnitText` in `@wewin/core/fx` carries the full argument.
   */
  readonly effectiveThbPerUnit: string | null;
  /**
   * The same quantity **before** the spread, for a reader checking what the spread did.
   *
   * ⚠️ `null` for `source: 'manual'`, and that null is a statement rather than a gap. A manual
   * override is used exactly as typed and the spread is *not* applied on top of it — THE RULE in
   * `packages/core/src/fx.ts` — so there is no "mid-market rate for this destination" in play.
   * Deriving one anyway and putting it on the payload would be handing a screen a plausible
   * number that nothing in the system uses, which is the specific failure this field's absence
   * prevents. What the feed says for that currency is still visible, unreduced, under `provider`.
   */
  readonly midThbPerUnit: string | null;
  /**
   * The spread on the destination row, in basis points — 200 is 2%.
   *
   * ⚠️ This is the **configured** spread, which for `source: 'manual'` is *not* the applied one
   * (`FxRate.spreadBp` is `0` there, by THE RULE). It is reported as configured because the
   * column keeps its value when an override is set — deliberately, so removing the override
   * restores the old behaviour — and a screen that showed `0` would tell an administrator the
   * spread had been cleared. `spreadApplied` says whether it is doing anything.
   */
  readonly spreadBp: number;
  /** `false` exactly when `source` is `'manual'`. Named so a screen never has to infer it. */
  readonly spreadApplied: boolean;
  /**
   * The provider's own figures for this currency, verbatim and unreduced — or `null` when there
   * is no observation, or the observation does not carry this currency.
   *
   * Nested rather than flat so that no template can print `unitPerBase` where a THB rate belongs:
   * reaching one of these numbers costs a `.provider.` and lands beside `base`, which is the only
   * thing that makes them mean anything.
   */
  readonly provider: FxProviderFiguresWire | null;
  /**
   * Why there is no `effectiveThbPerUnit`, or `null` when there is one.
   *
   * `@wewin/core/fx`'s own vocabulary (`destination_rate_missing`, `baht_rate_missing`,
   * `manual_rate_unreadable`, `same_currency`) plus `'no_snapshot'` for the case core cannot
   * name because it never sees the table.
   */
  readonly problem: string | null;
}

/** The two provider figures a mid-market rate is derived from, exactly as stored. */
export interface FxProviderFiguresWire {
  /** `rates[currency]` — units of `currency` per one unit of the observation's `base`. */
  readonly unitPerBase: number;
  /** `rates['THB']` — baht per one unit of the observation's `base`. */
  readonly thbPerBase: number;
}

/**
 * ⭐ The manual sync's budget, reported so the guard is visible before it refuses rather than
 * only when it does.
 *
 * The provider's free plan allows 1,000 requests a month for the whole system, and the *scheduled*
 * sync draws on the same pool — so a button spent carelessly today is a stale rate and a refused
 * quotation next week. That consequence is a week away from the click that causes it, which is
 * exactly the shape of thing a screen has to say out loud, because nobody will connect the two
 * on their own.
 *
 * ⚠️ Two limits and not one. `remainingToday` is the quota bound; `nextAllowedAt` is a short
 * minimum interval that exists for a different failure — a held-down button, or a double-submit,
 * spending the day's whole allowance in four seconds. A single daily cap would permit that, and
 * a single interval would permit 288 syncs a day.
 */
export interface FxManualSyncBudgetWire {
  /** Manual syncs allowed per rolling 24 hours. A constant server-side, reported down. */
  readonly dailyLimit: number;
  /** Manual syncs already attempted in the last 24 hours — successes and failures alike. */
  readonly usedToday: number;
  /** `dailyLimit − usedToday`, floored at zero. Zero means the next press is refused. */
  readonly remainingToday: number;
  /** The minimum gap between two manual syncs, in seconds. */
  readonly minIntervalSeconds: number;
  /**
   * ISO 8601 of the earliest moment a manual sync would be accepted, or `null` when one would be
   * accepted right now. Non-`null` for the minimum interval *and* for an exhausted daily quota —
   * a screen wanting to distinguish them reads `remainingToday`.
   */
  readonly nextAllowedAt: string | null;
}

/**
 * ⭐ What `POST /admin/fx/sync` answers with — and the reason it is four words rather than a
 * boolean.
 *
 * The free plan updates hourly. A manual sync minutes after the last one therefore fetches **the
 * same observation the system already had**, appends a row, and moves nothing — which is the
 * ordinary case, not the exceptional one. Reporting that as success would train staff that the
 * button does something it did not do, and the next person to press it during a real outage would
 * read the same green tick.
 *
 * ⚠️ `'unchanged'` still spent a provider request and still wrote an `fx_rates` row. It is not a
 * no-op against the quota, only against the number, and the copy has to keep those apart.
 */
export interface FxManualSyncResultWire {
  /**
   * - `'stored'` — a new observation landed; `observedAt` moved.
   * - `'unchanged'` — the provider answered with the observation we already had.
   * - `'failed'` — the fetch, the parse or the store did not complete. Recorded in
   *   `fx_sync_failures` exactly as a failed scheduled sync is.
   * - `'disabled'` — no `OPENEXCHANGERATES_APP_ID` is configured, so nothing was attempted and
   *   nothing was spent. Its own word rather than a failure, because there is no outage: this is
   *   a developer environment without a key, and `FxRatesService` treats it the same way.
   */
  readonly outcome: 'stored' | 'unchanged' | 'failed' | 'disabled';
  /** ISO 8601 of the newest observation *after* this sync, or `null` when there is still none. */
  readonly observedAt: string | null;
  /** ISO 8601 of the observation the system held *before* it, so a screen can show both. */
  readonly previousObservedAt: string | null;
  /**
   * How far a `'failed'` attempt got — `'fetch' | 'parse' | 'store'` — and `null` otherwise.
   *
   * ⚠️ Never a URL, never a response body, never a provider message. `app_id` travels in the
   * request URL, so `FxHttp` is built never to hand its caller either — see that file. A stage
   * name is the whole of what a screen gets, and it is enough to say which of a network, a
   * provider contract, or this database is the thing to chase.
   */
  readonly failureStage: string | null;
  /** The budget as it stands *after* this attempt, so the screen need not refetch to disable. */
  readonly manualSync: FxManualSyncBudgetWire;
}
