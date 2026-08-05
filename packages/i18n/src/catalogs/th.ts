import type { SourceCatalog } from '../catalog.js';

/**
 * ไทย — the source language, and the only complete catalogue in this package.
 *
 * Every sentence below is the one the previous version of the code built by hand inside
 * `validation.ts`, `optionStates.ts` and `pricing.ts`, moved here without a character
 * changing. `tests/parity.test.ts` renders real messages through this catalogue and
 * compares them to the exact strings `@wewin/core`'s phase-6a gate pins, so a well-meant
 * edit to the Thai here fails a test in another package rather than quietly changing
 * what 100% of today's customers read.
 *
 * Two of these sentences say more than their predecessors did, and both differences came
 * from turning a welded string into params:
 *
 *   `option.unavailable` used to be the constant `ตอนนี้สีนี้ยังไม่พร้อมผลิต` — "this
 *     *colour* is not available" — returned for every group, including the mosquito
 *     screen and the lock. It now names its own group, because the group is a param.
 *   `price.line.base` used to be `ราคาฐานตามพื้นที่`, which named no area at all, so a
 *     base charge computed on the product's minimum billable floor rather than on the
 *     size the customer chose had nowhere to say so. It now carries the area it charged.
 *
 * `ตร.ม.` lives in the template rather than in `formatArea`, so a translator can replace
 * it with `m²` or move it in front of the number. The metric unit symbols inside a
 * length (`cm`, `mm`) cannot be moved that way — they come from `@wewin/core/format`
 * with the value. See the note in `coverage.ts`; it is a real gap, and it is listed.
 */
export const th: SourceCatalog = {
  locale: 'th',
  status: 'source',
  messages: {
    'issue.selection.unknown':
      '{group}ที่เลือกไว้ไม่มีอยู่ในรายการของสินค้านี้ — กรุณาเลือกใหม่',
    'issue.range.outOfRange': '{group}ต้องอยู่ระหว่าง {range}',
    'issue.step.willSnapUp': '{group}ปรับได้ทีละ {step} ระบบจะปัดเป็น {snapped}',
    'issue.step.aboveLargestMark': '{group}ปรับได้ทีละ {step} ค่าสูงสุดที่ปรับได้คือ {largest}',
    'issue.step.noMarkInRange': '{group}ปรับได้ทีละ {step} และไม่มีค่าที่ลงตัวในช่วง {range}',
    'issue.rule': '{message}',
    'option.unavailable': 'ตอนนี้{group} "{option}" ยังไม่พร้อมผลิต',
    'price.line.base': 'ราคาฐานตามพื้นที่ {billableArea} ตร.ม.',
    'price.line.option': '{group} · {option}',
  },
};

/**
 * What a customer sees when even the Thai template cannot be rendered.
 *
 * This is the floor under the fallback chain and it should be unreachable: `th` is typed
 * total, so a missing Thai template is a compile error, and a malformed one is caught by
 * `validateCatalog` in CI. It exists for the case the type system cannot see — a
 * catalogue reconstructed from JSON, a bundle that shipped half-built.
 *
 * It is a sentence rather than the key. `issue.range.outOfRange` on a customer's screen
 * is not a smaller failure than a blank line; it is the same failure plus a leaked
 * implementation detail. The key goes to `onIssue`, where an engineer will see it.
 */
export const UNAVAILABLE_TEXT = 'ไม่สามารถแสดงรายละเอียดได้';
