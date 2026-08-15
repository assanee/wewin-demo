import { describe, expect, it } from 'vitest';
import type { ProductWire } from '@wewin/contract/catalog';

import { createRequestFrom, identityProblems, inheritanceSummaryTh } from './new-product';

/**
 * A source product shaped like the ones in the catalogue: one measured group, one swatch
 * group, in that order, and one rule. The order is the point of half these tests.
 */
const SOURCE: ProductWire = {
  id: 'lvr-hang-single',
  slug: 'lvr-hang-single',
  nameTh: 'บานแขวน เดี่ยว - ระแนงปรับได้',
  categoryId: 'louvre',
  summaryTh: 'บานแขวนระแนงปรับได้ เหมาะกับระเบียง',
  skuPrefix: 'LVH1',
  heroImage: 'media/lvr-hang-single.jpg',
  leadTimeDays: [14, 21],
  pricePerSqm: { currency: 'THB', minor: '150000' },
  minBillableSqUm: { unit: 'squm', value: '1000000000000' },
  elevation: { panels: 1, operation: 'hang', infill: 'louvre' },
  groups: [
    {
      kind: 'custom',
      code: 'width',
      labelTh: 'ความกว้าง',
      input: 'number',
      unit: 'cm',
      minUm: { unit: 'um', value: '600000' },
      maxUm: { unit: 'um', value: '3000000' },
      stepUm: { unit: 'um', value: '5000' },
      defaultUm: { unit: 'um', value: '1500000' },
    },
    {
      kind: 'sku',
      code: 'profile_color',
      labelTh: 'สีโปรไฟล์',
      input: 'swatch',
      required: true,
      includeInSkuCode: true,
      values: [
        { code: 'SG', labelTh: 'เทาเงิน', delta: { kind: 'none' }, available: true },
        { code: 'BK', labelTh: 'ดำ', delta: { kind: 'none' }, available: true },
      ],
      defaultValue: 'SG',
    },
  ],
  rules: [
    {
      id: 'width_needs_two_panels',
      messageTh: 'กว้างเกิน 2 เมตรต้องแบ่งอย่างน้อย 2 บาน',
      severity: 'error',
      when: { op: 'gt', left: { group: 'width' }, right: { um: '2000000' } },
      referencedGroupCodes: ['width'],
    },
  ],
} as unknown as ProductWire;

const IDENTITY = {
  id: 'lvr-hang-double',
  slug: 'lvr-hang-double',
  skuPrefix: 'LVH2',
  nameTh: 'บานแขวน คู่ - ระแนงปรับได้',
};

describe('turning a source product into a create request', () => {
  it('⭐ carries the group order across, because a record has none', () => {
    /*
     * `ProductWire.groups` is an ordered array; `options` is keyed by group code. Drop the
     * index and the new product still has both groups and still validates — it just asks for
     * the colour before the width, which nobody notices until a customer is halfway through
     * a configurator that reads in a different order from every other product.
     */
    const request = createRequestFrom(SOURCE, IDENTITY);

    expect(request.options['width']?.sortOrder).toBe(0);
    expect(request.options['profile_color']?.sortOrder).toBe(1);
  });

  it('copies a swatch group with every value and its default', () => {
    const option = createRequestFrom(SOURCE, IDENTITY).options['profile_color'];

    expect(option).toStrictEqual({
      kind: 'sku',
      sortOrder: 1,
      valueCodes: ['SG', 'BK'],
      defaultValueCode: 'SG',
    });
  });

  it('copies a measured group with all four bounds', () => {
    /*
     * ⚠️ All four, and `stepUm` is the one worth naming: it is what makes the configurator's
     * spinner move by 0.5 cm. Lose it and the field still works, in millimetre steps, which
     * is a product nobody can manufacture.
     */
    const option = createRequestFrom(SOURCE, IDENTITY).options['width'];

    expect(option).toStrictEqual({
      kind: 'custom',
      sortOrder: 0,
      minUm: { unit: 'um', value: '600000' },
      maxUm: { unit: 'um', value: '3000000' },
      stepUm: { unit: 'um', value: '5000' },
      defaultUm: { unit: 'um', value: '1500000' },
    });
  });

  it('takes the identity from the person and everything else from the source', () => {
    const request = createRequestFrom(SOURCE, IDENTITY);

    expect(request.id).toBe('lvr-hang-double');
    expect(request.slug).toBe('lvr-hang-double');
    expect(request.skuPrefix).toBe('LVH2');
    expect(request.fields.nameTh).toBe('บานแขวน คู่ - ระแนงปรับได้');

    /* Inherited, and none of it is on the form. */
    expect(request.fields.categoryId).toBe('louvre');
    expect(request.fields.elevation).toStrictEqual(SOURCE.elevation);
    expect(request.fields.pricePerSqm).toStrictEqual(SOURCE.pricePerSqm);
    expect(request.fields.leadTimeDays).toStrictEqual([14, 21]);
  });

  it('trims what was typed, because a trailing space in a slug is a different URL', () => {
    const request = createRequestFrom(SOURCE, {
      id: '  lvr-hang-double  ',
      slug: ' lvr-hang-double ',
      skuPrefix: ' LVH2 ',
      nameTh: '  บานแขวน คู่  ',
    });

    expect(request.id).toBe('lvr-hang-double');
    expect(request.slug).toBe('lvr-hang-double');
    expect(request.skuPrefix).toBe('LVH2');
    expect(request.fields.nameTh).toBe('บานแขวน คู่');
  });

  it('carries the rules, keyed by code and in order', () => {
    const request = createRequestFrom(SOURCE, IDENTITY);

    expect(request.rules?.['width_needs_two_panels']).toStrictEqual({
      severity: 'error',
      messageTh: 'กว้างเกิน 2 เมตรต้องแบ่งอย่างน้อย 2 บาน',
      when: SOURCE.rules[0]?.when,
      sortOrder: 0,
    });
  });

  it('⚠️ omits `rules` entirely when the source has none, rather than sending an empty record', () => {
    /* Absent and empty are different on the wire. Most products have no rules at all. */
    const request = createRequestFrom({ ...SOURCE, rules: [] }, IDENTITY);

    expect('rules' in request).toBe(false);
  });
});

