/**
 * Look-ahead, stereo-linked peak limiter with true-peak detection.
 *
 * Gain computer, for input sample m with detected peak d[m]:
 *   r[m] = min(1, ceiling / d[m])                     required gain
 *   h[k] = min(r[k .. k+L-1])                         forward-window minimum
 *   e[k] = min(h[k], e[k-1] + (1 - e[k-1]) * a_rel)   instant attack, exponential release
 *   s[k] = mean(e[k-L+1 .. k])                        box-filter smoothing
 * For every k in [m-L+1, m] the window of h[k] contains m, so e[k] <= r[m]
 * and hence s[m] <= r[m]: the applied gain never exceeds what sample m
 * requires, while the gain ramps over L samples instead of jumping. The
 * envelope is computed from k = -L+1 so this also holds for the first samples.
 *
 * d[m] covers the sample values and the BS.1770-5 Annex 2 4x-interpolated
 * values on both adjacent inter-sample intervals, so the ceiling applies to
 * true peaks as estimated from the input; `marginDb` absorbs the small extra
 * inter-sample overshoot caused by the gain modulation itself.
 */
import { TP_TAPS, TP_L1 } from './truepeak';
import { interpMax } from './interp.generated';

export interface LimiterOptions {
  sampleRate: number;
  channels: number;
  ceilingDb: number;
  lookaheadMs?: number;
  releaseMs?: number;
  /** Extra headroom below the ceiling inside the gain computer. */
  marginDb?: number;
}

/** Interpolated values computed at input index n describe the interval (n-6, n-5). */
const TP_DELAY = 6;
const H = TP_TAPS - 1;
const BLOCK = 1024;

