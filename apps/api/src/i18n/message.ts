import { isMessage, reviveMessage, type Message } from '@wewin/core/message';

/**
 * Server messages — every sentence this API produces, as a key and its values.
 *
 * ── The debt this pays ───────────────────────────────────────────────────────────
 *
 * Plan section 5 retired the Thai string from `core`. It said nothing about the API,
 * because at the time the API's Thai strings were the only sentences a customer could see
 * and the storefront was the only client. Neither is true now: `pg-errors.ts` holds a table
 * of Thai prose that is answered to a browser, a dashboard, and whatever integrates next,
 * and an error a customer sees has to be in *their* language and not in the server's.
 *
 * ── Why a second key scheme instead of extending core's ──────────────────────────
 *
 * `@wewin/core/message` owns nine keys, all of them statements about a *configuration* —
 * out of range, off grid, unavailable, a price row. This file owns statements about a
 * *request*: a constraint refused it, a colleague moved the row underneath it, the numbers
 * did not foot. Those are different vocabularies with different owners, and core cannot
 * hold them without depending on Postgres constraint names.
 *
 * What is shared is the *rule*, and it is the rule that matters:
 *
 *     **A param is a value. The layer that knows the locale renders it.**
 *
 * Nothing in this file imports a formatter, and after this change neither does
 * `allocations.ts` — its private `satang()` helper, which built `฿5,529.60` inside a domain
 * module, is gone. Money stays `bigint` minor units all the way to `render.ts`, because a
 * Hindi or Burmese catalogue may need its own digits and its own grouping, and a translator
 * handed the substring `฿5,529.60` cannot produce either.
 *
 * ── One table, two things derived from it ────────────────────────────────────────
 *
 * `PARAM_SHAPES` is written once and both the runtime validator and the compile-time
 * `ServerMessage` union come out of it. Core writes its map twice — an interface and a
 * shapes table — which is affordable for nine keys and would be a hundred opportunities to
 * disagree here. The cost of deriving is that the shapes table has to be `as const`; the
 * benefit is that a key with no renderer, or a renderer reading a param the key does not
 * carry, is a compile error rather than an `undefined` in a customer's inbox.
 */

/* ------------------------------------------------------------------ *
 * Params — values, never rendered text
 * ------------------------------------------------------------------ */

/**
 * An amount of money, in minor units of its currency.
 *
 * `minor` and not baht: every figure in this system is `bigint` satang and the division on
 * the way to a screen is exactly where a rounding decision hides from review. The currency
 * travels with it because plan 4.2 has foreign-currency invoices on the road map and a bare
 * number that "is obviously baht" is how ฿5,530 becomes €5,530 on the day it is not.
 *
 * ⚠️ Rendered to the satang, not the baht. `formatBaht` in core rounds to whole baht —
 * correct for a quotation, and wrong for every message in this file, because these messages
 * exist to tell a reviewer *which forty satang* did not foot.
 */
export interface MoneyParam {
  readonly kind: 'money';
  readonly minor: bigint;
  readonly currency: 'THB';
}

/**
 * A cardinal or ordinal number — an instalment's sequence, a limit, a count of lines.
 *
 * A param rather than a substring precisely because Hindi (`१`) and Burmese (`၁`) write
 * their own digits. `String(n)` at the call site would have shipped Western digits into
 * eight catalogues and nobody would have found out from a passing test.
 */
export interface CountParam {
  readonly kind: 'count';
  readonly value: number;
}

/**
 * A machine identifier — a product id, a group code, a constraint name.
 *
 * The opposite of `CatalogTextParam` in core, and the distinction is load-bearing: a
 * catalogue label is content a translator owns and localises, while `awn-4t` is a primary
 * key that must read identically in all eight languages or it stops being usable in a
 * support conversation. This kind exists so that "do not translate this" is a decision made
 * once, at the call site, rather than eight times by eight translators.
 */
