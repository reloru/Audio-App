/**
 * Offline rendering: arrangement (clips, layers, seam crossfades) ->
 * varispeed / sample-rate conversion -> EQ -> width -> gain -> output fades ->
 * true-peak limiter -> loudness meter -> sink. Streaming in fixed blocks, so
 * memory use does not grow with song length.
 */
import { Biquad, biquadCoeffs } from '../dsp/biquad';
import { fadeGain } from '../dsp/fades';
import { LoudnessMeter, type LoudnessResult } from '../dsp/loudness';
import { TruePeakLimiter } from '../dsp/limiter';
import { Resampler } from '../dsp/resample';
import { clipLength, clipStarts, seamExtent } from '../model/timeline';
import type { FadeSpec, Id, Layer, Project, Source, EqSettings } from '../model/types';
import { eqToBiquads } from './eq';

export interface Pcm {
  sampleRate: number;
  channels: Float32Array[];
}

/** Decoded audio per layer id, at the project sample rate. */
export type LayerAudio = Map<Id, Pcm>;

export interface FrameRange {
  start: number;
  end: number;
}

export const dbToGain = (db: number) => Math.pow(10, db / 20);

/** Layers that are audible after mute/solo, with their channel gains. */
export function activeLayers(source: Source): { layer: Layer; gl: number; gr: number }[] {
  const anySolo = source.layers.some((l) => l.solo && !l.mute);
  return source.layers
    .filter((l) => !l.mute && (!anySolo || l.solo))
    .map((layer) => {
      const g = dbToGain(layer.gainDb);
      const b = Math.max(-1, Math.min(1, layer.balance));
      return { layer, gl: g * (b > 0 ? 1 - b : 1), gr: g * (b < 0 ? 1 + b : 1) };
    });
}

/** Random-access reader of the arranged (pre-effects) stereo timeline. */
export class ArrangementReader {
  readonly length: number;
  private readonly starts: number[];
  private readonly sources: Map<Id, Source>;
  private readonly offset: number;

  constructor(
    private readonly project: Project,
    private readonly audio: LayerAudio,
    range?: FrameRange,
  ) {
    this.starts = clipStarts(project.clips);
    const total = project.clips.reduce((s, c) => s + clipLength(c), 0);
    const r = range ?? { start: 0, end: total };
    this.offset = Math.max(0, r.start);
    this.length = Math.max(0, Math.min(total, r.end) - this.offset);
    this.sources = new Map(project.sources.map((s) => [s.id, s]));
  }

  read = (start: number, len: number): Float32Array[] => {
    const L = new Float32Array(len);
    const R = new Float32Array(len);
    const a = Math.max(0, start);
    const b = Math.min(this.length, start + len);
    if (b <= a) return [L, R];
    const clips = this.project.clips;
    for (let i = 0; i < clips.length; i++) {
      const c = clips[i];
      const src = this.sources.get(c.sourceId);
      if (!src) continue;
      const T = this.starts[i] - this.offset;
      const n = clipLength(c);
      const sIn = seamExtent(clips, this.sources, i);
      const sOut = seamExtent(clips, this.sources, i + 1);
      const r0 = Math.max(a, T - sIn.pre);
      const r1 = Math.min(b, T + n + sOut.post);
      if (r1 <= r0) continue;
      const m = r1 - r0;
      // Envelope: equal-power crossfades at both seams, 1 elsewhere.
      const env = new Float32Array(m).fill(1);
      const inLen = sIn.pre + sIn.post;
      if (inLen > 0) {
        const z0 = T - sIn.pre;
        for (let t = Math.max(r0, z0); t < Math.min(r1, T + sIn.post); t++) env[t - r0] *= Math.sin((((t - z0 + 0.5) / inLen) * Math.PI) / 2);
      }
      const outLen = sOut.pre + sOut.post;
      if (outLen > 0) {
        const z0 = T + n - sOut.pre;
        for (let t = Math.max(r0, z0); t < r1; t++) env[t - r0] *= Math.cos((((t - z0 + 0.5) / outLen) * Math.PI) / 2);
      }
      const srcStart = c.start + (r0 - T);
      for (const { layer, gl, gr } of activeLayers(src)) {
        const pcm = this.audio.get(layer.id);
        if (!pcm) continue;
        const chL = pcm.channels[0];
        const chR = pcm.channels[1] ?? chL;
        const lim = chL.length;
        const o = r0 - start;
        for (let k = 0; k < m; k++) {
          const f = srcStart + k;
          if (f < 0 || f >= lim) continue;
          const e = env[k];
          L[o + k] += e * gl * chL[f];
          R[o + k] += e * gr * chR[f];
        }
      }
    }
    return [L, R];
  };
}

export interface PostSettings {
  eq: EqSettings;
  width: number;
  gainDb: number;
  fadeIn: FadeSpec;
  fadeOut: FadeSpec;
}

/** EQ, width, gain and output fades on a stereo stream at the output rate. */
export class PostChain {
  private readonly filters: [Biquad, Biquad][];
  private readonly gain: number;
  private readonly fi: number;
  private readonly fo: number;

