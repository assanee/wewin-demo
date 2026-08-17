'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Plus } from 'lucide-react';
import type { AdminOptionGroupWire, AdminProductSummaryWire, ProductWire } from '@wewin/contract';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import { FieldGroup, FieldSeparator } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';

import {
  createProduct,
  failureMessage,
  getProduct,
  getPublishedDocumentOf,
  listCategories,
  listOptionGroups,
  listProducts,
} from './catalog-api';
import { SelectField, TextField } from './form-field';
import {
  ProductFieldsFieldset,
  blankFormState,
  validateFields,
  type Errors,
  type FormState,
  type StringField,
  type ValidatedFields,
} from './fields-form';
import { MediaPicker } from './media-picker';
import { createRequestFrom, identityProblems } from './new-product';
import { OptionSelectionEditor } from './option-selection-editor';
import { blankChoice, buildOptions, type GroupChoice, type OptionErrors } from './option-selection';

/**
 * ⭐ เพิ่มสินค้า — one screen, two ways in.
 *
 * ── Why this is a page and not the dialog it replaces ────────────────────────────
 *
 * The copy flow fitted in a modal because it asked four questions. Creating a product from
 * nothing asks for eight product fields, an elevation, a gallery and a whole option set —
 * around thirty controls, several of which are lists. A modal that scrolls for three screens
 * is a page wearing a mask, and it cannot be linked to, reloaded, or opened in a tab.
 *
 * ── Why the copy mode survives ───────────────────────────────────────────────────
 *
 * ⚠️ It is genuinely the faster path and it always was: most new products in this catalogue
 * are a variant of an existing one — `บานเลื่อน แบ่ง 4` beside `บานเลื่อน แบ่ง 3` — and
 * copying gets the option set, the rules and the price right by construction. Removing it to
 * celebrate the new path would make the common case slower to serve the rare one.
 *
 * ⛔ What it could not do is start a catalogue. The source list is filtered to products that
 * have a published version or a draft, so on an empty database the picker is empty and the
 * only screen that creates products creates nothing. That is why "สร้างใหม่ทั้งหมด" is the
 * default mode when there is nothing to copy from.
 */

type Mode = 'copy' | 'blank';

interface Loaded {
  readonly products: readonly AdminProductSummaryWire[];
  readonly categories: readonly { readonly id: string; readonly labelTh: string }[];
  readonly groups: readonly AdminOptionGroupWire[];
}

export function CreateProductScreen() {
  const router = useRouter();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadProblem, setLoadProblem] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([listProducts(), listCategories(), listOptionGroups()])
      .then(([products, categories, groups]) => {
        if (cancelled) return;
        setLoaded({
          products: products.products,
          /* `listCategories` answers a bare array, not an envelope. */
          categories: categories.map((entry) => ({ id: entry.id, labelTh: entry.labelTh })),
          groups: groups.groups,
        });
      })
      .catch((cause: unknown) => {
        if (!cancelled) setLoadProblem(failureMessage(cause));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loadProblem !== null) {
    return (
      <Alert variant="destructive">
        <AlertTriangle className="size-4" />
        <AlertTitle>เปิดหน้านี้ไม่สำเร็จ</AlertTitle>
        <AlertDescription>{loadProblem}</AlertDescription>
      </Alert>
    );
  }

  if (loaded === null) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-72 w-full" />
      </div>
    );
  }

  return <CreateForm loaded={loaded} onCreated={(id) => router.push(`/products/${id}`)} />;
}

