import { analyzeBeats, type BeatAnalysis } from '../dsp/beats';

// Typed locally: the DOM and WebWorker libs cannot be loaded in one program.
declare const self: {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent) => void) | null;
};

export interface AnalysisRequest {
  id: number;
  mono: Float32Array;
  sampleRate: number;
}
export interface AnalysisResponse {
  id: number;
  result?: BeatAnalysis;
  error?: string;
}

self.onmessage = (e: MessageEvent<AnalysisRequest>) => {
  const { id, mono, sampleRate } = e.data;
  try {
    const result = analyzeBeats([mono], sampleRate);
    self.postMessage({ id, result } satisfies AnalysisResponse);
  } catch (err) {
    self.postMessage({ id, error: err instanceof Error ? err.message : String(err) } satisfies AnalysisResponse);
  }
};
