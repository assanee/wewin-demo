/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ What a settings history decides — the rail's arithmetic, and the citable record.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Two things, both pure, both previously either absent or done in a `.tsx` where they could not be
 * proved: **which segment of rail a given entry draws**, and **the record layer under the reading**.
 * The elapsed-time label is the third and lives in `elapsed.ts`, because it is shared with the order
 * spine and is not about settings.
 *
 * ── ⚠️⭐ THE LINE THIS FILE EXISTS TO KEEP ───────────────────────────────────
 *
 * `order-timeline.ts` states it for the order spine and the same two obligations apply to all
 * four `*_changes` tables, so it is not restated differently here — only pointed at, because a
 * second wording of one rule is how two screens drift:
 *
 *     the reading    what changed, in Thai, at a glance. An *interpretation*, expected to get
 *                    better, and a better one must reach every row ever written. That is
 *                    `changedFields` / `taxCountryChangedFields` / `profileChangedFields` /
 *                    `authority-limits.ts`'s `changedFields` — four readers, already good, and
 *                    this file replaces none of them.
 *
 *     the record     what was stored: the row id, the full actor uuid, the precise `changed_at`,
 *                    and the `before`/`after` snapshots key by key. The **citable** thing. It
 *                    must not change, and nothing here can change it, because nothing here writes.
 *
 * The reading answers "did somebody widen this and narrow it back". The record is what gets pasted
 * into the message that reports it. Each of these four dialogs shows strictly less than its table
 * stores — the actor is truncated to eight characters, `changed_at` is rounded to the minute, and
 * the fields that did *not* move are filtered out entirely — every one of which is right for
 * reading and wrong for quoting. So: the reading stays on the surface, the record opens on demand.
 *
 * ⚠️ **The rendered sentence is never stored alongside the entry, and must not be** — same trade,
 * same reasoning, as `order-timeline.ts`'s header. The snapshots underneath are already frozen and
 * already inspectable, which is what citation actually needs.
 *
 * No React here: `apps/dashboard`'s vitest is `environment: 'node'` and a `.test.tsx` is silently
 * never collected, so anything that decides what a value *means* has to live in a `.ts` module or
 * it cannot be proved at all.
 */

/* ------------------------------------------------------------------ *
 * The rail
 * ------------------------------------------------------------------ */

/**
 * Which segment of rail sits behind one entry.
 *
 *   `from-marker`  the first of several: the line starts at this marker's centre and runs down
 *   `full`         a middle entry: the line passes through
 *   `to-marker`    the last of several: the line arrives at this marker's centre and stops
 *   `none`         the only entry there is
 *
 * ⚠️⭐ **`none` is the state the order spine does not have, and it is why this is a function rather
 * than a ternary in the component.** A spine always has a terminus below its last event — the
 * buttons, or the sentence that replaces them — so every row there has something to connect to, and
 * `order-spine.tsx` correspondingly has three rail constants and no fourth. A settings history has
 * no terminus at all, so a history of exactly one entry has nothing above it and nothing below it,
 * and a stub of line hanging off a lone marker is a rail asserting a sequence that does not exist.
 * That case is not hypothetical: of the seven subjects with history in the dev database, the
 * shallowest is a bank account with three entries and `organisation_profile_changes` starts every
 * fresh database at one.
 *
 * ⚠️ The off-by-one that this exists to make provable is the `to-marker`/`full` boundary: `total - 1`
 * as `total` renders the last entry with a line running off the bottom of the list, which is
 * precisely the artefact a reviewer reads as "there is more below, scroll" on a list that has
 * ended. It is invisible to a markup assertion and awkward to catch in a screenshot.
 */
export type RailSegment = 'from-marker' | 'full' | 'to-marker' | 'none';

export function railSegment(index: number, total: number): RailSegment {
  const above = index > 0;
  const below = index < total - 1;

  if (above) return below ? 'full' : 'to-marker';
  return below ? 'from-marker' : 'none';
}

/* ------------------------------------------------------------------ *
 * The record
 * ------------------------------------------------------------------ */

/**
 * One key of a snapshot pair, verbatim on both sides.
 *
 * `inBefore` / `inAfter` distinguish **"stored as empty"** from **"not stored at all"**, which no
 * amount of text in `beforeText` could do unambiguously: a snapshot holding the string `"null"`
 * and a snapshot holding no such key would otherwise print identically, and on an audit trail
 * those are different facts.
 */
