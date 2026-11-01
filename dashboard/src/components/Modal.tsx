import { X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

let openModals = 0;

function setBackgroundHidden(hidden: boolean) {
  const root = document.getElementById('root');
  if (!root) return;
  if (hidden) {
    root.setAttribute('aria-hidden', 'true');
    root.setAttribute('inert', '');
  } else {
    root.removeAttribute('aria-hidden');
    root.removeAttribute('inert');
  }
}

interface ModalProps {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** "drawer" slides in from the side (detail panels, mobile nav). */
  variant?: 'dialog' | 'drawer' | 'nav';
  closeLabel?: string;
}

/** Accessible modal: labelled, traps focus, closes on Escape / backdrop, restores focus. */
export function Modal({
  title,
  description,
  onClose,
  children,
  footer,
  variant = 'dialog',
  closeLabel = 'Close',
}: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const focusables = () => Array.from(node?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    (
      focusables().find((el) => el.dataset.autofocus !== undefined) ??
      focusables()[0] ??
      node
    )?.focus();
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    openModals += 1;
    setBackgroundHidden(true);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
      } else if (e.key === 'Tab') {
        const els = focusables();
        if (els.length === 0) return;
        const first = els[0] as HTMLElement;
        const last = els[els.length - 1] as HTMLElement;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = originalOverflow;
      openModals -= 1;
      if (openModals <= 0) {
        openModals = 0;
        setBackgroundHidden(false);
      }
      previous?.focus?.();
    };
  }, []);

  return createPortal(
    <div
      className={`modal-backdrop modal-${variant}`}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={ref}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
      >
        <header className="modal-header">
          <div>
            <h2 id={titleId} className="modal-title">
              {title}
            </h2>
            {description && (
              <p id={descId} className="muted">
                {description}
              </p>
            )}
          </div>
          <button type="button" className="icon-btn" aria-label={closeLabel} onClick={onClose}>
            <X size={20} aria-hidden />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-footer">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

interface ConfirmProps {
  title: string;
  /** Plain-language consequences of the action. */
  consequences: ReactNode;
  confirmLabel: string;
  tone?: 'danger' | 'primary';
  pending?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  consequences,
  confirmLabel,
  tone = 'primary',
  pending,
  error,
  onConfirm,
  onCancel,
}: ConfirmProps) {
  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onCancel} data-autofocus>
            Cancel
          </button>
          <button
            type="button"
            className={`btn ${tone === 'danger' ? 'btn-danger' : 'btn-primary'}`}
            onClick={onConfirm}
            disabled={pending}
          >
            {pending ? 'Sending request…' : confirmLabel}
          </button>
        </>
      }
    >
      <div className="stack">
        <div>{consequences}</div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

export function DetailPanel({
  title,
  description,
  onClose,
  children,
}: {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Modal
      variant="drawer"
      title={title}
      description={description}
      onClose={onClose}
      closeLabel="Close details"
    >
      {children}
    </Modal>
  );
}
