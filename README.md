# ALUFORM — Custom Furniture Configurator

Prototype เว็บสำหรับขายงานอะลูมิเนียมสั่งทำ (หน้าต่าง ระแนง ประตู มุ้ง)
ลูกค้ากรอกขนาดช่องเปิดจริง เห็นราคาเต็มจำนวนทันที **ไม่ต้องล็อกอิน ไม่ต้องทิ้งเบอร์ก่อนดูราคา**

ปลายทางของธุรกิจคือ **ขอใบเสนอราคา (RFQ)** ไม่ใช่การจ่ายเงินออนไลน์ — ใน UI เรียกว่า "ตะกร้า"
แต่ใน code ใช้ชื่อ `Quote*` (`QuoteLine`, route `/quote`) เพื่อไม่ต้อง rename ทั้งโปรเจกต์ตอนทำ RFQ จริง

สเปกเต็มอยู่ที่ [`prompt.md`](prompt.md)

---

## สถานะ

| Phase | ขอบเขต | สถานะ |
|---|---|---|
| 1 | types · zod schema · mock data · pricing · validation · skuCode + unit tests | ✅ |
| 2 | design tokens · fonts · `AppHeader` · `/` (stub) · `/products` + FilterPanel | ✅ |
| 3 | `/products/:slug` configurator เต็มรูปแบบ · ElevationPreview · PriceSummary | ✅ |
| 4 | `QuoteContext` · localStorage · `/quote` · toast · a11y pass | ⬜ ยังไม่ทำ |

ตอนนี้ `/quote` เป็น stub — v1 จบที่ **เพิ่มลงตะกร้าและเห็นสิ่งที่เพิ่มไปแล้ว** ยังไม่มีฟอร์มขอใบเสนอราคา

**121 tests · `tsc --noEmit` สะอาด · `oxlint` ไม่มี warning**

---

## เริ่มใช้งาน

```bash
npm install
npm run dev          # http://localhost:5173
npm test             # vitest run
npm run typecheck    # tsc -b --noEmit
npm run lint         # oxlint
npm run build
```

ไม่มี backend ไม่มี env variable ไม่มี API — ข้อมูลทุกอย่างเป็น TS module ใน `src/data/`
network request เดียวที่ออกไปข้างนอกคือการโหลดฟอนต์จาก Google Fonts

---

## ⚠️ ราคาส่วนใหญ่เป็นตัวเลขสมมติ

catalog มี 81 สินค้า **แต่มีเพียง 3 ตัวที่ราคาเป็นของจริง** — เป็นตัวเลขที่สเปกกำหนดไว้ใน test case:

| สินค้า | pricePerSqm |
|---|---|
| `awn-4t` หน้าต่างบานกระทุ้ง 4 | 1,500 |
| `lvr-adj-3` ระแนงปรับได้ แบ่ง 3 | 2,400 |
| `sld-2p` ประตูบานเลื่อน สลับ | 2,100 |

อีก 78 ตัว รวมทั้ง lead time, `minBillableSqm`, ช่วงขนาด และค่า surcharge ของ option
**เป็น placeholder ทั้งหมด** ราคาเป็นคอลัมน์เดียวในตาราง `ROWS` ที่ [`src/data/products.ts`](src/data/products.ts)
— แทนที่ด้วยราคาจริงได้โดยไม่ต้องแตะอย่างอื่น

---

## แนวคิดหลัก

### แยก `sku` ออกจาก `custom`

โจทย์ทั้งหมดของระบบอยู่ตรงนี้:

| ประเภท | ลักษณะ | ตัวอย่าง | ผลต่อระบบ |
|---|---|---|---|
| `sku` | ค่าจำกัด นับได้ มีสต็อกแยก | สีโปรไฟล์ สีกระจก ความหนา มุ้งลวด | ประกอบเป็น `sku_code` |
| `custom` | ตัวเลขต่อเนื่อง มีหน่วยวัด | ความกว้าง ความสูง | เป็น input ของสูตรราคา ไม่สร้างรหัสใหม่ |

`sku_code` = `{skuPrefix}-{code ของทุก SkuGroup ที่ includeInSkuCode}` เช่น `AWN4T-DW-GRN-T5-NS0`

### Schema-driven

