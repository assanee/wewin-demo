# ลำดับการย้ายเฟส 2 (phase 2 migration order)

## 0. สถานะจริงที่ยืนยันด้วยการรัน ไม่ใช่จากคำบรรยาย

- `npx vitest run` ใน `packages/core` → **17 files / 257 tests ผ่านหมด** ไม่ใช่ 16/246 ที่ทั้งสี่พื้นที่อ้าง
- `git status --short` มีสองไฟล์ untracked เท่านั้น: `packages/core/src/units.ts` และ `packages/core/tests/units.test.ts` — **เฟส 2 เริ่มไปแล้ว** และตัดสินคำศัพท์ไปแล้ว: `units.ts:22` `LENGTH_UNITS = ['mm','cm','m','in','ft']` (ชื่อ `'in'`/`'ft'` ไม่ใช่ `'inch'`/`'foot'`), `units.ts:30-36` `MICRONS_PER_UNIT` เป็น `bigint` ครบห้าหน่วย, `units.ts:46-52` `toMicrons(number, LengthUnit): bigint`, `units.ts:61-63` `fromMicrons(bigint, LengthUnit): number`
- `packages/core/package.json` exports มี 18 subpath และ **ไม่มี `./units`** → `apps/web` import โมดูลนี้ไม่ได้เลย นี่คืองานชิ้นแรกจริง ไม่ใช่ "สร้าง units.ts"
- จุดแปลงขาออกวันนี้มี **8 จุดพอดี** (grep แล้ว): `shareLink.ts:53`, `MeasureInput.tsx:129`, `ElevationPreview.tsx:78/113/133`, `ProductCard.tsx:59`, `QuoteLineRow.tsx:35`, `QuoteLineCard.tsx:27`

---

## 1. ข้อขัดแย้งที่ตัดสินแล้ว (พร้อมเหตุผล)

**D1 — canonical เป็น `bigint` ไม่ใช่ `number`** (blast-radius/identity-and-storage เสนอ `number`, snap-and-entry สลับไปมา)
เลือก `bigint` สามเหตุผล: (ก) `units.ts:46` คืน `bigint` อยู่แล้ว การเลือก `number` แปลว่าต้องเขียน converter ตัวที่สอง ซึ่งคือ hazard ที่ทุกพื้นที่บ่นเอง (ข) `number` ไม่ห้ามค่าไม่เต็มหน่วย — `shareLink.ts:93-96` วันนี้ยัด `250.37` เข้า measures ได้ตรงๆ และ `MeasureInput.tsx:108-112` commit ค่าดิบทุก keystroke ถ้า canonical เป็น `number` ทั้งเหตุผลของเฟส ("integer ทำให้ float dust เป็นไปไม่ได้") หายไปทันที (ค) `apps/web` **ไม่มีเทสต์เลยสักไฟล์** typecheck คือด่านอัตโนมัติเดียว การเปลี่ยนชนิดคือสิ่งเดียวที่ทำให้ 8 จุดขาออกกลายเป็น compile error แทน `"0"` เงียบๆ
ราคาที่ต้องจ่าย (`JSON.stringify` ที่ `useConfigurator.ts:58-62`, replacer ที่ `quote.ts:189-191`) เป็นการแก้จุดละบรรทัด และต้องแตะอยู่แล้วเพราะ storage ขึ้น v3

**D2 — พื้นที่เป็น µm² เต็ม + `PRICE_SCALE` 1e6 → 1e12** (ไม่ใช่ `/1_000_000n` ใน `calcAreaMicroSqm`)
การหารใน area คือจุดปัดที่สองในชั้นเดียวกัน ซึ่ง `pricing.ts:225-232` บันทึกไว้เองว่าเป็นบั๊กที่เคยทำให้ ฿36,224.496 กลายเป็น ฿36,225 · รันตรวจแล้ว: ทุกพจน์คูณ 1e6 เท่ากันหมด และตัวหารก็คูณ 1e6 → **ราคาบนกริดปัจจุบันไม่ขยับแม้แต่สตางค์เดียว** (`3_205_000n × 1_600_000n === 5_128_000n × 1_000_000n` = true) · ค่าสูงสุด `8e6 × 3e6 × 2400 × 100 = 5.76e18` อยู่ในวิสัย bigint สบาย · `minBillableSqm` ทั้ง 6 ค่า × 1e12 เป็นจำนวนเต็มเป๊ะทุกตัว (ตรวจแล้ว รวม 0.8 → 800000000000)
**ข้อควรระวังที่ blast-radius ตกไป:** `MICRO_SQM` (`pricing.ts:33`) เป็นค่าคงที่คนละตัวกับ `PRICE_SCALE` แม้ค่าเท่ากัน ใช้ที่ `:174` (minBillable) และ `:237` (display) — ยกตัวเดียวแล้วลืมอีกตัว = พื้นราคาขั้นต่ำตายสนิท ต้องเปลี่ยนชื่อเป็น `SQ_UM_PER_SQM` เพื่อให้ลืมไม่ได้