export interface CodeParam {
  readonly kind: 'code';
  readonly value: string;
}

export type ServerParam = MoneyParam | CountParam | CodeParam;

export type ServerParamKind = ServerParam['kind'];

/** `param` shorthands, so a call site never writes a literal and never picks a kind twice. */
export const thb = (minor: bigint): MoneyParam => ({ kind: 'money', minor, currency: 'THB' });
export const count = (value: number): CountParam => ({ kind: 'count', value });
export const code = (value: string): CodeParam => ({ kind: 'code', value });

interface ParamByKind {
  readonly money: MoneyParam;
  readonly count: CountParam;
  readonly code: CodeParam;
}

/* ------------------------------------------------------------------ *
 * The key scheme
 * ------------------------------------------------------------------ */

/**
 * Every message this API can produce, and exactly which params it carries.
 *
 * Naming is `error.<domain>.<case>`. The domain segment is not decoration — the four
 * `pg-errors.ts` translators exist because the same SQLSTATE means different things in
 * different vocabularies, and they say so at length in their own headers. Two of them
 * explain the *same constraint name* differently: `refunds_accrual_entry_key` is
 * "this accrual is already referenced by another refund" to a slip reviewer and
 * "one sum of money is refunded once" to an accountant. A key space flattened to the
 * constraint name would silently collapse those two sentences into whichever was
 * registered last.
 *
 * `{}` means the sentence interpolates nothing. Most do — a constraint refusal is a
 * complete statement — and that is a feature: a message with no params cannot be
 * mistranslated by getting a number in the wrong place.
 */
