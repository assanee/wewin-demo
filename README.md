# ALUFORM — Custom Furniture Configurator

Prototype เว็บสำหรับขายงานอะลูมิเนียมสั่งทำ (หน้าต่าง ระแนง ประตู มุ้ง)
ลูกค้ากรอกขนาดช่องเปิดจริง เห็นราคาเต็มจำนวนทันที **ไม่ต้องล็อกอิน ไม่ต้องทิ้งเบอร์ก่อนดูราคา**

ปลายทางของธุรกิจคือ **ขอใบเสนอราคา (RFQ)** ไม่ใช่การจ่ายเงินออนไลน์ — ใน UI เรียกว่า "ตะกร้า"
แต่ใน code ใช้ชื่อ `Quote*` (`QuoteLine`, route `/quote`) เพื่อไม่ต้อง rename ทั้งโปรเจกต์ตอนทำ RFQ จริง

สเปก v1 ฉบับเต็ม (`prompt.md`) ไม่ได้อยู่ในรีโป — README นี้กับ [`docs/monorepo-plan.md`](docs/monorepo-plan.md) คือเอกสารที่ยังมีชีวิต

---

## สถานะ

| Phase | ขอบเขต | สถานะ |
|---|---|---|
| 1 | types · zod schema · mock data · pricing · validation · skuCode + unit tests | ✅ |
| 2 | design tokens · fonts · `AppHeader` · `/` (stub) · `/products` + FilterPanel | ✅ |
| 3 | `/products/:slug` configurator เต็มรูปแบบ · ElevationPreview · PriceSummary | ✅ |
| 4 | `QuoteContext` · localStorage · `/quote` · toast · a11y pass | ✅ |

**v1 จบตรงนี้ตามสเปก** — เพิ่มลงตะกร้า ดู แก้จำนวน ลบ ทำซ้ำ แก้การตั้งค่า
ไม่มีปุ่มส่งคำขอ ไม่มีฟอร์มกรอกข้อมูลติดต่อ ไม่มีการชำระเงิน

