# @wewin/dashboard

เครื่องมือภายในสำหรับจัดการสินค้า ตัวเลือก และรูปภาพ — Next.js App Router + shadcn/ui
ลงชื่อเข้าใช้ผ่าน `apps/api` (เฟส 3b)

เอกสารนี้อธิบาย **โครง** ของแอป หน้าจอจัดการสินค้าเป็นอีกครึ่งหนึ่งของเฟส 4 และมาทีหลัง

---

## รันขึ้นมา

```bash
cp apps/dashboard/.env.example apps/dashboard/.env   # แล้วอ่านคอมเมนต์ในไฟล์ให้ครบ
pnpm --filter @wewin/api dev                          # :3000
pnpm --filter @wewin/dashboard dev                    # :3001
```

`.env.example` ระบุค่าฝั่ง API สามตัวที่ต้องตั้งด้วย (`CORS_ORIGINS`, `OAUTH_WEB_BASE_URL`,
`COOKIE_SECURE`) — ทั้งสามตัวถ้าไม่ตั้ง อาการจะออกมาเหมือนแดชบอร์ดพัง ไม่ใช่เหมือนตั้งค่าไม่ครบ

---

## Sign-in works the way apps/api built it, not a second way

1. ปุ่มบนหน้า `/login` มาจาก `GET /auth/oauth/providers` — API บอกเองว่ามี provider ไหนตั้งค่าไว้
   จึงไม่มีปุ่มที่กดแล้วได้ 404
2. ปุ่มเป็น `<a href>` ไปยัง origin ของ API ไม่ใช่ `fetch` เพราะ `start` ตอบ 302 พร้อมตั้ง
   binding cookie ตามข้อ 6(b) ของแผน — เบราว์เซอร์ต้อง *navigate* จริง
3. callback ตั้งเฉพาะ refresh cookie (`__Host-`, `httpOnly`) และ **ทิ้ง access token ทิ้งไป**
   โดยตั้งใจ — ดู `session-issuer.adapter.ts` แดชบอร์ดจึงเรียก `POST /auth/refresh`
   ครั้งแรกเพื่อรับ access token
4. access token อยู่ใน memory ของแท็บนั้นเท่านั้น ไม่ลง `localStorage` ไม่ลงคุกกี้ที่อ่านได้
   รีโหลดหน้า = แลกใหม่หนึ่งรอบ

### สิ่งที่ **จงใจไม่ทำ**: รวม refresh ให้เหลือเส้นเดียว

`src/lib/api/client.ts` ไม่มี mutex ไม่มี in-flight promise ที่แชร์กัน แต่ละคำขอที่เจอ 401
จะยิง `POST /auth/refresh` ของตัวเอง

การแก้ข้อ 6(c) ของ API คือทำ rotation ให้เป็น statement เดียวแบบ atomic พร้อมช่วงผ่อนผัน ~15
วินาที เพื่อให้หกพาเนลที่ token หมดอายุพร้อมกันได้ successor คนละใบ ไม่ใช่ถูกกล่าวหาว่าขโมย
token ถ้าไคลเอนต์รวบ refresh ให้เหลือเส้นเดียว **การแข่งกันจะไม่เกิดขึ้นอีกเลย** — ช่วงผ่อนผัน
จะไม่เคยถูกใช้งาน และวันที่มันพัง (migration ที่ลบเงื่อนไขทิ้ง, `AUTH_REFRESH_GRACE_SECONDS=0`
ที่หลุดเข้าไปใน environment) จะไม่มีอะไรที่นี่รู้ตัว

ต้นทุนคือแถวเพิ่มไม่กี่แถวต่อการหมดอายุหนึ่งครั้ง กำไรคือคุณสมบัติที่ API อ้างว่ามี เป็น
คุณสมบัติที่แอปนี้พึ่งพาอยู่จริง

---

## Navigation derives from permissions

`GET /me` คืนรายการสิทธิ์ → `src/lib/nav/navigation.ts` กรองเมนูจากรายการนั้น → `AppSidebar`
เรนเดอร์ผลลัพธ์ ไม่มีลิงก์ hard-code อยู่ในคอมโพเนนต์เลย

**การซ่อนเมนูไม่ใช่การให้สิทธิ์** (แผนข้อ 6) ตัวบังคับจริงคือ `RbacGuard` บน API ทุก endpoint
พร้อม boot-time route audit ที่ไม่ยอมบูตถ้ามี endpoint ไหนไม่ประกาศ access ไว้ หน้า `/` พิมพ์
principal ที่ `/me` ตอบมาแบบดิบๆ ไว้ให้ตรวจได้ว่าเมนูคำนวณมาจากอะไร

