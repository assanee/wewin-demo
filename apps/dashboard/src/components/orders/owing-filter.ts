/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ WHAT THE ORDER LIST SAYS WHEN IT IS SHOWING ONLY THE ORDERS THAT OWE MONEY.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The owner asked for this so somebody could chase what is owed:
 * *"ต้องสามารถตรวจได้ว่า order ไหนบ้างที่ยังชำระไม่ครบ เพราะให้สามารถติดตามตรวจสอบได้"*.
 *
 * ── ⚠️ THE COUNT IS HONEST BECAUSE IT IS A COUNT AND NOT A SUM ───────────────
 *
 * The obvious thing to print beside a list of debts is their total, and it is the one number
 * this screen must not print. The list is fetched with `limit`, so on a company owing money on
 * more orders than the page holds, a sum of the rows understates the debt and nothing on screen
 * says so — the reader is not told they are looking at a page. The overview's money card already
 * carries the authoritative total, folded over every live order in Postgres, and that is where a
 * total belongs.
 *
 * `apps/dashboard/src/components/overview/outstanding-breakdown.ts` learned this the expensive
 * way: it decided "these are all of them" by comparing a TypeScript sum of its rows against the
 * server's aggregate, two numbers taken over different predicates, and claimed truncation
 * whenever any live order was overpaid. A count of what is on screen cannot be wrong about
 * itself.
 *
 * So: how many orders are shown, and — when the page is full — that there may be more. Not a
 * baht figure. The per-row ค้างชำระ column is where the amounts already are.
 */

/** What the list is filtered to. Two independent axes, exactly as the API models them. */
export interface OwingFilterInput {
  /** Whether the owing filter is on. */
  readonly owingOnly: boolean;
  /** How many rows came back. */
  readonly shown: number;
  /** The `limit` the request carried, so a full page can be recognised as possibly truncated. */
  readonly limit: number;
  /** Whether a status filter is also on — it changes what "none" means. */
  readonly statusLabelTh: string | null;
}

export interface OwingFilterNotice {
  /** The sentence above the table, or `null` when the filter is off and there is nothing to say. */
  readonly summaryTh: string | null;
  /** What to print instead of a table when nothing came back. */
  readonly emptyTh: string;
}

/**
 * ⚠️ `shown >= limit`, not `=== limit`. A server that returns more than it was asked for is a
 * bug elsewhere, but reading it as "not truncated" would be this function silently asserting
 * something it cannot know. `>=` is the direction that stays truthful either way.
 */
export function describeOwingFilter(input: OwingFilterInput): OwingFilterNotice {
  const { owingOnly, shown, limit, statusLabelTh } = input;

  if (!owingOnly) {
    return {
      summaryTh: null,
      emptyTh:
        statusLabelTh === null
          ? 'ยังไม่มีออเดอร์ในระบบ'
          : `ไม่มีออเดอร์ในสถานะ “${statusLabelTh}”`,
    };
  }

  /*
   * Nothing owing is worth saying plainly rather than as an absence: "no rows" on a filtered
   * list reads as "the filter is broken" at least as often as it reads as "you are paid up".
   */
  if (shown === 0) {
    return {
      summaryTh: null,
      emptyTh:
        statusLabelTh === null
          ? 'ไม่มีออเดอร์ที่ค้างชำระ'
          : `ไม่มีออเดอร์ที่ค้างชำระในสถานะ “${statusLabelTh}”`,
    };
  }

  const scope = statusLabelTh === null ? '' : ` ในสถานะ “${statusLabelTh}”`;
  const more = shown >= limit ? ` — แสดง ${String(limit)} รายการแรก อาจมีมากกว่านี้` : '';

  return {
    summaryTh: `ค้างชำระ ${String(shown)} ออเดอร์${scope} เรียงจากยอดมากไปน้อย${more}`,
    emptyTh: 'ไม่มีออเดอร์ที่ค้างชำระ',
  };
}
