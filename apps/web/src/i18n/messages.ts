import type {
  CatalogTextParam,
  Message,
  MessageKey,
  MessageParamsByKey,
} from '@wewin/core/message';
import { formattersFor, type Formatters } from './format';
import { resolveCatalogText, refKey, type ContentCatalogues } from './content';
import { SOURCE_LOCALE, type Locale } from './locales';

/**
 * The other half of `@wewin/core/message`: the layer that turns a key and its params
 * into a sentence.
 *
 * Core stopped building Thai this round — `validation.ts` no longer imports
 * `format.ts` at all — and this is where the formatting it gave up now happens. The
 * arrangement is the one core's own module comment predicts: **the layer that knows
 * the locale renders the values.**
 *
 * A renderer receives the params typed to its own key, so an entry that forgets to
 * interpolate the range in `issue.range.outOfRange` does not compile. That is not a
 * nicety: the message is the only thing on screen telling a customer *why* the size
 * they typed was refused, and a version of it with the bounds missing is worse than
 * no message, because it looks like a complete sentence.
 */

/** What a renderer is handed besides its params. */
export interface MessageContext {
  readonly f: Formatters;
  /** Catalogue content, resolved for this locale, falling back to the Thai source. */
  readonly text: (param: CatalogTextParam) => string;
}

export type MessageRenderers = {
  readonly [K in MessageKey]: (params: MessageParamsByKey[K], ctx: MessageContext) => string;
};

export type PartialMessageRenderers = {
  readonly [K in MessageKey]?: (params: MessageParamsByKey[K], ctx: MessageContext) => string;
};

/**
 * Thai — the source, and a character-for-character reproduction of the sentences
 * `validation.ts`, `optionStates.ts` and `pricing.ts` used to build themselves.
 *
 * Core's `messages.test.ts` holds the same nine sentences and pins them against the
 * pre-6a output. This copy is pinned against *that* in `messages.test.ts` here, so the
 * two renderers cannot drift into two different Thai translations of one rule — which
 * is exactly the failure the `Message` type was introduced to make impossible between
 * the tooltip and the issue panel.
 */
export const messagesTh: MessageRenderers = {
  'issue.selection.unknown': (p, c) =>
    `${c.text(p.group)}ที่เลือกไว้ไม่มีอยู่ในรายการของสินค้านี้ — กรุณาเลือกใหม่`,

  'issue.range.outOfRange': (p, c) =>
    `${c.text(p.group)}ต้องอยู่ระหว่าง ${c.f.range(p.range.minUm, p.range.maxUm, p.range.unit)}`,

  'issue.step.willSnapUp': (p, c) =>
    `${c.text(p.group)}ปรับได้ทีละ ${c.f.measure(p.step.um, p.step.unit)} ระบบจะปัดเป็น ${c.f.measure(
      p.snapped.um,
      p.snapped.unit,
    )}`,

  'issue.step.aboveLargestMark': (p, c) =>
    `${c.text(p.group)}ปรับได้ทีละ ${c.f.measure(
      p.step.um,
      p.step.unit,
    )} ค่าสูงสุดที่ปรับได้คือ ${c.f.measure(p.largest.um, p.largest.unit)}`,

  'issue.step.noMarkInRange': (p, c) =>
    `${c.text(p.group)}ปรับได้ทีละ ${c.f.measure(
      p.step.um,
      p.step.unit,
    )} และไม่มีค่าที่ลงตัวในช่วง ${c.f.range(p.range.minUm, p.range.maxUm, p.range.unit)}`,

  // A rule's prose is written by a person in the catalogue. There is nothing for a
  // locale to arrange around it, which is why this key carries one param and no words.
  'issue.rule': (p, c) => c.text(p.message),

  'option.unavailable': (p, c) =>
    `ตอนนี้${c.text(p.group)} "${c.text(p.option)}" ยังไม่พร้อมผลิต`,

  // The area is the param `pricing.ts` gained this round. The old label was the bare
  // constant `ราคาฐานตามพื้นที่`, which named no area — so a base charge computed on
  // the product's floor rather than on the size on screen had nowhere to say so.
  'price.line.base': (p, c) => `ราคาฐานตามพื้นที่ ${c.f.area(p.billableArea.sqUm)} ตร.ม.`,

  // The `·` was `pricing.ts`'s choice until this round. It is typography, so it is the
  // locale's.
  'price.line.option': (p, c) => `${c.text(p.group)} · ${c.text(p.option)}`,
};

/** English — the second complete renderer, and the one that disagrees about order. */
export const messagesEn: PartialMessageRenderers = {
  'issue.selection.unknown': (p, c) =>
    `The ${c.text(p.group)} saved with this item is not offered for this product — please choose again.`,

  'issue.range.outOfRange': (p, c) =>
    `${c.text(p.group)} must be between ${c.f.range(p.range.minUm, p.range.maxUm, p.range.unit)}.`,

  'issue.step.willSnapUp': (p, c) =>
    `${c.text(p.group)} adjusts in steps of ${c.f.measure(
      p.step.um,
      p.step.unit,
    )}, so this will be rounded up to ${c.f.measure(p.snapped.um, p.snapped.unit)}.`,

  'issue.step.aboveLargestMark': (p, c) =>
    `${c.text(p.group)} adjusts in steps of ${c.f.measure(
      p.step.um,
      p.step.unit,
    )}, and the largest size available is ${c.f.measure(p.largest.um, p.largest.unit)}.`,

  'issue.step.noMarkInRange': (p, c) =>
    `${c.text(p.group)} adjusts in steps of ${c.f.measure(
      p.step.um,
      p.step.unit,
    )}, and no such size falls between ${c.f.range(p.range.minUm, p.range.maxUm, p.range.unit)}.`,

  'issue.rule': (p, c) => c.text(p.message),

  'option.unavailable': (p, c) =>
    `“${c.text(p.option)}” is not available to make at the moment (${c.text(p.group)}).`,

  'price.line.base': (p, c) => `Base price for ${c.f.area(p.billableArea.sqUm)} m²`,

  'price.line.option': (p, c) => `${c.text(p.group)} · ${c.text(p.option)}`,
};

