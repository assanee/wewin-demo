/**
 * Mock catalog — the single source of truth for the whole app.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ PLACEHOLDER ECONOMICS                                                   │
 * │                                                                         │
 * │ The category and product names come from the real range. The numbers    │
 * │ do NOT: `pricePerSqm` is an invented placeholder for every product       │
 * │ except awn-4t (1500), lvr-adj-3 (2400) and sld-2p (2100), which carry   │
 * │ the figures fixed by the spec's pricing test cases.                     │
 * │                                                                         │
 * │ Lead times, minimum billable areas, size ranges and option surcharges   │
 * │ are placeholders too. Replace PRICE_PER_SQM below with a real price     │
 * │ list — it is a single column, and nothing else needs to change.         │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * 81 products across 10 categories are built from one table rather than written
 * out by hand. Hand-writing them would be ~2,500 lines in which a single wrong
 * `min` would be invisible; here every product's shape comes from its kit, and a
 * new product is one row.
 */

import type { CustomGroup, OptionGroup, OptionValue, Product, Rule, SkuGroup } from '../types/catalog.js';
import type { PanelInfill, PanelOperation } from '../elevation.js';
import { and, area, areaSqm, gt, lengthCm, lt, measure, mul, scalar, selected } from './ruleBuilders.js';
import { sqmToSqUm, toMicrons } from '../units.js';

/* ------------------------------------------------------------------ *
 * Shared option values
 *
 * Factories, not shared consts: two products holding the same OptionValue object
 * would share mutations (flipping `available` when a colour goes out of stock),
 * which is never right across SKUs.
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

/* ------------------------------------------------------------------ *
 * Group factories
 * ------------------------------------------------------------------ */

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

const bladeWidthGroup = (): SkuGroup => ({
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
});

const controlGroup = (): SkuGroup => ({
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
});

const lockTypeGroup = (): SkuGroup => ({
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
});

const insectScreenGroup = (): SkuGroup => ({
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
});

const meshGradeGroup = (): SkuGroup => ({
  kind: 'sku',
  code: 'mesh_grade',
  labelTh: 'เกรดตาข่าย',
  input: 'chip',
  required: true,
  includeInSkuCode: true,
  values: [
    { code: 'MG1', labelTh: 'ตาข่ายมาตรฐาน', delta: { type: 'none' }, available: true },
    { code: 'MG2', labelTh: 'ตาข่ายกันสัตว์เลี้ยง', delta: { type: 'per_sqm', amount: 320 }, available: true },
    { code: 'MG3', labelTh: 'ตาข่ายถี่พิเศษ กันตัวริ้น', delta: { type: 'per_sqm', amount: 180 }, available: true },
  ],
  defaultValue: 'MG1',
});

/* ------------------------------------------------------------------ *
 * Kits — which option groups a family of products offers
 * ------------------------------------------------------------------ */

type Kit = 'louver' | 'louver_door' | 'glass_window' | 'glass_door' | 'glass_fixed' | 'screen';

const ALL_PROFILES = ['DW', 'LW', 'SG', 'BK', 'WH'] as const;
const LOUVER_PROFILES = ['DW', 'LW', 'SG'] as const;
const ALL_GLASS = ['CLR', 'GRN', 'BLU', 'BRZ', 'FRS', 'RFL'] as const;

const KIT_GROUPS: Record<Kit, () => SkuGroup[]> = {
  louver: () => [profileColorGroup(LOUVER_PROFILES), bladeWidthGroup(), controlGroup()],
  louver_door: () => [profileColorGroup(LOUVER_PROFILES), bladeWidthGroup(), controlGroup(), lockTypeGroup()],
  glass_window: () => [
    profileColorGroup(ALL_PROFILES),
    glassColorGroup(ALL_GLASS),
    glassThicknessGroup(['T5', 'T6', 'T8', 'LAM']),
    insectScreenGroup(),
  ],
  // Doors carry more weight per panel, so 5 mm is not offered.
  glass_door: () => [
    profileColorGroup(ALL_PROFILES),
    glassColorGroup(ALL_GLASS),
    glassThicknessGroup(['T6', 'T8', 'LAM']),
    lockTypeGroup(),
  ],
  glass_fixed: () => [
    profileColorGroup(ALL_PROFILES),
    glassColorGroup(ALL_GLASS),
    glassThicknessGroup(['T5', 'T6', 'T8', 'LAM']),
  ],
  screen: () => [profileColorGroup(ALL_PROFILES), meshGradeGroup()],
};

const KIT_LEAD_TIME: Record<Kit, [number, number]> = {
  louver: [14, 21],
  louver_door: [18, 25],
  glass_window: [10, 14],
  glass_door: [14, 20],
  glass_fixed: [7, 12],
  screen: [7, 10],
};

/** What fills a panel, which follows entirely from the kit. */
const KIT_INFILL: Record<Kit, PanelInfill> = {
  louver: 'louvre',
  louver_door: 'louvre',
  glass_window: 'glass',
  glass_door: 'glass',
  glass_fixed: 'glass',
  screen: 'mesh',
};

