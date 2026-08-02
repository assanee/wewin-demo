import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Link } from 'react-router-dom';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'md' | 'lg';

/**
 * `primary` is the lime one. Spec section 2 caps lime at two appearances per screen
 * (the total and the main action), so a screen should never hold two primary buttons.
 */
const VARIANT_CLASS: Record<Variant, string> = {
  primary: 'bg-lime text-ink border-lime hover:brightness-110 active:brightness-95 font-medium',
  secondary: 'bg-panel-2 text-chalk border-line hover:border-line-2',
  ghost: 'bg-transparent text-chalk-2 border-transparent hover:text-chalk hover:border-line',
  danger: 'bg-transparent text-danger border-line hover:border-danger',
};

/** 44px floor on every size — spec section 8 requires it of all touch targets. */
const SIZE_CLASS: Record<Size, string> = {
  md: 'min-h-11 px-4 text-body',
  lg: 'min-h-[52px] px-6 text-lead',
};

const BASE =
  'inline-flex items-center justify-center gap-2 border rounded-xs ' +
  'transition-[background-color,border-color,color,filter] duration-180 ease-out ' +
  'disabled:opacity-40 disabled:pointer-events-none select-none';

interface CommonProps {
  variant?: Variant;
  size?: Size;
  className?: string;
  children: ReactNode;
}

type ButtonProps = CommonProps & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'children'>;

export function Button({
  variant = 'secondary',
  size = 'md',
  className = '',
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`${BASE} ${VARIANT_CLASS[variant]} ${SIZE_CLASS[size]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

interface ButtonLinkProps extends CommonProps {
  to: string;
  'aria-label'?: string;
}

/** Same skin as Button, but a real link — so middle-click and copy-address work. */
export function ButtonLink({
  to,
  variant = 'secondary',
  size = 'md',
  className = '',
  children,
  ...rest
}: ButtonLinkProps) {
  return (
    <Link
      to={to}
      className={`${BASE} ${VARIANT_CLASS[variant]} ${SIZE_CLASS[size]} ${className}`}
      {...rest}
    >
      {children}
    </Link>
  );
}