configurator **render จาก JSON ของสินค้าล้วนๆ** ไม่มี UI ที่ hardcode ต่อสินค้าชิ้นใดชิ้นหนึ่ง
สินค้า `screen-fiber-single` มี sku group แค่ 2 กลุ่มและไม่มีกระจกเลย ก็ทำงานถูกต้องโดยไม่มีโค้ดพิเศษ

### Pure functions

pricing กับ validation อยู่ใน `src/lib/` ไม่ import อะไรจาก React เลย — เทสได้ตรงๆ และย้ายไปฝั่ง server ได้ถ้าวันหนึ่งต้องทำ

---

## โครงสร้าง

```
src/
  types/     catalog.ts (data model) · rule.ts (RuleExpr AST)
  data/      products.ts (แหล่งข้อมูลเดียว) · categories.ts
             schema.ts (zod, parse ตอน boot) · catalog.ts (จุดที่แอปอ่านข้อมูล)
             ruleBuilders.ts
  lib/       pricing.ts · validation.ts · optionStates.ts · skuCode.ts
             filters.ts · format.ts · hash.ts
  state/     useConfigurator.ts · useMediaQuery.ts · useElementSize.ts
  components/
    configurator/  ElevationPreview (signature) · OptionGroupBase
                   SwatchGroup · ChipGroup · ToggleOption · MeasureInput
                   IssuePanel · PriceSummary · PriceBreakdownList
    catalog/       ProductCard · FilterPanel
    common/        AppHeader · Button · Badge · Accordion · BottomSheet · Schematic
  pages/     Home · Catalog · Configure · Quote · About · NotFound
tests/       8 ไฟล์ 121 เคส
```

ทุกอย่างอ่านข้อมูลผ่าน [`src/data/catalog.ts`](src/data/catalog.ts) ไม่ใช่ `products.ts` โดยตรง
เพื่อให้ zod parse ทำงานครั้งเดียวตอน module load **ก่อน** component แรกจะ render
— typo ใน mock data จะทำให้แอปไม่ boot พร้อมข้อความชัดเจน แทนที่จะไปโผล่เป็นราคาผิดในอีกสามหน้าถัดไป

---

## เพิ่มสินค้าใหม่

แก้ไฟล์เดียว — เพิ่มหนึ่งแถวใน `ROWS` ที่ [`src/data/products.ts`](src/data/products.ts):

```ts
{
  slug: 'awn-5',
  nameTh: 'หน้าต่างบานกระทุ้ง 5',
  categoryId: 'casement',
  kit: 'glass_window',   // กำหนดว่ามี option group อะไรบ้าง
  prefix: 'AWN5',        // ห้ามซ้ำกับสินค้าอื่น (schema เช็คให้)
  size: 'window',        // กำหนดช่วง min/max/default ของขนาด
  pricePerSqm: 1550,
  ruleIdBase: 'awn5',
},
```

`kit` มี 6 แบบ: `louver` · `louver_door` · `glass_window` · `glass_door` · `glass_fixed` · `screen`
`size` มี 8 profile: `window` · `window_wide` · `door` · `door_wide` · `louver` · `fixed` · `vertical` · `screen`

ถ้าสินค้านั้นมีข้อจำกัดเฉพาะตัว ใส่ `extraRules` เพิ่ม — กฎ "กระจกสองชั้นกว้างไม่เกิน 200 cm"
ถูก generate ให้อัตโนมัติทุกสินค้าที่มี LAM อยู่แล้ว เพราะเป็นสมบัติของวัสดุ ไม่ใช่ของสินค้า

---

## สูตรราคา

[`src/lib/pricing.ts`](src/lib/pricing.ts) — **ลำดับนี้ห้ามสลับ**

```
1. areaSqm      = (width × height) / 10000
2. billableSqm  = max(areaSqm, minBillableSqm)
3. base         = billableSqm × pricePerSqm
4. percentTotal = Σ (base × delta / 100)        ← คิดจาก base เท่านั้น
5. perSqmTotal  = Σ (billableSqm × delta)
6. flatTotal    = Σ delta
7. unitPrice    = base + percent + perSqm + flat
8. total        = round(unitPrice × qty)        ← ปัดเศษที่ขั้นนี้ขั้นเดียว
```

`percent` เป็น markup บนค่าอะลูมิเนียม จึงต้องคิดก่อนบวกค่ากระจกและค่าอุปกรณ์
ปัดเศษครั้งเดียวตอนท้าย — ถ้าปัดต่อชิ้นก่อนคูณ ยอด 3 ชิ้นจะเพี้ยนไป 1 บาท

