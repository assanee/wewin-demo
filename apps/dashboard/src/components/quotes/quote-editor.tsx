'use client';

import Link from 'next/link';
import type { Route } from 'next';
import { useState } from 'react';
import { Printer, ShieldCheck } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PageHeader } from '@/components/page-header';
import { useSession } from '@/lib/auth/session';

import { AuthorityPanel } from './authority-panel';
import { CustomerDocument } from './customer-document';
import { LineTable } from './line-table';
import { OverrideDialog } from './override-dialog';
import { ProvenanceLegend } from './provenance';
import {
  ConflictBanner,
  IntegrityAlarms,
  StaleBaselineBanner,
  UnrecognisedDestinationBanner,
} from './quote-alerts';
import { failureMessage, verifyQuote } from './quote-api';
import { hasHumanFigures } from './quote-model';
import { TotalsCard } from './totals-card';
import { useQuoteEditor } from './use-quote';
import type { OverrideContext } from './override-entry';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The screen the whole feature is for.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The owner's fourth decision was *"the quotation step must be editable in every value"*, and
 * the trade it forced is written at the top of plan 7.9: the old mitigation — the API
 * recomputes and 409s on mismatch — is gone, because a correct total no longer has a
 * computable definition. What replaces it is provenance, and provenance is only a control if
 * somebody can **see** it. That is this screen's whole job.
 *
 * ### Two surfaces, deliberately not one with a toggle
 *
 * The editing tab shows every figure with its origin: the machine's number struck through
 * beside the human's, who set it, what they typed and why. The document tab shows what the
 * customer sees, which has none of that in it. They are separate components with separate
 * headers rather than one component with a `readOnly` prop, because the day somebody adds a
 * field the wrong default would put an internal negotiation onto a customer's PDF.
 *
 * ### What is not on this screen, and where it went
 *
 * No approve button — the decider is a different person on a different screen, which is what
 * the two-person rule in `approvals` means and what plan 7.13 warns against multiplying. No
 * VAT-amount box — derived, never entered (plan 4.4). No price recomputation — the API
 * computes, always, and the only number this client sends is the characters a person typed.
 * No way to move a sku or a product version — a different product is a different line.
 *
 * And no submit button: freezing the document is an order transition, not a quote write, and
 * it lives on the order screen. What is here is the **verification** the submit will perform
 * anyway — ⚠️ which is a courtesy and not a gate, because a catalogue publish can land in the
 * seconds between the two, and a gate a client may decline to call is not a gate.
 */