function CreateForm({
  loaded,
  onCreated,
}: {
  readonly loaded: Loaded;
  readonly onCreated: (productId: string) => void;
}) {
  const copyable = loaded.products.filter(
    (product) => product.published !== null || product.draft !== null,
  );

  /*
   * ⚠️ The default is chosen by what is possible, not by preference. With nothing to copy
   * from, opening on the copy mode would show an empty picker and a dead button — the exact
   * trap that made a fresh catalogue uncreatable.
   */
  const [mode, setMode] = useState<Mode>(copyable.length > 0 ? 'copy' : 'blank');

  const [id, setId] = useState('');
  const [form, setForm] = useState<FormState>(blankFormState);
  const [errors, setErrors] = useState<Errors>({});
  /* Per-box refusals for the option groups — see `OptionSelectionEditor`. */
  const [optionErrors, setOptionErrors] = useState<OptionErrors>({});
  const [choices, setChoices] = useState<readonly GroupChoice[]>(() =>
    loaded.groups.map((group) => ({
      ...blankChoice(group),
      /* width and height are not optional — see `OptionSelectionEditor`. */
      offered: group.code === 'width' || group.code === 'height',
    })),
  );

  const [sourceId, setSourceId] = useState('');
  const [source, setSource] = useState<ProductWire | null>(null);
  const [loadingSource, setLoadingSource] = useState(false);

  const [pickingHero, setPickingHero] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const setField = (key: StringField) => (value: string) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const identity = { id, slug: form.slug, skuPrefix: form.skuPrefix, nameTh: form.nameTh };
  const idProblems = identityProblems(identity, loaded.products);

  async function chooseSource(nextId: string): Promise<void> {
    setSourceId(nextId);
    setSource(null);
    setProblem(null);
    if (nextId === '') return;

    const row = loaded.products.find((product) => product.id === nextId);
    if (row === undefined) return;

    setLoadingSource(true);
    try {
      /*
       * The published document when there is one, the draft otherwise — copying a draft
       * would propagate a half-finished change into a second product, so the published
       * version wins whenever it exists.
       */
      const published = await getPublishedDocumentOf(row.id, row.slug);
      setSource(published !== null ? published.product : ((await getProduct(row.id)).draft?.product ?? null));
    } catch (cause) {
      setProblem(failureMessage(cause));
    } finally {
      setLoadingSource(false);
    }
  }

  async function submit(): Promise<void> {
    setProblem(null);

    if (mode === 'copy') {
      if (source === null) return;
      await send(createRequestFrom(source, identity));
      return;
    }

    /*
     * Both halves are validated before either is sent, so a person with a bad price and a
     * bad size range sees both — rather than fixing one and being told about the other.
     */
    const validated = validateFields(form);
    const built = buildOptions(choices, loaded.groups);

    setErrors(isValidated(validated) ? {} : validated);
    /*
     * ⚠️ Cleared on every attempt, not merged. A box that was fixed must stop being red the
     * moment it is fixed and resubmitted — errors that outlive their cause are the reason
     * people stop reading them.
     */
    setOptionErrors(built.ok ? {} : built.errors);

    if (!isValidated(validated) || !built.ok) {
      if (!built.ok) setProblem(built.problems.join(' · '));
      return;
    }

    await send({
      id: id.trim(),
      slug: validated.slug,
      skuPrefix: validated.skuPrefix,
      fields: validated.fields,
      options: built.options,
    });
  }

  async function send(request: Parameters<typeof createProduct>[0]): Promise<void> {
    setBusy(true);
    try {
      await createProduct(request);
      onCreated(request.id);
    } catch (cause) {
      setProblem(failureMessage(cause));
      setBusy(false);
    }
  }

  const ready =
    idProblems.length === 0 && (mode === 'copy' ? source !== null : id.trim() !== '');

  return (
    <div className="flex flex-col gap-6">
      <FieldGroup className="grid gap-4 md:grid-cols-2">
        <SelectField
          label="วิธีสร้าง"
          value={mode}
          onChange={(next) => setMode(next === 'blank' ? 'blank' : 'copy')}
          options={[
            {
              value: 'copy',
              labelTh:
                copyable.length > 0
                  ? 'คัดลอกจากสินค้าที่มีอยู่ — เร็วกว่าเมื่อเป็นรุ่นใกล้เคียงกัน'
                  : 'คัดลอกจากสินค้าที่มีอยู่ (ยังไม่มีสินค้าให้คัดลอก)',
            },
            { value: 'blank', labelTh: 'สร้างใหม่ทั้งหมด — กรอกทุกอย่างเอง' },
          ]}
          disabled={busy}
          description={
            mode === 'copy'
              ? 'หมวดหมู่ ชุดตัวเลือก ขนาด ราคา และกฎ จะถูกคัดลอกมาให้ แล้วแก้ต่อในฉบับร่างได้'
              : 'ทุกอย่างกรอกเอง รวมถึงชุดตัวเลือกและช่วงขนาด'
          }
        />
        {mode === 'copy' && (
          <SelectField
            label="เริ่มจากสินค้า"
            value={sourceId}
            onChange={(next) => void chooseSource(next)}
            options={copyable.map((product) => ({
              value: product.id,
              labelTh: `${product.nameTh} · ${product.id}`,
            }))}
            disabled={busy || copyable.length === 0}
            description={
              copyable.length === 0
                ? 'ยังไม่มีสินค้าที่เผยแพร่หรือมีฉบับร่าง — ใช้ "สร้างใหม่ทั้งหมด"'
                : 'เลือกตัวที่รูปทรงและชุดตัวเลือกใกล้เคียงที่สุด'
            }
          />
        )}
      </FieldGroup>

      <FieldSeparator />

      <FieldGroup className="grid gap-4 md:grid-cols-2">
        <TextField
          label="รหัสสินค้า"
          value={id}
          onChange={setId}
          disabled={busy}
          mono
          description="ตัวพิมพ์เล็ก ตัวเลข และขีดกลาง เช่น lvr-hang-double — เปลี่ยนภายหลังไม่ได้"
        />
        <TextField
          label="สลัก (slug)"
          value={form.slug}
          onChange={setField('slug')}
          disabled={busy}
          mono
          description="ส่วนท้ายของลิงก์หน้าสินค้าที่ลูกค้าเห็น"
        />
        <TextField
          label="คำนำหน้า SKU"
          value={form.skuPrefix}
          onChange={setField('skuPrefix')}
          disabled={busy}
          mono
          description="ตัวพิมพ์ใหญ่และตัวเลข — ประกอบเป็นรหัส SKU ที่พิมพ์บนใบเสนอราคา"
        />
        <TextField
          label="ชื่อสินค้า"
          value={form.nameTh}
          onChange={setField('nameTh')}
          disabled={busy}
        />
      </FieldGroup>

      {idProblems.length > 0 && started(identity) && (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertTitle>ยังสร้างไม่ได้</AlertTitle>
          <AlertDescription>
            <ul className="flex list-disc flex-col gap-1 pl-4">
              {idProblems.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {mode === 'blank' && (
        <>
          <FieldSeparator />
          <ProductFieldsFieldset
            form={form}
            errors={errors}
            categories={loaded.categories}
            disabled={busy}
            onField={setField}
            onImages={(next) => setForm((current) => ({ ...current, images: next }))}
            onPickHero={() => setPickingHero(true)}
            /* ชื่อ · สลัก · คำนำหน้า SKU are asked for above, beside the product id. */
            omitIdentity
          />

          <FieldSeparator />

          <div className="flex flex-col gap-2">
            <h2 className="type-heading">ชุดตัวเลือก</h2>
            <p className="text-muted-foreground type-body">
              เลือกจากคลังที่ใช้ร่วมกันทุกสินค้า — ความกว้างและความสูงบังคับ เพราะระบบคิดราคาจากสองค่านี้
            </p>
          </div>
          <OptionSelectionEditor
            groups={loaded.groups}
            choices={choices}
            errors={optionErrors}
            disabled={busy}
            onChange={(code, next) =>
              setChoices((current) =>
                current.map((choice) => (choice.code === code ? { ...choice, ...next } : choice)),
              )
            }
          />
        </>
      )}

      {problem !== null && (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertTitle>สร้างสินค้าไม่สำเร็จ</AlertTitle>
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      )}

      <div className="flex items-center gap-2">
        <Button onClick={() => void submit()} disabled={!ready || busy || loadingSource}>
          {busy ? <Spinner /> : <Plus data-icon="inline-start" />}
          สร้างเป็นฉบับร่าง
        </Button>
        <span className="text-muted-foreground type-caption">
          สินค้าใหม่เริ่มเป็นฉบับร่างเสมอ — ลูกค้าจะยังไม่เห็นจนกว่าจะกดเผยแพร่
        </span>
      </div>

      {pickingHero && (
        <MediaPicker
          titleTh="เลือกรูปหลัก"
          onClose={() => setPickingHero(false)}
          onPick={(path) => {
            setField('heroImage')(path);
            setPickingHero(false);
            return null;
          }}
        />
      )}
    </div>
  );
}

const isValidated = (result: ValidatedFields | Errors): result is ValidatedFields =>
  'fields' in result;

/** Nothing is shouted about until somebody has started — an empty form is not a wrong one. */
const started = (identity: { readonly id: string; readonly slug: string; readonly skuPrefix: string; readonly nameTh: string }): boolean =>
  identity.id !== '' || identity.slug !== '' || identity.skuPrefix !== '' || identity.nameTh !== '';
