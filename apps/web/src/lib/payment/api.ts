import { reviewsApiBaseUrl } from '../reviews/api';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ WHAT THIS SCREEN ASKS APPS/API FOR — task 13, the screen the plan exists for.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `apps/web` does not depend on `@wewin/contract` — `lib/reviews/wire.ts` and
 * `lib/quotation/api.ts` already made that call and gave the reason at length: a shape is
 * restated and *checked* here rather than imported, so a field renamed six weeks upstream
 * becomes a `malformed` result at the point it was read instead of `undefined` three
 * components deep. This file is the fourth restatement, not the first.
 *
 * 🔗 **The seam:**
 *
 *     GET  /orders/:orderId/payment-instructions   → { grandTotalThbMinor, outstandingThbMinor, accounts[] }
 *     GET  /orders/:orderId/payment-slips           → { slips[] }
 *     POST /orders/:orderId/payment-slips/image      the file, as the body — see uploadSlipImage
 *     POST /orders/:orderId/payment-slips             the slip itself, naming the uploaded bytes
 *
 * Every one of the four is ownership-scoped and answers `Cache-Control: no-store` — a
 * customer's outstanding balance and bank slip history have no business in a shared cache,
 * and `cache: 'no-store'` below is this app's half of that.
 *
 * ── ⚠️ The five traps this module exists to not walk into ────────────────────────
 *
 * The brief names them and they are restated here because this is where each is actually
 * closed, not merely described:
 *
 *   1. `readBoundedBody` on the API side calls `request.destroy()` *while* rejecting an
 *      over-limit upload, so it never reaches the client as a 413 — it reaches as a thrown
 *      `fetch`, indistinguishable from the server being down. `describeUploadProblem` is
 *      the client-side check that must run *before* `uploadSlipImage` is ever called.
 *   2. The API buffers the whole body before it checks the order's status, so
 *      `POST …/image` itself can answer 409 `order_not_accepting_slips` or `too_many_slips`
 *      — not only `POST …` (the create call). `uploadSlipImage`'s failure carries the same
 *      `detail` field `createSlip`'s does, for exactly this reason.
 *   3. `UPLOAD_HANDLE_TTL_SECONDS` is fifteen minutes (`slip-grant.ts`). This module does not
 *      enforce that — it cannot, from the browser — but it is why the caller is told to
 *      upload only once the rest of the form is complete, in `PaymentIsland`.
 *   4. Nothing consumes an upload handle and `storage_key` carries no uniqueness constraint,
 *      so presenting the same `imageHandle` to `createSlip` twice creates two slip rows for
 *      one transfer. This module never retries anything itself — every function here makes
 *      exactly one request and returns exactly one result; the caller decides what happens
 *      next.
 *   5. A 401 here means the access token this call was handed has expired — `SessionProvider`
 *      asks once on mount and never again, so a tab left open outlives its own token. Every
 *      result type below has an `'unauthorized'` problem distinct from `'refused'`, so the
 *      caller can tell "sign in again, and keep what was typed" apart from every other
 *      failure — see `PaymentIsland`.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/* ------------------------------------------------------------------ *
 * Trap 1 — the size check that has to happen before the network call
 * ------------------------------------------------------------------ */

/** Mirrored from `PAYMENT_SLIP_MAX_BYTES` in `apps/api/src/payments/slips/slip-storage.config.ts`. */
export const MAX_SLIP_BYTES = 8 * 1024 * 1024;

/**
 * `null` when the file is small enough to send. There is only one problem this can name —
 * `'too-big'` — because it is the one failure this module can detect *without* a request,
 * and the one request `readBoundedBody` answers by destroying the socket rather than by
 * sending a 413 a client could read.
 */
export function describeUploadProblem(byteSize: number): 'too-big' | null {
  return byteSize > MAX_SLIP_BYTES ? 'too-big' : null;
}

/* ------------------------------------------------------------------ *
 * A `datetime-local` value, made into something `createSlipRequestSchema` accepts
 * ------------------------------------------------------------------ */