const KIT_SUMMARY: Record<Kit, string> = {
  louver: 'ใบระแนงอะลูมิเนียมปรับองศาได้ คุมแสงและลมโดยไม่ต้องปิดช่องทั้งหมด',
  louver_door: 'บานเปิดที่ใช้ใบระแนงปรับองศาแทนกระจก ได้ทั้งความเป็นส่วนตัวและการระบายอากาศ',
  glass_window: 'หน้าต่างกระจกพร้อมวงกบอะลูมิเนียม เลือกสีกระจกและความหนาได้',
  glass_door: 'ประตูกระจกบานหนา พร้อมวงกบและระบบล็อกที่เลือกได้',
  glass_fixed: 'ช่องแสงติดตาย รับแสงเต็มที่ กันเสียงและฝุ่นได้ดีที่สุดในกลุ่ม',
  screen: 'มุ้งกันแมลงกรอบอะลูมิเนียม ติดคู่กับบานเดิมหรือติดแยกก็ได้',
};

/* ------------------------------------------------------------------ *
 * Size profiles
 *
 * Multi-panel products get the wider ranges: a six-panel folding door cannot be
 * built at 120 cm, and a single casement window cannot be built at 800 cm.
 * ------------------------------------------------------------------ */

type SizeKey = 'window' | 'window_wide' | 'door' | 'door_wide' | 'louver' | 'fixed' | 'vertical' | 'screen';

interface SizeProfile {
  width: [min: number, max: number, def: number];
  height: [min: number, max: number, def: number];
  minBillableSqm: number;
}

/**
 * The table stays in the numbers a person can check against a price list; `cm` here
 * and `sqmToSqUm` at the call site turn them into canonical units on the way out.
 *
 * Writing `600_000n` here instead would make 48 bounds unreadable and unreviewable,
 * and a single wrong zero would be a window six metres out with nothing to compare
 * it against. The catalogue schema re-checks every converted bound against the grid
 * invariants, so the conversion is verified by machine rather than by eye.
 */
const cm = (value: number): bigint => toMicrons(value, 'cm');

const STEP_UM = cm(0.5);

const SIZES: Record<SizeKey, SizeProfile> = {
  window: { width: [60, 400, 320], height: [60, 250, 160], minBillableSqm: 1.5 },
  window_wide: { width: [90, 600, 360], height: [60, 250, 180], minBillableSqm: 2.0 },
  door: { width: [120, 500, 180], height: [180, 280, 220], minBillableSqm: 2.0 },
  door_wide: { width: [180, 800, 360], height: [180, 300, 240], minBillableSqm: 3.0 },
  louver: { width: [60, 600, 300], height: [60, 400, 200], minBillableSqm: 1.0 },
  fixed: { width: [40, 400, 200], height: [40, 300, 150], minBillableSqm: 0.8 },
  vertical: { width: [60, 200, 120], height: [100, 300, 200], minBillableSqm: 1.2 },
  screen: { width: [40, 200, 100], height: [40, 260, 200], minBillableSqm: 1.0 },
};

const measureGroups = (size: SizeKey): CustomGroup[] => {
  const profile = SIZES[size];
  const [wMin, wMax, wDef] = profile.width;
  const [hMin, hMax, hDef] = profile.height;

  return [
    {
      kind: 'custom',
      code: 'width',
      labelTh: 'ความกว้าง',
      input: 'number',
      unit: 'cm',
      minUm: cm(wMin),
      maxUm: cm(wMax),
      stepUm: STEP_UM,
      defaultUm: cm(wDef),
      helperTh: 'วัดจากขอบวงกบด้านนอกถึงขอบวงกบอีกด้าน',
    },
    {
      kind: 'custom',
      code: 'height',
      labelTh: 'ความสูง',
      input: 'number',
      unit: 'cm',
      minUm: cm(hMin),
      maxUm: cm(hMax),
      stepUm: STEP_UM,
      defaultUm: cm(hDef),
    },
  ];
};

/* ------------------------------------------------------------------ *
 * The catalog table
 * ------------------------------------------------------------------ */

interface Row {
  slug: string;
  nameTh: string;
  categoryId: string;
  kit: Kit;
  prefix: string;
  size: SizeKey;
  /** PLACEHOLDER except for the three products fixed by the spec's test cases. */
  pricePerSqm: number;
  /** Prefix for generated rule ids; also lets a row keep spec-mandated ids. */
  ruleIdBase: string;
  /** Rules beyond the automatic ones. */
  extraRules?: Rule[];
  summaryTh?: string;

  /* --- Elevation drawing -------------------------------------------------
     The panel count and opening symbol are data because the drawing has to
     match the product name: "บานเฟี้ยม แบ่ง 12" that renders four panels is a
     more obvious lie than a wrong price. One renderer reads these for all 81. */

  /** Panels across the elevation. Defaults to 1. */
  panels?: number;
  /** Opening symbol drawn over each panel. Defaults to 'fixed'. */
  op?: PanelOperation;
  /** Relative widths, e.g. [2, 1] for the unequal leaves of a คู่แม่ลูก door. */
  panelWidths?: number[];
  /** Which leaves slide, when only some of them do. */
  movingPanels?: number[];
}

