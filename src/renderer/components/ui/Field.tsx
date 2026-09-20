import type { ComponentPropsWithRef, ReactNode } from 'react';

const INPUT = 'w-full rounded-md border border-line bg-bg-0 px-2 py-1.5 text-[12px] text-fg outline-none focus:border-accent';

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="mb-3 block">
      <div className="mb-1 text-[11px] font-medium text-fg-2">{label}</div>
      {children}
      {hint ? <div className="mt-1 text-[11px] text-muted">{hint}</div> : null}
    </label>
  );
}

export function TextInput(props: ComponentPropsWithRef<'input'>) {
  return <input className={INPUT} {...props} />;
}

export function Select(props: ComponentPropsWithRef<'select'>) {
  return <select className={INPUT} {...props} />;
}

export function TextArea(props: ComponentPropsWithRef<'textarea'>) {
  return <textarea className={`${INPUT} font-mono`} {...props} />;
}

export function Checkbox({ label, ...props }: ComponentPropsWithRef<'input'> & { label: string }) {
  return (
    // Dimmed when disabled: the native box greys itself, but a full-strength label beside it still
    // reads as a live option.
    <label className={`mb-2 flex items-center gap-2 text-[12px]${props.disabled ? ' opacity-50' : ''}`}>
      <input type="checkbox" className="accent-accent" {...props} />
      {label}
    </label>
  );
}
