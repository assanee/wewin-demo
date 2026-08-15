'use client';

import { useState } from 'react';
import { ArrowDown, ArrowUp, ImagePlus, Trash2 } from 'lucide-react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { apiUrl } from '@/lib/api/config';

import { GALLERY_MAX, addImage, moveImage, removeImageAt } from './gallery';
import { MediaPicker } from './media-picker';

/**
 * ⭐ 0052. รูปสินค้า — the gallery, in the order a customer will see it.
 *
 * `gallery.ts` holds every rule this component obeys and the argument for each; this file is
 * the arrangement of buttons around them.
 *
 * ⚠️ **Position 1 is labelled, and the labelling is the feature.** The order is content —
 * `documentHash` moves when it changes, and the storefront shows the first picture first —
 * so a list that merely happened to be in some order would leave the most consequential
 * property of this field invisible. Up/down beat drag-and-drop here for the same reason they
 * beat it in a settings screen: there are at most 24 rows, and a keyboard reaches buttons.
 *
 * ⚠️ The video is not in this list, even though the storefront shows it first. It is one
 * link and not a picture, it cannot be reordered against the pictures, and showing it as
 * row 0 of a list whose rows have up/down arrows would promise a rearrangement that does not
 * exist. It sits above the list, where the sentence can say where it will appear.
 */
export function GalleryEditor({
  images,
  videoUrl,
  videoError,
  disabled,
  onImages,
  onVideoUrl,
}: {
  readonly images: readonly string[];
  readonly videoUrl: string;
  readonly videoError: string | undefined;
  readonly disabled: boolean;
  readonly onImages: (next: readonly string[]) => void;
  readonly onVideoUrl: (next: string) => void;
}) {
  const [picking, setPicking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <span className="type-body font-medium">รูปสินค้า</span>
        <span className="type-caption text-muted-foreground">
          ลำดับคือสิ่งที่ลูกค้าเห็น — รูปที่ 1 คือรูปแรกในหน้าสินค้า
          {videoUrl.trim() !== '' && ' (วิดีโอจะมาก่อนรูปทั้งหมด)'}
        </span>
      </div>

      {problem !== null && (
        <Alert variant="destructive">
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      )}

      {images.length === 0 ? (
        <p className="text-muted-foreground type-body border-dashed border py-6 text-center">
          ยังไม่มีรูป — หน้าสินค้าจะแสดงเฉพาะรูปหลัก
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {images.map((path, index) => (
            <li key={path} className="flex items-center gap-3 rounded border p-2">
              <span className="type-caption text-muted-foreground w-6 shrink-0 text-center tabular-nums">
                {index + 1}
              </span>
              <span className="bg-muted/30 flex size-16 shrink-0 items-center justify-center overflow-hidden rounded">
                {/* eslint-disable-next-line @next/next/no-img-element -- the API is a
                    different origin and these are operator-facing thumbnails. */}
                <img src={apiUrl(path)} alt="" className="size-full object-contain" />
              </span>
              <span className="type-caption text-muted-foreground min-w-0 flex-1 truncate">
                {path}
              </span>

              <Button
                variant="ghost"
                size="icon"
                aria-label={`ย้ายรูปที่ ${String(index + 1)} ขึ้น`}
                disabled={disabled || index === 0}
                onClick={() => onImages(moveImage(images, index, -1))}
              >
                <ArrowUp className="size-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`ย้ายรูปที่ ${String(index + 1)} ลง`}
                disabled={disabled || index === images.length - 1}
                onClick={() => onImages(moveImage(images, index, 1))}
              >
                <ArrowDown className="size-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`เอารูปที่ ${String(index + 1)} ออก`}
                disabled={disabled}
                onClick={() => {
                  setProblem(null);
                  onImages(removeImageAt(images, index));
                }}
              >
                <Trash2 className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div>
        <Button
          variant="outline"
          disabled={disabled || images.length >= GALLERY_MAX}
          onClick={() => {
            setProblem(null);
            setPicking(true);
          }}
        >
          <ImagePlus data-icon="inline-start" />
          เพิ่มรูป
        </Button>
        {images.length >= GALLERY_MAX && (
          <span className="text-muted-foreground type-caption ml-3">
            ครบ {GALLERY_MAX} รูปแล้ว
          </span>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <label className="type-body font-medium" htmlFor="product-video-url">
          วิดีโอ (ไม่บังคับ)
        </label>
        <span className="type-caption text-muted-foreground">
          ลิงก์ YouTube หรือ Vimeo หนึ่งลิงก์ — จะแสดงเป็นลำดับแรกก่อนรูปทั้งหมด
          ลบลิงก์ออกเพื่อเอาวิดีโอออก
        </span>
        <input
          id="product-video-url"
          type="url"
          inputMode="url"
          value={videoUrl}
          disabled={disabled}
          onChange={(event) => onVideoUrl(event.target.value)}
          placeholder="https://www.youtube.com/watch?v=…"
          className="border-input focus-visible:ring-ring h-11 rounded-md border px-3 focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50"
          aria-invalid={videoError !== undefined}
        />
        {videoError !== undefined && (
          <span className="text-destructive type-caption">{videoError}</span>
        )}
      </div>

      {picking && (
        <MediaPicker
          titleTh="เพิ่มรูปสินค้า"
          onClose={() => setPicking(false)}
          onPick={(path) => {
            const result = addImage(images, path);
            if (!result.ok) {
              setProblem(result.reasonTh);
              return;
            }
            setProblem(null);
            onImages(result.images);
            setPicking(false);
          }}
        />
      )}
    </div>
  );
}
