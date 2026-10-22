/**
 * Live preview with Web Audio. Mirrors the offline renderer: the same clip
 * layout and seam crossfades (scheduled as gain automation), the same EQ
 * formulas (native BiquadFilterNode), width matrix, gain, output fades, and
 * the same true-peak limiter running in an AudioWorklet.
 */
import limiterUrl from './limiter.worklet.ts?worker&url';
import { fadeGain } from '../dsp/fades';
import { eqToBiquads } from '../engine/eq';
import { dbToGain, type FrameRange } from '../engine/render';
import { clipStarts, seamExtent, timelineLength } from '../model/timeline';
import type { Id, Project, Source } from '../model/types';

export interface PlayerInput {
  project: Project;
  buffers: Map<Id, AudioBuffer>;
  /** Extra gain for previewing loudness normalisation. */
  previewGainDb: number;
  /** Range the output fades refer to (null = whole timeline). */
  fadeRange: FrameRange | null;
}

interface LayerBus {
  input: GainNode;
  gl: GainNode;
  gr: GainNode;
}

const LOOP_EDGE = 0.005;

export class Player {
  private ctx: AudioContext | null = null;
  private mix!: GainNode;
  private eqNodes: BiquadFilterNode[] = [];
  private eqKey = '';
  private widthIn!: GainNode;
  private wLL!: GainNode;
  private wLR!: GainNode;
  private wRL!: GainNode;
  private wRR!: GainNode;
  private widthOut!: ChannelMergerNode;
  private master!: GainNode;
  private fade!: GainNode;
  private loopEdge!: GainNode;
  private limiter: AudioWorkletNode | null = null;
  private buses = new Map<Id, LayerBus>();
  private scheduled = new Set<AudioScheduledSourceNode>();
  private input: PlayerInput | null = null;
  private arrKey = '';

  private _playing = false;
  private startCtx = 0;
  private startPos = 0;
  private pausedPos = 0;
  private loop: FrameRange | null = null;
  private loopNext = 0;
  private loopTimer: ReturnType<typeof setInterval> | null = null;
  private endTimer: ReturnType<typeof setTimeout> | null = null;

  onEnded?: () => void;

  get playing(): boolean {
    return this._playing;
  }

