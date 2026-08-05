import { catalogueOf, covers, THAI_CATALOGUE } from './catalog';
import type { AnyCatalogueEntry } from './catalog/types';
import { formattersOf } from './format';
import { FALLBACK_LOCALE, resolveAgainst, type RenderLocale, type SupportedLocale } from './locales';
import type { ServerMessage, ServerMessageKey } from './message';

/**
 * A message plus the language it actually came out in.
 *
 * `locale` travels with the text rather than being discarded, for the same reason
 * `notification_attempts.locale` records what was sent rather than what was asked for: the
 * fact "we answered them in Thai because we have no Burmese" has to survive to the place
 * that could act on it — an envelope field, a log line, a dispute six months later.
 */
export interface RenderedMessage {
  readonly text: string;
  readonly locale: RenderLocale;
}

/**
 * The single exit from a `ServerMessage` to a string a person reads.
 *
 * ── Fallback is per message, not per request ─────────────────────────────────────
 *
 * `resolveAgainst` is asked about *this key*, so a German reader gets German for the nine
 * keys German has and Thai for the rest, in the same session and sometimes in the same
 * response. That is deliberate: the alternative — pick one language per request and stick
 * to it — sounds tidier and means a locale contributes nothing until it is finished.
 *
 * ── The Thai entry is fetched from the complete catalogue, not from the resolved one ──
 *
 * Even after `resolveAgainst` says `th`, the lookup goes through `THAI_CATALOGUE`, whose
 * type is `Catalogue` and not `PartialCatalogue`. That is what makes the `undefined` branch
 * below unreachable for Thai and lets this function have no "no message at all" case. There
 * is no path here that returns a key, an empty string, or `[missing]` — the worst outcome is
 * a Thai sentence.
 */
export function renderServerMessage(
  value: ServerMessage,
  requested: string | null,
): RenderedMessage {
  const locale = resolveAgainst(requested, (candidate) => covers(candidate, value.key));
  const entry = entryFor(locale.rendered, value.key);

  return { text: apply(entry, value, locale.rendered), locale };
}

/** Thai, without negotiating. For a log line, a document reprint, or an internal queue. */
export function renderInThai(value: ServerMessage): string {
  return apply(entryFor(FALLBACK_LOCALE, value.key), value, FALLBACK_LOCALE);
}

/**
 * Render in a locale that was chosen elsewhere — a document's pinned one, most of all.
 *
 * Separate from `renderServerMessage` because it takes a `SupportedLocale` rather than a
 * request's preference, and that difference is plan 10.6's whole point: a document does not
 * negotiate. It still degrades to Thai for an untranslated key, and it still says so.
 */
export function renderIn(value: ServerMessage, locale: SupportedLocale): RenderedMessage {
  const resolved = resolveAgainst(locale, (candidate) => covers(candidate, value.key));
  return { text: apply(entryFor(resolved.rendered, value.key), value, resolved.rendered), locale: resolved };
}

function entryFor(locale: SupportedLocale, key: ServerMessageKey): AnyCatalogueEntry {
  const entry = catalogueOf(locale)[key];
  /*
   * `?? THAI_CATALOGUE[key]` and not an assertion. `resolveAgainst` has already checked
   * coverage, so this is belt and braces — but the belt is a `Partial` lookup and the
   * braces cost one `??`, and the failure it guards against is a blank message rather than
   * a crash, which is the failure mode nobody notices.
   */
  return entry ?? THAI_CATALOGUE[key];
}

function apply(
  entry: AnyCatalogueEntry,
  value: ServerMessage,
  locale: SupportedLocale,
): string {
  if (typeof entry === 'string') return entry;

  /*
   * The cast is the one place the derived-union machinery has to be taken on trust, and it
   * is narrow: `CatalogueEntry<K>` is a function exactly when `ParamsFor<K>` is non-empty,
   * and `ServerMessage` pairs each key with those same params — both from `PARAM_SHAPES`.
   * TypeScript cannot see that through a `ServerMessageKey` that is no longer narrowed to a
   * single member, which is a limitation of the checker rather than of the design. The
   * catalogue files, where a mismatch would actually be written, are fully checked.
   */
  const render = entry as (params: unknown, fmt: ReturnType<typeof formattersOf>) => string;
  return render(value.params, formattersOf(locale));
}
