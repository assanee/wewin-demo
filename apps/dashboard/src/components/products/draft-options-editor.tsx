'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, Save, Undo2 } from 'lucide-react';
import type { AdminOptionGroupWire, ProductWire } from '@wewin/contract';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

import { failureMessage, deleteOption, listOptionGroups, putOption } from './catalog-api';
import { OptionSelectionEditor } from './option-selection-editor';
import {
  buildOptions,
  choicesFromProduct,
  optionWrites,
  type GroupChoice,
  type OptionErrors,
} from './option-selection';

/**
 * ⭐ ตัวเลือก on a draft — editable, at last.
 *
 * `PUT …/draft/options/:code` and `DELETE …/draft/options/:code` have existed since the admin
 * surface did, and until now **no screen called either**: the product editor rendered a
 * read-only table saying "แก้ตัวเลือกยังทำที่หน้านี้ไม่ได้". The option groups a product was
 * born with were the ones it kept for ever, which also made the create screen's choices
 * permanent in a way nobody was told about.
 *
 * ── One editor, two screens ─────────────────────────────────────────────────────
 *
 * The control is `OptionSelectionEditor`, the same component the create screen uses, and the
 * rules are the same `buildOptions` — including the eight grid rules the server answers with
 * one sentence, and the per-box red marks. A second editor here would be a second set of
 * rules to keep in step with Postgres.
 *
 * ── A save is a sequence, and that is a real property ───────────────────────────
 *
 * ⚠️ There is no batch endpoint. Each write carries the `documentHash` it expects and returns
 * the next one, so a save is a chain — and **a failure halfway leaves the earlier writes
 * applied**. That is not hidden: the draft is reloaded either way, so the screen shows what
 * actually landed rather than what was attempted, and the message names the group that
 * stopped it.
 *
 * The alternative — a batch endpoint that applies all or nothing — is the better design and
 * is a change to the API, not to this screen. Named here rather than approximated with a
 * client-side rollback, which would be a second sequence of writes that can also fail.
 */
export function DraftOptionsEditor({
  product,
  disabled,
  onSave,
}: {
  readonly product: ProductWire;
  readonly disabled: boolean;
  /**
   * Runs the whole chain inside the editor's own draft guard. The callback is handed the
   * hash to start from and must return the hash it ended on.
   */
  readonly onSave: (run: (expectedDocumentHash: string) => Promise<unknown>) => Promise<boolean>;
}) {
  const [catalogue, setCatalogue] = useState<readonly AdminOptionGroupWire[] | null>(null);
  const [loadProblem, setLoadProblem] = useState<string | null>(null);
  const [choices, setChoices] = useState<readonly GroupChoice[] | null>(null);
  const [errors, setErrors] = useState<OptionErrors>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listOptionGroups()
      .then((list) => {
        if (!cancelled) setCatalogue(list.groups);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setLoadProblem(failureMessage(cause));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /*
   * ⚠️ Re-seeded whenever the draft's own groups change — which is what happens after a save
   * reloads it. Keyed on the value rather than reset by an effect, the same shape
   * `FieldsForm` uses: an effect would run a render later and briefly show the pre-save
   * state as if the save had not happened.
   */
  const seed = catalogue === null ? null : choicesFromProduct(product.groups, catalogue);
  const [seededFrom, setSeededFrom] = useState<string | null>(null);
  const fingerprint = catalogue === null ? null : JSON.stringify(product.groups.map((g) => g.code));
  if (seed !== null && fingerprint !== seededFrom) {
    setSeededFrom(fingerprint);
    setChoices(seed);
    setErrors({});
  }

  if (loadProblem !== null) {
    return (
      <Alert variant="destructive">
        <AlertTriangle className="size-4" />
        <AlertTitle>โหลดคลังชุดตัวเลือกไม่สำเร็จ</AlertTitle>
        <AlertDescription>{loadProblem}</AlertDescription>
      </Alert>
    );
  }

  if (catalogue === null || choices === null) {
    return <Skeleton className="h-48 w-full" />;
  }

  const built = buildOptions(choices, catalogue);
  const writes = built.ok ? optionWrites(product.groups, built.options) : [];
  const dirty = !built.ok || writes.length > 0;

  async function save(): Promise<void> {
    setProblem(null);
    if (!built.ok) {
      setErrors(built.errors);
      setProblem(built.problems.join(' · '));
      return;
    }
    setErrors({});
    if (writes.length === 0) return;

    setBusy(true);
    const ok = await onSave(async (expectedDocumentHash) => {
      /*
       * The chain. Each write answers with the draft it produced, and its hash is what the
       * next write must present — the first one uses the hash the guard handed in.
       */
      let hash = expectedDocumentHash;
      for (const write of writes) {
        const draft =
          write.kind === 'put'
            ? await putOption(product.id, write.code, hash, write.option)
            : await deleteOption(product.id, write.code, hash);
        hash = draft.documentHash;
      }
    });
    setBusy(false);
    if (!ok) {
      /* `onSave` has already shown why. Nothing to add, and a second message would compete. */
      return;
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {problem !== null && (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertTitle>บันทึกชุดตัวเลือกไม่ได้</AlertTitle>
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      )}

      <OptionSelectionEditor
        groups={catalogue}
        choices={choices}
        errors={errors}
        disabled={disabled || busy}
        onChange={(code, next) =>
          setChoices((current) =>
            (current ?? []).map((choice) => (choice.code === code ? { ...choice, ...next } : choice)),
          )
        }
      />

      <div className="flex items-center gap-2">
        <Button onClick={() => void save()} disabled={disabled || busy || !dirty}>
          {busy ? <Spinner /> : <Save data-icon="inline-start" />}
          บันทึกชุดตัวเลือก
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            setChoices(seed);
            setErrors({});
            setProblem(null);
          }}
          disabled={disabled || busy || !dirty}
        >
          <Undo2 data-icon="inline-start" />
          ย้อนกลับ
        </Button>
        {dirty && (
          <span className="text-muted-foreground type-caption">
            {built.ok
              ? `มีการแก้ไข ${String(writes.length)} กลุ่มที่ยังไม่ได้บันทึก`
              : 'มีการแก้ไขที่ยังไม่ได้บันทึก'}
          </span>
        )}
      </div>
    </div>
  );
}