export interface RecordLine {
  readonly key: string;
  readonly beforeText: string;
  readonly afterText: string;
  readonly inBefore: boolean;
  readonly inAfter: boolean;
}

/**
 * ⚠️⭐ THE HAZARD THIS FUNCTION EXISTS FOR: **`JSON.stringify` throws on a `bigint`.**
 *
 * Three of the four change logs carry `before`/`after` as `Record<string, unknown>` decoded
 * straight off jsonb, so every leaf is a JSON primitive. The fourth does not:
 * `AuthorityLimitChangeView`'s snapshots are *typed*, and `maxConcessionThbMinor` is a **`bigint`**
 * — widened by `minorOf` on purpose, because a ceiling is compared against a concession and both
 * can exceed 2^53 in satang.
 *
 * `JSON.stringify(1n)` is a `TypeError`, not a fallback. A record layer that reached for it would
 * throw inside render on the authority dialog *only* — the one of the four whose subject is who
 * may give away money — and React would unmount the dialog to a blank. It would also pass every
 * test written against the other three, and pass a screenshot of them, and fail in front of an
 * administrator. Hence `bigint` is the first branch here and the replacer below exists for a
 * `bigint` nested inside an object.
 *
 * Everything else is ordinary honesty about a `Record<string, unknown>`: the snapshots are a
 * free-form thing the server decided to keep (`organisation.service.ts`'s `RECORDED` and friends),
 * not a shape this dashboard validates, so no branch may assume a type.
 */
export function recordValueText(value: unknown): string {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return value;
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  try {
    return JSON.stringify(value, (_key, nested) =>
      typeof nested === 'bigint' ? nested.toString() : nested,
    ) ?? String(value);
  } catch {
    /* A circular snapshot cannot arrive off jsonb, but a record layer that threw would be worse
     * than one that printed `[object Object]`. */
    return String(value);
  }
}

/**
 * ⭐ A snapshot pair as verbatim lines — **every key in either side, always, on both sides**.
 *
 * ⚠️⚠️ **THE UNION, NOT `Object.keys(after)`.** This is the one rule the function exists to
 * enforce and the failure it prevents is silent. The services snapshot a fixed field list on every
 * write (`RECORDED`, `PROFILE_RECORDED`, `AuthorityService.snapshot`), so in practice both sides
 * carry identical key sets — which means a key present in one and absent from the other is an
 * **anomaly**, and an anomaly is the single most interesting thing an audit layer can be looking
 * at. Iterating `after` alone would drop a field that was removed; iterating `before` alone would
 * drop one that was added. Either way the line vanishes with nothing to indicate it ever existed,
 * on a screen whose entire value is that it is complete. Same posture as `payloadLines` rendering
 * an unknown payload key rather than skipping it, and `statusLabel` printing an unrecognised
 * status as its own code.
 *
 * ⚠️ **Sorted, and that is a decision about *diffability* rather than a fallback ordering.** The
 * four readers above this one order their fields by a hand-written domain list, for the reason
 * `changedFields` gives: arrival order makes the same field jump around the screen from entry to
 * entry. A raw record has no domain order to borrow — but it has a stronger requirement, which is
 * that **`before` and `after` must print in the same order or they cannot be compared by eye**,
 * and `Object.keys` on two separately-parsed JSON objects does not promise that. A codepoint sort
 * promises it for both sides at once. It is deliberately not `localeCompare`: these keys are ASCII
 * `camelCase` and a locale-sensitive collation would make the order depend on the reader's ICU
 * build.
 *
 * `before === null` — a creation, or an authority grant — yields every key with `inBefore: false`.
 * The caller renders that as one column rather than two; there is nothing to diff against.
 */
export function recordLines(
  before: Readonly<Record<string, unknown>> | null,
  after: Readonly<Record<string, unknown>>,
): readonly RecordLine[] {
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after)])].sort();

  return keys.map((key) => {
    const inBefore = before !== null && Object.hasOwn(before, key);
    const inAfter = Object.hasOwn(after, key);

    return {
      key,
      beforeText: inBefore ? recordValueText(before[key]) : '',
      afterText: inAfter ? recordValueText(after[key]) : '',
      inBefore,
      inAfter,
    };
  });
}
