'use client';

import { useMemo, useState } from 'react';
import { ImagePlus, Save, Undo2 } from 'lucide-react';
import type { ElevationWire, ProductFieldsWire, ProductWire } from '@wewin/contract';

import { Button } from '@/components/ui/button';
import { FieldGroup, FieldSeparator } from '@/components/ui/field';

import { SelectField, TextField } from './form-field';
import { GalleryEditor } from './gallery-editor';
import { readVideoUrl } from './gallery';
import { MediaPicker } from './media-picker';
import { bahtField, readBaht, readCount, readSqm, sqmField } from './quantities';
import { areaWire, rateWire } from './wire';

/**
 * The product's own fields — everything that is not one of its options.
 *
 * ### These are draft edits, not live edits, and the screen has to say so
 *
 * `products` is not a versioned table: there is one row per product and the published
 * document holds a frozen *copy* of these values. So saving here changes what the next
 * publish would freeze and changes nothing a customer is quoted — which is correct, and is
 * the single most confusing thing about this whole surface, because the price you just
 * typed is now stored and still not in effect. The API says so in `unpublishedFields`; this
 * form says so by putting the words "บันทึกลงฉบับร่าง" on its own button. Not "บันทึก".
 *
 * ### Nothing here is in a canonical unit
 *
 * The price box holds baht, never satang. The minimum billable area holds square metres,
 * never square micrometres. Both conversions go through `quantities.ts` in both directions,
 * and the encoders in `wire.ts` are the only things that attach a unit to the result — so a
 * figure typed here cannot reach a column under the wrong unit without one of those two
 * files being wrong, which is a smaller surface than every form field on the screen.
 *
 * ### Every field is sent on every save
 *
 * A patch of only the boxes somebody touched sounds tidier and is not: `expectedDocumentHash`
 * already makes a colleague's concurrent edit a 409 rather than a silent overwrite, so a
 * full patch cannot clobber anything the hash would have caught. What a partial patch would
 * add is a second notion of "changed" — this component's — beside the server's, and two
 * answers to "did this move?" is how a field stops being saved because a comparison thought
 * it had not.
 */

interface FormState {
  readonly slug: string;
  readonly skuPrefix: string;
  readonly nameTh: string;
  readonly categoryId: string;
  readonly summaryTh: string;
  readonly heroImage: string;
  /** ⭐ 0052. The gallery, in display order. The only non-string field on this form. */
  readonly images: readonly string[];
  /** ⭐ 0052. Empty means "no video" — see `readVideoUrl`. */
  readonly videoUrl: string;
  readonly leadMin: string;
  readonly leadMax: string;
  readonly pricePerSqm: string;
  readonly minBillableSqm: string;
  readonly panels: string;
  readonly operation: string;
  readonly infill: string;
  readonly panelWidths: string;
  readonly movingPanels: string;
}

type Errors = Partial<Record<keyof FormState, string>>;

/**
 * The keys of `FormState` whose value is a string.
 *
 * ⭐ 0052 made this necessary: `images` is the first field on this form that is not text,
 * and both `text()` and `set()` take a key and assume one. Narrowing the key type is what
 * stops `set('images')` from compiling and quietly replacing the gallery with a string.
 */
type StringField = {
  [K in keyof FormState]: FormState[K] extends string ? K : never;
}[keyof FormState];

const OPERATIONS: readonly { value: ElevationWire['operation']; labelTh: string }[] = [
  { value: 'fixed', labelTh: 'บานติดตาย' },
  { value: 'casement', labelTh: 'บานเปิด' },
  { value: 'awning', labelTh: 'บานกระทุ้ง' },
  { value: 'slide', labelTh: 'บานเลื่อน' },
  { value: 'fold', labelTh: 'บานเฟี้ยม' },
  { value: 'hang', labelTh: 'บานแขวน' },
  { value: 'vertical', labelTh: 'บานเลื่อนขึ้นลง' },
];

const INFILLS: readonly { value: ElevationWire['infill']; labelTh: string }[] = [
  { value: 'glass', labelTh: 'กระจก' },
  { value: 'louvre', labelTh: 'ระแนง' },
  { value: 'mesh', labelTh: 'มุ้งลวด' },
];

/** A list of numbers as a person writes one: `2, 1` or `2 1`. Empty means "not set". */
const parseList = (text: string): readonly string[] =>
  text
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter((part) => part !== '');