  /** Must be called from a user gesture the first time (autoplay policies). */
  async ensure(): Promise<AudioContext> {
    if (this.ctx) {
      if (this.ctx.state !== 'running') await this.ctx.resume().catch(() => undefined);
      return this.ctx;
    }
    // iOS mutes Web Audio under the ringer switch unless the session is "playback".
    const nav = navigator as Navigator & { audioSession?: { type: string } };
    if (nav.audioSession) {
      try {
        nav.audioSession.type = 'playback';
      } catch {
        /* unsupported */
      }
    }
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    this.mix = ctx.createGain();
    this.mix.channelCount = 2;
    this.mix.channelCountMode = 'explicit';
    this.widthIn = ctx.createGain();
    const split = ctx.createChannelSplitter(2);
    this.widthOut = ctx.createChannelMerger(2);
    this.wLL = ctx.createGain();
    this.wLR = ctx.createGain();
    this.wRL = ctx.createGain();
    this.wRR = ctx.createGain();
    this.widthIn.connect(split);
    split.connect(this.wLL, 0);
    split.connect(this.wLR, 0);
    split.connect(this.wRL, 1);
    split.connect(this.wRR, 1);
    this.wLL.connect(this.widthOut, 0, 0);
    this.wRL.connect(this.widthOut, 0, 0);
    this.wLR.connect(this.widthOut, 0, 1);
    this.wRR.connect(this.widthOut, 0, 1);
    this.master = ctx.createGain();
    this.fade = ctx.createGain();
    this.loopEdge = ctx.createGain();
    this.widthOut.connect(this.master);
    this.master.connect(this.fade);
    this.fade.connect(this.loopEdge);
    try {
      await ctx.audioWorklet.addModule(limiterUrl);
      this.limiter = new AudioWorkletNode(ctx, 'bounce-limiter', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: 'explicit',
        processorOptions: { ceilingDb: -1, enabled: true },
      });
      this.loopEdge.connect(this.limiter);
      this.limiter.connect(ctx.destination);
    } catch {
      this.limiter = null;
      this.loopEdge.connect(ctx.destination);
    }
    this.rebuildEq();
    if (ctx.state !== 'running') await ctx.resume().catch(() => undefined);
    if (this.input) this.applyLive();
    return ctx;
  }

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 48000;
  }

  setInput(input: PlayerInput): void {
    const prev = this.input;
    this.input = input;
    const key = arrangementKey(input);
    const changed = key !== this.arrKey;
    this.arrKey = key;
    if (!this.ctx) return;
    this.applyLive();
    if (changed && this._playing && prev) {
      const pos = this.position();
      this.stopNodes();
      this.startAt(pos);
    }
  }

  /** Timeline position in frames at the project rate. */
  position(): number {
    if (!this._playing || !this.ctx || !this.input) return this.pausedPos;
    const p = this.input.project;
    const lat = (this.ctx as AudioContext & { outputLatency?: number }).outputLatency ?? this.ctx.baseLatency ?? 0;
    const elapsed = Math.max(0, (this.ctx.currentTime - lat - this.startCtx) * p.sampleRate * p.speed);
    const loop = this.loop;
    if (loop) {
      const first = loop.end - this.startPos;
      if (elapsed < first) return this.startPos + elapsed;
      const len = loop.end - loop.start;
      return loop.start + ((elapsed - first) % len);
    }
    return Math.min(timelineLength(p.clips), this.startPos + elapsed);
  }

  async play(from: number, loop: FrameRange | null): Promise<void> {
    await this.ensure();
    if (!this.input) return;
    this.stopNodes();
    this.loop = loop && loop.end - loop.start > 0.05 * this.input.project.sampleRate ? loop : null;
    let start = from;
    if (this.loop && (from < this.loop.start || from >= this.loop.end)) start = this.loop.start;
    this.startAt(start);
  }

  pause(): void {
    if (!this._playing) return;
    this.pausedPos = this.position();
    this.stopNodes();
    this._playing = false;
  }

  seek(frame: number): void {
    if (this._playing) {
      const loop = this.loop;
      this.stopNodes();
      this.loop = loop && frame >= loop.start && frame < loop.end ? loop : null;
      this.startAt(frame);
    } else this.pausedPos = frame;
  }

  stop(): void {
    this.stopNodes();
    this._playing = false;
  }

  private startAt(pos: number): void {
    const ctx = this.ctx!;
    const p = this.input!.project;
    const total = timelineLength(p.clips);
    if (pos >= total) pos = 0;
    const when = ctx.currentTime + 0.03;
    this.startCtx = when;
    this.startPos = pos;
    this._playing = true;
    const sec = (frames: number) => frames / (p.sampleRate * p.speed);
    if (this.loop) {
      const { start, end } = this.loop;
      this.scheduleSpan(pos, end, when);
      this.loopEdges(pos, end, when, pos > start);
      this.loopNext = when + sec(end - pos);
      this.loopTimer = setInterval(() => {
        if (!this.ctx || !this.loop) return;
        while (this.loopNext - this.ctx.currentTime < 0.6) {
          this.scheduleSpan(start, end, this.loopNext);
          this.loopEdges(start, end, this.loopNext, true);
          this.loopNext += sec(end - start);
        }
      }, 100);
    } else {
      this.loopEdge.gain.cancelScheduledValues(0);
      this.loopEdge.gain.value = 1;
      this.scheduleSpan(pos, total, when);
      this.endTimer = setTimeout(
        () => {
          this._playing = false;
          this.pausedPos = 0;
          this.stopNodes();
          this.onEnded?.();
        },
        (sec(total - pos) + 0.05) * 1000 + (when - ctx.currentTime) * 1000,
      );
    }
    this.scheduleFades(pos, when);
  }

  private stopNodes(): void {
    if (this.loopTimer) clearInterval(this.loopTimer);
    if (this.endTimer) clearTimeout(this.endTimer);
    this.loopTimer = null;
    this.endTimer = null;
    for (const s of this.scheduled) {
      try {
        s.onended = null;
        s.stop();
        s.disconnect();
      } catch {
        /* already stopped */
      }
    }
    this.scheduled.clear();
    if (this.ctx) {
      this.fade.gain.cancelScheduledValues(0);
      this.fade.gain.value = 1;
      this.loopEdge.gain.cancelScheduledValues(0);
      this.loopEdge.gain.value = 1;
    }
  }

  /** Short fades at loop boundaries to avoid clicks. */
  private loopEdges(from: number, to: number, when: number, fadeInStart: boolean): void {
    const p = this.input!.project;
    const dur = (to - from) / (p.sampleRate * p.speed);
    const g = this.loopEdge.gain;
    const e = Math.min(LOOP_EDGE, dur / 4);
    if (fadeInStart) {
      g.setValueAtTime(0, when);
      g.linearRampToValueAtTime(1, when + e);
    } else g.setValueAtTime(1, when);
    g.setValueAtTime(1, when + dur - e);
    g.linearRampToValueAtTime(0, when + dur);
  }

  private scheduleSpan(from: number, to: number, when: number): void {
    const ctx = this.ctx!;
    const { project: p, buffers } = this.input!;
    const clips = p.clips;
    const sources = new Map<Id, Source>(p.sources.map((s) => [s.id, s]));
    const starts = clipStarts(clips);
    const sec = (frames: number) => frames / (p.sampleRate * p.speed);
    for (let i = 0; i < clips.length; i++) {
      const c = clips[i];
      const src = sources.get(c.sourceId);
      if (!src) continue;
      const T = starts[i];
      const n = c.end - c.start;
      const sIn = seamExtent(clips, sources, i);
      const sOut = seamExtent(clips, sources, i + 1);
      const r0 = Math.max(from, T - sIn.pre);
      const r1 = Math.min(to, T + n + sOut.post);
      if (r1 <= r0) continue;
      const t0 = when + sec(r0 - from);
      // All layers are scheduled; mute/solo act on the bus gains so they can change live.
      for (const layer of src.layers) {
        const buf = buffers.get(layer.id);
        const bus = this.buses.get(layer.id);
        if (!buf || !bus) continue;
        const env = ctx.createGain();
        const inStart = T - sIn.pre;
        const inEnd = T + sIn.post;
        const outStart = T + n - sOut.pre;
        const outEnd = T + n + sOut.post;
        let v0 = 1;
        if (r0 < inEnd && inEnd > inStart) v0 *= Math.sin((((r0 - inStart) / (inEnd - inStart)) * Math.PI) / 2);
        if (r0 >= outStart && outEnd > outStart) v0 *= Math.cos((((r0 - outStart) / (outEnd - outStart)) * Math.PI) / 2);
        env.gain.value = v0;
        if (inEnd > inStart) curveAt(env.gain, (u) => Math.sin((u * Math.PI) / 2), inStart, inEnd, r0, from, when, sec);
        if (outEnd > outStart) curveAt(env.gain, (u) => Math.cos((u * Math.PI) / 2), outStart, Math.min(outEnd, r1), r0, from, when, sec, outEnd);
        const s = ctx.createBufferSource();
        s.buffer = buf;
        s.playbackRate.value = p.speed;
        s.connect(env);
        env.connect(bus.input);
        const offset = (c.start + (r0 - T)) / buf.sampleRate;
        const dur = (r1 - r0) / buf.sampleRate;
        s.start(Math.max(t0, ctx.currentTime), Math.max(0, offset), dur);
        s.onended = () => {
          this.scheduled.delete(s);
          s.disconnect();
          env.disconnect();
        };
        this.scheduled.add(s);
      }
    }
  }

  private scheduleFades(from: number, when: number): void {
    const { project: p, fadeRange } = this.input!;
    const total = timelineLength(p.clips);
    const R = fadeRange ?? { start: 0, end: total };
    const sec = (frames: number) => frames / (p.sampleRate * p.speed);
    const perSec = p.sampleRate * p.speed;
    const fi = Math.min(R.end - R.start, p.fadeIn.seconds * perSec);
    const fo = Math.min(R.end - R.start, p.fadeOut.seconds * perSec);
    const g = this.fade.gain;
    let v0 = 1;
    if (fi > 0 && from >= R.start && from < R.start + fi) v0 *= fadeGain(p.fadeIn.curve, (from - R.start) / fi);
    if (fo > 0 && from >= R.end - fo && from < R.end) v0 *= fadeGain(p.fadeOut.curve, 1 - (from - (R.end - fo)) / fo);
    g.value = v0;
    if (fi > 0) curveAt(g, (u) => fadeGain(p.fadeIn.curve, u), R.start, R.start + fi, from, from, when, sec);
    if (fo > 0) curveAt(g, (u) => fadeGain(p.fadeOut.curve, 1 - u), R.end - fo, R.end, from, from, when, sec);
  }

  /** Applies mix, EQ, width, gain and limiter settings to running nodes. */
  private applyLive(): void {
    const ctx = this.ctx;
    const inp = this.input;
    if (!ctx || !inp) return;
    const p = inp.project;
    const now = ctx.currentTime;
    // Layer buses
    const seen = new Set<Id>();
    for (const s of p.sources) {
      const anySolo = s.layers.some((l) => l.solo && !l.mute);
      for (const l of s.layers) {
        seen.add(l.id);
        let bus = this.buses.get(l.id);
        if (!bus) {
          const input = ctx.createGain();
          input.channelCount = 2;
          input.channelCountMode = 'explicit';
          input.channelInterpretation = 'speakers';
          const split = ctx.createChannelSplitter(2);
          const merge = ctx.createChannelMerger(2);
          const gl = ctx.createGain();
          const gr = ctx.createGain();
          input.connect(split);
          split.connect(gl, 0);
          split.connect(gr, 1);
          gl.connect(merge, 0, 0);
          gr.connect(merge, 0, 1);
          merge.connect(this.mix);
          bus = { input, gl, gr };
          this.buses.set(l.id, bus);
        }
        const audible = !l.mute && (!anySolo || l.solo);
        const g = audible ? dbToGain(l.gainDb) : 0;
        const b = Math.max(-1, Math.min(1, l.balance));
        bus.gl.gain.setTargetAtTime(g * (b > 0 ? 1 - b : 1), now, 0.015);
        bus.gr.gain.setTargetAtTime(g * (b < 0 ? 1 + b : 1), now, 0.015);
      }
    }
    for (const [id, bus] of this.buses) {
      if (!seen.has(id)) {
        bus.input.disconnect();
        this.buses.delete(id);
      }
    }
    this.rebuildEq();
    const w = p.width;
    const a = 0.5 * (1 + w);
    const c = 0.5 * (1 - w);
    this.wLL.gain.setTargetAtTime(a, now, 0.015);
    this.wRR.gain.setTargetAtTime(a, now, 0.015);
    this.wLR.gain.setTargetAtTime(c, now, 0.015);
    this.wRL.gain.setTargetAtTime(c, now, 0.015);
    this.master.gain.setTargetAtTime(dbToGain(p.gainDb + inp.previewGainDb), now, 0.015);
    this.limiter?.port.postMessage({ enabled: p.master.limiter, ceilingDb: p.master.ceilingDb });
  }

  private rebuildEq(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const params = this.input ? eqToBiquads(this.input.project.eq, ctx.sampleRate) : [];
    const key = params.map((q) => q.type).join(',');
    if (key !== this.eqKey) {
      this.mix.disconnect();
      for (const n of this.eqNodes) n.disconnect();
      this.eqNodes = params.map(() => ctx.createBiquadFilter());
      let prev: AudioNode = this.mix;
      for (const n of this.eqNodes) {
        prev.connect(n);
        prev = n;
      }
      prev.connect(this.widthIn);
      this.eqKey = key;
    }
    params.forEach((q, i) => {
      const n = this.eqNodes[i];
      n.type = q.type;
      n.frequency.value = q.frequency;
      n.Q.value = q.Q;
      n.gain.value = q.gain;
    });
  }
}

