import { Cpu, Keyboard, TriangleAlert, UserPen } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

import { baht } from './amounts';
import { ENTRY_MODE_LABEL_TH, concessionText } from './override-entry';
import type { LineView, Provenance } from './quote-model';
import type { OverrideReasonWire, QuoteOverrideWire } from './quote-wire';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The one vocabulary for "where did this number come from", used everywhere it is asked.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * This is the safety property of the entire feature rendered as pixels. Once a human may set
 * any figure, nothing can answer "is this total correct?" — so the screen's job is to make
 * **an overridden number obviously different from a computed one**, on sight, without
 * hovering anything.
 *
 * Three treatments, for the three states `quote-model.ts` defines:
 *
 *   **คำนวณ** — the machine's figure. Plain tabular monospace, no chrome at all. This is the
 *     default look precisely so that anything with chrome on it reads as an exception.
 *   **พิมพ์เอง** — a free-form charge. A human wrote it, but there was never a computed figure
 *     to concede against, so it is neither of the other two. Dashed underline, quiet badge.
 *   **แก้ราคาแล้ว** — an override. The baseline is shown **struck through, beside it**, the
 *     figure sits in a filled box, and who set it travels with it.
 *
 * ### Why the difference is not only colour
 *
 * Two of the three carry a distinct *shape* — a box, a strike-through, a dashed rule — and an
 * icon, so the distinction survives a colour-blind reader, a greyscale print of a quote, and
 * a projector. Colour alone would be a safety property that stops working in the room where
 * quotes actually get argued about.
 *
 * ### Why the override badge is the only `default` badge on these screens
 *
 * `products/publish-state.tsx` refuses `variant="default"` for all three of its states and
 * says why: shadcn's default badge is `bg-primary`, and if the primary colour is what every
 * state looks like then no state stands out (plan 8.5). That reasoning is about *competing*
 * states. Here there is exactly one fact worth the primary colour — a person put their name
 * on a number — and nothing else on this screen uses it. Same rule: primary is spent once, on
 * the thing the screen exists for.
 *
 * ### "by whom" is a name
 *
 * `QuoteOverrideWire` carries `setByUserName` beside `setByUserId`. It shipped for one round
 * with only the id, so the screen answered *"where did this number come from?"* — the question
 * plan 7.9 says the whole feature exists to answer — with eight hex characters. The id is still
 * the tooltip, because that is what an audit query takes; the name is what a person reads.
 */

export function ProvenanceBadge({ provenance }: { readonly provenance: Provenance }) {
  switch (provenance.kind) {
    case 'computed':
      return (
        <Badge variant="outline" className="text-muted-foreground">
          <Cpu data-icon="inline-start" />
          คำนวณ
        </Badge>
      );
    case 'typed':
      return (
        <Badge variant="secondary">
          <Keyboard data-icon="inline-start" />
          พิมพ์เอง
        </Badge>
      );
    case 'overridden':
      return (
        <Badge title={overrideTitle(provenance.override)}>
          <UserPen data-icon="inline-start" />
          แก้ราคาแล้ว
        </Badge>
      );
  }
}

/** A user id in a form a person can carry to an audit query without reading out 36 characters. */
export const shortUserId = (userId: string): string => userId.slice(0, 8);

/** Everything the row cannot fit, for the hover — who, when, from which box, and why. */
export function overrideTitle(override: QuoteOverrideWire): string {
  const parts = [
    `ตั้งโดย ${override.setByUserName ?? 'ผู้ใช้'} (${override.setByUserId})`,
    `กรอกที่ช่อง "${ENTRY_MODE_LABEL_TH[override.enteredAs]}" เป็น "${override.enteredValueText}"`,
    `เหตุผล: ${REASON_LABEL_TH[override.reasonCode]}`,
  ];
  if (override.noteTh !== null && override.noteTh.trim() !== '') parts.push(override.noteTh);
  return parts.join(' · ');
}

export const REASON_LABEL_TH: Readonly<Record<OverrideReasonWire, string>> = {
  price_match: 'สู้ราคาคู่แข่ง',
  volume: 'ซื้อจำนวนมาก',
  relationship: 'ลูกค้าประจำ',
  goodwill: 'ชดเชยให้ลูกค้า',
  correction: 'แก้ไขข้อผิดพลาด',
  rounding: 'ปัดเศษ',
  other: 'อื่นๆ',
};

/**
 * One money figure, wearing its provenance.
 *
 * `tabular-nums` on every arm and not only on some: a column of prices that changes width per
 * row is a column somebody has to read twice, and the whole point of this component is that
 * the difference between two rows should be the *treatment* and never the alignment.
 */