const PARAM_SHAPES = {
  /* ── Password sign-in — src/auth/password ─────────────────────────────────────
   *
   * ⚠️ There is exactly **one** rejection key, and that is the design rather than an
   * economy. A missing account, an account with no password, a suspended one, a closed one
   * and a wrong password all render this sentence, because any wording that told them apart
   * would answer "is this address a customer here?" to anybody who asked. See
   * `password-sign-in.service.ts`, where the same idea is enforced on the timing.
   */
  'error.auth.credentials_rejected': {},
  /*
   * ⚠️ One refusal for every way step two can fail: an expired challenge, a challenge that
   * was never ours, a wrong code, a code already spent, an account whose second factor was
   * turned off between the two steps. Naming which would turn the endpoint into an oracle —
   * "your challenge expired" confirms a captured token was genuine, and "no second factor is
   * enabled" says which accounts to attack directly instead.
   */
  'error.auth.second_factor_rejected': {},
  'error.mfa.already_enabled': {},
  'error.mfa.not_enrolling': {},
  /**
   * ⭐ The first refusal in this catalogue whose reader is a **customer**, not staff.
   *
   * Every other sentence here is answered into a Thai dashboard, which is the argument
   * `tests/i18n/envelope.test.ts` records for why 211 raw literals were tolerable. This one
   * is answered to `/[locale]/orders`, which exists in eight languages and is opened from an
   * email by somebody who may never have seen the dashboard — so it is keyed rather than
   * written, and the pin stays where it is.
   *
   * ⚠️ One key for four different problems: expired, mistyped, unknown order, never
   * submitted. The API refuses to distinguish them on purpose — see `document-link.ts` — and
   * the sentence therefore offers the one action that works in every case.
   */
  'error.order.document_link_unusable': {},
  /** Staff-facing: `NOTIFICATIONS_WEB_BASE_URL` is unset, so no link can be built at all. */
  'error.order.storefront_not_configured': {},
  /** ⭐ Registration takes a number, not an address — see `registration.service.ts`. */
  'error.auth.register_phone_only': {},
  /**
   * ⚠️ Says the number is taken, which every signup form must.
   *
   * A form that refuses without saying why is one nobody can complete. What is disclosed is
   * that *somebody* registered it — not who, and not whether they proved it — and the
   * sentence points at the two things that help: sign in, or telephone if it is not yours.
   */
  'error.auth.number_already_registered': {},
  'error.mfa.no_recovery_path': {},
  /*
   * A provider-only account cannot re-prove with a password, so it cannot turn its own
   * second factor off. Not a hole: the route out is an administrator, who is a person who
   * can be asked why — which is a better answer than a self-service path with no proof.
   */
  'error.mfa.needs_a_password': {},
  'error.auth.too_many_attempts': { minutes: 'count' },
  'error.auth.password_too_short': { minimum: 'count' },
  'error.auth.password_too_long': { maximum: 'count' },
  'error.auth.reset_token_rejected': {},

  /* ── Catalogue constraints — src/admin/pg-errors.ts ───────────────────────── */
  'error.catalog.slug_taken': {},
  'error.catalog.sku_prefix_taken': {},
  'error.catalog.product_id_taken': {},
  'error.catalog.price_whole_baht': {},
  'error.catalog.price_positive': {},
  'error.catalog.lead_time_ordered': {},
  'error.catalog.min_billable_positive': {},
  'error.catalog.group_code_taken': {},
  'error.catalog.sku_group_shape': {},
  'error.catalog.custom_group_shape': {},
  'error.catalog.value_code_taken': {},
  'error.catalog.delta_shape': {},
  'error.catalog.delta_whole_units': {},
  'error.catalog.swatch_hex_format': {},
  'error.catalog.size_grid': {},
  'error.catalog.version_sku_shape': {},
  'error.catalog.version_custom_shape': {},
  'error.catalog.rule_code_taken': {},
  'error.catalog.already_published': {},
  'error.catalog.version_number_taken': {},
  'error.catalog.duplicate': {},
  'error.catalog.missing_reference': {},
  'error.catalog.check_failed': {},
  'error.catalog.frozen': {},
  /** `ไม่พบสินค้ารหัส "awn-4t"` — the id is a `code` and stays Latin in all eight. */
  'error.catalog.product_not_found': { productId: 'code' },

  /* ── Order constraints — src/orders/pg-errors.ts ──────────────────────────── */
  'error.order.change_request_already_open': {},
  'error.order.already_superseded': {},
  'error.order.concurrent_event': {},
  'error.order.order_no_taken': {},
  'error.order.needs_an_owner': {},
  'error.order.needs_a_contact_channel': {},
  'error.order.contact_email_shape': {},
  'error.order.total_does_not_foot': {},
  'error.order.deposit_exceeds_total': {},
  'error.order.concurrent_document': {},
  'error.order.cannot_return_to_awaiting_payment': {},
  'error.order.duplicate': {},
  'error.order.missing_reference': {},
  'error.order.check_failed': {},
  'error.order.state_changed': {},
  'error.order.locked': {},

  /* ── Quote constraints — src/quotes/pg-errors.ts ──────────────────────────── */
  'error.quote.override_already_on_line': {},
  'error.quote.override_already_on_document': {},
  'error.quote.concurrent_line': {},
  'error.quote.override_equals_computed': {},
  'error.quote.override_money_negative': {},
  'error.quote.override_days_negative': {},
  'error.quote.line_charge_zero': {},
  'error.quote.line_qty_positive': {},
  'error.quote.override_other_needs_a_note': {},
  'error.quote.override_entry_mode_mismatch': {},
  'error.quote.duplicate': {},
  'error.quote.missing_reference': {},
  'error.quote.check_failed': {},
  'error.quote.locked': {},
  /*
   * One key per operation, not one key with an `operation` param.
   *
   * These five are the plan-7.9(ง)(2) refusals, and each names a *different recovery* —
   * supersede the override, revoke it, reload. A single key parameterised by the operation
   * would hand a translator one sentence with a placeholder and no way to know that
   * "reprice" and "remove" need different verbs in German.
   */
  'error.quote.frozen.write_line': {},
  'error.quote.frozen.reprice_line': {},
  'error.quote.frozen.remove_line': {},
  'error.quote.frozen.write_override': {},
  'error.quote.frozen.supersede_override': {},

  /* ── Money constraints — src/payments/ledger/pg-errors.ts ─────────────────── */
  'error.money.accrual_already_refunded': {},
  'error.money.approver_is_requester': {},
  'error.money.disburser_is_approver': {},
  'error.money.refund_amount_positive': {},
  'error.money.refund_currency_is_thb': {},
  'error.money.refund_status_shape': {},
  'error.money.payee_last4_shape': {},
  'error.money.posting_amount_nonzero': {},
  'error.money.entry_needs_a_slip': {},
  'error.money.variance_needs_a_kind': {},
  'error.money.duplicate': {},
  'error.money.missing_reference': {},
  'error.money.check_failed': {},
  'error.money.state_changed': {},
  'error.money.locked': {},

  /* ── Slip constraints — src/payments/slips/slip-errors.ts ─────────────────── */
  'error.slip.reviewer_is_submitter': {},
  'error.slip.amount_positive': {},
  'error.slip.currency_is_thb': {},
  'error.slip.review_shape': {},
  'error.slip.erasure_shape': {},
  'error.slip.payer_last4_shape': {},
  'error.slip.instalment_repeated_in_slip': {},
  'error.slip.allocation_amount_positive': {},
  'error.slip.posting_amount_nonzero': {},
  'error.slip.accrual_already_refunded': {},
  'error.slip.duplicate': {},
  'error.slip.check_failed': {},
  'error.slip.guard_refused': {},

  /* ── Allocation arithmetic — src/payments/slips/allocations.ts ────────────── */
  'error.slip.no_allocations': {},
  'error.slip.duplicate_instalment_line': {},
  'error.slip.instalment_not_on_this_order': {},
  /** ⭐ The money params. `seq` is a number a Burmese catalogue writes in Burmese digits. */
  'error.slip.over_allocated': { seq: 'count', remaining: 'money', requested: 'money' },
  'error.slip.foot_with_room_left': { allocated: 'money', slip: 'money', roomLeft: 'money' },
  'error.slip.overpayment_not_acknowledged': { excess: 'money' },
  'error.slip.overpayment_mismatch': { acknowledged: 'money', excess: 'money' },
  'error.slip.foot_mismatch': { allocated: 'money', slip: 'money', difference: 'money' },

  /* ── Organisation — src/organisation/ ─────────────────────────────────────── */
  /**
   * Not constraint translators — neither trips a database CHECK a customer could reach.
   * Both are ordinary `AppError.notFound`s for a row this admin surface expects to exist:
   * a bank account looked up by an id that names nothing, and the one-row
   * `organisation_profile` that migration 0027 seeds and nothing in this application can
   * delete, kept here as a defensive answer rather than a `!` that would throw uglier.
   */
  'error.organisation.account_missing': {},
  'error.organisation.profile_missing': {},
  /** The same shape as the two above, for the tax-country row a PATCH or availability write names. */
  'error.tax_country.missing': {},
  /**
   * Not a constraint translator either — thrown by `TaxCountryService.resolveDestination`
   * (`packages/core/src/vat.ts`'s amended header explains why the destination decides the
   * basis) for a code that names no row at all. Never thrown for a withdrawn
   * (`isActive: false`) country, which resolves normally — see that method's own comment.
   */
  'error.tax_country.unknown_destination': {},

  /*
   * ── Tax-country constraints — src/organisation/pg-errors.ts ────────────────
   *
   * Unlike the two keys just above, these three *are* constraint translators — the note there
   * stopped being true the moment Task 1 added `tax_countries_rate_matches_treatment`. See
   * `pg-errors.ts` for exactly which of the table's CHECKs are reachable through a validated
   * body and which are not.
   */
  'error.tax_country.duplicate': {},
  'error.tax_country.code_taken': {},
  'error.tax_country.name_blank': {},
  'error.tax_country.rate_treatment_conflict': {},
  'error.tax_country.check_failed': {},

  /* ── Staleness — src/quotes/errors.ts, src/orders/order-document.ts ───────── */
  'error.stale.catalog_while_configuring': {},
  'error.stale.catalog_while_editing_quote': {},
  'error.stale.quote_edited_by_someone_else': {},
  'error.stale.override_baselines': {},

  /* ── Configuration — src/quotes/pricing.ts, src/orders/order-document.ts ──── */
  'error.line.cannot_be_made': {},

  /* ── Infrastructure — src/common/errors/all-exceptions.filter.ts ──────────── */
  'error.http.payload_too_large': {},
  'error.http.busy': {},
  /**
   * An unrecognised throw — a bug in this service, said in the caller's language.
   *
   * It was the hard-coded English string `'Internal server error.'`, built at the bottom of
   * `all-exceptions.filter.ts` with `serverMessage: undefined`. That made the 500 the one
   * error a client can actually provoke today that bypassed the catalogue entirely, and it
   * sent English to every one of the eight — including Thai, which every other error in
   * this API answers in.
   *
   * No params: the exception's own message may name a table, a column or a connection
   * string, so it stays in the log where `Error.message` already puts it, and the client
   * gets the request id the envelope carries.
   */
  'error.internal.unexpected': {},
} as const satisfies Readonly<Record<string, Readonly<Record<string, ServerParamKind>>>>;

