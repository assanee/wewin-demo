import { CircleDot, FileEdit, Lock, PencilLine } from 'lucide-react';
import type { AdminProductSummaryWire, AdminProductWire } from '@wewin/contract';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

import { fieldLabel } from './document-diff';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The one vocabulary for "live" and "not live", used by every screen that shows either.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The brief asks for the difference between saved and published to be impossible to miss.
 * The way to fail at that is not to omit it — it is to say it three slightly different ways
 * on three screens, so that a person learns three shapes and trusts none of them. So the
 * words, the icons and the colours live here, and the list, the header and the publish
 * dialog all render the same component.
 *
 * Three facts, and they are independent — a product can be in any combination of them:
 *
 *   **เผยแพร่แล้ว v3** — a frozen document exists and customers are being quoted from it.
 *     A lock, because it cannot be edited: changing it means publishing a v4.
 *   **ฉบับร่าง v4** — an editable version exists. It is what every write on these screens
 *     goes to, and no customer can see any part of it.
 *   **แก้ไขแล้วยังไม่เผยแพร่** — the product's own row (name, price, lead time…) has moved
 *     away from the frozen copy. This one exists because the `products` row is *not*
 *     versioned: an edit to `pricePerSqm` is stored the moment it is made while quotes keep
 *     coming from the frozen figure, and that is correct and completely invisible unless
 *     something says so. `unpublishedFields` is the server telling us which ones.
 *
 * `variant="default"` is not used for any of them. shadcn's default badge is `bg-primary`,
 * and plan 8.5's warning about the lime accent generalises: if the primary colour is what
 * every state looks like, no state stands out. Live is `secondary` (settled), draft is
 * `outline` (in progress), unpublished is `destructive` (needs a decision).
 */

const dateTime = new Intl.DateTimeFormat('th-TH', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

/** An ISO timestamp as a Thai date. Invalid input renders as itself rather than "Invalid Date". */
export function formatTimestamp(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : dateTime.format(at);
}

type ProductState = AdminProductWire | AdminProductSummaryWire;

export function PublishedBadge({ product }: { readonly product: ProductState }) {
  if (product.published === null) {
    return (
      <Badge variant="outline" className="text-muted-foreground">
        <CircleDot data-icon="inline-start" />
        ยังไม่เคยเผยแพร่
      </Badge>
    );
  }

  return (
    <Badge variant="secondary" title={`เผยแพร่เมื่อ ${formatTimestamp(product.published.publishedAt)}`}>
      <Lock data-icon="inline-start" />
      เผยแพร่แล้ว v{product.published.version}
    </Badge>
  );
}

export function DraftBadge({ product }: { readonly product: ProductState }) {
  if (product.draft === null) return null;

  return (
    <Badge variant="outline" title={`แก้ไขล่าสุด ${formatTimestamp(product.draft.updatedAt)}`}>
      <FileEdit data-icon="inline-start" />
      ฉบับร่าง v{product.draft.version}
    </Badge>
  );
}

/**
 * The product-level fields that are saved but not live.
 *
 * The names are spelled out in the tooltip rather than only counted, because "3 รายการ" is
 * a number somebody has to open a screen to interpret and "ราคาต่อตารางเมตร" is the one
 * that makes them open it.
 */
export function UnpublishedFieldsBadge({ product }: { readonly product: ProductState }) {
  if (product.unpublishedFields.length === 0) return null;

  const names = product.unpublishedFields.map(fieldLabel);

  return (
    <Badge variant="destructive" title={`แก้ไขแล้วยังไม่เผยแพร่: ${names.join(', ')}`}>
      <PencilLine data-icon="inline-start" />
      แก้ไขแล้วยังไม่เผยแพร่ {names.length} รายการ
    </Badge>
  );
}

export function PublishStateBadges({
  product,
  className,
}: {
  readonly product: ProductState;
  readonly className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)}>
      <PublishedBadge product={product} />
      <DraftBadge product={product} />
      <UnpublishedFieldsBadge product={product} />
    </div>
  );
}
