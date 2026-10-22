/**
 * Loudness measurement per Rec. ITU-R BS.1770-5 (integrated loudness, gating),
 * EBU Tech 3341 (momentary 0.4 s / short-term 3 s windows) and EBU Tech 3342
 * (loudness range). True peak per BS.1770-5 Annex 2 (see truepeak.ts).
 */
import { Biquad, type BiquadCoeffs } from './biquad';
import { TruePeakDetector, linToDb } from './truepeak';

/** BS.1770-5 Table 1: first-stage (shelving) pre-filter at 48 kHz. */
const STAGE1_48K = {
  b0: 1.53512485958697,
  b1: -2.69169618940638,
  b2: 1.19839281085285,
  a1: -1.69065929318241,
  a2: 0.73248077421585,
};
/** BS.1770-5 Table 2: second-stage (RLB high-pass) filter at 48 kHz. */
const STAGE2_48K = { b0: 1.0, b1: -2.0, b2: 1.0, a1: -1.99004745483398, a2: 0.99007225036621 };

/**
 * The Recommendation lists coefficients for 48 kHz only. Both stages are the
 * bilinear transform (pre-warped at the filter frequency) of an analogue
 * second-order section; we recover that section exactly from the 48 kHz
 * coefficients and re-discretise it at the target rate. At 48 kHz this
 * reproduces the tabulated values.
 *
 * With K = tan(pi f0 / fs) and D = 1 + K/Q + K^2, a bilinear biquad has
 *   a1 = 2(K^2 - 1)/D, a2 = (1 - K/Q + K^2)/D
 * so 1 - a1 + a2 = 4/D, 1 + a1 + a2 = 4K^2/D, 1 - a2 = 2(K/Q)/D.
 * The shelf numerator is (Vh + Vb K/Q + K^2, 2(K^2 - Vh), Vh - Vb K/Q + K^2)/D.
 */
interface ShelfProto {
  f0: number;
  Q: number;
  Vh: number;
  Vb: number;
}
interface HighpassProto {
  f0: number;
  Q: number;
  g: number;
}

function denomParams(a1: number, a2: number, fs: number) {
  const D = 4 / (1 - a1 + a2);
  const K2 = (1 + a1 + a2) / (1 - a1 + a2);
  const K = Math.sqrt(K2);
  const KoverQ = ((1 - a2) * D) / 2;
  return { D, K, Q: K / KoverQ, f0: (Math.atan(K) * fs) / Math.PI };
}

export const SHELF_PROTO: ShelfProto = (() => {
  const c = STAGE1_48K;
  const { D, K, Q, f0 } = denomParams(c.a1, c.a2, 48000);
  const Vh = K * K - (c.b1 * D) / 2;
  const Vb = ((c.b0 - c.b2) * D) / (2 * (K / Q));
  return { f0, Q, Vh, Vb };
})();

export const HIGHPASS_PROTO: HighpassProto = (() => {
  const c = STAGE2_48K;
  const { D, Q, f0 } = denomParams(c.a1, c.a2, 48000);
  return { f0, Q, g: c.b0 * D };
})();

export function kWeightingCoeffs(fs: number): [BiquadCoeffs, BiquadCoeffs] {
  const s = SHELF_PROTO;
  let K = Math.tan((Math.PI * s.f0) / fs);
  let D = 1 + K / s.Q + K * K;
  const stage1: BiquadCoeffs = {
    b0: (s.Vh + (s.Vb * K) / s.Q + K * K) / D,
    b1: (2 * (K * K - s.Vh)) / D,
    b2: (s.Vh - (s.Vb * K) / s.Q + K * K) / D,
    a1: (2 * (K * K - 1)) / D,
    a2: (1 - K / s.Q + K * K) / D,
  };
  const h = HIGHPASS_PROTO;
  K = Math.tan((Math.PI * h.f0) / fs);
  D = 1 + K / h.Q + K * K;
  const stage2: BiquadCoeffs = {
    b0: h.g / D,
    b1: (-2 * h.g) / D,
    b2: h.g / D,
    a1: (2 * (K * K - 1)) / D,
    a2: (1 - K / h.Q + K * K) / D,
  };
  return [stage1, stage2];
}

