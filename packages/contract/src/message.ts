import { z } from 'zod';
import {
  type CatalogTextRef,
  type Message,
  type MessageKey,
  type MessageParam,
  MESSAGE_KEYS,
  isMessage,
  isMessageKey,
} from '@wewin/core/message';
import type { LengthUnit } from '@wewin/core/units';
import {
  type AreaWire,
  type LengthWire,
  areaWireSchema,
  decodeSqUm,
  decodeUm,
  encodeSqUm,
  encodeUm,
  lengthUnitSchema,
  lengthWireSchema,
} from './measure.js';

/**
 * A structured message over HTTP — the half of plan section 5 that lives at the boundary.
 *
 * Core stopped building Thai sentences and started emitting `{ key, params }`. That change
 * is worth nothing while the DTO next door still says `messageTh: string`, because the
 * first thing an encoder must then do is pick a language and flatten — and the language it
 * would pick is the server's, months before the reader's browser is consulted. A storefront
 * that fetches its prices instead of computing them locally would be back to one language,
 * with the whole mechanism intact and unreachable behind it. So the key and the values
 * cross the wire, and the reader renders.
 *
 * ## Why the numbers are `Exact` and not bare digit strings
 *
 * A `Message` carries `bigint` micrometres and square micrometres. `JSON.stringify` throws
 * on a `bigint` — helpfully, since the alternative would have been a silent `number` — so
 * something has to encode them. `apps/api` had a local encoder that wrote `{ um: "3200000" }`,
 * which is the shape core's own `reviveMessage` coerces back, and it was the shape that put
 * a raw `bigint` into `documentHash` when it was skipped.
 *
 * This module uses `Exact<'um'>` / `Exact<'um2'>` instead, for the reason `exact.ts` gives
 * at length: the unit travels with the digits. `{ "unit": "um2", "digits": "6000000000000" }`
 * cannot be read as square millimetres by a client this repository does not ship, and
 * `wire.digits / 100` is a compile error rather than a wrong answer.
 *
 * ## What is *not* here
 *
 * No locale, and no rendered text. A `MessageWire` is the same value in every language;
 * choosing one is the reader's job, done by `@wewin/i18n` against the reader's own
 * preference. Plan 10.6 is what makes that separation load-bearing: a notification renders
 * in the recipient's current language and a document in the one pinned at submit, and only
 * a payload that has not already picked one can serve both.
 */

/* ------------------------------------------------------------------ *
 * Params
 * ------------------------------------------------------------------ */

export type CatalogTextRefWire = CatalogTextRef;

export type MessageParamWire =
  | { readonly kind: 'length'; readonly um: LengthWire; readonly unit: LengthUnit }
  | {
      readonly kind: 'lengthRange';
      readonly minUm: LengthWire;
      readonly maxUm: LengthWire;
      readonly unit: LengthUnit;
    }
  | { readonly kind: 'area'; readonly sqUm: AreaWire }
  | {
      readonly kind: 'catalogText';
      readonly ref: CatalogTextRefWire;
      readonly th: string;
    };

/**
 * A message on the wire.
 *
 * `key` is a plain `string` in the type rather than `MessageKey`, and that is deliberate:
 * a client running an older build of core must be able to *hold* a message whose key it
 * does not know, so that it can fall back to something rather than fail to parse the
 * response. `decodeMessage` is where the key is checked against this build's registry, and
 * it returns `null` — never a half-understood message.
 */
export interface MessageWire {
  readonly key: string;
  readonly params: Readonly<Record<string, MessageParamWire>>;
}

/* ------------------------------------------------------------------ *
 * Schemas
 * ------------------------------------------------------------------ */

const catalogTextRefSchema: z.ZodType<CatalogTextRefWire> = z.discriminatedUnion('on', [
  z.object({
    on: z.literal('groupLabel'),
    productId: z.string().min(1),
    groupCode: z.string().min(1),
  }),
  z.object({
    on: z.literal('optionLabel'),
    productId: z.string().min(1),
    groupCode: z.string().min(1),
    valueCode: z.string().min(1),
  }),
  z.object({
    on: z.literal('ruleMessage'),
    productId: z.string().min(1),
    ruleId: z.string().min(1),
  }),
]);

const messageParamWireSchema: z.ZodType<MessageParamWire> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('length'), um: lengthWireSchema, unit: lengthUnitSchema }),
  z.object({
    kind: z.literal('lengthRange'),
    minUm: lengthWireSchema,
    maxUm: lengthWireSchema,
    unit: lengthUnitSchema,
  }),
  z.object({ kind: z.literal('area'), sqUm: areaWireSchema }),
  z.object({
    kind: z.literal('catalogText'),
    ref: catalogTextRefSchema,
    // Non-empty for the same reason core requires it: `th` is the visible fallback every
    // incomplete locale lands on, so an empty one is a message that renders blank in seven
    // languages while looking perfectly well formed in the payload.
    th: z.string().min(1),
  }),
]);

