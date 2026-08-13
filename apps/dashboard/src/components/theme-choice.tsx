'use client';

import { useTheme } from 'next-themes';
import { Monitor, Moon, Sun } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ Choosing a theme. Three states, and the third one is not padding.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `providers.tsx` has run `ThemeProvider` since the shell was built, so the `.dark` block in
 * globals.css has never been dead CSS — it has been *unreachable*, which is a different
 * problem with the same symptom. The app followed the operating system and offered no way to
 * disagree with it.
 *
 * ── Why three options and not a switch ───────────────────────────────────────
 *
 * `defaultTheme="system"` is the behaviour this app already had, and a two-position switch
 * cannot express it: whichever way it starts, the first render has to pick light or dark and
 * that choice is then *stored*, so a laptop that switches at sunset stops following. A
 * two-state control does not simplify a three-state setting, it deletes one of the states.
 * ตามระบบ is therefore an option in its own right and the one selected until somebody
 * chooses otherwise.
 *
 * ── ⚠️ Why the trigger swaps its icon in CSS and not in JavaScript ───────────
 *
 * `useTheme()` returns `undefined` for `theme` and `resolvedTheme` on the server and on the
 * first client render — it cannot do otherwise, because the answer lives in `localStorage`.
 * A trigger that rendered `resolvedTheme === 'dark' ? <Moon/> : <Sun/>` would therefore emit
 * the *light* icon into the HTML and correct it after hydration: a visible flash of the
 * wrong icon on every page load, and a hydration warning under it.
 *
 * So the trigger renders **both** icons unconditionally and lets the `dark:` variant decide
 * which is visible. That is the same mechanism the rest of the app's colours use, and it is
 * driven by the `class="dark"` that next-themes' inline script has already written onto
 * `<html>` *before the first paint* — which is the whole reason that script, and the
 * `suppressHydrationWarning` in layout.tsx that lets it get away with it, exist. The markup
 * is identical on both sides of hydration, so there is nothing to flash and nothing to warn
 * about.
 *
 * The menu is free to read `theme` directly: radix does not mount `DropdownMenuContent`
 * until the menu is opened, which cannot happen before hydration.
 */

/**
 * The three values, and the only three. `next-themes` types `setTheme` as taking any
 * `string` and `theme` as returning any `string | undefined`, so a stale `localStorage` entry
 * — a theme name from a build that offered more of them — arrives here as a value that
 * matches no option. Narrowed rather than cast, the same way `ui/sonner.tsx` narrows it for
 * exactly this reason: `exactOptionalPropertyTypes` refuses to pass `string | undefined` into
 * a `value?: string` prop, and an unrecognised name would otherwise leave the radio group
 * with nothing checked and no clue why.
 */
const THEMES = ['light', 'dark', 'system'] as const;

type Theme = (typeof THEMES)[number];

const LABEL_TH: Readonly<Record<Theme, string>> = {
  light: 'สว่าง',
  dark: 'มืด',
  system: 'ตามระบบ',
};

const ICON: Readonly<Record<Theme, typeof Sun>> = {
  light: Sun,
  dark: Moon,
  system: Monitor,
};

function asTheme(value: string | undefined): Theme {
  return THEMES.find((candidate) => candidate === value) ?? 'system';
}

/**
 * The control itself, for the header.
 *
 * `variant="ghost"` because the header holds no other filled control and a themed app whose
 * loudest element is the theme button has its emphasis backwards. The focus ring comes from
 * `buttonVariants` and is the one every other button in the app uses — worth stating because
 * an icon-only ghost button is where a missing ring is least likely to be noticed and most
 * likely to matter.
 */
export function ThemeChoice() {
  const { theme, setTheme } = useTheme();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="เปลี่ยนธีมการแสดงผล">
          {/*
            Both icons, always. See the header of this file: which one is visible is decided
            by the `dark` class on <html>, so the server and the client render the same thing.
            `dark:hidden` / `hidden dark:block` and not opacity — an invisible-but-present
            icon would still take part in the flex layout and shift the visible one.
          */}
          <Sun className="dark:hidden" />
          <Moon className="hidden dark:block" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end">
        <DropdownMenuLabel>ธีมการแสดงผล</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={asTheme(theme)}
          onValueChange={(next) => setTheme(asTheme(next))}
        >
          {THEMES.map((candidate) => {
            const Icon = ICON[candidate];
            return (
              <DropdownMenuRadioItem key={candidate} value={candidate}>
                <Icon />
                {LABEL_TH[candidate]}
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
