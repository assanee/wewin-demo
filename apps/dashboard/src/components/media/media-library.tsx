'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Copy, ImageOff, ShieldCheck, Trash2, Upload } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Spinner } from '@/components/ui/spinner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { apiUrl } from '@/lib/api/config';
import { useSession } from '@/lib/auth/session';
import { failureMessage } from '@/components/products/catalog-api';

import {
  deleteMedia,
  listMedia,
  updateMediaAltText,
  uploadMedia,
  type MediaObject,
  type MediaUploadResult,
} from './media-api';
import { mediaFocus } from './media-focus';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The image library, and the two facts about an image that are easy to hide.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * **What was stripped.** The API removes Exif, XMP, `tEXt` and trailing bytes, and reports
 * which of them it found. The contract's own comment says the dashboard shows this, and the
 * reason is worth restating: *"we strip EXIF"* is a claim that is either true of the file
 * somebody just uploaded or it is not, and this list is the only occasion anybody ever finds
 * out which. A photograph of a factory has a GPS tag in it; so does a photograph taken in
 * somebody's house.
 *
 * **What cites it.** `usage.frozen` non-empty means a published version's document points at
 * these bytes, and that document is what a customer was shown. The delete button is not
 * offered, and the versions are named — "cannot delete" without saying what is holding it is
 * an instruction to go looking through 81 products.
 *
 * ── Why the whole object is rendered rather than a thumbnail grid ────────────────
 *
 * Because the decisions this screen supports are about *bytes*: is this the right file, is
 * it big enough, is anything using it, can it go. A grid of pictures answers the first
 * question and hides the other three.
 *
 * ── ⭐ One primary thing, and the rows stopped being hand-rolled cards ────────
 *
 * There was no `Card` on this screen and it read as though there were: `MediaRow` returned a
 * `rounded-lg border p-4` box per item, which is a Card in a **different visual language** —
 * `Card` draws `rounded-xl` with `ring-1 ring-foreground/10`, so the library's boxes did not
 * match a single other bordered thing in the app while still filling the page with boxes.
 *
 * ⚠️ **And because there was no `Card`, these rows never inherited its `text-sm`.** Every
 * unclassed string here rendered at the browser's 16px while every other screen in the dashboard
 * rendered its body at 14px — the row title was a bare `font-medium` and came out *larger than
 * the section headings on `/orders`*. That is the same 16px collision the type scale was built
 * to delete, arriving by inheritance rather than by choice. Everything is on `type-body` /
 * `type-caption` now, so the size is stated rather than borrowed.
 *
 * The boxes became one `divide-y` list, and `mediaFocus` states the library's condition at
 * `type-focal` above it. The `Empty` block went with them: its sentence is the empty case of
 * that same statement, and it was a dashed box drawn around the absence of anything.
 *
 * ⚠️ **The citation line moved to the top of each row.** It was rendered muted, last, under the
 * alt-text box — and it is the fact that decides whether ลบ is offered at all. The answer to
 * *can it go* should not be below the thing you would have to scroll past to look for it.
 */

type State =
  | { readonly status: 'loading' }
  | { readonly status: 'failed'; readonly message: string }
  | {
      readonly status: 'ready';
      readonly items: readonly MediaObject[];
      readonly nextCursor: string | null;
    };