export function formFromProduct(product: ProductWire): FormState {
  return {
    slug: product.slug,
    skuPrefix: product.skuPrefix,
    nameTh: product.nameTh,
    categoryId: product.categoryId,
    summaryTh: product.summaryTh,
    heroImage: product.heroImage,
    images: [...(product.images ?? [])],
    videoUrl: product.videoUrl ?? '',
    leadMin: String(product.leadTimeDays[0]),
    leadMax: String(product.leadTimeDays[1]),
    /* Baht and square metres — see the header. The canonical figures never reach a box. */
    pricePerSqm: bahtField(rateMinorOfProduct(product)),
    minBillableSqm: sqmField(sqUmOfProduct(product)),
    panels: String(product.elevation.panels),
    operation: product.elevation.operation,
    infill: product.elevation.infill,
    panelWidths: product.elevation.panelWidths?.join(', ') ?? '',
    /* One-based on screen: "บานที่ 1" is the leftmost panel, and 0 is not a panel number. */
    movingPanels: product.elevation.movingPanels?.map((index) => index + 1).join(', ') ?? '',
  };
}

/*
 * Split out only so `formFromProduct` reads as a list of fields rather than as a list of
 * decoder calls. They are the sanctioned decoders from wire.ts either way.
 */
function rateMinorOfProduct(product: ProductWire): bigint {
  return rateMinorOfWire(product);
}

/* eslint-disable-next-line */
import { rateMinorOf as rateMinorOfExact, sqUmOf as sqUmOfExact } from './wire';

const rateMinorOfWire = (product: ProductWire): bigint => rateMinorOfExact(product.pricePerSqm);
const sqUmOfProduct = (product: ProductWire): bigint => sqUmOfExact(product.minBillableSqUm);

export interface ValidatedFields {
  readonly slug: string;
  readonly skuPrefix: string;
  readonly fields: ProductFieldsWire;
}

/**
 * Everything the form holds, checked and converted, or the reasons it could not be.
 *
 * One pass over every field rather than per-field validation on blur: the elevation's
 * panel count is what makes a `panelWidths` list right or wrong, so at least one rule here
 * cannot be decided by looking at a single box.
 */
