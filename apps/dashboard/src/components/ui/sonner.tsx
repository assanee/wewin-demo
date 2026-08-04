"use client"

import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"

/*
 * `next-themes` types `theme` as `string | undefined`, and the generated version cast it
 * straight into `ToasterProps["theme"]`. That cast is a lie in two directions under this
 * repo's compiler settings: it re-admits `undefined` (which `exactOptionalPropertyTypes`
 * refuses) and it would happily pass through a stored theme name that is none of the three
 * sonner understands. Narrowed instead of cast — the same rule apps/api applies to every
 * value it did not construct itself.
 */
const SONNER_THEMES = ["light", "dark", "system"] as const

type SonnerTheme = (typeof SONNER_THEMES)[number]

function asSonnerTheme(value: string | undefined): SonnerTheme {
  return SONNER_THEMES.find((candidate) => candidate === value) ?? "system"
}

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme } = useTheme()

  return (
    <Sonner
      theme={asSonnerTheme(theme)}
      className="toaster group"
      icons={{
        success: (
          <CircleCheckIcon className="size-4" />
        ),
        info: (
          <InfoIcon className="size-4" />
        ),
        warning: (
          <TriangleAlertIcon className="size-4" />
        ),
        error: (
          <OctagonXIcon className="size-4" />
        ),
        loading: (
          <Loader2Icon className="size-4 animate-spin" />
        ),
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
