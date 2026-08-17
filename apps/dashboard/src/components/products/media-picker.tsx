'use client';

import { useEffect, useRef, useState } from 'react';
import { ImageOff, Upload } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { apiUrl } from '@/lib/api/config';
import { failureMessage } from '@/components/products/catalog-api';
import { listMedia, uploadMedia, type MediaObject } from '@/components/media/media-api';

/**
 * ⭐ 0052. เลือกรูป — the image library, as a dialog, wherever a picture is being chosen.
 *
 * ⚠️ It calls `listMedia` and `uploadMedia` from `components/media/media-api.ts` rather than
 * fetching `/admin/media` itself. Those two already decode the response field by field and
 * already know that an upload is a raw body with the filename in a header, not a multipart
 * form — a second copy of that knowledge here would be a second thing to fix when the
 * upload contract moves.
 *
 * ⚠️ Upload and choose are the same dialog on purpose. Somebody attaching a photograph to a
 * product has the file in their hand; sending them to `/media` to upload it and back here to
 * attach it is two screens for one intention, and the round trip is where the tab with the
 * unsaved draft gets closed.
 *
 * ⛔ It hands back a **path**, never a media id. `schema/media.ts` states the reference
 * between the ledger and the catalogue as exactly one string, `/media/<id>`, and the delete
 * guard greps published documents for that string — so a caller that stored an id instead
 * would be storing something the guard cannot see.
 */
export function MediaPicker({
  titleTh,
  onPick,
  onClose,
}: {
  readonly titleTh: string;
  /**
   * Take this picture. Return the reason it cannot be taken, or `null` to accept.
   *
   * ⛔ The return value exists because the refusal has to be rendered **here**, inside the
   * open dialog. It was first written to `void`, with the caller showing the message in the
   * gallery editor — which is behind this dialog while it is open, so clicking a picture
   * that was already in the gallery did nothing a person could see. A refusal nobody can
   * read is a broken button. Found by clicking it; no node-environment test can see this.
   */
  readonly onPick: (path: string) => string | null;
  readonly onClose: () => void;
}) {
  const [items, setItems] = useState<readonly MediaObject[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    listMedia()
      .then((list) => {
        if (!cancelled) setItems(list.items);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setProblem(failureMessage(cause));
          setItems([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function upload(file: File): Promise<void> {
    setUploading(true);
    setProblem(null);
    try {
      const result = await uploadMedia(file);
      /*
       * The upload answers 200 with somebody else's row when these exact bytes were already
       * stored. Attaching it is still right — it is the same picture — so the only thing
       * that changes is that nothing new was added to the library. It can still be refused:
       * uploading a file that is byte-identical to one already in this gallery lands here.
       */
      const refusal = onPick(result.media.path);
      if (refusal !== null) {
        setProblem(refusal);
        setUploading(false);
      }
    } catch (cause) {
      setProblem(failureMessage(cause));
      setUploading(false);
    }
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{titleTh}</DialogTitle>
          <DialogDescription>
            เลือกจากคลังรูป หรืออัปโหลดไฟล์ใหม่ — รับ JPEG, PNG และ WebP ไม่เกิน 8 MB
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {problem !== null && (
            <Alert variant="destructive">
              <AlertTitle>ทำรายการไม่สำเร็จ</AlertTitle>
              <AlertDescription>{problem}</AlertDescription>
            </Alert>
          )}

          <div>
            <input
              ref={fileInput}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                /* Cleared so choosing the same file twice in a row still fires a change. */
                event.target.value = '';
                if (file) void upload(file);
              }}
            />
            <Button
              variant="outline"
              disabled={uploading}
              onClick={() => fileInput.current?.click()}
            >
              {uploading ? <Spinner /> : <Upload className="size-4" />}
              อัปโหลดรูปใหม่
            </Button>
          </div>

          {items === null ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {Array.from({ length: 8 }, (_, index) => (
                <Skeleton key={index} className="aspect-square w-full" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <div className="text-muted-foreground flex flex-col items-center gap-2 py-10">
              <ImageOff className="size-8" />
              <p className="type-body">ยังไม่มีรูปในคลัง — อัปโหลดรูปแรกได้เลย</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {items.map((media) => (
                <button
                  key={media.id}
                  type="button"
                  onClick={() => {
                    const refusal = onPick(media.path);
                    setProblem(refusal);
                  }}
                  disabled={uploading}
                  className="focus-visible:ring-ring group flex flex-col gap-1 rounded border p-1 text-left hover:border-primary focus-visible:ring-2 focus-visible:outline-none"
                >
                  <span className="bg-muted/30 flex aspect-square items-center justify-center overflow-hidden rounded">
                    {/* eslint-disable-next-line @next/next/no-img-element -- the API is a
                        different origin and these are operator-facing thumbnails. */}
                    <img
                      src={apiUrl(media.path)}
                      alt={media.altTextTh ?? ''}
                      className="size-full object-contain"
                    />
                  </span>
                  <span className="type-caption text-muted-foreground truncate px-1">
                    {media.originalFilename ?? media.id.slice(0, 8)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            ปิด
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