/** Bytes as a person reads them. Binary units, because that is what the ceiling is in. */
function bytes(size: number): string {
  if (size < 1024) return `${String(size)} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function MediaLibrary() {
  const { can } = useSession();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [uploading, setUploading] = useState(false);
  const [lastUpload, setLastUpload] = useState<MediaUploadResult | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const editable = can('catalog.write');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const page = await listMedia();
        if (!cancelled) {
          setState({ status: 'ready', items: page.items, nextCursor: page.nextCursor });
        }
      } catch (cause) {
        if (!cancelled) setState({ status: 'failed', message: failureMessage(cause) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function loadMore(): Promise<void> {
    if (state.status !== 'ready' || state.nextCursor === null) return;
    try {
      const page = await listMedia(state.nextCursor);
      setState({
        status: 'ready',
        items: [...state.items, ...page.items],
        nextCursor: page.nextCursor,
      });
    } catch (cause) {
      setProblem(failureMessage(cause));
    }
  }

  async function onFiles(files: FileList | null): Promise<void> {
    const file = files?.[0];
    if (file === undefined) return;

    setUploading(true);
    setProblem(null);
    setLastUpload(null);
    try {
      const result = await uploadMedia(file);
      setLastUpload(result);
      setState((current) =>
        current.status !== 'ready'
          ? current
          : {
              ...current,
              /*
               * A duplicate returns the *existing* row, so prepending it blindly would show
               * the same object twice. Replaced when it is already in the list, prepended
               * when it is not — either way the person sees the object their upload
               * produced, at the top.
               */
              items: [result.media, ...current.items.filter((item) => item.id !== result.media.id)],
            },
      );
    } catch (cause) {
      setProblem(failureMessage(cause));
    } finally {
      setUploading(false);
      if (fileInput.current !== null) fileInput.current.value = '';
    }
  }

  function replace(updated: MediaObject): void {
    setState((current) =>
      current.status !== 'ready'
        ? current
        : {
            ...current,
            items: current.items.map((item) => (item.id === updated.id ? updated : item)),
          },
    );
  }

  function remove(mediaId: string): void {
    setState((current) =>
      current.status !== 'ready'
        ? current
        : { ...current, items: current.items.filter((item) => item.id !== mediaId) },
    );
  }

  const focus =
    state.status === 'ready' ? mediaFocus(state.items, state.nextCursor !== null) : null;

  return (
    <div className="flex flex-col gap-6">
      {/*
       * ⭐ THE PRIMARY THING. On the page ground, no border, type doing the work.
       *
       * Only once the list has arrived: a count stated while the request is in flight is a claim
       * about a library nothing has looked at yet.
       */}
      {focus !== null && (
        <section className="flex flex-col gap-1">
          <p className="type-focal text-balance">{focus.headlineTh}</p>
          {focus.detailTh === null ? null : (
            <p className="text-muted-foreground type-body max-w-2xl">{focus.detailTh}</p>
          )}
        </section>
      )}

      {editable && (
        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={fileInput}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={(event) => void onFiles(event.target.files)}
          />
          <Button onClick={() => fileInput.current?.click()} disabled={uploading}>
            {uploading ? <Spinner /> : <Upload className="size-4" />}
            อัปโหลดรูป
          </Button>
          <p className="text-muted-foreground type-body">JPEG · PNG · WebP — สูงสุด 8 MB ต่อไฟล์</p>
        </div>
      )}

      {problem !== null && (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertTitle>ทำรายการไม่สำเร็จ</AlertTitle>
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      )}

      {lastUpload !== null && <UploadReport result={lastUpload} />}

      {state.status === 'loading' && (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      )}

      {state.status === 'failed' && (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertTitle>โหลดคลังรูปภาพไม่สำเร็จ</AlertTitle>
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      )}

      {/*
       * ⚠️ The `Empty` block that used to stand here is gone rather than restyled. Its title and
       * its description are now the empty branch of `mediaFocus` — one sentence in one place,
       * on the page ground, instead of the same sentence inside a dashed rectangle drawn around
       * nothing.
       */}
      {state.status === 'ready' && state.items.length > 0 && (
        <ul className="divide-border/60 flex flex-col divide-y">
          {state.items.map((item) => (
            <li key={item.id} className="py-5 first:pt-0 last:pb-0">
              <MediaRow
                media={item}
                editable={editable}
                onChanged={replace}
                onDeleted={() => remove(item.id)}
                onProblem={setProblem}
              />
            </li>
          ))}
        </ul>
      )}

      {state.status === 'ready' && state.nextCursor !== null && (
        <div>
          <Button variant="outline" onClick={() => void loadMore()}>
            โหลดเพิ่ม
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * What the upload actually did.
 *
 * Shown once, after the upload, rather than folded into the row — because both facts are
 * about *this* upload and neither is a property of the stored object. The row will look
 * identical whether the file arrived carrying a GPS tag or not.
 */
function UploadReport({ result }: { readonly result: MediaUploadResult }) {
  return (
    <Alert>
      <ShieldCheck className="size-4" />
      <AlertTitle>
        {result.deduplicated ? 'ไฟล์นี้มีอยู่แล้วในคลัง' : 'อัปโหลดสำเร็จ'}
      </AlertTitle>
      <AlertDescription>
        <div className="flex flex-col gap-1">
          {result.deduplicated && (
            <span>
              ไบต์ชุดนี้เคยถูกอัปโหลดมาก่อน ระบบจึงคืนรูปเดิมให้ —
              คำบรรยายและชื่อไฟล์ที่เห็นเป็นของคนที่อัปโหลดครั้งแรก ไม่ใช่ของไฟล์ที่เพิ่งเลือก
            </span>
          )}
          {result.stripped.length > 0 ? (
            <span>
              ลบข้อมูลแฝงออกแล้ว: <strong>{result.stripped.join(' · ')}</strong>
              {' — '}
              ข้อมูลเหล่านี้อาจมีพิกัดสถานที่ถ่ายและรุ่นกล้องติดมาด้วย
            </span>
          ) : (
            <span>ไฟล์นี้ไม่มีข้อมูลแฝงติดมา จึงไม่มีอะไรถูกลบออก</span>
          )}
        </div>
      </AlertDescription>
    </Alert>
  );
}

function MediaRow({
  media,
  editable,
  onChanged,
  onDeleted,
  onProblem,
}: {
  readonly media: MediaObject;
  readonly editable: boolean;
  readonly onChanged: (updated: MediaObject) => void;
  readonly onDeleted: () => void;
  readonly onProblem: (message: string) => void;
}) {
  const [altText, setAltText] = useState(media.altTextTh ?? '');
  const [savingAlt, setSavingAlt] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [copied, setCopied] = useState(false);

  const frozen = media.usage.frozen;
  const drafts = media.usage.drafts;
  const dirty = altText.trim() !== (media.altTextTh ?? '');

  async function saveAlt(): Promise<void> {
    setSavingAlt(true);
    try {
      // `null` and not `''` when it is cleared: the column is nullable and the schema takes
      // `string | null`, so an empty string would store an alt text that is present and blank
      // — which a screen reader announces as an image with no description *twice*.
      onChanged(await updateMediaAltText(media.id, altText.trim() === '' ? null : altText.trim()));
    } catch (cause) {
      onProblem(failureMessage(cause));
    } finally {
      setSavingAlt(false);
    }
  }

  async function destroy(): Promise<void> {
    setDeleting(true);
    try {
      await deleteMedia(media.id);
      onDeleted();
    } catch (cause) {
      onProblem(failureMessage(cause));
      setDeleting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4 md:flex-row">
      <div className="bg-muted/30 flex size-40 shrink-0 items-center justify-center overflow-hidden rounded">
        {/* eslint-disable-next-line @next/next/no-img-element -- the API is a different
            origin and these are operator-facing thumbnails, not the storefront's LCP. */}
        <img
          src={apiUrl(media.path)}
          alt={media.altTextTh ?? ''}
          className="size-full object-contain"
        />
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="type-body truncate font-medium">
              {media.originalFilename ?? '(ไม่มีชื่อไฟล์)'}
            </span>
            <Badge variant="outline">{media.contentType.replace('image/', '')}</Badge>
            <Badge variant="outline">
              {media.width} × {media.height}
            </Badge>
            <Badge variant="outline">{bytes(media.byteSize)}</Badge>
          </div>

          {/*
           * ⭐ Directly under the filename, because this is the line that answers *can it go* —
           * and `frozen` decides whether the delete button is rendered at all. It used to be the
           * last thing in the row, muted, below a textarea: a reader deciding whether to delete
           * a file had to scroll past the alt-text editor to find out that they could not.
           */}
          {(frozen.length > 0 || drafts.length > 0) && (
            <div className="text-muted-foreground type-caption flex flex-col gap-0.5">
              {frozen.length > 0 && (
                <span>
                  ถูกอ้างอิงในเวอร์ชันที่เผยแพร่แล้ว:{' '}
                  {frozen.map((reference) => `${reference.productNameTh} v${reference.version}`).join(' · ')}
                </span>
              )}
              {drafts.length > 0 && (
                <span>
                  อยู่ในฉบับร่างของ: {drafts.map((reference) => reference.productNameTh).join(' · ')}
                </span>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="type-body" htmlFor={`alt-${media.id}`}>
            คำบรรยายภาพ (alt)
          </label>
          <Textarea
            id={`alt-${media.id}`}
            value={altText}
            onChange={(event) => setAltText(event.target.value)}
            disabled={!editable || savingAlt}
            rows={2}
            placeholder="อธิบายสิ่งที่อยู่ในภาพ สำหรับคนที่มองไม่เห็น"
          />
          {editable && dirty && (
            <div>
              <Button size="sm" onClick={() => void saveAlt()} disabled={savingAlt}>
                {savingAlt && <Spinner />}
                บันทึกคำบรรยาย
              </Button>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void navigator.clipboard?.writeText(media.path).then(() => setCopied(true));
            }}
          >
            <Copy className="size-4" />
            {copied ? 'คัดลอกแล้ว' : 'คัดลอก path'}
          </Button>
          <code className="text-muted-foreground type-caption truncate">{media.path}</code>
        </div>
      </div>

      {editable && (
        <div className="flex shrink-0 flex-col items-end justify-start gap-2">
          {frozen.length > 0 ? (
            /*
             * ⚠️ Not a disabled button with a tooltip. The reason is a *fact about the
             * catalogue* — a customer was shown this picture and the company has to be able
             * to reproduce what they were shown — and a greyed-out button says "you lack
             * permission", which is a different and wrong answer.
             */
            <div className="text-muted-foreground type-body flex items-center gap-1.5">
              <ImageOff className="size-4" />
              ลบไม่ได้ — มีเวอร์ชันที่เผยแพร่แล้วอ้างอิงอยู่
            </div>
          ) : (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => void destroy()}
              disabled={deleting}
            >
              {deleting ? <Spinner /> : <Trash2 className="size-4" />}
              ลบ
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