**D3 — snap anchor ที่ศูนย์สัมบูรณ์ ไม่ใช่ที่ `group.min`** (`validation.ts:158-159` วันนี้ยึด min)
ตรวจครบ: `min`/`max` ทั้งหมดเป็นจำนวนเต็ม cm → ทุกค่าเป็นพหุคูณของ 10,000 µm → หาร 5,000 ลงตัวทั้งหมด ดังนั้น anchor ที่ศูนย์ให้ผลเหมือนเดิมเป๊ะบนกริดเมตริก แต่แก้กริดนิ้วให้ถูกต้องฟรี (600,000 % 3175 = 3100 ≠ 0 — anchor ที่ min ทำให้พิมพ์ 24 in ได้ 24.122 in กลับมา)

**D4 — `step` เป็น grid ต่อหน่วย 25 µm คือ lattice ไม่ใช่ grid** metric ใช้ `group.stepUm` (5,000), imperial ใช้ 3,175 (1/8 in) · 3175 = 127×25 และ 5000 = 200×25 — 25 µm มีหน้าที่เดียวคือทำให้สอง grid อยู่บน lattice เดียวกัน ห้ามใครไป snap ถึงมัน (snap ที่ 25 µm ให้ 47.550197 in ซึ่งไม่มีตลับเมตรใดอ่านได้)

**D5 — `enteredUnits: Record<string, LengthUnit>` เป็นฟิลด์พี่น้องของ `measures` และ ไม่ เข้า `configHash`** ห้ามยัดเข้าไปใน `measures` (`hash.ts:41` interpolate object เป็น `[object Object]` → หน้าต่างคนละบานได้ hash เดียวกัน) · **`displayUnit` อยู่นอก `ConfiguratorState` ทั้งหมด** เพราะ `useConfigurator.ts:77-79` ห่อ state ทั้งก้อนไว้ใน History → สลับหน่วยจะกินช่อง undo และ `sameState:58-62` ไม่รู้จักมัน ทำให้ `isPristine:128` โกหก · หน่วยเป็น per-user preference ตรงตามที่แผนระบุ

**D6 — share link: คงชื่อ key เดิม เพิ่ม `v=3` แล้วปฏิเสธทั้งลิงก์เมื่อไม่มี** (ไม่ใช่ rename เป็น `width_um`)
เหตุผลที่ rename ใช้ไม่ได้: `shareLink.ts` ตั้ง `found = true` จาก **sku group loop** ก่อนถึง custom group loop ดังนั้นตัด key `width`/`height` ทิ้งแล้วลิงก์ **ไม่ตาย** — ผู้รับได้สีที่แชร์มาบวกขนาด default ซึ่ง "ดูถูก" กว่าบั๊กเดิมเสียอีก ต้องคุมที่ `found`/early-return เท่านั้น

**D7 — `Issue` ยังเป็น `messageTh` ในเฟส 2 เลื่อน `{key, params}` ไปเฟส catalog schema** (ค้านทั้ง blast-radius และ validation-and-display ที่บอกว่า "ถึงกำหนดก่อนเวลา")
เหตุผล: `validate()` ต้องรับ `enteredUnits` อยู่แล้วเพื่อเลือก grid ของ `isOnStep` เมื่อมันรู้หน่วย มันก็ format ข้อความด้วย `formatLength` ได้ → ไม่มีข้อความไหนพ่นเลข µm ออกจอเลย ปัญหาที่เหลือคือ "ข้อความเป็น cm ขณะผู้ใช้พิมพ์นิ้ว" ซึ่งเป็นช่องว่าง UX ไม่ใช่ข้อมูลผิด · การลากงาน 5 ไฟล์ + assertion ทั้งชุดเข้ามาในคอมมิตที่ใหญ่ที่สุดของเฟสอยู่แล้วคือการเพิ่มความเสี่ยงโดยไม่ซื้ออะไรที่กู้ไม่ได้