export interface LoudnessResult {
  /** Gated integrated loudness, LUFS (-Infinity if everything is gated out). */
  integrated: number;
  /** Maximum momentary loudness (0.4 s window, 10 ms steps), LUFS. */
  momentaryMax: number;
  /** Maximum short-term loudness (3 s window, 10 ms steps), LUFS. */
  shortTermMax: number;
  /** Loudness range per EBU Tech 3342, LU. */
  lra: number;
  /** Short-term loudness every 100 ms (first value at t = 3 s). */
  shortTerm: Float32Array;
  /** Momentary loudness every 100 ms (first value at t = 0.4 s). */
  momentary: Float32Array;
  /** True peak, dBTP (only when measured). */
  truePeakDb: number;
  /** Sample peak, dBFS. */
  samplePeakDb: number;
  /** Duration measured, seconds. */
  duration: number;
}

const ABS_GATE = -70;
const REL_GATE_INTEGRATED = -10;
const REL_GATE_LRA = -20;

function energyToLufs(meanSquareWeighted: number): number {
  return meanSquareWeighted > 0 ? -0.691 + 10 * Math.log10(meanSquareWeighted) : -Infinity;
}

/**
 * Streaming loudness meter. Audio is split into 10 ms sub-blocks; 400 ms
 * gating blocks are 40 sub-blocks advancing by 10 (75 % overlap, as required),
 * and the 0.4 s / 3 s sliding windows advance in 10 ms steps.
 */
export class LoudnessMeter {
  readonly sub: number;
  private readonly filters: [Biquad, Biquad][];
  private readonly weights: number[];
  private readonly tp: TruePeakDetector[] | null;
  private energies = new Float64Array(1024);
  private nSub = 0;
  private acc = 0;
  private accCount = 0;
  private samplePeak = 0;
  private frames = 0;
  private scratch = new Float64Array(0);
  private squares = new Float64Array(0);

  constructor(
    readonly sampleRate: number,
    readonly channelCount: number,
    opts: { truePeak?: boolean; weights?: number[] } = {},
  ) {
    this.sub = Math.round(sampleRate / 100);
    const [c1, c2] = kWeightingCoeffs(sampleRate);
    this.filters = Array.from({ length: channelCount }, () => [new Biquad(c1), new Biquad(c2)] as [Biquad, Biquad]);
    this.weights = opts.weights ?? new Array(channelCount).fill(1);
    this.tp = opts.truePeak ? Array.from({ length: channelCount }, () => new TruePeakDetector()) : null;
  }

  push(channels: Float32Array[], n = channels[0].length): void {
    if (this.scratch.length < n) {
      this.scratch = new Float64Array(n);
      this.squares = new Float64Array(n);
    }
    const w = this.scratch;
    // Weighted sum of squares per sample, accumulated across channels.
    const sq = this.squares;
    sq.fill(0, 0, n);
    for (let c = 0; c < this.channelCount; c++) {
      const x = channels[c];
      let sp = this.samplePeak;
      for (let i = 0; i < n; i++) {
        const a = Math.abs(x[i]);
        if (a > sp) sp = a;
      }
      this.samplePeak = sp;
      this.tp?.[c].push(x, n);
      const [f1, f2] = this.filters[c];
      f1.processInto(x, w, n);
      f2.process(w, 0, n);
      const g = this.weights[c];
      for (let i = 0; i < n; i++) sq[i] += g * w[i] * w[i];
    }
    let acc = this.acc;
    let cnt = this.accCount;
    const sub = this.sub;
    for (let i = 0; i < n; i++) {
      acc += sq[i];
      if (++cnt === sub) {
        this.pushEnergy(acc);
        acc = 0;
        cnt = 0;
      }
    }
    this.acc = acc;
    this.accCount = cnt;
    this.frames += n;
  }

  private pushEnergy(e: number): void {
    if (this.nSub === this.energies.length) {
      const bigger = new Float64Array(this.energies.length * 2);
      bigger.set(this.energies);
      this.energies = bigger;
    }
    this.energies[this.nSub++] = e;
  }

