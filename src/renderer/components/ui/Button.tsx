import type { ComponentPropsWithRef } from 'react';

// `ComponentPropsWithRef`, not `ButtonHTMLAttributes`: React 19 passes `ref` as an ordinary
// prop, but only a props type that DECLARES it lets `tsc` through — and dialogs name their
// initial focus target by ref (`ui/Dialog.tsx`).

type Variant = 'primary' | 'default' | 'ghost' | 'danger';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-bg-0 hover:brightness-110',
  default: 'bg-bg-3 text-fg hover:bg-line',
  ghost: 'text-fg-2 hover:bg-bg-3 hover:text-fg',
  danger: 'bg-red text-bg-0 hover:brightness-110',
};

export function Button({ variant = 'default', className = '', ...props }: ComponentPropsWithRef<'button'> & { variant?: Variant }) {
  return (
    <button
      type="button"
      className={`no-drag inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-40 ${VARIANTS[variant]} ${className}`}
      {...props}
    />
  );
}

export function IconButton({ title, className = '', ...props }: ComponentPropsWithRef<'button'> & { title: string }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      className={`no-drag inline-flex h-6 w-6 items-center justify-center rounded text-fg-2 hover:bg-bg-3 hover:text-fg disabled:pointer-events-none disabled:opacity-40 ${className}`}
      {...props}
    />
  );
}
