import { useSyncExternalStore } from 'react';

/**
 * Read a media query reactively.
 *
 * Use sparingly. CSS breakpoints handle anything that is only a style change; this
 * exists for the cases where the DOM itself must differ — /quote renders a table on
 * desktop and a card list on mobile, and rendering both while hiding one with CSS
 * would make a screen reader read every line twice (spec section 9).
 *
 * `useSyncExternalStore` rather than useState + useEffect: the server snapshot is
 * explicit (false), so this stays safe if the app ever moves to SSR.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = (onChange: () => void): (() => void) => {
    const list = window.matchMedia(query);
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  };

  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}

export const useIsDesktop = (): boolean => useMediaQuery('(min-width: 1024px)');

/** Honour the OS "reduce motion" setting in JS-driven behaviour, not just CSS. */
export const usePrefersReducedMotion = (): boolean =>
  useMediaQuery('(prefers-reduced-motion: reduce)');
