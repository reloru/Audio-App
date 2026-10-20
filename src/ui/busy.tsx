import { useEffect, useState } from 'preact/hooks';
import { Progress } from './components/controls';

type ProgressFn = (text: string, fraction: number) => void;

interface BusyState {
  title: string;
  text: string;
  progress: number;
}

let state: BusyState | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Runs a task while showing a blocking progress card. */
export async function runBusy<T>(title: string, fn: (p: ProgressFn) => Promise<T>): Promise<T> {
  state = { title, text: '', progress: 0 };
  emit();
  try {
    return await fn((text, progress) => {
      state = { title, text, progress };
      emit();
    });
  } finally {
    state = null;
    emit();
  }
}

export function useBusy() {
  return { run: runBusy };
}

export function BusyOverlay() {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((x) => x + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  if (!state) return null;
  return (
    <div class="busy" role="alert" aria-busy="true">
      <div class="card stack">
        <h3>{state.title}…</h3>
        <div class="small dim" style={{ minHeight: '1.4em' }}>
          {state.text}
        </div>
        <Progress value={state.progress} />
      </div>
    </div>
  );
}