/**
 * `<input type="datetime-local">` yields `2026-08-09T14:30` with no timezone designator, and
 * `createSlipRequestSchema.transferredAt` refuses that (`z.string().datetime({ offset: true })`).
 * The browser's own offset is the right one: the customer is reading a time off their
 * banking app, on this device, and `new Date(local)` parses a designator-less date-time
 * string as *local* time — which is exactly the reading a person typing "14:30" meant.
 */
export function toInstant(local: string): string | null {
  if (local.trim() === '') return null;
  const parsed = new Date(local);
  if (Number.isNaN(parsed.getTime())) return null;
  /*
   * ⚠️ `toISOString()` always carries `.sss` milliseconds, which a `datetime-local` input
   * never has anything to fill — it is always `.000`. Stripped rather than kept: the zod
   * schema on the other end (`z.string().datetime({ offset: true })`) accepts both spellings,
   * but a canonical one is one fewer shape a reviewer has to recognise as the same instant.
   */
  return parsed.toISOString().replace(/\.\d{3}Z$/u, 'Z');
}

/* ------------------------------------------------------------------ *
 * Money on the wire — `{ unit: 'THB.satang', digits: '552960' }`, never a JSON number
 * ------------------------------------------------------------------ */

/** The same shape `MyQuotations.tsx` reads, restated because that one is not exported. */
function satang(value: unknown): bigint | null {
  if (!isRecord(value) || value['unit'] !== 'THB.satang') return null;
  const digits = value['digits'];
  return typeof digits === 'string' && /^-?\d+$/u.test(digits) ? BigInt(digits) : null;
}

/* ------------------------------------------------------------------ *
 * Payment instructions — GET /orders/:orderId/payment-instructions
 * ------------------------------------------------------------------ */

/**
 * What a customer may see about an account: never `isActive`, never `sortOrder` — an
 * inactive account is never returned at all, and ordering is the organisation's business.
 */
export interface PaymentAccount {
  readonly id: string;
  readonly bankCode: string;
  readonly accountNumber: string;
  readonly accountName: string;
  readonly promptpayId: string | null;
}

export interface PaymentInstructions {
  readonly grandTotalThbMinor: bigint;
  readonly outstandingThbMinor: bigint;
  readonly accounts: readonly PaymentAccount[];
}

function decodeAccount(value: unknown): PaymentAccount | null {
  if (!isRecord(value)) return null;
  const { id, bankCode, accountNumber, accountName, promptpayId } = value;
  if (
    typeof id !== 'string' ||
    typeof bankCode !== 'string' ||
    typeof accountNumber !== 'string' ||
    typeof accountName !== 'string'
  ) {
    return null;
  }
  return {
    id,
    bankCode,
    accountNumber,
    accountName,
    promptpayId: typeof promptpayId === 'string' ? promptpayId : null,
  };
}

function decodeInstructions(body: unknown): PaymentInstructions | null {
  if (!isRecord(body)) return null;

  const grandTotalThbMinor = satang(body['grandTotalThbMinor']);
  const outstandingThbMinor = satang(body['outstandingThbMinor']);
  const rawAccounts = body['accounts'];
  if (grandTotalThbMinor === null || outstandingThbMinor === null || !Array.isArray(rawAccounts)) {
    return null;
  }

  const accounts: PaymentAccount[] = [];
  for (const raw of rawAccounts) {
    const account = decodeAccount(raw);
    if (account === null) return null;
    accounts.push(account);
  }

  return { grandTotalThbMinor, outstandingThbMinor, accounts };
}

/* ------------------------------------------------------------------ *
 * A slip, as the customer's own history reads it back
 * ------------------------------------------------------------------ */

export type PaymentSlipStatus = 'submitted' | 'accepted' | 'rejected';

export interface PaymentSlip {
  readonly id: string;
  readonly status: PaymentSlipStatus;
  readonly amountThbMinor: bigint;
  /** When this row was written — not `transferredAt`, which is the customer's own claim. */
  readonly createdAt: string;
  readonly rejectedReasonTh: string | null;
}

