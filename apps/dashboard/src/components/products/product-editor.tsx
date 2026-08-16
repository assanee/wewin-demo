'use client';

import { useState } from 'react';
import { AlertTriangle, ExternalLink, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { PageHeader } from '@/components/page-header';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { useSession } from '@/lib/auth/session';
import { storefrontProductUrl } from '@/lib/api/config';

import { discardDraft, openDraft, publishDraft, updateDraft } from './catalog-api';
import { diffDocuments } from './document-diff';
import { FieldsForm } from './fields-form';
import { DraftOptionsEditor } from './draft-options-editor';
import { publishFocus } from './publish-focus';
import { PublishStateBadges, formatTimestamp } from './publish-state';
import { useProductEditor } from './use-product';

/**
 * The screen the rest of this folder was written for.
 *
 * Editing a product here is never editing what customers see. A published document is
 * frozen in Postgres — a trigger refuses to update one — so the shape of the work is:
 * open a draft, change the draft, publish it, and the previous version is archived. That
 * is not an implementation detail to hide behind a Save button, it is the thing a person
 * has to understand to use this screen without surprising themselves, so the draft and
 * the published version are shown side by side and publishing is its own deliberate act.
 *
 * ── ⭐ The title was a chip, and the answer was buried three Cards down ───────
 *
 * The product's name was an `<h1 className="text-xl font-semibold">` sitting **inside** a
 * `flex flex-wrap items-center gap-3` toolbar, between a ghost back-button and two Badges. At
 * 20px in a row of controls it read as one more chip rather than as the name of the record —
 * the reader's eye had nothing to anchor on, which is precisely what `PageHeader` exists to
 * fix. The back-link, the SKU and the state badges are all still here; they are now `back` and
 * `meta`, which is what they always were.
 *
 * `mono={false}` — the default, and stated in the header's own contract: an order number is a
 * machine string and reads as one, a Thai product name is not.
 *
 * ── ⭐ One primary thing, and three Cards became three sections ──────────────
 *
 * The screen rendered **three `<Card>`s** whenever a draft existed (ข้อมูลสินค้า / ตัวเลือก /
 * เผยแพร่), each with the same ring and each headed at `text-base` above `text-sm` body copy —
 * a 2px step, which is the absence of a hierarchy rather than a weak one. None of the three
 * survives the house rule:
 *
 *   **ข้อมูลสินค้า** is a form. Nobody reads it detached from this screen, and the heading plus
 *   `gap-10` already separates it from what follows.
 *   **ตัวเลือก** is a `<Table>` — the one case the rule names outright. A table already draws a
 *   full set of rules; a ring around it is an edge around an edge.
 *   **เผยแพร่** is an *act*, not a reference. Its diff list and its button do not need a border
 *   to be told apart from the form above them; they need a heading, which they now have.
 *
 * What replaces them at the top is `publishFocus` — whether what you changed is live yet, which
 * is the question somebody opened this screen to answer.
 */
export function ProductEditorScreen({ productId }: { readonly productId: string }) {
  const { can } = useSession();
  const editor = useProductEditor(productId);
  const [publishing, setPublishing] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);

  if (editor.state.status === 'loading') {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (editor.state.status === 'error') {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>เปิดสินค้านี้ไม่ได้</EmptyTitle>
          <EmptyDescription>
            {editor.state.error instanceof Error
              ? editor.state.error.message
              : 'ไม่ทราบสาเหตุ ลองใหม่อีกครั้ง'}
          </EmptyDescription>
        </EmptyHeader>
        <Button variant="outline" onClick={editor.reload}>
          ลองอีกครั้ง
        </Button>
      </Empty>
    );
  }

  const { product, publishedDocument } = editor.state.resource;
  const { draft } = product;
  const mayWrite = can('catalog.write');
  const mayPublish = can('catalog.publish');

  /*
   * The diff is computed against the published document rather than against the draft's
   * own history. What matters to whoever presses publish is not what they typed, it is
   * what a customer will see change.
   */
  const diff = draft === null ? null : diffDocuments(publishedDocument, draft.product);

  /*
   * ⚠️ The **published** slug, not the draft's. Editing the slug in a draft does not move the
   * customer's URL until it is published, so linking to the draft's would send somebody to a
   * 404 and let them conclude the product had vanished.
   */
  const storefrontUrl = storefrontProductUrl(publishedDocument?.slug ?? product.slug);

  const focus = publishFocus({
    publishedVersion: product.published?.version ?? null,
    draftVersion: draft?.version ?? null,
    draftChangeCount: diff === null ? null : diff.changes.length,
    unpublishedFieldCount: product.unpublishedFields.length,
  });

  return (
    <div className="flex flex-col gap-10">
      <PageHeader
        title={product.nameTh}
        back={{ href: '/products', label: 'สินค้าทั้งหมด' }}
        meta={
          <>
            <Badge variant="outline" className="font-mono">
              {product.skuPrefix}
            </Badge>
            <PublishStateBadges product={product} />
            {/*
              ⭐ The link to what a customer actually sees.
              ⚠️ Only when a version is published — before that there is no page to open, and
              a link that 404s reads as a broken publish rather than as "not published yet".
              ⛔ Built from the **slug**, never from the id in this page's own URL: they are
              different strings, and the pair that prompted this were `uoio` here and
              `sdfghjkl` there.
            */}
            {product.published !== null && storefrontUrl !== null && (
              <a
                href={storefrontUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="text-muted-foreground type-caption inline-flex items-center gap-1 hover:underline"
              >
                <ExternalLink className="size-3.5" />
                ดูหน้าร้าน
              </a>
            )}
          </>
        }
      />

      {/*
       * ⭐ THE PRIMARY THING: is what I changed live yet. On the page ground, no border.
       *
       * It sits above everything, including the "no draft" branch — a product whose live version
       * has drifted from its `products` row has something pending whether or not a draft is open,
       * and that state used to be visible only as a red badge in the header.
       */}
      <section className="flex flex-col gap-1">
        <p className="type-focal text-balance">{focus.headlineTh}</p>
        {focus.detailTh === null ? null : (
          <p className="text-muted-foreground type-body">{focus.detailTh}</p>
        )}
      </section>

      {draft === null ? (
        <Section
          title="เปิดฉบับร่าง"
          descriptionTh="เอกสารที่เผยแพร่แล้วแก้ไม่ได้ — การแก้สินค้าคือการเปิดฉบับร่างแล้วเผยแพร่เป็นเวอร์ชันใหม่"
        >
          <div className="flex flex-col gap-2">
            <div>
              <Button
                disabled={!mayWrite || editor.busy}
                onClick={() => {
                  void editor.withProduct('เปิดฉบับร่าง', () => openDraft(product.id));
                }}
              >
                เปิดฉบับร่าง
              </Button>
            </div>
            {mayWrite ? null : (
              <p className="text-muted-foreground type-body">บัญชีของคุณไม่มีสิทธิ์แก้ไขแคตตาล็อก</p>
            )}
          </div>
        </Section>
      ) : (
        <>
          <Section
            title="ข้อมูลสินค้า"
            descriptionTh={`ฉบับร่างเวอร์ชัน ${draft.version} · แก้ล่าสุด ${formatTimestamp(draft.updatedAt)}`}
          >
            <FieldsForm
              product={draft.product}
              categories={editor.reference?.categories ?? []}
              disabled={!mayWrite || editor.busy}
              onSave={(validated) =>
                editor.withDraft('บันทึกข้อมูลสินค้า', (expectedDocumentHash) =>
                  updateDraft(product.id, expectedDocumentHash, {
                    slug: validated.slug,
                    skuPrefix: validated.skuPrefix,
                    fields: validated.fields,
                  }),
                )
              }
            />
          </Section>

          <Section
            title="ตัวเลือก"
            descriptionTh="เลือกกลุ่มจากคลังที่ใช้ร่วมกันทุกสินค้า — ความกว้างและความสูงบังคับ เพราะระบบคิดราคาจากสองค่านี้"
          >
            {/*
              ⭐ Editable since the endpoints that back it finally have a caller. The read-only
              table this replaces said "แก้ตัวเลือกยังทำที่หน้านี้ไม่ได้", which meant the groups a
              product was born with were the ones it kept for ever.
            */}
            <DraftOptionsEditor
              product={draft.product}
              disabled={editor.busy}
              onSave={(run) => editor.withDraft('บันทึกชุดตัวเลือก', run)}
            />
          </Section>

          <Section
            title="เผยแพร่"
            descriptionTh={
              diff?.firstPublish
                ? 'สินค้านี้ยังไม่เคยเผยแพร่ — ทุกอย่างในฉบับร่างจะใหม่สำหรับลูกค้าทั้งหมด'
                : 'สิ่งที่ลูกค้าจะเห็นเปลี่ยนไปเมื่อเผยแพร่ฉบับร่างนี้'
            }
          >
            <div className="flex flex-col gap-4">
              {diff === null || diff.changes.length === 0 ? (
                <p className="text-muted-foreground type-body">
                  ฉบับร่างยังเหมือนกับเวอร์ชันที่เผยแพร่อยู่ทุกประการ
                </p>
              ) : (
                <ul className="type-body flex flex-col gap-1">
                  {diff.changes.map((change) => (
                    <li key={change.key} className="flex gap-2">
                      <Badge
                        variant={change.kind === 'removed' ? 'destructive' : 'secondary'}
                        className="shrink-0"
                      >
                        {change.kind === 'added'
                          ? 'เพิ่ม'
                          : change.kind === 'removed'
                            ? 'ตัดออก'
                            : 'เปลี่ยน'}
                      </Badge>
                      <span>
                        {change.labelTh}
                        {change.beforeTh === null || change.afterTh === null ? null : (
                          <span className="text-muted-foreground">
                            {' '}
                            — {change.beforeTh} → {change.afterTh}
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              <Separator />

              {/*
                Publishing carries the draft's version id AND its document hash. Either
                alone is not enough: the id catches someone else opening a new draft in
                between, and the hash catches the case where the id still matches because
                they edited this same draft while this screen was open.
              */}
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  disabled={!mayPublish || editor.busy || publishing}
                  onClick={() => {
                    setPublishing(true);
                    void editor
                      .withProduct('เผยแพร่', () =>
                        publishDraft(product.id, draft.productVersionId, draft.documentHash),
                      )
                      .then((ok) => {
                        if (ok) toast.success('เผยแพร่แล้ว — ลูกค้าเห็นเวอร์ชันนี้ตั้งแต่ตอนนี้');
                      })
                      .finally(() => setPublishing(false));
                  }}
                >
                  <Upload data-icon="inline-start" />
                  เผยแพร่เวอร์ชัน {draft.version}
                </Button>
                {/*
                  ⚠️ **ทิ้งฉบับร่าง had no button, and that was not a missing convenience.**
                  `DELETE …/draft` and `discardDraft` both existed with no caller, so a draft
                  whose changes turned out to be wrong could only be escaped by publishing
                  them — the one move somebody had already decided against.

                  ⚠️ Offered only when there is a published version to fall back to, because
                  the API refuses it otherwise: `catalog-admin.service.ts:349-352` throws
                  "ทิ้งร่างนี้ไม่ได้ เพราะสินค้ายังไม่เคยเผยแพร่ — สินค้าจะเหลือสถานะที่แก้ไขต่อไม่ได้".
                  Discarding the only version a product has ever had would leave a row nothing
                  can edit and nothing can serve. Rendering the button anyway and letting the
                  server say no would be a button that is never right to press — found by
                  pressing it.

                  Beside `เผยแพร่` rather than hidden in a menu, because these are the two
                  answers to the same question, and destructive is not the same as rare.
                */}
                {product.published !== null && (
                  <Button
                    variant="outline"
                    disabled={!mayWrite || editor.busy || publishing || discarding}
                    onClick={() => setConfirmingDiscard(true)}
                  >
                    <Trash2 data-icon="inline-start" />
                    ทิ้งฉบับร่าง
                  </Button>
                )}
                {product.published === null && (
                  /*
                    Absent buttons are the quiet version of the defect this round has been
                    clearing out, so the reason is said rather than left to be inferred from
                    a gap where a button is on every other product.
                  */
                  <p className="text-muted-foreground type-body">
                    ทิ้งฉบับร่างไม่ได้จนกว่าจะเผยแพร่ครั้งแรก — ร่างนี้เป็นเวอร์ชันเดียวที่สินค้านี้มี
                  </p>
                )}
                {mayPublish ? null : (
                  <p className="text-muted-foreground type-body">บัญชีของคุณไม่มีสิทธิ์เผยแพร่</p>
                )}
              </div>

              {confirmingDiscard && (
                <Dialog open onOpenChange={(next) => !next && setConfirmingDiscard(false)}>
                  <DialogContent className="sm:max-w-lg">
                    <DialogHeader>
                      <DialogTitle>ทิ้งฉบับร่างเวอร์ชัน {draft.version}?</DialogTitle>
                      <DialogDescription>
                        ลูกค้ายังเห็นเวอร์ชัน {product.published?.version} เหมือนเดิม —
                        ทิ้งเฉพาะสิ่งที่แก้ไว้ในร่างนี้
                      </DialogDescription>
                    </DialogHeader>

                    <Alert variant="destructive">
                      <AlertTriangle className="size-4" />
                      <AlertTitle>สิ่งที่แก้ไว้ในร่างนี้จะหายไปทั้งหมด</AlertTitle>
                      <AlertDescription>
                        ย้อนกลับไม่ได้ · เปิดร่างใหม่ได้ทันทีหลังจากนี้
                      </AlertDescription>
                    </Alert>

                    <DialogFooter>
                      <Button
                        variant="ghost"
                        onClick={() => setConfirmingDiscard(false)}
                        disabled={discarding}
                      >
                        เก็บร่างไว้
                      </Button>
                      <Button
                        variant="destructive"
                        disabled={discarding}
                        onClick={() => {
                          setDiscarding(true);
                          void editor
                            .withProduct('ทิ้งฉบับร่าง', () =>
                              discardDraft(product.id, draft.documentHash),
                            )
                            .then((ok) => {
                              if (ok) {
                                setConfirmingDiscard(false);
                                toast.success('ทิ้งฉบับร่างแล้ว — เปิดร่างใหม่ได้');
                              }
                            })
                            .finally(() => setDiscarding(false));
                        }}
                      >
                        ทิ้งฉบับร่าง
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              )}

              {product.published === null ? null : (
                <Alert>
                  <AlertTitle>เวอร์ชันที่เผยแพร่อยู่ตอนนี้</AlertTitle>
                  <AlertDescription>
                    เวอร์ชัน {product.published.version} · เผยแพร่เมื่อ{' '}
                    {formatTimestamp(product.published.publishedAt)} —
                    เอกสารนี้แช่แข็งแล้วและจะถูกเก็บเข้าคลังเมื่อเผยแพร่ฉบับร่าง
                  </AlertDescription>
                </Alert>
              )}
            </div>
          </Section>
        </>
      )}
    </div>
  );
}

/**
 * One band of the editor.
 *
 * The three that used to be Cards are these now — a `<section>` with a `type-section` heading
 * and `gap-10` above it, the same shape `account-settings.tsx` arrived at for the same reason:
 * everything on this page is one subject, read top to bottom, and a ring around each band was
 * three statements that they might be confused for one another.
 *
 * ⚠️ `descriptionTh` is `type-body`, not the `text-sm` `CardDescription` it replaces. Same size,
 * but named — so the next person applying this scale does not have to know that `text-sm`
 * happened to be the body step.
 */
function Section({
  title,
  descriptionTh,
  children,
}: {
  readonly title: string;
  readonly descriptionTh: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="type-section">{title}</h2>
        <p className="text-muted-foreground type-body max-w-2xl">{descriptionTh}</p>
      </div>
      {children}
    </section>
  );
}
