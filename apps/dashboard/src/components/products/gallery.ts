/**
 * ⭐ 0052. The rules a gallery follows while somebody is editing it.
 *
 * Pure, and in a `.ts` rather than beside the component, because vitest runs this app with
 * `environment: 'node'` — a test file that imports a `.tsx` is never collected, so logic
 * that lives in a component is logic with no tests. `new-product.ts` and `duplicate-line.ts`
 * are split the same way and for the same reason.
 *
 * ── What the server already guarantees ────────────────────────────────────────────
 *
 * The API refuses a path that does not start with `/`, a list longer than 24, and a video
 * link that is not an http(s) URL. None of that is re-implemented here to be safe — it is
 * re-implemented here to be *legible*: a refusal that arrives as a red box beside the box
 * somebody typed in beats the same refusal arriving as a toast after a round trip. The
 * server stays the authority; this is the sentence.
 */

/** The ceiling the contract enforces (`z.array(...).max(24)`). Kept equal on purpose. */
export const GALLERY_MAX = 24;

export type GalleryEdit =
  | { readonly ok: true; readonly images: readonly string[] }
  | { readonly ok: false; readonly reasonTh: string };

/**
 * Add one picture to the end.
 *
 * ⚠️ A picture already in the gallery is refused rather than added again. The database
 * would accept it — `product_images` is unique on `(product_id, sort_order)`, not on the
 * path — and a storefront gallery that shows the same photograph at positions 2 and 5 reads
 * as a bug in the shop, not as a decision. Refusing it with a sentence is also the only way
 * the person finds out; silently ignoring the click looks like a broken button.
 */
export function addImage(images: readonly string[], path: string): GalleryEdit {
  if (images.includes(path)) return { ok: false, reasonTh: 'รูปนี้อยู่ในแกลเลอรีอยู่แล้ว' };
  if (images.length >= GALLERY_MAX) {
    return { ok: false, reasonTh: `แนบได้สูงสุด ${String(GALLERY_MAX)} รูป` };
  }
  return { ok: true, images: [...images, path] };
}

/** Remove the picture at `index`. Out of range leaves the list alone. */
export function removeImageAt(images: readonly string[], index: number): readonly string[] {
  if (index < 0 || index >= images.length) return images;
  return images.filter((_, at) => at !== index);
}

/**
 * Move one picture one place earlier (`-1`) or later (`+1`).
 *
 * ⚠️ Clamped, never wrapped. Moving the first picture up has to do nothing: a list that
 * wraps would send it to the last position, so the same button would mean "one earlier"
 * most of the time and "all the way to the end" once — and the picture a customer sees
 * first is exactly the one somebody is most likely to click "up" on.
 */
export function moveImage(
  images: readonly string[],
  index: number,
  direction: -1 | 1,
): readonly string[] {
  const target = index + direction;
  if (index < 0 || index >= images.length) return images;
  if (target < 0 || target >= images.length) return images;

  const next = [...images];
  const moved = next[index] as string;
  next[index] = next[target] as string;
  next[target] = moved;
  return next;
}

export type VideoRead =
  | { readonly ok: true; readonly value: string | null }
  | { readonly ok: false; readonly reasonTh: string };

/**
 * The video box as typed → what the wire carries.
 *
 * Empty means `null`, which is how a link is *removed*: the field is nullable precisely so
 * that "no video" is distinguishable from "leave it alone".
 *
 * ⛔ The http(s) check is not tidiness. `javascript:alert(1)` and `data:text/html,…` are
 * both well-formed URLs, this string ends up in an `href` on the storefront, and a publish
 * freezes it into a document that a later fix to this form would never reach. The contract
 * refuses them too — that is the check that counts — and this one exists so the refusal is
 * a sentence in the form rather than a 400 after a save.
 */
export function readVideoUrl(text: string): VideoRead {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: true, value: null };
  if (trimmed.length > 500) return { ok: false, reasonTh: 'ลิงก์ยาวเกิน 500 ตัวอักษร' };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reasonTh: 'กรอกเป็นลิงก์เต็ม เช่น https://www.youtube.com/watch?v=…' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reasonTh: 'รับเฉพาะลิงก์ http หรือ https' };
  }
  return { ok: true, value: trimmed };
}
