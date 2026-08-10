import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_SLIP_BYTES, createSlip, describeUploadProblem, toInstant } from '../src/lib/payment/api';

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