/**
 * A whole message, shape *and* meaning.
 *
 * The second half is a `superRefine` that runs the decoder, because "is this a known key"
 * and "does this key take these params" cannot be spelled in zod without copying core's
 * `PARAM_SHAPES` here — and a second copy of that table is a second copy to drift out of
 * step, whose failure is a message rendered with someone else's numbers in it.
 *
 * Putting it in the schema rather than leaving it to the decoder is what lets a caller that
 * has parsed a payload treat the result as sound. `apps/api` reads pinned order documents
 * back out of JSONB through this schema, so a document written by a future build of core
 * fails as a parse error with a path — which is already the case that produces
 * "เอกสารที่ตรึงไว้ของออร์เดอร์นี้อยู่ในรูปแบบที่ระบบรุ่นนี้อ่านไม่ได้" — rather than as an
 * `undefined` interpolated into a sentence three layers later.
 */
export const messageWireSchema: z.ZodType<MessageWire> = z
  .object({
    key: z.string().min(1),
    params: z.record(z.string(), messageParamWireSchema),
  })
  .superRefine((wire, ctx) => {
    if (!isMessageKey(wire.key)) {
      ctx.addIssue({
        code: 'custom',
        path: ['key'],
        message: `not a message key this build of @wewin/core can produce: ${wire.key}`,
      });
      return;
    }

    if (decodeMessage(wire) === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['params'],
        message: `params do not match the shape of ${wire.key}`,
      });
    }
  });

/** Every key this build of core can produce. Exported so a client can report the gap. */
export const KNOWN_MESSAGE_KEYS: readonly MessageKey[] = MESSAGE_KEYS;

/* ------------------------------------------------------------------ *
 * Encode / decode
 * ------------------------------------------------------------------ */

function encodeParam(param: MessageParam): MessageParamWire {
  switch (param.kind) {
    case 'length':
      return { kind: 'length', um: encodeUm(param.um), unit: param.unit };
    case 'lengthRange':
      return {
        kind: 'lengthRange',
        minUm: encodeUm(param.minUm),
        maxUm: encodeUm(param.maxUm),
        unit: param.unit,
      };
    case 'area':
      return { kind: 'area', sqUm: encodeSqUm(param.sqUm) };
    case 'catalogText':
      return { kind: 'catalogText', ref: param.ref, th: param.th };
  }
}

export function encodeMessage(message: Message): MessageWire {
  const params: Record<string, MessageParamWire> = {};
  for (const [name, param] of Object.entries(message.params as Record<string, MessageParam>)) {
    params[name] = encodeParam(param);
  }
  return { key: message.key, params };
}

function decodeParam(param: MessageParamWire): MessageParam {
  switch (param.kind) {
    case 'length':
      return { kind: 'length', um: decodeUm(param.um), unit: param.unit };
    case 'lengthRange':
      return {
        kind: 'lengthRange',
        minUm: decodeUm(param.minUm),
        maxUm: decodeUm(param.maxUm),
        unit: param.unit,
      };
    case 'area':
      return { kind: 'area', sqUm: decodeSqUm(param.sqUm) };
    case 'catalogText':
      return { kind: 'catalogText', ref: param.ref, th: param.th };
  }
}

/**
 * A `MessageWire` back into a core `Message`, or `null`.
 *
 * The final check is core's `isMessage` and not a rebuilt copy of its param table. That is
 * what makes "the key takes these params, in these kinds, and no others" one rule with one
 * implementation — including the two rejections that only exist there: an extra param the
 * key does not take (written by a different version of core, and guessing which half to
 * believe is how a message renders with someone else's numbers in it), and a `catalogText`
 * with an empty Thai fallback.
 *
 * `null` rather than a throw, because the caller is usually rendering a list and one
 * unreadable row must not blank the page.
 */
export function decodeMessage(wire: MessageWire): Message | null {
  if (!isMessageKey(wire.key)) return null;

  const params: Record<string, MessageParam> = {};
  for (const [name, param] of Object.entries(wire.params)) {
    params[name] = decodeParam(param);
  }

  const rebuilt: unknown = { key: wire.key, params };
  return isMessage(rebuilt) ? rebuilt : null;
}

/**
 * `decodeMessage`, for a wire that has already been through `messageWireSchema`.
 *
 * Throws rather than returning `null`, and the throw is unreachable by construction: the
 * schema runs the same decoder and rejects anything it cannot read. It exists so the decode
 * path for a whole price breakdown does not have to invent a `Message` to stand in for one
 * bad row — there is no such thing, and a placeholder would be a sentence nobody wrote.
 */
export function requireMessage(wire: MessageWire): Message {
  const message = decodeMessage(wire);
  if (message === null) {
    throw new TypeError(
      `message wire did not decode: ${wire.key}. Parse with messageWireSchema first.`,
    );
  }
  return message;
}
