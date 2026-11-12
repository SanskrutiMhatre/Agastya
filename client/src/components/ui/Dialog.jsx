import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import Button from './Button.jsx';
import Icon from '../Icon.jsx';
import { Alert } from './States.jsx';

/*
  Modal dialog on the native <dialog> element: the browser provides the
  focus trap, Escape to close and an inert background. Focus returns to the
  element that opened it.
*/
export function Dialog({ open, onClose, title, description, children, footer, size = 'md', dismissable = true }) {
  const ref = useRef(null);
  const opener = useRef(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      opener.current = document.activeElement;
      d.showModal();
    } else if (!open && d.open) {
      d.close();
      if (opener.current && opener.current.focus) opener.current.focus();
    }
  }, [open]);

  // Removed while open (its owner stopped rendering it): closed first, at once, so the browser
  // does not move the focus to the page body afterwards, after the owner has placed it.
  useLayoutEffect(() => () => { const d = ref.current; if (d && d.open) d.close(); }, []);

  const widths = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl' };
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      onCancel={(e) => { e.preventDefault(); if (dismissable) onClose(); }}
      onMouseDown={(e) => { if (dismissable && e.target === ref.current) onClose(); }}
      className={`m-auto w-[calc(100%-2rem)] ${widths[size]} rounded-xl border border-line bg-surface text-ink shadow-pop p-0`}
    >
      {open ? (
        <div className="flex flex-col max-h-[85vh]">
          <div className="flex items-start justify-between gap-4 px-6 pt-5">
            <div>
              <h2 id={titleId} className="text-[17px] font-semibold">{title}</h2>
              {description ? <p id={descId} className="mt-1 text-ink-3">{description}</p> : null}
            </div>
            {dismissable ? (
              <button type="button" onClick={onClose} className="-mr-2 -mt-1 h-8 w-8 grid place-items-center rounded-md text-ink-3 hover:bg-surface-3 hover:text-ink" aria-label="Close">
                <Icon name="x" size={18} />
              </button>
            ) : null}
          </div>
          <div className="px-6 py-4 overflow-y-auto">{children}</div>
          {footer ? <div className="flex flex-wrap justify-end gap-2 px-6 py-4 border-t border-line bg-surface-2 rounded-b-xl">{footer}</div> : null}
        </div>
      ) : null}
    </dialog>
  );
}

/*
  Confirmation for consequential or destructive actions. onConfirm may be
  async; errors are shown in the dialog instead of closing it.
*/
export function ConfirmDialog({ open, onClose, onConfirm, title, children, confirmLabel = 'Confirm', tone = 'primary' }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => { if (open) { setBusy(false); setError(null); } }, [open]);
  async function go() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open} onClose={() => !busy && onClose()} title={title} size="sm"
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} onClick={go} loading={busy}>{confirmLabel}</Button>
        </>
      )}
    >
      <div className="text-ink-2 space-y-2">{children}</div>
      {error ? <Alert className="mt-3">{error.message}</Alert> : null}
    </Dialog>
  );
}