**D8 — ข้ออ้างที่ตรวจแล้วเป็นเท็จ ตัดออกจากงบเวลา**
`optionStates.ts:51` กรอง issue ด้วย `group.code` ของ **sku group** (`profile_color` ฯลฯ) ส่วน step warning ตั้ง `affects: ['width']` → `['width'].includes('profile_color')` เป็น false ตลอด **step warning ไม่มีวันไปถึง swatch** · `filters.ts` ไม่มี dimension predicate เลย มีแต่ badge ช่วง → งบส่วนนี้เล็กกว่าที่ทุกพื้นที่สมมติ · `awn4t-ratio` ที่ 3:1 พอดี: ในโลก float `209.55/69.85 = 3.0000000000000004` ฟ้อง แต่ในโลก µm `2095500/698500 = 3` เป๊ะ → เลิกฟ้องเอง นี่เป็นผลข้างเคียงที่ **ถูกต้อง** ของเฟสนี้ ต้องตรึงด้วยเทสต์ ไม่ใช่ปล่อยให้ค้นพบทีหลัง

---

## 2. THE MIGRATION ORDER

### ขั้น 1 — เปิด `units.ts` ให้เข้าถึงได้ และ commit มัน
**เปลี่ยน:** commit `src/units.ts` + `tests/units.test.ts` · เพิ่ม `"./units": "./dist/units.js"` ใน `package.json` exports (ตอนนี้มี 18 subpath ไม่มีตัวนี้) · re-export type จาก `src/index.ts` · เพิ่ม `parseMeasure(text, enteredUnit, group): bigint | null` ทับบน `toMicrons` — **ห้ามสร้าง API ชื่อใหม่ซ้อน** และมันต้องคืน `null` ไม่ใช่ throw เพราะ `units.ts:47-49` throw `RangeError` บน non-finite ขณะที่ทุกทางเข้าวันนี้ fallback เป็น `defaultValue` (`validation.ts:154-155`, `MeasureInput.tsx:67`) — ลบข้อความในช่องแล้ว blur จะโยนกลาง event handler
**เทสต์ที่พิสูจน์:** `units.test.ts` เดิม 11 ข้อยังเขียว + เทสต์ใหม่ว่า `parseMeasure('', 'cm', g)` คืน `null` ไม่ throw
**ถ้าทำทีหลังจะพังเงียบอย่างไร:** `MeasureInput` จะถูกเขียนด้วย converter ตัวที่สอง (`value * 10000` inline) เพราะ import ไม่ได้ → กลับไปมี 5 จุดแปลงเหมือนเดิม โดยที่ `units.test.ts` ยังเขียวและไม่มีอะไรบอก

### ขั้น 2 — primitive ของ grid ใน core (pure, ยังไม่มีใครเรียก)
**เปลี่ยน:** ใน `units.ts` เพิ่ม `GRID_UM: Record<LengthUnit, bigint>` (`mm/cm/m` → จาก `group.stepUm`, `in/ft` → `3175n`), `snapUpUm(value, gridUm)` = `((v + g - 1n) / g) * g` (anchor ที่ศูนย์, D3), `isOnGridUm`, และตาราง `DISPLAY_DECIMALS = {mm:3, cm:4, m:6, in:5, ft:6}` (ค่าขั้นต่ำที่ round-trip เป็น identity)
**เทสต์ที่พิสูจน์:** snapUp ปัด **ขึ้น** เสมอ, ค่าที่อยู่บน grid แล้วไม่ขยับ, `3175n % 25n === 0n` และ `5000n % 25n === 0n`
**ถ้าทำทีหลัง:** ขั้น 6 จะต้องคิด grid semantics พร้อมกับแก้ 12 ไฟล์ — และคำถาม "พิมพ์นิ้วแล้ว snap ไปกริดไหน" จะถูกตอบโดยบังเอิญด้วยการแปลง `snapToStep` เป็น bigint ตรงๆ ซึ่งจะดัน 98⅛ in ขึ้นเป็น 98.2283 in ทุกครั้ง (99.5% ของค่าที่พิมพ์เป็นเศษส่วนนิ้วพิมพ์ซ้ำไม่ได้)

