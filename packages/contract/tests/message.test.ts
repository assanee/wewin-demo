import { describe, expect, it } from 'vitest';
import { getProductBySlug } from '@wewin/core/fixtures';
import { calcPrice } from '@wewin/core/pricing';
import { validate } from '@wewin/core/validation';
import { optionStatesFor } from '@wewin/core/option-states';
import { MESSAGE_KEYS, type Message } from '@wewin/core/message';
import type { Product } from '@wewin/core';
import {
  decodeMessage,
  encodeMessage,
  messageWireSchema,
  requireMessage,
} from '../src/message.js';
import { encodePriceResponse, priceResponseWireSchema } from '../src/pricing.js';

/**
 * The boundary phase 5 left unpaid, and phase 6a's whole reason to exist.
 *
 * Core emits `{ key, params }` and eight locales render it — but only for a client that
 * computes its own prices. `PriceLineWire.label` was `string`, `IssueWire.messageTh` was
 * `string`, so the *first* thing an encoder had to do was pick a language and flatten, and
 * the language it picked was the server's, months before a reader's browser was consulted.
 * The mechanism was complete and unreachable, with a `string` between it and every client.
 *
 * These tests hold the two halves of the fix: the values survive the wire exactly, and a
 * payload this build cannot read is refused rather than half-understood.
 */

const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

function fixture(slug: string): Product {
  const product = getProductBySlug(slug);
  if (!product) throw new Error(`test fixture missing product "${slug}"`);
  return product;
}

const awning = fixture('awn-4t');
const selections = { profile_color: 'DW', glass_color: 'GRN', glass_thickness: 'T5' };
const measures = { width: 3_200_000n, height: 1_600_000n };

/** One real message of every shape core can produce, from real calls and not by hand. */
function everyShape(): Message[] {
  const price = calcPrice(awning, selections, measures, 1);
  const outOfRange = validate(
    awning,
    selections,
    { width: 10_000n, height: 1_600_000n },
    { width: 'cm', height: 'cm' },
  );
  const offGrid = validate(
    awning,
    selections,
    { width: 3_202_000n, height: 1_600_000n },
    { width: 'cm', height: 'cm' },
  );

  const states = Object.values(
    optionStatesFor(awning, selections, measures, { width: 'cm', height: 'cm' }),
  ).flatMap((group) => Object.values(group));

  return [
    ...price.lines.map((line) => line.label),
    ...outOfRange.map((issue) => issue.message),
    ...offGrid.map((issue) => issue.message),
    ...states.flatMap((state) => [state.reason, state.warn].filter((m) => m !== undefined)),
  ];
}

describe('a message crosses the wire as a message', () => {
  it('every shape survives JSON and comes back identical', () => {
    const messages = everyShape();
    // A sweep that found nothing would prove nothing: the fixtures really do produce
    // several kinds, including the `area` param that used to throw on `JSON.stringify`.
    expect(messages.length).toBeGreaterThan(2);

    for (const message of messages) {
      const parsed = messageWireSchema.parse(json(encodeMessage(message)));
      expect(decodeMessage(parsed)).toEqual(message);
    }
  });

  it('the square micrometres in a base row are exact after the round trip', () => {
    // The bug that took 194 tests red: `label: line.label` handed core's `Message` — with a
    // `bigint` µm² inside it — straight into a DTO typed `string`, and from there into
    // `canonicalJson`, which threw `Do not know how to serialize a BigInt` while computing a
    // pinned order document's hash. 6,000,000,000,000 is not a number a `double` may round.
    const price = calcPrice(awning, selections, measures, 1);
    const base = price.lines[0];
    if (base === undefined) throw new Error('no base row');

    const wire = json(encodeMessage(base.label));
    expect(JSON.stringify(wire)).toContain('5120000000000');

    const back = requireMessage(messageWireSchema.parse(wire));
    expect(back).toEqual(base.label);
    if (back.key !== 'price.line.base') throw new Error('wrong key');
    expect(back.params.billableArea.sqUm).toBe(5_120_000_000_000n);
    expect(typeof back.params.billableArea.sqUm).toBe('bigint');
  });

  it('the unit travels with the digits, so nothing downstream has to guess', () => {
    // `contract/exact.ts`'s rule, applied here rather than restated. `apps/api` had its own
    // encoder writing the bare digits `{ um: "3200000" }`, which meant one document carried
    // two spellings of one quantity — and two spellings is one quantity that hashes two ways.
    const [message] = everyShape().filter((m) => m.key === 'issue.range.outOfRange');
    if (message === undefined) throw new Error('no out-of-range message in the fixture');

    expect(json(encodeMessage(message))).toMatchObject({
      key: 'issue.range.outOfRange',
      params: { range: { minUm: { unit: 'um' }, maxUm: { unit: 'um' } } },
    });
  });

  it('carries no locale and no rendered text — the reader chooses', () => {
    // Plan 10.6 is what makes this load-bearing: a notification renders in the recipient's
    // current preference and a document in the one pinned at submit, and only a payload that
    // has not already picked a language can serve both.
    const encoded = JSON.stringify(everyShape().map(encodeMessage));
    for (const word of ['locale', 'lang', 'ต้องอยู่ระหว่าง', 'ราคาฐาน']) {
      expect(encoded).not.toContain(word);
    }
    // The Thai *source* of a catalogue string is there, and must be: it is the visible
    // fallback. What is absent is a rendered sentence.
    expect(encoded).toContain('ความกว้าง');
  });
});