const AWN4T_RULES: Rule[] = [
  {
    id: 'awn4t-max-area',
    severity: 'error',
    messageTh: 'พื้นที่รวมต้องไม่เกิน 8.00 ตร.ม. ลองลดความกว้างหรือความสูง',
    when: gt(area(), areaSqm(8)),
  },
  {
    id: 'awn4t-ratio',
    severity: 'error',
    messageTh: 'อัตราส่วนกว้างต่อสูงต้องไม่เกิน 3:1',
    // w/h > 3 as w > 3h. Same predicate, no division, so a ratio of 3.4 still fires.
    when: gt(measure('width'), mul(scalar(3), measure('height'))),
  },
];

const LVR3_RULES: Rule[] = [
  {
    id: 'lvr3-motor-min',
    severity: 'error',
    messageTh: 'มอเตอร์ไฟฟ้าต้องใช้กับความกว้างตั้งแต่ 150 cm ขึ้นไป',
    when: and(selected('control', 'MOT'), lt(measure('width'), lengthCm(150))),
  },
];

const SLD2_RULES: Rule[] = [
  {
    id: 'sld2-lam-height',
    severity: 'warning',
    messageTh: 'กระจกสองชั้นที่ความสูงเกิน 250 cm อาจต้องเสริมเสา ทีมงานจะยืนยันอีกครั้ง',
    when: and(selected('glass_thickness', 'LAM'), gt(measure('height'), lengthCm(250))),
  },
];