type Shapes = typeof PARAM_SHAPES;

/** Every key a locale catalogue has to cover. */
export type ServerMessageKey = keyof Shapes;

type ParamsOf<K extends ServerMessageKey> = {
  readonly [P in keyof Shapes[K]]: Shapes[K][P] extends ServerParamKind
    ? ParamByKind[Shapes[K][P]]
    : never;
};

/**
 * A message: a key into the locale catalogue and the values it interpolates.
 *
 * A distributed union rather than `{ key: ServerMessageKey; params: … }`, so narrowing on
 * `key` narrows `params` with it — the property that makes the catalogue in `catalog/th.ts`
 * checkable at compile time instead of by reading it.
 */
export type ServerMessage = {
  [K in ServerMessageKey]: { readonly key: K; readonly params: ParamsOf<K> };
}[ServerMessageKey];

/**
 * The keys whose sentence interpolates nothing.
 *
 * ⚠️ This exists to close a real hole. The five constraint translators hold
 * `Map<constraintName, key>`, and a `Map` value typed as the whole `ServerMessageKey` union
 * would happily accept `'error.slip.foot_mismatch'` — whose catalogue entry then reads
 * `params.allocated` off an empty object and throws inside the exception filter, which is
 * the one place in the process where throwing loses the original error.
 *
 * Typing those maps as `NullaryMessageKey` makes it a compile error instead. A parametric
 * key cannot be looked up from a constraint name, because a constraint name carries no
 * numbers.
 */