export function Figure({
  minor,
  provenance,
  baselineMinor,
  className,
}: {
  readonly minor: bigint;
  readonly provenance: Provenance;
  /** The figure this replaced, shown struck through. Only meaningful for an override. */
  readonly baselineMinor?: bigint | undefined;
  readonly className?: string | undefined;
}) {
  const digits = 'font-mono tabular-nums';

  if (provenance.kind === 'computed') {
    return <span className={cn(digits, className)}>{baht(minor)}</span>;
  }

  if (provenance.kind === 'typed') {
    return (
      <span
        className={cn(digits, 'underline decoration-dashed underline-offset-4', className)}
        title="ยอดที่พิมพ์เอง — ไม่มีราคาคำนวณให้เทียบ"
      >
        {baht(minor)}
      </span>
    );
  }

  return (
    <span className={cn('inline-flex items-baseline gap-2', className)}>
      {baselineMinor === undefined ? null : (
        <span className={cn(digits, 'text-muted-foreground line-through')} title="ราคาที่คำนวณได้">
          {baht(baselineMinor)}
        </span>
      )}
      <span
        className={cn(digits, 'rounded-sm bg-primary px-1.5 py-0.5 font-semibold text-primary-foreground')}
        title={overrideTitle(provenance.override)}
      >
        {baht(minor)}
      </span>
    </span>
  );
}

/**
 * The line's figure, its baseline, what the concession was, and whether the ground moved.
 *
 * Assembled here rather than in the table so the four never drift apart: a screen that showed
 * the effective figure in one component and the concession in another would be one refactor
 * away from showing a concession computed against a different baseline than the one struck
 * through beside it.
 */
export function LineFigure({ view }: { readonly view: LineView }) {
  const override = view.provenance.kind === 'overridden' ? view.provenance.override : null;

  return (
    <div className="flex flex-col items-end gap-0.5">
      <Figure
        minor={view.effectiveThbMinor}
        provenance={view.provenance}
        {...(override === null ? {} : { baselineMinor: view.baselineThbMinor })}
      />
      {override === null ? null : (
        <span className="text-xs text-muted-foreground">
          {concessionText(view.baselineThbMinor, view.effectiveThbMinor)} · โดย{' '}
          <span title={override.setByUserId}>
            {override.setByUserName ?? shortUserId(override.setByUserId)}
          </span>
        </span>
      )}
      {view.stale === null ? null : (
        <span className="inline-flex items-center gap-1 text-xs font-medium text-destructive">
          <TriangleAlert className="size-3" />
          {view.stale.kind === 'promise_baseline_moved'
            ? 'ราคาฐานขยับหลังตกลงราคานี้ — ต้องยืนยันใหม่'
            : 'บรรทัดนี้ผูกกับเวอร์ชันที่เลิกเผยแพร่แล้ว — ต้องคิดราคาใหม่'}
        </span>
      )}
    </div>
  );
}

/**
 * The key, stated once on the screen.
 *
 * A legend is usually a sign that a design failed to be self-evident. It is here anyway, and
 * deliberately: these three treatments encode a distinction with legal and accounting weight
 * — who is answerable for a number — and a person who guesses the vocabulary correctly is
 * still a person who guessed.
 */
export function ProvenanceLegend({ className }: { readonly className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-center gap-x-4 gap-y-2 text-xs', className)}>
      <span className="inline-flex items-center gap-1.5">
        <Figure minor={879_100n} provenance={{ kind: 'computed' }} className="text-xs" />
        <span className="text-muted-foreground">ระบบคำนวณ ไม่มีใครแก้</span>
      </span>
      <span className="inline-flex items-center gap-1.5">
        <Figure minor={200_000n} provenance={{ kind: 'typed' }} className="text-xs" />
        <span className="text-muted-foreground">คนพิมพ์ ไม่มีราคาคำนวณให้เทียบ</span>
      </span>
      <span className="inline-flex items-baseline gap-1.5">
        {/*
          Built from the same `baht()` the table uses rather than from a literal string, so a
          legend can never demonstrate a formatting the screen does not actually produce —
          which is the one way a key becomes worse than no key.
        */}
        <span className="font-mono text-xs text-muted-foreground line-through tabular-nums">
          {baht(879_100n)}
        </span>
        <span className="rounded-sm bg-primary px-1.5 py-0.5 font-mono text-xs font-semibold text-primary-foreground tabular-nums">
          {baht(850_000n)}
        </span>
        <span className="text-muted-foreground">คนตั้งราคาทับค่าที่คำนวณได้</span>
      </span>
    </div>
  );
}
