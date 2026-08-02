/**
 * Mock catalog. This file is the single source of truth for the whole app —
 * adding a product must never require touching anything else (spec section 11).
 */

import type { OptionValue, Product, SkuGroup } from '../types/catalog';
import { and, area, div, gt, lt, measure, selected } from './ruleBuilders';

/* ------------------------------------------------------------------ *
 * Shared option values
 *
 * These are factories rather than shared consts: two products holding the same
 * OptionValue object would share mutations (e.g. flipping `available` when a
 * colour goes out of stock), which is never what you want across SKUs.
 * ------------------------------------------------------------------ */

type ProfileCode = 'DW' | 'LW' | 'SG' | 'BK' | 'WH';

const PROFILE_COLORS: Record<ProfileCode, OptionValue> = {
  DW: { code: 'DW', labelTh: 'ลายไม้เข้ม', swatchHex: '#7A4A3A', delta: { type: 'percent', amount: 8 }, available: true },
  LW: { code: 'LW', labelTh: 'ลายไม้อ่อน', swatchHex: '#D9C39A', delta: { type: 'percent', amount: 8 }, available: true },
  SG: { code: 'SG', labelTh: 'เทาซาฮาร่า', swatchHex: '#7C7F85', delta: { type: 'none' }, available: true },
  BK: { code: 'BK', labelTh: 'ดำ', swatchHex: '#2A2A2C', delta: { type: 'percent', amount: 5 }, available: true },
  WH: { code: 'WH', labelTh: 'อบขาว', swatchHex: '#F2F2EE', delta: { type: 'none' }, available: true },
};

type GlassColorCode = 'CLR' | 'GRN' | 'BLU' | 'BRZ' | 'FRS' | 'RFL';

const GLASS_COLORS: Record<GlassColorCode, OptionValue> = {
  CLR: { code: 'CLR', labelTh: 'โปร่งใส', swatchHex: '#C9E4F7', delta: { type: 'none' }, available: true },
  GRN: { code: 'GRN', labelTh: 'สีเขียว', swatchHex: '#A9C6A2', delta: { type: 'per_sqm', amount: 180 }, available: true },
  BLU: { code: 'BLU', labelTh: 'สีฟ้า', swatchHex: '#5B95C7', delta: { type: 'per_sqm', amount: 220 }, available: true },
  BRZ: { code: 'BRZ', labelTh: 'สีชาดำ', swatchHex: '#6A6A6A', delta: { type: 'per_sqm', amount: 200 }, available: true },
  FRS: { code: 'FRS', labelTh: 'ฝ้า', swatchHex: '#EFEFEF', delta: { type: 'per_sqm', amount: 150 }, available: true },
  RFL: { code: 'RFL', labelTh: 'เงา', swatchHex: '#E2E8EE', delta: { type: 'per_sqm', amount: 260 }, available: true },
};

type ThicknessCode = 'T5' | 'T6' | 'T8' | 'LAM';

const GLASS_THICKNESS: Record<ThicknessCode, OptionValue> = {
  T5: { code: 'T5', labelTh: '5 mm (เทมเปอร์)', delta: { type: 'per_sqm', amount: 0 }, available: true },
  T6: { code: 'T6', labelTh: '6 mm (เทมเปอร์)', delta: { type: 'per_sqm', amount: 120 }, available: true },
  T8: { code: 'T8', labelTh: '8 mm (เทมเปอร์)', delta: { type: 'per_sqm', amount: 300 }, available: true },
  LAM: { code: 'LAM', labelTh: 'กระจกสองชั้น', delta: { type: 'per_sqm', amount: 650 }, available: true },
};

const pick = <K extends string>(source: Record<K, OptionValue>, codes: readonly K[]): OptionValue[] =>
  codes.map((code) => ({ ...source[code] }));

const profileColorGroup = (codes: readonly ProfileCode[]): SkuGroup => ({
  kind: 'sku',
  code: 'profile_color',
  labelTh: 'สีโปรไฟล์อะลูมิเนียม',
  input: 'swatch',
  required: true,
  includeInSkuCode: true,
  values: pick(PROFILE_COLORS, codes),
  // Sahara grey is the no-surcharge finish. Defaulting to a colour that adds 8%
  // would inflate the first price every customer sees before they choose anything.
  defaultValue: codes.includes('SG') ? 'SG' : (codes[0] ?? 'SG'),
});

