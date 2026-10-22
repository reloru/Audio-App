import { useEffect, useState } from 'preact/hooks';

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error';
}

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

export function toast(text: string, kind: Toast['kind'] = 'info', ms = 2800): void {
  const t = { id: nextId++, text, kind };
  // One message at a time keeps the controls under it usable.
  toasts = [t];
  listeners.forEach((l) => l());
  setTimeout(() => {
    toasts = toasts.filter((x) => x.id !== t.id);
    listeners.forEach((l) => l());
  }, ms);
}

export function useToasts(): Toast[] {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((x) => x + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  return toasts;
}

export function errorText(e: unknown): string {
  if (e instanceof DOMException && e.name === 'AbortError') return 'Cancelled';
  if (e instanceof Error) return e.message;
  return String(e);
}