function decodeSlip(value: unknown): PaymentSlip | null {
  if (!isRecord(value)) return null;

  const { id, status, createdAt, rejectedReasonTh } = value;
  const amountThbMinor = satang(value['amountThbMinor']);

  if (typeof id !== 'string' || typeof createdAt !== 'string' || amountThbMinor === null) {
    return null;
  }
  if (status !== 'submitted' && status !== 'accepted' && status !== 'rejected') return null;

  return {
    id,
    status,
    amountThbMinor,
    createdAt,
    rejectedReasonTh: typeof rejectedReasonTh === 'string' ? rejectedReasonTh : null,
  };
}

function decodeSlipList(body: unknown): readonly PaymentSlip[] | null {
  if (!isRecord(body) || !Array.isArray(body['slips'])) return null;

  const slips: PaymentSlip[] = [];
  for (const raw of body['slips']) {
    const slip = decodeSlip(raw);
    if (slip === null) return null;
    slips.push(slip);
  }
  return slips;
}

/* ------------------------------------------------------------------ *
 * The four calls
 * ------------------------------------------------------------------ */

export type PaymentProblem =
  /** No API base URL. In production a deployment mistake. */
  | 'unconfigured'
  /** The network, or an API that is not running. */
  | 'unreachable'
  /**
   * ⚠️ Trap 5. The access token this call carried has expired — `SessionProvider` asked
   * once, on mount, and this tab has been open longer than the token lives. Distinct from
   * `'refused'` because the right answer is not "show the API's sentence", it is "ask the
   * customer to sign in again, without losing what they typed".
   */
  | 'unauthorized'
  /** The API refused for a reason of its own; `detail` is its own sentence, already in Thai. */
  | 'refused'
  /** 2xx whose body this bundle cannot read. */
  | 'malformed';

export type PaymentResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly problem: PaymentProblem; readonly detail?: string | undefined };

type Sent =
  | { readonly ok: true; readonly response: Response }
  | { readonly ok: false; readonly problem: 'unconfigured' | 'unreachable' };

async function send(path: string, init: RequestInit): Promise<Sent> {
  const base = reviewsApiBaseUrl();
  if (base === null) return { ok: false, problem: 'unconfigured' };

  try {
    const response = await fetch(`${base}${path}`, {
      credentials: 'include',
      cache: 'no-store',
      ...init,
    });
    return { ok: true, response };
  } catch {
    return { ok: false, problem: 'unreachable' };
  }
}

/**
 * A non-2xx response, turned into a problem and the API's own sentence.
 *
 * `401` is `'unauthorized'` and everything else not-ok is `'refused'` — the same split
 * `account.ts`'s `sessionFrom` draws, read off `response.status` rather than off the error
 * envelope's `code` because this app has never needed the full `ErrorCode` union and adding
 * it for one field would be a second catalogue of the same six words `apps/dashboard`
 * already restates.
 */
async function refusal(
  response: Response,
): Promise<{ problem: PaymentProblem; detail?: string | undefined }> {
  const body: unknown = await response.json().catch(() => null);
  const detail =
    isRecord(body) && isRecord(body['error']) && typeof body['error']['message'] === 'string'
      ? body['error']['message']
      : undefined;

  return { problem: response.status === 401 ? 'unauthorized' : 'refused', detail };
}

function authHeaders(accessToken: string): Record<string, string> {
  return { accept: 'application/json', authorization: `Bearer ${accessToken}` };
}

export async function fetchPaymentInstructions(
  orderId: string,
  accessToken: string,
): Promise<PaymentResult<PaymentInstructions>> {
  const sent = await send(`/orders/${encodeURIComponent(orderId)}/payment-instructions`, {
    headers: authHeaders(accessToken),
  });
  if (!sent.ok) return { ok: false, problem: sent.problem };
  if (!sent.response.ok) return { ok: false, ...(await refusal(sent.response)) };

  const body: unknown = await sent.response.json().catch(() => null);
  const data = decodeInstructions(body);
  return data === null ? { ok: false, problem: 'malformed' } : { ok: true, data };
}

export async function fetchSlips(
  orderId: string,
  accessToken: string,
): Promise<PaymentResult<readonly PaymentSlip[]>> {
  const sent = await send(`/orders/${encodeURIComponent(orderId)}/payment-slips`, {
    headers: authHeaders(accessToken),
  });
  if (!sent.ok) return { ok: false, problem: sent.problem };
  if (!sent.response.ok) return { ok: false, ...(await refusal(sent.response)) };

  const body: unknown = await sent.response.json().catch(() => null);
  const data = decodeSlipList(body);
  return data === null ? { ok: false, problem: 'malformed' } : { ok: true, data };
}