export type NullaryMessageKey = {
  [K in ServerMessageKey]: [keyof ParamsOf<K>] extends [never] ? K : never;
}[ServerMessageKey];

/**
 * Every key, derived rather than listed.
 *
 * A hand-kept second list is a list that drifts, and a drifted one fails as a key with no
 * translation in any language, found by a customer.
 */
export const SERVER_MESSAGE_KEYS: readonly ServerMessageKey[] = Object.keys(
  PARAM_SHAPES,
) as ServerMessageKey[];

export const isServerMessageKey = (value: unknown): value is ServerMessageKey =>
  typeof value === 'string' && Object.hasOwn(PARAM_SHAPES, value);

/** Which params a key takes, for a validator that cannot see the type. */
export function paramShapeOf(
  key: ServerMessageKey,
): Readonly<Record<string, ServerParamKind>> {
  return PARAM_SHAPES[key];
}

/**
 * Build a message. The only constructor, so a call site never writes the literal.
 *
 * Generic over `K` so that passing the wrong params for a key does not compile, which is
 * the single reason the `PARAM_SHAPES` gymnastics above are worth it.
 */
export function message<K extends ServerMessageKey>(
  key: K,
  ...params: keyof ParamsOf<K> extends never ? [] : [ParamsOf<K>]
): ServerMessage {
  const [given] = params;
  return { key, params: given ?? {} } as ServerMessage;
}

