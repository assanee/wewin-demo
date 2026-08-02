import type { ReactNode } from 'react';

type Tone = 'neutral' | 'blueprint' | 'danger' | 'warn';

const TONE_CLASS: Record<Tone, string> = {
  neutral: 'border-line text-chalk-2',
  // Dimensional information only — spec section 2 forbids blueprint on controls.
  blueprint: 'border-line text-blueprint',
  danger: 'border-danger/40 text-danger',
  warn: 'border-warn/40 text-warn',
};

interface BadgeProps {
  tone?: Tone;
  mono?: boolean;
  children: ReactNode;
}

export function Badge({ tone = 'neutral', mono = false, children }: BadgeProps) {
  return (
    <span
      className={`inline-flex min-w-0 items-center rounded-xs border bg-panel-2/60 px-2 py-0.5 text-caption ${
        mono ? 'numeric' : ''
      } ${TONE_CLASS[tone]}`}
    >
      <span className="truncate">{children}</span>
    </span>
  );
}