ตัวเลขทุกตัวที่ขึ้นจอผ่าน formatter ใน [`format.ts`](src/lib/format.ts) — กัน float artifact, `NaN` และ `-0`

---

## กฎ validation

[`src/lib/validation.ts`](src/lib/validation.ts) รองรับ 3 ประเภท:

1. **Range / step** — derive จาก `CustomGroup.min/max/step` อัตโนมัติ ไม่ต้องเขียนใน `rules[]`
   ค่าที่ไม่ตรง step จะ snap **ขึ้น** ตอน blur (บานที่ใหญ่ไปเจียนหน้างานได้ บานที่เล็กไปทำไม่ได้)
2. **Cross-field** — เช่น พื้นที่รวมไม่เกิน 8 ตร.ม.
3. **Compatibility** — เช่น `glass_thickness == 'LAM' && width > 200`

### ทำไม `RuleExpr` เป็น discriminated union ไม่ใช่ expression string

สเปกเปิดให้เลือกทั้งสองทาง เราเลือก union เพราะ:

- `strict: true` ตรวจ string ไม่ได้เลย — typo อย่าง `widht > 200` จะโผล่เป็น `ReferenceError`
  ตอน runtime และเฉพาะตอนที่ลูกค้าบังเอิญเลือกคู่ที่ไปแตะกฎนั้น
- zod ตรวจโครงสร้าง union ได้ตอน boot — `schema.ts` จับกฎที่อ้าง group ผิดชื่อได้ทันที
- ได้ `Issue.affects` ฟรีจากการเดิน AST ทำให้ UI รู้ว่าต้อง highlight ช่องไหน
  และทำให้บล็อกตัวเลือกได้ถูกจุด (ดูด้านล่าง)

`ruleBuilders.ts` ทำให้เขียนกฎอ่านง่ายพอๆ กับ string: `and(selected('glass_thickness','LAM'), gt(measure('width'), 200))`

### ตัวเลือกที่เลือกไม่ได้

[`optionStates.ts`](src/lib/optionStates.ts) ตัดสินว่าตัวเลือกไหนขึ้น disabled + ขีดฆ่า

นิยามที่ตรงไปตรงมา ("เลือกแล้วเกิด error → บล็อก") ใช้ไม่ได้ — ถ้าพื้นที่เกิน 8 ตร.ม. อยู่แล้ว
ทุกตัวเลือกจะเกิด error เหมือนกันหมด สีกระจกก็จะโดนขีดฆ่าทั้งที่ไม่เกี่ยวอะไรเลย
จึงบล็อกเฉพาะเมื่อ error ที่เกิด **อ้างถึงกลุ่มนั้นเองใน `affects`**

ตัวเลือกที่ถูกบล็อกยัง focus ได้และใช้ `aria-disabled` ไม่ใช่ `disabled` — เพราะ control ที่ `disabled`
ไม่ยิง event เลย บน touch device จึงไม่มีทางรู้ว่าทำไมเลือกไม่ได้ เหตุผลจะขึ้นเป็นข้อความใต้กลุ่มเสมอ

---

## งานออกแบบ

แนวคิด: สินค้ากลุ่มนี้ขายด้วย **ความแม่นยำ** ไม่ใช่ความหรู หน้าเว็บควรให้ความรู้สึกเหมือนแบบก่อสร้าง
มากกว่าแคตตาล็อกไลฟ์สไตล์ — พื้นหลังโทนอะโนไดซ์เข้ม ตัวเลขและมิติเด่นชัด สีสดใช้เฉพาะสถานะที่เลือกอยู่

**Signature element** คือ `ElevationPreview` — SVG ที่วาดใหม่ real-time พร้อมเส้นบอกมิติจริง
(extension line, dimension line, หัวลูกศร, ตัวเลขใน mono) วาดในพิกัด **พิกเซล** ไม่ใช่หน่วย cm
เพราะถ้าใช้ viewBox หน่วย cm แล้วให้เบราว์เซอร์ย่อ ตัวเลขบอกมิติจะย่อตามไปด้วย
ระแนง 600×60 cm จะอ่านไม่ออก — ซึ่งพังจุดประสงค์ทั้งหมดขององค์ประกอบนี้

### Design tokens บังคับด้วย tooling

