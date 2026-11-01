import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { Tone } from '../lib/labels';

interface ToastItem {
  id: number;
  tone: Tone;
  message: string;
}
interface ToastApi {
  toast: (message: string, tone?: Tone) => void;
}

const ToastContext = createContext<ToastApi>({ toast: () => undefined });
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const toast = useCallback((message: string, tone: Tone = 'info') => {
    const id = Date.now() + Math.random();
    setItems((cur) => [...cur.slice(-3), { id, tone, message }]);
    window.setTimeout(() => setItems((cur) => cur.filter((t) => t.id !== id)), 7000);
  }, []);
  const value = useMemo(() => ({ toast }), [toast]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-region" role="status" aria-live="polite" aria-label="Notifications">
        {items.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            {t.message}
            <button
              type="button"
              className="icon-btn"
              aria-label="Dismiss notification"
              onClick={() => setItems((cur) => cur.filter((x) => x.id !== t.id))}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
