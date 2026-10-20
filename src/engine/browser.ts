/** Browser glue: MP3 worker sink, beat-analysis worker, UI yielding, wake lock. */
import type { Mp3Sink, Mp3SinkFactory } from './export';
import type { Mp3WorkerRequest, Mp3WorkerResponse } from '../workers/mp3.worker';
import type { AnalysisRequest, AnalysisResponse } from '../workers/analysis.worker';
import type { BeatAnalysis } from '../dsp/beats';

export const yieldToUi = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

export const createMp3Sink: Mp3SinkFactory = async (sampleRate, channels, bitrate) => {
  const worker = new Worker(new URL('../workers/mp3.worker.ts', import.meta.url), { type: 'module' });
  let pending: { resolve: (m: Mp3WorkerResponse) => void; reject: (e: Error) => void } | null = null;
  worker.onmessage = (e: MessageEvent<Mp3WorkerResponse>) => {
    const p = pending;
    pending = null;
    if (!p) return;
    if (e.data.type === 'error') p.reject(new Error(e.data.message));
    else p.resolve(e.data);
  };
  worker.onerror = (e) => {
    const p = pending;
    pending = null;
    p?.reject(new Error(e.message || 'MP3 encoder failed'));
  };
  const call = (msg: Mp3WorkerRequest, transfer: Transferable[] = []) =>
    new Promise<Mp3WorkerResponse>((resolve, reject) => {
      pending = { resolve, reject };
      worker.postMessage(msg, transfer);
    });
  await call({ type: 'open', sampleRate, channels, bitrate });
  let id = 0;
  const sink: Mp3Sink = {
    async encode(ch, n) {
      const copies = ch.map((c) => c.slice(0, n));
      await call({ type: 'encode', id: id++, channels: copies }, copies.map((c) => c.buffer));
    },
    async finish() {
      const r = await call({ type: 'finish' });
      worker.terminate();
      return r.type === 'done' ? r.parts : [];
    },
  };
  return sink;
};

let analysisWorker: Worker | null = null;
let nextId = 1;
const waiting = new Map<number, { resolve: (r: BeatAnalysis) => void; reject: (e: Error) => void }>();

export function analyzeBeatsInWorker(mono: Float32Array, sampleRate: number): Promise<BeatAnalysis> {
  if (!analysisWorker) {
    analysisWorker = new Worker(new URL('../workers/analysis.worker.ts', import.meta.url), { type: 'module' });
    analysisWorker.onmessage = (e: MessageEvent<AnalysisResponse>) => {
      const w = waiting.get(e.data.id);
      if (!w) return;
      waiting.delete(e.data.id);
      if (e.data.result) w.resolve(e.data.result);
      else w.reject(new Error(e.data.error ?? 'Analysis failed'));
    };
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    analysisWorker!.postMessage({ id, mono, sampleRate } satisfies AnalysisRequest, [mono.buffer]);
  });
}

/** Keeps the screen awake during long exports where supported. */
export async function withWakeLock<T>(fn: () => Promise<T>): Promise<T> {
  let lock: { release(): Promise<void> } | null = null;
  try {
    const wl = (navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock;
    lock = (await wl?.request('screen')) ?? null;
  } catch {
    lock = null;
  }
  try {
    return await fn();
  } finally {
    await lock?.release().catch(() => undefined);
  }
}