### ขั้น 3 — rule AST: ติดมิติให้ const + เปลี่ยนอัตราส่วนเป็นการคูณไขว้ (**ยังเป็น cm ทั้งหมด**)
**เปลี่ยน:** `types/rule.ts:21-27` `{n:'const', value, dim:'length'|'area'|'scalar'}` · builder `lengthCm(200)` / `areaSqm(8)` / `scalar(3)` · `data/schema.ts:42` บังคับ `dim` · เปลี่ยน `gt(div(measure('width'), measure('height')), 3)` (`products.ts:344`) เป็นการคูณไขว้ `w > 3·h` และให้ `evalNum` ปฏิเสธการเทียบข้ามมิติ · const ที่ต้องติดหน่วยมี **ห้าค่าใน 4 กฎ**: `products.ts:338` (8 sqm), `:344` (3 scalar), `:353` (150 cm), `:362` (250 cm), `:513` `LAM_MAX_WIDTH_CM = 200` ใช้ที่ `:523` แนบที่ `:537` — ไม่ใช่ "81 สินค้า"
**เทสต์ที่พิสูจน์:** rule-parity sweep — วนทุกสินค้า × ทุกคู่ (w,h) บนกริด 0.5 cm แล้วยืนยันว่าเซตของ `ruleId` ที่ยิงเหมือนเดิมทุกช่อง · **รันพิสูจน์แล้วล่วงหน้า: `(w/h)>3` กับ `w>3h` ให้ผลเหมือนกัน 259,461/259,461 ช่องทั้งในโลก float วันนี้และในโลก µm bigint** — การรีไรต์นี้จึงเป็น no-op ที่ตรวจสอบได้
**ถ้าทำทีหลัง:** สองอย่างพังพร้อมกันและเงียบทั้งคู่ — `2000000n > 200` จริงเสมอ (LAM ถูกบล็อกทั้งแคตตาล็อก) กับ `lt(measure('width'), 150)` เท็จเสมอ (`lvr3-motor-min` เลิกยิง ลูกค้าสั่งมอเตอร์ที่ 60 cm ได้) และ `4805000n / 1600000n === 3n` ทำให้ `3n > 3n` เป็นเท็จ → **`awn4t-ratio` เงียบสำหรับอัตราส่วนทุกค่าใน [3,4)** ซึ่งเป็น error severity หน้าต่างที่ผลิตไม่ได้ผ่านเข้าตะกร้าไปตัดจริง

### ขั้น 4 — `formatLength(um: bigint, unit: LengthUnit)` ใน `format.ts` (additive, ยังไม่มีใครเรียก)
**เปลี่ยน:** เพิ่มฟังก์ชันใหม่ข้าง `formatCm` (`format.ts:40-43`) · กฎการแสดง: mm/cm/m ทศนิยมตามตารางขั้นต่ำ, **in/ft เป็นเศษส่วน 1/8** (`82 1/2"`, `4' 3 1/2"`) ไม่ใช่ทศนิยม — เหตุผลคือกริดนิ้วคือ 1/8 ค่าที่ snap แล้วจึงตรงกับขีดบนตลับเมตรพอดี ส่วน "4.29 ft" ต้องแปลงด้วยมือหน้าเลื่อย · ค่าที่แสดงในหน่วยที่ไม่ใช่ entered_unit นำหน้าด้วย `≈` (`units.ts:57-59` บันทึกไว้เองแล้วว่า 3,205,000 µm = 126.181102… in ซึ่งไม่มีทศนิยมใดกู้คืน)
**เทสต์ที่พิสูจน์:** round-trip identity ต่อหน่วยตามตาราง decimals + `formatLength(3_200_000n, 'cm') === '320'` (ผลลัพธ์เท่า `formatCm` เดิมทุกเคสใน `format.test.ts`)
**ถ้าทำทีหลัง:** ขั้น 6 จะแก้ compile error 8 จุดด้วยการห่อ `Number()` แล้วทั้งเฟสตายตรงนั้น

### ขั้น 5 — เสริมความแข็งของ persistence **ก่อน** flip (ยังเป็น cm ทั้งหมด — behaviour ไม่ขยับ)
**เปลี่ยน:** ใส่ `schemaVersion` ลงใน payload จริง (`quote.ts:193-194` วันนี้เขียนแค่ `{lines}` ทั้งที่แผนสั่งไว้ตั้งแต่เฟส 1) และให้ `parseStoredQuote` ปฏิเสธ payload ที่ `schemaVersion` ไม่ตรง · ให้ `isQuoteLine` (`quote.ts:202-225`) ตรวจ **ค่าข้างใน** `measures` ไม่ใช่แค่ `typeof === 'object'` · เพิ่ม revive path ของ `measures` คู่ขนานกับ `MONEY_FIELDS` (`quote.ts:228-236`) · เปลี่ยน `sameState` (`useConfigurator.ts:58-62`) จาก `JSON.stringify` เป็นการเทียบ key-by-key · แก้คอมเมนต์ `QuoteContext.tsx:20` ที่ยังเขียนว่า `aluform.quote.v1`
**เทสต์ที่พิสูจน์:** payload ที่ `measures` มีค่าเป็น string → บรรทัดถูก **drop** ไม่ใช่รอด; payload ไม่มี `schemaVersion` → `[]`
**ถ้าทำทีหลัง (คือทำในขั้น 6 พร้อมกัน):** เส้นทางที่กู้ไม่ได้เปิดอยู่ — บรรทัดที่ measures เน่าเป็น string จะรอด filter, `measureOf` (`pricing.ts:121-125`) ตกไปที่ `defaultUm`, แล้ววินาทีที่ลูกค้ากด "แก้ไขการตั้งค่า" `Configure.tsx` เขียน `priceSnapshot` ใหม่ทับ **พยานตัวสุดท้ายของขนาดจริงคือ `priceSnapshot.areaSqm` ซึ่งเป็น `number` ธรรมดาจึงรอด JSON** — ก่อน write-back กู้ได้ หลัง write-back สำเนาทั้งสองชุดตรงกันที่ค่าผิด

