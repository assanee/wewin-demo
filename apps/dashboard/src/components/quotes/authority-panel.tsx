'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Check, Clock, Lock, ShieldAlert, ShieldCheck } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';

import { baht } from './amounts';
import {
  getAssessment,
  requestApproval,
  type ApprovalDimensionWire,
  type AuthorityAssessmentView,
  type DimensionAssessmentView,
} from './authority-api';
/*
 * ⭐ The approver's decision, read by the person who asked for it.
 *
 * `components/approvals/` owns the decoding of an `approvals` row — it is the module built around
 * that resource — so this reads it from there rather than growing a fourth hand-written narrower
 * for the same wire shape. The dependency runs one way only (`approvals-api` imports this folder's
 * `decodeCeiling`/`decodeDimension`; nothing there imports this file), so there is no cycle.
 */
import { listApprovals, type ApprovalView } from '@/components/approvals/approvals-api';
import { failureMessage } from './quote-api';
import type { QuoteEditor } from './use-quote';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * What has been conceded, whose ceiling it is measured against — plan 7.13 and plan 13.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ### Two dimensions, one table, and no third mechanism
 *
 * `margin` is anything that reduces what the customer pays — a line total down, a document
 * discount, a grand total down, a negative charge, goodwill, an FX adjustment. `cashflow` is
 * anything that reduces the money received before production opens. Plan 7.13 found the same
 * two-person rule written six times with six column pairs, each with its own hole, and settled
 * it on the one `approvals` table these endpoints read.
 *
 * ### This panel performs no arithmetic and reads no ceiling off the quote
 *
 * The concession is **one subtraction at document level**, computed by the server — plan 7.13:
 * per row, ten lines discounted 10% each pass individually and nothing is ever reviewed. And
 * `allowed` is the server's answer, not a comparison this screen makes: the contract for the
 * quote is explicit that its own `marginConcessionThbMinor` is a figure to *render* and not
 * the one a ceiling is compared against. A client that compared it would be plan 7.13's
 * opening finding arriving one more time.
 *
 * The `sources` list is here because a single "฿1,432 conceded" is a number nobody can
 * challenge. Broken out per line and per override it becomes a decision somebody can review,
 * which is the whole point of an approval.
 *
 * ### An empty ceiling is not a ceiling of zero — plan 13
 *
 * `authority_limits` ships with **zero rows**, because nobody has asked the owner what the
 * limits are and plan 13's rule is that a placeholder must never be shipped wearing the
 * costume of an answer. So the screen has three sentences, not two, and the wire gives it
 * three answers rather than making it guess — see `ceilingClaim` below and `CeilingWire`:
 *
 *     { known: false }                  this response says nothing about your ceiling
 *     { known: true, thbMinor: null }   no row: fail-closed, this role may concede nothing
 *     { known: true, thbMinor: 0n }     a row saying "may record concessions, approve none"
 *
 * ⚠️ The middle and the last are different grants and are printed differently. The first is
 * printed as nothing at all, and getting *that* wrong is what told salespeople they had no
 * authority on every quote that conceded nothing.
 *
 * ### There is a request button and no approve button
 *
 * The decider is a different person on a different screen — `POST /quotes/approvals/:id/decision`
 * is deliberately not called from this folder. Plan 7.13's list of screens nobody has designed
 * yet still has "the approver's inbox" on it.
 */
export type QuoteWriteFn = QuoteEditor['write'];

const DIMENSION_LABEL_TH: Readonly<Record<ApprovalDimensionWire, string>> = {
  margin: 'ส่วนลด (เงินที่ลูกค้าจ่ายน้อยลง)',
  cashflow: 'กระแสเงินสด (เงินที่บริษัทได้รับน้อยลง)',
};

const DIMENSION_HINT_TH: Readonly<Record<ApprovalDimensionWire, string>> = {
  margin: 'นับรวมยอดบรรทัดที่ถูกลด ส่วนลดทั้งใบ ยอดรวมที่ถูกลด และบรรทัดค่าใช้จ่ายที่ติดลบ',
  cashflow: 'นับรวมการลดยอดมัดจำและการเลื่อนงวดที่ถือประตูเข้าสายการผลิต',
};

const SOURCE_LABEL_TH: Readonly<Record<string, string>> = {
  line_override: 'แก้ราคาบรรทัด',
  document_override: 'แก้ยอดรวมทั้งใบ',
  negative_charge: 'บรรทัดค่าใช้จ่ายติดลบ',
};