function pow2AtLeast(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

export class TruePeakLimiter {
  readonly latency: number;
  readonly lookahead: number;
  private readonly ceil: number;
  private readonly aRel: number;
  private readonly nch: number;

  private readonly delay: Float32Array[];
  private readonly dMask: number;
  private readonly work: Float32Array[];
  private readonly absMax = new Float32Array(H + BLOCK);
  private readonly pre = new Float32Array(H + BLOCK + TP_TAPS);
  private readonly suf = new Float32Array(H + BLOCK + TP_TAPS);

  private readonly det = new Float64Array(16);
  private static readonly DET_MASK = 15;

  private readonly dqIdx: Float64Array;
  private readonly dqVal: Float64Array;
  private readonly qMask: number;
  private dqHead = 0;
  private dqTail = 0;

  private readonly box: Float64Array;
  private boxPos = 0;
  private boxSum: number;
  private env = 1;

  private n = 0;
  /** Smallest gain applied so far (linear). */
  minGain = 1;
  /** Number of output samples with gain < 0.9999. */
  reducedSamples = 0;

  constructor(o: LimiterOptions) {
    this.nch = o.channels;
    const L = Math.max(TP_TAPS, Math.round(((o.lookaheadMs ?? 5) / 1000) * o.sampleRate));
    this.lookahead = L;
    this.latency = L - 1 + TP_DELAY;
    this.ceil = Math.pow(10, (o.ceilingDb - (o.marginDb ?? 0.02)) / 20);
    this.aRel = 1 - Math.exp(-1 / (((o.releaseMs ?? 80) / 1000) * o.sampleRate));
    const dsize = pow2AtLeast(this.latency + 1);
    this.dMask = dsize - 1;
    this.delay = Array.from({ length: this.nch }, () => new Float32Array(dsize));
    this.work = Array.from({ length: this.nch }, () => new Float32Array(H + BLOCK));
    const qsize = pow2AtLeast(L + 2);
    this.qMask = qsize - 1;
    this.dqIdx = new Float64Array(qsize);
    this.dqVal = new Float64Array(qsize);
    this.box = new Float64Array(L).fill(1);
    this.boxSum = L;
  }

  /**
   * Processes `frames` frames. output[c][i] is the limited signal delayed by
   * `latency` frames. input and output may be the same arrays.
   */
  process(input: Float32Array[], output: Float32Array[], frames = input[0].length): void {
    for (let off = 0; off < frames; off += BLOCK) this.block(input, output, off, Math.min(BLOCK, frames - off));
  }

  private block(input: Float32Array[], output: Float32Array[], off: number, B: number): void {
    const nch = this.nch;
    const N = H + B;
    const absMax = this.absMax;
    // 1) work buffers (history + block) and per-index max |x| across channels
    for (let c = 0; c < nch; c++) {
      const w = this.work[c];
      const x = input[c];
      for (let i = 0; i < B; i++) w[H + i] = x[off + i];
    }
    for (let j = 0; j < N; j++) {
      let m = 0;
      for (let c = 0; c < nch; c++) {
        const a = Math.abs(this.work[c][j]);
        if (a > m) m = a;
      }
      absMax[j] = m;
    }
    // 2) sliding max over windows [j, j+H] (van Herk / Gil-Werman)
    const pre = this.pre;
    const suf = this.suf;
    for (let j = 0; j < N; j++) pre[j] = j % TP_TAPS === 0 ? absMax[j] : Math.max(pre[j - 1], absMax[j]);
    for (let j = N - 1; j >= 0; j--) suf[j] = j === N - 1 || (j + 1) % TP_TAPS === 0 ? absMax[j] : Math.max(suf[j + 1], absMax[j]);

    const ceil = this.ceil;
    const skipBelow = ceil / TP_L1;
    const det = this.det;
    const DM = TruePeakLimiter.DET_MASK;
    const L = this.lookahead;
    const qMask = this.qMask;
    const dqIdx = this.dqIdx;
    const dqVal = this.dqVal;
    const box = this.box;
    const aRel = this.aRel;
    const lat = this.latency;
    const dMask = this.dMask;

    for (let i = 0; i < B; i++) {
      const n = this.n + i;
      const j = H + i; // newest sample in work
      for (let c = 0; c < nch; c++) this.delay[c][n & dMask] = this.work[c][j];
      det[n & DM] = absMax[j];

      // 3) interpolated peak of the window ending at n (history before the
      //    first sample is silence, so onsets are measured like the meter does)
      {
        const wmax = Math.max(suf[i], pre[j]);
        if (wmax > skipBelow) {
          let ip = 0;
          for (let c = 0; c < nch; c++) {
            const y = interpMax(this.work[c], j);
            if (y > ip) ip = y;
          }
          // Indices before 0 belong to the silent pre-roll; fold them into
          // sample 0, which is the nearest real sample.
          const a = Math.max(0, n - TP_DELAY) & DM;
          const b = Math.max(0, n - TP_DELAY + 1) & DM;
          if (ip > det[a]) det[a] = ip;
          if (ip > det[b]) det[b] = ip;
        }
      }

      // 4) gain computer for m = n - TP_DELAY (detector value is final)
      const m = n - TP_DELAY;
      let g = 0;
      if (m >= 0) {
        const d = det[m & DM];
        const r = d > ceil ? ceil / d : 1;
        while (this.dqTail !== this.dqHead) {
          const last = (this.dqTail - 1) & qMask;
          if (dqVal[last] >= r) this.dqTail = last;
          else break;
        }
        dqIdx[this.dqTail] = m;
        dqVal[this.dqTail] = r;
        this.dqTail = (this.dqTail + 1) & qMask;
        const k = m - L + 1;
        while (dqIdx[this.dqHead] < k) this.dqHead = (this.dqHead + 1) & qMask;
        const hk = dqVal[this.dqHead];
        const rel = this.env + (1 - this.env) * aRel;
        const e = hk < rel ? hk : rel;
        this.env = e;
        const bp = this.boxPos;
        this.boxSum += e - box[bp];
        box[bp] = e;
        if (bp + 1 === L) {
          this.boxPos = 0;
          let s = 0;
          for (let q = 0; q < L; q++) s += box[q];
          this.boxSum = s;
        } else this.boxPos = bp + 1;
        if (k >= 0) {
          g = this.boxSum / L;
          if (g < this.minGain) this.minGain = g;
          if (g < 0.9999) this.reducedSamples++;
        }
      }

      // 5) output sample n - latency
      if (n >= lat) {
        const kpos = (n - lat) & dMask;
        for (let c = 0; c < nch; c++) output[c][off + i] = this.delay[c][kpos] * g;
      } else {
        for (let c = 0; c < nch; c++) output[c][off + i] = 0;
      }
    }
    // keep the last H samples as history
    for (let c = 0; c < nch; c++) this.work[c].copyWithin(0, B, B + H);
    this.n += B;
  }
}

/** Limits a whole buffer, compensating the latency. */
export function limitBuffer(channels: Float32Array[], o: Omit<LimiterOptions, 'channels'>): Float32Array[] {
  const lim = new TruePeakLimiter({ ...o, channels: channels.length });
  const len = channels[0].length;
  const total = len + lim.latency;
  const inp = channels.map((c) => {
    const x = new Float32Array(total);
    x.set(c);
    return x;
  });
  const out = channels.map(() => new Float32Array(total));
  lim.process(inp, out, total);
  return out.map((c) => c.slice(lim.latency, lim.latency + len));
}