รายการรหัสสิทธิ์ใน `src/lib/auth/permissions.ts` เป็น *สำเนา* ของ
`apps/api/src/rbac/permissions.ts` — คลาดเคลื่อนได้ และทุกทิศทางที่มันคลาดเคลื่อนทำให้เมนู
*หายไป* ไม่ใช่โผล่เกิน เพราะการมองเห็นคำนวณจากรายการที่ API ส่งมา ไม่ใช่จากไฟล์นั้น

---

## ไม่มี auth middleware และนั่นไม่ใช่ช่องโหว่

รูปแบบมาตรฐานของ Next — เช็ค session ใน `middleware.ts` แล้ว redirect ก่อนเรนเดอร์ — ทำที่นี่
ไม่ได้ refresh cookie ขึ้นต้นด้วย `__Host-` จึงไม่มี `Domain` และเป็นของ origin ของ API เท่านั้น
เซิร์ฟเวอร์ Next ตัวนี้เป็นคนละ host เบราว์เซอร์จะไม่ส่งคุกกี้นั้นมาให้เลย middleware ที่
"ตรวจ session" จะกำลังตรวจคุกกี้ที่มันมองไม่เห็น — ผลคือ redirect ทุกครั้งหรือปล่อยผ่านทุกครั้ง
และอย่างหลังคือประตูที่ดูเหมือนประตูแต่ไม่ใช่

`src/components/require-session.tsx` จึงเป็น redirect ฝั่งไคลเอนต์ล้วนๆ และเขียนคอมเมนต์บอกไว้ว่า
มันไม่ใช่ประตู

---

## รอยต่อสำหรับหน้าจอสินค้า

| ของ | อยู่ที่ |
|---|---|
| route group ที่ต้องเข้าสู่ระบบ | `src/app/(app)/` — ได้ sidebar + header + redirect มาให้เอง |
| ตารางเมนู (path + label + permission) | `src/lib/nav/navigation.ts` — ที่เดียวในแอปที่มีลิงก์ |
| การเรียก API | `src/lib/api/client.ts` (`apiFetch` / `apiJson`) |
| หน้า placeholder ที่รอถูกแทนที่ | `src/app/(app)/{products,option-groups,media}/page.tsx` |

`typedRoutes` เปิดอยู่ ดังนั้นการเพิ่มรายการใน `navigation.ts` โดยที่ยังไม่มี `page.tsx`
จะไม่ compile — พิสูจน์แล้วโดยชี้ href ไปยัง `/does-not-exist` แล้วดู `next build` ตีกลับ

---

## shadcn/ui

`components.json` — style `radix-nova`, base color `neutral`, icon `lucide`, RSC เปิด

ใช้ค่า default ของ shadcn เต็มรูปแบบตามแผนข้อ 8.5 **ไม่** ยก `: initial` สี่ namespace จาก
`apps/web/src/index.css` มาด้วย — กฎนั้นถูกออกแบบมาจับโค้ดที่คนเขียน พอเจอโค้ดที่เครื่อง
generate มันจะกลายเป็นกับดัก: คลาสอย่าง `text-sm` จะไม่ผลิต CSS เลย ไม่ error ไม่เตือน
ตัวหนังสือกลับไปเป็น 16px แล้วดูเหมือนดีไซน์พลาด

`--primary` เป็นสีกลาง ไม่ใช่ `--lime` — ตามคำเตือนในข้อ 8.5 ถ้า map ตรงๆ ปุ่ม shadcn ทุกตัว
จะเป็นสีมะนาว และกฎ "ห้ามเกินสองจุดต่อหน้าจอ" จะถูกละเมิดตั้งแต่หน้าจอแรก

### คอมโพเนนต์ที่ติดตั้งไว้ล่วงหน้า และเหตุผลที่ยังไม่มีใครใช้

`src/components/ui/` มีของที่โครงนี้ไม่ได้เรียกใช้เลยอยู่หลายตัว — `table` `dialog` `command`
`field` `label` `textarea` `input-group` **อย่าเพิ่งลบทิ้งเพราะเห็นว่าไม่มีคน import**