export function validateFields(form: FormState): ValidatedFields | Errors {
  const errors: Errors = {};

  const text = (key: StringField, messageTh: string): string => {
    const value = form[key].trim();
    if (value === '') errors[key] = messageTh;
    return value;
  };

  const slug = text('slug', 'กรอกสลัก');
  const skuPrefix = text('skuPrefix', 'กรอกคำนำหน้ารหัส SKU');
  const nameTh = text('nameTh', 'กรอกชื่อสินค้า');
  const categoryId = text('categoryId', 'เลือกหมวดหมู่');
  const summaryTh = text('summaryTh', 'กรอกคำอธิบาย');
  const heroImage = text('heroImage', 'กรอกที่อยู่รูปหลัก');

  if (slug !== '' && !/^[a-z0-9-]+$/.test(slug)) {
    errors.slug = 'ใช้ได้เฉพาะ a–z, 0–9 และขีดกลาง';
  }
  if (skuPrefix !== '' && !/^[A-Z0-9]+$/.test(skuPrefix)) {
    errors.skuPrefix = 'ใช้ได้เฉพาะ A–Z และ 0–9 ตัวพิมพ์ใหญ่';
  }

  const leadMin = readCount(form.leadMin, { min: 0, max: 3650 });
  if (!leadMin.ok) errors.leadMin = leadMin.reasonTh;
  const leadMax = readCount(form.leadMax, { min: 0, max: 3650 });
  if (!leadMax.ok) errors.leadMax = leadMax.reasonTh;
  if (leadMin.ok && leadMax.ok && leadMin.value > leadMax.value) {
    errors.leadMax = 'ต้องไม่น้อยกว่าค่าต่ำสุด';
  }

  const price = readBaht(form.pricePerSqm);
  if (!price.ok) errors.pricePerSqm = price.reasonTh;
  else if (price.value <= 0n) errors.pricePerSqm = 'ต้องมากกว่าศูนย์';

  const minBillable = readSqm(form.minBillableSqm);
  if (!minBillable.ok) errors.minBillableSqm = minBillable.reasonTh;

  const panels = readCount(form.panels, { min: 1, max: 24 });
  if (!panels.ok) errors.panels = panels.reasonTh;

  const widthParts = parseList(form.panelWidths);
  const widths: number[] = [];
  for (const part of widthParts) {
    const value = Number(part);
    if (!/^\d+(?:\.\d+)?$/.test(part) || value <= 0) {
      errors.panelWidths = 'กรอกเป็นตัวเลขบวก คั่นด้วยจุลภาค';
      break;
    }
    widths.push(value);
  }
  if (errors.panelWidths === undefined && widths.length > 0 && panels.ok && widths.length !== panels.value) {
    errors.panelWidths = `ต้องมี ${String(panels.value)} ค่า ให้ตรงกับจำนวนบาน`;
  }

  const movingParts = parseList(form.movingPanels);
  const moving: number[] = [];
  for (const part of movingParts) {
    const value = Number(part);
    if (!/^\d+$/.test(part) || value < 1 || (panels.ok && value > panels.value)) {
      errors.movingPanels = `กรอกหมายเลขบาน 1–${panels.ok ? String(panels.value) : 'จำนวนบาน'} คั่นด้วยจุลภาค`;
      break;
    }
    moving.push(value - 1);
  }

  /*
   * ⭐ 0052. The gallery itself needs no check here: every path in it came from the picker,
   * which only ever hands back a path the API gave it. The video is typed by hand and does.
   */
  const video = readVideoUrl(form.videoUrl);
  if (!video.ok) errors.videoUrl = video.reasonTh;

  const operation = OPERATIONS.find((entry) => entry.value === form.operation)?.value;
  if (operation === undefined) errors.operation = 'เลือกลักษณะการเปิด';
  const infill = INFILLS.find((entry) => entry.value === form.infill)?.value;
  if (infill === undefined) errors.infill = 'เลือกวัสดุ';

  if (Object.keys(errors).length > 0) return errors;
  if (!leadMin.ok || !leadMax.ok || !price.ok || !minBillable.ok || !panels.ok) return errors;
  if (operation === undefined || infill === undefined) return errors;
  if (!video.ok) return errors;

  const elevation: ElevationWire = {
    panels: panels.value,
    operation,
    infill,
    /*
     * Omitted rather than sent as an empty array: core reads "absent" as an even split and
     * would reject a zero-length list against a panel count, so `[]` is not a shorter way
     * of saying the same thing.
     */
    ...(widths.length > 0 ? { panelWidths: widths } : {}),
    ...(moving.length > 0 ? { movingPanels: [...moving].sort((left, right) => left - right) } : {}),
  };

  return {
    slug,
    skuPrefix,
    fields: {
      nameTh,
      categoryId,
      summaryTh,
      heroImage,
      leadTimeDays: [leadMin.value, leadMax.value],
      pricePerSqm: rateWire(price.value),
      minBillableSqUm: areaWire(minBillable.value),
      elevation,
      /*
       * ⭐ 0052. Both sent on every save, like every other field on this form — the header
       * explains why a partial patch is not wanted. `images: []` is how a gallery is
       * emptied and `videoUrl: null` is how a link is removed, so neither can be omitted
       * to mean "unchanged" without losing the ability to mean "gone".
       */
      images: [...form.images],
      videoUrl: video.value,
    },
  };
}

const isValidated = (result: ValidatedFields | Errors): result is ValidatedFields =>
  'fields' in result;

