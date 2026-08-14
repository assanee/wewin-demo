import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_SLIP_BYTES,
  createSlip,
  describeUploadProblem,
  fetchPaymentInstructions,
  toInstant,
} from '../src/lib/payment/api';

describe('an oversize image is refused before it is sent', () => {
  it('names the size, and does not claim the server is unreachable', () => {
    /*
     * ⚠️ readBoundedBody calls request.destroy() *while* rejecting, so an over-limit upload
     * surfaces in the browser as a thrown fetch and lands in the catch — which is the
     * 'unreachable' branch. Without a client-side check the customer is told the server is
     * down about a photo that was merely too big.
     */
    expect(describeUploadProblem(MAX_SLIP_BYTES + 1)).toBe('too-big');
    expect(describeUploadProblem(MAX_SLIP_BYTES)).toBeNull();
  });
});

describe('a datetime-local value becomes something the API accepts', () => {
  it('adds an offset, because zod refuses a bare local time', () => {
    // Verified against the installed zod: '+07:00' ok, 'Z' ok, no designator refused.
    expect(toInstant('2026-08-09T14:30')).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([+-]\d{2}:\d{2}|Z)$/u);
  });

  it('refuses an empty or unparseable value rather than sending it', () => {
    expect(toInstant('')).toBeNull();
    expect(toInstant('not a time')).toBeNull();
  });
});

describe('createSlip always names which account received the transfer — fix round 1', () => {
  /*
   * ⚠️ THE TEST THAT ACTUALLY MATTERS, per the coordinator's own framing. The API's
   * `createSlipRequestSchema` keeps `receivedBankAccountId` optional on purpose — a
   * staff-entered slip may have no picker behind it — so nothing on the wire enforces that
   * this storefront always sends one. `CreateSlipInput.receivedBankAccountId` being a
   * required *TypeScript* property only proves a caller passed a string in; it says nothing
   * about whether `createSlip`'s own body still forwards it to the network. A refactor that
   * dropped the one line serialising it into the JSON body would leave every other test in
   * this file green and would leave `payment_slips.received_bank_account_id` NULL for every
   * slip this screen ever produces again — which is exactly the regression this task's fix
   * round exists to close. Reading the actual `fetch` call is the only way to notice.
   */
  const originalBase = process.env.NEXT_PUBLIC_API_BASE_URL;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_API_BASE_URL = 'https://api.example';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalBase === undefined) delete process.env.NEXT_PUBLIC_API_BASE_URL;
    else process.env.NEXT_PUBLIC_API_BASE_URL = originalBase;
  });

  it('sends the chosen account id in the create body, alongside everything else typed', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'slip-1',
          orderId: 'order-1',
          status: 'submitted',
          amountThbMinor: { unit: 'THB.satang', digits: '10000' },
          createdAt: new Date().toISOString(),
          rejectedReasonTh: null,
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const result = await createSlip(
      'order-1',
      {
        imageHandle: 'handle-1',
        amountThbMinor: 100_00n,
        transferredAt: '2026-08-09T07:30:00Z',
        receivedBankAccountId: 'account-1',
      },
      'token-1',
    );

    expect(result.ok).toBe(true);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sentBody['receivedBankAccountId']).toBe('account-1');
    // The rest of the body survives the change too — this is not a test that only exercises
    // the one new field while breaking everything beside it silently.
    expect(sentBody['imageHandle']).toBe('handle-1');
    expect(sentBody['amountThbMinor']).toEqual({ unit: 'THB.satang', digits: '10000' });
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ THE INSTRUCTIONS DECODER HAD NO TEST AT ALL, AND IT IS THE SCREEN'S DOOR.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `decodeInstructions` is module-private and nothing reached it: this file covers `createSlip`,
 * `describeUploadProblem` and `toInstant`, and adding a *required* field to the decoder broke
 * none of them. Its own comments make three claims about behaviour on a missing field — that
 * `nextDueThbMinor` must not fall back to the outstanding, and that neither boolean may default,
 * because every default ships a defect — and nothing was checking any of them.
 *
 * That matters most on version skew, which is the only way these fields go missing in
 * production: an API a deploy behind omits one, and the intended answer is a loud "try again"
 * rather than a screen that quietly bills the wrong number. Softening any of these to `?? …`
 * would have left the whole suite green.
 *
 * Driven through `fetchPaymentInstructions` rather than by exporting the decoder — the boundary
 * worth testing is the one the screen actually calls.
 */
describe('⭐ the payment-instructions decoder refuses a payload it cannot trust', () => {
  const originalBase = process.env.NEXT_PUBLIC_API_BASE_URL;

  const complete = {
    grandTotalThbMinor: { unit: 'THB.satang', digits: '1479168' },
    outstandingThbMinor: { unit: 'THB.satang', digits: '1035418' },
    nextDueThbMinor: { unit: 'THB.satang', digits: '443750' },
    /* Nothing forgiven — the state of every order except the handful somebody has written off. */
    writtenOffThbMinor: { unit: 'THB.satang', digits: '0' },
    orderIsLive: true,
    accounts: [],
  } as const;

  const answer = (body: unknown): void => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
  };

  beforeEach(() => {
    process.env.NEXT_PUBLIC_API_BASE_URL = 'https://api.example';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalBase === undefined) delete process.env.NEXT_PUBLIC_API_BASE_URL;
    else process.env.NEXT_PUBLIC_API_BASE_URL = originalBase;
  });

  it('accepts a complete payload, and keeps the two figures apart', async () => {
    answer(complete);

    const result = await fetchPaymentInstructions('order-1', 'token-1');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    /* Distinct on a 30/70 order: what is still owed, and what to pay now. */
    expect(result.data.outstandingThbMinor).toBe(1_035_418n);
    expect(result.data.nextDueThbMinor).toBe(443_750n);
    expect(result.data.writtenOffThbMinor).toBe(0n);
    expect(result.data.orderIsLive).toBe(true);
  });

  /*
   * One case per field the decoder declares required. `malformed` and not a silent default: the
   * problem code is what puts a "try again" on screen instead of a wrong number.
   */
  for (const missing of [
    'grandTotalThbMinor',
    'outstandingThbMinor',
    'nextDueThbMinor',
    /*
     * ⭐ Required, and the direction of the default it refuses is the point: a missing write-off
     * figure read as `0n` would put *"ออเดอร์นี้ชำระครบแล้ว"* back on a forgiven order's screen,
     * silently, on any deployment whose API is a version behind this bundle.
     */
    'writtenOffThbMinor',
    /*
     * ⚠️ `acceptsPayment` was a fifth entry here until `0046_slips_after_delivery.sql` made it
     * answer identically to `orderIsLive` on every status and the wire dropped it. It is not
     * merely no longer required — an unknown key is ignored by the decoder, so a case for it
     * would have passed by testing nothing.
     */
    'orderIsLive',
  ] as const) {
    it(`refuses the whole payload when ${missing} is absent`, async () => {
      const { [missing]: _dropped, ...partial } = complete;
      answer(partial);

      const result = await fetchPaymentInstructions('order-1', 'token-1');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.problem).toBe('malformed');
    });
  }

  it('refuses a boolean sent as a string, which is how a JSON encoder loses a type', async () => {
    answer({ ...complete, orderIsLive: 'true' });

    const result = await fetchPaymentInstructions('order-1', 'token-1');

    expect(result.ok).toBe(false);
  });
});