**296 tests ใน `packages/core` · `tsc --noEmit` สะอาด · `oxlint` ไม่มี warning**
(ทั้ง workspace 506 tests หลังเฟส 3a — ดูหัวข้อ [เทส](#เทส))

### การยกระดับเป็น monorepo

แผนเต็มอยู่ที่ [`docs/monorepo-plan.md`](docs/monorepo-plan.md) — ตารางนี้คือสถานะจริงของมัน

| เฟส | ทำอะไร | สถานะ |
|---|---|---|
| 0 | pnpm workspace + Turborepo · แยกชั้นโดเมนเป็น `@wewin/core` · **ไม่เปลี่ยนพฤติกรรมอะไรเลย** | ✅ |
| 1 | เงินเป็น `bigint` หน่วยย่อย (สตางค์) ทั้งระบบ · VAT คำนวณจริง · `NaN` กับ `-0` แทนค่าไม่ได้อีก | ✅ |
| 2 | ความยาว canonical เป็น **ไมโครเมตรจำนวนเต็ม** · grid · หน่วยแสดงผล 5 แบบ | ✅ |
| 3a | `packages/db` · `packages/contract` · `apps/api` · ย้าย catalog เข้า Postgres | ✅ |
| 3b | auth + RBAC (แผนข้อ 6) | ✅ |
| 4 | dashboard แก้ไขสินค้า · draft/publish | ✅ |
| 5 | order lifecycle · outbox · ชำระเงิน · ใบเสนอราคาที่ฝ่ายขายแก้ได้ | ✅ |
| 6 | Next.js App Router · i18n 8 ภาษา · ตัวเลขตามภาษา | ✅ |
| 7 | รีวิวหลังส่งมอบ · การกลั่นกรอง · ค่าตั้งค่าผู้ใช้ | ⚠️ **ไม่ครบ** |
| — | เข้าสู่ระบบด้วยรหัสผ่าน · ลืมรหัสผ่าน (ครบทั้งอีเมลและหน้าจอ) · สคริปต์สร้างผู้ใช้คนแรก | ✅ |
| — | ชุดตัวเลือก · คลังรูปภาพ | ✅ |

⚠️ **เฟส 7 ปิดไม่ครบ** — schema, API, และหน้าร้านเสร็จและผ่านเทสต์ แต่ **หน้าจอ moderation ใน dashboard ยังไม่มี**
และมีหนี้เปิดค้างหลายข้อ · รายละเอียดทั้งหมดอยู่ในแผนข้อ 9.6 และ 12.1 — อ่านก่อนทำต่อ

หน้า **ชุดตัวเลือก** และ **คลังรูปภาพ** ถูกสร้างแล้ว (เคยเป็น placeholder ที่เขียนว่า "กำลังพัฒนาในเฟส 4"
ทั้งที่เฟส 4 จบไปสามเฟสก่อน) — API ทั้งสิบสองเส้นทางมีมาตั้งแต่เฟส 4 รอแค่หน้าจอ

สิ่งที่พบระหว่างปิดเฟส 7 สำคัญกว่าตัวฟีเจอร์: **`submitted_at` เขียนด้วยนาฬิกา Node ขณะที่ `frozen_at`
ประทับด้วยนาฬิกา Postgres** และมี CHECK เทียบสองค่านี้ — ออร์เดอร์ที่ยืนยันเข้าผลิตเร็วกว่าที่นาฬิกา
ฐานข้อมูลจะตามทัน จะถูกปฏิเสธทั้งที่ลูกค้าจ่ายเงินแล้ว · เป็นบั๊กของ production ไม่ใช่ของเทสต์ (แผนข้อ 9.6(1))

เฟส 1 เทียบกับ `calcPrice` ของ v1.0.0 กว่า 55,000 ชุด **ตรงกันทุกตัว ยกเว้น 87 ชุดที่ v1 คิดขาดไป ฿1**
เพราะ float ทำครึ่งบาทหล่นหาย · เฟส 2 เปลี่ยนหน่วยใต้ทั้งหมดนั้นโดยที่ 87 ยังเป็น 87

เฟส 3a ใช้เกณฑ์เดียวกันกับการย้ายข้อมูล: `apps/api/tests/catalog-fidelity.pg.test.ts` seed แล้วอ่าน
สินค้าทั้ง **81 ตัวกลับออกมาทาง HTTP** แล้วเทียบกับ `@wewin/core/fixtures` ด้วย `toStrictEqual`
ทุก option ทุกค่า ทุกโหนดของ rule AST ทุก elevation ทุก bigint — ผิดไปหนึ่งไมโครเมตรหรือหนึ่งสตางค์ก็แดง
และบล็อกสุดท้ายของไฟล์ **แก้แถวในฐานจริงเพื่อพิสูจน์ว่าเทสต์แดงได้** แล้วคืนค่ากลับ

---

## เข้า dashboard ครั้งแรก

`users.read`/`users.write` ยังไม่มี route จึงไม่มีหน้าจอสร้างบัญชี — สคริปต์นี้คือทางเข้าแรก
และเป็นสคริปต์ไม่ใช่ endpoint เพราะ endpoint ที่ออกบัญชีสิทธิ์เต็มคือรูที่ต้องเฝ้าตลอดไป

```bash
pnpm --filter @wewin/api create-user -- somchai@wewin.co.th
# หรือจำกัดสิทธิ์
pnpm --filter @wewin/api create-user -- sales@wewin.co.th --permissions orders.read,quotes.write
```

รหัสผ่านมาจากการพิมพ์ตอบ หรือจาก `WEWIN_BOOTSTRAP_PASSWORD` สำหรับงานอัตโนมัติ —
**ไม่เคยรับจาก argv** เพราะ argv อยู่ใน shell history และใน `ps` ของทุกคนบนเครื่อง ·
รันซ้ำด้วยอีเมลเดิมคือวิธีเปลี่ยนรหัสผ่านที่ลืม

⚠️ dashboard เรียก API ข้าม origin จึงต้องมีใน `.env` ราก ไม่งั้นหน้า login จะขึ้น
*"ติดต่อ API ไม่ได้"* ทั้งที่ API ทำงานปกติ:

```
CORS_ORIGINS=http://localhost:3001,http://localhost:3002
COOKIE_SECURE=false
```

## เริ่มใช้งาน

```bash
pnpm install

cp .env.example .env  # DATABASE_URL — ค่าเริ่มต้นชี้ไปที่ Postgres ของ docker compose
pnpm db:up            # docker compose up -d --wait  (รอจน healthcheck ผ่านก่อนคืน prompt)
pnpm db:migrate       # สร้าง schema
pnpm db:seed          # ยัดตาราง 81 สินค้าจาก @wewin/core เข้า Postgres

pnpm dev              # ทุก app พร้อมกัน — web อยู่ที่ http://localhost:3002
pnpm test             # vitest
pnpm typecheck
pnpm lint
pnpm boundaries       # ใครนำเข้าอะไรได้บ้าง — ดูหัวข้อ "ทิศทางของ dependency"
pnpm build
```

ต้องใช้ **pnpm** ไม่ใช่ npm — workspace ผูกกันด้วย `workspace:*` protocol

**ต้องมี Docker** เครื่องนี้ไม่มี Postgres — `docker-compose.yml` ที่ราก
คือตัวจัดหาให้ **ต้องอยู่ที่รากเท่านั้น** เพราะ Docker Compose ไล่หาไฟล์ขึ้นไปตามไดเรกทอรีแม่
ไฟล์ที่รากจึงทำให้ `db:up` ของทุกแพ็กเกจชี้ไป Postgres ตัวเดียวกัน ส่วนไฟล์ที่ซุกอยู่ในแพ็กเกจใด
แพ็กเกจหนึ่งจะกลายเป็นคนละ compose project กับที่รากเรียก แล้วได้ฐานสองตัวโดยไม่มีใครสังเกต

`pnpm db:nuke` ลบทั้ง container และ volume เมื่ออยากเริ่มจากศูนย์

ไฟล์เดียวจริงแล้ว — `docker-compose.yml` ที่รากคือการรวมสองไฟล์เดิม
(`packages/db` พอร์ต 5433 + locale ICU th-TH · `apps/api` พอร์ต 5432 + `--data-checksums` + TZ=UTC)
เหลือพอร์ต **5433** เพราะ `pnpm db:seed` ทำ truncate และ 5432 คือที่ที่ Postgres ของบริษัทมักอยู่
`db:up` ของทั้ง `packages/db` และ `apps/api` ชี้กลับมาที่ไฟล์นี้ด้วย `-f ../../docker-compose.yml`

`db:migrate` กับ `db:seed` ตั้ง `"cache": false` ไว้ใน [`turbo.json`](turbo.json) **เจตนา ไม่ใช่ความมักง่าย**
— migration ที่ "hit cache" คือ migration ที่ไม่ได้รัน แล้ว Turbo รายงานว่าสำเร็จโดยที่ตารางไม่มีอยู่จริง
ส่วน `DATABASE_URL` ถูกประกาศเป็น `env` ของ task `test` จึงเข้าไปอยู่ใน hash: ชุดเทสที่เขียวกับฐานหนึ่ง
ไม่ได้บอกอะไรเลยเกี่ยวกับอีกฐานหนึ่ง การชี้ไปฐานอื่นจึงต้อง **หลุด** แคช ไม่ใช่ใช้ผลเดิม

`.env` อยู่ที่ราก **ที่เดียวพอ** — ทั้ง `apps/api` (ตอนบูตและตอนเทส) `packages/db` (เทส · `db:migrate`
· `db:seed`) ไล่หาจากไดเรกทอรีของตัวเองขึ้นไปจนถึงราก แล้วหยุดที่ `pnpm-workspace.yaml`
ไฟล์ที่อยู่ในแพ็กเกจชนะไฟล์ที่ราก (ไว้ชี้ migration ไปฐานอื่นชั่วคราว) และตัวแปรที่ export ไว้แล้ว
ชนะทั้งสองไฟล์เสมอ — `process.loadEnvFile` เติมช่องว่าง ไม่ทับของเดิม

`GET /meta` **นับจากฐานข้อมูล ไม่ใช่จากตาราง TS** — เดิมมันอ่าน `@wewin/core/fixtures` แล้วตอบ
`{"source":"fixtures","productCount":81}` ต่อไปเรื่อยๆ แม้ฐานจะว่างเปล่า ตอนนี้ตอบ
`{"source":"database","counts":{"publishedProducts":81,"categories":10}}` และเมื่อฐานล่ม
`counts` เป็น `null` **ไม่ใช่ `0`** เพราะ "ยังไม่มีสินค้าที่เผยแพร่" กับ "query ล้มเหลว" เป็นคนละเรื่อง

`documentHash` ที่เสิร์ฟออกไป **คำนวณใหม่จากเอกสาร ไม่ได้อ่านจากคอลัมน์** — ไม่งั้นมันเป็นแค่ป้ายชื่อ
เอกสารที่ถูกแก้ในที่เดิมจะยังถือ hash เก่าไว้ แล้วการเทียบ 409 ตามแผนข้อ 5.5 ก็จะเทียบกับค่าที่
ไม่ได้อธิบายเอกสารข้างๆ มันอีกต่อไป ผลลัพธ์ memoise ไว้ต่อคู่ `(versionId, hash)` เพราะแถวถูก
แช่แข็งอยู่แล้ว และมีเทสต์ที่ปิด trigger แล้วแก้ JSONB จริงเพื่อพิสูจน์ว่ามันปฏิเสธ

`apps/web` ยังอ่าน catalog จาก `@wewin/core/fixtures` โดยตรงและยังไม่เรียก API เลย — มันจะย้ายไปกิน
`apps/api` ตอนเปลี่ยนเป็น Next.js ในเฟส 6 network request เดียวที่หน้าเว็บออกไปข้างนอกตอนนี้
ยังเป็นการโหลดฟอนต์จาก Google Fonts เหมือนเดิม

---

## ⚠️ ราคาส่วนใหญ่เป็นตัวเลขสมมติ

catalog มี 81 สินค้า **แต่มีเพียง 3 ตัวที่ราคาเป็นของจริง** — เป็นตัวเลขที่สเปกกำหนดไว้ใน test case:

| สินค้า | pricePerSqm |
|---|---|
| `awn-4t` หน้าต่างบานกระทุ้ง 4 | 1,500 |
| `lvr-adj-3` ระแนงปรับได้ แบ่ง 3 | 2,400 |
| `sld-2p` ประตูบานเลื่อน สลับ | 2,100 |

อีก 78 ตัว รวมทั้ง lead time, `minBillableSqUm`, ช่วงขนาด และค่า surcharge ของ option
**เป็น placeholder ทั้งหมด** ราคาเป็นคอลัมน์เดียวในตาราง `ROWS` ที่ [`packages/core/src/data/products.ts`](packages/core/src/data/products.ts)
— แทนที่ด้วยราคาจริงได้โดยไม่ต้องแตะอย่างอื่น แล้ว `pnpm db:seed` ใหม่

**ข้อมูลติดต่อใน [`apps/web/src/data/company.ts`](apps/web/src/data/company.ts) เป็นของจริง** — คัดลอกตรงตัวจาก
https://www.wewin180.com/th/contact (ดึงเมื่อ 2 ส.ค. 2569 ตรวจซ้ำกับ `/th/about`)
เบอร์คงรูปแบบ `+66` ตามที่เว็บเผยแพร่ ไม่ได้แปลงเป็น `0XX` เพื่อให้เทียบกับต้นทางได้ตรงๆ

**สิ่งที่ไม่มีบนเว็บต้นทาง จะไม่ถูกเดาขึ้นมา:**

| เรื่อง | สถานะ |
|---|---|
| ปีก่อตั้ง | ตัดออก — ฉบับก่อนเขียน "พ.ศ. 2547" ซึ่งเป็นตัวเลขที่แต่งขึ้น |
| ความหนาโปรไฟล์ · มาตรฐาน (มอก.) · เงื่อนไขรับประกัน | `null` ใน `productSpecs` — ไม่ render |

สามข้อหลังเคยถูกเขียนเป็น "มอก. 284-2530 · ทดสอบแรงลม 2,000 Pa" และ "โครงสร้าง 5 ปี · อุปกรณ์ 2 ปี"
ซึ่ง**แต่งขึ้นทั้งหมด** — ใบรับรองที่กุขึ้นคือการอ้างผลทดสอบที่ไม่เคยเกิด และเงื่อนไขรับประกันที่กุขึ้น
คือข้อสัญญา ทั้งคู่เดาไม่ได้ยิ่งกว่าราคา แถวที่ `valueTh` เป็น `null` จะไม่แสดง
หน้าสินค้าจึงบอกให้สอบถามทีมงานแทน — เติมค่าจริงลง `productSpecs` แล้วแถวจะกลับมาเอง

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

pricing กับ validation อยู่ใน `packages/core/` ไม่ import อะไรจาก React เลย — เทสได้ตรงๆ และย้ายไปฝั่ง server ได้ถ้าวันหนึ่งต้องทำ

---

## โครงสร้าง

```
packages/core/            @wewin/core — โดเมนล้วน ไม่มี React แม้แต่ import เดียว
  src/
    types/     catalog.ts (data model) · rule.ts (RuleExpr AST)
    data/      products.ts (ตาราง 81 สินค้า — ต้นทางของ seed) · categories.ts
               schema.ts (zod, parse ตอน boot) · catalog.ts (จุดที่แอปอ่านข้อมูล)
               ruleBuilders.ts
    money.ts · vat.ts · units.ts        ← เงิน bigint · VAT · ไมโครเมตร (เฟส 1–2)
    pricing.ts · validation.ts · optionStates.ts · skuCode.ts · elevation.ts
    filters.ts · catalogSummary.ts · format.ts · hash.ts · history.ts
    shareLink.ts · quote.ts (reducer, pure) · constants.ts
    index.ts   root ของแพ็กเกจ — เป็น type ล้วน ไม่มี runtime
  tests/       18 ไฟล์ 296 เคส

packages/contract/        @wewin/contract — DTO ของ HTTP ที่ api กับ client ใช้ร่วมกัน
packages/db/              @wewin/db — Drizzle schema + migration + seed
                          **มีแต่ apps/api ที่ import ได้** และ db ขึ้นกับ core ไม่ใช่ทางกลับ

apps/api/                 @wewin/api — NestJS (CommonJS) · Drizzle · Postgres

apps/web/                 @wewin/web — Next.js App Router (เฟส 6b · แอป Vite ถูกลบแล้ว)
  src/
    state/         QuoteContext.tsx (React shell) · useQuote · useConfigurator
                   useMediaQuery · useElementSize
    data/          company.ts (ข้อมูลบริษัทจริง — เป็นเนื้อหา ไม่ใช่โดเมน)
    components/
      configurator/  ElevationPreview · OptionGroupBase · SwatchGroup · ChipGroup
                     ToggleOption · MeasureInput · IssuePanel · PriceSummary
                     PriceBreakdownList · ConfiguratorToolbar · QrCode
      catalog/       ProductCard · FilterPanel
      quote/         QuoteLineRow (lg) · QuoteLineCard (base/md) · QuoteActions
      common/        AppHeader · AppFooter · Button · Badge · Accordion · BottomSheet
                     ElevationDrawing · Schematic · StickyBar · Toast · useToast.ts
    pages/     Home · Catalog · Configure · Quote · About · NotFound
```

**`@wewin/core` ถูก compile ด้วย `tsc` ไม่ได้แชร์ซอร์ส** — สิ่งที่ CI type-check คือสิ่งเดียวกับที่ production รัน
และ root ของแพ็กเกจเป็น type ล้วนโดยตั้งใจ: `import '@wewin/core'` จะโยน `ERR_PACKAGE_PATH_NOT_EXPORTED`
ทุก runtime value ต้องมาจาก subpath (`@wewin/core/pricing`, `/validation`, `/fixtures`, …)
เพื่อให้การถามว่า `Product` หน้าตายังไง ไม่ลากตาราง 81 สินค้าเข้ามาด้วย

ทุกอย่างอ่านข้อมูลผ่าน [`packages/core/src/data/catalog.ts`](packages/core/src/data/catalog.ts) ไม่ใช่ `products.ts` โดยตรง
เพื่อให้ zod parse ทำงานครั้งเดียวตอน module load **ก่อน** component แรกจะ render
— typo ใน mock data จะทำให้แอปไม่ boot พร้อมข้อความชัดเจน แทนที่จะไปโผล่เป็นราคาผิดในอีกสามหน้าถัดไป

### ทิศทางของ dependency

```
              ┌──►  contract  ──┐
   core  ─────┼──►  db  ────────┼──►  api
              └──►  web
```

ลูกศรมีทิศทางเดียว **`db` ขึ้นกับ `core` ไม่ใช่ทางกลับ** — โดเมนต้องคำนวณราคาได้โดยไม่รู้จัก Postgres

[`turbo.json`](turbo.json) **ไม่ได้เขียนลำดับนี้ลงไปตรงๆ** มันประกาศแค่ `"dependsOn": ["^build"]`
แล้วปล่อยให้ลำดับตกผลึกจากกราฟ `workspace:*` ของ pnpm เอง ผลคือการเพิ่มแพ็กเกจใหม่
ไม่มีทางทำให้ลำดับ build ผิดโดยที่ลืมแก้ไฟล์นี้ — เพราะไม่มีลำดับที่เขียนไว้ให้ลืมแก้

### `packages/db` มีแต่ `apps/api` ที่ import ได้ — บังคับด้วยเครื่องมือ

กฎนี้เป็นเรื่องที่ `pnpm boundaries` ตรวจ ไม่ใช่เรื่องที่คนรีวิวต้องจำ ประกอบจากสามชิ้นที่ต้องมีครบ:

| ชิ้น | อยู่ที่ | เนื้อหา |
|---|---|---|
| ป้าย | `packages/db/turbo.json` | `"tags": ["db"]` |
| ป้าย | `apps/api/turbo.json` | `"tags": ["api"]` |
| กฎ | [`turbo.json`](turbo.json) ที่ราก | `boundaries.tags.db.dependents.allow: ["api"]` |

**ขาดซีกไหนก็ไม่เหลือกฎ** ถ้าไม่มี `boundaries` ที่ราก ป้ายก็เป็นแค่ข้อความ · ถ้า `apps/api`
ไม่ติดป้าย `api` มันจะถูกปฏิเสธพร้อมกับทุกคน เพราะ allowlist ตรวจ **ป้าย** ไม่ได้ตรวจชื่อแพ็กเกจ
แพ็กเกจที่ไม่มีป้ายเลยแล้วไปพึ่ง `@wewin/db` จะได้ `Package X found without any tag listed in allowlist for db`

---

## เพิ่มสินค้าใหม่

แก้ไฟล์เดียว — เพิ่มหนึ่งแถวใน `ROWS` ที่ [`packages/core/src/data/products.ts`](packages/core/src/data/products.ts):

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

แล้ว `pnpm db:seed` เพื่อให้ฝั่ง API เห็นด้วย — invariant ข้ามสินค้า (slug ซ้ำ · id ซ้ำ · `prefix` ซ้ำ ·
`categoryId` ที่ไม่มีอยู่) มีคนตรวจสองชั้น: zod ตอน module load และ `UNIQUE`/`FK` ใน Postgres
ตามแผนข้อ 5 ชั้นที่สองไม่ใช่ของซ้ำซ้อน — zod ตรวจได้เพราะมันเห็นตารางทั้งใบพร้อมกัน
ส่วน dashboard ในเฟส 4 จะแก้ทีละสินค้า ตอนนั้นจะไม่มีใครเห็นตารางทั้งใบอีกแล้ว

> เฟส 4 จะย้ายการเพิ่มสินค้าไปที่ dashboard และตาราง `ROWS` จะกลายเป็น seed ตั้งต้นอย่างเดียว

---

## สูตรราคา

[`packages/core/src/pricing.ts`](packages/core/src/pricing.ts) — **ลำดับนี้ห้ามสลับ** และทุกบรรทัดเป็น `bigint`

```
1. areaSqUm     = width µm × height µm                  ← จำนวนเต็มพอดี ไม่มีการหาร
2. billableSqUm = max(areaSqUm, minBillableSqUm)
3. base         = billableSqUm × pricePerSqm × 100       ← [scaled] สตางค์ × SQ_UM_PER_SQM
4. percentTotal = Σ (base × delta / 100)                 ← คิดจาก base เท่านั้น
5. perSqmTotal  = Σ (billableSqUm × delta × 100)
6. flatTotal    = Σ (delta × 100 × SQ_UM_PER_SQM)
7. unitPrice    = base + percent + perSqm + flat         ← ยังเป็น [scaled] เต็มความละเอียด
8. total        = divRoundHalfUp(unitPrice × qty, SQ_UM_PER_SQM × 100)
```

`percent` เป็น markup บนค่าอะลูมิเนียม จึงต้องคิดก่อนบวกค่ากระจกและค่าอุปกรณ์
`base` พก factor 100 ติดตัวมาตลอด การหาร `/100` ในขั้นที่ 4 จึงลงตัวเสมอ ไม่ใช่แค่มักจะลงตัว

**ปัดเศษจุดเดียว และปัดจากความละเอียดเต็มตรงไปยังหน่วยที่แสดง** ห้ามแวะปัดที่สตางค์ก่อน —
฿36,224.496 ถ้าแวะปัดจะกลายเป็น ฿36,224.50 แล้วจบที่ ฿36,225 ซึ่งเกินที่ v1.0.0 คิดไป ฿1

`unitPriceMinor` ที่ส่งออกไปเป็น **ค่าสำหรับแสดงผลเท่านั้น** มันคูณ `qty` แล้วไม่ได้ `totalMinor`
ตัวที่เป็นสัญญาคือ `totalMinor` ส่วนการคูณจำนวนใหม่ให้ใช้ `totalFromUnitPrice(unitPriceScaledMinor, qty)`
ซึ่งเริ่มจากค่าที่ยังไม่ถูกปัด — ไม่งั้นก็คือการปัดสองครั้งอีกทางหนึ่ง

ตัวเลขทุกตัวที่ขึ้นจอผ่าน formatter ใน [`format.ts`](packages/core/src/format.ts) — กัน float artifact, `NaN` และ `-0`

### ความยาวเป็นไมโครเมตร ไม่ใช่มิลลิเมตร

[`units.ts`](packages/core/src/units.ts) — `gcd(5 mm, ⅛ นิ้ว) = gcd(5000 µm, 3175 µm) = 25 µm`
ค่า min/max/default ในตาราง size profile **48 จาก 48 ค่าไม่อยู่บน grid นิ้ว** ถ้า canonical เป็นมิลลิเมตร
แล้ว snap ตาม grid ของหน่วยที่กำลังแสดงอยู่ แค่สลับหน่วยแล้วคลิกออกจากช่อง ขนาดจริงจะขยับ

> **การสลับหน่วยเป็นการแสดงผลล้วนๆ ห้าม snap ใหม่** `snapUpUm` ทำงานเฉพาะตอนพิมพ์ค่าใหม่
> ในหน่วยที่พิมพ์ และบรรทัดนั้นจำ `enteredUnits` ของตัวเองไว้

หน่วยแสดงผลมี 5 แบบ: `mm` · `cm` · `m` · `in` · `ft`

---

## กฎ validation

[`packages/core/src/validation.ts`](packages/core/src/validation.ts) รองรับ 3 ประเภท:

1. **Range / step** — derive จาก `CustomGroup.minUm/maxUm/stepUm` อัตโนมัติ ไม่ต้องเขียนใน `rules[]`
   ค่าที่ไม่ตรง step จะ snap **ขึ้น** ตอน blur (บานที่ใหญ่ไปเจียนหน้างานได้ บานที่เล็กไปทำไม่ได้)
   grid ที่ใช้ตัดสินคือ grid ของหน่วยที่ *พิมพ์เข้ามา* ไม่ใช่ของหน่วยที่กำลังแสดงอยู่
2. **Cross-field** — เช่น พื้นที่รวมไม่เกิน 8 ตร.ม.
3. **Compatibility** — เช่น `glass_thickness == 'LAM' && width > 200`

### ทำไม `RuleExpr` เป็น discriminated union ไม่ใช่ expression string

สเปกเปิดให้เลือกทั้งสองทาง เราเลือก union เพราะ:

- `strict: true` ตรวจ string ไม่ได้เลย — typo อย่าง `widht > 200` จะโผล่เป็น `ReferenceError`
  ตอน runtime และเฉพาะตอนที่ลูกค้าบังเอิญเลือกคู่ที่ไปแตะกฎนั้น
- zod ตรวจโครงสร้าง union ได้ตอน boot — `schema.ts` จับกฎที่อ้าง group ผิดชื่อได้ทันที
- ได้ `Issue.affects` ฟรีจากการเดิน AST ทำให้ UI รู้ว่าต้อง highlight ช่องไหน
  และทำให้บล็อกตัวเลือกได้ถูกจุด (ดูด้านล่าง)

`ruleBuilders.ts` ทำให้เขียนกฎอ่านง่ายพอๆ กับ string:
`and(selected('glass_thickness','LAM'), gt(measure('width'), lengthCm(200)))`

ตัวเลขในกฎต้องผ่าน `lengthCm()` / `areaSqm()` / `scalar()` เสมอ — ทั้งสามแปลงเป็นหน่วย canonical
ให้ตั้งแต่ตอนเขียน กฎจึงเทียบกับค่าที่ลูกค้ากรอกได้ตรงๆ โดยไม่มีการแปลงหน่วยกลางทาง

### ตัวเลือกที่เลือกไม่ได้

[`optionStates.ts`](packages/core/src/optionStates.ts) ตัดสินว่าตัวเลือกไหนขึ้น disabled + ขีดฆ่า

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

[`apps/web/src/index.css`](apps/web/src/index.css) **ล้าง** `--color-*`, `--text-*`, `--breakpoint-*`, `--font-*` ของ Tailwind
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

ทั้ง workspace **2,648 เคส** · `@wewin/core` 339 · `@wewin/i18n` 199 · `@wewin/contract` 90
· `@wewin/db` 313 · `@wewin/web` 293 · `@wewin/dashboard` 141 · `@wewin/api` 1,273

`packages/core` ทดสอบฟังก์ชัน pure ล้วน ไม่มีเคสไหนต้องใช้ DOM จึงไม่ต้องมี Postgres และไม่อ่าน
`DATABASE_URL` เลย

⚠️ **นับจำนวนเคส ไม่ใช่ดู exit code** — เฟส 7 เจอรันที่รายงาน `Tests 18 skipped` โดยที่ `Test Files 1 failed`
เพราะพังใน `beforeAll` จำนวนเคสที่ *fail* จึงเป็นศูนย์ · อ่านผ่านๆ แล้วเหมือนไม่มีอะไรพัง ทั้งที่แอปบูตไม่ขึ้น

ชุดที่ต้องใช้ฐานจริงจะ **skip พร้อมข้อความ** เมื่อไม่มี `DATABASE_URL` — และคำว่า "พร้อมข้อความ"
คือประเด็นทั้งหมด เพราะครั้งหนึ่ง `turbo run test` เขียวโดยที่ 97 จาก 115 เคสของ `apps/api` ถูก skip
เงียบๆ (รวมทั้ง 91 เคสที่เป็นเกณฑ์ผ่านของเฟส 3a ทั้งเฟส) — turbo ส่ง `DATABASE_URL` ต่อให้เฉพาะเมื่อ
มัน export อยู่ใน shell แล้วเท่านั้น ส่วน `.env` บนดิสก์ turbo มองไม่เห็น ตอนนี้ทั้ง
`apps/api/tests/setup.ts` และ `packages/db/tests/support/db.ts` อ่าน `.env` เอง (ไล่หาจากแพ็กเกจ
ตัวเองขึ้นไปจนถึงราก) และเตือนออก stderr เมื่อไม่เจอ ส่วน `turbo.json` ประกาศ
`globalDependencies: [".env"]` ไว้ด้วย — ชี้ไปฐานอื่นแล้วต้องหลุดแคช ไม่ใช่ replay ผลเดิม

`apps/api` กับ `packages/db` ใช้ Postgres ตัวเดียวกันและทั้งคู่ truncate catalog ดังนั้น
`apps/api/turbo.json` จึงประกาศ `dependsOn: ["@wewin/db#test"]` ไว้ — ไม่ใช่ลำดับ build
แต่เป็นการกันไม่ให้สองชุดรันพร้อมกันแล้ว truncate ของฝั่งหนึ่งไปโผล่กลาง assertion ของอีกฝั่ง

```
quoteReducer.test.ts    42   ตะกร้า: dedupe, ทำซ้ำ, reprice, persistence
schema.test.ts          31   พิสูจน์ว่า schema ปฏิเสธ typo ที่มันมีไว้จับจริง
validation.test.ts      25   รวม 7 เคสตามสเปกหัวข้อ 6
filters.test.ts         23
shareLink.test.ts       21
elevation.test.ts       18
pricing.test.ts         17   รวม 6 เคสตามสเปกหัวข้อ 5
units.test.ts           16   µm ↔ 5 หน่วย · grid · snapUp
format.test.ts          15
money.test.ts           14   half_up รวมค่าติดลบ · minorExponent ≠ roundTo
catalogSummary.test.ts  13   ตัวเลขที่หน้าแรกโฆษณา ต้อง derive จาก products.ts
history.test.ts         12   undo/redo รวบตามความหมาย ไม่ใช่ตามเวลา
optionStates.test.ts    12
vat.test.ts              9   net / vat / grand ต้อง foot เสมอ ทั้งสองทางที่กรอก
displayUnits.test.ts     8   สลับหน่วยไปกลับทุกขนาดที่ตั้งค่าได้ ขนาดจริงต้องไม่ขยับ
hash.test.ts             8
skuCode.test.ts          7
pricing-parity.test.ts   5   เทียบ v1.0.0 กว่า 55,000 ชุด — เกณฑ์ผ่านของเฟส 1
```

`tests/baseline/` เก็บ `pricing-v1.0.0.ts` กับ `catalog-v1.0.0.ts` ไว้ทั้งดุ้น — เป็นสำเนาของโค้ดเดิม
ไม่ใช่ตารางคำตอบที่ generate ไว้ล่วงหน้า เพราะตารางคำตอบพิสูจน์ได้แค่ว่าเราเคยรันมันตอนไหนสักตอน

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
| `RuleExpr` | `Function` constructor | **discriminated union** | สเปกเปิดช่องไว้เอง เหตุผลอยู่ใน [`types/rule.ts`](packages/core/src/types/rule.ts) |
| `configHash` | sha1 | **FNV-1a (sync)** | sha1 ในเบราว์เซอร์เป็น async อย่างเดียว และนี่ไม่ใช่ security boundary |
| Validation test #3 | `400×120` → 2 errors | **`400×220`** → 1 error | `400×120` = 4.8 ตร.ม. ไม่เกิน 8 กฎ max-area จึงยิงไม่ได้ทางคณิตศาสตร์ |
| ราคาบน sticky bar | 20px | **18px** | 20px ไม่อยู่ใน type scale 7 ค่า สองกฎนี้ขัดกันเอง |
| `heroImage` | ภาพสินค้า | **`Schematic` วาดจากข้อมูล** | ไม่มีภาพถ่ายจริง และการวาดภาพแยกต่อสินค้าคือ hardcode UI ต่อชิ้น |
| ตะกร้า | `QuoteContext.tsx` ไฟล์เดียว | **แยก `quoteReducer.ts`** | reducer เป็น pure function เทสได้โดยไม่ต้องมี React หรือ mock เวลา |
| `QuoteLine` | ไม่มีฟิลด์ warning | **เพิ่ม `warnings`** | หัวข้อ 6 บอกว่า warning ต้องติดไปกับ QuoteLine แต่ interface ในหัวข้อ 3 ไม่มีให้ |
| ปุ่มบันทึกตอนแก้ไข | ไม่ระบุ | **อัปเดตในที่เดิม** | "แก้ไขการตั้งค่า" ที่กลายเป็นการเพิ่มรายการใหม่คือการแก้ไขที่ล้มเหลว |

### ตะกร้าทำงานยังไง

- **dedupe**: กด "เพิ่มลงรายการ" ด้วย config เดิมซ้ำ → รวมจำนวนเข้ารายการเดิม (เทียบด้วย `configHash`)
- **"ทำซ้ำรายการ" ข้าม dedupe โดยตั้งใจ** — เคสจริงคือหน้าต่างทรงเดียวกัน 5 บานคนละขนาด
  ถ้าทำซ้ำแล้วถูกรวมกลับทันที ฟีเจอร์นี้ก็ไร้ความหมาย
- **แก้จำนวนคูณจาก `unitPrice` ที่ล็อกไว้** ไม่ได้เรียก `calcPrice` ใหม่ — ไม่งั้นจะได้ราคาวันนี้
  ซึ่งทำลายจุดประสงค์ของ `priceSnapshot`
- **`hydrated` อยู่ใน state ของ reducer ไม่ใช่ใน ref** — effect ที่เขียน localStorage ต้องอ่านธงนี้
  จาก object เดียวกับที่มันกำลังจะเขียน ถ้าใช้ ref ทั้งสอง effect รันในคอมมิตเดียวกัน
  ตัวเขียนจะเห็น state ว่างเปล่าที่ยังไม่อัปเดตแล้วทับตะกร้าจริงทิ้ง
- **`localStorage` ถือเป็น input ที่เชื่อไม่ได้** — JSON เสียหรือ line ที่ฟิลด์ไม่ครบถูกทิ้งทีละรายการ
  ตะกร้าที่พังบางส่วนต้องเสียแค่รายการนั้น ไม่ใช่ทั้งแอปบูตไม่ขึ้น

---

## นอกขอบเขต

ยังไม่มีในโปรเจกต์นี้: ระบบชำระเงิน · บัญชีผู้ใช้ · auth/RBAC (เฟส 3b) · การส่งอีเมล ·
ระบบหลังบ้านแอดมิน (เฟส 4) · i18n · SSR/SEO (เฟส 6) · animation library · UI component library
(design token เฉพาะเจาะจงเกินกว่าจะไป override ธีมของ library)

**backend/database/API เลิกอยู่ในรายการนี้แล้วตั้งแต่เฟส 3a** — แต่ `apps/web` ยังไม่ได้ต่อกับมัน

โค้ดเขียนโดยไม่ผูกกับ `window` ใน render path เพื่อให้ย้ายไป Next.js App Router ได้ง่ายถ้าจะขึ้น production จริง
