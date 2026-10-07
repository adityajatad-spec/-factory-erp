import { useEffect, useRef, type ReactNode } from 'react';

/** Native <dialog>: focus trapping, Esc to close and backdrop come from the browser. */
export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  wide = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className={`m-auto w-[calc(100%-2rem)] rounded-lg border border-slate-200 p-0 shadow-xl ${wide ? 'max-w-2xl' : 'max-w-md'}`}
    >
      {open && (
        <div className="flex max-h-[85vh] flex-col">
          <header className="border-b border-slate-200 px-4 py-3">
            <h2 className="text-base font-semibold text-slate-900">{title}</h2>
          </header>
          <div className="overflow-y-auto px-4 py-3">{children}</div>
          {footer && (
            <footer className="flex justify-end gap-2 border-t border-slate-200 bg-slate-50 px-4 py-3">
              {footer}
            </footer>
          )}
        </div>
      )}
    </dialog>
  );
}