### ขั้น 6 — **THE FLIP** (คอมมิตเดียว ห้ามแยก)
แผนบรรทัดที่ว่าด้วยข้อมูลค้างสั่งไว้ตรงๆ ว่า localStorage และ share link ต้องขึ้นเวอร์ชัน "ใน commit เดียวกับที่เปลี่ยนหน่วย" และ typecheck คือสิ่งที่บังคับให้ทุกอย่างข้างล่างเคลื่อนพร้อมกันอยู่แล้ว

**6.1 catalog** — `CustomGroup` (`types/catalog.ts:38-49`) เป็น `minUm/maxUm/stepUm/defaultUm: bigint` เขียนผ่าน constructor `cm(60)` **ห้ามพิมพ์ `600_000n` ลงตาราง** (`products.ts:256-296`) · `Unit` (`catalog.ts:9`) แตกเป็น `AuthoredUnit` (คงค่า `'cm'` ทั้ง 81 สินค้า ไม่ต้องแตะ data) กับ `LengthUnit` จาก `units.ts` · zod (`schema.ts`) เพิ่ม refinement: `minUm > 0n`, `stepUm % 25n === 0n`, `(maxUm − minUm) % stepUm === 0n`, `(defaultUm − minUm) % stepUm === 0n` — นี่คือด่านที่ทำให้การแปลง 48 ช่องตรวจได้ด้วยเครื่อง ไม่ใช่ด้วยตา (`schema.ts` เตือนตัวเองไว้แล้วว่า zod strip คีย์ที่ไม่รู้จักทิ้งเงียบๆ)
**6.2 pricing** — ลบ `toMillimetres` (`pricing.ts:143-144`) และลบ `calcAreaSqm` (`:138-141`) ทิ้งพร้อมกัน · `calcAreaSqUm = wUm * hUm` ไม่มีการหารเลย · `PRICE_SCALE` → `1e12`, `MICRO_SQM` → `SQ_UM_PER_SQM = 1e12` (คนละตัว เปลี่ยนพร้อมกัน มิฉะนั้นพื้นราคาขั้นต่ำตายทุกสินค้า) · `minBillableSqm` ประกาศเป็น `minBillableSqUm` integer ในตาราง · `RuleScope.areaSqm: number` → `areaSqUm: bigint` — สายพื้นที่เหลือหนึ่งเดียวที่ทั้งกฎและราคาอ่านตัวเดียวกัน
**6.3 validation** — ลบ `EPSILON` (`:13`, `:158`, `:171`) และ `toFixed(decimals)` (`:164-166`) ทิ้ง ไม่ใช่แปลงตาม · `snapToStep` → `snapUpUm` จากขั้น 2 · `isOnStep` → `(v % gridUm) === 0n` · `validate()` (`:184-188`) รับ `enteredUnits` เพิ่ม · ที่ขอบบน: ถ้า snap ขึ้นแล้วเกิน `maxUm` ให้เป็น **error** ห้าม `Math.min(snapped, group.max)` (`:162`) ซึ่งคือการ snap **ลง** — 4,000,000 µm ไม่อยู่บนกริดนิ้ว (`3175 × 1260 = 4,000,500`) ลูกค้าพิมพ์ 157.5 in แล้วได้หน้าต่างสั้นลง 500 µm เงียบๆ คือฝั่งที่ spec ข้อ 6 บอกว่ากู้ไม่ได้
**6.4 identity + storage** — `canonicalise` (`hash.ts:38-45`) ใส่ token หน่วยลงสตริง (`width=3200000um`) เพื่อให้ payload ข้ามยุคชนกันไม่ได้ตลอดไป · `QuoteLine` (`quote.ts:13-31`) `measures: Record<string, bigint>` + `enteredUnits: Record<string, LengthUnit>` (ค่าเริ่มต้น `'cm'`) · key → `aluform.quote.v3`, `schemaVersion: 3`, **ทิ้ง v2 ไม่ migrate** — เหตุผลที่ยืนได้: ไม่ใช่ "หน่วยกำกวม" (มันไม่กำกวม `products.ts:278,290` ฮาร์ดโค้ด `unit:'cm'`) แต่เพราะ `unitPriceScaledMinor` เปลี่ยนสเกล 1e6 เท่า และ migration ต้องมีคนดูแลตลอดไป
**6.5 share link** — emit `String(um)` ตรงๆ **เลิกผ่าน `formatCm`** (`shareLink.ts:2,53` — วันนี้ลิงก์ทำความละเอียดหายอยู่แล้วก่อนมีนิ้วเสียด้วยซ้ำ: 250.34 → "250.3") · เพิ่ม `v=3` เข้า `SHARE_RESERVED_KEYS` (`:21`) **และบังคับใช้จริงใน `readSharedConfig`** ซึ่งวันนี้ไม่มีใครอ่าน constant ตัวนี้เลยนอกจากเทสต์ · ลิงก์ไม่มี `v` → `return null` ก่อนวน group ใดๆ · `enteredUnits` เป็นราย group (`width_u=in&height_u=cm`) ไม่ใช่ `u=` ตัวเดียวต่อลิงก์ · **ลิงก์ต้องไม่ trigger snap ตอนเปิด**
**6.6 UI** — `Schematic`/`ElevationPreview` เปลี่ยน props เป็น `ratio: number` + label strings **ห้าม bigint ข้ามเข้าไปในชั้น SVG แม้แต่ตัวเดียว** (`Math.max(3200000n, 1)` โยน TypeError และ `ProductCard.tsx:31-32` อ่าน `defaultValue` ตรงๆ → **หน้า `/products` พังก่อนหน้า configurator**) · `MeasureInput`: `text` เก็บสตริงในหน่วยที่แสดง, effect (`:35-38`) เทียบกับ `formatLength(value, displayUnit)` ไม่ใช่ `parseFloat(text) !== value` (ซึ่งจะเป็นจริงตลอดกาลข้ามชนิดแล้วเขียนทับกลางที่ผู้ใช้พิมพ์), `min/max/step` attribute เป็นค่าในหน่วยที่แสดง, ลบ `toFixed` แฝดที่ `:56-59`, **stepper ต้องเรียก snapUp เดียวกับ core** (วันนี้ `:54-62` ไม่เคยเรียก `snapToStep` เลย) · `?? 0` / `?? 100` ทุกตัวต้องเป็น `0n` หรือ `defaultUm` — grep 7 จุด: `Configure.tsx:89,90,300`, `ProductCard.tsx:31,32`, `QuoteLineCard.tsx:19-20`, `QuoteLineRow.tsx:15-16`
**6.7 ห้ามแตะ** — `elevation.ts` ทั้งไฟล์ (`Rect.width/height` เป็น **พิกเซล** จาก `useElementSize` ไม่ใช่ measure) ใส่คอมเมนต์ประกาศชั้นหน่วยที่หัวไฟล์ เป็นงานสองนาทีที่ตัดความเสี่ยงของการ grep ทิ้ง · `tests/baseline/pricing-v1.0.0.ts` vendored verbatim

