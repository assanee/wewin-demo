import Link from 'next/link';
import type { Route } from 'next';
import { ArrowLeft } from 'lucide-react';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ The top of every screen, in one place.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Before this component the page title was hand-rolled per route and had drifted into four
 * different things: `text-2xl font-semibold tracking-tight` on `/`, `text-2xl font-semibold`
 * on `/orders` and `/account`, `text-xl font-semibold` inside `quote-list.tsx` and
 * `quote-editor.tsx`, and **nothing at all** on `/quotes`' error and empty states — a screen
 * whose fetch failed lost its own name. The description under it was `text-sm` in one place
 * and unclassed (so 16px, *larger than the section headings below it*) in two others.
 *
 * The shell deliberately owns none of this — `(app)/layout.tsx` keeps its header thin and
 * says why: a header that knows each page's title becomes a registry every new route has to
 * be added to. This is the other half of that argument. The page still owns its title; it
 * just no longer owns the *typography* of a title.
 *
 * ── The rule this component enforces ─────────────────────────────────────────
 *
 * `type-page` appears here and nowhere else, so "one page title per screen" is structural
 * rather than a thing to remember. `type-focal` is **not** used here on purpose: the primary
 * thing on a screen is not its name. The name says where you are; the focal statement says
 * what is true right now, and it belongs in the page body underneath — the current status on
 * an order, what is blocked on the overview.
 *
 * ⚠️ Render this in the failure and empty states too, not only when the data arrived. Losing
 * the page title is how a reader stops being able to tell "this screen is broken" from "I
 * clicked the wrong thing".
 */
export function PageHeader({
  title,
  description,
  back,
  meta,
  actions,
  mono = false,
}: {
  readonly title: string;
  readonly description?: string;
  /** A way back up, for a detail screen. The label is the destination, never "ย้อนกลับ". */
  readonly back?: { readonly href: Route; readonly label: string };
  /** Badges and facts that qualify the title — status, revision, a freeze marker. */
  readonly meta?: React.ReactNode;
  /** Buttons that act on the whole record. Right-aligned on a wide screen, wrapped below on a narrow one. */
  readonly actions?: React.ReactNode;
  /** An order number is a machine string and reads as one. Thai titles never set this. */
  readonly mono?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      {back === undefined ? null : (
        <Link
          href={back.href}
          className="text-muted-foreground hover:text-foreground type-caption -ml-1 inline-flex w-fit items-center gap-1 rounded px-1 py-0.5 focus-visible:outline-ring focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          <ArrowLeft className="size-3.5" aria-hidden />
          {back.label}
        </Link>
      )}

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
          <h1 className={mono ? 'type-page font-mono' : 'type-page'}>{title}</h1>
          {meta}
        </div>
        {actions === undefined ? null : (
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        )}
      </div>

      {description === undefined ? null : (
        <p className="text-muted-foreground type-body max-w-2xl">{description}</p>
      )}
    </div>
  );
}