/**
 * Upload one photograph. Returns the opaque `imageHandle` the create call presents next.
 *
 * ⚠️ **The `File` is the request body, not `FormData`.** `apps/dashboard/src/components/
 * media/media-api.ts:118-141` explains why at length and the reasoning is exactly the same
 * here: the endpoint reads the request stream directly and bounds it as the bytes arrive,
 * so a multipart envelope would be refused as the wrong content type before a single byte
 * of it was interpreted as an image.
 *
 * ⚠️ Trap 2. A failure here can be the same 409 `order_not_accepting_slips` or
 * `too_many_slips` a failure of `createSlip` can be — the API checks the order's status
 * only *after* buffering this whole body. The caller must render this function's `detail`
 * on a failure of *this* call, not only on a failure of the one after it.
 */
export async function uploadSlipImage(
  orderId: string,
  file: File,
  accessToken: string,
): Promise<PaymentResult<string>> {
  const sent = await send(`/orders/${encodeURIComponent(orderId)}/payment-slips/image`, {
    method: 'POST',
    headers: {
      ...authHeaders(accessToken),
      'content-type': file.type === '' ? 'application/octet-stream' : file.type,
    },
    body: file,
  });
  if (!sent.ok) return { ok: false, problem: sent.problem };
  if (!sent.response.ok) return { ok: false, ...(await refusal(sent.response)) };

  const body: unknown = await sent.response.json().catch(() => null);
  const imageHandle = isRecord(body) && typeof body['imageHandle'] === 'string' ? body['imageHandle'] : null;
  return imageHandle === null ? { ok: false, problem: 'malformed' } : { ok: true, data: imageHandle };
}

export interface CreateSlipInput {
  readonly imageHandle: string;
  readonly amountThbMinor: bigint;
  /** An instant with an offset — pass it through `toInstant` first. */
  readonly transferredAt: string;
  readonly bankReference?: string | undefined;
  /**
   * ⚠️ Required here, not optional — fix round 1. `createSlipRequestSchema` on the API side
   * keeps this field `.optional()`, because the column predates it and a staff-entered slip
   * may have no picker behind it. This screen's picker cannot be bypassed — there is no path
   * through `PaymentIsland` that reaches `createSlip` without an account already chosen — so
   * the type here is stricter than the wire's: a caller that somehow had no id to pass would
   * be a compile error, not a slip with `received_bank_account_id` silently left `NULL`.
   * `tests/payment.test.ts` pins that this function always sends it.
   */
  readonly receivedBankAccountId: string;
}

/**
 * Name the uploaded bytes, and the amount and time they were sent for.
 *
 * ⚠️ Trap 4, restated at the one call site that matters: **calling this twice with the same
 * `imageHandle` creates two slips.** Nothing here retries — one call in, one result out —
 * and the decision about whether a second call is safe belongs to `PaymentIsland`, which
 * knows whether the first call's fate is known.
 */
export async function createSlip(
  orderId: string,
  input: CreateSlipInput,
  accessToken: string,
): Promise<PaymentResult<PaymentSlip>> {
  const sent = await send(`/orders/${encodeURIComponent(orderId)}/payment-slips`, {
    method: 'POST',
    headers: { ...authHeaders(accessToken), 'content-type': 'application/json' },
    body: JSON.stringify({
      imageHandle: input.imageHandle,
      amountThbMinor: { unit: 'THB.satang', digits: input.amountThbMinor.toString() },
      transferredAt: input.transferredAt,
      receivedBankAccountId: input.receivedBankAccountId,
      ...(input.bankReference === undefined ? {} : { bankReference: input.bankReference }),
    }),
  });
  if (!sent.ok) return { ok: false, problem: sent.problem };
  if (!sent.response.ok) return { ok: false, ...(await refusal(sent.response)) };

  const body: unknown = await sent.response.json().catch(() => null);
  const data = decodeSlip(body);
  return data === null ? { ok: false, problem: 'malformed' } : { ok: true, data };
}
