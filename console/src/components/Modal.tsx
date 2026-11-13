import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface ModalProps {
  open: boolean;
  title?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  narrow?: boolean;
}

// 模块级弹窗栈：多个弹窗叠起来时，只有栈顶处理 Esc / Tab
const modalStack: symbol[] = [];

// body 滚动锁用计数器：第一个进时记下原值，最后一个出时还原
let bodyLockCount = 0;
let bodyOverflowBeforeLock = '';

function lockBodyScroll(): void {
  if (bodyLockCount === 0) bodyOverflowBeforeLock = document.body.style.overflow;
  bodyLockCount += 1;
  document.body.style.overflow = 'hidden';
}

function unlockBodyScroll(): void {
  bodyLockCount = Math.max(0, bodyLockCount - 1);
  if (bodyLockCount === 0) document.body.style.overflow = bodyOverflowBeforeLock;
}

const FOCUSABLE = [
  'a[href]',
  'button',
  'input',
  'textarea',
  'select',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const INITIAL_FOCUS = [
  'input:not([disabled]):not([hidden])',
  'textarea:not([disabled]):not([hidden])',
  'select:not([disabled]):not([hidden])',
  'button:not([disabled]):not([hidden])',
  'a[href]:not([hidden])',
].join(',');

function focusableIn(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) =>
      !element.hasAttribute('disabled') &&
      !element.hasAttribute('hidden') &&
      element.getClientRects().length > 0,
  );
}

/** 共用弹窗。Esc 关闭、焦点陷阱、打开时焦点进弹窗、关闭后回到原处。 */
export default function Modal({ open, title, onClose, children, footer, wide = false, narrow = false }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const stackId = useRef<symbol>(Symbol('modal'));
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const id = stackId.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    modalStack.push(id);
    lockBodyScroll();

    const onKeyDown = (event: KeyboardEvent) => {
      // 叠了两层时，下面那层的监听器什么都不做
      if (modalStack[modalStack.length - 1] !== id) return;

      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }

      if (event.key !== 'Tab') return;
      const nodes = focusableIn(dialogRef.current);
      if (nodes.length === 0) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }

      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;
      const inside = active instanceof Node && dialogRef.current?.contains(active);
      const onDialog = active === dialogRef.current;

      if (event.shiftKey) {
        if (!inside || onDialog || active === first) {
          event.preventDefault();
          last.focus();
        }
      } else if (!inside || onDialog || active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);

    const raf = requestAnimationFrame(() => {
      const first = dialogRef.current?.querySelector<HTMLElement>(INITIAL_FOCUS);
      (first ?? dialogRef.current)?.focus();
    });

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      const index = modalStack.lastIndexOf(id);
      if (index !== -1) modalStack.splice(index, 1);
      unlockBodyScroll();
      cancelAnimationFrame(raf);
      previous?.focus();
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div className="modal-root">
      <div className="modal-backdrop" onClick={onClose} />
      <div
        className={wide ? 'modal wide' : narrow ? 'modal narrow' : 'modal'}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        ref={dialogRef}
        tabIndex={-1}
      >
        {title ? (
          <div className="modal-head">
            <h2 className="modal-title" id={titleId}>
              {title}
            </h2>
          </div>
        ) : null}
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