/**
 * The assessment, fetched on its own.
 *
 * A separate resource behind a separate permission with a separate endpoint, so it gets a
 * separate load rather than riding on the quote: a caller with `quotes.write` but without
 * whatever the assessment needs would otherwise turn the whole quote screen into an error.
 * `reloadKey` is the quote's revision — every write to the quote can move the concession, so
 * the assessment is re-fetched whenever the quote does.
 */
export function AuthorityPanel({
  orderId,
  reloadKey,
  mayWrite,
}: {
  readonly orderId: string;
  readonly reloadKey: string;
  readonly mayWrite: boolean;
}) {
  const [state, setState] = useState<
    | { readonly status: 'loading' }
    | { readonly status: 'error'; readonly error: unknown }
    | { readonly status: 'ready'; readonly assessment: AuthorityAssessmentView }
  >({ status: 'loading' });
  /**
   * ⭐ Requests on this order that came back **refused** — the half of the loop that was missing.
   *
   * `AuthorityService.decide` requires a sentence on every rejection *"because the requester has to
   * be told what to change"*, and until this fetch existed nobody was ever told: the note went into
   * `approvals.decision_note_th` and no screen in the application read it. The salesperson saw the
   * quote go back to "needs approval" with the request gone from the panel, which is
   * indistinguishable from never having asked.
   *
   * ⚠️ A **separate, best-effort** read and not part of `state`: it is context beside a refusal, and
   * a caller who cannot read it (or an endpoint that is down) must not turn the authority panel —
   * which is what says whether this quote may be sent at all — into an error card. So a failure
   * here leaves the panel intact and the note absent, which is the pre-existing behaviour.
   */
  const [refusals, setRefusals] = useState<readonly ApprovalView[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setState({ status: 'loading' });
    void getAssessment(orderId)
      .then((assessment) => setState({ status: 'ready', assessment }))
      .catch((error: unknown) => setState({ status: 'error', error }));

    void listApprovals({ status: 'rejected', orderId, limit: 20 })
      .then(setRefusals)
      .catch(() => setRefusals([]));
  }, [orderId]);

  useEffect(() => {
    load();
    /* `reloadKey` is in the dependency list on purpose — see the header. */
  }, [load, reloadKey]);

  const ask = useCallback(
    async (dimension: ApprovalDimensionWire, reasonTh: string): Promise<void> => {
      setBusy(true);
      try {
        await requestApproval({ orderId, dimension, reasonTh });
        toast.success('ส่งคำขออนุมัติแล้ว');
        load();
      } catch (error: unknown) {
        toast.error(failureMessage(error));
      } finally {
        setBusy(false);
      }
    },
    [load, orderId],
  );

  if (state.status === 'loading') return <Skeleton className="h-40 w-full" />;

  if (state.status === 'error') {
    return (
      <Card>
        <CardHeader>
          <CardTitle>อำนาจอนุมัติ</CardTitle>
          <CardDescription>
            อ่านสถานะอำนาจอนุมัติไม่ได้ — {failureMessage(state.error)}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button size="sm" variant="outline" onClick={load}>
            ลองอีกครั้ง
          </Button>
        </CardContent>
      </Card>
    );
  }

  const { assessment } = state;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          อำนาจอนุมัติ
          {assessment.allowed ? (
            <Badge variant="secondary">
              <ShieldCheck data-icon="inline-start" />
              ส่งใบนี้ได้
            </Badge>
          ) : (
            <Badge variant="destructive">
              <ShieldAlert data-icon="inline-start" />
              ยังส่งไม่ได้
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          ประเมินที่ระดับเอกสาร ไม่ใช่รายบรรทัด — ส่วนลด 10% สิบบรรทัดผ่านทีละบรรทัดได้ทั้งที่รวมแล้วต้องมีคนตรวจ
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <DimensionRow
          dimension={assessment.margin}
          refusal={latestRefusal(refusals, 'margin')}
          busy={busy}
          mayWrite={mayWrite}
          onAsk={ask}
        />
        <Separator />
        <DimensionRow
          dimension={assessment.cashflow}
          refusal={latestRefusal(refusals, 'cashflow')}
          busy={busy}
          mayWrite={mayWrite}
          onAsk={ask}
        />
      </CardContent>
    </Card>
  );
}

/**
 * The most recent refusal in one dimension, or `undefined`.
 *
 * The list arrives newest first (`inbox` orders decided rows by `created_at` descending), so this
 * is a `find` and not a sort — restating the ordering here would be a second opinion about it.
 * Older refusals on the same dimension are deliberately not shown: the one that matters is the
 * answer to the last thing that was asked.
 */
