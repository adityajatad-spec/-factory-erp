import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-slate-900 text-white hover:bg-slate-800 disabled:bg-slate-400',
  secondary:
    'bg-white text-slate-800 border border-slate-300 hover:bg-slate-50 disabled:text-slate-400',
  danger: 'bg-white text-red-700 border border-red-300 hover:bg-red-50 disabled:text-red-300',
  ghost: 'text-slate-700 hover:bg-slate-100 disabled:text-slate-400',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  shortcut,
  className = '',
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: 'sm' | 'md';
  shortcut?: string;
  children: ReactNode;
}) {
  const sizing = size === 'sm' ? 'h-7 px-2 text-xs' : 'h-8 px-3 text-sm';
  return (
    <button
      type="button"
      className={`inline-flex items-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed ${sizing} ${VARIANTS[variant]} ${className}`}
      {...props}
    >
      {children}
      {shortcut && (
        <kbd className="ml-1 rounded border border-current/30 px-1 font-mono text-[10px] opacity-60">
          {shortcut}
        </kbd>
      )}
    </button>
  );
}