/**
 * The renderers per locale. Six are absent, exactly as their UI catalogues are.
 *
 * A locale with no renderer here falls back to Thai words *with its own numbers* —
 * `f` follows the active locale in every case — which is the same bargain the UI
 * catalogue strikes and for the same reason.
 */
const RENDERERS: Partial<Record<Locale, PartialMessageRenderers>> = {
  en: messagesEn,
  th: messagesTh,
};

export interface RenderedMessage {
  readonly text: string;
  /**
   * True when **any part** of the sentence came from Thai.
   *
   * Two things can fall back independently and the flag has to cover both, because the
   * caller uses it to decide whether to set `lang="th"` on the element:
   *
   *   - the *sentence*, when this locale has no renderer for the key;
   *   - a *`catalogText` param*, when the content catalogue has no translation of the
   *     group label, option label or rule prose the sentence interpolates.
   *
   * It used to report only the first, and the consequence was live: with English complete
   * and the content catalogue empty, `ความกว้าง must be between 60–600 cm.` rendered
   * unmarked inside `<html lang="en">`, because the *sentence* was English. A screen
   * reader then pronounced the Thai in an English voice, and the one signal that says
   * "this bit is not translated yet" was structurally unable to fire on the only bit that
   * was not.
   */
  readonly fallback: boolean;
}

/**
 * Nine cases that all read the same, and cannot be collapsed.
 *
 * `(renderers[m.key] ?? messagesTh[m.key])(m.params, ctx)` is correct for any one key
 * and unsound for the union of them: with `m` still a union, `renderers[m.key]` is a
 * union of nine function types whose parameters intersect, and no single `params`
 * satisfies all nine. Writing the cases out is what narrows `params` alongside `key`,
 * which is the property core's `Message` was shaped as a distributed union to give —
 * and it is also the exhaustiveness check that makes adding a tenth key to core a
 * compile error here rather than a blank line on the screen.
 */
function renderText(
  message: Message,
  renderers: PartialMessageRenderers,
  ctx: MessageContext,
): string {
  switch (message.key) {
    case 'issue.selection.unknown':
      return (renderers[message.key] ?? messagesTh[message.key])(message.params, ctx);
    case 'issue.range.outOfRange':
      return (renderers[message.key] ?? messagesTh[message.key])(message.params, ctx);
    case 'issue.step.willSnapUp':
      return (renderers[message.key] ?? messagesTh[message.key])(message.params, ctx);
    case 'issue.step.aboveLargestMark':
      return (renderers[message.key] ?? messagesTh[message.key])(message.params, ctx);
    case 'issue.step.noMarkInRange':
      return (renderers[message.key] ?? messagesTh[message.key])(message.params, ctx);
    case 'issue.rule':
      return (renderers[message.key] ?? messagesTh[message.key])(message.params, ctx);
    case 'option.unavailable':
      return (renderers[message.key] ?? messagesTh[message.key])(message.params, ctx);
    case 'price.line.base':
      return (renderers[message.key] ?? messagesTh[message.key])(message.params, ctx);
    case 'price.line.option':
      return (renderers[message.key] ?? messagesTh[message.key])(message.params, ctx);
  }
}

/** Render one core `Message` for a locale, reporting whether the words fell back. */
export function renderMessage(
  message: Message,
  locale: Locale,
  contentCatalogues?: ContentCatalogues,
): RenderedMessage {
  const own = RENDERERS[locale];

  // Collected during the render rather than predicted before it: which params a key
  // interpolates is the renderer's business, and asking that question here would be a
  // second copy of the answer.
  let paramFellBack = false;

  const context: MessageContext = {
    f: formattersFor(locale),
    text: (param) => {
      const resolved = resolveCatalogText(param, locale, contentCatalogues);
      if (resolved.fallback) paramFellBack = true;
      return resolved.text;
    },
  };

  const text = renderText(message, own ?? {}, context);
  const sentenceFellBack = own?.[message.key] === undefined && locale !== SOURCE_LOCALE;

  return { text, fallback: sentenceFellBack || paramFellBack };
}

/**
 * A stable identity for a message, independent of the language it is read in.
 *
 * `PriceBreakdownList` used the row's label as its React `key`, which worked only
 * while the label was a Thai string that happened to be unique. A rendered sentence
 * cannot be that key any more: switching language would change every key at once and
 * make React discard and rebuild the whole list, and two rows whose translations
 * collide would trip the duplicate-key warning in one locale and not another.
 *
 * So the identity is built from the key and the refs — the things that say *which*
 * message this is — and never from the words.
 */
export function messageIdentity(message: Message): string {
  const parts: string[] = [message.key];

  for (const param of Object.values(message.params)) {
    switch (param.kind) {
      case 'catalogText':
        parts.push(refKey(param.ref));
        break;
      case 'length':
        parts.push(`${param.um.toString()}${param.unit}`);
        break;
      case 'lengthRange':
        parts.push(`${param.minUm.toString()}-${param.maxUm.toString()}${param.unit}`);
        break;
      case 'area':
        parts.push(param.sqUm.toString());
        break;
    }
  }

  return parts.join('|');
}