แผนข้อ 8.5 ระบุชื่อไว้ตรงๆ ว่าแดชบอร์ดต้องการ `Table` · `Sidebar` · `Dialog` · `Form` ·
`Command` — คือเหตุผลที่เลือก shadcn ตั้งแต่แรก ของพวกนี้เป็น **ฐาน UI ซึ่งเป็นงานของโครง**
ไม่ใช่ของหน้าจอใดหน้าจอหนึ่ง ติดตั้งตอนนี้ทีเดียวแปลว่าคนที่เขียนหน้าจอสินค้าไม่ต้องไปแก้
`package.json` กับ `pnpm-lock.yaml` ระหว่างที่ไฟล์เดียวกันกำลังถูกแก้อยู่อีกทาง

**`Form` ของแผน = `field` ในวันนี้** registry item ชื่อ `form` ของ base `radix` ว่างเปล่า
(ไม่มีไฟล์เลย — ตรวจด้วย `npx shadcn@latest view @shadcn/form -c apps/dashboard`) เพราะ
shadcn ถอด wrapper ที่ผูกกับ react-hook-form ออกแล้วเปลี่ยนไปเป็น `Field` ที่ไม่ผูกกับ
form library ตัวไหนเลย ผลพลอยได้คือแดชบอร์ดไม่ได้ถูกบังคับให้รับ react-hook-form เข้ามา และ
`FieldError` รับ `errors` เป็น array อยู่แล้ว ซึ่งเข้ากับ `details` ของ `VALIDATION_FAILED`
ที่ API ตอบมาได้ตรงๆ

ที่ยังไม่ได้ติดตั้งเพราะยังไม่รู้ว่าหน้าจอต้องการทรงไหน — `select` `checkbox` `radio-group`
`tabs` `popover` `alert-dialog` เพิ่มได้ตามต้องการด้วย
`npx shadcn@latest add <name> -c apps/dashboard`

### แรงเสียดทานที่ต้องรู้ล่วงหน้า

โค้ดที่ shadcn generate มาไม่ได้เขียนมาให้ผ่าน `exactOptionalPropertyTypes` เจอแล้วสองจุด
(`dropdown-menu.tsx`, `sonner.tsx`) ทางแก้คือ **แก้ไฟล์ที่ generate มา** ไม่ใช่ปิด flag
ทั้งสองจุดมีคอมเมนต์อธิบายไว้ในไฟล์ และจะโผล่ใน `shadcn add --diff` ในอนาคต

oxlint เตือน `react(only-export-components)` ห้าจุด (สี่จุดเป็นไฟล์ที่ generate มา ที่ export
`buttonVariants`/`badgeVariants`/`useSidebar` คู่กับคอมโพเนนต์ อีกจุดคือ `useSession`) เป็น
คำเตือนเรื่อง Fast Refresh ไม่ใช่ error — `oxlint` ยัง exit 0 และรากของ repo ตั้งกฎนี้ไว้เป็น
`warn` เอง จึงไม่ได้ไล่ปิดด้วย disable comment ในไฟล์ที่ `shadcn add --diff` จะต้องอ่านทีหลัง

---

## ตรวจสอบ

```bash
pnpm --filter @wewin/dashboard test        # 38 เทสต์ ไม่ต้องใช้ Postgres และไม่ต้องใช้เบราว์เซอร์
pnpm --filter @wewin/dashboard typecheck   # เร็ว: Route ยัง degrade เป็น string
pnpm --filter @wewin/dashboard build       # เข้ม: next build รัน tsc พร้อม .next/types
npx oxlint
```

`build` ต้องมี `NEXT_PUBLIC_API_BASE_URL` — ถ้าไม่มีจะ fail โดยตั้งใจ ค่านี้ถูกฝังลง bundle
ตอน build ไม่มีจังหวะไหนหลังจากนั้นให้อ่านได้อีก

เทสต์ครอบเฉพาะตรรกะที่ไม่งั้นจะมีแค่คอมเมนต์กำกับ — ที่สำคัญที่สุดคือ
`tests/refresh-is-not-serialised.test.ts` ยิง 401 พร้อมกันหกเส้นแล้วยืนยันว่าเกิด refresh
หกครั้ง ไม่ใช่ครั้งเดียว พิสูจน์ด้วย mutation test แล้วว่าถ้าใครใส่ single-flight เข้าไป
เทสต์นี้จะแดงพร้อมข้อความบอกเหตุผล ไม่ได้เทสต์การเรนเดอร์คอมโพเนนต์ — เทสต์ที่เรนเดอร์
sidebar แล้วนับลิงก์คือเทสต์ของ `visibleNavigation` ที่เขียนแพงกว่าเดิม