  result(): LoudnessResult {
    const E = this.energies;
    const n = this.nSub;
    const sub = this.sub;
    // Prefix sums for O(1) window energies.
    const pre = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + E[i];
    const windowLufs = (start: number, len: number) => energyToLufs((pre[start + len] - pre[start]) / (len * sub));

    // Integrated loudness (BS.1770-5 eqs. 4-6).
    const blockLen = 40;
    const blocks: number[] = [];
    const blockE: number[] = [];
    for (let s = 0; s + blockLen <= n; s += 10) {
      const e = (pre[s + blockLen] - pre[s]) / (blockLen * sub);
      blocks.push(energyToLufs(e));
      blockE.push(e);
    }
    let integrated = -Infinity;
    {
      let sum = 0;
      let cnt = 0;
      for (let j = 0; j < blocks.length; j++) {
        if (blocks[j] > ABS_GATE) {
          sum += blockE[j];
          cnt++;
        }
      }
      if (cnt > 0) {
        const rel = energyToLufs(sum / cnt) + REL_GATE_INTEGRATED;
        let s2 = 0;
        let c2 = 0;
        for (let j = 0; j < blocks.length; j++) {
          if (blocks[j] > ABS_GATE && blocks[j] > rel) {
            s2 += blockE[j];
            c2++;
          }
        }
        if (c2 > 0) integrated = energyToLufs(s2 / c2);
      }
    }

    // Momentary / short-term maxima in 10 ms steps, series in 100 ms steps.
    let momentaryMax = -Infinity;
    const momentary: number[] = [];
    for (let s = 0; s + 40 <= n; s++) {
      const l = windowLufs(s, 40);
      if (l > momentaryMax) momentaryMax = l;
      if ((s + 40) % 10 === 0) momentary.push(l);
    }
    let shortTermMax = -Infinity;
    const shortTerm: number[] = [];
    for (let s = 0; s + 300 <= n; s++) {
      const l = windowLufs(s, 300);
      if (l > shortTermMax) shortTermMax = l;
      if ((s + 300) % 10 === 0) shortTerm.push(l);
    }

    const tpLin = this.tp ? Math.max(...this.tp.map((d) => d.peak)) : NaN;
    return {
      integrated,
      momentaryMax,
      shortTermMax,
      lra: loudnessRange(shortTerm),
      shortTerm: Float32Array.from(shortTerm),
      momentary: Float32Array.from(momentary),
      truePeakDb: this.tp ? linToDb(tpLin) : NaN,
      samplePeakDb: linToDb(this.samplePeak),
      duration: this.frames / this.sampleRate,
    };
  }
}


/** EBU Tech 3342 loudness range from short-term loudness values (LUFS). */
export function loudnessRange(shortTerm: ArrayLike<number>): number {
  const absGated: number[] = [];
  for (let i = 0; i < shortTerm.length; i++) {
    const v = shortTerm[i];
    if (v >= ABS_GATE) absGated.push(v);
  }
  if (absGated.length === 0) return 0;
  let p = 0;
  for (const v of absGated) p += Math.pow(10, v / 10);
  const integ = 10 * Math.log10(p / absGated.length);
  const rel = absGated.filter((v) => v >= integ + REL_GATE_LRA).sort((a, b) => a - b);
  const m = rel.length;
  if (m === 0) return 0;
  // MATLAB reference: sorted(round((n-1)*P/100 + 1)) with 1-based indexing.
  const lo = rel[Math.round(((m - 1) * 10) / 100 + 1) - 1];
  const hi = rel[Math.round(((m - 1) * 95) / 100 + 1) - 1];
  return hi - lo;
}

/** Convenience: measure a whole buffer. */
export function measureLoudness(
  channels: Float32Array[],
  sampleRate: number,
  opts: { truePeak?: boolean; weights?: number[] } = { truePeak: true },
): LoudnessResult {
  const m = new LoudnessMeter(sampleRate, channels.length, opts);
  const CH = 65536;
  const len = channels[0].length;
  for (let off = 0; off < len; off += CH) {
    const e = Math.min(len, off + CH);
    m.push(
      channels.map((c) => c.subarray(off, e)),
      e - off,
    );
  }
  return m.result();
}