**เทสต์ที่พิสูจน์:** `pricing-parity` ต้องยังตรึง `expect(correctedUp).toBe(87)` (`:154`) และ `compared > 50_000` (`:148`) — **ราคาห้ามขยับสักบาท ถ้าขยับแปลว่าสเกลพื้นที่ผิด** · harness เองอยู่ในรัศมี: `sizeSweep` (`:43-66`) ต้อง generate เป็น µm แล้ว `fromMicrons(v,'cm')` ตอนป้อน baseline เท่านั้น, `1_000_000` ที่ `:80-82` ต้องอ้าง constant, และ assertion ที่ `:193` ต้อง re-pin จาก `5_128_000n` เป็น `5_128_000_000_000n`

### ขั้น 7 — ตัวเลือกหน่วยแสดงผลห้าหน่วย (additive)
**เปลี่ยน:** `displayUnit` เป็น context ระดับแอป **นอก History** · ทุกจุดที่วันนี้อ่าน `group.unit` เพื่อแสดงผลย้ายไปอ่านตัวนี้ (`ProductCard.tsx:59`, `MeasureInput.tsx:79/91/121/129`, `Configure.tsx:139`) · `MeasureRange` (`filters.ts:100-114`) คืน `{minUm, maxUm}` แล้วให้ ProductCard format
**เทสต์ที่พิสูจน์:** property test — สลับ cm→in→ft→cm 1,000 รอบ `measures` ต้องไม่ขยับแม้แต่ 1 µm
**ถ้าทำทีหลัง:** ไม่พังอะไร นี่คือเหตุผลที่มันอยู่หลัง flip ได้