describe('a payload this build cannot read is refused, not half-understood', () => {
  const sound = (): unknown => {
    const [first] = everyShape();
    if (first === undefined) throw new Error('no messages');
    return json(encodeMessage(first));
  };

  it('rejects a key no version of core here can produce', () => {
    const wire = { ...(sound() as object), key: 'issue.range.fromTheFuture' };
    expect(messageWireSchema.safeParse(wire).success).toBe(false);
    expect(decodeMessage(wire as never)).toBeNull();
  });

  it('rejects a known key carrying the wrong params', () => {
    // Written by a different build of core. Guessing which half to believe is how a message
    // renders with somebody else's numbers in it — so neither half is believed.
    const price = calcPrice(awning, selections, measures, 1);
    const base = price.lines[0];
    if (base === undefined) throw new Error('no base row');

    const swapped = {
      key: 'issue.range.outOfRange',
      params: (json(encodeMessage(base.label)) as { params: unknown }).params,
    };
    expect(messageWireSchema.safeParse(swapped).success).toBe(false);
  });

  it('rejects an extra param the key does not take', () => {
    const price = calcPrice(awning, selections, measures, 1);
    const base = price.lines[0];
    if (base === undefined) throw new Error('no base row');

    const encoded = json(encodeMessage(base.label)) as { key: string; params: object };
    const extra = {
      key: encoded.key,
      params: {
        ...encoded.params,
        somethingElse: { kind: 'area', sqUm: { unit: 'um2', digits: '1' } },
      },
    };
    expect(messageWireSchema.safeParse(extra).success).toBe(false);
  });

  it('rejects a catalogText with no Thai, which would render blank in seven languages', () => {
    const [message] = everyShape().filter((m) => m.key === 'issue.range.outOfRange');
    if (message === undefined) throw new Error('no out-of-range message');

    const encoded = json(encodeMessage(message)) as {
      key: string;
      params: { group: { th: string } };
    };
    encoded.params.group.th = '';
    expect(messageWireSchema.safeParse(encoded).success).toBe(false);
  });

  it('and `requireMessage` throws rather than inventing a sentence nobody wrote', () => {
    expect(() => requireMessage({ key: 'not.a.key', params: {} })).toThrow(TypeError);
  });
});

describe('a whole price response', () => {
  it('carries keys for every label, issue and option state', () => {
    const price = calcPrice(awning, selections, measures, 1);
    const issues = validate(
      awning,
      selections,
      { width: 10_000n, height: 1_600_000n },
      { width: 'cm', height: 'cm' },
    );

    const wire = json(
      encodePriceResponse({
        productVersionId: '3f1c9d2e-5b47-4a10-9c8e-71d2f0a6b3e4',
        documentHash: 'a'.repeat(64),
        skuCode: 'AWN4T-DW-GRN-T5',
        configHash: '0123456789abcdef',
        price,
        issues,
        optionStates: optionStatesFor(awning, selections, measures, { width: 'cm', height: 'cm' }),
      }),
    );

    const parsed = priceResponseWireSchema.parse(wire);
    expect(parsed.issues.length).toBeGreaterThan(0);
    for (const issue of parsed.issues) {
      expect(MESSAGE_KEYS).toContain(issue.message.key);
    }
    for (const line of parsed.price.lines) {
      expect(MESSAGE_KEYS).toContain(line.label.key);
    }
  });
});