const glassColorGroup = (codes: readonly GlassColorCode[]): SkuGroup => ({
  kind: 'sku',
  code: 'glass_color',
  labelTh: 'สีกระจก',
  input: 'swatch',
  required: true,
  includeInSkuCode: true,
  values: pick(GLASS_COLORS, codes),
  defaultValue: codes[0] ?? 'CLR',
});

const glassThicknessGroup = (codes: readonly ThicknessCode[]): SkuGroup => ({
  kind: 'sku',
  code: 'glass_thickness',
  labelTh: 'ความหนากระจก',
  input: 'chip',
  required: true,
  includeInSkuCode: true,
  values: pick(GLASS_THICKNESS, codes),
  defaultValue: codes[0] ?? 'T6',
});

/* ------------------------------------------------------------------ *
 * Products
 * ------------------------------------------------------------------ */

const awn4t: Product = {
  id: 'awn-4t',
  slug: 'awn-4t',
  nameTh: 'หน้าต่างบานกระทุ้ง 4 ช่องแสงบน',
  categoryId: 'windows',
  summaryTh:
    'บานกระทุ้งเปิดออกด้านนอก ระบายอากาศได้แม้ฝนตก พร้อมช่องแสงบน 4 ช่อง เหมาะกับห้องนอนและห้องน้ำ',
  heroImage: '/products/awn-4t.svg',
  leadTimeDays: [10, 14],
  pricePerSqm: 1500,
  minBillableSqm: 1.5,
  skuPrefix: 'AWN4T',
  groups: [
    profileColorGroup(['DW', 'LW', 'SG', 'BK', 'WH']),
    glassColorGroup(['CLR', 'GRN', 'BLU', 'BRZ', 'FRS', 'RFL']),
    glassThicknessGroup(['T5', 'T6', 'T8', 'LAM']),
    {
      kind: 'sku',
      code: 'insect_screen',
      labelTh: 'มุ้งลวด',
      input: 'toggle',
      required: true,
      includeInSkuCode: true,
      values: [
        { code: 'NS0', labelTh: 'ไม่มีมุ้งลวด', delta: { type: 'none' }, available: true },
        { code: 'NS1', labelTh: 'มีมุ้งลวด', delta: { type: 'flat', amount: 1800 }, available: true },
      ],
      defaultValue: 'NS0',
    },
    {
      kind: 'custom',
      code: 'width',
      labelTh: 'ความกว้าง',
      input: 'number',
      unit: 'cm',
      min: 60,
      max: 400,
      step: 0.5,
      defaultValue: 320,
      helperTh: 'วัดจากขอบวงกบด้านนอกถึงขอบวงกบอีกด้าน',
    },
    {
      kind: 'custom',
      code: 'height',
      labelTh: 'ความสูง',
      input: 'number',
      unit: 'cm',
      min: 60,
      max: 250,
      step: 0.5,
      defaultValue: 160,
    },
  ],
  rules: [
    {
      id: 'awn4t-max-area',
      severity: 'error',
      messageTh: 'พื้นที่รวมต้องไม่เกิน 8.00 ตร.ม. ลองลดความกว้างหรือความสูง',
      when: gt(area(), 8),
    },
    {
      id: 'awn4t-ratio',
      severity: 'error',
      messageTh: 'อัตราส่วนกว้างต่อสูงต้องไม่เกิน 3:1',
      when: gt(div(measure('width'), measure('height')), 3),
    },
    {
      id: 'awn4t-lam-width',
      severity: 'error',
      messageTh: 'กระจกสองชั้นรองรับความกว้างไม่เกิน 200 cm',
      when: and(selected('glass_thickness', 'LAM'), gt(measure('width'), 200)),
    },
  ],
};