### ขั้น 8 — `entered_unit` ทำงานจริง
**เปลี่ยน:** MeasureInput มี **dirty flag** — blur commit เฉพาะเมื่อ text ต่างจาก render ของ canonical ปัจจุบัน (เทียบ string ไม่ใช่ parse แล้วเทียบ number) · commit ที่ dirty เขียน `enteredUnits[code]` และเลือก grid จากมัน · `Configure.tsx:442-448` `initialStateFrom` ต้องพา `enteredUnits` มาด้วย (วันนี้คัดมาแค่ 4 ฟิลด์) · merge ที่ `quote.ts:96` ยึดหน่วยของบรรทัดเดิมโดยตั้งใจ เขียนกำกับไว้แบบเดียวกับ nickname
**เทสต์ที่พิสูจน์:** blur โดยไม่แก้ข้อความ → `measures` ไม่ขยับ (เคส 3,200,000 → 3,200,400 ที่ `units.test.ts` ตรึงไว้แล้วว่าเป็นสิ่งที่ห้ามเกิด) · duplicate/edit พา `enteredUnits` ไปด้วย
**ถ้าทำทีหลัง:** ไม่มีที่เก็บ = มีช่วงที่บรรทัดในตะกร้าไม่รู้ว่าตัวเองถูกกรอกด้วยหน่วยอะไร ซึ่งกู้คืนไม่ได้ — นี่คือเหตุผลที่ **ฟิลด์** ต้องเกิดในขั้น 6 แม้ **พฤติกรรม** จะมาขั้น 8

### ขั้น 9 — หนี้ที่ประกาศไว้ ไม่ใช่ที่ลืม
`Issue` → `{key, params}` + `PriceBreakdown.lines[].label` (แผนไล่ call site ไว้ครบแล้ว: `validation.ts` · `optionStates.ts` · `quoteReducer.ts` · `IssuePanel` · `PriceBreakdownList`) · `canonicalise` เดินจาก `customGroups(product)` เติม `defaultUm` เมื่อ key ขาด ให้ตรงกับ `measureOf` แทน `?? 0` · ข้อความใน rule ที่ hardcode ตัวเลขซ้ำกับ threshold 3 ใน 4 จุด (`products.ts:352/353`, `337/338`, `361/362` — มีแค่ `522/523` ที่ใช้ค่าคงที่ร่วม)

---

## 3. คำตอบตรงสี่ข้อที่ถามมา

**canonical ตัวเดียวและจำนวนจุดแปลงที่แน่นอน**
`integer micrometres as bigint` ตัวเดียว ถือโดย: `CustomGroup.{minUm,maxUm,stepUm,defaultUm}` · `measures` ทุกที่ (state, QuoteLine, RuleScope, hash input, share link) · const ในตำแหน่ง length/area ของ rule AST · พื้นที่เป็น µm²
**จุดแปลงหลังเฟส 2 = 2 จุด runtime + 1 จุด build-time** — ขาเข้า `parseMeasure(text, enteredUnit, group)` ใน `units.ts` (ที่เดียวที่เรียก `snapUpUm`; MeasureInput ทั้งสามทางเรียกตัวนี้) · ขาออก `formatLength(um, unit)` · build-time คือ `cm()` ในตาราง catalog · **share link ไม่นับ เพราะมันไม่แปลงอะไรเลย** พก integer µm ดิบทั้งสองทาง
วันนี้คือ **5 ขาเข้า** (`MeasureInput.tsx:108-112` พิมพ์, `:64-70` blur, `:54-62` stepper, `shareLink.ts:93-96`, `pricing.ts:143-144`) + **8 ขาออก** และมันให้คำตอบไม่ตรงกันอยู่แล้ววันนี้: พิมพ์ 250.3 แล้ว blur ได้ 250.5 แต่เปิดลิงก์ `?width=250.3` ได้ 250.3 ค้างไว้