/**
 * Schedules fn(u) over timeline region [regionStart, regionEnd) as a value
 * curve, starting from timeline frame `from` (which plays at context time
 * `when`). Parts already in the past are skipped. `curveEnd` lets a region be
 * truncated while keeping the curve shape of the full region.
 */
function curveAt(
  param: AudioParam,
  fn: (u: number) => number,
  regionStart: number,
  regionEnd: number,
  notBefore: number,
  from: number,
  when: number,
  sec: (frames: number) => number,
  curveEnd = regionEnd,
): void {
  const a = Math.max(regionStart, notBefore, from);
  const b = regionEnd;
  if (b - a < 1) return;
  const span = curveEnd - regionStart;
  const u0 = (a - regionStart) / span;
  const u1 = (b - regionStart) / span;
  const N = 64;
  const curve = new Float32Array(N);
  for (let k = 0; k < N; k++) curve[k] = fn(u0 + ((u1 - u0) * k) / (N - 1));
  const t = when + sec(a - from);
  const d = sec(b - a);
  if (d <= 0) return;
  try {
    param.setValueCurveAtTime(curve, t, d);
  } catch {
    param.setValueAtTime(curve[N - 1], t + d);
  }
}

function arrangementKey(i: PlayerInput): string {
  const p = i.project;
  return JSON.stringify([
    p.clips,
    p.sources.map((s) => [s.id, s.frames, s.layers.map((l) => l.id)]),
    p.speed,
    p.fadeIn,
    p.fadeOut,
    i.fadeRange,
    i.buffers.size,
  ]);
}
