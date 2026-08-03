import { useEffect, useRef, type ReactNode } from 'react';

interface StickyBarProps {
  children: ReactNode;
  className?: string;
}

/**
 * Bottom bar pinned above the home indicator.
 *
 * While mounted it reserves its own height on `<body>` (spec section 8) instead of
 * leaving each page to render a matching spacer. A page-level spacer only covers
 * that page's own content — the app shell's footer sits outside it and ends up
 * hidden under the bar, which is the exact failure the spec's rule exists to stop.
 *
 * The reservation is measured rather than hard-coded. A constant has to be kept in
 * step with the row height *plus* the top border *plus* the safe-area padding, and
 * the first version of this got it wrong by exactly one border and left the footer
 * a pixel under the bar.
 */
export function StickyBar({ children, className = '' }: StickyBarProps) {
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = barRef.current;
    if (!element) return;

    const apply = () => {
      document.body.style.setProperty('--sticky-bar-height', `${element.offsetHeight}px`);
    };

    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(element);

    return () => {
      observer.disconnect();
      document.body.style.removeProperty('--sticky-bar-height');
    };
  }, []);

  return (
    <div
      ref={barRef}
      className={`fixed inset-x-0 bottom-0 z-30 border-t border-line bg-panel ${className}`}
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="container-page flex h-18 items-center justify-between gap-3">{children}</div>
    </div>
  );
}
