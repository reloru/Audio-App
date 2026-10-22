/**
 * Input for cloud tempo/pitch: the arranged timeline (clips, seam crossfades, stem mix with
 * level/balance/mute/solo) as 16-bit WAV. Master processing (speed, EQ, width, gain, fades,
 * loudness) is not applied; it is copied to the result project instead.
 */
import { WavEncoder } from '../io/wav';
import type { Project } from '../model/types';
import { ArrangementReader, type LayerAudio } from './render';

/** Peak the upload is scaled to (−6 dBFS), leaving room for peaks the time stretch adds. */
export const HEADROOM_PEAK = Math.pow(10, -6 / 20);
/** Largest attenuation applied (dB), so the compensation fits the +12 dB layer level range. */
export const MAX_HEADROOM_DB = 12;

const BLOCK = 65536;

export interface CloudInput {
  /** WAV file contents in order (header first). */
  parts: Uint8Array[];
  bytes: number;
  seconds: number;
  sampleRate: number;
  /** Gain applied before upload (dB, ≤ 0); the result needs the opposite. */
  gainDb: number;
}

export async function renderCloudInput(
  project: Project,
  audio: LayerAudio,
  opts: { onProgress?: (f: number) => void; signal?: AbortSignal; yieldFn?: () => Promise<void> } = {},
): Promise<CloudInput> {
  const reader = new ArrangementReader(project, audio);
  const len = reader.length;
  const step = async (done: number, pass: number) => {
    if (opts.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    opts.onProgress?.((pass + done / Math.max(1, len)) / 2);
    await opts.yieldFn?.();
  };

  let peak = 0;
  for (let s = 0; s < len; s += BLOCK) {
    for (const ch of reader.read(s, Math.min(BLOCK, len - s))) for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]));
    await step(s, 0);
  }
  if (!(peak > 0)) throw new Error('The song is silent.');
  const gainDb = Math.max(-MAX_HEADROOM_DB, Math.min(0, 20 * Math.log10(HEADROOM_PEAK / peak)));
  const gain = Math.pow(10, gainDb / 20);

  const enc = new WavEncoder(project.sampleRate, 2, 'pcm16', true);
  const blocks: Uint8Array[] = [];
  for (let s = 0; s < len; s += BLOCK) {
    const n = Math.min(BLOCK, len - s);
    const chs = reader.read(s, n);
    for (const ch of chs) for (let i = 0; i < n; i++) ch[i] *= gain;
    blocks.push(enc.encode(chs, n));
    await step(s, 1);
  }
  const parts = [enc.header(), ...blocks, enc.trailer()];
  return {
    parts,
    bytes: parts.reduce((a, p) => a + p.length, 0),
    seconds: len / project.sampleRate,
    sampleRate: project.sampleRate,
    gainDb,
  };
}