const ROWS: Row[] = [
  /* --- 1. ระแนงและป้องกันแสงแดด --------------------------------- */
  { slug: 'lvr-adj', nameTh: 'ระแนงปรับได้', categoryId: 'louvers', kit: 'louver', prefix: 'LVR1', size: 'louver', pricePerSqm: 2200, ruleIdBase: 'lvr1', panels: 1, op: 'fixed' },
  { slug: 'lvr-adj-2', nameTh: 'ระแนงปรับได้ แบ่ง 2', categoryId: 'louvers', kit: 'louver', prefix: 'LVR2', size: 'louver', pricePerSqm: 2300, ruleIdBase: 'lvr2', panels: 2, op: 'fixed' },
  {
    slug: 'lvr-adj-3',
    nameTh: 'ระแนงปรับได้ แบ่ง 3',
    categoryId: 'louvers',
    kit: 'louver',
    prefix: 'LVR3',
    size: 'louver',
    pricePerSqm: 2400,
    ruleIdBase: 'lvr3',
    panels: 3,
    op: 'fixed',
    extraRules: LVR3_RULES,
    summaryTh: 'ระแนงอะลูมิเนียมปรับองศาใบได้ แบ่งชุดควบคุม 3 ช่วง คุมแสงและลมได้อิสระในแต่ละช่วง',
  },
  { slug: 'lvr-slide-swap', nameTh: 'บานเลื่อนสลับ - ระแนงปรับได้', categoryId: 'louvers', kit: 'louver', prefix: 'LVSW', size: 'window_wide', pricePerSqm: 3400, ruleIdBase: 'lvsw', panels: 2, op: 'slide' },
  { slug: 'lvr-slide-4free', nameTh: 'บานเลื่อน แบ่ง 4 อิสระ - ระแนงปรับได้', categoryId: 'louvers', kit: 'louver', prefix: 'LVS4F', size: 'window_wide', pricePerSqm: 3900, ruleIdBase: 'lvs4f', panels: 4, op: 'slide' },
  { slug: 'lvr-slide-single', nameTh: 'บานเลื่อน เดี่ยว - ระแนงปรับได้', categoryId: 'louvers', kit: 'louver', prefix: 'LVS1', size: 'window', pricePerSqm: 3100, ruleIdBase: 'lvs1', panels: 2, op: 'slide', movingPanels: [1] },
  { slug: 'lvr-slide-3', nameTh: 'บานเลื่อน แบ่ง 3 - ระแนงปรับได้', categoryId: 'louvers', kit: 'louver', prefix: 'LVS3', size: 'window_wide', pricePerSqm: 3700, ruleIdBase: 'lvs3', panels: 3, op: 'slide' },
  { slug: 'lvr-slide-4c', nameTh: 'บานเลื่อน แบ่ง 4 เปิดกลาง - ระแนงปรับได้', categoryId: 'louvers', kit: 'louver', prefix: 'LVS4C', size: 'window_wide', pricePerSqm: 3800, ruleIdBase: 'lvs4c', panels: 4, op: 'slide' },
  { slug: 'lvr-hang-swap', nameTh: 'บานแขวนสลับ - ระแนงปรับได้', categoryId: 'louvers', kit: 'louver', prefix: 'LVHW', size: 'window_wide', pricePerSqm: 3500, ruleIdBase: 'lvhw', panels: 2, op: 'hang' },
  { slug: 'lvr-hang-4free', nameTh: 'บานแขวน แบ่ง 4 อิสระ - ระแนงปรับได้', categoryId: 'louvers', kit: 'louver', prefix: 'LVH4F', size: 'window_wide', pricePerSqm: 4000, ruleIdBase: 'lvh4f', panels: 4, op: 'hang' },
  { slug: 'lvr-hang-single', nameTh: 'บานแขวน เดี่ยว - ระแนงปรับได้', categoryId: 'louvers', kit: 'louver', prefix: 'LVH1', size: 'window', pricePerSqm: 3200, ruleIdBase: 'lvh1', panels: 2, op: 'hang', movingPanels: [1] },
  { slug: 'lvr-hang-3', nameTh: 'บานแขวน แบ่ง 3 - ระแนงปรับได้', categoryId: 'louvers', kit: 'louver', prefix: 'LVH3', size: 'window_wide', pricePerSqm: 3800, ruleIdBase: 'lvh3', panels: 3, op: 'hang' },
  { slug: 'lvr-hang-4c', nameTh: 'บานแขวน แบ่ง 4 เปิดกลาง - ระแนงปรับได้', categoryId: 'louvers', kit: 'louver', prefix: 'LVH4C', size: 'window_wide', pricePerSqm: 3900, ruleIdBase: 'lvh4c', panels: 4, op: 'hang' },
  { slug: 'lvr-door-single', nameTh: 'ประตูบานเปิด เดี่ยว - ระแนงปรับได้', categoryId: 'louvers', kit: 'louver_door', prefix: 'LVD1', size: 'door', pricePerSqm: 3300, ruleIdBase: 'lvd1', panels: 1, op: 'casement' },
  { slug: 'lvr-door-double', nameTh: 'ประตูบานเปิด คู่ - ระแนงปรับได้', categoryId: 'louvers', kit: 'louver_door', prefix: 'LVD2', size: 'door_wide', pricePerSqm: 3500, ruleIdBase: 'lvd2', panels: 2, op: 'casement' },
  { slug: 'lvr-door-uneven', nameTh: 'ประตูบานเปิด คู่แม่ลูก - ระแนงปรับได้', categoryId: 'louvers', kit: 'louver_door', prefix: 'LVDU', size: 'door_wide', pricePerSqm: 3600, ruleIdBase: 'lvdu', panels: 2, op: 'casement', panelWidths: [2, 1] },
  { slug: 'lvr-door-uneven-3in', nameTh: 'ประตูบานเปิด คู่แม่ลูก กรอบ 3 นิ้ว - ระแนงปรับได้', categoryId: 'louvers', kit: 'louver_door', prefix: 'LVDU3', size: 'door_wide', pricePerSqm: 3900, ruleIdBase: 'lvdu3', panels: 2, op: 'casement', panelWidths: [2, 1] },
  { slug: 'lvr-swing-single', nameTh: 'ประตูบานสวิง เดี่ยว - ระแนงปรับได้', categoryId: 'louvers', kit: 'louver_door', prefix: 'LVW1', size: 'door', pricePerSqm: 3600, ruleIdBase: 'lvw1', panels: 1, op: 'casement' },
  { slug: 'lvr-swing-double', nameTh: 'ประตูบานสวิง คู่ - ระแนงปรับได้', categoryId: 'louvers', kit: 'louver_door', prefix: 'LVW2', size: 'door_wide', pricePerSqm: 3800, ruleIdBase: 'lvw2', panels: 2, op: 'casement' },
  { slug: 'lvr-swing-uneven', nameTh: 'ประตูบานสวิง คู่แม่ลูก - ระแนงปรับได้', categoryId: 'louvers', kit: 'louver_door', prefix: 'LVWU', size: 'door_wide', pricePerSqm: 3900, ruleIdBase: 'lvwu', panels: 2, op: 'casement', panelWidths: [2, 1] },
  { slug: 'lvr-fold-2', nameTh: 'บานเฟี้ยม แบ่ง 2 - ระแนงปรับได้', categoryId: 'louvers', kit: 'louver_door', prefix: 'LVF2', size: 'door_wide', pricePerSqm: 4200, ruleIdBase: 'lvf2', panels: 2, op: 'fold' },
  { slug: 'lvr-fold-4', nameTh: 'บานเฟี้ยม แบ่ง 4 - ระแนงปรับได้', categoryId: 'louvers', kit: 'louver_door', prefix: 'LVF4', size: 'door_wide', pricePerSqm: 4400, ruleIdBase: 'lvf4', panels: 4, op: 'fold' },
  { slug: 'lvr-fold-6', nameTh: 'บานเฟี้ยม แบ่ง 6 - ระแนงปรับได้', categoryId: 'louvers', kit: 'louver_door', prefix: 'LVF6', size: 'door_wide', pricePerSqm: 4600, ruleIdBase: 'lvf6', panels: 6, op: 'fold' },
  { slug: 'lvr-fold-8', nameTh: 'บานเฟี้ยม แบ่ง 8 - ระแนงปรับได้', categoryId: 'louvers', kit: 'louver_door', prefix: 'LVF8', size: 'door_wide', pricePerSqm: 4800, ruleIdBase: 'lvf8', panels: 8, op: 'fold' },

  /* --- 2. 2in1 บานมัลติฟังก์ชัน ---------------------------------- */
  { slug: 'multi-hang-cas-2', nameTh: '2in1 บานแขวน-เปิด แบ่ง 2', categoryId: 'multi', kit: 'glass_window', prefix: 'M2HC2', size: 'window_wide', pricePerSqm: 3200, ruleIdBase: 'm2hc2', panels: 2, op: 'hang' },
  { slug: 'multi-hang-cas-4', nameTh: '2in1 บานแขวน-เปิด แบ่ง 4', categoryId: 'multi', kit: 'glass_window', prefix: 'M2HC4', size: 'window_wide', pricePerSqm: 3500, ruleIdBase: 'm2hc4', panels: 4, op: 'hang' },
  { slug: 'multi-hang-fold-3', nameTh: '2in1 บานแขวน-เฟี้ยม แบ่ง 3', categoryId: 'multi', kit: 'glass_door', prefix: 'M2HF3', size: 'door_wide', pricePerSqm: 3800, ruleIdBase: 'm2hf3', panels: 3, op: 'fold' },
  { slug: 'multi-hang-fold-6', nameTh: '2in1 บานแขวน-เฟี้ยม แบ่ง 6', categoryId: 'multi', kit: 'glass_door', prefix: 'M2HF6', size: 'door_wide', pricePerSqm: 4100, ruleIdBase: 'm2hf6', panels: 6, op: 'fold' },

  /* --- 3. บานเฟี้ยม ---------------------------------------------- */
  { slug: 'fold-2', nameTh: 'บานเฟี้ยม แบ่ง 2', categoryId: 'folding', kit: 'glass_door', prefix: 'FLD2', size: 'door_wide', pricePerSqm: 3400, ruleIdBase: 'fld2', panels: 2, op: 'fold' },
  { slug: 'fold-4', nameTh: 'บานเฟี้ยม แบ่ง 4', categoryId: 'folding', kit: 'glass_door', prefix: 'FLD4', size: 'door_wide', pricePerSqm: 3600, ruleIdBase: 'fld4', panels: 4, op: 'fold' },
  { slug: 'fold-6', nameTh: 'บานเฟี้ยม แบ่ง 6', categoryId: 'folding', kit: 'glass_door', prefix: 'FLD6', size: 'door_wide', pricePerSqm: 3800, ruleIdBase: 'fld6', panels: 6, op: 'fold' },
  { slug: 'fold-8', nameTh: 'บานเฟี้ยม แบ่ง 8', categoryId: 'folding', kit: 'glass_door', prefix: 'FLD8', size: 'door_wide', pricePerSqm: 4000, ruleIdBase: 'fld8', panels: 8, op: 'fold' },
  { slug: 'fold-10', nameTh: 'บานเฟี้ยม แบ่ง 10', categoryId: 'folding', kit: 'glass_door', prefix: 'FLD10', size: 'door_wide', pricePerSqm: 4200, ruleIdBase: 'fld10', panels: 10, op: 'fold' },
  { slug: 'fold-12', nameTh: 'บานเฟี้ยม แบ่ง 12', categoryId: 'folding', kit: 'glass_door', prefix: 'FLD12', size: 'door_wide', pricePerSqm: 4400, ruleIdBase: 'fld12', panels: 12, op: 'fold' },
  { slug: 'fold-nt-2', nameTh: 'บานเฟี้ยม ไร้รางล่าง แบ่ง 2', categoryId: 'folding', kit: 'glass_door', prefix: 'FLN2', size: 'door_wide', pricePerSqm: 4000, ruleIdBase: 'fln2', panels: 2, op: 'fold' },
  { slug: 'fold-nt-4', nameTh: 'บานเฟี้ยม ไร้รางล่าง แบ่ง 4', categoryId: 'folding', kit: 'glass_door', prefix: 'FLN4', size: 'door_wide', pricePerSqm: 4200, ruleIdBase: 'fln4', panels: 4, op: 'fold' },
  { slug: 'fold-nt-6', nameTh: 'บานเฟี้ยม ไร้รางล่าง แบ่ง 6', categoryId: 'folding', kit: 'glass_door', prefix: 'FLN6', size: 'door_wide', pricePerSqm: 4400, ruleIdBase: 'fln6', panels: 6, op: 'fold' },
  { slug: 'fold-nt-8', nameTh: 'บานเฟี้ยม ไร้รางล่าง แบ่ง 8', categoryId: 'folding', kit: 'glass_door', prefix: 'FLN8', size: 'door_wide', pricePerSqm: 4600, ruleIdBase: 'fln8', panels: 8, op: 'fold' },
  { slug: 'fold-nt-10', nameTh: 'บานเฟี้ยม ไร้รางล่าง แบ่ง 10', categoryId: 'folding', kit: 'glass_door', prefix: 'FLN10', size: 'door_wide', pricePerSqm: 4800, ruleIdBase: 'fln10', panels: 10, op: 'fold' },
  { slug: 'fold-nt-12', nameTh: 'บานเฟี้ยม ไร้รางล่าง แบ่ง 12', categoryId: 'folding', kit: 'glass_door', prefix: 'FLN12', size: 'door_wide', pricePerSqm: 5000, ruleIdBase: 'fln12', panels: 12, op: 'fold' },

  /* --- 4. บานเปิด ------------------------------------------------ */
  { slug: 'cas-door-single', nameTh: 'ประตูบานเปิด เดี่ยว', categoryId: 'casement', kit: 'glass_door', prefix: 'CAS1', size: 'door', pricePerSqm: 2400, ruleIdBase: 'cas1', panels: 1, op: 'casement' },
  { slug: 'cas-door-double', nameTh: 'ประตูบานเปิด คู่', categoryId: 'casement', kit: 'glass_door', prefix: 'CAS2', size: 'door_wide', pricePerSqm: 2600, ruleIdBase: 'cas2', panels: 2, op: 'casement' },
  { slug: 'cas-door-uneven', nameTh: 'ประตูบานเปิด คู่แม่ลูก', categoryId: 'casement', kit: 'glass_door', prefix: 'CASU', size: 'door_wide', pricePerSqm: 2700, ruleIdBase: 'casu', panels: 2, op: 'casement', panelWidths: [2, 1] },
  { slug: 'cas-door-uneven-3in', nameTh: 'ประตูบานเปิด คู่แม่ลูก กรอบ 3 นิ้ว', categoryId: 'casement', kit: 'glass_door', prefix: 'CASU3', size: 'door_wide', pricePerSqm: 3000, ruleIdBase: 'casu3', panels: 2, op: 'casement', panelWidths: [2, 1] },
  { slug: 'cas-win-1', nameTh: 'หน้าต่างบานเปิด', categoryId: 'casement', kit: 'glass_window', prefix: 'CSW1', size: 'window', pricePerSqm: 1600, ruleIdBase: 'csw1', panels: 1, op: 'casement' },
  { slug: 'cas-win-2', nameTh: 'หน้าต่างบานเปิด 2', categoryId: 'casement', kit: 'glass_window', prefix: 'CSW2', size: 'window', pricePerSqm: 1700, ruleIdBase: 'csw2', panels: 2, op: 'casement' },
  { slug: 'cas-win-3', nameTh: 'หน้าต่างบานเปิด 3', categoryId: 'casement', kit: 'glass_window', prefix: 'CSW3', size: 'window_wide', pricePerSqm: 1800, ruleIdBase: 'csw3', panels: 3, op: 'casement' },
  { slug: 'cas-win-4', nameTh: 'หน้าต่างบานเปิด 4', categoryId: 'casement', kit: 'glass_window', prefix: 'CSW4', size: 'window_wide', pricePerSqm: 1900, ruleIdBase: 'csw4', panels: 4, op: 'casement' },
  { slug: 'awn-1', nameTh: 'หน้าต่างบานกระทุ้ง', categoryId: 'casement', kit: 'glass_window', prefix: 'AWN1', size: 'window', pricePerSqm: 1350, ruleIdBase: 'awn1', panels: 1, op: 'awning' },
  { slug: 'awn-2', nameTh: 'หน้าต่างบานกระทุ้ง 2', categoryId: 'casement', kit: 'glass_window', prefix: 'AWN2', size: 'window', pricePerSqm: 1400, ruleIdBase: 'awn2', panels: 2, op: 'awning' },
  { slug: 'awn-3', nameTh: 'หน้าต่างบานกระทุ้ง 3', categoryId: 'casement', kit: 'glass_window', prefix: 'AWN3', size: 'window', pricePerSqm: 1450, ruleIdBase: 'awn3', panels: 3, op: 'awning' },
  {
    slug: 'awn-4t',
    nameTh: 'หน้าต่างบานกระทุ้ง 4',
    categoryId: 'casement',
    kit: 'glass_window',
    prefix: 'AWN4T',
    size: 'window',
    pricePerSqm: 1500,
    ruleIdBase: 'awn4t',
    panels: 4,
    op: 'awning',
    extraRules: AWN4T_RULES,
    summaryTh:
      'บานกระทุ้งเปิดออกด้านนอก ระบายอากาศได้แม้ฝนตก พร้อมช่องแสงบน 4 ช่อง เหมาะกับห้องนอนและห้องน้ำ',
  },

  /* --- 5. บานสวิง ------------------------------------------------ */
  { slug: 'swing-single', nameTh: 'ประตูบานสวิง เดี่ยว', categoryId: 'swing', kit: 'glass_door', prefix: 'SWG1', size: 'door', pricePerSqm: 2800, ruleIdBase: 'swg1', panels: 1, op: 'casement' },
  { slug: 'swing-double', nameTh: 'ประตูบานสวิง คู่', categoryId: 'swing', kit: 'glass_door', prefix: 'SWG2', size: 'door_wide', pricePerSqm: 3000, ruleIdBase: 'swg2', panels: 2, op: 'casement' },
  { slug: 'swing-uneven', nameTh: 'ประตูบานสวิง คู่แม่ลูก', categoryId: 'swing', kit: 'glass_door', prefix: 'SWGU', size: 'door_wide', pricePerSqm: 3100, ruleIdBase: 'swgu', panels: 2, op: 'casement', panelWidths: [2, 1] },

  /* --- 6. บานแขวน ------------------------------------------------ */
  { slug: 'hang-swap', nameTh: 'บานแขวน สลับ', categoryId: 'hanging', kit: 'glass_window', prefix: 'HNGW', size: 'window_wide', pricePerSqm: 2500, ruleIdBase: 'hngw', panels: 2, op: 'hang' },
  { slug: 'hang-single', nameTh: 'บานแขวน เดี่ยว', categoryId: 'hanging', kit: 'glass_window', prefix: 'HNG1', size: 'window', pricePerSqm: 2300, ruleIdBase: 'hng1', panels: 2, op: 'hang', movingPanels: [1] },
  { slug: 'hang-single-pocket', nameTh: 'บานแขวน เดี่ยว - ซ่อนผนัง', categoryId: 'hanging', kit: 'glass_window', prefix: 'HNG1P', size: 'window', pricePerSqm: 2900, ruleIdBase: 'hng1p', panels: 2, op: 'hang', movingPanels: [1] },
  { slug: 'hang-4c', nameTh: 'บานแขวน แบ่ง 4 เปิดกลาง', categoryId: 'hanging', kit: 'glass_window', prefix: 'HNG4C', size: 'window_wide', pricePerSqm: 2800, ruleIdBase: 'hng4c', panels: 4, op: 'hang' },
  { slug: 'hang-4c-pocket', nameTh: 'บานแขวน แบ่ง 4 เปิดกลาง - ซ่อนผนัง', categoryId: 'hanging', kit: 'glass_window', prefix: 'HNG4P', size: 'window_wide', pricePerSqm: 3400, ruleIdBase: 'hng4p', panels: 4, op: 'hang' },

  /* --- 7. บานเลื่อน ---------------------------------------------- */
  {
    slug: 'sld-2p',
    nameTh: 'ประตูบานเลื่อน สลับ',
    categoryId: 'sliding',
    kit: 'glass_door',
    prefix: 'SLD2',
    size: 'door',
    pricePerSqm: 2100,
    ruleIdBase: 'sld2',
    panels: 2,
    op: 'slide',
    extraRules: SLD2_RULES,
    summaryTh: 'บานเลื่อนสองบานบนรางคู่ เปิดได้ครึ่งช่อง เหมาะกับทางออกระเบียงและห้องนั่งเล่น',
  },
  { slug: 'sld-door-4c', nameTh: 'ประตูบานเลื่อน แบ่ง 4 เปิดกลาง', categoryId: 'sliding', kit: 'glass_door', prefix: 'SLDD4C', size: 'door_wide', pricePerSqm: 2400, ruleIdBase: 'sldd4c', panels: 4, op: 'slide' },
  { slug: 'sld-door-3free', nameTh: 'ประตูบานเลื่อน แบ่ง 3 อิสระ', categoryId: 'sliding', kit: 'glass_door', prefix: 'SLDD3F', size: 'door_wide', pricePerSqm: 2500, ruleIdBase: 'sldd3f', panels: 3, op: 'slide' },
  { slug: 'sld-door-3', nameTh: 'ประตูบานเลื่อน แบ่ง 3', categoryId: 'sliding', kit: 'glass_door', prefix: 'SLDD3', size: 'door_wide', pricePerSqm: 2300, ruleIdBase: 'sldd3', panels: 3, op: 'slide' },
  { slug: 'sld-door-6c', nameTh: 'ประตูบานเลื่อน แบ่ง 6 เปิดกลาง', categoryId: 'sliding', kit: 'glass_door', prefix: 'SLDD6C', size: 'door_wide', pricePerSqm: 2700, ruleIdBase: 'sldd6c', panels: 6, op: 'slide' },
  { slug: 'sld-win-swap', nameTh: 'บานเลื่อน สลับ', categoryId: 'sliding', kit: 'glass_window', prefix: 'SLDW', size: 'window_wide', pricePerSqm: 1700, ruleIdBase: 'sldw', panels: 2, op: 'slide' },
  { slug: 'sld-win-4c', nameTh: 'บานเลื่อน แบ่ง 4 เปิดกลาง', categoryId: 'sliding', kit: 'glass_window', prefix: 'SLDW4C', size: 'window_wide', pricePerSqm: 1900, ruleIdBase: 'sldw4c', panels: 4, op: 'slide' },
  { slug: 'sld-win-3free', nameTh: 'บานเลื่อน แบ่ง 3 อิสระ', categoryId: 'sliding', kit: 'glass_window', prefix: 'SLDW3F', size: 'window_wide', pricePerSqm: 2000, ruleIdBase: 'sldw3f', panels: 3, op: 'slide' },
  { slug: 'sld-win-3', nameTh: 'บานเลื่อน แบ่ง 3', categoryId: 'sliding', kit: 'glass_window', prefix: 'SLDW3', size: 'window_wide', pricePerSqm: 1850, ruleIdBase: 'sldw3', panels: 3, op: 'slide' },
  { slug: 'sld-win-6c', nameTh: 'บานเลื่อน แบ่ง 6 เปิดกลาง', categoryId: 'sliding', kit: 'glass_window', prefix: 'SLDW6C', size: 'window_wide', pricePerSqm: 2150, ruleIdBase: 'sldw6c', panels: 6, op: 'slide' },

  /* --- 8. บานเลื่อนแนวตั้ง ---------------------------------------- */
  { slug: 'vert-slide', nameTh: 'บานเลื่อนแนวตั้ง', categoryId: 'vertical-sliding', kit: 'glass_window', prefix: 'VSL1', size: 'vertical', pricePerSqm: 2600, ruleIdBase: 'vsl1', panels: 1, op: 'vertical' },

  /* --- 9. บานปิดตาย ---------------------------------------------- */
  { slug: 'fixed-1', nameTh: 'บานติดตาย', categoryId: 'fixed', kit: 'glass_fixed', prefix: 'FIX1', size: 'fixed', pricePerSqm: 1100, ruleIdBase: 'fix1', panels: 1, op: 'fixed' },
  { slug: 'fixed-2', nameTh: 'บานติดตาย 2', categoryId: 'fixed', kit: 'glass_fixed', prefix: 'FIX2', size: 'fixed', pricePerSqm: 1150, ruleIdBase: 'fix2', panels: 2, op: 'fixed' },
  { slug: 'fixed-3', nameTh: 'บานติดตาย 3', categoryId: 'fixed', kit: 'glass_fixed', prefix: 'FIX3', size: 'fixed', pricePerSqm: 1200, ruleIdBase: 'fix3', panels: 3, op: 'fixed' },
  { slug: 'fixed-4', nameTh: 'บานติดตาย 4', categoryId: 'fixed', kit: 'glass_fixed', prefix: 'FIX4', size: 'fixed', pricePerSqm: 1250, ruleIdBase: 'fix4', panels: 4, op: 'fixed' },
  { slug: 'fixed-5', nameTh: 'บานติดตาย 5', categoryId: 'fixed', kit: 'glass_fixed', prefix: 'FIX5', size: 'fixed', pricePerSqm: 1300, ruleIdBase: 'fix5', panels: 5, op: 'fixed' },
  { slug: 'fixed-6', nameTh: 'บานติดตาย 6', categoryId: 'fixed', kit: 'glass_fixed', prefix: 'FIX6', size: 'fixed', pricePerSqm: 1350, ruleIdBase: 'fix6', panels: 6, op: 'fixed' },

  /* --- 10. มุ้งกันยุงและแมลง -------------------------------------- */
  { slug: 'screen-ss-door', nameTh: 'มุ้งลวดสแตนเลส ประตู', categoryId: 'screens', kit: 'screen', prefix: 'SCRSD', size: 'door', pricePerSqm: 1400, ruleIdBase: 'scrsd', panels: 1, op: 'casement' },
  { slug: 'screen-alu-single', nameTh: 'มุ้งจีบอลูมิเนียม เดี่ยว', categoryId: 'screens', kit: 'screen', prefix: 'SCRA1', size: 'screen', pricePerSqm: 1200, ruleIdBase: 'scra1', panels: 1, op: 'slide' },
  { slug: 'screen-fiber-single', nameTh: 'มุ้งจีบไฟเบอร์ เดี่ยว', categoryId: 'screens', kit: 'screen', prefix: 'SCRF1', size: 'screen', pricePerSqm: 900, ruleIdBase: 'scrf1', panels: 1, op: 'slide' },
  { slug: 'screen-fiber-track-single', nameTh: 'มุ้งจีบไฟเบอร์ เก็บราง เดี่ยว', categoryId: 'screens', kit: 'screen', prefix: 'SCRFT1', size: 'screen', pricePerSqm: 1050, ruleIdBase: 'scrft1', panels: 1, op: 'slide' },
];

