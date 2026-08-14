'use client';

import Link from 'next/link';
import type { Route } from 'next';
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Search } from 'lucide-react';
import type { AdminProductSummaryWire, CategoryWire } from '@wewin/contract';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

import { failureMessage, listCategories, listProducts } from './catalog-api';
import { PublishStateBadges, formatTimestamp } from './publish-state';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The list. 81 products today; the shape has to survive 800.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Two costs grow with the catalogue and only one of them is this component's to control.
 *
 * **The response.** `GET /admin/catalog/products` has no page parameter — it answers with
 * every product, and its own contract comment explains the one thing it does to keep that
 * affordable: a row carries a `DraftSummaryWire` and not a `DraftWire`, so the server does
 * not compile 81 documents to render a table of names. At 800 products that response is
 * still one request of summaries, which is the right trade for an internal tool; past a few
 * thousand it needs a page parameter, and that is a change to the endpoint rather than to
 * this file. Written down here because the first person to feel it will be reading this.
 *
 * **The DOM.** That one *is* here, and is why the table renders a window rather than the
 * whole filtered set. 800 rows of five cells with three badges each is ~15,000 nodes and a
 * layout pass on every keystroke; 50 rows is a table that stays responsive while somebody
 * types. Filtering runs over the full array — it is a string comparison over a few thousand
 * items and is not what costs anything — so the count line always reports the true total,
 * and the window only decides how much of it is drawn.
 *
 * Search covers the four identifiers a person actually has in hand: the Thai name they read,
 * the id they saw in a URL, the slug from a storefront link, and the SKU prefix off a
 * quote. Matching only the name would fail exactly when somebody is chasing something down.
 *
 * ── ⭐ The route had no name at all, and the list is its own primary thing ────
 *
 * There was **no `<h1>` anywhere on `/products`** — not in the ready state, not in the error
 * one. The screen opened on a search box and three dropdowns, so a reader who had clicked the
 * wrong sidebar entry, or whose fetch had failed, had nothing on the page telling them where
 * they were. `PageHeader` fixes that in all three states.
 *
 * There is deliberately **no `type-focal` statement** here, and that is the house rule for a
 * list screen rather than an omission: the list *is* the primary thing (see the README's table),
 * so the work is taking chrome off it and tightening the rows — the same conclusion
 * `order-list.tsx` and `quote-list.tsx` reached. The count that would otherwise want to be a
 * focal line rides in the header's description, where it qualifies the title instead of
 * competing with the rows.
 */

const PAGE = 50;

/**
 * ⚠️ Rendered in the loading and failure states too, not only once the rows arrived — the rule
 * `page-header.tsx` states, and the one this screen failed hardest. `total` is `null` until the
 * catalogue is in hand, which is why the description has two forms rather than a count of 0.
 */
function Header({ total }: { readonly total: number | null }) {
  return (
    <PageHeader
      title="สินค้า"
      description={
        total === null
          ? 'ทุกสินค้าในแคตตาล็อก ทั้งที่เผยแพร่แล้วและที่ยังเป็นฉบับร่าง'
          : `${total} รายการในแคตตาล็อก ทั้งที่เผยแพร่แล้วและที่ยังเป็นฉบับร่าง`
      }
    />
  );
}

type StateFilter = 'all' | 'draft' | 'unpublished' | 'never' | 'live';

const STATE_LABELS: Record<StateFilter, string> = {
  all: 'ทุกสถานะ',
  draft: 'มีฉบับร่าง',
  unpublished: 'แก้ไขแล้วยังไม่เผยแพร่',
  never: 'ยังไม่เคยเผยแพร่',
  live: 'เผยแพร่แล้ว',
};

const matchesState = (product: AdminProductSummaryWire, filter: StateFilter): boolean => {
  switch (filter) {
    case 'all':
      return true;
    case 'draft':
      return product.draft !== null;
    case 'unpublished':
      return product.unpublishedFields.length > 0;
    case 'never':
      return product.published === null;
    case 'live':
      return product.published !== null;
  }
};

/**
 * Thai sorts by `localeCompare('th')` and not by code point.
 *
 * `'ไม้'.localeCompare('กระจก')` is -1 under a code-point sort and +1 under Thai collation,
 * which is the difference between an alphabetical list and one that only looks alphabetical
 * to somebody who does not read it.
 */
const byName = (left: AdminProductSummaryWire, right: AdminProductSummaryWire): number =>
  left.nameTh.localeCompare(right.nameTh, 'th');

/** Most recently touched first — a draft's edit, else the publish, else nothing. */
const touchedAt = (product: AdminProductSummaryWire): number => {
  const stamp = product.draft?.updatedAt ?? product.published?.publishedAt;
  return stamp === undefined ? 0 : new Date(stamp).getTime();
};

type Sort = 'name' | 'recent';

interface LoadState {
  readonly products: readonly AdminProductSummaryWire[];
  readonly categories: readonly CategoryWire[];
}

export function ProductList() {
  const [loaded, setLoaded] = useState<LoadState | null>(null);
  const [error, setError] = useState<unknown>(null);

  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [state, setState] = useState<StateFilter>('all');
  const [sort, setSort] = useState<Sort>('name');
  const [limit, setLimit] = useState(PAGE);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        /*
         * The category list is a separate request and a failure of it must not blank the
         * table: it names the filter's options, and a product row shows its raw category id
         * perfectly well without one. So both are awaited together and only the product
         * failure is fatal.
         */
        const [products, categories] = await Promise.all([
          listProducts(),
          listCategories().catch(() => [] as readonly CategoryWire[]),
        ]);
        if (!cancelled) setLoaded({ products: products.products, categories });
      } catch (cause: unknown) {
        if (!cancelled) setError(cause);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const categoryLabel = useMemo(() => {
    const names = new Map(loaded?.categories.map((entry) => [entry.id, entry.labelTh]) ?? []);
    return (id: string): string => names.get(id) ?? id;
  }, [loaded]);

  const filtered = useMemo(() => {
    const products = loaded?.products ?? [];
    const needle = query.trim().toLowerCase();

    const matched = products.filter((product) => {
      if (category !== 'all' && product.categoryId !== category) return false;
      if (!matchesState(product, state)) return false;
      if (needle === '') return true;

      return (
        product.nameTh.toLowerCase().includes(needle) ||
        product.id.toLowerCase().includes(needle) ||
        product.slug.toLowerCase().includes(needle) ||
        product.skuPrefix.toLowerCase().includes(needle)
      );
    });

    return [...matched].sort(sort === 'name' ? byName : (left, right) => touchedAt(right) - touchedAt(left));
  }, [loaded, query, category, state, sort]);

  /* A narrowed filter must not leave the window scrolled past its own results. */
  useEffect(() => {
    setLimit(PAGE);
  }, [query, category, state, sort]);

  if (error !== null) {
    return (
      <div className="flex flex-col gap-8">
        <Header total={null} />
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>โหลดรายการสินค้าไม่สำเร็จ</AlertTitle>
          <AlertDescription>{failureMessage(error)}</AlertDescription>
        </Alert>
      </div>
    );
  }

  if (loaded === null) {
    return (
      <div className="flex flex-col gap-8">
        <Header total={null} />
        <div className="flex flex-col gap-2">
          {Array.from({ length: 8 }, (_, index) => (
            <Skeleton key={index} className="h-12 w-full" />
          ))}
        </div>
      </div>
    );
  }

  const shown = filtered.slice(0, limit);
  const categories = [...loaded.categories].sort((left, right) =>
    left.labelTh.localeCompare(right.labelTh, 'th'),
  );

  return (
    <div className="flex flex-col gap-8">
      <Header total={loaded.products.length} />

      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <InputGroup className="w-full sm:w-80">
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
            <InputGroupInput
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
              }}
              placeholder="ค้นหาชื่อ รหัส สลัก หรือคำนำหน้า SKU"
              aria-label="ค้นหาสินค้า"
            />
          </InputGroup>

          <Select
            value={category}
            onValueChange={(value) => {
              setCategory(value);
            }}
          >
            <SelectTrigger className="w-48" aria-label="กรองตามหมวดหมู่">
              <SelectValue placeholder="ทุกหมวดหมู่" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">ทุกหมวดหมู่</SelectItem>
              {categories.map((entry) => (
                <SelectItem key={entry.id} value={entry.id}>
                  {entry.labelTh}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={state}
            onValueChange={(value) => {
              setState(value as StateFilter);
            }}
          >
            <SelectTrigger className="w-56" aria-label="กรองตามสถานะ">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(STATE_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={sort}
            onValueChange={(value) => {
              setSort(value as Sort);
            }}
          >
            <SelectTrigger className="w-40" aria-label="เรียงลำดับ">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="name">เรียงตามชื่อ</SelectItem>
              <SelectItem value="recent">แก้ไขล่าสุดก่อน</SelectItem>
            </SelectContent>
          </Select>

          {/*
          No "new product" action here yet: the create and edit screens are not written.
          Phase 4 ran out of budget partway through and the list is what survives. A
          button pointing at a page that does not exist reads as a bug; its absence reads
          as the gap it is.
        */}
        </div>

        {filtered.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>ไม่พบสินค้าที่ตรงกับเงื่อนไข</EmptyTitle>
              <EmptyDescription>
                ลองล้างคำค้นหรือเปลี่ยนตัวกรอง — แคตตาล็อกมีทั้งหมด {loaded.products.length} รายการ
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            {/*
             * ⚠️ The `rounded-lg border` that used to wrap this table is gone, and it was worse
             * than an ordinary redundant frame: it was a **Card lookalike in a different visual
             * language**. `Card` draws `rounded-xl ring-1 ring-foreground/10`; this drew a
             * `rounded-lg` border. Two boxes meaning the same thing, drawn two ways, on adjacent
             * screens — which is how a reader learns to trust neither. And it was drawn around the
             * one element in the app that already carries a full set of rules.
             */}
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="type-caption h-8">สินค้า</TableHead>
                    <TableHead className="type-caption hidden h-8 md:table-cell">
                      หมวดหมู่
                    </TableHead>
                    <TableHead className="type-caption hidden h-8 lg:table-cell">SKU</TableHead>
                    <TableHead className="type-caption h-8">สถานะ</TableHead>
                    {/* Slack to the last column — see `order-list.tsx`. ⚠️ This one is
                      `lg:table-cell`, so below `lg` the slack falls back to สถานะ on its own,
                      which is the narrow layout the columns were chosen for anyway. */}
                    <TableHead className="type-caption hidden h-8 w-full lg:table-cell">
                      อัปเดตล่าสุด
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shown.map((product) => (
                    <TableRow key={product.id}>
                      <TableCell className="px-2 py-1.5">
                        {/*
                        The link is on the name rather than on the row: a whole-row click
                        target cannot be reached by keyboard without inventing a role for a
                        `<tr>`, and a table of 50 unreachable rows is a table nobody can use
                        without a mouse.
                      */}
                        <Link
                          href={`/products/${product.id}` as Route}
                          className="focus-visible:outline-ring type-body rounded font-medium underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
                        >
                          {product.nameTh}
                        </Link>
                        <div className="text-muted-foreground type-caption">{product.id}</div>
                      </TableCell>
                      <TableCell className="text-muted-foreground type-body hidden px-2 py-1.5 md:table-cell">
                        {categoryLabel(product.categoryId)}
                      </TableCell>
                      <TableCell className="text-muted-foreground type-caption hidden px-2 py-1.5 font-mono lg:table-cell">
                        {product.skuPrefix}
                      </TableCell>
                      <TableCell className="px-2 py-1.5">
                        <PublishStateBadges product={product} />
                      </TableCell>
                      <TableCell className="text-muted-foreground type-caption hidden px-2 py-1.5 lg:table-cell">
                        {product.draft !== null
                          ? formatTimestamp(product.draft.updatedAt)
                          : product.published !== null
                            ? formatTimestamp(product.published.publishedAt)
                            : '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <div className="flex items-center gap-3">
              <p className="text-muted-foreground type-caption">
                แสดง {shown.length} จาก {filtered.length} รายการ
                {filtered.length === loaded.products.length
                  ? ''
                  : ` (ทั้งหมด ${loaded.products.length})`}
              </p>
              {shown.length < filtered.length ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setLimit((current) => current + PAGE);
                  }}
                >
                  แสดงเพิ่ม {Math.min(PAGE, filtered.length - shown.length)} รายการ
                </Button>
              ) : null}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