export function QuoteEditorScreen({ orderId }: { readonly orderId: string }) {
  const { can } = useSession();
  const editor = useQuoteEditor(orderId);
  const [pricing, setPricing] = useState<{
    readonly context: OverrideContext;
    readonly subjectTh: string;
  } | null>(null);

  if (editor.state.status === 'loading') {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (editor.state.status === 'error') {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>เปิดใบเสนอราคานี้ไม่ได้</EmptyTitle>
          <EmptyDescription>{failureMessage(editor.state.error)}</EmptyDescription>
        </EmptyHeader>
        <Button variant="outline" onClick={editor.reload}>
          ลองอีกครั้ง
        </Button>
      </Empty>
    );
  }

  const { view } = editor.state;
  const mayWrite = can('quotes.write');
  const overridden = view.lines.filter((line) => line.provenance.kind === 'overridden').length;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="ใบเสนอราคา"
        back={{ href: '/quotes', label: 'ใบเสนอราคาทั้งหมด' }}
        meta={
          <>
            <Badge
              variant="outline"
              className="type-caption font-mono"
              title="โทเคนของฉบับที่กำลังแก้อยู่"
            >
              {view.wire.quoteRevision}
            </Badge>
            {overridden === 0 ? null : (
              <Badge title="จำนวนบรรทัดที่มีคนตั้งราคาทับค่าที่คำนวณได้">
                แก้ราคาแล้ว {overridden} บรรทัด
              </Badge>
            )}
            {view.staleLines.length === 0 ? null : (
              <Badge variant="destructive">ต้องยืนยันราคา {view.staleLines.length} บรรทัด</Badge>
            )}
            {view.unrecognisedDestination === null ? null : (
              /* In the strip as well as the banner below — not because either is pinned in place:
                 nothing in this dashboard is `sticky` or `fixed`, so both scroll away together
                 with the rest of the page. It sits here for the same reason the other summary
                 badges do (the revision token, "แก้ราคาแล้ว", "ต้องยืนยันราคา") — visible at a
                 glance beside them, not because it survives scrolling that they do not. */
              <Badge
                variant="destructive"
                title="ยอดที่แสดงคิดจากอัตราภาษีเริ่มต้น ไม่ใช่ของประเทศปลายทางนี้"
              >
                ประเทศปลายทาง &quot;{view.unrecognisedDestination}&quot; ไม่มีในระบบ
              </Badge>
            )}
          </>
        }
        actions={
          /*
           * ⚠️ Prints the **pinned** document, not what is on this screen.
           *
           * The two differ the moment somebody edits, and that is the point:
           * `printable-quotation.ts` refuses an order with no pinned document, because before
           * submit there is no quotation — there is a cart, and on paper they look the same.
           */
          <Button asChild variant="outline" size="sm">
            <Link href={`/quotes/${orderId}/print` as Route}>
              <Printer data-icon="inline-start" />
              พิมพ์ / PDF
            </Link>
          </Button>
        }
      />

      {/*
       * ─────────────────────────────────────────────────────────────────────────
       * ⚠️ There is deliberately NO `type-focal` block on this screen. It had one; it is gone.
       * ─────────────────────────────────────────────────────────────────────────
       *
       * Phase 1 opened this screen with the grand total at 24px, and I flagged it in my own
       * report as the weakest result of the five: on a one-line quote the same figure appeared
       * twice inside a single viewport — here, and as `TotalsCard`'s headline row 400px below,
       * under the identical label ยอดรวมสุทธิ (รวม VAT).
       *
       * Eleven more screens settled it. **Every focal statement that works in this app is a
       * derived judgement that cannot be read anywhere else on its screen** — ภาพรวม's
       * "13 รายการรอดำเนินการ", an order's "รอชำระเงิน · ทำต่อได้ 2 อย่าง", /account's identity
       * and its ways-in count. The quote's total was the one exception: a raw figure repeated
       * from a component whose entire job is to show it, with a *breakdown* underneath that the
       * summary could not add anything to. That is duplication wearing a focal point's clothes.
       *
       * What replaces it is not nothing. **The primary thing on this screen is the line table** —
       * it is what you opened the editor to change — and the precedent for that is already set
       * on /orders, /quotes and /products: on a screen whose subject is a list, the list *is*
       * the emphasis, and it earns that by being the first un-chromed thing under the header
       * rather than by having a sentence announce it.
       *
       * The state that *is* a judgement still leads, in the header's `meta` badges above: the
       * revision token, how many lines a human priced, how many need re-confirming, and an
       * unrecognised destination. Those say things the table cannot. The verdict on whether the
       * quote can be sent stays with the banners and ตรวจก่อนส่ง — one assertion of one gate,
       * which is what this file's own comments have asked for from the start.
       */}

      {editor.conflict === null ? null : (
        <ConflictBanner
          conflict={editor.conflict}
          onDismiss={editor.dismissConflict}
          onReload={editor.reload}
        />
      )}
      {/* First of the three, because it is the only one that says the quote cannot be sent
          *at all* — the others are about lines to re-confirm on a quote that otherwise can. */}
      <UnrecognisedDestinationBanner view={view} />
      <StaleBaselineBanner view={view} />
      <IntegrityAlarms alarms={view.alarms} />

      {/* `gap-6`: the root's own `gap-2` left the first section heading crammed under the tabs. */}
      <Tabs defaultValue="edit" className="gap-6">
        <TabsList>
          <TabsTrigger value="edit">แก้ไขใบเสนอราคา</TabsTrigger>
          <TabsTrigger value="document">ใบที่ลูกค้าเห็น</TabsTrigger>
        </TabsList>

        <TabsContent value="edit" className="flex flex-col gap-8">
          {/*
           * De-carded. `LineTable` is a `<Table>`, which is already a grid of rules — the Card
           * put a ring around a thing that draws its own edges. What the section needs is a
           * heading and the sentence explaining the provenance notation, not a border.
           */}
          <section className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <h2 className="type-section">รายการ</h2>
              <p className="text-muted-foreground type-body max-w-2xl">
                {!view.showsProvenance
                  ? 'บัญชีของคุณเห็นเฉพาะยอดที่ถูกเสนอ ไม่เห็นที่มาของตัวเลข'
                  : hasHumanFigures(view)
                    ? 'ตัวเลขที่มีกรอบทึบคือตัวเลขที่คนตั้ง ตัวเลขธรรมดาคือตัวเลขที่ระบบคำนวณ'
                    : 'ยังไม่มีใครแก้ตัวเลขในใบนี้ — ทุกยอดมาจากการคำนวณ'}
              </p>
            </div>
            {view.showsProvenance ? <ProvenanceLegend /> : null}
            <LineTable
              orderId={orderId}
              lines={view.lines}
              busy={editor.busy}
              mayWrite={mayWrite && view.showsProvenance}
              onWrite={editor.write}
              onOverride={(context, subjectTh) => setPricing({ context, subjectTh })}
            />
          </section>

          <TotalsCard
            view={view}
            orderId={orderId}
            busy={editor.busy}
            mayWrite={mayWrite}
            onWrite={editor.write}
            onOverride={(context, subjectTh) => setPricing({ context, subjectTh })}
          />

          {view.showsProvenance ? (
            <AuthorityPanel
              orderId={orderId}
              reloadKey={view.wire.quoteRevision}
              mayWrite={mayWrite}
            />
          ) : null}

          {/*
           * De-carded. A heading, a paragraph and one button do not need separating from the
           * page — there is nothing here that could be confused with its neighbour.
           */}
          <section className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <h2 className="type-section">ตรวจก่อนส่ง</h2>
              <p className="text-muted-foreground type-body max-w-2xl">
                ตรวจว่าราคาฐานของทุกการแก้ราคายังตรงกับที่บันทึกไว้ — เป็นการตรวจชุดเดียวกับที่ระบบทำตอนยืนยันการชำระเงิน
                และ<strong className="font-semibold">ไม่ได้แทนการตรวจตอนนั้น</strong>{' '}
                เพราะแคตตาล็อกเปลี่ยนระหว่างสองจังหวะได้
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <Button
                variant="outline"
                className="self-start"
                disabled={!mayWrite || editor.busy}
                onClick={() => {
                  void editor.write('ราคาทุกบรรทัดยังตรงกับที่ตกลงไว้', (expect) =>
                    verifyQuote(orderId, expect),
                  );
                }}
              >
                <ShieldCheck data-icon="inline-start" />
                ตรวจราคาที่ตกลงไว้
              </Button>
              {view.hasStaleBaselines ? (
                <p className="text-destructive type-body">
                  ยังส่งใบนี้ไม่ได้ — มี {view.staleLines.length} บรรทัดที่ต้องยืนยันราคาก่อน
                </p>
              ) : null}
              {/*
                The other reason a send is refused — a concession over the ceiling — is stated
                by the authority panel above and not repeated here. Two components asserting the
                same gate is how they end up disagreeing after one of them is edited.
              */}
              {mayWrite ? null : (
                <p className="text-muted-foreground type-body">บัญชีของคุณไม่มีสิทธิ์แก้ใบเสนอราคา</p>
              )}
            </div>
          </section>
        </TabsContent>

        <TabsContent value="document">
          <CustomerDocument view={view} />
        </TabsContent>
      </Tabs>

      {pricing === null ? null : (
        <OverrideDialog
          open
          onOpenChange={(open) => {
            if (!open) setPricing(null);
          }}
          orderId={orderId}
          context={pricing.context}
          subjectTh={pricing.subjectTh}
          busy={editor.busy}
          onWrite={editor.write}
        />
      )}
    </div>
  );
}
