import * as React from "react"

import { cn } from "@/lib/utils"

function Card({
  className,
  size = "default",
  ...props
}: React.ComponentProps<"div"> & { size?: "default" | "sm" }) {
  return (
    <div
      data-slot="card"
      data-size={size}
      className={cn(
        "group/card flex flex-col gap-(--card-spacing) overflow-hidden rounded-xl bg-card py-(--card-spacing) text-sm text-card-foreground ring-1 ring-foreground/10 [--card-spacing:--spacing(4)] has-data-[slot=card-footer]:pb-0 has-[>img:first-child]:pt-0 data-[size=sm]:[--card-spacing:--spacing(3)] data-[size=sm]:has-data-[slot=card-footer]:pb-0 *:[img:first-child]:rounded-t-xl *:[img:last-child]:rounded-b-xl",
        className
      )}
      {...props}
    />
  )
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "group/card-header @container/card-header grid auto-rows-min items-start gap-1 rounded-t-xl px-(--card-spacing) has-data-[slot=card-action]:grid-cols-[1fr_auto] has-data-[slot=card-description]:grid-rows-[auto_auto] [.border-b]:pb-(--card-spacing)",
        className
      )}
      {...props}
    />
  )
}

/**
 * ⚠️ **`type-section`, and this line is the one the whole hierarchy pass turns on.**
 *
 * This was shadcn's generated `text-base ... font-medium`, i.e. 16px — while `Card` above sets
 * `text-sm` (14px) on everything inside it. A card heading was therefore **two pixels larger
 * than its own body copy**, in 39 of the app's 41 `<CardTitle>`s. That is not a weak hierarchy,
 * it is the absence of one, and it is the whole of what the owner was reading as ไม่มีจุดเด่น.
 *
 * `type-section` is 18px/600 — see the scale block in `globals.css` and the rule in the app's
 * README. Phase 1 applied it at four screens' call sites and deliberately left this default
 * alone, because changing it restyles every screen in the app and doing that to eleven
 * unreviewed ones is a side effect rather than a decision. Phase 2 *is* that review, so the
 * reason has expired and the default moves.
 *
 * ⚠️ **`group-data-[size=sm]/card:text-sm` is gone with it, and that is not an oversight.** A
 * `size="sm"` card dropped its title to 14px — the exact size of the body underneath it, so the
 * heading and its content became indistinguishable. A denser card is a reason for less padding,
 * never for a heading that has stopped being one. `--card-spacing` already carries the density;
 * the type does not need to help.
 *
 * If you are adding a card and want a *smaller* heading than this, you almost certainly want no
 * `CardTitle` at all — see the three questions in `apps/dashboard/README.md`.
 */
function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn("font-heading type-section", className)}
      {...props}
    />
  )
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn(
        "col-start-2 row-span-2 row-start-1 self-start justify-self-end",
        className
      )}
      {...props}
    />
  )
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={cn("px-(--card-spacing)", className)}
      {...props}
    />
  )
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn(
        "flex items-center rounded-b-xl border-t bg-muted/50 p-(--card-spacing)",
        className
      )}
      {...props}
    />
  )
}

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
}
