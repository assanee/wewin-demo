import { describe, expect, it } from 'vitest';

import { MAX_SLIP_BYTES, describeUploadProblem, toInstant } from '../src/lib/payment/api';

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