const lvrAdj3: Product = {
  id: 'lvr-adj-3',
  slug: 'lvr-adj-3',
  nameTh: 'ระแนงปรับได้ แบ่ง 3',
  categoryId: 'louvers',
  summaryTh:
    'ระแนงอะลูมิเนียมปรับองศาใบได้ แบ่งชุดควบคุม 3 ช่วง คุมแสงและลมได้อิสระในแต่ละช่วง',
  heroImage: '/products/lvr-adj-3.svg',
  leadTimeDays: [14, 21],
  pricePerSqm: 2400,
  minBillableSqm: 1.0,
  skuPrefix: 'LVR3',
  groups: [
    profileColorGroup(['DW', 'LW', 'SG']),
    {
      kind: 'sku',
      code: 'blade_width',
      labelTh: 'ความกว้างใบระแนง',
      input: 'chip',
      required: true,
      includeInSkuCode: true,
      values: [
        { code: 'B100', labelTh: 'ใบ 100 mm', delta: { type: 'per_sqm', amount: 180 }, available: true },
        { code: 'B150', labelTh: 'ใบ 150 mm', delta: { type: 'per_sqm', amount: 0 }, available: true },
        { code: 'B200', labelTh: 'ใบ 200 mm', delta: { type: 'per_sqm', amount: 90 }, available: true },
      ],
      defaultValue: 'B150',
    },
    {
      kind: 'sku',
      code: 'control',
      labelTh: 'ระบบควบคุม',
      input: 'chip',
      required: true,
      includeInSkuCode: true,
      values: [
        { code: 'MAN', labelTh: 'ปรับด้วยมือ', delta: { type: 'none' }, available: true },
        { code: 'MOT', labelTh: 'มอเตอร์ไฟฟ้า', delta: { type: 'flat', amount: 12000 }, available: true },
      ],
      defaultValue: 'MAN',
    },
    {
      kind: 'custom',
      code: 'width',
      labelTh: 'ความกว้าง',
      input: 'number',
      unit: 'cm',
      min: 60,
      max: 600,
      step: 0.5,
      defaultValue: 300,
    },
    {
      kind: 'custom',
      code: 'height',
      labelTh: 'ความสูง',
      input: 'number',
      unit: 'cm',
      min: 60,
      max: 400,
      step: 0.5,
      defaultValue: 200,
    },
  ],
  rules: [
    {
      id: 'lvr3-motor-min',
      severity: 'error',
      messageTh: 'มอเตอร์ไฟฟ้าต้องใช้กับความกว้างตั้งแต่ 150 cm ขึ้นไป',
      when: and(selected('control', 'MOT'), lt(measure('width'), 150)),
    },
  ],
};

const sld2p: Product = {
  id: 'sld-2p',
  slug: 'sld-2p',
  nameTh: 'ประตูบานเลื่อน 2 บาน',
  categoryId: 'doors',
  summaryTh:
    'บานเลื่อนสองบานบนรางคู่ เปิดได้ครึ่งช่อง เหมาะกับทางออกระเบียงและห้องนั่งเล่น',
  heroImage: '/products/sld-2p.svg',
  leadTimeDays: [14, 20],
  pricePerSqm: 2100,
  minBillableSqm: 2.0,
  skuPrefix: 'SLD2',
  groups: [
    profileColorGroup(['DW', 'LW', 'SG', 'BK', 'WH']),
    glassColorGroup(['CLR', 'GRN', 'BLU', 'BRZ', 'FRS', 'RFL']),
    glassThicknessGroup(['T6', 'T8', 'LAM']),
    {
      kind: 'sku',
      code: 'lock_type',
      labelTh: 'ระบบล็อก',
      input: 'chip',
      required: true,
      includeInSkuCode: true,
      values: [
        { code: 'LK1', labelTh: 'กลอนมาตรฐาน', delta: { type: 'none' }, available: true },
        { code: 'LK2', labelTh: 'ล็อกหลายจุด', delta: { type: 'flat', amount: 3500 }, available: true },
      ],
      defaultValue: 'LK1',
    },
    {
      kind: 'custom',
      code: 'width',
      labelTh: 'ความกว้าง',
      input: 'number',
      unit: 'cm',
      min: 120,
      max: 500,
      step: 0.5,
      defaultValue: 180,
    },
    {
      kind: 'custom',
      code: 'height',
      labelTh: 'ความสูง',
      input: 'number',
      unit: 'cm',
      min: 180,
      max: 280,
      step: 0.5,
      defaultValue: 220,
    },
  ],
  rules: [
    {
      id: 'sld2-lam-height',
      severity: 'warning',
      messageTh: 'กระจกสองชั้นที่ความสูงเกิน 250 cm อาจต้องเสริมเสา ทีมงานจะยืนยันอีกครั้ง',
      when: and(selected('glass_thickness', 'LAM'), gt(measure('height'), 250)),
    },
  ],
};

export const products: Product[] = [awn4t, lvrAdj3, sld2p];

export const getProductBySlug = (slug: string): Product | undefined =>
  products.find((product) => product.slug === slug);

export const getProductById = (id: string): Product | undefined =>
  products.find((product) => product.id === id);