/** Bangkok time, stated — the same rendering the approvals screen uses. */
const decidedAtTh = (iso: string): string =>
  new Date(iso).toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok',
    dateStyle: 'medium',
    timeStyle: 'short',
  });

function latestRefusal(
  refusals: readonly ApprovalView[],
  dimension: ApprovalDimensionWire,
): ApprovalView | undefined {
  return refusals.find((row) => row.dimension === dimension);
}

function DimensionRow({
  dimension,
  refusal,
  busy,
  mayWrite,
  onAsk,
}: {
  readonly dimension: DimensionAssessmentView;
  readonly refusal: ApprovalView | undefined;
  readonly busy: boolean;
  readonly mayWrite: boolean;
  readonly onAsk: (dimension: ApprovalDimensionWire, reasonTh: string) => Promise<void>;
}) {
  const [reasonTh, setReasonTh] = useState('');

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-medium">{DIMENSION_LABEL_TH[dimension.dimension]}</span>
        <span className="font-mono tabular-nums">{baht(dimension.concessionThbMinor)}</span>
      </div>
      <p className="text-xs text-muted-foreground">{DIMENSION_HINT_TH[dimension.dimension]}</p>

      {dimension.sources.length === 0 ? null : (
        <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
          {dimension.sources.map((source, index) => (
            <li
              key={`${source.overrideId ?? source.quoteLineId ?? 'x'}-${String(index)}`}
              className="flex justify-between gap-3"
            >
              <span>
                {SOURCE_LABEL_TH[source.kind] ?? source.kind}
                {source.reasonCode === null ? '' : ` · ${source.reasonCode}`}
              </span>
              <span className="font-mono tabular-nums">{baht(source.amountThbMinor)}</span>
            </li>
          ))}
        </ul>
      )}

      <CeilingLine claim={ceilingClaim(dimension)} />
      <Outcome outcome={dimension.outcome} />

      {/*
       * ⭐ The refusal, with the reason the approver was required to write.
       *
       * Shown only while this dimension still needs an approval: once a later request has been
       * granted, an old refusal is history and belongs on the approvals screen rather than beside a
       * quote that is now sendable.
       *
       * ⚠️ It says which quote the refusal was about. A salesperson who edits after being refused
       * has changed the document, so the figure in the refusal is not the figure on the screen —
       * printing the note without that fact invites "but they already said no to this", about a
       * quote nobody has seen.
       */}
      {dimension.outcome === 'needs_approval' && refusal !== undefined && (
        <div className="border-destructive/40 bg-destructive/5 flex flex-col gap-1 rounded-md border p-3">
          <span className="text-destructive inline-flex items-center gap-1.5 text-sm font-medium">
            <ShieldAlert className="size-4" />
            คำขอก่อนหน้าไม่ได้รับอนุมัติ
          </span>
          <p className="text-sm">{refusal.decisionNoteTh ?? 'ผู้อนุมัติไม่ได้ระบุเหตุผล'}</p>
          <span className="text-muted-foreground text-xs">
            ขอไว้ {baht(refusal.concessionThbMinor)}
            {refusal.decidedAt === null ? '' : ` · ตัดสินเมื่อ ${decidedAtTh(refusal.decidedAt)}`}
          </span>
        </div>
      )}

      {dimension.outcome !== 'needs_approval' ? null : (
        <div className="flex flex-col gap-2">
          <Textarea
            rows={2}
            value={reasonTh}
            disabled={!mayWrite || busy}
            placeholder="เหตุผลที่ขออนุมัติ — ผู้อนุมัติจะเห็นข้อความนี้"
            onChange={(event) => setReasonTh(event.target.value)}
          />
          <Button
            size="sm"
            className="self-start"
            disabled={!mayWrite || busy || reasonTh.trim() === ''}
            onClick={() => {
              void onAsk(dimension.dimension, reasonTh.trim());
            }}
          >
            ขออนุมัติ
          </Button>
          <p className="text-xs text-muted-foreground">
            คำขอนี้ไม่ได้ระบุจำนวนเงิน — ระบบวัดยอดที่ลดจากใบเสนอราคาเองตอนบันทึกคำขอ
            เพื่อไม่ให้ขออนุมัติ ฿100 แล้วได้อนุมัติ ฿100,000
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * ⭐ What this response says about the reader's ceiling — three answers, not two.
 *
 * ⚠️ **This function used to be the bug, and the fix is that it no longer decides anything.**
 *
 * The wire once carried a bare `ceilingThbMinor: string | null` whose `null` meant "your role
 * has no ceiling" on `needs_approval` and "this outcome never consulted the table" on the other
 * three — a split produced by a branch inside `AuthorityService.judge` that no client can see.
 * Reading it as "no ceiling" printed **ยังไม่มีการกำหนดเพดานอำนาจสำหรับบทบาทของคุณ** on every
 * quote with no discount on it — which is most quotes — and kept printing it after an
 * administrator had granted that very role a ceiling. Found by driving both screens in a
 * browser; nothing in the API could have caught it, because the API was right and the sentence
 * was invented here.
 *
 * The first fix rebuilt the distinction here, from `outcome`. That worked and was the wrong
 * place: it left a wire field meaning two things, correct on exactly one client, and the
 * dashboard is only the first. `CeilingWire` now carries `known` and the server sets it — so
 * this is a rename of the server's three answers into the three sentences the screen prints,
 * and there is nothing left here to get wrong.
 */
export type CeilingClaim =
  | { readonly kind: 'ceiling'; readonly ceilingThbMinor: bigint }
  | { readonly kind: 'none_granted' }
  | { readonly kind: 'unknown' };

export function ceilingClaim(dimension: Pick<DimensionAssessmentView, 'ceiling'>): CeilingClaim {
  if (!dimension.ceiling.known) return { kind: 'unknown' };
  if (dimension.ceiling.thbMinor === null) return { kind: 'none_granted' };
  return { kind: 'ceiling', ceilingThbMinor: dimension.ceiling.thbMinor };
}

function CeilingLine({ claim }: { readonly claim: CeilingClaim }) {
  if (claim.kind === 'unknown') return null;

  if (claim.kind === 'none_granted') {
    return (
      <p className="inline-flex items-start gap-1.5 text-sm text-destructive">
        <Lock className="mt-0.5 size-4 shrink-0" />
        <span>
          ยังไม่มีการกำหนดเพดานอำนาจสำหรับบทบาทของคุณ — ระบบจึง<strong>ไม่อนุญาตให้ลดยอด</strong>จนกว่าเจ้าของกิจการจะกำหนด
          <span className="text-muted-foreground"> (ค่าตั้งต้นแบบ fail-closed ไม่ใช่นโยบายที่ตัดสินแล้ว)</span>
        </span>
      </p>
    );
  }

  return (
    <p className="text-sm text-muted-foreground">
      เพดานของบทบาทคุณ {baht(claim.ceilingThbMinor)}
      {claim.ceilingThbMinor === 0n ? ' — บันทึกส่วนลดได้ แต่ต้องให้คนอื่นอนุมัติทุกครั้ง' : ''}
    </p>
  );
}

function Outcome({ outcome }: { readonly outcome: DimensionAssessmentView['outcome'] }) {
  switch (outcome) {
    case 'nothing_conceded':
      return <p className="text-sm text-muted-foreground">ยังไม่มีการลดยอดในมิตินี้</p>;
    case 'within_authority':
      return (
        <p className="inline-flex items-center gap-1.5 text-sm">
          <ShieldCheck className="size-4" />
          อยู่ในอำนาจของคุณ
        </p>
      );
    case 'covered_by_approval':
      return (
        <p className="inline-flex items-center gap-1.5 text-sm">
          <Check className="size-4" />
          มีผู้อนุมัติแล้ว
        </p>
      );
    case 'needs_approval':
      return (
        <p className="inline-flex items-center gap-1.5 text-sm text-destructive">
          <Clock className="size-4" />
          เกินอำนาจของคุณ — ต้องมีคนอื่นอนุมัติก่อนส่งใบนี้
        </p>
      );
    /*
     * ⚠️ Unreachable from this screen, and handled rather than defaulted.
     *
     * `unassessed` is what the API's `bareMeasurementWire` sends for a measurement with nobody's
     * authority applied — it appears on `GET /quotes/approvals/:id`, which the approver's inbox
     * reads, and never on `GET /quotes/authority/orders/:orderId`, which is what this panel reads
     * (every dimension there is judged). It is in the union because the shared decoder is shared;
     * a `default` clause would have swallowed a real outcome added later, and saying nothing is
     * the correct rendering for "no verdict was asked for".
     */
    case 'unassessed':
      return null;
  }
}
