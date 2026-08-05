import { describe, expect, it } from 'vitest';

import { worksOrderLines, type WorksOrderSource } from '../../src/quotes/works-order';

/**
 * ⚠️ Plan 7.9(ค)'s ⚠️, as the test that would go red if anybody ever added the friendly field.
 *
 * > ฝ่ายขายพิมพ์ "กระจกเทมเปอร์ 8 มม." บนบรรทัดที่ sku บอก T6 (6 มม.) ได้ · ใบสั่งผลิตต้อง render
 * > จาก sku + option ที่ resolve จาก catalog document เท่านั้น
 *
 * The schema made half of this structural — `product_version_id` cannot move and `sku_code`
 * cannot move without `selections`. What no constraint can stop is a *renderer* reaching for
 * the friendliest string on the row, and the fixture below is exactly that temptation: a line
 * whose sku says 6 mm and whose customer-facing sentence says 8 mm.
 */

const line: WorksOrderSource = {
  seq: 1,
  skuCode: 'SLD-W-T6-STD',
  selections: { glass: 'T6', frame: 'white', lock: 'standard' },
  measures: { width: '3200000', height: '2100000' },
  qty: 2,
};

describe('a works order renders from the sku and the resolved options', () => {
  it('carries the sku, the option codes and the canonical measurements', () => {
    const [rendered] = worksOrderLines([line]);

    expect(rendered?.skuCode).toBe('SLD-W-T6-STD');
    expect(rendered?.options).toEqual([
      { groupCode: 'frame', valueCode: 'white' },
      { groupCode: 'glass', valueCode: 'T6' },
      { groupCode: 'lock', valueCode: 'standard' },
    ]);
    expect(rendered?.measuresUm).toEqual([
      { code: 'height', um: '2100000' },
      { code: 'width', um: '3200000' },
    ]);
    expect(rendered?.qty).toBe(2);
  });

  /*
   * ⭐ The one that matters. `WorksOrderSource` has no field a description could be assigned
   * to, so the prose is not merely omitted from the output — it is not in scope at the point
   * the output is built. This asserts the consequence: the factory is never told 8 mm about a
   * 6 mm window, whatever sales wrote to the customer.
   */
  it('never contains sales prose, because the prose was never in scope', () => {
    const rendered = JSON.stringify(worksOrderLines([line]));

    expect(rendered).toContain('T6');
    expect(rendered).not.toContain('8 มม.');
    expect(rendered).not.toContain('เทมเปอร์');
    expect(Object.keys(worksOrderLines([line])[0] ?? {})).toEqual([
      'seq',
      'skuCode',
      'options',
      'measuresUm',
      'qty',
    ]);
  });

  it('is deterministic, so two sheets for one configuration are one sheet', () => {
    const shuffled: WorksOrderSource = {
      ...line,
      selections: { lock: 'standard', glass: 'T6', frame: 'white' },
      measures: { height: '2100000', width: '3200000' },
    };

    expect(worksOrderLines([shuffled])).toEqual(worksOrderLines([line]));
  });

  it('orders by seq, not by the order rows happened to arrive in', () => {
    const second: WorksOrderSource = { ...line, seq: 2, skuCode: 'CSM-W-T5-STD' };
    expect(worksOrderLines([second, line]).map((row) => row.seq)).toEqual([1, 2]);
  });
});