export function FieldsForm({
  product,
  categories,
  disabled,
  onSave,
}: {
  readonly product: ProductWire;
  readonly categories: readonly { readonly id: string; readonly labelTh: string }[];
  readonly disabled: boolean;
  readonly onSave: (validated: ValidatedFields) => Promise<boolean>;
}) {
  const initial = useMemo(() => formFromProduct(product), [product]);
  const [form, setForm] = useState<FormState>(initial);
  const [errors, setErrors] = useState<Errors>({});

  /*
   * Keyed on the draft's own values rather than on a `useEffect` that resets state: when the
   * draft reloads after a save, `initial` is a new object and this comparison starts from
   * the saved values, which is exactly when "unsaved" should stop being true.
   */
  const [pickingHero, setPickingHero] = useState(false);
  const [baseline, setBaseline] = useState(initial);
  if (baseline !== initial) {
    setBaseline(initial);
    setForm(initial);
    setErrors({});
  }

  /*
   * ⚠️ `images` is compared element by element and everything else by value. A reference
   * comparison would call the form dirty after somebody added a picture and removed it
   * again, because the list is rebuilt on every edit — and an "unsaved changes" warning
   * that fires when nothing is unsaved is one people learn to click past.
   */
  const dirty = (Object.keys(initial) as (keyof FormState)[]).some((key) => {
    const next = form[key];
    const before = initial[key];
    if (Array.isArray(next) && Array.isArray(before)) {
      return next.length !== before.length || next.some((path, index) => path !== before[index]);
    }
    return next !== before;
  });

  const set = (key: StringField) => (value: string) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const submit = async (): Promise<void> => {
    const result = validateFields(form);
    if (!isValidated(result)) {
      setErrors(result);
      return;
    }
    setErrors({});
    await onSave(result);
  };

  const categoryOptions = categories.map((entry) => ({ value: entry.id, labelTh: entry.labelTh }));

  return (
    <div className="flex flex-col gap-6">
      <FieldGroup className="@container/field-group grid gap-4 md:grid-cols-2">
        <TextField
          label="ชื่อสินค้า"
          value={form.nameTh}
          onChange={set('nameTh')}
          error={errors.nameTh}
          disabled={disabled}
        />
        <SelectField
          label="หมวดหมู่"
          value={form.categoryId}
          onChange={set('categoryId')}
          options={
            categoryOptions.length > 0
              ? categoryOptions
              : [{ value: form.categoryId, labelTh: form.categoryId }]
          }
          error={errors.categoryId}
          disabled={disabled}
          description="หมวดหมู่แก้ไขจากที่นี่ไม่ได้ — เลือกได้จากรายการที่มีอยู่เท่านั้น"
        />
        <TextField
          label="สลัก (slug)"
          value={form.slug}
          onChange={set('slug')}
          error={errors.slug}
          disabled={disabled}
          mono
          description="ใช้ในลิงก์หน้าร้าน การเปลี่ยนค่านี้ทำให้ลิงก์เดิมใช้ไม่ได้หลังเผยแพร่"
        />
        <TextField
          label="คำนำหน้ารหัส SKU"
          value={form.skuPrefix}
          onChange={set('skuPrefix')}
          error={errors.skuPrefix}
          disabled={disabled}
          mono
          description="ประกอบเป็นรหัส SKU ร่วมกับรหัสของตัวเลือกที่ลูกค้าเลือก"
        />
        <TextField
          label="คำอธิบาย"
          value={form.summaryTh}
          onChange={set('summaryTh')}
          error={errors.summaryTh}
          disabled={disabled}
          multiline
        />
        <div className="flex flex-col gap-2">
          <TextField
            label="รูปหลัก"
            value={form.heroImage}
            onChange={set('heroImage')}
            error={errors.heroImage}
            disabled={disabled}
            mono
            description="รูปที่ใช้แทนสินค้าในรายการและการ์ดหน้าร้าน — คนละอย่างกับแกลเลอรีด้านล่าง"
          />
          {/*
            ⚠️ The box stays editable beside the picker. All 81 seeded products hold a path
            to a static file rather than a `/media/<id>`, and a picker that was the only way
            to set this field would make those paths unreachable — a person correcting a
            typo in one would have to replace the picture to do it.
          */}
          <div>
            <Button variant="outline" size="sm" disabled={disabled} onClick={() => setPickingHero(true)}>
              <ImagePlus data-icon="inline-start" />
              เลือกจากคลังรูป
            </Button>
          </div>
        </div>
      </FieldGroup>

      <FieldSeparator />

      <GalleryEditor
        images={form.images}
        videoUrl={form.videoUrl}
        videoError={errors.videoUrl}
        disabled={disabled}
        onImages={(next) => setForm((current) => ({ ...current, images: next }))}
        onVideoUrl={set('videoUrl')}
      />

      {pickingHero && (
        <MediaPicker
          titleTh="เลือกรูปหลัก"
          onClose={() => setPickingHero(false)}
          onPick={(path) => {
            set('heroImage')(path);
            setPickingHero(false);
          }}
        />
      )}

      <FieldSeparator />

      <FieldGroup className="grid gap-4 md:grid-cols-2">
        <TextField
          label="ราคาต่อตารางเมตร"
          value={form.pricePerSqm}
          onChange={set('pricePerSqm')}
          error={errors.pricePerSqm}
          disabled={disabled}
          prefix="฿"
          description="จำนวนเต็มบาท ไม่มีสตางค์ — ระบบคิดราคาด้วยจำนวนเต็มบาทเท่านั้น"
        />
        <TextField
          label="พื้นที่ขั้นต่ำที่คิดเงิน"
          value={form.minBillableSqm}
          onChange={set('minBillableSqm')}
          error={errors.minBillableSqm}
          disabled={disabled}
          suffix="ตร.ม."
          description="ถ้าพื้นที่จริงน้อยกว่านี้ จะคิดราคาที่ค่านี้"
        />
        <TextField
          label="ระยะเวลาผลิต — อย่างน้อย"
          value={form.leadMin}
          onChange={set('leadMin')}
          error={errors.leadMin}
          disabled={disabled}
          suffix="วัน"
        />
        <TextField
          label="ระยะเวลาผลิต — อย่างมาก"
          value={form.leadMax}
          onChange={set('leadMax')}
          error={errors.leadMax}
          disabled={disabled}
          suffix="วัน"
        />
      </FieldGroup>

      <FieldSeparator />

      {/*
        ⚠️ `type-section` and not the unclassed `font-medium` this was — which inherited 14px
        from `Card`, i.e. **the same size as the fields underneath it**, so the only thing
        marking it as a heading was the weight. It reads as `type-section` even though the
        section it sits inside is also `type-section`, and that is a real limitation of a
        five-step scale rather than an oversight: there is deliberately no step between 18 and
        14 (16 is the value that collided). What separates the two is the `FieldSeparator`
        directly above and the gap — the space half of "type, space and weight".
      */}
      <div className="flex flex-col gap-1">
        <h3 className="type-section">รูปด้าน</h3>
        <p className="text-muted-foreground type-caption">
          ภาพด้านหน้าของสินค้าวาดจากค่าเหล่านี้ ไม่ได้มาจากไฟล์รูป — จำนวนบานและสัญลักษณ์การเปิดจึงต้องตรงกับของจริง
        </p>
      </div>

      <FieldGroup className="grid gap-4 md:grid-cols-2">
        <TextField
          label="จำนวนบาน"
          value={form.panels}
          onChange={set('panels')}
          error={errors.panels}
          disabled={disabled}
        />
        <SelectField
          label="ลักษณะการเปิด"
          value={form.operation}
          onChange={set('operation')}
          options={OPERATIONS.map((entry) => ({ value: entry.value, labelTh: entry.labelTh }))}
          error={errors.operation}
          disabled={disabled}
        />
        <SelectField
          label="วัสดุในบาน"
          value={form.infill}
          onChange={set('infill')}
          options={INFILLS.map((entry) => ({ value: entry.value, labelTh: entry.labelTh }))}
          error={errors.infill}
          disabled={disabled}
        />
        <TextField
          label="สัดส่วนความกว้างของแต่ละบาน"
          value={form.panelWidths}
          onChange={set('panelWidths')}
          error={errors.panelWidths}
          disabled={disabled}
          placeholder="เว้นว่าง = กว้างเท่ากันทุกบาน"
          description="ตัวเลขเทียบสัดส่วน เช่น 2, 1 คือบานแรกกว้างสองเท่าของบานที่สอง"
        />
        <TextField
          label="บานที่เคลื่อนได้"
          value={form.movingPanels}
          onChange={set('movingPanels')}
          error={errors.movingPanels}
          disabled={disabled}
          placeholder="เว้นว่าง = ทุกบานเคลื่อนได้"
          description="หมายเลขบานนับจาก 1 ทางซ้าย เช่น 1, 3"
        />
      </FieldGroup>

      <div className="flex items-center gap-2">
        <Button
          onClick={() => {
            void submit();
          }}
          disabled={disabled || !dirty}
        >
          <Save data-icon="inline-start" />
          บันทึกลงฉบับร่าง
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            setForm(initial);
            setErrors({});
          }}
          disabled={disabled || !dirty}
        >
          <Undo2 data-icon="inline-start" />
          ย้อนกลับ
        </Button>
        {dirty ? (
          <span className="text-muted-foreground type-caption">
            มีการแก้ไขที่ยังไม่ได้บันทึกลงฉบับร่าง
          </span>
        ) : null}
      </div>
    </div>
  );
}