/* ------------------------------------------------------------------ *
 * Build
 * ------------------------------------------------------------------ */

const LAM_MAX_WIDTH_CM = 200;

/**
 * Laminated glass comes in a limited pane width, so every product that offers it
 * inherits the same limit rather than each row restating it.
 */
const laminatedWidthRule = (ruleIdBase: string): Rule => ({
  id: `${ruleIdBase}-lam-width`,
  severity: 'error',
  messageTh: `กระจกสองชั้นรองรับความกว้างไม่เกิน ${LAM_MAX_WIDTH_CM} cm`,
  when: and(selected('glass_thickness', 'LAM'), gt(measure('width'), lengthCm(LAM_MAX_WIDTH_CM))),
});

function buildProduct(row: Row): Product {
  const groups: OptionGroup[] = [...KIT_GROUPS[row.kit](), ...measureGroups(row.size)];

  const offersLaminated = groups.some(
    (group) =>
      group.kind === 'sku' &&
      group.code === 'glass_thickness' &&
      group.values.some((value) => value.code === 'LAM'),
  );

  const rules: Rule[] = [...(row.extraRules ?? [])];
  if (offersLaminated) rules.push(laminatedWidthRule(row.ruleIdBase));

  return {
    id: row.slug,
    slug: row.slug,
    nameTh: row.nameTh,
    categoryId: row.categoryId,
    summaryTh: row.summaryTh ?? KIT_SUMMARY[row.kit],
    elevation: {
      panels: row.panels ?? 1,
      operation: row.op ?? 'fixed',
      infill: KIT_INFILL[row.kit],
      ...(row.panelWidths ? { panelWidths: row.panelWidths } : {}),
      ...(row.movingPanels ? { movingPanels: row.movingPanels } : {}),
    },
    heroImage: `/products/${row.slug}.svg`,
    leadTimeDays: KIT_LEAD_TIME[row.kit],
    pricePerSqm: row.pricePerSqm,
    minBillableSqUm: sqmToSqUm(SIZES[row.size].minBillableSqm),
    groups,
    rules,
    skuPrefix: row.prefix,
  };
}

export const products: Product[] = ROWS.map(buildProduct);

export const getProductBySlug = (slug: string): Product | undefined =>
  products.find((product) => product.slug === slug);

export const getProductById = (id: string): Product | undefined =>
  products.find((product) => product.id === id);
