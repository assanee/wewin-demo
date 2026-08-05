/**
 * What the factory is told — plan 7.9(ค)'s ⚠️, as a function rather than as a rule.
 *
 * > ⚠️ **คำอธิบายที่ฝ่ายขายพิมพ์ห้ามขึ้นใบสั่งผลิต** — ฝ่ายขายพิมพ์ "กระจกเทมเปอร์ 8 มม."
 * > บนบรรทัดที่ sku บอก T6 (6 มม.) ได้ · ใบสั่งผลิตต้อง render จาก sku + option ที่ resolve
 * > จาก catalog document เท่านั้น ข้อความฝ่ายขายติดป้าย "สำหรับลูกค้า"
 *
 * The schema made half of this structural: `product_version_id` cannot move, `sku_code`
 * cannot move without `selections`, and `customer_description_th` is the only freely editable
 * field. That closes "sales edits the sku" and leaves open the failure that actually happens,
 * which is a *renderer* reaching for the friendliest string on the row.
 *
 * So the projection exists as a type. `WorksOrderLine` has no field a description could be
 * assigned to, `worksOrderLines` is the only way to build one, and its input type is
 * deliberately narrow: it takes the four fields a works order may read and it is not given
 * the prose at all, so a future edit cannot include it by forgetting to exclude it. A test
 * builds a line whose sku says T6 and whose description says 8 มม. and asserts the string
 * `8` never appears in the rendered output.
 *
 * ── Free-form lines are absent, and that is the answer, not an omission ──────────
 *
 * A free-form line is delivery, installation, a survey or a credit. It has no sku, no
 * selections and no measurements — there is nothing to cut from it, and a factory sheet with
 * a row reading "ค่าติดตั้ง ฿2,000" is a sheet somebody has to decide how to ignore. The
 * filter is here rather than at every call site for the same reason the type is narrow.
 */

/** Exactly the fields a production sheet may be built from, and no others. */
export interface WorksOrderSource {
  readonly seq: number;
  readonly skuCode: string;
  /** `{ groupCode: valueCode }` — codes, never Thai labels (plan 7.9(ง)(1)). */
  readonly selections: Readonly<Record<string, string>>;
  /** Canonical micrometres as decimal strings, keyed by custom group code (plan 4.1). */
  readonly measures: Readonly<Record<string, string>>;
  readonly qty: number;
}

export interface WorksOrderLine {
  readonly seq: number;
  readonly skuCode: string;
  /** Sorted by code, so two sheets for the same configuration are the same sheet. */
  readonly options: readonly { readonly groupCode: string; readonly valueCode: string }[];
  readonly measuresUm: readonly { readonly code: string; readonly um: string }[];
  readonly qty: number;
}

/**
 * The projection. Total, pure, and the only constructor of a `WorksOrderLine`.
 *
 * Takes `WorksOrderSource` and not a quote line, so the prose is not in scope: a quote line
 * carrying `customerDescriptionTh` cannot be passed here without the caller dropping it
 * first, and dropping it is what the type is for.
 */
export function worksOrderLines(sources: readonly WorksOrderSource[]): readonly WorksOrderLine[] {
  return [...sources]
    .sort((left, right) => left.seq - right.seq)
    .map((source) => ({
      seq: source.seq,
      skuCode: source.skuCode,
      options: Object.entries(source.selections)
        .map(([groupCode, valueCode]) => ({ groupCode, valueCode }))
        .sort((left, right) => left.groupCode.localeCompare(right.groupCode)),
      measuresUm: Object.entries(source.measures)
        .map(([code, um]) => ({ code, um }))
        .sort((left, right) => left.code.localeCompare(right.code)),
      qty: source.qty,
    }));
}
