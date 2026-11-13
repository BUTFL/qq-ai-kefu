import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

type ToastKind = 'ok' | 'err';
type PushToast = (text: string, kind?: ToastKind) => void;

interface ToastItem {
  id: number;
  text: string;
  kind: ToastKind;
}

const ToastContext = createContext<PushToast>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, number>());

  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach((timer) => window.clearTimeout(timer));
      pending.clear();
    };
  }, []);

  const push = useCallback<PushToast>((text, kind = 'ok') => {
    const id = nextId.current++;
    setItems((prev) => [...prev, { id, text, kind }]);
    const timer = window.setTimeout(() => {
      timers.current.delete(id);
      setItems((prev) => prev.filter((item) => item.id !== id));
    }, 3200);
    timers.current.set(id, timer);
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {items.map((item) => (
          <div
            key={item.id}
            className={item.kind === 'err' ? 'toast err' : 'toast'}
            role={item.kind === 'err' ? 'alert' : undefined}
          >
            {item.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): PushToast {
  return useContext(ToastContext);
}