[`src/index.css`](src/index.css) **ล้าง** `--color-*`, `--text-*`, `--breakpoint-*`, `--font-*` ของ Tailwind
ทิ้งด้วย `: initial` แล้วใส่ของเราเข้าไปแทน ผลคือ `text-sm`, `sm:`, `bg-slate-800` **ไม่ถูก generate เลย**

กติกา "type scale มี 7 ค่า ห้ามใช้ค่านอกนี้" และ "breakpoint มีแค่ 3 จุด" จึงเป็นเรื่องที่เครื่องมือบังคับ
ไม่ใช่เรื่องที่ต้องอาศัยวินัยของคนรีวิว

| token | ใช้กับ |
|---|---|
| `--lime` | ราคารวม + ปุ่มหลัก **ไม่เกิน 2 จุดต่อหน้าจอ** |
| `--blueprint` | ข้อมูลเชิงมิติเท่านั้น ห้ามเอาไปทำปุ่ม |
| `--danger` / `--warn` | error / warning |

Breakpoint: base 360–767 · `md` 768–1023 · `lg` 1024+ · container `max-width: 1200px`

---

## เทส

```
tests/pricing.test.ts       17   รวม 6 เคสตามสเปกหัวข้อ 5
tests/validation.test.ts    20   รวม 7 เคสตามสเปกหัวข้อ 6
tests/optionStates.test.ts  12
tests/schema.test.ts        20   พิสูจน์ว่า schema ปฏิเสธ typo ที่มันมีไว้จับจริง
tests/filters.test.ts       23
tests/format.test.ts        15
tests/hash.test.ts           7
tests/skuCode.test.ts        7
```

เทสของ filter ใช้ **fixture 3 สินค้า** ไม่ใช่ catalog จริง เพราะมันทดสอบ *logic ของตัวกรอง*
ไม่ใช่ทดสอบว่าสัปดาห์นี้มีสินค้าอะไรบ้าง — การ assert รายชื่อ slug ทั้งชุดทำให้ทุกเคสพังทันทีที่เพิ่มสินค้า
โดยไม่ได้บอกอะไรเกี่ยวกับ logic เลย ส่วน catalog จริงมี property test แยกที่เป็นจริงเสมอไม่ว่าจะโตแค่ไหน

ตรวจ responsive ด้วยเบราว์เซอร์จริงที่ **360 / 390 / 667×375 (landscape) / 768 / 1024 / 1440**
โดยวัดขอบขวาของทุก element ไม่ใช่แค่ `scrollWidth` — เพราะ `overflow-x: clip` จะกลบผลได้

---

## จุดที่ต่างจาก `prompt.md`

| เรื่อง | สเปกบอก | ที่ทำจริง | เหตุผล |
|---|---|---|---|
| React | 18 | **19** | Vite template ล่าสุด ไม่มีอะไรพึ่งพฤติกรรมเฉพาะของ 18 |
| `RuleExpr` | `Function` constructor | **discriminated union** | สเปกเปิดช่องไว้เอง เหตุผลอยู่ใน [`types/rule.ts`](src/types/rule.ts) |
| `configHash` | sha1 | **FNV-1a (sync)** | sha1 ในเบราว์เซอร์เป็น async อย่างเดียว และนี่ไม่ใช่ security boundary |
| Validation test #3 | `400×120` → 2 errors | **`400×220`** → 1 error | `400×120` = 4.8 ตร.ม. ไม่เกิน 8 กฎ max-area จึงยิงไม่ได้ทางคณิตศาสตร์ |
| ราคาบน sticky bar | 20px | **18px** | 20px ไม่อยู่ใน type scale 7 ค่า สองกฎนี้ขัดกันเอง |
| `heroImage` | ภาพสินค้า | **`Schematic` วาดจากข้อมูล** | ไม่มีภาพถ่ายจริง และการวาดภาพแยกต่อสินค้าคือ hardcode UI ต่อชิ้น |

---

## นอกขอบเขต

ไม่มีในโปรเจกต์นี้: ระบบชำระเงิน · บัญชีผู้ใช้ · backend/database/API จริง · การส่งอีเมล ·
ระบบหลังบ้านแอดมิน · i18n · SSR/SEO · animation library · UI component library
(design token เฉพาะเจาะจงเกินกว่าจะไป override ธีมของ library)

โค้ดเขียนโดยไม่ผูกกับ `window` ใน render path เพื่อให้ย้ายไป Next.js App Router ได้ง่ายถ้าจะขึ้น production จริง
