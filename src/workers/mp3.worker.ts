import wasmUrl from 'wasm-media-encoders/wasm/mp3?url';
import { openMp3Stream, type Mp3Stream } from '../io/mp3encoder';

export type Mp3WorkerRequest =
  | { type: 'open'; sampleRate: number; channels: 1 | 2; bitrate: 128 | 160 | 192 | 224 | 256 | 320 }
  | { type: 'encode'; id: number; channels: Float32Array[] }
  | { type: 'finish' };

export type Mp3WorkerResponse =
  | { type: 'ready' }
  | { type: 'ack'; id: number }
  | { type: 'done'; parts: Uint8Array[] }
  | { type: 'error'; message: string };

// Typed locally: the DOM and WebWorker libs cannot be loaded in one program.
declare const self: {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent) => void) | null;
};

let stream: Mp3Stream | null = null;
let parts: Uint8Array[] = [];

const post = (m: Mp3WorkerResponse, transfer: Transferable[] = []) => self.postMessage(m, transfer);

self.onmessage = async (e: MessageEvent<Mp3WorkerRequest>) => {
  const m = e.data;
  try {
    if (m.type === 'open') {
      stream = await openMp3Stream(wasmUrl, m.sampleRate, m.channels, m.bitrate);
      parts = [];
      post({ type: 'ready' });
    } else if (m.type === 'encode') {
      if (!stream) throw new Error('Encoder not open');
      const out = stream.encode(m.channels);
      if (out.length) parts.push(out);
      post({ type: 'ack', id: m.id });
    } else if (m.type === 'finish') {
      if (!stream) throw new Error('Encoder not open');
      const last = stream.finish();
      if (last.length) parts.push(last);
      const done = parts;
      parts = [];
      stream = null;
      post({ type: 'done', parts: done }, done.map((p) => p.buffer));
    }
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
