import type { ReactNode } from 'react';

import Modal from './Modal';

interface ConfirmProps {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** 二次确认。全站不弹浏览器原生确认框。 */
export default function Confirm({
  open,
  title,
  message,
  confirmText = '确定',
  cancelText = '取消',
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmProps) {
  return (
    <Modal
      open={open}
      title={title}
      narrow
      onClose={busy ? () => undefined : onCancel}
      footer={
        <>
          <button className="btn quiet" type="button" onClick={onCancel} disabled={busy}>
            {cancelText}
          </button>
          <button className={danger ? 'btn key' : 'btn'} type="button" onClick={onConfirm} disabled={busy}>
            {busy ? '处理中…' : confirmText}
          </button>
        </>
      }
    >
      <p className="confirm-text">{message}</p>
    </Modal>
  );
}