  constructor(
    private readonly s: PostSettings,
    sampleRate: number,
    private readonly total: number,
  ) {
    this.filters = eqToBiquads(s.eq, sampleRate).map((p) => {
      const c = biquadCoeffs(p, sampleRate);
      return [new Biquad(c), new Biquad(c)];
    });
    this.gain = dbToGain(s.gainDb);
    this.fi = Math.min(total, Math.round(s.fadeIn.seconds * sampleRate));
    this.fo = Math.min(total, Math.round(s.fadeOut.seconds * sampleRate));
  }

  process(ch: Float32Array[], pos: number, n: number): void {
    const [L, R] = ch;
    for (const [fl, fr] of this.filters) {
      fl.process(L, 0, n);
      fr.process(R, 0, n);
    }
    const w = this.s.width;
    if (w !== 1) {
      const a = 0.5 * (1 + w);
      const b = 0.5 * (1 - w);
      for (let i = 0; i < n; i++) {
        const l = L[i];
        const r = R[i];
        L[i] = a * l + b * r;
        R[i] = b * l + a * r;
      }
    }
    const g = this.gain;
    if (g !== 1) {
      for (let i = 0; i < n; i++) {
        L[i] *= g;
        R[i] *= g;
      }
    }
    if (this.fi > 0 && pos < this.fi) {
      for (let i = 0; i < n && pos + i < this.fi; i++) {
        const v = fadeGain(this.s.fadeIn.curve, (pos + i + 0.5) / this.fi);
        L[i] *= v;
        R[i] *= v;
      }
    }
    const foStart = this.total - this.fo;
    if (this.fo > 0 && pos + n > foStart) {
      for (let i = Math.max(0, foStart - pos); i < n; i++) {
        const v = fadeGain(this.s.fadeOut.curve, 1 - (pos + i - foStart + 0.5) / this.fo);
        L[i] *= v;
        R[i] *= v;
      }
    }
  }
}

export interface RenderOptions {
  project: Project;
  audio: LayerAudio;
  range?: FrameRange;
  outputRate: number;
  /** Added to the project gain (used for loudness normalisation). */
  extraGainDb?: number;
  limiter?: { ceilingDb: number } | null;
  meter?: boolean;
  onBlock?: (channels: Float32Array[], frames: number) => void | Promise<void>;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  /** Called between blocks so a UI thread can stay responsive. */
  yieldFn?: () => Promise<void>;
}

export interface RenderResult {
  frames: number;
  loudness?: LoudnessResult;
  limiterMinGain: number;
  limiterReducedFraction: number;
}

export function outputLength(project: Project, inputFrames: number, outputRate: number): number {
  const step = (project.speed * project.sampleRate) / outputRate;
  return step === 1 ? inputFrames : Math.max(0, Math.floor((inputFrames - 1) / step) + 1);
}

const BLOCK = 8192;

export async function render(o: RenderOptions): Promise<RenderResult> {
  const p = o.project;
  const reader = new ArrangementReader(p, o.audio, o.range);
  const step = (p.speed * p.sampleRate) / o.outputRate;
  const rs = step === 1 ? null : new Resampler(step);
  const total = rs ? rs.outputLength(reader.length) : reader.length;
  const post = new PostChain(
    { eq: p.eq, width: p.width, gainDb: p.gainDb + (o.extraGainDb ?? 0), fadeIn: p.fadeIn, fadeOut: p.fadeOut },
    o.outputRate,
    total,
  );
  const lim = o.limiter ? new TruePeakLimiter({ sampleRate: o.outputRate, channels: 2, ceilingDb: o.limiter.ceilingDb }) : null;
  const meter = o.meter ? new LoudnessMeter(o.outputRate, 2, { truePeak: true }) : null;
  let skip = lim?.latency ?? 0;
  let emitted = 0;
  let lastYield = Date.now();

  const emit = async (ch: Float32Array[], n: number) => {
    let from = 0;
    if (skip > 0) {
      from = Math.min(skip, n);
      skip -= from;
    }
    const cnt = Math.min(n - from, total - emitted);
    if (cnt <= 0) return;
    const out = from === 0 && cnt === ch[0].length ? ch : ch.map((c) => c.subarray(from, from + cnt));
    meter?.push(out, cnt);
    if (o.onBlock) await o.onBlock(out, cnt);
    emitted += cnt;
  };

  const maybeYield = async () => {
    if (o.signal?.aborted) throw new DOMException('Render cancelled', 'AbortError');
    if (o.yieldFn && Date.now() - lastYield > 30) {
      await o.yieldFn();
      lastYield = Date.now();
    }
  };

  for (let pos = 0; pos < total; pos += BLOCK) {
    const n = Math.min(BLOCK, total - pos);
    const ch = rs ? rs.process(reader.read, 2, pos, n) : reader.read(pos, n);
    post.process(ch, pos, n);
    if (lim) lim.process(ch, ch, n);
    await emit(ch, n);
    o.onProgress?.(Math.min(1, (pos + n) / total));
    await maybeYield();
  }
  // Flush the limiter's look-ahead delay.
  if (lim) {
    let remaining = lim.latency;
    while (remaining > 0 && emitted < total) {
      const n = Math.min(BLOCK, remaining);
      const z = [new Float32Array(n), new Float32Array(n)];
      lim.process(z, z, n);
      await emit(z, n);
      remaining -= n;
    }
  }
  return {
    frames: emitted,
    loudness: meter?.result(),
    limiterMinGain: lim?.minGain ?? 1,
    limiterReducedFraction: lim && total ? lim.reducedSamples / total : 0,
  };
}