**storage ไป v3 ไหม / share link พังไหม**
v3 **และ**ใส่ `schemaVersion` ในตัว payload · v2 ถูก **ทิ้ง ไม่ migrate** · share link **พังทุกลิงก์ที่มีอยู่ โดยเจตนา** — ปฏิเสธทั้งใบคืน `null` เมื่อไม่มี `v=3` ไม่ใช่ clamp เพราะ clamp คือกลไกที่แปลงข้อมูลผิดหน่วยให้กลายเป็นข้อมูลที่ดูถูกต้อง (`?width=250` → clamp ขึ้น `minUm` = 60 cm)

**`configHash` และ cart identity**
hash ของทุก configuration เปลี่ยนค่า และ `template literal` บน bigint ไม่โยน (`${3200000n}` = `"3200000"`) จึงไม่มีสัญญาณเตือนใดๆ ตอน migrate — ที่ยอมได้เพราะ v2 ถูกทิ้งในคอมมิตเดียวกัน ไม่มีบรรทัดเก่ารอดมาเทียบ · **identity = skuCode + measures µm เท่านั้น** `enteredUnits` ไม่เข้า hash เพราะ 320 cm / 3200 mm / 3.2 m คือหน้าต่างบานเดียวกันและต้อง merge · `duplicate` ปลอดภัยอยู่แล้ว (`quote.ts:130` spread) · ไม่มี hazard คลาส "hash ชนแล้วแถวหาย" — `configHash` มีผู้บริโภคสามจุด ไม่ถูกใช้เป็น React key หรือ map key ที่ไหน

**เทสต์ที่ต้องแก้ / ที่ห้ามแก้**
*ห้ามแก้:* `tests/baseline/pricing-v1.0.0.ts` ทั้งไฟล์ (vendored verbatim) · `expect(correctedUp).toBe(87)` และ `expect(compared).toBeGreaterThan(50_000)` · `elevation.test.ts` (พิกเซล ไม่ใช่ measure) · `money.test.ts` / `vat.test.ts` / `catalogSummary.test.ts` (ไม่แตะ measure สักจุด)
*ต้องแก้เชิงกลไก (นับจริง):* `validation.test.ts` 47 จุด · `quoteReducer.test.ts` 44 · `optionStates.test.ts` 23 · `shareLink.test.ts` 20 · `pricing-parity.test.ts` 19 · `hash.test.ts` 13 · `pricing.test.ts` 10 · `history.test.ts` 8 · `skuCode.test.ts` / `filters.test.ts` 3 · `schema.test.ts` 2 — **แปดถึงสิบไฟล์ ไม่ใช่สอง** นี่คือส่วนที่ใหญ่ที่สุดของงานและหายไปจากงบของทุกพื้นที่
*ต้องแก้เชิงความหมาย ห้ามแปลงเป็น µm เฉยๆ:* `shareLink.test.ts` เคส clamp — มันทดสอบว่า clamp "ทำงาน" ซึ่งหลังเฟส 2 คือการปกป้องบั๊ก ต้องแทนด้วย "ลิงก์ที่ไม่มี `v=3` → `null`" · `pricing-parity.test.ts:193` re-pin เป็น µm² · `hash.test.ts` ที่ตรึง 160.5

---

## 4. เทสต์ใหม่ที่เล็กที่สุดที่จับ hazard ระดับ blocking ได้ครบ

1. **rule-parity sweep** — ทุกสินค้า × ทุก (w,h) บนกริด 0.5 cm: เซต `ruleId` ที่ยิงต้องเหมือนก่อนย้ายทุกช่อง จับ: const ไร้หน่วย, bigint div ตัดเศษ, area สองสาย, cross-multiply rewrite (ขั้น 3 และ 6.2)
2. **display round-trip invariant** — สำหรับทั้ง 5 หน่วย × ทุกค่าบน grid ของทุกกลุ่ม: `parseMeasure(formatLength(um,u), u, g) === um` และการสลับหน่วยซ้ำ 1,000 รอบไม่ขยับสักไมครอน จับ: กฎกลางของเฟส 4.1 (ขั้น 4, 7, 8)
3. **blur ที่ไม่ได้แก้ข้อความต้องไม่ commit** — assert `measures` ไม่ขยับ โดยเฉพาะเคส 3,200,000 → 3,200,400 จับ: hazard ที่ spec เขียนหัวข้อขึ้นมาเพื่อมัน (ขั้น 8)
4. **storage rejection** — payload v2 เขียนด้วยมือ → `[]` · `measures` ที่มีค่าเป็น string → บรรทัดถูก drop · `schemaVersion` ไม่ตรง → `[]` จับ: hazard ที่กู้ไม่ได้ทั้งหมดในขั้น 5/6.4