describe('what the form refuses before the server sees it', () => {
  const EXISTING = [
    { id: 'lvr-hang-single', slug: 'lvr-hang-single', skuPrefix: 'LVH1' },
    { id: 'hang-single', slug: 'hang-single', skuPrefix: 'HNG1' },
  ];

  it('accepts an identity that collides with nothing', () => {
    expect(identityProblems(IDENTITY, EXISTING)).toStrictEqual([]);
  });

  it('⭐ reports every problem at once, not the first one', () => {
    /*
     * A form that reveals one problem per attempt is a form somebody fills in four times.
     * This is the assertion that fails if a `return` sneaks into the middle of the function.
     */
    const problems = identityProblems(
      { id: 'Not Kebab', slug: '', skuPrefix: 'lvh2', nameTh: '' },
      EXISTING,
    );

    expect(problems).toHaveLength(4);
    expect(problems[0]).toContain('รหัสสินค้า');
    expect(problems[1]).toContain('สลัก');
    expect(problems[2]).toContain('SKU');
    expect(problems[3]).toContain('ชื่อสินค้า');
  });

  it('catches each of the three identities colliding with a product already loaded', () => {
    expect(identityProblems({ ...IDENTITY, id: 'hang-single' }, EXISTING)[0]).toContain(
      'มีสินค้ารหัส hang-single อยู่แล้ว',
    );
    expect(identityProblems({ ...IDENTITY, slug: 'hang-single' }, EXISTING)[0]).toContain(
      'ใช้สลัก hang-single อยู่แล้ว',
    );
    expect(identityProblems({ ...IDENTITY, skuPrefix: 'HNG1' }, EXISTING)[0]).toContain(
      'รหัส SKU จะชนกัน',
    );
  });

  it('⚠️ says nothing about a lower-case SKU prefix being *nearly* right', () => {
    /*
     * `lvh2` is refused for its shape, not silently upper-cased. Upper-casing it for the
     * person would mean the code they typed and the code they get differ, and SKU prefixes
     * end up printed on a works order.
     */
    const problems = identityProblems({ ...IDENTITY, skuPrefix: 'lvh2' }, EXISTING);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('ตัวพิมพ์ใหญ่');
  });
});

describe('the sentence that says what is being inherited', () => {
  it('names the panel count, the groups and whether rules follow', () => {
    expect(inheritanceSummaryTh(SOURCE)).toBe('1 บาน · 2 ชุดตัวเลือก · 1 กฎ');
  });

  it('says so plainly when there are no rules', () => {
    expect(inheritanceSummaryTh({ ...SOURCE, rules: [] })).toBe('1 บาน · 2 ชุดตัวเลือก · ไม่มีกฎ');
  });
});