export function isServerMessage(value: unknown): value is ServerMessage {
  if (typeof value !== 'object' || value === null) return false;
  const { key, params } = value as { key?: unknown; params?: unknown };
  if (!isServerMessageKey(key)) return false;
  if (typeof params !== 'object' || params === null) return false;

  const shape = paramShapeOf(key);
  const record = params as Record<string, unknown>;
  const names = Object.keys(shape);

  /*
   * Extra params are rejected as well as missing ones. A payload carrying a param this key
   * does not take was built by a different version of this service, and guessing which half
   * of it to believe is how a message renders with somebody else's numbers in it.
   */
  if (Object.keys(record).length !== names.length) return false;

  return names.every((name) => {
    const expected = shape[name];
    const param = record[name];
    if (expected === undefined || typeof param !== 'object' || param === null) return false;
    const candidate = param as { kind?: unknown };
    if (candidate.kind !== expected) return false;

    switch (expected) {
      case 'money': {
        const { minor, currency } = param as { minor?: unknown; currency?: unknown };
        return typeof minor === 'bigint' && currency === 'THB';
      }
      case 'count': {
        const { value } = param as { value?: unknown };
        return typeof value === 'number' && Number.isSafeInteger(value);
      }
      case 'code': {
        const { value } = param as { value?: unknown };
        return typeof value === 'string' && value !== '';
      }
    }
  });
}

/* ------------------------------------------------------------------ *
 * The wire
 * ------------------------------------------------------------------ */

/**
 * A message as JSON: the same shape with every `bigint` written out in digits.
 *
 * `JSON.stringify` throws on a `bigint` rather than guessing, which is the one helpful
 * thing it does here. Satang cross the wire as a string of digits for the same reason they
 * do everywhere else in this repo — `Number` loses them above 2^53 and, more to the point,
 * a reader who sees `"553000"` knows to parse it and a reader who sees `5530` does not know
 * whether it is baht.
 */
export type WireMessage = { readonly key: string; readonly params: Record<string, unknown> };

export function encodeServerMessage(value: ServerMessage): WireMessage {
  const params: Record<string, unknown> = {};

  for (const [name, param] of Object.entries(value.params as Record<string, ServerParam>)) {
    params[name] =
      param.kind === 'money'
        ? { kind: 'money', minor: param.minor.toString(), currency: param.currency }
        : param;
  }

  return { key: value.key, params };
}

/**
 * A core `Message` as JSON — **`@wewin/contract`'s encoding, not a second one.**
 *
 * There was a local encoder here that wrote `{ um: "3200000" }`, the shape core's own
 * `reviveMessage` coerces back. It worked, and it was one of two encodings of the same
 * value inside one document: `encodePriceBreakdown` writes the contract's unit-tagged
 * `{ unit: "um", digits: "3200000" }` for a price row's label, and this wrote the bare
 * digits for an issue's message. Two spellings of one quantity is one quantity that hashes
 * two ways, which is the rule `contract/exact.ts` states about itself.
 *
 * It is also the encoding an HTTP client sees, and the contract is where that is decided.
 * Re-exported rather than wrapped so there is nothing here to drift.
 */
export { encodeMessage as encodeCoreMessage } from '@wewin/contract/message';

/**
 * Decode a core `Message` that came back over the wire, or `null`.
 *
 * Re-exported from core rather than reimplemented: this is the same reviver the storefront
 * reads localStorage with, and two decoders for one encoding is one decoder too many.
 */
export { isMessage as isCoreMessage, reviveMessage as reviveCoreMessage };
export type { Message as CoreMessage };
