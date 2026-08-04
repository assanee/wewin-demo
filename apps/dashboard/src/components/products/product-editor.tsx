'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ArrowLeft, Upload } from 'lucide-react';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table';
import { useSession } from '@/lib/auth/session';

import { openDraft, publishDraft, updateDraft } from './catalog-api';
import { diffDocuments, groupSummary } from './document-diff';
import { FieldsForm } from './fields-form';
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
 */
export function ProductEditorScreen({ productId }: { readonly productId: string }) {
  const { can } = useSession();
  const editor = useProductEditor(productId);
  const [publishing, setPublishing] = useState(false);

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

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <Button asChild variant="ghost" size="sm">
          <Link href="/products">
            <ArrowLeft data-icon="inline-start" />
            สินค้าทั้งหมด
          </Link>
        </Button>
        <h1 className="text-xl font-semibold">{product.nameTh}</h1>
        <Badge variant="outline" className="font-mono">
          {product.skuPrefix}
        </Badge>
        <PublishStateBadges product={product} className="ms-auto" />
      </div>

      {draft === null ? (
        <Card>
          <CardHeader>
            <CardTitle>ยังไม่มีฉบับร่าง</CardTitle>
            <CardDescription>
              เอกสารที่เผยแพร่แล้วแก้ไม่ได้ — การแก้สินค้าคือการเปิดฉบับร่างแล้วเผยแพร่เป็นเวอร์ชันใหม่
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              disabled={!mayWrite || editor.busy}
              onClick={() => {
                void editor.withProduct('เปิดฉบับร่าง', () => openDraft(product.id));
              }}
            >
              เปิดฉบับร่าง
            </Button>
            {mayWrite ? null : (
              <p className="mt-2 text-sm text-muted-foreground">
                บัญชีของคุณไม่มีสิทธิ์แก้ไขแคตตาล็อก
              </p>
            )}
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>ข้อมูลสินค้า</CardTitle>
              <CardDescription>
                ฉบับร่างเวอร์ชัน {draft.version} · แก้ล่าสุด {formatTimestamp(draft.updatedAt)}
              </CardDescription>
            </CardHeader>
            <CardContent>
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
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>ตัวเลือก</CardTitle>
              <CardDescription>
                แก้ตัวเลือกยังทำที่หน้านี้ไม่ได้ — ตารางนี้แสดงสิ่งที่ฉบับร่างถืออยู่
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableBody>
                  {draft.product.groups.map((group) => (
                    <TableRow key={group.code}>
                      <TableCell className="font-medium">{group.labelTh}</TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {group.code}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{groupSummary(group)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>เผยแพร่</CardTitle>
              <CardDescription>
                {diff?.firstPublish
                  ? 'สินค้านี้ยังไม่เคยเผยแพร่ — ทุกอย่างในฉบับร่างจะใหม่สำหรับลูกค้าทั้งหมด'
                  : 'สิ่งที่ลูกค้าจะเห็นเปลี่ยนไปเมื่อเผยแพร่ฉบับร่างนี้'}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {diff === null || diff.changes.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  ฉบับร่างยังเหมือนกับเวอร์ชันที่เผยแพร่อยู่ทุกประการ
                </p>
              ) : (
                <ul className="flex flex-col gap-1 text-sm">
                  {diff.changes.map((change) => (
                    <li key={change.key} className="flex gap-2">
                      <Badge
                        variant={change.kind === 'removed' ? 'destructive' : 'secondary'}
                        className="shrink-0"
                      >
                        {change.kind === 'added' ? 'เพิ่ม' : change.kind === 'removed' ? 'ตัดออก' : 'เปลี่ยน'}
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
                {mayPublish ? null : (
                  <p className="text-sm text-muted-foreground">
                    บัญชีของคุณไม่มีสิทธิ์เผยแพร่
                  </p>
                )}
              </div>

              {product.published === null ? null : (
                <Alert>
                  <AlertTitle>เวอร์ชันที่เผยแพร่อยู่ตอนนี้</AlertTitle>
                  <AlertDescription>
                    เวอร์ชัน {product.published.version} · เผยแพร่เมื่อ{' '}
                    {formatTimestamp(product.published.publishedAt)} — เอกสารนี้แช่แข็งแล้วและจะถูกเก็บเข้าคลังเมื่อเผยแพร่ฉบับร่าง
                  </AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
